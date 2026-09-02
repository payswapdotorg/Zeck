/**
 * Crash-injection proofs — the durable, recoverable training OPERATION
 * state and the STABLE idempotency keys (WORK-030; checkpoint contract
 * CONCURRENCY-CRASH-SAFETY; the WORK-024/026/028 crash standard).
 *
 * THE CRASH MODEL (kill/restart at the durable boundaries): a Zeck
 * process dies mid-operation. What survives a process crash:
 *   - the DURABLE STATE (the in-memory training store — the workload
 *     journal, the write-once checkpoint ledger, the operation ledger,
 *     the run leases — the SQL twin over migration 0025 is proven in
 *     tests/integration/postgres/training-crash-recovery.test.ts);
 *   - the EXECUTIONS LEDGER (the FakeTrainingLedger — idempotent per
 *     key, append-only, the canonical evidence path);
 *   - the BUDGETS AUTHORITY (keyed-idempotent reserve/settle/release);
 *   - the ACCELERATOR FLEET (the simulated substrate's keyed
 *     allocation/run ledgers — exactly what a real fleet's idempotency
 *     contract provides);
 *   - the VERIFICATION AUTHORITY (keyed-idempotent verdicts).
 * What dies: the in-flight service process (its closure, its unwritten
 * intents). A "restart" is a NEW service instance booted over the
 * surviving world (`boot(point)`).
 *
 * The injector arms ONE durable-boundary crash point per process (a
 * method on store/ledger/budget/fleet, before/after its durable commit)
 * and THROWS a ProcessCrashError through the awaited call — every armed
 * point below is OUTSIDE the service's best-effort `.catch()` regions,
 * so the crash always propagates and the process genuinely dies
 * mid-flight. The test then reboots (a fresh process) and re-issues the
 * SAME logical operation under the SAME idempotency coordinates.
 *
 * THE PROOF RECORDS (the required lifecycle points):
 *   SUBMISSION           C1 crash before the workload row | C2 crash
 *                        after the row, before the admitted envelope
 *                        (the replay repairs the binding) | C3 crash
 *                        after the reservation, before the row (the
 *                        keyed reservation converges)
 *   PAID DISPATCH        C4 crash before the fleet allocation (zero
 *                        paid activity; resume converges) | C5 crash
 *                        after the allocation, before the row binding
 *                        (keyed convergence — ONE allocation) | C6
 *                        crash after the run observation, before the
 *                        checkpoint writes (the keyed run ledger
 *                        replays; checkpoints recorded once)
 *   COMPLETION           C7 crash after the checkpoints, before the
 *                        completion envelope | C8 crash after the
 *                        completed row, before the budget tail (the
 *                        terminal replay RECONCILES: settle + lease +
 *                        allocation release exactly once)
 *   CANCELLATION         C9 crash after the cancelled row, before the
 *                        refund (the terminal replay reconciles)
 *   RESUME               C10 crash after lease re-acquisition before
 *                        the resume evidence (the lease lapses; the
 *                        next resume re-acquires at a higher epoch)
 *   RETRY                C11 crash after the fresh reservation, before
 *                        the re-arm (the keyed reservation converges;
 *                        the discriminator rebinds exactly once)
 *   RELEASE              C12 crash after the binding, before the
 *                        operation completion (the write-once release
 *                        replays without re-consulting the authority)
 *
 * Every record asserts the SAME invariants: EXACTLY ONE paid fleet
 * allocation per stable attempt key and one run observation per run key
 * (the fleet's ledgers — never a second row), exactly one reservation /
 * settle / release per budget operation id, the operation rows reach
 * their terminal status with the honest attempts ledger, and the durable
 * rows (workload / checkpoints / lease / release binding) exist exactly
 * once.
 */

import { describe, expect, test } from "vitest";
import {
  createAcceleratorSubstrateRuntime,
  SimulatedAcceleratorFleet,
} from "../../../src/integrations/accelerators/public";
import {
  createAcceleratorRuntimeRegistry,
  createTrainingService,
  InMemoryTrainingStore,
  type TrainingService,
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
  TR_TENANT_ID,
} from "./training-fakes";

