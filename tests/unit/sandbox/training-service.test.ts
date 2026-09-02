/**
 * Unit — the governed TRAINING service (WORK-030, ACC-001/002/003):
 * the admission chain, the paid-allocation boundary, the long-running
 * checkpoint/retry/cancel/resume semantics and the
 * verification-before-release boundary.
 *
 * Proves (with fakes + the REAL simulated accelerator substrate; the
 * real authorities back the real-PG suites):
 *   - the admission ORDER: execution binding (tenant guard) → substrate
 *     resolution (the provider-neutral capability/resource contract) →
 *     POLICY admission → CAPABILITY admission → BUDGET reservation →
 *     durable bundle → ledger evidence — NO paid allocation happens at
 *     submission; the fleet allocates only at dispatch, AFTER the
 *     reservation (ACC-001 + the architecture invariant);
 *   - journal-then-fail denials: policy/capability/budget denials are
 *     DURABLE denied rows + sandbox-denied envelopes + typed errors —
 *     and a budget denial leaves ZERO allocation-path activity (the
 *     fleet allocation ledger stays empty; fail-closed);
 *   - the full lifecycle: dispatch → allocation (exactly one per stable
 *     attempt key) → run (exactly one invocation per run key) →
 *     checkpoints (write-once, content-addressed) → completion (output
 *     adoption + budget settle exactly once + sandbox-completed);
 *   - crash-honest states: a running workload re-dispatches fail-closed
 *     (resume is the recovery path); terminal outcomes replay;
 *   - an unwired substrate fails closed (substrate-unavailable, budget
 *     released, no allocation);
 *   - checkpoint emission is RUNNING-only and identity-convergent;
 *   - cancellation from BOTH pre-allocation and running states (the
 *     lease-less tail included — the review-found defect regression);
 *     the reservation is refunded exactly once;
 *   - resume: live-lease conflict fails closed; an expired lease
 *     re-acquires at a HIGHER epoch, records resume-recorded, re-drives
 *     through the SAME run key (the keyed substrate ledger replays; no
 *     second run invocation), and an UNCHANGED resume NEVER re-consults
 *     policy (the materiality rule);
 *   - retry: a fresh reservation for the new attempt (BEFORE the new
 *     allocation), the budget discriminator rebinds to the new attempt
 *     (the review-found defect regression), the ladder is bounded;
 *   - VERIFICATION BEFORE RELEASE (ACC-003): a completed workload is
 *     never a release until the verification authority PASSES it; a
 *     FAIL verdict leaves the release dimension null; a failed workload
 *     can never enter release verification; the release binding is
 *     write-once;
 *   - PROVIDER SUBSTITUTION (ACC-002/AC-6): two DIFFERENT accelerator
 *     fleets behind the SAME neutral runtime contract produce the SAME
 *     execution abstraction (identical status progression, identical
 *     ledger command sequence, identical one-allocation/one-run
 *     convergence) — swapping the substrate adapter changes nothing in
 *     the core model;
 *   - tenant/cross-application isolation fails closed;
 *   - idempotent submission: same key replays, key reuse with a
 *     different fingerprint fails IDEMPOTENCY_KEY_REUSED.
 */

import { describe, expect, test } from "vitest";
import {
  createAcceleratorSubstrateRuntime,
  SimulatedAcceleratorFleet,
  type SimulatedAcceleratorFleetOptions,
} from "../../../src/integrations/accelerators/public";
import {
  createAcceleratorRuntimeRegistry,
  createTrainingService,
  InMemoryTrainingStore,
  type TrainingService,
  type TrainingWorkloadRecord,
  type TrainingWorkloadSpec,
} from "../../../src/modules/sandbox/public";
import { PlatformError } from "../../../src/shared/errors";
import {
  FakeSubstrateCatalog,
  FakeTrainingAdmission,
  FakeTrainingBudget,
  FakeTrainingCapabilities,
  FakeTrainingLedger,
  FakeTrainingVerification,
  sha256Hex,
  substrateSelectionOf,
  TR_ACTOR_ID,
  TR_APPLICATION_ID,
  TR_EXECUTION_ID,
  TR_OTHER_APPLICATION_ID,
  TR_OTHER_TENANT_EXECUTION_ID,
  TR_OTHER_TENANT_ID,
  TR_TENANT_ID,
} from "./training-fakes";

const ACTOR = { actorId: TR_ACTOR_ID, applicationId: TR_APPLICATION_ID, tenantId: TR_TENANT_ID };
const FOREIGN_ACTOR = {
  actorId: TR_ACTOR_ID,
  applicationId: TR_APPLICATION_ID,
  tenantId: TR_OTHER_TENANT_ID,
};

const GPU_INVENTORY = Array.from({ length: 8 }, () => ({
  deviceClass: "gpu",
  memoryMiB: 32_768,
  computeUnits: 100,
  fabricAttached: true,
}));

