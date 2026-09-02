/**
 * Unit — the governed tool runtime (WORK-010; TOL-001/TOL-002).
 *
 * Every required behavior class is proven here against the in-memory world
 * (real executions service + ledger adapter; fake admission/capability/
 * budget seams): deterministic first-class execution, the admission chain
 * and its order, every denial class BEFORE any adapter dispatch, typed
 * tool failures, normalization, provenance persistence, idempotent replay,
 * crash recovery (converge vs fail-closed), side-effect ordering, budget
 * settlement, downstream evidence and execution-authority preservation.
 *
 * The discrimination (mutant) proofs live in
 * tests/discrimination/tool-runtime.discrimination.test.ts; the physical
 * (real-PostgreSQL) halves live in tests/integration/postgres/tools-*.
 */

import { describe, expect, test } from "vitest";
import type { EventEnvelope } from "../../../src/modules/executions/domain/event";
import type { ToolContract } from "../../../src/modules/tools/domain/tool";
import type { ToolAdapter, ToolObservation } from "../../../src/modules/tools/ports/tool-adapter";
import { CALCULATOR_CONTRACT } from "../../../src/modules/tools/public";
import { createInMemoryToolsWorld, type InMemoryToolsWorld } from "./fakes";

// ---------------------------------------------------------------------------
// Test adapters
// ---------------------------------------------------------------------------

class RecordingAdapter implements ToolAdapter {
  readonly calls: Array<{ dispatch: unknown; context: unknown }> = [];
  behavior: (dispatch: {
    invocationId: string;
    input: Record<string, unknown>;
  }) => Promise<ToolObservation> = async () => ({ kind: "tool-success", output: {} });

  constructor(
    behavior?: (dispatch: {
      invocationId: string;
      input: Record<string, unknown>;
    }) => Promise<ToolObservation>,
  ) {
    if (behavior !== undefined) {
      this.behavior = behavior;
    }
  }

  async execute(
    dispatch: Parameters<ToolAdapter["execute"]>[0],
    context: Parameters<ToolAdapter["execute"]>[1],
  ): Promise<ToolObservation> {
    this.calls.push({ dispatch, context });
    return this.behavior(dispatch);
  }
}

const successAdapter = (output: Record<string, unknown>, artifacts?: string[]) =>
  new RecordingAdapter(async () => ({
    kind: "tool-success" as const,
    output,
    ...(artifacts ? { artifacts } : {}),
  }));

const failingAdapter = new RecordingAdapter(async () => ({
  kind: "tool-failure" as const,
  failure: { failureClass: "tool-execution" as const, message: "the tool broke", retryable: false },
}));

const throwingAdapter = new RecordingAdapter(async () => {
  throw new Error("adapter exploded");
});

const neverAdapter = new RecordingAdapter(() => new Promise<ToolObservation>(() => {}));

const badOutputAdapter = new RecordingAdapter(async () => ({
  kind: "tool-success" as const,
  output: { wrongShape: true } as unknown as Record<string, unknown>,
}));

const SIDE_EFFECT_TOOL: ToolContract = {
  ...CALCULATOR_CONTRACT,
  toolId: "side-effect-tool",
  execution: { deterministic: false, timeoutMs: 5_000, idempotent: true },
  sideEffect: "write-external",
  cost: { estimatedMicroUsd: "250" },
  evidence: { producesArtifacts: true },
};

const NON_IDEMPOTENT_TOOL: ToolContract = {
  ...CALCULATOR_CONTRACT,
  toolId: "non-idempotent-tool",
  execution: { deterministic: false, timeoutMs: 5_000, idempotent: false },
  sideEffect: "write-external",
};

async function seededWorld(
  tool: ToolContract = CALCULATOR_CONTRACT,
  adapter: ToolAdapter = successAdapter({ result: "42" }),
) {
  const world = createInMemoryToolsWorld();
  await world.registerTool(tool, adapter);
  const executionId = await world.seedExecution("RUNNING");
  return { world, executionId };
}

const inputOf = (
  world: InMemoryToolsWorld,
  executionId: string,
  overrides: Record<string, unknown> = {},
) => ({
  applicationId: world.applicationId,
  executionId,
  actor: world.actor(),
  toolId: "calculator",
  input: { operation: "add", left: "20", right: "22" },
  ...overrides,
});