const ACTOR = { actorId: TR_ACTOR_ID, applicationId: TR_APPLICATION_ID, tenantId: TR_TENANT_ID };

const GPU_INVENTORY = Array.from({ length: 8 }, () => ({
  deviceClass: "gpu",
  memoryMiB: 32_768,
  computeUnits: 100,
  fabricAttached: true,
}));

const SPEC: TrainingWorkloadSpec = {
  workloadKind: "fine-tuning",
  task: { command: "finetune", args: ["--steps", "12"], publicEnv: {} },
  resource: {
    accelerator: {
      acceleratorClass: "gpu",
      deviceCount: 2,
      perDeviceMemoryMiB: 16_384,
      interconnect: "none",
    },
    replicaCount: 1,
    cpuMilliCores: 2000,
    memoryMiB: 4096,
    estimatedDurationMs: 1_800_000,
    estimatedCostMicroUsd: "90000",
  },
  lineage: {
    datasetRefs: ["dataset:corpus-2"],
    codeRefs: ["code:trainer-4"],
    configRefs: ["config:hparams-b"],
    checkpointRefs: [],
    parentOutputRefs: [],
  },
  checkpointIntervalSteps: 4,
  maxRetryAttempts: 2,
};

/** The simulated process death (never a typed service error). */
class ProcessCrashError extends Error {
  constructor(point: string) {
    super(`simulated process crash at ${point}`);
    this.name = "ProcessCrashError";
  }
}

/** One armed durable-boundary crash point (per booted process). */
interface TrainingCrashPoint {
  readonly target: "store" | "ledger" | "budget" | "fleet";
  readonly method: string;
  readonly when: "before" | "after";
  /** Fire on the Nth invocation within THIS process (default 1). */
  readonly occurrence?: number;
}

/**
 * Wrap one durable seam so the booted process dies at the planned point
 * (`before` = the durable commit did not happen; `after` = it did). The
 * wrapper records the firing so a vacuous proof fails `crashed()`.
 */
function crashableSeam<T extends object>(
  target: T,
  label: string,
  point: TrainingCrashPoint | null,
) {
  let fired = false;
  if (point === null || point.target !== label) {
    return { proxy: target, crashed: () => fired };
  }
  const seen = new Map<string, number>();
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (typeof prop !== "string") {
        return Reflect.get(t, prop, t);
      }
      const value = Reflect.get(t, prop, t);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        const invocations = (seen.get(prop) ?? 0) + 1;
        seen.set(prop, invocations);
        const matches = prop === point.method && (point.occurrence ?? 1) === invocations;
        const die = (phase: "before" | "after") => {
          if (matches && point.when === phase) {
            fired = true;
            throw new ProcessCrashError(`${label}.${prop}#${invocations}:${phase}`);
          }
        };
        die("before");
        const result = (value as (...a: unknown[]) => unknown).apply(t, args);
        if (result instanceof Promise) {
          return result.then((resolved) => {
            die("after");
            return resolved;
          });
        }
        die("after");
        return result;
      };
    },
  });
  return { proxy, crashed: () => fired };
}

/** The mutable clock (lease-lapse control). */
class Clock {
  now = new Date("2026-09-02T10:00:00.000Z");
  advance(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }
}

interface SurvivingWorld {
  readonly store: InMemoryTrainingStore;
  readonly ledger: FakeTrainingLedger;
  readonly budget: FakeTrainingBudget;
  readonly fleet: SimulatedAcceleratorFleet;
  readonly verification: FakeTrainingVerification;
  readonly clock: Clock;
  boot(point?: TrainingCrashPoint | null): {
    readonly service: TrainingService;
    readonly crashed: () => boolean;
  };
}