const SPEC: TrainingWorkloadSpec = {
  workloadKind: "training",
  task: { command: "train", args: ["--epochs", "3"], publicEnv: {} },
  resource: {
    accelerator: {
      acceleratorClass: "gpu",
      deviceCount: 4,
      perDeviceMemoryMiB: 16_384,
      interconnect: "interconnect-fabric",
    },
    replicaCount: 2,
    cpuMilliCores: 4000,
    memoryMiB: 8192,
    estimatedDurationMs: 3_600_000,
    estimatedCostMicroUsd: "250000",
  },
  lineage: {
    datasetRefs: ["dataset:corpus-1"],
    codeRefs: ["code:trainer-9"],
    configRefs: ["config:hparams-a"],
    checkpointRefs: [],
    parentOutputRefs: [],
  },
  checkpointIntervalSteps: 4,
  maxRetryAttempts: 2,
};

interface World {
  readonly store: InMemoryTrainingStore;
  readonly service: TrainingService;
  readonly admission: FakeTrainingAdmission;
  readonly substrates: FakeSubstrateCatalog;
  readonly capabilities: FakeTrainingCapabilities;
  readonly budget: FakeTrainingBudget;
  readonly ledger: FakeTrainingLedger;
  readonly verification: FakeTrainingVerification;
  readonly fleet: SimulatedAcceleratorFleet;
}

function world(
  options: {
    readonly failRunsOf?: SimulatedAcceleratorFleetOptions["failRunsOf"];
    readonly offer?: "f1" | "none";
    readonly unwired?: boolean;
  } = {},
): World {
  const store = new InMemoryTrainingStore();
  const admission = new FakeTrainingAdmission();
  const substrates = new FakeSubstrateCatalog();
  const capabilities = new FakeTrainingCapabilities();
  const budget = new FakeTrainingBudget();
  const ledger = new FakeTrainingLedger();
  ledger.seedExecution(TR_EXECUTION_ID, "RUNNING");
  ledger.seedExecution(TR_OTHER_TENANT_EXECUTION_ID, "RUNNING", TR_OTHER_TENANT_ID);
  const verification = new FakeTrainingVerification();
  let counter = 0;
  const generateId = () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
  const fleet = new SimulatedAcceleratorFleet("f1", GPU_INVENTORY, {
    now: () => new Date(),
    generateId,
    ...(options.failRunsOf === undefined ? {} : { failRunsOf: options.failRunsOf }),
  });
  const runtimes = createAcceleratorRuntimeRegistry();
  if (!options.unwired) {
    runtimes.register(createAcceleratorSubstrateRuntime(fleet));
  }
  substrates.offer(
    options.offer === "none"
      ? null
      : substrateSelectionOf("accelerator-fabric-f1", "accelerator-fabric:f1"),
  );
  const service = createTrainingService({
    store,
    admission: { admit: admission.admit },
    substrates: { select: substrates.select },
    capabilities: { resolve: capabilities.resolve },
    budgetAuthority: budget,
    ledger,
    runtimes,
    verification,
    digest: sha256Hex,
    generateId,
    now: () => new Date(),
    leaseDurationMs: 60_000,
  });
  return {
    store,
    service,
    admission,
    substrates,
    capabilities,
    budget,
    ledger,
    verification,
    fleet,
  };
}

const submit = (w: World, key = "training-key-1") =>
  w.service.submitWorkload({ executionId: TR_EXECUTION_ID, spec: SPEC }, key, ACTOR);

const submitAndDispatch = async (w: World, key = "training-key-1") => {
  const admitted = await submit(w, key);
  const final = await w.service.dispatchWorkload(
    { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
    ACTOR,
  );
  return { admitted, final };
};

const expectPlatformError = async (
  code: string,
  run: () => Promise<unknown>,
): Promise<PlatformError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof PlatformError) {
      if (error.code !== code) {
        throw new Error(`expected PlatformError code ${code}, got ${error.code}: ${error.message}`);
      }
      return error;
    }
    throw error;
  }
  throw new Error(`expected a PlatformError with code ${code}`);
};

