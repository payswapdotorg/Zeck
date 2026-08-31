/**
 * Real-PostgreSQL — the governed sandbox lifecycle (WORK-012;
 * ENV-001/ENV-002; checkpoint contracts IDENTITY-IDEMPOTENCY,
 * CONCURRENCY-CRASH-SAFETY, TENANT-ISOLATION, POLICY-BEFORE-DISPATCH,
 * BUDGET-INTEGRITY, SANDBOX-BOUNDARY, EXECUTION-PROVENANCE).
 *
 * Proves against real PostgreSQL with the FULL production composition
 * (real executions service + ledger, real policy authority, real
 * capability registry, real budget service, SQL sandbox store):
 *   - the admission chain order and the durable admitted bundle with
 *     immutable runtime metadata bound to the parent execution (criterion
 *     4; M12/M13/M15);
 *   - sandbox-escape/host-access capability rejected BY POLICY (the
 *     isolation floor + host allowlists + secret refs — criterion 5's
 *     policy half) AND by the ADAPTER CONFIGURATION (the container
 *     profile validator — the unit/platform suites; here the fail-closed
 *     container dispatch without a runtime client);
 *   - journal-then-fail denials (policy/capability/budget) as durable
 *     rows + sandbox-denied envelopes;
 *   - duplicate sandbox convergence (including the CONCURRENT ×8 race on
 *     the unique index — M11) and key-reuse rejection;
 *   - cross-tenant/cross-application rejection at every boundary (M9/M10);
 *   - costed compute: reservation before dispatch, settlement after
 *     (BUDGET-INTEGRITY; M4);
 *   - no-execution as a first-class environment (M17) and process
 *     execution through the REAL platform runtime;
 *   - provenance persistence: ledger envelopes with who/what/when/why
 *     (M16) and the runtime-metadata immutability at the storage
 *     boundary.
 */

import { expect, test } from "vitest";
import { ContainerSandboxProvider } from "../../../src/modules/sandbox/adapters/container-provider";
import { ProcessSandboxProvider } from "../../../src/modules/sandbox/adapters/process-provider";
import { PlatformError } from "../../../src/shared/errors";
import { definePgSuite } from "./harness";
import { RecordingProvider, seedSandboxWorld } from "./sandbox-world";

const TASK = {
  command: "python3",
  args: ["analyze.py"],
  publicEnv: { MODE: "batch" },
};