const toolEventsOf = async (world: InMemoryToolsWorld, executionId: string) =>
  (await world.executionService.listEvents(world.applicationId, executionId)).filter(
    (event: EventEnvelope) => event.type.startsWith("execution.tool-"),
  );

describe("governed tool runtime — deterministic first-class execution", () => {
  test("a deterministic tool executes successfully with NO model anywhere (provider-independent)", async () => {
    const { world, executionId } = await seededWorld();
    const result = await world.runtime.invoke(inputOf(world, executionId), "key-1");

    expect(result).toMatchObject({
      status: "succeeded",
      outcomeClass: "tool-success",
      toolId: "calculator",
      toolVersion: "1.0.0",
      capabilityId: "arithmetic",
      output: { result: "42" },
      replayed: false,
    });
    // Deterministic tool: no budget reservation at all (cost "0").
    expect(world.budgets.reserveCalls).toHaveLength(0);
    // No model/provider rail participates — the only seams consulted are
    // admission + capability.
    expect(world.admission.calls).toHaveLength(1);
    expect(world.capabilities.calls).toHaveLength(1);
  });

  test("the built-in calculator adapter computes (real deterministic work)", async () => {
    const world = createInMemoryToolsWorld();
    await world.registerTool(
      CALCULATOR_CONTRACT,
      (await import("../../../src/modules/tools/adapters/builtins")).calculatorAdapter,
    );
    const executionId = await world.seedExecution("RUNNING");
    const result = await world.runtime.invoke(inputOf(world, executionId), "calc-1");
    expect(result.output).toEqual({ result: "42" });
  });
});

describe("governed tool runtime — the admission chain order", () => {
  test("policy admission is consulted BEFORE the adapter dispatches (dynamic ordering probe)", async () => {
    const adapter = successAdapter({ result: "1" });
    const world = createInMemoryToolsWorld();
    await world.registerTool(CALCULATOR_CONTRACT, adapter);
    const executionId = await world.seedExecution("RUNNING");

    const order: string[] = [];
    const originalAdmit = world.admission.impl.admit.bind(world.admission.impl);
    world.admission.impl.admit = async (request) => {
      order.push("admission");
      return originalAdmit(request);
    };
    adapter.behavior = async () => {
      order.push("adapter");
      return { kind: "tool-success", output: { result: "1" } };
    };

    await world.runtime.invoke(inputOf(world, executionId), "order-1");
    expect(order).toEqual(["admission", "adapter"]);
  });

  test("capability admission is consulted BEFORE the adapter dispatches", async () => {
    const adapter = successAdapter({ result: "1" });
    const world = createInMemoryToolsWorld();
    await world.registerTool(CALCULATOR_CONTRACT, adapter);
    const executionId = await world.seedExecution("RUNNING");

    const order: string[] = [];
    const originalResolve = world.capabilities.impl.resolve.bind(world.capabilities.impl);
    world.capabilities.impl.resolve = async (profile) => {
      order.push("capability");
      return originalResolve(profile);
    };
    adapter.behavior = async () => {
      order.push("adapter");
      return { kind: "tool-success", output: { result: "1" } };
    };

    await world.runtime.invoke(inputOf(world, executionId), "order-2");
    expect(order).toEqual(["capability", "adapter"]);
  });

  test("admission facts carry the contract's declared tool identity and scope", async () => {
    const { world, executionId } = await seededWorld(SIDE_EFFECT_TOOL);
    await world.runtime.invoke(
      inputOf(world, executionId, { toolId: "side-effect-tool" }),
      "facts-1",
    );
    expect(world.admission.calls[0]).toMatchObject({
      toolId: "side-effect-tool",
      tenantId: world.tenantId,
      applicationId: world.applicationId,
      executionId,
      hosts: [],
      secretRefs: [],
    });
    // The capability profile resolved is the CONTRACT's declared identity.
    expect(world.capabilities.calls[0]?.requirements[0]).toMatchObject({
      id: "arithmetic",
      kind: "tool",
    });
  });
});