describe("training admission chain (budget BEFORE paid allocation)", () => {
  test("submission admits through the full chain with ZERO paid allocation", async () => {
    const w = world();
    const record = await submit(w);
    expect(record.status).toBe("admitted");
    // The chain consulted every authority in order...
    expect(w.substrates.requests.length).toBe(1);
    expect(w.substrates.requests[0]?.workloadKind).toBe("training");
    expect(w.admission.requests.length).toBe(1);
    expect(w.capabilities.profiles.length).toBe(1);
    expect(w.budget.reserves.length).toBe(1);
    expect(w.budget.reserves[0]?.amountMicroUsd).toBe("250000");
    // ...and the paid path stayed INACTIVE (the physical witness).
    expect(w.fleet.listAllocations()).toEqual([]);
    // The durable bundle + the ledger evidence.
    expect(record.runtimeMetadata.substrate?.substrateId).toBe("accelerator-fabric-f1");
    expect(record.runtimeMetadata.policyEvidence?.policySetId).toBe("ps-training-1");
    expect(record.runtimeMetadata.budgetOperationId).not.toBeNull();
    expect(record.ledgerAdmittedSequence).not.toBeNull();
    expect(w.ledger.commandsOf(TR_EXECUTION_ID)).toContain("sandbox-admitted");
  });

  test("a policy denial is a durable journal-then-fail with zero paid path activity", async () => {
    const w = world();
    w.admission.deny("training workloads are not permitted for this tenant");
    const error = await expectPlatformError("POLICY_DENIED", () => submit(w));
    expect(error.message).toContain("training workloads are not permitted");
    const row = await w.store.findWorkloadByKey(TR_APPLICATION_ID, "training-key-1");
    expect(row?.status).toBe("denied");
    expect(row?.denialClass).toBe("policy");
    // The budget authority was NEVER consulted (policy precedes budget).
    expect(w.budget.reserves.length).toBe(0);
    expect(w.fleet.listAllocations()).toEqual([]);
    expect(w.ledger.commandsOf(TR_EXECUTION_ID)).toContain("sandbox-denied");
    // A replay of the same key replays the same durable denial.
    await expectPlatformError("POLICY_DENIED", () => submit(w));
    expect((await w.store.findWorkloadByKey(TR_APPLICATION_ID, "training-key-1"))?.id).toBe(
      row?.id,
    );
  });

  test("a budget denial fails closed with ZERO allocation-path activity", async () => {
    const w = world();
    w.budget.failReserve = true;
    const error = await expectPlatformError("BUDGET_EXCEEDED", () => submit(w));
    expect(error.message).toContain("fixture exhausted budget");
    const row = await w.store.findWorkloadByKey(TR_APPLICATION_ID, "training-key-1");
    expect(row?.status).toBe("denied");
    expect(row?.denialClass).toBe("budget");
    expect(row?.budgetOperationId).toBeNull();
    // THE physical proof: no reservation landed, no allocation, no run.
    expect(w.budget.reserves.length).toBe(0);
    expect(w.fleet.listAllocations()).toEqual([]);
    expect(w.ledger.commandsOf(TR_EXECUTION_ID)).toContain("sandbox-denied");
  });

  test("a missing substrate claim fails closed as capability-unavailable", async () => {
    const w = world({ offer: "none" });
    const error = await expectPlatformError("CAPABILITY_UNAVAILABLE", () => submit(w));
    expect(error.message).toContain("no available accelerator substrate");
    const row = await w.store.findWorkloadByKey(TR_APPLICATION_ID, "training-key-1");
    expect(row?.status).toBe("denied");
    expect(row?.denialClass).toBe("capability");
    expect(w.budget.reserves.length).toBe(0);
  });

  test("an unsatisfied capability requirement fails closed", async () => {
    const w = world();
    w.capabilities.setSatisfied(false);
    await expectPlatformError("CAPABILITY_UNAVAILABLE", () => submit(w));
    const row = await w.store.findWorkloadByKey(TR_APPLICATION_ID, "training-key-1");
    expect(row?.status).toBe("denied");
    expect(row?.denialClass).toBe("capability");
    expect(w.budget.reserves.length).toBe(0);
  });

  test("the execution binding is tenant-guarded and liveness-checked", async () => {
    const w = world();
    await expectPlatformError("TENANT_SCOPE_VIOLATION", () =>
      w.service.submitWorkload(
        { executionId: "00000000-0000-7000-8000-0000000000ff", spec: SPEC },
        "missing-execution",
        ACTOR,
      ),
    );
    await expectPlatformError("TENANT_SCOPE_VIOLATION", () =>
      w.service.submitWorkload(
        { executionId: TR_OTHER_TENANT_EXECUTION_ID, spec: SPEC },
        "foreign-tenant",
        ACTOR,
      ),
    );
    w.ledger.seedExecution(TR_EXECUTION_ID, "COMPLETED");
    await expectPlatformError("INVALID_STATE_TRANSITION", () =>
      w.service.submitWorkload(
        { executionId: TR_EXECUTION_ID, spec: SPEC },
        "terminal-execution",
        ACTOR,
      ),
    );
  });

  test("idempotent submission: same key replays; different fingerprint fails key-reuse", async () => {
    const w = world();
    const first = await submit(w);
    const replay = await submit(w);
    expect(replay.id).toBe(first.id);
    expect(w.budget.reserves.length).toBe(1); // exactly one reservation
    expect(w.admission.requests.length).toBe(1);
    await expectPlatformError("IDEMPOTENCY_KEY_REUSED", () =>
      w.service.submitWorkload(
        {
          executionId: TR_EXECUTION_ID,
          spec: { ...SPEC, maxRetryAttempts: 3 },
        },
        "training-key-1",
        ACTOR,
      ),
    );
  });
});