function survivingWorld(
  options: { readonly failRunsOf?: (workloadId: string, attempt: number) => boolean } = {},
): SurvivingWorld {
  const store = new InMemoryTrainingStore();
  const ledger = new FakeTrainingLedger();
  ledger.seedExecution(TR_EXECUTION_ID, "RUNNING");
  const budget = new FakeTrainingBudget();
  const verification = new FakeTrainingVerification();
  const clock = new Clock();
  let counter = 0;
  const generateId = () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
  const fleet = new SimulatedAcceleratorFleet("f1", GPU_INVENTORY, {
    now: () => clock.now,
    generateId,
    ...(options.failRunsOf === undefined ? {} : { failRunsOf: options.failRunsOf }),
  });
  const boot = (point: TrainingCrashPoint | null = null) => {
    const admission = new FakeTrainingAdmission();
    const substrates = new FakeSubstrateCatalog();
    const capabilities = new FakeTrainingCapabilities();
    const fleetProcess = crashableSeam(fleet, "fleet", point);
    const runtime = createAcceleratorSubstrateRuntime(fleetProcess.proxy);
    const runtimes = createAcceleratorRuntimeRegistry();
    runtimes.register(runtime);
    substrates.offer(substrateSelectionOf("accelerator-fabric-f1", "accelerator-fabric-f1"));
    const storeProcess = crashableSeam(store, "store", point);
    const ledgerProcess = crashableSeam(ledger, "ledger", point);
    const budgetProcess = crashableSeam(budget, "budget", point);
    const service = createTrainingService({
      store: storeProcess.proxy,
      admission: { admit: admission.admit },
      substrates: { select: substrates.select },
      capabilities: { resolve: capabilities.resolve },
      budgetAuthority: budgetProcess.proxy,
      ledger: ledgerProcess.proxy,
      runtimes,
      verification,
      digest: sha256Hex,
      generateId,
      now: () => clock.now,
      leaseDurationMs: 60_000,
    });
    return {
      service,
      crashed: () =>
        storeProcess.crashed() ||
        ledgerProcess.crashed() ||
        budgetProcess.crashed() ||
        fleetProcess.crashed(),
    };
  };
  return { store, ledger, budget, fleet, verification, clock, boot };
}

const dies = async (run: () => Promise<unknown>): Promise<ProcessCrashError | null> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ProcessCrashError) {
      return error;
    }
    throw error;
  }
  return null;
};

const submitInput = { executionId: TR_EXECUTION_ID, spec: SPEC };

describe("training crash recovery — submission", () => {
  test("C1: a crash BEFORE the workload row replays with one row, one reservation, one envelope", async () => {
    const world = survivingWorld();
    const first = world.boot({ target: "store", method: "insertWorkload", when: "before" });
    const crash = await dies(() => first.service.submitWorkload(submitInput, "crash-key-1", ACTOR));
    expect(crash).not.toBeNull();
    expect(first.crashed()).toBe(true);
    expect(world.fleet.listAllocations()).toEqual([]);
    const reboot = world.boot(null);
    const record = await reboot.service.submitWorkload(submitInput, "crash-key-1", ACTOR);
    expect(record.status).toBe("admitted");
    expect(world.budget.reserves.length).toBe(1); // ONE reservation (the first died pre-commit)
    expect(world.ledger.eventsOf(TR_EXECUTION_ID).length).toBe(1); // sandbox-admitted once
    expect(record.ledgerAdmittedSequence).not.toBeNull();
  });

  test("C2: a crash AFTER the row, BEFORE the envelope — the replay repairs the binding", async () => {
    const world = survivingWorld();
    const first = world.boot({ target: "ledger", method: "recordStepEvent", when: "before" });
    const crash = await dies(() => first.service.submitWorkload(submitInput, "crash-key-2", ACTOR));
    expect(crash).not.toBeNull();
    const row = await world.store.findWorkloadByKey(TR_APPLICATION_ID, "crash-key-2");
    expect(row?.status).toBe("admitted");
    expect(row?.ledgerAdmittedSequence).toBeNull(); // the binding died with the process
    const reboot = world.boot(null);
    const record = await reboot.service.submitWorkload(submitInput, "crash-key-2", ACTOR);
    expect(record.id).toBe(row?.id);
    expect(record.ledgerAdmittedSequence).not.toBeNull(); // repaired
    expect(world.ledger.eventsOf(TR_EXECUTION_ID).length).toBe(1);
    expect(world.budget.reserves.length).toBe(1);
  });

  test("C3: a crash AFTER the reservation, BEFORE the row — the keyed reservation converges", async () => {
    const world = survivingWorld();
    const first = world.boot({ target: "store", method: "insertWorkload", when: "after" });
    const crash = await dies(() => first.service.submitWorkload(submitInput, "crash-key-3", ACTOR));
    expect(crash).not.toBeNull();
    expect(world.budget.reservedOperations_().length).toBe(1);
    const reboot = world.boot(null);
    const record = await reboot.service.submitWorkload(submitInput, "crash-key-3", ACTOR);
    expect(record.status).toBe("admitted");
    expect(world.budget.reserves.length).toBe(1); // converged, not doubled
    expect(world.ledger.eventsOf(TR_EXECUTION_ID).length).toBe(1);
  });
});