describe("governed tool runtime — denials BEFORE any dispatch", () => {
  test("policy denial: the adapter is NEVER invoked; typed POLICY_DENIED; durable denial + ledger event", async () => {
    const adapter = successAdapter({ result: "1" });
    const world = createInMemoryToolsWorld();
    await world.registerTool(CALCULATOR_CONTRACT, adapter);
    const executionId = await world.seedExecution("RUNNING");
    world.admission.denyWith("tool not permitted by effective policy");

    await expect(world.runtime.invoke(inputOf(world, executionId), "deny-1")).rejects.toMatchObject(
      {
        code: "POLICY_DENIED",
        message: expect.stringContaining("tool not permitted"),
      },
    );

    expect(adapter.calls).toHaveLength(0); // acceptance criterion 5
    const record = await world.toolStore.findByKey(world.applicationId, "deny-1");
    expect(record).toMatchObject({
      status: "denied",
      denialClass: "policy",
      denialCode: "POLICY_DENIED",
    });
    const events = await toolEventsOf(world, executionId);
    expect(events.map((event) => event.type)).toEqual(["execution.tool-denied"]);
    expect(events[0]?.payload).toMatchObject({ denied: true, denialClass: "policy" });
  });

  test("a same-key retry replays the SAME typed denial without a second row or envelope", async () => {
    const adapter = successAdapter({ result: "1" });
    const world = createInMemoryToolsWorld();
    await world.registerTool(CALCULATOR_CONTRACT, adapter);
    const executionId = await world.seedExecution("RUNNING");
    world.admission.denyWith("no");

    await expect(
      world.runtime.invoke(inputOf(world, executionId), "deny-replay"),
    ).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    await expect(
      world.runtime.invoke(inputOf(world, executionId), "deny-replay"),
    ).rejects.toMatchObject({
      code: "POLICY_DENIED",
      details: expect.objectContaining({ denialClass: "policy" }),
    });
    expect(world.toolStore.records.size).toBe(1);
    expect((await toolEventsOf(world, executionId)).length).toBe(1);
    expect(adapter.calls).toHaveLength(0);
  });

  test("budget denial: BUDGET_EXCEEDED before dispatch, journaled, adapter never invoked", async () => {
    const adapter = successAdapter({ result: "1" });
    const world = createInMemoryToolsWorld();
    await world.registerTool(SIDE_EFFECT_TOOL, adapter);
    const executionId = await world.seedExecution("RUNNING");
    world.budgets.denyReservations("monthly budget exhausted");

    await expect(
      world.runtime.invoke(
        inputOf(world, executionId, { toolId: "side-effect-tool" }),
        "deny-budget",
      ),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

    expect(adapter.calls).toHaveLength(0);
    expect(world.budgets.reserveCalls).toHaveLength(1);
    const record = await world.toolStore.findByKey(world.applicationId, "deny-budget");
    expect(record).toMatchObject({ status: "denied", denialClass: "budget" });
    expect((await toolEventsOf(world, executionId))[0]?.type).toBe("execution.tool-denied");
  });

  test("a costed tool with NO wired budget authority fails closed (never executes unbudgeted)", async () => {
    const adapter = successAdapter({ result: "1" });
    const world = createInMemoryToolsWorld({ budgetAuthority: null });
    await world.registerTool(SIDE_EFFECT_TOOL, adapter);
    const executionId = await world.seedExecution("RUNNING");

    await expect(
      world.runtime.invoke(
        inputOf(world, executionId, { toolId: "side-effect-tool" }),
        "deny-noauth",
      ),
    ).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      message: expect.stringContaining("no budget authority is wired"),
    });
    expect(adapter.calls).toHaveLength(0);
    const record = await world.toolStore.findByKey(world.applicationId, "deny-noauth");
    expect(record).toMatchObject({ status: "denied", denialClass: "budget" });
  });

  test("capability denial: CAPABILITY_UNAVAILABLE before dispatch, journaled", async () => {
    const adapter = successAdapter({ result: "1" });
    const world = createInMemoryToolsWorld();
    await world.registerTool(CALCULATOR_CONTRACT, adapter);
    const executionId = await world.seedExecution("RUNNING");
    world.capabilities.fail();

    await expect(
      world.runtime.invoke(inputOf(world, executionId), "deny-cap"),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      message: expect.stringContaining("cannot be satisfied"),
    });
    expect(adapter.calls).toHaveLength(0);
    const record = await world.toolStore.findByKey(world.applicationId, "deny-cap");
    expect(record).toMatchObject({ status: "denied", denialClass: "capability" });
  });

  test("unregistered tool: CAPABILITY_UNAVAILABLE before any side effect (no adapter exists)", async () => {
    const { world, executionId } = await seededWorld();
    await expect(
      world.runtime.invoke(inputOf(world, executionId, { toolId: "ghost-tool" }), "deny-unreg"),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      message: expect.stringContaining("not registered"),
    });
    // No journal row was claimed for an unresolvable tool.
    expect(world.toolStore.records.size).toBe(0);
    expect((await toolEventsOf(world, executionId)).length).toBe(0);
  });

  test("tenant isolation: a foreign-tenant actor is rejected BEFORE any dispatch (typed)", async () => {
    const adapter = successAdapter({ result: "1" });
    const world = createInMemoryToolsWorld();
    await world.registerTool(CALCULATOR_CONTRACT, adapter);
    const executionId = await world.seedExecution("RUNNING");

    await expect(
      world.runtime.invoke(
        inputOf(world, executionId, {
          actor: {
            actorId: "00000000-0000-7000-8000-0000000000cc",
            tenantId: "00000000-0000-7000-8000-0000000000dd",
          },
        }),
        "deny-tenant",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    expect(adapter.calls).toHaveLength(0);
    expect(world.toolStore.records.size).toBe(0); // nothing durable claimed
  });

  test("unknown execution (or wrong application) is rejected before dispatch", async () => {
    const { world } = await seededWorld();
    await expect(
      world.runtime.invoke(inputOf(world, "00000000-0000-7000-8000-0000000000ff"), "deny-noexec"),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });

  test("terminal executions accept no tool invocations", async () => {
    const adapter = successAdapter({ result: "1" });
    const world = createInMemoryToolsWorld();
    await world.registerTool(CALCULATOR_CONTRACT, adapter);
    const executionId = await world.seedExecution("RUNNING");
    await world.executionService.transition(
      {
        command: "fail",
        actorId: world.actorId,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        executionId,
        verificationResults: [{ criterionId: "c", strategy: "s", status: "FAIL", recordedBy: "t" }],
      },
      "fail-key",
    );
    await expect(
      world.runtime.invoke(inputOf(world, executionId), "deny-terminal"),
    ).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      message: expect.stringContaining("terminal"),
    });
    expect(adapter.calls).toHaveLength(0);
  });

  test("input-contract violations are typed pre-admission failures (no key claimed)", async () => {
    const { world, executionId } = await seededWorld();
    await expect(
      world.runtime.invoke(
        inputOf(world, executionId, { input: { operation: "add" } }),
        "bad-input",
      ),
    ).rejects.toMatchObject({
      code: "POLICY_DENIED",
      message: expect.stringContaining("input contract"),
    });
    await expect(
      world.runtime.invoke(
        inputOf(world, executionId, {
          input: { operation: "add", left: "1", right: "2", extra: 3 },
        }),
        "bad-input-2",
      ),
    ).rejects.toMatchObject({
      code: "POLICY_DENIED",
      message: expect.stringContaining("undeclared field"),
    });
    expect(world.toolStore.records.size).toBe(0);
    expect(world.admission.calls).toHaveLength(0); // policy never consulted for invalid input
  });
});