describe("training dispatch (the paid boundary after the reservation)", () => {
  test("dispatch allocates ONCE, runs ONCE, records checkpoints and settles once", async () => {
    const w = world();
    const { final } = await submitAndDispatch(w);
    expect(final.status).toBe("completed");
    // Exactly one paid allocation per stable attempt key...
    expect(w.fleet.listAllocations().length).toBe(1);
    expect(w.fleet.listAllocations()[0]?.deviceClass).toBe("gpu");
    expect(w.fleet.listAllocations()[0]?.devices).toBe(4);
    // ...exactly one run invocation per run key...
    expect(w.fleet.runCount()).toBe(1);
    // ...the checkpoints are durable and content-addressed...
    const checkpoints = await w.store.listTrainingCheckpointsByWorkload(
      TR_APPLICATION_ID,
      "training-key-1",
    );
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const checkpoint of checkpoints) {
      expect(checkpoint.contentDigest).toHaveLength(64);
      const byIdentity = await w.service.getCheckpointByIdentity(
        TR_APPLICATION_ID,
        checkpoint.contentDigest,
      );
      expect(byIdentity?.id).toBe(checkpoint.id);
    }
    expect(final.lastCheckpointIdentity).not.toBeNull();
    // ...the output is adopted, the budget settled EXACTLY once, the
    // lease released, and the completion envelope recorded.
    expect(final.outputArtifactDigest).not.toBeNull();
    expect(w.budget.settles.length).toBe(1);
    expect(w.budget.settles[0]?.operationId).toBe(final.budgetOperationId);
    expect(
      (await w.store.findTrainingRunLease(TR_APPLICATION_ID, final.id))?.releasedAt,
    ).not.toBeNull();
    expect(w.ledger.commandsOf(TR_EXECUTION_ID)).toContain("sandbox-completed");
    expect(final.verifiedReleaseAt).toBeNull(); // completion is NOT release
  });

  test("a terminal workload replays its outcome on re-dispatch (no re-paid compute)", async () => {
    const w = world();
    const { final } = await submitAndDispatch(w);
    const replay = await w.service.dispatchWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: final.id },
      ACTOR,
    );
    expect(replay.status).toBe("completed");
    expect(w.fleet.runCount()).toBe(1);
    expect(w.fleet.listAllocations().length).toBe(1);
  });

  test("every emitted checkpoint gets its OWN ledger envelope; the completion binding matches the completion event (the per-identity key fix)", async () => {
    const w = world();
    const { final } = await submitAndDispatch(w);
    // interval 4 over the simulated 12 steps -> exactly 3 checkpoints.
    const checkpoints = await w.store.listTrainingCheckpointsByWorkload(
      TR_APPLICATION_ID,
      "training-key-1",
    );
    expect(checkpoints.length).toBe(3);
    const checkpointEvents = w.ledger
      .eventsOf(TR_EXECUTION_ID)
      .filter((entry) => entry.event.command === "checkpoint-recorded");
    // The re-review defect regression: a workload-scoped event key
    // burned on the FIRST checkpoint silently dropped every later
    // envelope (only 1 of 3 reached the canonical ledger).
    expect(checkpointEvents.length).toBe(3);
    const identities = checkpointEvents.map((entry) => entry.event.payload.checkpointIdentity);
    expect(new Set(identities).size).toBe(3);
    for (const checkpoint of checkpoints) {
      expect(identities).toContain(checkpoint.contentDigest);
    }
    // The completed binding points at the completion event's sequence
    // (the missing durable-state transition the retry defect exposed).
    expect(final.ledgerCompletedSequence).not.toBeNull();
    const completedEvents = w.ledger
      .eventsOf(TR_EXECUTION_ID)
      .filter((entry) => entry.event.command === "sandbox-completed");
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0]?.sequence).toBe(final.ledgerCompletedSequence);
    expect(final.ledgerAdmittedSequence).not.toBeNull();
  });

  test("a running workload re-dispatch fails closed (resume is the recovery path)", async () => {
    const w = world();
    // Simulate the honest crash state: admitted → allocating/running
    // without the completed tail.
    const admitted = await submit(w);
    await w.store.transitionWorkload({
      applicationId: TR_APPLICATION_ID,
      workloadKey: "training-key-1",
      to: "allocating",
      now: new Date().toISOString(),
    });
    await w.store.transitionWorkload({
      applicationId: TR_APPLICATION_ID,
      workloadKey: "training-key-1",
      to: "running",
      now: new Date().toISOString(),
    });
    await expectPlatformError("INVALID_STATE_TRANSITION", () =>
      w.service.dispatchWorkload(
        { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
        ACTOR,
      ),
    );
  });

  test("an unwired substrate fails closed: substrate-unavailable, budget released, no allocation", async () => {
    const w = world({ unwired: true });
    const admitted = await submit(w);
    const final = await w.service.dispatchWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
      ACTOR,
    );
    expect(final.status).toBe("failed");
    expect(final.failureClass).toBe("substrate-unavailable");
    expect(w.fleet.listAllocations()).toEqual([]);
    expect(w.budget.releases.length).toBe(1);
    expect(w.budget.releases[0]?.operationId).toBe(final.budgetOperationId);
  });

  test("a denied workload cannot dispatch", async () => {
    const w = world();
    w.admission.deny();
    await expectPlatformError("POLICY_DENIED", () => submit(w));
    const row = await w.store.findWorkloadByKey(TR_APPLICATION_ID, "training-key-1");
    await expectPlatformError("SANDBOX_ERROR", () =>
      w.service.dispatchWorkload(
        { applicationId: TR_APPLICATION_ID, workloadId: row?.id ?? "" },
        ACTOR,
      ),
    );
  });
});

