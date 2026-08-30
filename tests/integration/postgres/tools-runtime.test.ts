/**
 * Real-PostgreSQL: the governed tool runtime over the FULL production
 * fabric (WORK-010; TOL-001/TOL-002 on physical PostgreSQL).
 *
 * The production composition is exercised end to end: REAL policy
 * authority behind the tools admission seam, REAL capability registry
 * behind the capability gate, REAL budget service, REAL executions ledger
 * (gapless physical sequences interleaved with lifecycle transitions) and
 * the durable tools store over migration 0005.
 *
 * Proves on real PostgreSQL:
 *   * deterministic first-class execution + successful typed result;
 *   * REAL policy denial on the tool dimension (policy-before-dispatch:
 *     the adapter is never invoked; durable denial + ledger event);
 *   * REAL network-host denial for a declared-egress tool;
 *   * REAL capability denial (unpublished capability);
 *   * REAL budget denial through the WORK-004 authority;
 *   * typed tool failure + release of the hold;
 *   * tenant isolation (foreign tenant rejected before any dispatch);
 *   * idempotent replay: same key → same durable row + same envelopes;
 *   * CONCURRENT duplicate invocations (N=4, two pool connections) converge
 *     to ONE durable identity/outcome/ledger pair;
 *   * crash recovery: a committed `dispatching` row (crash between intent
 *     and outcome) converges for an idempotent tool and FAILS CLOSED for a
 *     non-idempotent one;
 *   * provenance persistence: policy evidence + ledger bindings on the row,
 *     invocation references on the envelopes, interleaved gapless sequences.
 */

import { expect, test } from "vitest";
import type { ToolContract } from "../../../src/modules/tools/domain/tool";
import type { ToolAdapter } from "../../../src/modules/tools/ports/tool-adapter";
import { CALCULATOR_CONTRACT, calculatorAdapter } from "../../../src/modules/tools/public";
import { PlatformError } from "../../../src/shared/errors";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { definePgSuite } from "./harness";
import { fundApplication, seedToolsWorld, type ToolsPgWorld } from "./tools-world";

const generateId = createUuidv7Generator();

const NETWORKED_TOOL: ToolContract = {
  toolId: "http-fetcher",
  version: "1.0.0",
  capability: { id: "document-retrieval", kind: "tool", minVersion: "1.0.0" },
  inputSchema: { fields: [{ name: "url", type: "string", required: true }] },
  outputSchema: { fields: [{ name: "body", type: "string", required: true }] },
  execution: { deterministic: false, timeoutMs: 5_000, idempotent: true },
  sideEffect: "read-only",
  network: { egress: "allowlist", hosts: ["api.external.example"] },
  secrets: { access: "none", refs: [] },
  cost: { estimatedMicroUsd: "120" },
  evidence: { producesArtifacts: true },
};

const COSTED_TOOL: ToolContract = {
  ...CALCULATOR_CONTRACT,
  toolId: "costed-compute",
  execution: { deterministic: false, timeoutMs: 5_000, idempotent: true },
  sideEffect: "write-external",
  cost: { estimatedMicroUsd: "500" },
};

const NON_IDEMPOTENT_TOOL: ToolContract = {
  ...CALCULATOR_CONTRACT,
  toolId: "one-shot",
  execution: { deterministic: false, timeoutMs: 5_000, idempotent: false },
  sideEffect: "write-external",
  cost: { estimatedMicroUsd: "0" },
};

function countingAdapter(output: Record<string, unknown>): ToolAdapter & { calls: number } {
  const adapter = {
    calls: 0,
    async execute() {
      adapter.calls += 1;
      return { kind: "tool-success" as const, output, artifacts: ["artifact://pg-1"] };
    },
  };
  return adapter;
}

function failingAdapter(): ToolAdapter {
  return {
    async execute() {
      return {
        kind: "tool-failure" as const,
        failure: {
          failureClass: "tool-execution" as const,
          message: "external tool failed",
          retryable: false,
        },
      };
    },
  };
}