describe("governed tool runtime — typed failures and normalization", () => {
  test("a returned tool failure is a durable tool-axis outcome (TOOL_ERROR axis, not provider/policy)", async () => {
    const world = createInMemoryToolsWorld();
    await world.registerTool(CALCULATOR_CONTRACT, failingAdapter);
    const executionId = await world.seedExecution("RUNNING");

    const result = await world.runtime.invoke(inputOf(world, executionId), "fail-1");
    expect(result).toMatchObject({
      status: "tool-failed",
      outcomeClass: "tool-failure",
      failureClass: "tool-execution",
      retryable: false,
      output: null,
    });
    const record = await world.toolStore.findByKey(world.applicationId, "fail-1");
    expect(record).toMatchObject({
      status: "tool-failed",
      outcomeClass: "tool-failure",
      failureClass: "tool-execution",
      failureMessage: "the tool broke",
    });
  });

  test("an adapter that THROWS becomes an adapter-error observation (typed tool failure)", async () => {
    const world = createInMemoryToolsWorld();
    await world.registerTool(CALCULATOR_CONTRACT, throwingAdapter);
    const executionId = await world.seedExecution("RUNNING");
    const result = await world.runtime.invoke(inputOf(world, executionId), "fail-throw");
    expect(result).toMatchObject({
      status: "tool-failed",
      failureClass: "adapter-error",
      retryable: false,
    });
  });

  test("output-contract violations are typed failures (the runtime enforces the declared output schema)", async () => {
    const world = createInMemoryToolsWorld();
    await world.registerTool(CALCULATOR_CONTRACT, badOutputAdapter);
    const executionId = await world.seedExecution("RUNNING");
    const result = await world.runtime.invoke(inputOf(world, executionId), "fail-output");
    expect(result).toMatchObject({
      status: "tool-failed",
      failureClass: "output-contract",
      output: null,
    });
  });

  test("timeout: the runtime enforces the declared deadline", async () => {
    const world = createInMemoryToolsWorld();
    const slow: ToolContract = {
      ...CALCULATOR_CONTRACT,
      execution: { deterministic: true, timeoutMs: 30, idempotent: true },
    };
    await world.registerTool(slow, neverAdapter);
    const executionId = await world.seedExecution("RUNNING");
    const result = await world.runtime.invoke(inputOf(world, executionId), "fail-timeout");
    expect(result).toMatchObject({
      status: "tool-failed",
      failureClass: "timeout",
      retryable: true,
    });
  });

  test("normalization: output validated, artifacts extracted, usage recorded", async () => {
    const adapter = successAdapter({ result: "7" }, ["artifact://derived-1"]);
    const world = createInMemoryToolsWorld();
    await world.registerTool(
      { ...SIDE_EFFECT_TOOL, cost: { estimatedMicroUsd: "250" } },
      new (adapter.constructor as new (b: unknown) => ToolAdapter)(async () => ({
        kind: "tool-success" as const,
        output: { result: "7" },
        artifacts: ["artifact://derived-1"],
        usageMicroUsd: "180",
      })),
    );
    const executionId = await world.seedExecution("RUNNING");
    const result = await world.runtime.invoke(
      inputOf(world, executionId, { toolId: "side-effect-tool" }),
      "norm-1",
    );
    expect(result).toMatchObject({
      output: { result: "7" },
      outputArtifacts: ["artifact://derived-1"],
    });
    const record = await world.toolStore.findByKey(world.applicationId, "norm-1");
    expect(record?.usageMicroUsd).toBe("180");
    expect(record?.outputArtifacts).toEqual(["artifact://derived-1"]);
    // Settled at ACTUAL usage (180), not the estimate (250).
    expect(world.budgets.settleCalls[0]?.command).toMatchObject({ actualAmountMicroUsd: "180" });
  });

  test("tool failure classification never becomes verification vocabulary", async () => {
    const world = createInMemoryToolsWorld();
    await world.registerTool(CALCULATOR_CONTRACT, failingAdapter);
    const executionId = await world.seedExecution("RUNNING");
    await world.runtime.invoke(inputOf(world, executionId), "vocab-1");
    const record = await world.toolStore.findByKey(world.applicationId, "vocab-1");
    expect(record?.outcomeClass).toBe("tool-failure"); // never FAIL / PASS / INCONCLUSIVE
    expect(record?.status).toBe("tool-failed"); // never a verification status
  });
});