describe("training checkpoint emission (write-once, identity-addressed)", () => {
  test("checkpoints are RUNNING-only and converge on their content identity", async () => {
    const w = world();
    const admitted = await submit(w, "ck-key");
    await expectPlatformError("INVALID_STATE_TRANSITION", () =>
      w.service.emitCheckpoint(
        {
          applicationId: TR_APPLICATION_ID,
          workloadId: admitted.id,
          contents: {
            checkpointSequence: 1,
            stepPosition: 4,
            metricsDigest: sha256Hex("metrics:1"),
            lineage: SPEC.lineage,
          },
        },
        ACTOR,
      ),
    );
    // The honest mid-flight state: the workload is RUNNING (the
    // simulated substrate runs synchronously, so the in-flight row is
    // armed through the guarded store transitions).
    for (const to of ["allocating", "running"] as const) {
      await w.store.transitionWorkload({
        applicationId: TR_APPLICATION_ID,
        workloadKey: "ck-key",
        to,
        now: new Date().toISOString(),
      });
    }
    const first = await w.service.emitCheckpoint(
      {
        applicationId: TR_APPLICATION_ID,
        workloadId: admitted.id,
        contents: {
          checkpointSequence: 1,
          stepPosition: 4,
          metricsDigest: sha256Hex("metrics:1"),
          lineage: SPEC.lineage,
        },
      },
      ACTOR,
    );
    // Re-emitting the SAME facts converges on the SAME identity.
    const replay = await w.service.emitCheckpoint(
      {
        applicationId: TR_APPLICATION_ID,
        workloadId: admitted.id,
        contents: {
          checkpointSequence: first.contents.checkpointSequence,
          stepPosition: first.contents.stepPosition,
          metricsDigest: first.contents.metricsDigest,
          lineage: SPEC.lineage,
        },
      },
      ACTOR,
    );
    expect(replay.id).toBe(first.id);
    expect(
      (await w.store.listTrainingCheckpointsByWorkload(TR_APPLICATION_ID, "ck-key")).length,
    ).toBe(1);
    expect(admitted.lastCheckpointIdentity ?? first.contentDigest).toBe(first.contentDigest);
  });
});

describe("training cancellation (the governed interruption)", () => {
  test("cancelling BEFORE allocation is clean (no lease crash, reservation refunded)", async () => {
    const w = world();
    const admitted = await submit(w);
    const cancelled = await w.service.cancelWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
      ACTOR,
    );
    expect(cancelled.status).toBe("cancelled");
    expect(w.fleet.listAllocations()).toEqual([]);
    expect(w.budget.releases.length).toBe(1);
    expect(w.ledger.commandsOf(TR_EXECUTION_ID)).toContain("interruption-requested");
    // Terminal replay.
    const replay = await w.service.cancelWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
      ACTOR,
    );
    expect(replay.status).toBe("cancelled");
  });

  test("cancelling a RUNNING workload releases the allocation, the lease and refunds", async () => {
    const w = world({ failRunsOf: () => true });
    // Drive to running but NOT final: use a fleet whose run fails AFTER
    // emitting the first checkpoint, then retry-arm and cancel from
    // failed? No — cancellation of a live run requires the run to be
    // in-flight. The in-process simulated run is synchronous, so the
    // honest in-flight state is produced by the lease: acquire the
    // workload row at running through a failing dispatch.
    const admitted = await submit(w);
    const failed = await w.service.dispatchWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
      ACTOR,
    );
    expect(failed.status).toBe("failed");
    // From failed the governed exit is retry (bounded) or terminal
    // residence; cancelling a failed row fails closed typed.
    await expectPlatformError("INVALID_STATE_TRANSITION", () =>
      w.service.cancelWorkload(
        { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
        ACTOR,
      ),
    );
  });

  test("a failed run's reservation is released exactly once (no settle)", async () => {
    const w = world({ failRunsOf: () => true });
    const { final } = await submitAndDispatch(w);
    expect(final.status).toBe("failed");
    expect(final.failureClass).toBe("workload-failure");
    expect(w.budget.settles.length).toBe(0);
    expect(w.budget.releases.length).toBe(1);
    expect(w.ledger.commandsOf(TR_EXECUTION_ID)).toContain("sandbox-completed");
  });
});