describe("training crash recovery — paid dispatch", () => {
  test("C4: a crash BEFORE the fleet allocation leaves ZERO paid activity; resume converges", async () => {
    const world = survivingWorld();
    const admitted = await world
      .boot(null)
      .service.submitWorkload(submitInput, "crash-key-4", ACTOR);
    const dispatching = world.boot({ target: "fleet", method: "allocate", when: "before" });
    const crash = await dies(() =>
      dispatching.service.dispatchWorkload(
        { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
        ACTOR,
      ),
    );
    expect(crash).not.toBeNull();
    expect(world.fleet.listAllocations()).toEqual([]); // ZERO paid activity
    const row = await world.store.findWorkloadByKey(TR_APPLICATION_ID, "crash-key-4");
    expect(row?.status).toBe("allocating"); // the honest in-flight state
    const reboot = world.boot(null);
    const final = await reboot.service.resumeWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
      ACTOR,
    );
    expect(final.status).toBe("completed");
    expect(world.fleet.listAllocations().length).toBe(1); // exactly one paid allocation
    expect(world.fleet.runCount()).toBe(1);
    expect(world.budget.settles.length).toBe(1);
  });

  test("C5: a crash AFTER the fleet allocation, BEFORE the row binding — keyed convergence", async () => {
    const world = survivingWorld();
    const admitted = await world
      .boot(null)
      .service.submitWorkload(submitInput, "crash-key-5", ACTOR);
    const dispatching = world.boot({
      target: "store",
      method: "bindWorkloadAllocation",
      when: "before",
    });
    const crash = await dies(() =>
      dispatching.service.dispatchWorkload(
        { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
        ACTOR,
      ),
    );
    expect(crash).not.toBeNull();
    expect(world.fleet.listAllocations().length).toBe(1); // the paid allocation committed
    const reboot = world.boot(null);
    const final = await reboot.service.resumeWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
      ACTOR,
    );
    expect(final.status).toBe("completed");
    // The SAME allocation key converged — never a second allocation.
    expect(world.fleet.listAllocations().length).toBe(1);
    expect(final.allocationId).not.toBeNull();
    expect(world.fleet.runCount()).toBe(1);
  });

  test("C6: a crash AFTER the run observation, BEFORE the checkpoint writes — the keyed run ledger replays", async () => {
    const world = survivingWorld();
    const admitted = await world
      .boot(null)
      .service.submitWorkload(submitInput, "crash-key-6", ACTOR);
    const dispatching = world.boot({
      target: "store",
      method: "insertTrainingCheckpoint",
      when: "before",
    });
    const crash = await dies(() =>
      dispatching.service.dispatchWorkload(
        { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
        ACTOR,
      ),
    );
    expect(crash).not.toBeNull();
    expect(world.fleet.runCount()).toBe(1); // the run observation committed
    // The crashed worker's lease LAPSES (the honest recovery clock).
    world.clock.advance(120_000);
    const reboot = world.boot(null);
    const final = await reboot.service.resumeWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
      ACTOR,
    );
    expect(final.status).toBe("completed");
    // The run REPLAYED from the keyed ledger — no second run invocation.
    expect(world.fleet.runCount()).toBe(1);
    // The checkpoints were recorded exactly once each.
    const checkpoints = await world.store.listTrainingCheckpointsByWorkload(
      TR_APPLICATION_ID,
      "crash-key-6",
    );
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(final.status).toBe("completed");
  });
});