definePgSuite("sandbox executions (real PG)", (ctx) => {
  async function seed() {
    const world = await seedSandboxWorld(ctx.port);
    const executionId = await world.seedExecution("RUNNING");
    return { world, executionId };
  }

  test("admission binds identity to the execution and persists immutable runtime metadata (criterion 4)", async () => {
    const { world, executionId } = await seed();
    const environmentId = await world.registerEnvironment("analysis", {
      kind: "container",
      limits: { cpuMilliCores: 1000, memoryMiB: 256, executionTimeoutMs: 60_000 },
      network: { egress: "allowlist", allowedHosts: ["api.example.com"] },
      filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: ["artifact-1"] },
      secrets: { secretRefs: ["conn-customer-api"] },
      runtime: { capabilityId: "container-runtime" },
      cost: { estimatedCostMicroUsd: "0" },
    });
    const record = await world.service.createSandboxExecution(
      { executionId, environmentId, task: TASK },
      "key-1",
      world.actor(),
    );
    expect(record.status).toBe("admitted");
    expect(record.executionId).toBe(executionId);
    expect(record.applicationId).toBe(world.applicationId);
    expect(record.tenantId).toBe(world.tenantId);
    expect(record.kind).toBe("container");
    expect(record.runtimeMetadata.environmentId).toBe(environmentId);
    expect(record.runtimeMetadata.limits).toEqual({
      cpuMilliCores: 1000,
      memoryMiB: 256,
      executionTimeoutMs: 60_000,
    });
    expect(record.runtimeMetadata.secretRefs).toEqual(["conn-customer-api"]);
    expect(record.runtimeMetadata.policyEvidence).toMatchObject({ policySetId: "default" });
    expect(record.runtimeMetadata.capabilitySatisfaction).toContain("container-runtime");

    // the runtime metadata is IMMUTABLE at the storage boundary (M13):
    await expect(
      ctx.port.execute({
        sql: "UPDATE sandbox.sandbox_executions SET runtime_metadata = '{}'::jsonb WHERE id = $1",
        parameters: [record.id],
      }),
    ).rejects.toThrow(/immutable/i);
  });

  test("sandbox escape is rejected BY POLICY: the isolation floor denies process for untrusted work (criterion 5)", async () => {
    const { world, executionId } = await seed();
    // Publish a restricted v2 policy: untrusted work needs containers.
    await world.policyAuthority.publish({
      id: "default",
      version: 2,
      documents: [
        {
          scope: "platform",
          selector: {},
          restrictions: { isolation: { minIsolation: "container" } },
        },
      ],
    });
    const processEnvId = await world.registerEnvironment("analysis", {
      kind: "process",
      limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
      secrets: { secretRefs: [] },
      runtime: { capabilityId: "process-sandbox" },
      cost: { estimatedCostMicroUsd: "0" },
    });
    await expect(
      world.service.createSandboxExecution(
        { executionId, environmentId: processEnvId, task: TASK },
        "key-floor",
        world.actor(),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    const denied = await world.sandboxStore.findSandboxByKey(world.applicationId, "key-floor");
    expect(denied?.status).toBe("denied");
    expect(denied?.denialClass).toBe("policy");
    // the denial is durable evidence on the canonical ledger:
    const events = await world.executionService.listEvents(world.applicationId, executionId);
    expect(events.some((e) => e.type === "execution.sandbox-denied")).toBe(true);
  });

  test("host access is rejected BY POLICY: unapproved egress hosts and secret refs are denied (criterion 5)", async () => {
    const { world, executionId } = await seed();
    await world.policyAuthority.publish({
      id: "default",
      version: 2,
      documents: [
        {
          scope: "platform",
          selector: {},
          restrictions: {
            network: { egress: "allowlist", allowedHosts: ["trusted.example.com"] },
            secrets: { access: "none" },
          },
        },
      ],
    });
    const envId = await world.registerEnvironment("untrusted", {
      kind: "container",
      limits: { cpuMilliCores: 1000, memoryMiB: 256, executionTimeoutMs: 60_000 },
      network: { egress: "allowlist", allowedHosts: ["evil.example.com"] },
      filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
      secrets: { secretRefs: ["conn-customer-api"] },
      runtime: { capabilityId: "container-runtime" },
      cost: { estimatedCostMicroUsd: "0" },
    });
    // the unapproved host is denied:
    await expect(
      world.service.createSandboxExecution(
        { executionId, environmentId: envId, task: TASK },
        "key-host",
        world.actor(),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });

    // and a secret-free environment on the approved host is admitted:
    const okEnvId = await world.registerEnvironment("trusted", {
      kind: "container",
      limits: { cpuMilliCores: 1000, memoryMiB: 256, executionTimeoutMs: 60_000 },
      network: { egress: "allowlist", allowedHosts: ["trusted.example.com"] },
      filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
      secrets: { secretRefs: [] },
      runtime: { capabilityId: "container-runtime" },
      cost: { estimatedCostMicroUsd: "0" },
    });
    const admitted = await world.service.createSandboxExecution(
      { executionId, environmentId: okEnvId, task: TASK },
      "key-host-ok",
      world.actor(),
    );
    expect(admitted.status).toBe("admitted");
  });

  test("capability denial is durable + typed when the runtime claim is absent (M3)", async () => {
    const { world, executionId } = await seed();
    const envId = await world.registerEnvironment("exotic", {
      kind: "microvm",
      limits: { cpuMilliCores: 1000, memoryMiB: 512, executionTimeoutMs: 60_000 },
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
      secrets: { secretRefs: [] },
      runtime: { capabilityId: "microvm-fleet" },
      cost: { estimatedCostMicroUsd: "0" },
    });
    await expect(
      world.service.createSandboxExecution(
        { executionId, environmentId: envId, task: TASK },
        "key-microvm",
        world.actor(),
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    const denied = await world.sandboxStore.findSandboxByKey(world.applicationId, "key-microvm");
    expect(denied?.denialClass).toBe("capability");
  });

  test("costed compute: reservation before dispatch, settlement after (BUDGET-INTEGRITY; M4)", async () => {
    const { world, executionId } = await seed();
    const envId = await world.registerEnvironment("costed", {
      kind: "process",
      limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
      secrets: { secretRefs: [] },
      runtime: { capabilityId: "process-sandbox" },
      cost: { estimatedCostMicroUsd: "5000" },
    });
    // UNDERFUNDED (the tools-world precedent): the application is funded
    // with LESS than the environment's estimate — the costed sandbox
    // fails closed at admission with the authority's BUDGET_EXCEEDED.
    const { fundApplication } = await import("./sandbox-world");
    await fundApplication(world, "300");
    await expect(
      world.service.createSandboxExecution(
        { executionId, environmentId: envId, task: TASK },
        "key-underfunded",
        world.actor(),
      ),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    const deniedBudget = await world.sandboxStore.findSandboxByKey(
      world.applicationId,
      "key-underfunded",
    );
    expect(deniedBudget?.status).toBe("denied");
    expect(deniedBudget?.denialClass).toBe("budget");

    // TOP-UP: the reservation is placed at admission and settled at
    // completion (actual usage 0 for the unmetered process runtime).
    await world.budgets.grantCredits(
      {
        actorId: world.actor().actorId,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        ownerKind: "developer",
        amountMicroUsd: "10000",
      },
      `fund-${world.applicationId}:topup`,
    );
    const admitted = await world.service.createSandboxExecution(
      {
        executionId,
        environmentId: envId,
        task: { command: process.execPath, args: ["-e", "console.log('ok')"], publicEnv: {} },
      },
      "key-funded",
      world.actor(),
    );
    expect(admitted.budgetOperationId).toBe("sandbox-execution:key-funded");
    world.registerProvider(new ProcessSandboxProvider());
    const completed = await world.service.dispatchSandboxExecution(
      { applicationId: world.applicationId, sandboxId: admitted.id },
      world.actor(),
    );
    expect(completed.status).toBe("completed");
    const ledger = await ctx.port.execute<{
      direction: string;
      amount_micro_usd: string;
    }>({
      sql: "SELECT le.direction, le.amount_micro_usd::text AS amount_micro_usd FROM budgets.ledger_entries le JOIN budgets.reservations r ON le.reservation_id = r.id WHERE r.operation_id = $1 ORDER BY le.occurred_at",
      parameters: ["sandbox-execution:key-funded"],
    });
    const directions = ledger.rows.map((row) => `${row.direction}:${row.amount_micro_usd}`);
    expect(directions).toContain("debit:5000"); // the reservation hold
    expect(directions).toContain("credit:5000"); // the settlement refund (actual 0)
  });

  test("duplicate sandbox creation converges; key reuse with a different fingerprint fails (M11)", async () => {
    const { world, executionId } = await seed();
    const environmentId = await world.registerEnvironment("analysis", {
      kind: "no-execution",
      limits: null,
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "none", readOnlyArtifactRefs: [] },
      secrets: { secretRefs: [] },
      runtime: null,
      cost: { estimatedCostMicroUsd: "0" },
    });
    const input = { executionId, environmentId, task: TASK };
    const first = await world.service.createSandboxExecution(input, "dup-key", world.actor());
    const replay = await world.service.createSandboxExecution(input, "dup-key", world.actor());
    expect(replay.id).toBe(first.id);
    await expect(
      world.service.createSandboxExecution(
        { ...input, task: { ...TASK, command: "node" } },
        "dup-key",
        world.actor(),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    const rows = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM sandbox.sandbox_executions WHERE application_id = $1 AND sandbox_key = 'dup-key'",
      parameters: [world.applicationId],
    });
    expect(rows.rows[0]?.count).toBe("1");
  });

  test("CONCURRENT duplicate sandbox creation converges on ONE identity (M11)", async () => {
    const { world, executionId } = await seed();
    const environmentId = await world.registerEnvironment("analysis", {
      kind: "no-execution",
      limits: null,
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "none", readOnlyArtifactRefs: [] },
      secrets: { secretRefs: [] },
      runtime: null,
      cost: { estimatedCostMicroUsd: "0" },
    });
    const input = { executionId, environmentId, task: TASK };
    const actor = world.actor();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        world.service.createSandboxExecution(input, "race-key", actor),
      ),
    );
    expect(new Set(results.map((record) => record.id)).size).toBe(1);
    const rows = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM sandbox.sandbox_executions WHERE application_id = $1 AND sandbox_key = 'race-key'",
      parameters: [world.applicationId],
    });
    expect(rows.rows[0]?.count).toBe("1");
  });

  test("cross-tenant and cross-application access fails closed (M9/M10)", async () => {
    const { world, executionId } = await seed();
    const environmentId = await world.registerEnvironment("analysis", {
      kind: "no-execution",
      limits: null,
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "none", readOnlyArtifactRefs: [] },
      secrets: { secretRefs: [] },
      runtime: null,
      cost: { estimatedCostMicroUsd: "0" },
    });
    const record = await world.service.createSandboxExecution(
      { executionId, environmentId, task: TASK },
      "scope-key",
      world.actor(),
    );
    // another tenant cannot dispatch it:
    await expect(
      world.service.dispatchSandboxExecution(
        { applicationId: world.applicationId, sandboxId: record.id },
        {
          actorId: world.actor().actorId,
          applicationId: world.applicationId,
          tenantId: "00000000-0000-7000-8000-0000000000ff",
        },
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    // another application cannot even see it:
    await expect(
      world.service.dispatchSandboxExecution(
        { applicationId: "00000000-0000-7000-8000-0000000000ee", sandboxId: record.id },
        {
          actorId: world.actor().actorId,
          applicationId: "00000000-0000-7000-8000-0000000000ee",
          tenantId: world.tenantId,
        },
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });

  test("no-execution is first class: admitted + completed WITHOUT any provider (M17)", async () => {
    const { world, executionId } = await seed();
    const environmentId = await world.registerEnvironment("none", {
      kind: "no-execution",
      limits: null,
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "none", readOnlyArtifactRefs: [] },
      secrets: { secretRefs: [] },
      runtime: null,
      cost: { estimatedCostMicroUsd: "0" },
    });
    const admitted = await world.service.createSandboxExecution(
      { executionId, environmentId, task: TASK },
      "noexec-key",
      world.actor(),
    );
    const completed = await world.service.dispatchSandboxExecution(
      { applicationId: world.applicationId, sandboxId: admitted.id },
      world.actor(),
    );
    expect(completed.status).toBe("completed");
    expect(completed.outcomeClass).toBe("sandbox-success");
    expect(world.providers.providerFor("no-execution")).toBeNull();
    // evidence on the canonical ledger: admitted + completed
    const events = await world.executionService.listEvents(world.applicationId, executionId);
    const commands = events.map((e) => e.type);
    expect(commands).toContain("execution.sandbox-admitted");
    expect(commands).toContain("execution.sandbox-completed");
  });

  test("process execution through the REAL platform runtime (criterion 2)", async () => {
    const { world, executionId } = await seed();
    const environmentId = await world.registerEnvironment("analysis", {
      kind: "process",
      limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 20_000 },
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
      secrets: { secretRefs: [] },
      runtime: { capabilityId: "process-sandbox" },
      cost: { estimatedCostMicroUsd: "0" },
    });
    world.registerProvider(new ProcessSandboxProvider());
    const admitted = await world.service.createSandboxExecution(
      {
        executionId,
        environmentId,
        task: {
          command: process.execPath,
          args: ["-e", "console.log(JSON.stringify(process.env))"],
          publicEnv: { EXPLICIT_ONLY: "yes" },
        },
      },
      "process-key",
      world.actor(),
    );
    const completed = await world.service.dispatchSandboxExecution(
      { applicationId: world.applicationId, sandboxId: admitted.id },
      world.actor(),
    );
    expect(completed.status).toBe("completed");
    expect(completed.outputDigest).toBeTruthy();
    // the child saw EXACTLY the explicit env — no ambient host environment:
    const output = completed.runtimeMetadata.task.publicEnv;
    expect(output).toEqual({ EXPLICIT_ONLY: "yes" });
  }, 30_000);

  test("container dispatch without a runtime client FAILS CLOSED (M18; criterion 5 adapter half)", async () => {
    const { world, executionId } = await seed();
    const environmentId = await world.registerEnvironment("untrusted", {
      kind: "container",
      limits: { cpuMilliCores: 1000, memoryMiB: 256, executionTimeoutMs: 60_000 },
      network: { egress: "allowlist", allowedHosts: ["api.example.com"] },
      filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
      secrets: { secretRefs: [] },
      runtime: { capabilityId: "container-runtime" },
      cost: { estimatedCostMicroUsd: "0" },
    });
    // the container provider with NO runtime client wired:
    world.registerProvider(new ContainerSandboxProvider());
    const admitted = await world.service.createSandboxExecution(
      { executionId, environmentId, task: TASK },
      "container-key",
      world.actor(),
    );
    const outcome = await world.service.dispatchSandboxExecution(
      { applicationId: world.applicationId, sandboxId: admitted.id },
      world.actor(),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failureClass).toBe("runtime-unavailable");
    expect(outcome.failureMessage).toContain("fails closed");
  });

  test("provenance persistence: ledger envelopes reconstruct who/what/when/why (M16)", async () => {
    const { world, executionId } = await seed();
    const environmentId = await world.registerEnvironment("analysis", {
      kind: "process",
      limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 20_000 },
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
      secrets: { secretRefs: [] },
      runtime: { capabilityId: "process-sandbox" },
      cost: { estimatedCostMicroUsd: "0" },
    });
    world.registerProvider(
      new RecordingProvider("process", {
        outcomeClass: "sandbox-success",
        outputDigest: "digest:done",
        output: { exitCode: 0 },
        usageMicroUsd: "0",
        failure: null,
      }),
    );
    const admitted = await world.service.createSandboxExecution(
      { executionId, environmentId, task: TASK },
      "prov-key",
      world.actor(),
    );
    const completed = await world.service.dispatchSandboxExecution(
      { applicationId: world.applicationId, sandboxId: admitted.id },
      world.actor(),
    );
    expect(completed.ledgerAdmittedSequence).not.toBeNull();
    expect(completed.ledgerCompletedSequence).not.toBeNull();

    const events = await world.executionService.listEvents(world.applicationId, executionId);
    const admittedEvent = events.find((e) => e.type === "execution.sandbox-admitted");
    expect(admittedEvent).toBeDefined();
    // WHO: the sandbox identity as provenance actor + the tenant.
    expect(admittedEvent?.actor).toMatchObject({ actorId: admitted.id, tenantId: world.tenantId });
    // WHAT: the identity chain + admitted snapshot.
    expect(admittedEvent?.reference).toMatchObject({
      sandboxId: admitted.id,
      environmentId,
      kind: "process",
      executionId,
    });
    expect(admittedEvent?.payload).toMatchObject({ kind: "process", status: "admitted" });
    // WHY: the cause + the policy evidence.
    expect(admittedEvent?.cause).toBe("sandbox-execution");
    expect(admittedEvent?.reference).toMatchObject({
      policy: {
        policySetId: "default",
        policySetVersion: 1,
      },
    });
    // WHEN: gapless sequencing bound to the row.
    expect(admittedEvent?.sequence).toBe(admitted.ledgerAdmittedSequence);
    const completedEvent = events.find((e) => e.type === "execution.sandbox-completed");
    expect(completedEvent?.sequence).toBe(completed.ledgerCompletedSequence);
    expect(completedEvent?.payload).toMatchObject({ outcomeClass: "sandbox-success" });
  });

  test("a dispatching sandbox (crash state) fails closed NON_CONVERGENT on retry (§14)", async () => {
    const { world, executionId } = await seed();
    const environmentId = await world.registerEnvironment("analysis", {
      kind: "no-execution",
      limits: null,
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "none", readOnlyArtifactRefs: [] },
      secrets: { secretRefs: [] },
      runtime: null,
      cost: { estimatedCostMicroUsd: "0" },
    });
    const admitted = await world.service.createSandboxExecution(
      { executionId, environmentId, task: TASK },
      "crash-key",
      world.actor(),
    );
    // simulate the crash between claim and outcome:
    await ctx.port.execute({
      sql: "UPDATE sandbox.sandbox_executions SET status = 'dispatching', dispatched_at = now() WHERE id = $1",
      parameters: [admitted.id],
    });
    await expect(
      world.service.dispatchSandboxExecution(
        { applicationId: world.applicationId, sandboxId: admitted.id },
        world.actor(),
      ),
    ).rejects.toBeInstanceOf(PlatformError);
  });

  test("a suspended environment admits nothing (fail closed)", async () => {
    const { world, executionId } = await seed();
    const environmentId = await world.registerEnvironment("analysis", {
      kind: "no-execution",
      limits: null,
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "none", readOnlyArtifactRefs: [] },
      secrets: { secretRefs: [] },
      runtime: null,
      cost: { estimatedCostMicroUsd: "0" },
    });
    await world.catalog.suspend(world.applicationId, environmentId, "s-1", world.actor());
    await expect(
      world.service.createSandboxExecution(
        { executionId, environmentId, task: TASK },
        "suspended-key",
        world.actor(),
      ),
    ).rejects.toMatchObject({ code: "SANDBOX_ERROR" });
  });
});