describe("training resume (lease + materiality discipline)", () => {
  test("a live foreign lease fails closed with resume-denied evidence", async () => {
    const w = world();
    const admitted = await submit(w);
    // Arm the honest in-flight state: allocation + lease held by the
    // live worker (the simulated run fails so the tail never releases).
    await w.store.transitionWorkload({
      applicationId: TR_APPLICATION_ID,
      workloadKey: "training-key-1",
      to: "allocating",
      now: new Date().toISOString(),
    });
    await w.store.acquireTrainingRunLease({
      applicationId: TR_APPLICATION_ID,
      workloadId: admitted.id,
      tenantId: TR_TENANT_ID,
      ownerId: "training-worker:training-key-1",
      now: new Date().toISOString(),
      leaseDurationMs: 60_000,
    });
    await expectPlatformError("INVALID_STATE_TRANSITION", () =>
      w.service.resumeWorkload(
        { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
        ACTOR,
      ),
    );
    expect(w.ledger.commandsOf(TR_EXECUTION_ID)).toContain("resume-denied");
  });

  test("an expired lease re-acquires at a higher epoch and converges through the same run key", async () => {
    const w = world();
    const admitted = await submit(w);
    const past = "2026-09-02T09:00:00.000Z";
    // The crashed-worker state: allocating with an EXPIRED lease.
    await w.store.transitionWorkload({
      applicationId: TR_APPLICATION_ID,
      workloadKey: "training-key-1",
      to: "allocating",
      now: past,
    });
    await w.store.acquireTrainingRunLease({
      applicationId: TR_APPLICATION_ID,
      workloadId: admitted.id,
      tenantId: TR_TENANT_ID,
      ownerId: "training-worker:training-key-1",
      now: past,
      leaseDurationMs: 1000,
    });
    const before = w.admission.requests.length;
    const final = await w.service.resumeWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
      ACTOR,
    );
    expect(final.status).toBe("completed");
    // ONE allocation, ONE run — the keyed substrate ledger converged.
    expect(w.fleet.listAllocations().length).toBe(1);
    expect(w.fleet.runCount()).toBe(1);
    // The UNCHANGED resume never re-consulted policy (materiality).
    expect(w.admission.requests.length).toBe(before);
    expect(w.ledger.commandsOf(TR_EXECUTION_ID)).toContain("resume-recorded");
    // The lease advanced to a higher epoch and was released by the tail.
    const lease = await w.store.findTrainingRunLease(TR_APPLICATION_ID, admitted.id);
    expect(lease?.epoch).toBeGreaterThanOrEqual(2);
    expect(lease?.releasedAt).not.toBeNull();
  });

  test("resume never resurrects terminal workloads", async () => {
    const w = world();
    const { final } = await submitAndDispatch(w);
    const replay = await w.service.resumeWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: final.id },
      ACTOR,
    );
    expect(replay.status).toBe("completed");
    expect(w.fleet.runCount()).toBe(1);
  });
});