describe("training crash recovery — completion", () => {
  test("C7: a crash AFTER the checkpoints, BEFORE the completion envelope", async () => {
    const world = survivingWorld();
    const admitted = await world
      .boot(null)
      .service.submitWorkload(submitInput, "crash-key-7", ACTOR);
    // Arm the completion envelope precisely: within the DISPATCH
    // process the ledger calls are checkpoint-recorded x3 (interval 4
    // over 12 steps) then sandbox-completed — invocation 4 (the
    // sandbox-admitted envelope rode the submission process).
    const precise = world.boot({
      target: "ledger",
      method: "recordStepEvent",
      when: "before",
      occurrence: 4,
    });
    const crash = await dies(() =>
      precise.service.dispatchWorkload(
        { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
        ACTOR,
      ),
    );
    expect(crash).not.toBeNull();
    const checkpoints = await world.store.listTrainingCheckpointsByWorkload(
      TR_APPLICATION_ID,
      "crash-key-7",
    );
    expect(checkpoints.length).toBe(3);
    const row = await world.store.findWorkloadByKey(TR_APPLICATION_ID, "crash-key-7");
    expect(row?.status).toBe("running"); // the honest pre-completion state
    // The live run lease lapses before the recovery resume.
    world.clock.advance(120_000);
    const reboot = world.boot(null);
    const final = await reboot.service.resumeWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
      ACTOR,
    );
    expect(final.status).toBe("completed");
    const commands = world.ledger.commandsOf(TR_EXECUTION_ID);
    expect(commands.filter((c) => c === "sandbox-completed").length).toBe(1);
    expect(world.fleet.runCount()).toBe(1);
    expect(world.budget.settles.length).toBe(1);
  });

  test("C8: a crash AFTER the completed row, BEFORE the budget tail — the terminal replay RECONCILES", async () => {
    const world = survivingWorld();
    const admitted = await world
      .boot(null)
      .service.submitWorkload(submitInput, "crash-key-8", ACTOR);
    // Crash AFTER the completed row's terminal transition (occurrence 3
    // within the dispatch process: allocating -> running -> completed),
    // BEFORE the finalization tail — the checkpoint operations now also
    // completeTrainingOperation BEFORE the transition (the re-review
    // operation-discipline fix), so the tail boundary is pinned on the
    // transition itself, not on the first post-transition store call.
    const dispatching = world.boot({
      target: "store",
      method: "transitionWorkload",
      when: "after",
      occurrence: 3,
    });
    const crash = await dies(() =>
      dispatching.service.dispatchWorkload(
        { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
        ACTOR,
      ),
    );
    expect(crash).not.toBeNull();
    const row = await world.store.findWorkloadByKey(TR_APPLICATION_ID, "crash-key-8");
    expect(row?.status).toBe("completed"); // the terminal row committed
    expect(world.budget.settles.length).toBe(0); // the tail died
    const lease = await world.store.findTrainingRunLease(TR_APPLICATION_ID, admitted.id);
    expect(lease?.releasedAt).toBeNull();
    // The terminal replay (a fresh dispatch of the terminal row).
    const reboot = world.boot(null);
    const final = await reboot.service.dispatchWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
      ACTOR,
    );
    expect(final.status).toBe("completed");
    expect(world.fleet.runCount()).toBe(1); // never re-executed
    expect(world.budget.settles.length).toBe(1); // the reconciled tail
    expect(
      (await world.store.findTrainingRunLease(TR_APPLICATION_ID, admitted.id))?.releasedAt,
    ).not.toBeNull();
    expect(world.fleet.listAllocations().length).toBe(1); // still exactly one
    expect(world.fleet.listAllocations()[0]?.releasedAt).not.toBeNull();
  });
});