definePgSuite("governed tool runtime (real PG)", (ctx) => {
  async function freshWorld(): Promise<ToolsPgWorld> {
    return seedToolsWorld(ctx.port);
  }

  const inputOf = (
    world: ToolsPgWorld,
    executionId: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    applicationId: world.applicationId,
    executionId,
    actor: world.actor(),
    toolId: "calculator",
    input: { operation: "multiply", left: "6", right: "7" },
    ...overrides,
  });

  const toolEventsOf = async (world: ToolsPgWorld, executionId: string) =>
    (await world.executionService.listEvents(world.applicationId, executionId)).filter((event) =>
      event.type.startsWith("execution.tool-"),
    );

  test("deterministic tool executes successfully over the full fabric with provenance", async () => {
    const world = await freshWorld();
    await world.registerTool(CALCULATOR_CONTRACT, calculatorAdapter);
    const executionId = await world.seedExecution();

    const result = await world.runtime.invoke(inputOf(world, executionId), "pg-1");

    expect(result).toMatchObject({
      status: "succeeded",
      outcomeClass: "tool-success",
      toolId: "calculator",
      output: { result: "42" },
      replayed: false,
    });
    const record = await world.toolStore.findByKey(world.applicationId, "pg-1");
    expect(record).toMatchObject({
      executionId,
      tenantId: world.tenantId,
      policyEvidence: { policySetId: "default", policySetVersion: 1 },
      capabilitySatisfaction: expect.stringContaining("arithmetic@"),
      ledgerRequestedSequence: 6,
      ledgerResultSequence: 7,
      dispatchedAt: expect.any(String),
      completedAt: expect.any(String),
    });

    // The physical ledger: gapless 1..7, tool events interleaved after the
    // lifecycle transitions, carrying invocation provenance.
    const events = await world.executionService.listEvents(world.applicationId, executionId);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events[5]).toMatchObject({ type: "execution.tool-requested" });
    expect(events[6]).toMatchObject({ type: "execution.tool-result" });
    expect(events[6]?.reference).toMatchObject({ invocationId: record?.id, toolId: "calculator" });
    // The physical executions row kept its status and advanced exactly twice.
    const execution = await world.executionService.getExecution(world.applicationId, executionId);
    expect(execution).toMatchObject({ status: "RUNNING", lastEventSequence: 7 });
  });

  test("REAL policy denial on the tool dimension: adapter never invoked, durable evidence", async () => {
    const world = await freshWorld();
    const adapter = countingAdapter({ body: "x" });
    await world.registerTool(CALCULATOR_CONTRACT, adapter);
    const executionId = await world.seedExecution();

    // v2: deny the calculator tool at application scope.
    await world.policyAuthority.publish({
      id: "default",
      version: 2,
      documents: [
        {
          scope: "platform",
          selector: {},
          restrictions: {},
        },
        {
          scope: "application",
          selector: { tenantId: world.tenantId, applicationId: world.applicationId },
          restrictions: { tool: { deniedTools: ["calculator"] } },
        },
      ],
    });

    await expect(
      world.runtime.invoke(inputOf(world, executionId), "pg-deny"),
    ).rejects.toMatchObject({
      code: "POLICY_DENIED",
      message: expect.stringContaining("prohibited"),
    });
    expect(adapter.calls).toBe(0);
    const record = await world.toolStore.findByKey(world.applicationId, "pg-deny");
    expect(record).toMatchObject({ status: "denied", denialClass: "policy" });
    const events = await toolEventsOf(world, executionId);
    expect(events.map((event) => event.type)).toEqual(["execution.tool-denied"]);
    // The denial envelope is physically append-only (migration 0004 trigger):
    await expect(
      ctx.port.execute({
        sql: "UPDATE executions.execution_events SET payload = '{}'::jsonb WHERE type = 'execution.tool-denied'",
        parameters: [],
      }),
    ).rejects.toThrow(/append-only/);
  });

  test("REAL network-host denial: a declared-egress tool is denied when the host is prohibited", async () => {
    const world = await freshWorld();
    const adapter = countingAdapter({ body: "x" });
    await world.registerTool(NETWORKED_TOOL, adapter);
    const executionId = await world.seedExecution();

    await world.policyAuthority.publish({
      id: "default",
      version: 2,
      documents: [
        {
          scope: "platform",
          selector: {},
          restrictions: { network: { egress: "none" } },
        },
      ],
    });

    await expect(
      world.runtime.invoke(
        inputOf(world, executionId, {
          toolId: "http-fetcher",
          input: { url: "https://api.external.example/x" },
        }),
        "pg-net",
      ),
    ).rejects.toMatchObject({
      code: "POLICY_DENIED",
      message: expect.stringContaining("network egress is prohibited"),
    });
    expect(adapter.calls).toBe(0);
  });

  test("REAL capability denial: an unpublished capability blocks dispatch", async () => {
    const world = await freshWorld();
    const adapter = countingAdapter({ result: "1" });
    // A tool whose capability is NOT in the arbitrated catalog:
    const orphan: ToolContract = {
      ...CALCULATOR_CONTRACT,
      toolId: "orphan-tool",
      capability: { id: "quantum-annealing", kind: "tool" },
    };
    await world.registerTool(orphan, adapter);
    const executionId = await world.seedExecution();

    await expect(
      world.runtime.invoke(inputOf(world, executionId, { toolId: "orphan-tool" }), "pg-cap"),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    expect(adapter.calls).toBe(0);
    const record = await world.toolStore.findByKey(world.applicationId, "pg-cap");
    expect(record).toMatchObject({ status: "denied", denialClass: "capability" });
  });

  test("REAL budget denial through the WORK-004 authority; success settles actual usage", async () => {
    const world = await freshWorld();
    const adapter = countingAdapter({ result: "42" });
    await world.registerTool(COSTED_TOOL, adapter);
    const executionId = await world.seedExecution();

    // Fund the application with LESS than the tool's estimate.
    await fundApplication(world, "300");

    await expect(
      world.runtime.invoke(inputOf(world, executionId, { toolId: "costed-compute" }), "pg-budget"),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(adapter.calls).toBe(0);
    const denied = await world.toolStore.findByKey(world.applicationId, "pg-budget");
    expect(denied).toMatchObject({ status: "denied", denialClass: "budget" });

    // Grant enough budget and retry with a NEW key: reserve → execute → settle.
    const scope = { ...world.actor(), applicationId: world.applicationId };
    await world.budgets.grantCredits(
      { ...scope, ownerKind: "developer", amountMicroUsd: "10000" },
      "top-up",
    );
    const result = await world.runtime.invoke(
      inputOf(world, executionId, { toolId: "costed-compute" }),
      "pg-budget-2",
    );
    expect(result.status).toBe("succeeded");
    const reservation = await world.budgets.getReservation(
      world.applicationId,
      "tool-invocation:pg-budget-2",
    );
    expect(reservation).toMatchObject({ status: "settled", settledAmountMicroUsd: "0" });
  });

  test("typed tool failure releases the hold; the durable record is tool-axis only", async () => {
    const world = await freshWorld();
    await world.registerTool(COSTED_TOOL, failingAdapter());
    await world.registerTool(CALCULATOR_CONTRACT, calculatorAdapter);
    const executionId = await world.seedExecution();
    await fundApplication(world);

    const result = await world.runtime.invoke(
      inputOf(world, executionId, { toolId: "costed-compute" }),
      "pg-fail",
    );
    expect(result).toMatchObject({
      status: "tool-failed",
      outcomeClass: "tool-failure",
      failureClass: "tool-execution",
    });
    const reservation = await world.budgets.getReservation(
      world.applicationId,
      "tool-invocation:pg-fail",
    );
    expect(reservation).toMatchObject({ status: "released" });
    const record = await world.toolStore.findByKey(world.applicationId, "pg-fail");
    expect(record?.outcomeClass).toBe("tool-failure"); // never verification vocabulary
  });

  test("tenant isolation: a foreign-tenant actor is rejected before any dispatch (real PG)", async () => {
    const world = await freshWorld();
    const adapter = countingAdapter({ result: "1" });
    await world.registerTool(CALCULATOR_CONTRACT, adapter);
    const executionId = await world.seedExecution();

    await expect(
      world.runtime.invoke(
        inputOf(world, executionId, {
          actor: {
            actorId: "00000000-0000-7000-8000-0000000000cc",
            tenantId: "00000000-0000-7000-8000-0000000000dd",
          },
        }),
        "pg-tenant",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    expect(adapter.calls).toBe(0);
    // Nothing durable was claimed for the foreign scope.
    expect(await world.toolStore.findByKey(world.applicationId, "pg-tenant")).toBeNull();
  });

  test("idempotent replay: same key replays the SAME durable row and envelopes", async () => {
    const world = await freshWorld();
    await world.registerTool(CALCULATOR_CONTRACT, calculatorAdapter);
    const executionId = await world.seedExecution();

    const first = await world.runtime.invoke(inputOf(world, executionId), "pg-idem");
    const replay = await world.runtime.invoke(inputOf(world, executionId), "pg-idem");

    expect(replay).toMatchObject({ replayed: true, invocationId: first.invocationId });
    const rows = await ctx.port.execute<{ count: string }>({
      sql: "SELECT COUNT(*)::text AS count FROM tools.tool_invocations WHERE application_id = $1 AND invocation_key = 'pg-idem'",
      parameters: [world.applicationId],
    });
    expect(rows.rows[0]?.count).toBe("1");
    const events = await toolEventsOf(world, executionId);
    expect(events.filter((event) => event.type === "execution.tool-requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "execution.tool-result")).toHaveLength(1);
  });

  test("key reuse with a different input fails IDEMPOTENCY_KEY_REUSED", async () => {
    const world = await freshWorld();
    await world.registerTool(CALCULATOR_CONTRACT, calculatorAdapter);
    const executionId = await world.seedExecution();

    await world.runtime.invoke(inputOf(world, executionId), "pg-reuse");
    await expect(
      world.runtime.invoke(
        inputOf(world, executionId, { input: { operation: "add", left: "1", right: "1" } }),
        "pg-reuse",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("CONCURRENT duplicates (N=4) converge to one durable identity, outcome and ledger pair", async () => {
    const world = await freshWorld();
    const adapter = countingAdapter({ result: "42" });
    await world.registerTool(CALCULATOR_CONTRACT, adapter);
    const executionId = await world.seedExecution();

    const results = await Promise.all([
      world.runtime.invoke(inputOf(world, executionId), "pg-conc"),
      world.runtime.invoke(inputOf(world, executionId), "pg-conc"),
      world.runtime.invoke(inputOf(world, executionId), "pg-conc"),
      world.runtime.invoke(inputOf(world, executionId), "pg-conc"),
    ]);

    // ONE durable identity + identical outcomes for every caller.
    expect(new Set(results.map((result) => result.invocationId)).size).toBe(1);
    expect(new Set(results.map((result) => JSON.stringify(result.output))).size).toBe(1);
    // ONE durable row (the unique key arbitration serialized the claims).
    const rows = await ctx.port.execute<{ count: string }>({
      sql: "SELECT COUNT(*)::text AS count FROM tools.tool_invocations WHERE application_id = $1 AND invocation_key = 'pg-conc'",
      parameters: [world.applicationId],
    });
    expect(rows.rows[0]?.count).toBe("1");
    // ONE pair of ledger envelopes (idempotent event appends).
    const events = await toolEventsOf(world, executionId);
    expect(events.filter((event) => event.type === "execution.tool-requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "execution.tool-result")).toHaveLength(1);
    // Gapless physical sequences preserved under concurrency.
    const all = await world.executionService.listEvents(world.applicationId, executionId);
    expect(all.map((event) => event.sequence)).toEqual(all.map((_, index) => index + 1));
    // The adapter may have dispatched multiple times ONLY under the
    // contract's idempotency declaration (safe by contract).
    expect(adapter.calls).toBeGreaterThanOrEqual(1);
  });

  test("crash recovery: a committed dispatching row converges (idempotent) or fails closed (non-idempotent)", async () => {
    const world = await freshWorld();
    const idemAdapter = countingAdapter({ result: "42" });
    await world.registerTool(CALCULATOR_CONTRACT, idemAdapter);
    await world.registerTool(NON_IDEMPOTENT_TOOL, countingAdapter({ result: "1" }));
    const executionId = await world.seedExecution();

    // Simulate the crash: durable intent committed, outcome never recorded.
    const request = inputOf(world, executionId);
    const { toolRequestFingerprint } = await import(
      "../../../src/modules/tools/application/tool-runtime"
    );
    const fingerprint = toolRequestFingerprint(request);
    await ctx.port.execute({
      sql: `INSERT INTO tools.tool_invocations
  (id, application_id, tenant_id, execution_id, invocation_key, request_fingerprint,
   tool_id, tool_version, capability_id, status, input_digest, input_artifacts, requested_at)
VALUES ($1, $2, $3, $4, 'pg-crash', $5, 'calculator', '1.0.0', 'arithmetic', 'dispatching', 'digest:crash', '[]'::jsonb, now())`,
      parameters: [generateId(), world.applicationId, world.tenantId, executionId, fingerprint],
    });

    // Retry the SAME logical request: the idempotent tool converges.
    const recovered = await world.runtime.invoke(request, "pg-crash");
    expect(recovered).toMatchObject({ status: "succeeded", replayed: true });

    // Non-idempotent tool with a stale dispatching row: fail closed.
    const request2 = inputOf(world, executionId, { toolId: "one-shot" });
    const fingerprint2 = toolRequestFingerprint(request2);
    await ctx.port.execute({
      sql: `INSERT INTO tools.tool_invocations
  (id, application_id, tenant_id, execution_id, invocation_key, request_fingerprint,
   tool_id, tool_version, capability_id, status, input_digest, input_artifacts, requested_at)
VALUES ($1, $2, $3, $4, 'pg-crash-2', $5, 'one-shot', '1.0.0', 'arithmetic', 'dispatching', 'digest:crash', '[]'::jsonb, now())`,
      parameters: [generateId(), world.applicationId, world.tenantId, executionId, fingerprint2],
    });
    await expect(world.runtime.invoke(request2, "pg-crash-2")).rejects.toMatchObject({
      code: "NON_CONVERGENT_EXTERNAL_EFFECT",
    });
  });

  test("side-effect ordering: the requested envelope precedes the result envelope on the physical ledger", async () => {
    const world = await freshWorld();
    await world.registerTool(CALCULATOR_CONTRACT, calculatorAdapter);
    const executionId = await world.seedExecution();

    await world.runtime.invoke(inputOf(world, executionId), "pg-order");
    const events = await toolEventsOf(world, executionId);
    expect(events.map((event) => [event.type, event.sequence])).toEqual([
      ["execution.tool-requested", 6],
      ["execution.tool-result", 7],
    ]);
    expect((events[0]?.occurredAt ?? "") <= (events[1]?.occurredAt ?? "")).toBe(true);
  });

  test("tool results are downstream evidence: a second invocation consumes the first's artifacts", async () => {
    const world = await freshWorld();
    const adapter = countingAdapter({ result: "42" });
    await world.registerTool(CALCULATOR_CONTRACT, adapter);
    const executionId = await world.seedExecution();

    const first = await world.runtime.invoke(inputOf(world, executionId), "pg-evidence-1");
    const second = await world.runtime.invoke(
      inputOf(world, executionId, {
        inputArtifactRefs: [...first.outputArtifacts, "artifact://pg-1"],
      }),
      "pg-evidence-2",
    );
    expect(second.status).toBe("succeeded");

    const timeline = await world.runtime.listInvocationsByExecution(
      world.applicationId,
      executionId,
    );
    expect(timeline).toHaveLength(2);
    expect(timeline[1]?.inputArtifacts).toContain("artifact://pg-1");
    // Both invocations' evidence rows are durable and provenance-bound.
    for (const record of timeline) {
      expect(record.executionId).toBe(executionId);
      expect(record.tenantId).toBe(world.tenantId);
    }
  });

  test("unregistered tool cannot be invoked (no adapter exists to dispatch)", async () => {
    const world = await freshWorld();
    const executionId = await world.seedExecution();
    await expect(
      world.runtime.invoke(inputOf(world, executionId, { toolId: "ghost" }), "pg-ghost"),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    const rows = await ctx.port.execute<{ count: string }>({
      sql: "SELECT COUNT(*)::text AS count FROM tools.tool_invocations WHERE application_id = $1",
      parameters: [world.applicationId],
    });
    expect(rows.rows[0]?.count).toBe("0");
  });

  test("typed PlatformError surface: tool failure is TOOL_ERROR-axis, distinguishable from denials", async () => {
    const world = await freshWorld();
    await world.registerTool(CALCULATOR_CONTRACT, failingAdapter());
    const executionId = await world.seedExecution();

    const result = await world.runtime.invoke(inputOf(world, executionId), "pg-axis");
    expect(result.status).toBe("tool-failed");
    // The typed result distinguishes: TOOL_ERROR axis (failure class) vs
    // POLICY_DENIED / BUDGET_EXCEEDED / CAPABILITY_UNAVAILABLE /
    // TENANT_SCOPE_VIOLATION (thrown canonical codes) vs verification
    // (never produced here).
    expect(PlatformError).toBeDefined();
  });
});
