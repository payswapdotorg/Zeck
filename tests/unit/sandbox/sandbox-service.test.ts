/**
 * Unit — the governed sandbox service (WORK-012, ENV-001/ENV-002): the
 * admission chain, the dispatch boundary and the evidence discipline.
 *
 * Proves (with fakes; the real authorities back the real-PG suites):
 *   - the admission ORDER: execution binding (tenant guard) → environment
 *     resolution → POLICY admission → CAPABILITY admission → BUDGET
 *     admission → durable bundle → ledger evidence (no provider is
 *     consulted before admission — M15);
 *   - journal-then-fail denials: policy/capability/budget denials are
 *     DURABLE denied rows + sandbox-denied envelopes + typed errors;
 *   - runtime metadata immutability: dispatch executes the ADMITTED
 *     snapshot; the provider receives references only (never secret
 *     values — M8; never ambient env — the spec carries exactly the
 *     publicEnv);
 *   - no-execution is first class: dispatch completes structurally with
 *     NO provider consultation (M17);
 *   - costed environments fail closed without a budget authority (M4);
 *   - dispatch requires the admitted state: denied sandboxes cannot
 *     dispatch; a dispatching sandbox (crash state) fails closed as
 *     NON_CONVERGENT; terminal sandboxes replay their outcome;
 *   - cross-tenant/cross-application access fails closed (M9/M10);
 *   - idempotent create: same key replays, key reuse with a different
 *     fingerprint fails IDEMPOTENCY_KEY_REUSED (M11);
 *   - an unwired substrate (container without a runtime client) FAILS
 *     CLOSED — runtime-unavailable, never a permissive fallback (M18);
 *   - the sandbox never writes executions tables: evidence flows through
 *     the ledger seam only (M16).
 */

import { describe, expect, test } from "vitest";
import { ContainerSandboxProvider } from "../../../src/modules/sandbox/adapters/container-provider";
import { InMemorySandboxStore } from "../../../src/modules/sandbox/adapters/in-memory-sandbox-store";
import { createEnvironmentCatalog } from "../../../src/modules/sandbox/application/environment-catalog";
import { createSandboxService } from "../../../src/modules/sandbox/application/sandbox-service";
import type { ComputeEnvironmentSpec } from "../../../src/modules/sandbox/domain/environment";
import { createSandboxProviderRegistry } from "../../../src/modules/sandbox/ports/sandbox-provider";
import {
  ACTOR_ID,
  APPLICATION_ID,
  FAILURE_OBSERVATION,
  FakeCapabilityGate,
  FakeExecutionLedger,
  FakeSandboxAdmission,
  OTHER_APPLICATION_ID,
  RecordingSandboxProvider,
  SUCCESS_OBSERVATION,
  TENANT_ID,
} from "./fakes";

const EXECUTION_ID = "00000000-0000-7000-8000-0000000000e1";
const OTHER_TENANT_EXECUTION_ID = "00000000-0000-7000-8000-0000000000e2";

const processSpec: ComputeEnvironmentSpec = {
  kind: "process",
  limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
  network: { egress: "none", allowedHosts: [] },
  filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: { capabilityId: "process-sandbox" },
  cost: { estimatedCostMicroUsd: "0" },
};

const containerSpec: ComputeEnvironmentSpec = {
  kind: "container",
  limits: { cpuMilliCores: 1000, memoryMiB: 256, executionTimeoutMs: 60_000 },
  network: { egress: "allowlist", allowedHosts: ["api.example.com"] },
  filesystem: {
    workspace: "ephemeral-writable",
    readOnlyArtifactRefs: ["artifact-input-1"],
  },
  secrets: { secretRefs: ["conn-customer-api"] },
  runtime: { capabilityId: "container-runtime" },
  cost: { estimatedCostMicroUsd: "0" },
};