describe("governed tool runtime — provenance and evidence", () => {
  test("every result carries full provenance; the row and ledger reference each other", async () => {
    const { world, executionId } = await seededWorld();
    const result = await world.runtime.invoke(inputOf(world, executionId), "prov-1");

    const record = await world.toolStore.findByKey(world.applicationId, "prov-1");
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      executionId,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      toolId: "calculator",
      toolVersion: "1.0.0",
      capabilityId: "arithmetic",
      inputDigest: expect.stringContaining("digest:"),
      policyEvidence: {
        policySetId: "set-1",
        policySetVersion: 3,
        policyContentHash: "hash-1",
        restrictionSetDigest: "digest-1",
      },
      capabilitySatisfaction: expect.stringContaining("arithmetic@"),
      dispatchedAt: expect.any(String),
      completedAt: expect.any(String),
      durationMs: expect.any(Number),
    });
    // Result provenance includes ledger bindings.
    expect(result.invocationId).toBe(record?.id);
    expect(result.ledgerRequestedSequence).toBe(6); // after the 5 lifecycle events
    expect(result.ledgerEvidenceSequence).toBe(7);

    const events = await toolEventsOf(world, executionId);
    expect(events.map((event) => event.type)).toEqual([
      "execution.tool-requested",
      "execution.tool-result",
    ]);
    for (const event of events) {
      expect(event.reference).toMatchObject({
        invocationId: record?.id,
        toolId: "calculator",
        toolVersion: "1.0.0",
        capabilityId: "arithmetic",
        inputDigest: record?.inputDigest,
        policy: { policySetId: "set-1" },
      });
      expect(event.cause).toBe("tool-invocation");
      expect(event.actor).toMatchObject({ tenantId: world.tenantId, actorId: record?.id });
    }
  });

  test("input artifact references are recorded as input provenance (upstream evidence)", async () => {
    const { world, executionId } = await seededWorld();
    await world.runtime.invoke(
      inputOf(world, executionId, { inputArtifactRefs: ["artifact://upstream-1"] }),
      "prov-2",
    );
    const record = await world.toolStore.findByKey(world.applicationId, "prov-2");
    expect(record?.inputArtifacts).toEqual(["artifact://upstream-1"]);
  });

  test("tool results are available as DOWNSTREAM evidence (TOL-002): a later invocation consumes them", async () => {
    const adapter = successAdapter({ result: "7" }, ["artifact://step-1-output"]);
    const world = createInMemoryToolsWorld();
    await world.registerTool(SIDE_EFFECT_TOOL, adapter);
    const executionId = await world.seedExecution("RUNNING");

    const first = await world.runtime.invoke(
      inputOf(world, executionId, { toolId: "side-effect-tool" }),
      "chain-1",
    );
    const evidence = await world.runtime.listInvocationsByExecution(
      world.applicationId,
      executionId,
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.outputArtifacts).toEqual(["artifact://step-1-output"]);

    // The downstream step references the upstream artifacts as input provenance.
    const second = await world.runtime.invoke(
      inputOf(world, executionId, {
        toolId: "side-effect-tool",
        inputArtifactRefs: [...first.outputArtifacts],
      }),
      "chain-2",
    );
    expect(second.status).toBe("succeeded");
    const downstream = await world.toolStore.findByKey(world.applicationId, "chain-2");
    expect(downstream?.inputArtifacts).toEqual(["artifact://step-1-output"]);
    const timeline = await world.runtime.listInvocationsByExecution(
      world.applicationId,
      executionId,
    );
    expect(timeline).toHaveLength(2);
  });

  test("tool success NEVER moves execution status (authority preservation)", async () => {
    const { world, executionId } = await seededWorld();
    await world.runtime.invoke(inputOf(world, executionId), "auth-1");
    const execution = await world.executionService.getExecution(world.applicationId, executionId);
    expect(execution?.status).toBe("RUNNING"); // unchanged; only the sequence advanced
    expect(execution?.lastEventSequence).toBe(7);
  });
});