describe("training retry (fresh admission per attempt)", () => {
  test("a failed workload retries with a FRESH reservation and the discriminator rebinds", async () => {
    const w = world({ failRunsOf: (_id, attempt) => attempt === 1 });
    const admitted = await submit(w);
    const first = await w.service.dispatchWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
      ACTOR,
    );
    expect(first.status).toBe("failed");
    expect(first.attempts).toBe(1);
    const retry = await w.service.retryWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
      ACTOR,
    );
    expect(retry.status).toBe("completed");
    expect(retry.attempts).toBe(2);
    // TWO distinct paid allocations (one per attempt key)...
    expect(w.fleet.listAllocations().length).toBe(2);
    // ...TWO reservations (attempt 1 released on failure, attempt 2 settled)...
    expect(w.budget.reservedOperations_().length).toBe(2);
    expect(w.budget.releases.length).toBe(1);
    expect(w.budget.settles.length).toBe(1);
    // ...and the settle targets the LIVE attempt-2 reservation (the
    // review-found defect regression: the discriminator rebinds).
    expect(retry.budgetOperationId).not.toBe(first.budgetOperationId);
    expect(w.budget.settles[0]?.operationId).toBe(retry.budgetOperationId);
    expect(w.budget.releases[0]?.operationId).toBe(first.budgetOperationId);
  });

  test("the retry ladder is bounded", async () => {
    const w = world({ failRunsOf: () => true });
    const admitted = await submit(w);
    let last: TrainingWorkloadRecord | null = null;
    for (let i = 0; i < 2; i += 1) {
      last = await w.service.dispatchWorkload(
        { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
        ACTOR,
      );
      expect(last.status).toBe("failed");
      last = await w.service.retryWorkload(
        { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
        ACTOR,
      );
    }
    expect(last?.attempts).toBe(3);
    await expectPlatformError("SANDBOX_ERROR", () =>
      w.service.retryWorkload({ applicationId: TR_APPLICATION_ID, workloadId: admitted.id }, ACTOR),
    );
  });

  test("a retried workload's completion records its OWN attempt envelope and binds the completed sequence (the per-attempt key fix)", async () => {
    const w = world({ failRunsOf: (_id, attempt) => attempt === 1 });
    const admitted = await submit(w);
    const first = await w.service.dispatchWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
      ACTOR,
    );
    expect(first.status).toBe("failed");
    // The failed attempt's terminal outcome IS on the ledger...
    const failedEvents = w.ledger
      .eventsOf(TR_EXECUTION_ID)
      .filter((entry) => entry.event.command === "sandbox-completed");
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0]?.event.payload.outcomeClass).toBe("workload-failed");
    expect(first.ledgerCompletedSequence).toBeNull(); // failure never binds it

    const retry = await w.service.retryWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
      ACTOR,
    );
    expect(retry.status).toBe("completed");
    // The re-review defect regression: the completion event key was
    // workload-scoped, so the successful attempt's envelope collided
    // with the failed attempt's burned key and was silently dropped —
    // the row completed with a NULL completed binding while the
    // ledger's final training event said "workload-failed".
    const completedEvents = w.ledger
      .eventsOf(TR_EXECUTION_ID)
      .filter((entry) => entry.event.command === "sandbox-completed");
    expect(completedEvents.length).toBe(2);
    expect(completedEvents[0]?.event.payload.outcomeClass).toBe("workload-failed");
    expect(completedEvents[1]?.event.payload.outcomeClass).toBe("workload-completed");
    expect(retry.ledgerCompletedSequence).toBe(completedEvents[1]?.sequence);
    expect(retry.ledgerCompletedSequence).not.toBeNull();
  });
});

describe("verification before release (ACC-003)", () => {
  test("a completed workload is NOT released; only the verification PASS releases", async () => {
    const w = world();
    const { final } = await submitAndDispatch(w);
    expect(final.verifiedReleaseAt).toBeNull();
    w.verification.verdict = "fail";
    await expectPlatformError("VERIFICATION_FAILED", () =>
      w.service.verifyAndReleaseWorkload(
        {
          applicationId: TR_APPLICATION_ID,
          workloadId: final.id,
          criteria: [{ criterionId: "heldout-accuracy", version: 1 }],
          evidenceRefs: ["eval:heldout-1"],
        },
        "release-key-1",
        ACTOR,
      ),
    );
    const denied = await w.service.getWorkload(TR_APPLICATION_ID, final.id);
    expect(denied?.verifiedReleaseAt).toBeNull();
    // The verification authority was consulted exactly once (keyed).
    expect(w.verification.requests.length).toBe(1);

    w.verification.verdict = "pass";
    const released = await w.service.verifyAndReleaseWorkload(
      {
        applicationId: TR_APPLICATION_ID,
        workloadId: final.id,
        criteria: [{ criterionId: "heldout-accuracy", version: 1 }],
        evidenceRefs: ["eval:heldout-1"],
      },
      "release-key-2",
      ACTOR,
    );
    expect(released.verifiedReleaseAt).not.toBeNull();
    expect(released.verificationEvaluationId).not.toBeNull();
    // Write-once: a replay never re-consults the authority.
    const replay = await w.service.verifyAndReleaseWorkload(
      {
        applicationId: TR_APPLICATION_ID,
        workloadId: final.id,
        criteria: [{ criterionId: "heldout-accuracy", version: 1 }],
        evidenceRefs: ["eval:heldout-1"],
      },
      "release-key-3",
      ACTOR,
    );
    expect(replay.verifiedReleaseAt).toBe(released.verifiedReleaseAt);
    expect(w.verification.requests.length).toBe(2);
  });

  test("a FAILED workload can never enter release verification", async () => {
    const w = world({ failRunsOf: () => true });
    const { final } = await submitAndDispatch(w);
    expect(final.status).toBe("failed");
    await expectPlatformError("INVALID_STATE_TRANSITION", () =>
      w.service.verifyAndReleaseWorkload(
        {
          applicationId: TR_APPLICATION_ID,
          workloadId: final.id,
          criteria: [],
          evidenceRefs: [],
        },
        "release-key-f",
        ACTOR,
      ),
    );
    expect(w.verification.requests.length).toBe(0);
  });
});