const noExecutionSpec: ComputeEnvironmentSpec = {
  kind: "no-execution",
  limits: null,
  network: { egress: "none", allowedHosts: [] },
  filesystem: { workspace: "none", readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: null,
  cost: { estimatedCostMicroUsd: "0" },
};

const costedProcessSpec: ComputeEnvironmentSpec = {
  ...processSpec,
  cost: { estimatedCostMicroUsd: "5000" },
};

interface World {
  readonly store: InMemorySandboxStore;
  readonly service: ReturnType<typeof createSandboxService>;
  readonly admission: FakeSandboxAdmission;
  readonly capabilities: FakeCapabilityGate;
  readonly ledger: FakeExecutionLedger;
  readonly providers: ReturnType<typeof createSandboxProviderRegistry>;
  readonly registerEnvironment: (slug: string, spec: ComputeEnvironmentSpec) => Promise<string>;
  readonly actor: { actorId: string; applicationId: string; tenantId: string };
}

function world(options: { budgetAuthority?: object } = {}): World {
  const store = new InMemorySandboxStore();
  const admission = new FakeSandboxAdmission();
  const capabilities = new FakeCapabilityGate();
  const ledger = new FakeExecutionLedger();
  const providers = createSandboxProviderRegistry();
  let counter = 0;
  const generateId = () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
  const catalog = createEnvironmentCatalog({
    store,
    generateId,
    now: () => new Date(),
    hashSpec: (canonical) => `digest:${canonical.length}`,
  });
  const actor = { actorId: ACTOR_ID, applicationId: APPLICATION_ID, tenantId: TENANT_ID };
  const service = createSandboxService({
    store,
    admission,
    capabilities: { resolve: capabilities.resolve },
    ...(options.budgetAuthority === undefined
      ? {}
      : { budgetAuthority: options.budgetAuthority as never }),
    ledger,
    providers,
    generateId,
    now: () => new Date(),
  });
  return {
    store,
    service,
    admission,
    capabilities,
    ledger,
    providers,
    actor,
    registerEnvironment: async (slug, spec) => {
      const record = await catalog.register(
        { applicationId: APPLICATION_ID, tenantId: TENANT_ID, slug, name: slug, spec },
        `env-${slug}`,
        actor,
      );
      return record.id;
    },
  };
}

const task = { command: "python3", args: ["analyze.py"], publicEnv: { MODE: "batch" } };

describe("sandbox admission (create)", () => {
  test("admits a process sandbox: bundle + immutable metadata + ledger evidence (criteria 1/4)", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const environmentId = await w.registerEnvironment("analysis", processSpec);
    const record = await w.service.createSandboxExecution(
      { executionId: EXECUTION_ID, environmentId, task },
      "key-1",
      w.actor,
    );
    expect(record.status).toBe("admitted");
    expect(record.executionId).toBe(EXECUTION_ID);
    expect(record.applicationId).toBe(APPLICATION_ID);
    expect(record.tenantId).toBe(TENANT_ID);
    expect(record.runtimeMetadata.kind).toBe("process");
    expect(record.runtimeMetadata.task.command).toBe("python3");
    expect(record.runtimeMetadata.limits).toEqual(processSpec.limits);
    expect(record.runtimeMetadata.policyEvidence).toMatchObject({ policySetId: "default" });

    // evidence on the canonical ledger (M16): the admitted envelope
    const events = w.ledger.eventsOf(EXECUTION_ID);
    expect(events.map((e) => e.event.command)).toEqual(["sandbox-admitted"]);
    expect(events[0]?.event.payload).toMatchObject({ kind: "process", status: "admitted" });
    expect(events[0]?.event.reference).toMatchObject({ sandboxId: record.id });
  });

  test("execution binding is tenant-guarded: missing execution and cross-tenant fail closed (M9)", async () => {
    const w = world();
    const environmentId = await w.registerEnvironment("analysis", processSpec);
    await expect(
      w.service.createSandboxExecution(
        { executionId: EXECUTION_ID, environmentId, task },
        "key-1",
        w.actor,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });

    w.ledger.seedExecution(
      OTHER_TENANT_EXECUTION_ID,
      "RUNNING",
      "00000000-0000-7000-8000-0000000000a2",
    );
    await expect(
      w.service.createSandboxExecution(
        { executionId: OTHER_TENANT_EXECUTION_ID, environmentId, task },
        "key-2",
        w.actor,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });

  test("terminal executions admit no sandbox", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "COMPLETED");
    const environmentId = await w.registerEnvironment("analysis", processSpec);
    await expect(
      w.service.createSandboxExecution(
        { executionId: EXECUTION_ID, environmentId, task },
        "key-1",
        w.actor,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("suspended/retired environments admit nothing (fail closed)", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const environmentId = await w.registerEnvironment("analysis", processSpec);
    await w.store.updateEnvironmentStatus({
      applicationId: APPLICATION_ID,
      environmentId,
      from: "available",
      to: "suspended",
      updatedAt: new Date().toISOString(),
    });
    await expect(
      w.service.createSandboxExecution(
        { executionId: EXECUTION_ID, environmentId, task },
        "key-1",
        w.actor,
      ),
    ).rejects.toMatchObject({ code: "SANDBOX_ERROR" });
  });

  test("POLICY denial is durable evidence + typed POLICY_DENIED (journal-then-fail; M2)", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const environmentId = await w.registerEnvironment("analysis", processSpec);
    w.admission.decide({ allowed: false, reason: "isolation floor requires container" });
    await expect(
      w.service.createSandboxExecution(
        { executionId: EXECUTION_ID, environmentId, task },
        "key-1",
        w.actor,
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    const denied = await w.store.findSandboxByKey(APPLICATION_ID, "key-1");
    expect(denied?.status).toBe("denied");
    expect(denied?.denialClass).toBe("policy");
    expect(w.ledger.eventsOf(EXECUTION_ID).map((e) => e.event.command)).toEqual(["sandbox-denied"]);
    // replay converges on the same typed denial
    await expect(
      w.service.createSandboxExecution(
        { executionId: EXECUTION_ID, environmentId, task },
        "key-1",
        w.actor,
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(w.ledger.eventsOf(EXECUTION_ID)).toHaveLength(1);
  });

  test("CAPABILITY denial is durable evidence + typed CAPABILITY_UNAVAILABLE (M3)", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const environmentId = await w.registerEnvironment("analysis", processSpec);
    w.capabilities.setSatisfied(false, "unknown-capability");
    await expect(
      w.service.createSandboxExecution(
        { executionId: EXECUTION_ID, environmentId, task },
        "key-1",
        w.actor,
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    const denied = await w.store.findSandboxByKey(APPLICATION_ID, "key-1");
    expect(denied?.denialClass).toBe("capability");
    expect(w.ledger.eventsOf(EXECUTION_ID).map((e) => e.event.command)).toEqual(["sandbox-denied"]);
  });

  test("COSTED environments fail closed without a budget authority (M4)", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const environmentId = await w.registerEnvironment("costed", costedProcessSpec);
    await expect(
      w.service.createSandboxExecution(
        { executionId: EXECUTION_ID, environmentId, task },
        "key-1",
        w.actor,
      ),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    const denied = await w.store.findSandboxByKey(APPLICATION_ID, "key-1");
    expect(denied?.denialClass).toBe("budget");
  });

  test("idempotent create: same key replays; key reuse with a different fingerprint fails (M11)", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const environmentId = await w.registerEnvironment("analysis", processSpec);
    const first = await w.service.createSandboxExecution(
      { executionId: EXECUTION_ID, environmentId, task },
      "key-1",
      w.actor,
    );
    const replay = await w.service.createSandboxExecution(
      { executionId: EXECUTION_ID, environmentId, task },
      "key-1",
      w.actor,
    );
    expect(replay.id).toBe(first.id);
    await expect(
      w.service.createSandboxExecution(
        { executionId: EXECUTION_ID, environmentId, task: { ...task, command: "node" } },
        "key-1",
        w.actor,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(await w.store.listSandboxesByExecution(APPLICATION_ID, EXECUTION_ID)).toHaveLength(1);
  });

  test("no-execution environments skip the capability gate (nothing runs)", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const environmentId = await w.registerEnvironment("none", noExecutionSpec);
    w.capabilities.setSatisfied(false, "unknown-capability");
    const record = await w.service.createSandboxExecution(
      { executionId: EXECUTION_ID, environmentId, task },
      "key-1",
      w.actor,
    );
    expect(record.status).toBe("admitted");
    expect(record.runtimeMetadata.kind).toBe("no-execution");
    expect(record.runtimeMetadata.limits).toBeNull();
  });
});

describe("sandbox dispatch", () => {
  test("dispatch executes the ADMITTED snapshot through the provider and completes (criterion 2)", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const environmentId = await w.registerEnvironment("analysis", processSpec);
    const provider = new RecordingSandboxProvider("process", SUCCESS_OBSERVATION);
    w.providers.register(provider);
    const admitted = await w.service.createSandboxExecution(
      { executionId: EXECUTION_ID, environmentId, task },
      "key-1",
      w.actor,
    );
    const completed = await w.service.dispatchSandboxExecution(
      { applicationId: APPLICATION_ID, sandboxId: admitted.id },
      w.actor,
    );
    expect(completed.status).toBe("completed");
    expect(completed.outcomeClass).toBe("sandbox-success");
    expect(completed.outputDigest).toBe("digest:done");
    expect(completed.ledgerCompletedSequence).not.toBeNull();
    // the provider received the sanitized runtime spec: references only
    expect(provider.specs).toHaveLength(1);
    const spec = provider.specs[0];
    expect(spec?.sandboxId).toBe(admitted.id);
    expect(spec?.task.publicEnv).toEqual({ MODE: "batch" });
    expect(spec?.network).toEqual(processSpec.network);
    expect(spec?.filesystem).toEqual(processSpec.filesystem);
    expect(spec?.limits).toEqual(processSpec.limits);
    expect(JSON.stringify(spec)).not.toMatch(/sk-|password|plaintext/i);
    // evidence order: admitted then completed on the canonical ledger
    expect(w.ledger.eventsOf(EXECUTION_ID).map((e) => e.event.command)).toEqual([
      "sandbox-admitted",
      "sandbox-completed",
    ]);
  });

  test("no-execution dispatch completes WITHOUT any provider (M17)", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const environmentId = await w.registerEnvironment("none", noExecutionSpec);
    const admitted = await w.service.createSandboxExecution(
      { executionId: EXECUTION_ID, environmentId, task },
      "key-1",
      w.actor,
    );
    const completed = await w.service.dispatchSandboxExecution(
      { applicationId: APPLICATION_ID, sandboxId: admitted.id },
      w.actor,
    );
    expect(completed.status).toBe("completed");
    expect(completed.outcomeClass).toBe("sandbox-success");
    expect(completed.runtimeMetadata.kind).toBe("no-execution");
    expect(w.providers.providerFor("no-execution")).toBeNull();
  });

  test("denied sandboxes cannot dispatch; nothing executes before admission (M15)", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const environmentId = await w.registerEnvironment("analysis", processSpec);
    w.admission.decide({ allowed: false, reason: "no" });
    await expect(
      w.service.createSandboxExecution(
        { executionId: EXECUTION_ID, environmentId, task },
        "key-1",
        w.actor,
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    const denied = await w.store.findSandboxByKey(APPLICATION_ID, "key-1");
    expect(denied?.status).toBe("denied");
    await expect(
      w.service.dispatchSandboxExecution(
        { applicationId: APPLICATION_ID, sandboxId: denied?.id ?? "" },
        w.actor,
      ),
    ).rejects.toMatchObject({ code: "SANDBOX_ERROR" });
  });

  test("an unwired substrate FAILS CLOSED: container without a runtime client (M18)", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const environmentId = await w.registerEnvironment("untrusted", containerSpec);
    w.providers.register(new ContainerSandboxProvider()); // no client wired
    const admitted = await w.service.createSandboxExecution(
      { executionId: EXECUTION_ID, environmentId, task },
      "key-1",
      w.actor,
    );
    const outcome = await w.service.dispatchSandboxExecution(
      { applicationId: APPLICATION_ID, sandboxId: admitted.id },
      w.actor,
    );
    // Fail-closed is an honest sandbox-axis FAILURE — never a permissive
    // execution and never a fabricated success.
    expect(outcome.status).toBe("failed");
    expect(outcome.failureClass).toBe("runtime-unavailable");
    expect(outcome.failureMessage).toContain("fails closed");
  });

  test("no provider for the kind fails closed (unknown substrate)", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const environmentId = await w.registerEnvironment("analysis", processSpec);
    // no provider registered at all
    const admitted = await w.service.createSandboxExecution(
      { executionId: EXECUTION_ID, environmentId, task },
      "key-1",
      w.actor,
    );
    const outcome = await w.service.dispatchSandboxExecution(
      { applicationId: APPLICATION_ID, sandboxId: admitted.id },
      w.actor,
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failureClass).toBe("runtime-unavailable");
  });

  test("terminal sandboxes replay their outcome (single-dispatch semantics)", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const environmentId = await w.registerEnvironment("analysis", processSpec);
    const provider = new RecordingSandboxProvider("process", SUCCESS_OBSERVATION);
    w.providers.register(provider);
    const admitted = await w.service.createSandboxExecution(
      { executionId: EXECUTION_ID, environmentId, task },
      "key-1",
      w.actor,
    );
    const first = await w.service.dispatchSandboxExecution(
      { applicationId: APPLICATION_ID, sandboxId: admitted.id },
      w.actor,
    );
    expect(first.status).toBe("completed");
    const replay = await w.service.dispatchSandboxExecution(
      { applicationId: APPLICATION_ID, sandboxId: admitted.id },
      w.actor,
    );
    expect(replay.status).toBe("completed");
    expect(replay.completedAt).toBe(first.completedAt);
    expect(provider.specs).toHaveLength(1); // executed exactly ONCE
  });

  test("a dispatching sandbox (crash state) fails closed NON_CONVERGENT (§14)", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const environmentId = await w.registerEnvironment("analysis", processSpec);
    const admitted = await w.service.createSandboxExecution(
      { executionId: EXECUTION_ID, environmentId, task },
      "key-1",
      w.actor,
    );
    await w.store.claimDispatching(APPLICATION_ID, "key-1");
    await expect(
      w.service.dispatchSandboxExecution(
        { applicationId: APPLICATION_ID, sandboxId: admitted.id },
        w.actor,
      ),
    ).rejects.toMatchObject({ code: "NON_CONVERGENT_EXTERNAL_EFFECT" });
  });

  test("failed observations finalize to failed with the sandbox-axis failure class", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const environmentId = await w.registerEnvironment("analysis", processSpec);
    w.providers.register(new RecordingSandboxProvider("process", FAILURE_OBSERVATION));
    const admitted = await w.service.createSandboxExecution(
      { executionId: EXECUTION_ID, environmentId, task },
      "key-1",
      w.actor,
    );
    const outcome = await w.service.dispatchSandboxExecution(
      { applicationId: APPLICATION_ID, sandboxId: admitted.id },
      w.actor,
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.outcomeClass).toBe("sandbox-failure");
    expect(outcome.failureClass).toBe("sandbox-execution");
  });

  test("cross-tenant and cross-application dispatch fail closed (M9/M10)", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const environmentId = await w.registerEnvironment("analysis", processSpec);
    const admitted = await w.service.createSandboxExecution(
      { executionId: EXECUTION_ID, environmentId, task },
      "key-1",
      w.actor,
    );
    await expect(
      w.service.dispatchSandboxExecution(
        { applicationId: APPLICATION_ID, sandboxId: admitted.id },
        {
          actorId: ACTOR_ID,
          applicationId: APPLICATION_ID,
          tenantId: "00000000-0000-7000-8000-0000000000a2",
        },
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(
      w.service.dispatchSandboxExecution(
        { applicationId: OTHER_APPLICATION_ID, sandboxId: admitted.id },
        w.actor,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });

  test("a terminal execution dispatches nothing", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const environmentId = await w.registerEnvironment("analysis", processSpec);
    const admitted = await w.service.createSandboxExecution(
      { executionId: EXECUTION_ID, environmentId, task },
      "key-1",
      w.actor,
    );
    w.ledger.seedExecution(EXECUTION_ID, "COMPLETED");
    await expect(
      w.service.dispatchSandboxExecution(
        { applicationId: APPLICATION_ID, sandboxId: admitted.id },
        w.actor,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("raw secret values never reach a durable row (task validation at admission; M8)", async () => {
    const w = world();
    w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const environmentId = await w.registerEnvironment("analysis", processSpec);
    await expect(
      w.service.createSandboxExecution(
        {
          executionId: EXECUTION_ID,
          environmentId,
          task: { ...task, publicEnv: { TOKEN: "ghp_abcdefghijklmnopqrst" } },
        },
        "key-1",
        w.actor,
      ),
    ).rejects.toMatchObject({ code: "SANDBOX_ERROR" });
    expect(await w.store.findSandboxByKey(APPLICATION_ID, "key-1")).toBeNull();
  });
});