describe("governed tool runtime — idempotency, concurrency and crash safety", () => {
  test("same key + same input replays the SAME durable outcome (adapter dispatched exactly once)", async () => {
    const adapter = successAdapter({ result: "42" });
    const world = createInMemoryToolsWorld();
    await world.registerTool(CALCULATOR_CONTRACT, adapter);
    const executionId = await world.seedExecution("RUNNING");

    const first = await world.runtime.invoke(inputOf(world, executionId), "idem-1");
    const replay = await world.runtime.invoke(inputOf(world, executionId), "idem-1");

    expect(replay.replayed).toBe(true);
    expect(replay.invocationId).toBe(first.invocationId);
    expect(replay.output).toEqual(first.output);
    expect(adapter.calls).toHaveLength(1);
    expect(world.toolStore.records.size).toBe(1);
    // Exactly ONE pair of ledger envelopes for the logical invocation.
    const events = await toolEventsOf(world, executionId);
    expect(events.map((event) => event.type)).toEqual([
      "execution.tool-requested",
      "execution.tool-result",
    ]);
  });

  test("same key + different input fails IDEMPOTENCY_KEY_REUSED", async () => {
    const { world, executionId } = await seededWorld();
    await world.runtime.invoke(inputOf(world, executionId), "reuse-1");
    await expect(
      world.runtime.invoke(
        inputOf(world, executionId, { input: { operation: "add", left: "1", right: "2" } }),
        "reuse-1",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("crash recovery (dispatching row): a contract-idempotent tool re-executes and converges", async () => {
    const adapter = successAdapter({ result: "42" });
    const world = createInMemoryToolsWorld();
    await world.registerTool(CALCULATOR_CONTRACT, adapter);
    const executionId = await world.seedExecution("RUNNING");

    // Simulate the crash state: a previous attempt committed durable intent
    // (dispatching) and died before recording the outcome.
    const fingerprint = (
      await import("../../../src/modules/tools/application/tool-runtime")
    ).toolRequestFingerprint(inputOf(world, executionId));
    await world.toolStore.claimDispatching({
      id: "00000000-0000-7000-8000-00000000c0de",
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      invocationKey: "crash-1",
      requestFingerprint: fingerprint,
      toolId: "calculator",
      toolVersion: "1.0.0",
      capabilityId: "arithmetic",
      inputDigest: "digest:crash",
      inputArtifacts: [],
      budgetOperationId: null,
      policyEvidence: null,
      capabilitySatisfaction: null,
      requestedAt: "2026-09-15T12:00:00Z",
    });

    const result = await world.runtime.invoke(inputOf(world, executionId), "crash-1");
    expect(result).toMatchObject({
      invocationId: "00000000-0000-7000-8000-00000000c0de",
      status: "succeeded",
      replayed: true,
    });
    expect(world.toolStore.records.size).toBe(1);
    const events = await toolEventsOf(world, executionId);
    expect(events.map((event) => event.type)).toEqual([
      "execution.tool-requested",
      "execution.tool-result",
    ]);
  });

  test("crash recovery (dispatching row): a NON-idempotent tool fails closed as non-convergent", async () => {
    const adapter = successAdapter({ result: "42" });
    const world = createInMemoryToolsWorld();
    await world.registerTool(NON_IDEMPOTENT_TOOL, adapter);
    const executionId = await world.seedExecution("RUNNING");

    const request = inputOf(world, executionId, { toolId: "non-idempotent-tool" });
    const fingerprint = (
      await import("../../../src/modules/tools/application/tool-runtime")
    ).toolRequestFingerprint(request);
    await world.toolStore.claimDispatching({
      id: "00000000-0000-7000-8000-00000000c0ff",
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      invocationKey: "crash-2",
      requestFingerprint: fingerprint,
      toolId: "non-idempotent-tool",
      toolVersion: "1.0.0",
      capabilityId: "arithmetic",
      inputDigest: "digest:crash",
      inputArtifacts: [],
      budgetOperationId: null,
      policyEvidence: null,
      capabilitySatisfaction: null,
      requestedAt: "2026-09-15T12:00:00Z",
    });

    await expect(world.runtime.invoke(request, "crash-2")).rejects.toMatchObject({
      code: "NON_CONVERGENT_EXTERNAL_EFFECT",
      message: expect.stringContaining("unknown external outcome"),
    });
    expect(adapter.calls).toHaveLength(0); // no re-dispatch of a non-idempotent tool
  });

  test("concurrent duplicate invocations converge on one durable outcome (serialized claims)", async () => {
    const adapter = successAdapter({ result: "42" });
    const world = createInMemoryToolsWorld();
    await world.registerTool(CALCULATOR_CONTRACT, adapter);
    const executionId = await world.seedExecution("RUNNING");

    const results = await Promise.all([
      world.runtime.invoke(inputOf(world, executionId), "conc-1"),
      world.runtime.invoke(inputOf(world, executionId), "conc-1"),
      world.runtime.invoke(inputOf(world, executionId), "conc-1"),
    ]);

    const ids = new Set(results.map((result) => result.invocationId));
    expect(ids.size).toBe(1); // ONE durable identity
    expect(world.toolStore.records.size).toBe(1); // ONE row
    const outputs = new Set(results.map((result) => JSON.stringify(result.output)));
    expect(outputs.size).toBe(1); // identical durable outcome for every caller
    const events = await toolEventsOf(world, executionId);
    expect(events.filter((event) => event.type === "execution.tool-requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "execution.tool-result")).toHaveLength(1);
    // The adapter may have dispatched multiple times ONLY because the
    // contract declares idempotency (safe by contract).
    expect(adapter.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("budget settlement reconciliation on replay: a settle crash converges on retry", async () => {
    const adapter = successAdapter({ result: "7" });
    const world = createInMemoryToolsWorld();
    await world.registerTool(SIDE_EFFECT_TOOL, adapter);
    const executionId = await world.seedExecution("RUNNING");

    // First invocation settles normally.
    await world.runtime.invoke(
      inputOf(world, executionId, { toolId: "side-effect-tool" }),
      "settle-1",
    );
    expect(world.budgets.settleCalls).toHaveLength(1);
    // Simulate the settlement ledger losing the record (crash after durable
    // outcome): a replay re-attempts settlement with the SAME key and
    // converges. The fake models the REAL keyed idempotency — the
    // re-attempt is observable as a CONVERGED finalization (never a
    // second debit; exactly one physical settle per stable key).
    await world.runtime.invoke(
      inputOf(world, executionId, { toolId: "side-effect-tool" }),
      "settle-1",
    );
    expect(world.budgets.convergedFinalizations).toHaveLength(1);
    expect(world.budgets.convergedFinalizations[0]).toContain("settle-");
    expect(world.budgets.settleCalls).toHaveLength(1);
    expect(new Set(world.budgets.settleCalls.map((call) => call.key)).size).toBe(1);
  });
});

describe("governed tool runtime — side-effect ordering and budget discipline", () => {
  test("ledger order proves: requested BEFORE result; admission evidence rides the requested envelope", async () => {
    const { world, executionId } = await seededWorld();
    await world.runtime.invoke(inputOf(world, executionId), "order-3");
    const events = await toolEventsOf(world, executionId);
    const requested = events.find((event) => event.type === "execution.tool-requested");
    const result = events.find((event) => event.type === "execution.tool-result");
    expect(requested).toBeDefined();
    expect(result).toBeDefined();
    expect((requested?.sequence ?? 0) < (result?.sequence ?? 0)).toBe(true);
    expect(requested?.reference).toMatchObject({ policy: { policySetId: "set-1" } });
  });

  test("a costed tool reserves BEFORE dispatch and settles ACTUAL usage after success", async () => {
    const adapter = successAdapter({ result: "7" });
    const world = createInMemoryToolsWorld();
    await world.registerTool(SIDE_EFFECT_TOOL, adapter);
    const executionId = await world.seedExecution("RUNNING");

    const order: string[] = [];
    const originalReserve = world.budgets.impl.reserve.bind(world.budgets.impl);
    world.budgets.impl.reserve = async (command, key) => {
      order.push("reserve");
      return originalReserve(command, key);
    };
    adapter.behavior = async () => {
      order.push("adapter");
      return { kind: "tool-success", output: { result: "7" }, usageMicroUsd: "100" };
    };

    await world.runtime.invoke(
      inputOf(world, executionId, { toolId: "side-effect-tool" }),
      "budget-1",
    );
    expect(order).toEqual(["reserve", "adapter"]);
    expect(world.budgets.reserveCalls[0]?.command).toMatchObject({
      executionId,
      amountMicroUsd: "250",
      operationId: "tool-invocation:budget-1",
    });
    expect(world.budgets.settleCalls[0]?.command).toMatchObject({
      operationId: "tool-invocation:budget-1",
      actualAmountMicroUsd: "100",
    });
    expect(world.budgets.releaseCalls).toHaveLength(0);
  });

  test("a failed costed tool RELEASES the hold (no spend incurred)", async () => {
    const world = createInMemoryToolsWorld();
    await world.registerTool(SIDE_EFFECT_TOOL, failingAdapter);
    const executionId = await world.seedExecution("RUNNING");

    const result = await world.runtime.invoke(
      inputOf(world, executionId, { toolId: "side-effect-tool" }),
      "budget-fail",
    );
    expect(result.status).toBe("tool-failed");
    expect(world.budgets.reserveCalls).toHaveLength(1);
    expect(world.budgets.settleCalls).toHaveLength(0);
    expect(world.budgets.releaseCalls[0]?.command).toMatchObject({
      operationId: "tool-invocation:budget-fail",
    });
  });

  test("a capability denial AFTER reservation releases the hold", async () => {
    const world = createInMemoryToolsWorld();
    await world.registerTool(SIDE_EFFECT_TOOL, successAdapter({ result: "1" }));
    const executionId = await world.seedExecution("RUNNING");
    world.capabilities.fail();

    await expect(
      world.runtime.invoke(
        inputOf(world, executionId, { toolId: "side-effect-tool" }),
        "budget-cap",
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(world.budgets.reserveCalls).toHaveLength(1);
    expect(world.budgets.releaseCalls).toHaveLength(1);
    expect(world.budgets.releaseCalls[0]?.command).toMatchObject({
      operationId: "tool-invocation:budget-cap",
    });
  });
});