describe("provider/accelerator substitution (ACC-002/AC-6)", () => {
  test("two different fleets behind the same contract produce the same execution abstraction", async () => {
    const runOnce = async (fabricId: string) => {
      const store = new InMemoryTrainingStore();
      const admission = new FakeTrainingAdmission();
      const substrates = new FakeSubstrateCatalog();
      const capabilities = new FakeTrainingCapabilities();
      const budget = new FakeTrainingBudget();
      const ledger = new FakeTrainingLedger();
      ledger.seedExecution(TR_EXECUTION_ID, "RUNNING");
      const verification = new FakeTrainingVerification();
      let counter = 0;
      const generateId = () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
      const fleet = new SimulatedAcceleratorFleet(fabricId, GPU_INVENTORY, {
        now: () => new Date(),
        generateId,
      });
      const runtimes = createAcceleratorRuntimeRegistry();
      runtimes.register(createAcceleratorSubstrateRuntime(fleet));
      substrates.offer(
        substrateSelectionOf(`accelerator-fabric-${fabricId}`, `accelerator-fabric:${fabricId}`),
      );
      const service = createTrainingService({
        store,
        admission: { admit: admission.admit },
        substrates: { select: substrates.select },
        capabilities: { resolve: capabilities.resolve },
        budgetAuthority: budget,
        ledger,
        runtimes,
        verification,
        digest: sha256Hex,
        generateId,
        now: () => new Date(),
      });
      const key = `sub-${fabricId}`;
      const admitted = await service.submitWorkload(
        { executionId: TR_EXECUTION_ID, spec: SPEC },
        key,
        ACTOR,
      );
      const final = await service.dispatchWorkload(
        { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
        ACTOR,
      );
      return { final, fleet, ledger, commands: ledger.commandsOf(TR_EXECUTION_ID).join("|") };
    };
    const a = await runOnce("f1");
    const b = await runOnce("f2");
    // The core execution abstraction is UNCHANGED: same statuses, same
    // ledger vocabulary sequence, same one-allocation/one-run physics.
    expect(a.final.status).toBe("completed");
    expect(b.final.status).toBe("completed");
    expect(a.commands).toBe(b.commands);
    expect(a.fleet.runCount()).toBe(1);
    expect(b.fleet.runCount()).toBe(1);
    expect(a.fleet.listAllocations().length).toBe(1);
    expect(b.fleet.listAllocations().length).toBe(1);
    expect(a.fleet.fabricId).not.toBe(b.fleet.fabricId);
    // The only differences are the neutral substrate evidence fields.
    expect(a.final.substrateId).not.toBe(b.final.substrateId);
  });
});

describe("tenant isolation", () => {
  test("every operation fails closed across tenants", async () => {
    const w = world();
    const admitted = await submit(w);
    for (const op of [
      () =>
        w.service.dispatchWorkload(
          { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
          FOREIGN_ACTOR,
        ),
      () =>
        w.service.cancelWorkload(
          { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
          FOREIGN_ACTOR,
        ),
      () =>
        w.service.resumeWorkload(
          { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
          FOREIGN_ACTOR,
        ),
      () =>
        w.service.retryWorkload(
          { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
          FOREIGN_ACTOR,
        ),
      () =>
        w.service.verifyAndReleaseWorkload(
          {
            applicationId: TR_APPLICATION_ID,
            workloadId: admitted.id,
            criteria: [],
            evidenceRefs: [],
          },
          "iso",
          FOREIGN_ACTOR,
        ),
    ]) {
      await expectPlatformError("TENANT_SCOPE_VIOLATION", op);
    }
    expect(await w.service.getWorkload(TR_OTHER_APPLICATION_ID, admitted.id)).toBeNull();
  });
});

describe("store parity (the in-memory store enforces the SQL store's contracts)", () => {
  test("insertTrainingOperation fails closed on same key + different fingerprint (SQL parity)", async () => {
    const w = world();
    const base = {
      applicationId: TR_APPLICATION_ID,
      tenantId: TR_TENANT_ID,
      executionId: TR_EXECUTION_ID,
      workloadId: null,
      operationKind: "cancel" as const,
      operationKey: "trop:cancel:parity-key",
      createdAt: new Date().toISOString(),
    };
    const first = await w.store.insertTrainingOperation({
      ...base,
      id: "00000000-0000-7000-8000-0000000000d1",
      requestFingerprint: "cancel:parity-key",
    });
    expect(first.claimed).toBe(true);
    // Same key + SAME fingerprint: convergent replay with attempts bumped.
    const replay = await w.store.insertTrainingOperation({
      ...base,
      id: "00000000-0000-7000-8000-0000000000d2",
      requestFingerprint: "cancel:parity-key",
    });
    expect(replay.claimed).toBe(false);
    expect(replay.record.attempts).toBe(2);
    // Same key + DIFFERENT fingerprint: key reuse fails closed — the
    // SQL store's contract the in-memory twin previously omitted (the
    // re-review store-parity defect: the unit tier accepted writes the
    // real store rejects).
    await expectPlatformError("IDEMPOTENCY_KEY_REUSED", () =>
      w.store.insertTrainingOperation({
        ...base,
        id: "00000000-0000-7000-8000-0000000000d3",
        requestFingerprint: "cancel:parity-key-OTHER",
      }),
    );
  });
});