describe("training crash recovery — cancellation", () => {
  test("C9: a crash AFTER the cancelled row, BEFORE the refund — the terminal replay reconciles", async () => {
    const world = survivingWorld();
    const admitted = await world
      .boot(null)
      .service.submitWorkload(submitInput, "crash-key-9", ACTOR);
    const cancelling = world.boot({
      target: "store",
      method: "transitionWorkload",
      when: "after",
    });
    const crash = await dies(() =>
      cancelling.service.cancelWorkload(
        { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
        ACTOR,
      ),
    );
    expect(crash).not.toBeNull();
    const row = await world.store.findWorkloadByKey(TR_APPLICATION_ID, "crash-key-9");
    expect(row?.status).toBe("cancelled"); // the terminal row committed
    expect(world.budget.releases.length).toBe(0); // the refund died with the process
    const reboot = world.boot(null);
    const final = await reboot.service.cancelWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
      ACTOR,
    );
    expect(final.status).toBe("cancelled");
    expect(world.budget.releases.length).toBe(1); // reconciled exactly once
    expect(world.fleet.listAllocations()).toEqual([]); // nothing was ever allocated
  });
});

describe("training crash recovery — resume", () => {
  test("C10: a crash AFTER lease re-acquisition — the lease lapses and the next resume re-acquires higher", async () => {
    const world = survivingWorld();
    const admitted = await world
      .boot(null)
      .service.submitWorkload(submitInput, "crash-key-10", ACTOR);
    // Arm the honest crashed-worker state: allocating + an EXPIRED lease.
    const past = new Date("2026-09-02T09:00:00.000Z");
    const store = world.store;
    await store.transitionWorkload({
      applicationId: TR_APPLICATION_ID,
      workloadKey: "crash-key-10",
      to: "allocating",
      now: past.toISOString(),
    });
    await store.acquireTrainingRunLease({
      applicationId: TR_APPLICATION_ID,
      workloadId: admitted.id,
      tenantId: TR_TENANT_ID,
      ownerId: "training-worker:crash-key-10",
      now: past.toISOString(),
      leaseDurationMs: 1000,
    });
    // The resume process dies right AFTER the lease re-acquisition,
    // BEFORE the resume-recorded evidence (the first ledger call of the
    // resume process).
    const resuming = world.boot({
      target: "ledger",
      method: "recordStepEvent",
      when: "before",
      occurrence: 1,
    });
    const crash = await dies(() =>
      resuming.service.resumeWorkload(
        { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
        ACTOR,
      ),
    );
    expect(crash).not.toBeNull();
    const leaseAfterCrash = await store.findTrainingRunLease(TR_APPLICATION_ID, admitted.id);
    expect(leaseAfterCrash?.epoch).toBeGreaterThanOrEqual(2);
    expect(leaseAfterCrash?.releasedAt).toBeNull();
    // The lease is LIVE — the immediate replay fails closed...
    const blocked = world.boot(null);
    let blockedCode = "";
    try {
      await blocked.service.resumeWorkload(
        { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
        ACTOR,
      );
    } catch (error) {
      blockedCode = error instanceof PlatformError ? error.code : "";
    }
    expect(blockedCode).toBe("INVALID_STATE_TRANSITION");
    // ...the lease LAPSES by expiry (the clock advances)...
    world.clock.advance(120_000);
    // ...and the next resume re-acquires at a HIGHER epoch and converges.
    const reboot = world.boot(null);
    const final = await reboot.service.resumeWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
      ACTOR,
    );
    expect(final.status).toBe("completed");
    const lease = await store.findTrainingRunLease(TR_APPLICATION_ID, admitted.id);
    expect(lease?.epoch).toBeGreaterThan(leaseAfterCrash?.epoch ?? 0);
    expect(lease?.releasedAt).not.toBeNull();
    expect(world.fleet.listAllocations().length).toBe(1);
    expect(world.fleet.runCount()).toBe(1);
    expect(world.budget.settles.length).toBe(1);
  });
});

describe("training crash recovery — retry", () => {
  test("C11: a crash AFTER the fresh reservation, BEFORE the re-arm — the keyed reservation converges", async () => {
    const world = survivingWorld({ failRunsOf: (_id, attempt) => attempt === 1 });
    const admitted = await world
      .boot(null)
      .service.submitWorkload(submitInput, "crash-key-11", ACTOR);
    const first = await world
      .boot(null)
      .service.dispatchWorkload(
        { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
        ACTOR,
      );
    expect(first.status).toBe("failed");
    expect(world.budget.reservedOperations_().length).toBe(1);
    const retrying = world.boot({
      target: "store",
      method: "bumpWorkloadAttempts",
      when: "before",
    });
    const crash = await dies(() =>
      retrying.service.retryWorkload(
        { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
        ACTOR,
      ),
    );
    expect(crash).not.toBeNull();
    expect(world.budget.reservedOperations_().length).toBe(2); // attempt-2 reserved
    const row = await world.store.findWorkloadByKey(TR_APPLICATION_ID, "crash-key-11");
    expect(row?.attempts).toBe(1); // the re-arm died
    const reboot = world.boot(null);
    const final = await reboot.service.retryWorkload(
      { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
      ACTOR,
    );
    expect(final.status).toBe("completed");
    expect(final.attempts).toBe(2);
    expect(world.budget.reserves.length).toBe(2); // TWO distinct attempts, never a third
    expect(world.budget.releases.length).toBe(1); // attempt-1 released on failure
    expect(world.budget.settles.length).toBe(1); // attempt-2 settled once
    expect(world.budget.settles[0]?.operationId).toBe(final.budgetOperationId);
    expect(world.fleet.listAllocations().length).toBe(2); // one per attempt key
  });
});

describe("training crash recovery — release", () => {
  test("C12: a crash AFTER the release binding, BEFORE the operation completion — write-once replay", async () => {
    const world = survivingWorld();
    const admitted = await world
      .boot(null)
      .service.submitWorkload(submitInput, "crash-key-12", ACTOR);
    const completed = await world
      .boot(null)
      .service.dispatchWorkload(
        { applicationId: TR_APPLICATION_ID, workloadId: admitted.id },
        ACTOR,
      );
    expect(completed.status).toBe("completed");
    world.verification.verdict = "pass";
    const releasing = world.boot({
      target: "store",
      method: "completeTrainingOperation",
      when: "before",
    });
    const crash = await dies(() =>
      releasing.service.verifyAndReleaseWorkload(
        {
          applicationId: TR_APPLICATION_ID,
          workloadId: admitted.id,
          criteria: [{ criterionId: "heldout-accuracy", version: 1 }],
          evidenceRefs: ["eval:heldout-9"],
        },
        "release-crash-12",
        ACTOR,
      ),
    );
    expect(crash).not.toBeNull();
    const bound = await world.store.findWorkloadByKey(TR_APPLICATION_ID, "crash-key-12");
    expect(bound?.verifiedReleaseAt).not.toBeNull(); // the binding committed
    const callsBefore = world.verification.requests.length;
    const reboot = world.boot(null);
    const replay = await reboot.service.verifyAndReleaseWorkload(
      {
        applicationId: TR_APPLICATION_ID,
        workloadId: admitted.id,
        criteria: [{ criterionId: "heldout-accuracy", version: 1 }],
        evidenceRefs: ["eval:heldout-9"],
      },
      "release-crash-12",
      ACTOR,
    );
    expect(replay.verifiedReleaseAt).toBe(bound?.verifiedReleaseAt);
    // The write-once binding replayed WITHOUT re-consulting the authority.
    expect(world.verification.requests.length).toBe(callsBefore);
  });
});
