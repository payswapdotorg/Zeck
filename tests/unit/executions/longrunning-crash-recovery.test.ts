/**
 * Crash-injection proofs — the durable, recoverable long-running operation
 * state, the stable execution-scoped idempotency keys and the
 * committed-effect convergence of every side-effecting operation of the
 * long-running surface (WORK-028; checkpoint contract
 * CONCURRENCY-CRASH-SAFETY; the WORK-024 crash-safety standard from the PR
 * #46 review round, applied to checkpoint/resume/lease/interruption/
 * termination/wake-ups — the LNG acceptance bar).
 *
 * THE CRASH MODEL (kill/restart at the durable boundaries): a Zeck process
 * dies mid-operation. What survives a process crash:
 *   - the DURABLE STATE (the long-running store: checkpoints, leases,
 *     wake-ups and the execution_operations ledger);
 *   - the EXECUTIONS MODULE (its own durable fabric — the store, the
 *     idempotency-key ledger, the canonical EventEnvelope ledger);
 *   - the ADMISSION AUTHORITIES (durable modules behind their seams).
 * What dies: the in-flight service process (its closure, its unwritten
 * intents). A "restart" is a NEW service instance booted over the
 * surviving world (`boot()`).
 *
 * The injector arms ONE durable-boundary crash point per process (a method
 * on the long-running store or on the frozen executions service, before/
 * after its durable commit) and THROWS a ProcessCrashError through the
 * awaited call — every armed point below is OUTSIDE the service's
 * best-effort `.catch()` regions, so the crash always propagates and the
 * process genuinely dies mid-flight. The test then reboots (a fresh
 * process) and re-issues the SAME logical operation under the SAME
 * idempotency coordinates.
 *
 * THE PROOF RECORDS (every side-effecting operation of the Work Order):
 *   CHECKPOINT COMMIT   C1 claim | C2 durable insert (the committed-effect
 *                       probe) | C3 stage | C4 ledger evidence
 *   PAUSE               C5 checkpoint insert | C6 frozen wait transition
 *   RESUME              C7 claim | C8 lease acquire (no epoch inflation) |
 *                       C9 frozen resume transition | C10 materially
 *                       changed re-admission | C11 durable denial replay
 *   INTERRuption        C12 journal-then-act evidence | C13 wake supersede
 *   TERMINATION         C14 crash past the frozen cancel transition (the
 *                       orphan-convergence defect this suite found)
 *   WAKE-UPS            C15 schedule | C16 claimed stage (recovery scan) |
 *                       C17 applied marker | C18 resume-inside-apply (the
 *                       orphaned PENDING resume row — the second defect)
 *   LEASES              C19 acquire | C20 renew pre-stage | C21 renew
 *                       committed (exactly one heartbeat per key) |
 *                       C22 release
 *   KEY DISCIPLINE      C23 execution-scoped operation keys
 *
 * Every record asserts the SAME invariants: EXACTLY ONE durable side
 * effect per stable key across every crash window (one checkpoint row, one
 * ledger evidence event, one heartbeat bump, one wake application, one
 * frozen transition — the retry converges through the recorded stage or
 * the committed-effect probes), the operation row reaches COMPLETED with
 * the honest attempts ledger, the execution identity NEVER changes, and
 * every recovery that passes a committed effect converges WITHOUT the
 * lease guard re-firing (a lease that expired during the crash window
 * never blocks the convergence of an effect that is already durable).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { BudgetAuthority } from "../../../src/modules/budgets/public";
import { InMemoryLongRunningExecutionStore } from "../../../src/modules/executions/adapters/in-memory-long-running-store";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import {
  createLongRunningExecutionService,
  type LongRunningExecutionService,
  type ResumeExecutionCommand,
} from "../../../src/modules/executions/application/long-running-service";
import type { CheckpointContents, ResumeFacts } from "../../../src/modules/executions/domain/checkpoint";
import {
  longRunningOperationKey,
  type LongRunningOperationKind,
} from "../../../src/modules/executions/domain/longrunning";
import type { ResumeReAdmissionRequest } from "../../../src/modules/executions/ports/resume-admission";
import { PlatformError } from "../../../src/shared/errors";
import {
  allowAllAuthorization,
  FakeBudgetAuthority,
  InMemoryExecutionStore,
  InMemoryExecutionsIdempotency,
} from "./fakes";

const APPLICATION_ID = "00000000-0000-7000-8000-0000000000a1";
const ACTOR_ID = "00000000-0000-7000-8000-0000000000aa";
const TENANT_ID = "00000000-0000-7000-8000-0000000000bb";
const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

// ---------------------------------------------------------------------------
// The crash injector.
// ---------------------------------------------------------------------------

/** The simulated process death (never a typed service error). */
class ProcessCrashError extends Error {
  constructor(point: string) {
    super(`simulated process crash at ${point}`);
    this.name = "ProcessCrashError";
  }
}

/** One armed durable-boundary crash point (per process). */
interface CrashPoint {
  readonly target: "store" | "executions";
  readonly method: string;
  readonly when: "before" | "after";
  /** Fire on the Nth invocation within THIS process (default 1). */
  readonly occurrence?: number;
}

/**
 * Wrap one durable seam so the process dies at the planned point. `before`
 * = the durable commit did NOT happen; `after` = the commit did happen and
 * the process died immediately after. The wrapper records the firing so a
 * vacuous proof (a point the service never reaches) fails its `crashed()`
 * assertion.
 */
function crashing<T extends object>(target: T, label: string, point: CrashPoint | null) {
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

// ---------------------------------------------------------------------------
// The surviving world and the process boot.
// ---------------------------------------------------------------------------

/** Recording fakes for the two REQUIRED re-admission authorities. */
class AdmissionFakes {
  readonly policyCalls: ResumeReAdmissionRequest[] = [];
  readonly resourceCalls: ResumeReAdmissionRequest[] = [];
  denyPolicy = false;
  readonly policy = {
    readmit: async (request: ResumeReAdmissionRequest) => {
      this.policyCalls.push(request);
      return this.denyPolicy
        ? {
            allowed: false as const,
            reason: "fixture policy denial",
            denialCode: "POLICY_DENIED" as const,
          }
        : { allowed: true as const };
    },
  };
  readonly resource = {
    readmit: async (request: ResumeReAdmissionRequest) => {
      this.resourceCalls.push(request);
      return { allowed: true as const };
    },
  };
}

interface World {
  readonly executionStore: InMemoryExecutionStore;
  readonly store: InMemoryLongRunningExecutionStore;
  readonly admissions: AdmissionFakes;
  readonly budgets: FakeBudgetAuthority;
  readonly advance: (ms: number) => void;
  readonly driveToRunning: () => Promise<string>;
  /** Boot one Zeck process over the surviving world (the restart primitive). */
  boot(plan: CrashPoint | null): {
    service: LongRunningExecutionService;
    crashed: () => boolean;
  };
  executionId: string;
}

function createWorld(): World {
  // The SURVIVING durable fabric: the executions module (store + key
  // ledger — the frozen lifecycle + canonical ledger) and the long-running
  // store. A process death never touches these.
  const executionStore = new InMemoryExecutionStore();
  executionStore.seedApplication(APPLICATION_ID, TENANT_ID);
  const idempotency = new InMemoryExecutionsIdempotency();
  idempotency.store = executionStore;
  const store = new InMemoryLongRunningExecutionStore();
  const admissions = new AdmissionFakes();
  const budgets = new FakeBudgetAuthority();

  let n = 0;
  const generateId = () => {
    n += 1;
    return `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
  };
  let clockMs = Date.parse("2026-09-15T12:00:00Z");
  const now = () => new Date(clockMs);
  const advance = (ms: number) => {
    clockMs += ms;
  };

  const driveToRunning = async (): Promise<string> => {
    const executions = createExecutionService({
      store: executionStore,
      idempotency,
      authorization: allowAllAuthorization,
      generateId,
      now,
    });
    const actor = { actorId: ACTOR_ID, tenantId: TENANT_ID };
    const created = await executions.createExecution(
      { applicationId: APPLICATION_ID, task: { kind: "summarize", input: "artifact-1" } },
      `create-${generateId()}`,
      actor,
    );
    const executionId = created.executionId;
    const scope = { ...actor, applicationId: APPLICATION_ID, executionId };
    await executions.transition({ ...scope, command: "authorize" }, `authorize-${executionId}`);
    await executions.transition({ ...scope, command: "plan" }, `plan-${executionId}`);
    await executions.transition({ ...scope, command: "queue" }, `queue-${executionId}`);
    await executions.transition({ ...scope, command: "start" }, `start-${executionId}`);
    return executionId;
  };

  const boot = (plan: CrashPoint | null) => {
    // A NEW executions service instance over the SURVIVING store + key
    // ledger (the process-local composition of the durable module), then
    // the long-running service over it — both wrapped by the injector.
    const executionsProcess = crashing(
      createExecutionService({
        store: executionStore,
        idempotency,
        authorization: allowAllAuthorization,
        generateId,
        now,
      }),
      "executions",
      plan,
    );
    const storeProcess = crashing(store, "store", plan);
    const service = createLongRunningExecutionService({
      executions: executionsProcess.proxy as ExecutionService,
      store: storeProcess.proxy,
      resumePolicyReadmission: admissions.policy,
      resourceReadmission: admissions.resource,
      budgetAuthority: budgets.impl as BudgetAuthority,
      digest: sha256,
      generateId,
      now,
    });
    return {
      service,
      crashed: () => executionsProcess.crashed() || storeProcess.crashed(),
    };
  };

  return {
    executionStore,
    store,
    admissions,
    budgets,
    advance,
    driveToRunning,
    boot,
    executionId: "unseeded",
  };
}

const actor = { actorId: ACTOR_ID, tenantId: TENANT_ID };

/**
 * Run one operation in a DYING process: the armed crash point kills it
 * mid-flight (the promise's terminal state is irrelevant — the process is
 * gone; only the durable world matters).
 */
async function diesDuring(run: () => Promise<unknown>, crashed: () => boolean): Promise<void> {
  await run().then(
    () => undefined,
    () => undefined,
  );
  expect(crashed()).toBe(true);
}

const checkpointOf = (
  executionId: string,
  overrides: Partial<CheckpointContents> = {},
): CheckpointContents => ({
  executionId,
  planId: "plan-1",
  planRevision: 3,
  contextArtifactRefs: ["artifact:ctx/1"],
  lastEventPosition: 5,
  resourceClass: "standard",
  environmentId: null,
  environmentSpecDigest: null,
  requiredCapabilities: ["cap-a"],
  maxCostMicroUsd: null,
  ...overrides,
});

const factsOf = (contents: CheckpointContents): ResumeFacts => ({
  planId: contents.planId,
  planRevision: contents.planRevision,
  resourceClass: contents.resourceClass,
  environmentId: contents.environmentId,
  environmentSpecDigest: contents.environmentSpecDigest,
  requiredCapabilities: contents.requiredCapabilities,
  maxCostMicroUsd: contents.maxCostMicroUsd,
});

async function acquire(world: World, service: LongRunningExecutionService, executionId: string) {
  return service.acquireLease(
    { applicationId: APPLICATION_ID, executionId, actor, ownerId: "worker-1", ttlMs: 60_000 },
    `lease-${executionId}`,
  );
}

/** The durable checkpoints of one execution (surviving world). */
const checkpointsOf = (world: World, executionId: string) =>
  [...world.store.checkpoints.values()].filter((row) => row.executionId === executionId);

/** The ledger evidence events of one command (surviving world). */
const eventsOf = (world: World, command: string) =>
  world.executionStore.events.filter((event) => event.command === command);

/** The operation row of one stable key (surviving world). */
const operationOf = (
  world: World,
  kind: LongRunningOperationKind,
  discriminator: string,
) => {
  const key = longRunningOperationKey(kind, discriminator);
  return world.store.operations.get(`${APPLICATION_ID}|${key}`);
};

describe("crash-injection proofs: durable operation state + stable keys (WORK-028)", () => {
  // ---- CHECKPOINT COMMIT ---------------------------------------------------

  test("C1: crash AFTER the durable operation claim — the retry commits exactly one checkpoint; the attempts ledger is honest", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const dying = world.boot({ target: "store", method: "beginOperation", when: "after" });
    // Setup runs in its OWN process (the crash point must fire inside the
    // operation under test, not during setup).
    await acquire(world, world.boot(null).service, executionId);
    await diesDuring(
      () =>
        dying.service.recordCheckpoint(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            worker: { ownerId: "worker-1", epoch: 1 },
            contents: checkpointOf(executionId),
          },
          `ck-${executionId}`,
        ),
      dying.crashed,
    );
    // The claim committed; nothing else did.
    expect(operationOf(world, "checkpoint", `${executionId}:ck-${executionId}`)).toMatchObject({
      status: "pending",
      attempts: 1,
      stage: null,
    });
    expect(checkpointsOf(world, executionId)).toHaveLength(0);
    // RESTART: the same logical checkpoint completes with exactly one row.
    const restarted = world.boot(null);
    const outcome = await restarted.service.recordCheckpoint(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        contents: checkpointOf(executionId),
      },
      `ck-${executionId}`,
    );
    expect(outcome.replayed).toBe(false);
    expect(checkpointsOf(world, executionId)).toHaveLength(1);
    expect(eventsOf(world, "checkpoint-recorded")).toHaveLength(1);
    expect(operationOf(world, "checkpoint", `${executionId}:ck-${executionId}`)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("C2: crash AFTER the durable checkpoint insert (before the stage write) — the committed-effect probe converges the recovery WITHOUT a second row and WITHOUT the lease guard (the lease EXPIRED during the crash window)", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const dying = world.boot({ target: "store", method: "insertCheckpoint", when: "after" });
    await acquire(world, dying.service, executionId);
    await diesDuring(
      () =>
        dying.service.recordCheckpoint(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            worker: { ownerId: "worker-1", epoch: 1 },
            contents: checkpointOf(executionId),
          },
          `ck-${executionId}`,
        ),
      dying.crashed,
    );
    // The checkpoint side effect is durable; the operation row is the
    // honest PENDING claim.
    expect(checkpointsOf(world, executionId)).toHaveLength(1);
    expect(operationOf(world, "checkpoint", `${executionId}:ck-${executionId}`)).toMatchObject({
      status: "pending",
    });
    // The crash window spans the lease lifetime: the worker's lease EXPIRES
    // while the process is dead. The committed effect must still converge
    // (a stale worker never COMMITS a new effect — an already-committed
    // effect is converged, never duplicated, never blocked).
    world.advance(120_000);
    const restarted = world.boot(null);
    const outcome = await restarted.service.recordCheckpoint(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        // The stale worker's guard would fail EXPIRED — the digest probe
        // must converge before the guard.
        worker: { ownerId: "worker-1", epoch: 1 },
        contents: checkpointOf(executionId),
      },
      `ck-${executionId}`,
    );
    expect(outcome.checkpointSequence).toBe(1);
    expect(checkpointsOf(world, executionId)).toHaveLength(1); // EXACTLY ONE row
    expect(eventsOf(world, "checkpoint-recorded")).toHaveLength(1);
    expect(operationOf(world, "checkpoint", `${executionId}:ck-${executionId}`)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("C3: crash AFTER the checkpoint-committed stage — the recovery re-runs the evidence tail and completes", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const dying = world.boot({ target: "store", method: "recordOperationStage", when: "after" });
    await acquire(world, world.boot(null).service, executionId);
    await diesDuring(
      () =>
        dying.service.recordCheckpoint(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            worker: { ownerId: "worker-1", epoch: 1 },
            contents: checkpointOf(executionId),
          },
          `ck-${executionId}`,
        ),
      dying.crashed,
    );
    expect(checkpointsOf(world, executionId)).toHaveLength(1);
    expect(operationOf(world, "checkpoint", `${executionId}:ck-${executionId}`)).toMatchObject({
      status: "pending",
      stage: { stage: "checkpoint-committed" },
    });
    const restarted = world.boot(null);
    await restarted.service.recordCheckpoint(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        contents: checkpointOf(executionId),
      },
      `ck-${executionId}`,
    );
    expect(checkpointsOf(world, executionId)).toHaveLength(1);
    expect(eventsOf(world, "checkpoint-recorded")).toHaveLength(1);
    expect(operationOf(world, "checkpoint", `${executionId}:ck-${executionId}`)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("C4: crash AFTER the ledger evidence (before the completion) — the stable per-sequence evidence key replays; the marker row converges", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const dying = world.boot({ target: "executions", method: "recordStepEvent", when: "after" });
    await acquire(world, dying.service, executionId);
    await diesDuring(
      () =>
        dying.service.recordCheckpoint(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            worker: { ownerId: "worker-1", epoch: 1 },
            contents: checkpointOf(executionId),
          },
          `ck-${executionId}`,
        ),
      dying.crashed,
    );
    // The evidence committed on the canonical ledger; the operation did not.
    expect(eventsOf(world, "checkpoint-recorded")).toHaveLength(1);
    expect(operationOf(world, "checkpoint", `${executionId}:ck-${executionId}`)).toMatchObject({
      status: "pending",
    });
    const restarted = world.boot(null);
    const outcome = await restarted.service.recordCheckpoint(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        contents: checkpointOf(executionId),
      },
      `ck-${executionId}`,
    );
    expect(outcome.replayed).toBe(false);
    expect(eventsOf(world, "checkpoint-recorded")).toHaveLength(1); // ONE event, key-converged
    expect(checkpointsOf(world, executionId)).toHaveLength(1);
    expect(operationOf(world, "checkpoint", `${executionId}:ck-${executionId}`)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  // ---- PAUSE ---------------------------------------------------------------

  test("C5: pause crash AFTER the checkpoint insert (before the frozen wait transition) — the retry converges to WAITING_TOOL with exactly one checkpoint, one wake-up and one released lease", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const dying = world.boot({ target: "store", method: "insertCheckpoint", when: "after" });
    await acquire(world, dying.service, executionId);
    await diesDuring(
      () =>
        dying.service.pauseExecution(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            worker: { ownerId: "worker-1", epoch: 1 },
            waitKind: "tool",
            checkpoint: checkpointOf(executionId),
            wakeUp: {
              wakeKey: "tool-return",
              cause: "awaiting tool result",
              earliestWakeAt: new Date(Date.parse("2026-09-15T12:01:00Z")).toISOString(),
            },
          },
          `pause-${executionId}`,
        ),
      dying.crashed,
    );
    expect(checkpointsOf(world, executionId)).toHaveLength(1);
    // RESTART: the full pause converges.
    const restarted = world.boot(null);
    const outcome = await restarted.service.pauseExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        waitKind: "tool",
        checkpoint: checkpointOf(executionId),
        wakeUp: {
          wakeKey: "tool-return",
          cause: "awaiting tool result",
          earliestWakeAt: new Date(Date.parse("2026-09-15T12:01:00Z")).toISOString(),
        },
      },
      `pause-${executionId}`,
    );
    expect(outcome.status).toBe("WAITING_TOOL");
    expect(outcome.replayed).toBe(false);
    expect(checkpointsOf(world, executionId)).toHaveLength(1);
    expect(eventsOf(world, "checkpoint-recorded")).toHaveLength(1);
    expect(eventsOf(world, "wake-up-scheduled")).toHaveLength(1);
    expect(world.store.leases.get(executionId)?.releaseCause).toBe("paused");
    expect(operationOf(world, "pause", `${executionId}:pause-${executionId}`)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("C6: pause crash AFTER the frozen wait transition (before the wake-up) — the transition replay converges; the wake-up is scheduled exactly once", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const dying = world.boot({ target: "executions", method: "transition", when: "after" });
    await acquire(world, dying.service, executionId);
    await diesDuring(
      () =>
        dying.service.pauseExecution(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            worker: { ownerId: "worker-1", epoch: 1 },
            waitKind: "user",
            checkpoint: checkpointOf(executionId),
          },
          `pause-${executionId}`,
        ),
      dying.crashed,
    );
    // The frozen wait-user move committed; the tail did not.
    const status = () => world.executionStore.executions.get(executionId)?.status;
    expect(status()).toBe("WAITING_USER");
    expect(world.store.leases.get(executionId)?.releasedAt ?? null).toBeNull();
    const restarted = world.boot(null);
    const outcome = await restarted.service.pauseExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        waitKind: "user",
        checkpoint: checkpointOf(executionId),
      },
      `pause-${executionId}`,
    );
    expect(outcome.status).toBe("WAITING_USER");
    expect(world.store.leases.get(executionId)?.releaseCause).toBe("paused");
    // Exactly one wait-user envelope exists (the transition replayed by key).
    const waitEvents = world.executionStore.events.filter(
      (event) => event.command === "wait-user",
    );
    expect(waitEvents).toHaveLength(1);
    expect(operationOf(world, "pause", `${executionId}:pause-${executionId}`)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  // ---- RESUME --------------------------------------------------------------

  test("C7: resume crash AFTER the operation claim — the retry resumes the SAME identity; no second resume effect", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const setup = world.boot(null);
    await acquire(world, setup.service, executionId);
    await setup.service.pauseExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        waitKind: "tool",
        checkpoint: checkpointOf(executionId),
      },
      `pause-${executionId}`,
    );
    const dying = world.boot({ target: "store", method: "beginOperation", when: "after" });
    await diesDuring(
      () =>
        dying.service.resumeExecution(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            resumeFacts: factsOf(checkpointOf(executionId)),
          },
          `resume-${executionId}`,
        ),
      dying.crashed,
    );
    expect(operationOf(world, "resume", `${executionId}:resume-${executionId}`)).toMatchObject({
      status: "pending",
      attempts: 1,
    });
    const restarted = world.boot(null);
    const outcome = await restarted.service.resumeExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        resumeFacts: factsOf(checkpointOf(executionId)),
      },
      `resume-${executionId}`,
    );
    expect(outcome.executionId).toBe(executionId); // the identity invariant
    expect(outcome.status).toBe("RUNNING");
    expect(outcome.readmitted).toBe(false);
    expect(operationOf(world, "resume", `${executionId}:resume-${executionId}`)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("C8: resume crash AFTER the lease acquisition — the same-owner convergence keeps epoch 1 (no epoch inflation across the crash-resume)", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const setup = world.boot(null);
    await acquire(world, setup.service, executionId);
    await setup.service.pauseExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        waitKind: "tool",
        checkpoint: checkpointOf(executionId),
      },
      `pause-${executionId}`,
    );
    const dying = world.boot({ target: "store", method: "acquireLease", when: "after" });
    await diesDuring(
      () =>
        dying.service.resumeExecution(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            resumeFacts: factsOf(checkpointOf(executionId)),
            worker: { ownerId: "worker-2", ttlMs: 60_000 },
          },
          `resume-${executionId}`,
        ),
      dying.crashed,
    );
    // The lease moved to worker-2 at epoch 2 (the paused release ended
    // epoch 1); the resume tail did not run.
    expect(world.store.leases.get(executionId)).toMatchObject({
      ownerId: "worker-2",
      epoch: 2,
      releasedAt: null,
    });
    const restarted = world.boot(null);
    const outcome = await restarted.service.resumeExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        resumeFacts: factsOf(checkpointOf(executionId)),
        worker: { ownerId: "worker-2", ttlMs: 60_000 },
      },
      `resume-${executionId}`,
    );
    expect(outcome.status).toBe("RUNNING");
    expect(outcome.lease).toMatchObject({ ownerId: "worker-2", epoch: 2 }); // NOT 3
    expect(operationOf(world, "resume", `${executionId}:resume-${executionId}`)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("C9: resume crash AFTER the frozen resume transition (before the stage write) — the recovery evidence path converges; the identity is unchanged", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const setup = world.boot(null);
    await acquire(world, setup.service, executionId);
    await setup.service.pauseExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        waitKind: "tool",
        checkpoint: checkpointOf(executionId),
      },
      `pause-${executionId}`,
    );
    const dying = world.boot({ target: "executions", method: "transition", when: "after" });
    await diesDuring(
      () =>
        dying.service.resumeExecution(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            resumeFacts: factsOf(checkpointOf(executionId)),
          },
          `resume-${executionId}`,
        ),
      dying.crashed,
    );
    // The frozen resume move committed (RUNNING); the operation row is the
    // honest PENDING claim.
    expect(world.executionStore.executions.get(executionId)?.status).toBe("RUNNING");
    expect(operationOf(world, "resume", `${executionId}:resume-${executionId}`)).toMatchObject({
      status: "pending",
    });
    const restarted = world.boot(null);
    const outcome = await restarted.service.resumeExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        resumeFacts: factsOf(checkpointOf(executionId)),
      },
      `resume-${executionId}`,
    );
    expect(outcome.executionId).toBe(executionId);
    expect(outcome.status).toBe("RUNNING");
    // The recovery resume is journaled exactly once (resume-recorded).
    expect(eventsOf(world, "resume-recorded")).toHaveLength(1);
    expect(operationOf(world, "resume", `${executionId}:resume-${executionId}`)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("C10: materially changed resume crash AFTER the re-admission (before the transition) — the retry re-enters the CURRENT authority and completes", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const setup = world.boot(null);
    await acquire(world, setup.service, executionId);
    await setup.service.pauseExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        waitKind: "tool",
        checkpoint: checkpointOf(executionId),
      },
      `pause-${executionId}`,
    );
    // The materially changed resume: the cost bound moves (a material
    // change on maxCostMicroUsd — the budget axis). Crash BEFORE the
    // resume transition, AFTER the re-admission seam ran.
    const dying = world.boot({ target: "executions", method: "transition", when: "before" });
    await diesDuring(
      () =>
        dying.service.resumeExecution(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            resumeFacts: factsOf(checkpointOf(executionId, { maxCostMicroUsd: "500000" })),
          },
          `resume-${executionId}`,
        ),
      dying.crashed,
    );
    // The admission seam ran once (the authority consultation is not a
    // side effect — a crash before the transition re-consults).
    expect(world.admissions.policyCalls).toHaveLength(1);
    expect(world.budgets.reserveCalls).toHaveLength(1);
    expect(operationOf(world, "resume", `${executionId}:resume-${executionId}`)).toMatchObject({
      status: "pending",
    });
    const restarted = world.boot(null);
    const outcome = await restarted.service.resumeExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        resumeFacts: factsOf(checkpointOf(executionId, { maxCostMicroUsd: "500000" })),
      },
      `resume-${executionId}`,
    );
    expect(outcome.status).toBe("RUNNING");
    expect(outcome.readmitted).toBe(true);
    expect(outcome.materialChange).toContain("maxCostMicroUsd");
    // Re-admission re-entered (2 consultations); ONE reservation per
    // operation key (the budget seam is key-convergent) and one transition.
    expect(world.admissions.policyCalls).toHaveLength(2);
    expect(world.budgets.reserveCalls).toHaveLength(2);
    expect(
      new Set(world.budgets.reserveCalls.map((call) => String(call.operationId))).size,
    ).toBe(1);
    expect(operationOf(world, "resume", `${executionId}:resume-${executionId}`)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("C11: a durably FAILED resume (a journaled re-admission denial) replays typed — the denial is never re-derived nor re-consulted", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const setup = world.boot(null);
    await acquire(world, setup.service, executionId);
    await setup.service.pauseExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        waitKind: "tool",
        checkpoint: checkpointOf(executionId),
      },
      `pause-${executionId}`,
    );
    // First materially changed resume: the policy authority DENIES.
    world.admissions.denyPolicy = true;
    const command: ResumeExecutionCommand = {
      applicationId: APPLICATION_ID,
      executionId,
      actor,
      resumeFacts: factsOf(checkpointOf(executionId, { resourceClass: "gpu" })),
    };
    await expect(setup.service.resumeExecution(command, `resume-${executionId}`)).rejects.toMatchObject(
      { code: "POLICY_DENIED" },
    );
    expect(world.admissions.policyCalls).toHaveLength(1);
    expect(eventsOf(world, "resume-denied")).toHaveLength(1); // journaled denial
    expect(operationOf(world, "resume", `${executionId}:resume-${executionId}`)).toMatchObject({
      status: "failed",
    });
    // RESTART (the authority even flips to allow): the durable denial
    // replays typed — the decision is already an outcome, not a re-derivation.
    const restarted = world.boot(null);
    world.admissions.denyPolicy = false;
    await expect(
      restarted.service.resumeExecution(command, `resume-${executionId}`),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(world.admissions.policyCalls).toHaveLength(1); // never re-consulted
    expect(eventsOf(world, "resume-denied")).toHaveLength(1); // never re-journaled
    expect(world.executionStore.executions.get(executionId)?.status).toBe("WAITING_TOOL");
  });

  // ---- HUMAN INTERRUPTION --------------------------------------------------

  test("C12: interruption crash AFTER the journal-then-act evidence — the retry completes the interruption; the request evidence exists exactly once", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const setup = world.boot(null);
    await acquire(world, setup.service, executionId);
    const dying = world.boot({ target: "executions", method: "recordStepEvent", when: "after" });
    await diesDuring(
      () =>
        dying.service.requestInterruption(
          { applicationId: APPLICATION_ID, executionId, actor, reason: "operator halt" },
          `interrupt-${executionId}`,
        ),
      dying.crashed,
    );
    // The durable request committed BEFORE the pause move (journal-then-act);
    // the stage write had not run yet (crash between evidence and stage).
    expect(eventsOf(world, "interruption-requested")).toHaveLength(1);
    expect(operationOf(world, "interrupt", `${executionId}:interrupt-${executionId}`)).toMatchObject(
      {
        status: "pending",
        stage: null,
      },
    );
    const restarted = world.boot(null);
    const outcome = await restarted.service.requestInterruption(
      { applicationId: APPLICATION_ID, executionId, actor, reason: "operator halt" },
      `interrupt-${executionId}`,
    );
    expect(outcome.status).toBe("WAITING_HUMAN");
    expect(outcome.leaseReleased).toBe(true);
    expect(eventsOf(world, "interruption-requested")).toHaveLength(1); // ONE request
    expect(operationOf(world, "interrupt", `${executionId}:interrupt-${executionId}`)).toMatchObject(
      {
        status: "completed",
        attempts: 2,
      },
    );
  });

  test("C13: interruption crash AFTER the wake supersede / lease force-release — the retry converges to WAITING_HUMAN; the wake never fires afterwards", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const setup = world.boot(null);
    await acquire(world, setup.service, executionId);
    await setup.service.pauseExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        waitKind: "tool",
        checkpoint: checkpointOf(executionId),
        wakeUp: {
          wakeKey: "tool-return",
          cause: "awaiting tool result",
          earliestWakeAt: new Date(Date.parse("2026-09-15T12:00:01Z")).toISOString(),
        },
      },
      `pause-${executionId}`,
    );
    // Re-acquire as a new worker epoch (the interruption must supersede a
    // LIVE foreign lease — human authority trumps worker ownership).
    const reawake = world.boot(null);
    await reawake.service.acquireLease(
      { applicationId: APPLICATION_ID, executionId, actor, ownerId: "worker-2", ttlMs: 60_000 },
      `lease2-${executionId}`,
    );
    const dying = world.boot({ target: "store", method: "markWakeUpsSuperseded", when: "after" });
    await diesDuring(
      () =>
        dying.service.requestInterruption(
          { applicationId: APPLICATION_ID, executionId, actor, reason: "operator halt" },
          `interrupt-${executionId}`,
        ),
      dying.crashed,
    );
    // The scheduled wake is superseded durably (human authority revoked
    // auto-resume FIRST); the crash hit before the force-release/wait move.
    expect(world.store.wakeUps.get(`${APPLICATION_ID}|${executionId}|tool-return`)).toMatchObject({
      status: "superseded",
    });
    const restarted = world.boot(null);
    const outcome = await restarted.service.requestInterruption(
      { applicationId: APPLICATION_ID, executionId, actor, reason: "operator halt" },
      `interrupt-${executionId}`,
    );
    // An already-waiting execution stays in its frozen wait state (the
    // frozen machine only moves RUNNING -> WAITING_HUMAN); the durable
    // interruption request IS the interruption record, and the human
    // authority is enforced: wakes superseded, lease force-released.
    expect(outcome.status).toBe("WAITING_TOOL");
    expect(outcome.leaseReleased).toBe(true);
    expect(world.store.leases.get(executionId)?.releaseCause).toBe("human-interruption");
    // The superseded wake NEVER fires: the due scan finds nothing.
    world.advance(120_000);
    const woke = world.boot(null);
    const applied = await woke.service.applyWakeUps({ applicationId: APPLICATION_ID, actor });
    expect(applied.applications).toHaveLength(0);
    expect(world.executionStore.executions.get(executionId)?.status).toBe("WAITING_TOOL");
  });

  // ---- GOVERNED TERMINATION --------------------------------------------------

  test("C14: termination crash AFTER the frozen cancel transition — the recovery converges the operation (the terminal move committed during the operation); no orphaned PENDING claim", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const setup = world.boot(null);
    await acquire(world, setup.service, executionId);
    const dying = world.boot({ target: "executions", method: "transition", when: "after" });
    await diesDuring(
      () =>
        dying.service.terminateExecution(
          { applicationId: APPLICATION_ID, executionId, actor, reason: "governed shutdown" },
          `terminate-${executionId}`,
        ),
      dying.crashed,
    );
    // The frozen cancel move committed (CANCELLED); the operation row is
    // the honest PENDING claim — the [cancel, stage] crash window.
    expect(world.executionStore.executions.get(executionId)?.status).toBe("CANCELLED");
    expect(operationOf(world, "terminate", `${executionId}:terminate-${executionId}`)).toMatchObject(
      {
        status: "pending",
      },
    );
    // RESTART: the retry MUST converge (terminal states are final — the
    // committed terminal move IS the outcome; a fresh terminate claim on a
    // terminal execution still fails closed, but the crash-resume of THIS
    // operation completes it honestly).
    const restarted = world.boot(null);
    const outcome = await restarted.service.terminateExecution(
      { applicationId: APPLICATION_ID, executionId, actor, reason: "governed shutdown" },
      `terminate-${executionId}`,
    );
    expect(outcome.status).toBe("CANCELLED");
    expect(outcome.leaseReleased).toBe(true);
    expect(operationOf(world, "terminate", `${executionId}:terminate-${executionId}`)).toMatchObject(
      {
        status: "completed",
        attempts: 2,
      },
    );
    // Exactly one cancel envelope (the transition replayed by key).
    const cancelEvents = world.executionStore.events.filter(
      (event) => event.command === "cancel",
    );
    expect(cancelEvents).toHaveLength(1);
  });

  // ---- WAKE-UPS --------------------------------------------------------------

  test("C15: wake-up scheduling crash AFTER the durable insert — the wake-key convergence completes the schedule; the evidence exists once", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const setup = world.boot(null);
    await acquire(world, setup.service, executionId);
    const dying = world.boot({ target: "store", method: "insertWakeUp", when: "after" });
    await diesDuring(
      () =>
        dying.service.scheduleWakeUp(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            wakeKey: "retry-backoff",
            cause: "backoff retry",
            earliestWakeAt: new Date(Date.parse("2026-09-15T12:00:30Z")).toISOString(),
          },
          `sched-${executionId}`,
        ),
      dying.crashed,
    );
    expect(world.store.wakeUps.get(`${APPLICATION_ID}|${executionId}|retry-backoff`)).toMatchObject({
      status: "scheduled",
    });
    expect(operationOf(world, "wakeup-schedule", `${executionId}:sched-${executionId}`)).toMatchObject(
      { status: "pending" },
    );
    const restarted = world.boot(null);
    const outcome = await restarted.service.scheduleWakeUp(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        wakeKey: "retry-backoff",
        cause: "backoff retry",
        earliestWakeAt: new Date(Date.parse("2026-09-15T12:00:30Z")).toISOString(),
      },
      `sched-${executionId}`,
    );
    expect(outcome.status).toBe("scheduled");
    expect([...world.store.wakeUps.values()].filter((row) => row.wakeKey === "retry-backoff")).toHaveLength(1);
    expect(eventsOf(world, "wake-up-scheduled")).toHaveLength(1);
    expect(operationOf(world, "wakeup-schedule", `${executionId}:sched-${executionId}`)).toMatchObject(
      { status: "completed", attempts: 2 },
    );
  });

  test("C16: wakeup-apply crash AFTER the 'claimed' stage (before the resume) — the recovery scan converges the PENDING claim; exactly one resume", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const setup = world.boot(null);
    await acquire(world, setup.service, executionId);
    await setup.service.pauseExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        waitKind: "tool",
        checkpoint: checkpointOf(executionId),
        wakeUp: {
          wakeKey: "tool-return",
          cause: "awaiting tool result",
          earliestWakeAt: new Date(Date.parse("2026-09-15T12:00:01Z")).toISOString(),
        },
      },
      `pause-${executionId}`,
    );
    // The wake is now due; a process claims it (stage 'claimed') and dies
    // BEFORE the resume.
    world.advance(2_000);
    const dying = world.boot({ target: "store", method: "recordOperationStage", when: "after" });
    await diesDuring(
      () => dying.service.applyWakeUps({ applicationId: APPLICATION_ID, actor }),
      dying.crashed,
    );
    const claimed = operationOf(world, "wakeup-apply", `${executionId}:wake:tool-return`);
    expect(claimed).toMatchObject({ status: "pending", stage: { stage: "claimed" } });
    expect(world.executionStore.executions.get(executionId)?.status).toBe("WAITING_TOOL");
    // RESTART: the recovery scan (pendingWakeUpApplies) converges the
    // orphaned claim — the wake applies exactly once.
    const restarted = world.boot(null);
    const outcome = await restarted.service.applyWakeUps({ applicationId: APPLICATION_ID, actor });
    expect(outcome.applications).toEqual([
      { action: "resumed", wakeKey: "tool-return", executionId },
    ]);
    expect(world.executionStore.executions.get(executionId)?.status).toBe("RUNNING");
    expect(world.store.wakeUps.get(`${APPLICATION_ID}|${executionId}|tool-return`)).toMatchObject({
      status: "applied",
    });
    expect(operationOf(world, "wakeup-apply", `${executionId}:wake:tool-return`)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
    // The resume operation row for the wake key converged too (no orphan).
    expect(operationOf(world, "resume", `${executionId}:wake:tool-return`)).toMatchObject({
      status: "completed",
    });
  });

  test("C17: wakeup-apply crash AFTER the applied marker (before the evidence/complete) — the recovery scan converges; the marker is write-once", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const setup = world.boot(null);
    await acquire(world, setup.service, executionId);
    await setup.service.pauseExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        waitKind: "tool",
        checkpoint: checkpointOf(executionId),
        wakeUp: {
          wakeKey: "tool-return",
          cause: "awaiting tool result",
          earliestWakeAt: new Date(Date.parse("2026-09-15T12:00:01Z")).toISOString(),
        },
      },
      `pause-${executionId}`,
    );
    // The resume committed AND the wake marker moved to applied; the crash
    // hit before the evidence + completion.
    world.advance(2_000);
    const dying = world.boot({ target: "store", method: "markWakeUpApplied", when: "after" });
    await diesDuring(
      () => dying.service.applyWakeUps({ applicationId: APPLICATION_ID, actor }),
      dying.crashed,
    );
    expect(world.store.wakeUps.get(`${APPLICATION_ID}|${executionId}|tool-return`)).toMatchObject({
      status: "applied",
    });
    expect(operationOf(world, "wakeup-apply", `${executionId}:wake:tool-return`)).toMatchObject({
      status: "pending",
    });
    // RESTART: the recovery scan finds the applied marker, converges the
    // provenance tail and completes.
    const restarted = world.boot(null);
    const outcome = await restarted.service.applyWakeUps({ applicationId: APPLICATION_ID, actor });
    expect(outcome.applications).toEqual([
      { action: "replayed", wakeKey: "tool-return", executionId },
    ]);
    expect(operationOf(world, "wakeup-apply", `${executionId}:wake:tool-return`)).toMatchObject({
      status: "completed",
      attempts: 1, // the second process never re-claimed (recovery scan)
    });
    expect(eventsOf(world, "wake-up-applied")).toHaveLength(1);
    // The wake never re-applies: the status machine is write-once.
    const again = world.boot(null);
    const repeat = await again.service.applyWakeUps({ applicationId: APPLICATION_ID, actor });
    expect(repeat.applications).toHaveLength(0);
    expect(eventsOf(world, "wake-up-applied")).toHaveLength(1);
  });

  test("C18: wakeup-apply crash AFTER the resume (before the wake marker) — the recovery converges BOTH the wake and the orphaned PENDING resume row; zero duplicate side effects", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const setup = world.boot(null);
    await acquire(world, setup.service, executionId);
    await setup.service.pauseExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        waitKind: "tool",
        checkpoint: checkpointOf(executionId),
        wakeUp: {
          wakeKey: "tool-return",
          cause: "awaiting tool result",
          earliestWakeAt: new Date(Date.parse("2026-09-15T12:00:01Z")).toISOString(),
        },
      },
      `pause-${executionId}`,
    );
    // Crash AFTER the resume transition inside applyWakeUps, BEFORE the
    // wake application marker: the execution is RUNNING, the wake is still
    // scheduled, BOTH operation rows are honest PENDING claims.
    world.advance(2_000);
    const dying = world.boot({ target: "executions", method: "transition", when: "after" });
    await diesDuring(
      () => dying.service.applyWakeUps({ applicationId: APPLICATION_ID, actor }),
      dying.crashed,
    );
    expect(world.executionStore.executions.get(executionId)?.status).toBe("RUNNING");
    expect(world.store.wakeUps.get(`${APPLICATION_ID}|${executionId}|tool-return`)).toMatchObject({
      status: "scheduled",
    });
    expect(operationOf(world, "wakeup-apply", `${executionId}:wake:tool-return`)).toMatchObject({
      status: "pending",
    });
    expect(operationOf(world, "resume", `${executionId}:wake:tool-return`)).toMatchObject({
      status: "pending",
    });
    // RESTART: the recovery scan converges the wake AND the orphaned
    // resume row (the RUNNING status is the committed effect).
    const restarted = world.boot(null);
    const outcome = await restarted.service.applyWakeUps({ applicationId: APPLICATION_ID, actor });
    expect(outcome.applications).toEqual([
      { action: "already-running", wakeKey: "tool-return", executionId },
    ]);
    expect(world.store.wakeUps.get(`${APPLICATION_ID}|${executionId}|tool-return`)).toMatchObject({
      status: "applied",
    });
    expect(operationOf(world, "wakeup-apply", `${executionId}:wake:tool-return`)).toMatchObject({
      status: "completed",
    });
    // THE ORPHAN CONVERGENCE: the resume operation row for the wake key is
    // completed through the recovery-evidence path — exactly one
    // resume-recorded evidence, zero duplicate transitions.
    expect(operationOf(world, "resume", `${executionId}:wake:tool-return`)).toMatchObject({
      status: "completed",
    });
    expect(eventsOf(world, "resume-recorded")).toHaveLength(1);
    const resumeEvents = world.executionStore.events.filter((event) => event.command === "resume");
    expect(resumeEvents).toHaveLength(1); // one frozen resume transition, total
  });

  // ---- LEASES ----------------------------------------------------------------

  test("C19: lease-acquire crash AFTER the guarded insert — the same-owner convergence completes WITHOUT a second row or epoch inflation", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const dying = world.boot({ target: "store", method: "acquireLease", when: "after" });
    await diesDuring(
      () =>
        dying.service.acquireLease(
          { applicationId: APPLICATION_ID, executionId, actor, ownerId: "worker-1", ttlMs: 60_000 },
          `lease-${executionId}`,
        ),
      dying.crashed,
    );
    expect(world.store.leases.get(executionId)).toMatchObject({
      ownerId: "worker-1",
      epoch: 1,
      heartbeatCount: 0,
    });
    expect(operationOf(world, "lease-acquire", `${executionId}:lease-${executionId}`)).toMatchObject(
      { status: "pending" },
    );
    const restarted = world.boot(null);
    const outcome = await restarted.service.acquireLease(
      { applicationId: APPLICATION_ID, executionId, actor, ownerId: "worker-1", ttlMs: 60_000 },
      `lease-${executionId}`,
    );
    expect(outcome.lease).toMatchObject({ ownerId: "worker-1", epoch: 1 });
    expect(outcome.lease.heartbeatCount).toBe(0);
    expect(operationOf(world, "lease-acquire", `${executionId}:lease-${executionId}`)).toMatchObject(
      { status: "completed", attempts: 2 },
    );
    // A DIFFERENT owner while the lease is live: refused (fail closed).
    const other = world.boot(null);
    await expect(
      other.service.acquireLease(
        { applicationId: APPLICATION_ID, executionId, actor, ownerId: "worker-2", ttlMs: 60_000 },
        `lease2-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("C20: lease-renew crash AFTER the pre-renew stage (before the store renew) — the retry runs the heartbeat; exactly ONE bump per key", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const setup = world.boot(null);
    await acquire(world, setup.service, executionId);
    // Crash after the 'renewing' stage write, BEFORE store.renewLease.
    const dying = world.boot({ target: "executions", method: "transition", when: "before" });
    // (arm on a no-op point first; the store renew is the second stage target)
    const dying2 = world.boot({ target: "store", method: "renewLease", when: "before" });
    await diesDuring(
      () =>
        dying2.service.renewLease(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            worker: { ownerId: "worker-1", epoch: 1 },
            ttlMs: 60_000,
          },
          `renew-${executionId}`,
        ),
      dying2.crashed,
    );
    // The pre-state stage committed; the renew itself did NOT.
    expect(operationOf(world, "lease-renew", `${executionId}:renew-${executionId}`)).toMatchObject({
      status: "pending",
      stage: { stage: "renewing", heartbeatCountBefore: 0 },
    });
    expect(world.store.leases.get(executionId)?.heartbeatCount).toBe(0);
    void dying;
    // RESTART: the renew runs (the counter never advanced) — one heartbeat.
    const restarted = world.boot(null);
    const outcome = await restarted.service.renewLease(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        ttlMs: 60_000,
      },
      `renew-${executionId}`,
    );
    expect(outcome.replayed).toBe(false);
    expect(outcome.lease.heartbeatCount).toBe(1); // EXACTLY ONE bump
    expect(operationOf(world, "lease-renew", `${executionId}:renew-${executionId}`)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("C21: lease-renew crash AFTER the durable renew (before the 'renewed' stage) — the pre-state comparison converges; the heartbeat ledger advances EXACTLY ONCE", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const setup = world.boot(null);
    await acquire(world, setup.service, executionId);
    // Crash AFTER store.renewLease committed (the heartbeat advanced to 1).
    const dying = world.boot({ target: "store", method: "renewLease", when: "after" });
    await diesDuring(
      () =>
        dying.service.renewLease(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            worker: { ownerId: "worker-1", epoch: 1 },
            ttlMs: 60_000,
          },
          `renew-${executionId}`,
        ),
      dying.crashed,
    );
    expect(world.store.leases.get(executionId)?.heartbeatCount).toBe(1); // committed
    expect(operationOf(world, "lease-renew", `${executionId}:renew-${executionId}`)).toMatchObject({
      status: "pending",
      stage: { stage: "renewing", heartbeatCountBefore: 0 },
    });
    // RESTART: the counter moved past the recorded pre-state under the SAME
    // (owner, epoch) claim — the renew (or a successor heartbeat)
    // committed; the operation converges WITHOUT a second bump.
    const restarted = world.boot(null);
    const outcome = await restarted.service.renewLease(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        ttlMs: 60_000,
      },
      `renew-${executionId}`,
    );
    expect(outcome.replayed).toBe(true);
    expect(outcome.lease.heartbeatCount).toBe(1); // STILL exactly one
    expect(operationOf(world, "lease-renew", `${executionId}:renew-${executionId}`)).toMatchObject({
      status: "completed",
      attempts: 2, // the recovery re-claimed (the honest attempts ledger)
    });
  });

  test("C22: lease-release crash AFTER the durable release — the retry converges onto the released row; one-way release", async () => {
    const world = createWorld();
    const executionId = await world.driveToRunning();
    const setup = world.boot(null);
    await acquire(world, setup.service, executionId);
    const dying = world.boot({ target: "store", method: "releaseLease", when: "after" });
    await diesDuring(
      () =>
        dying.service.releaseLease(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            worker: { ownerId: "worker-1", epoch: 1 },
            cause: "worker-released",
          },
          `release-${executionId}`,
        ),
      dying.crashed,
    );
    expect(world.store.leases.get(executionId)?.releaseCause).toBe("worker-released");
    expect(operationOf(world, "lease-release", `${executionId}:release-${executionId}`)).toMatchObject(
      { status: "pending" },
    );
    const restarted = world.boot(null);
    const outcome = await restarted.service.releaseLease(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        cause: "worker-released",
      },
      `release-${executionId}`,
    );
    expect(outcome.lease).toMatchObject({ releaseCause: "worker-released" });
    expect(operationOf(world, "lease-release", `${executionId}:release-${executionId}`)).toMatchObject(
      { status: "completed", attempts: 2 },
    );
    // The released epoch cannot renew (stale workers never mutate the lease).
    const other = world.boot(null);
    await expect(
      other.service.renewLease(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor,
          worker: { ownerId: "worker-1", epoch: 1 },
          ttlMs: 60_000,
        },
        `renew2-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  // ---- KEY DISCIPLINE ---------------------------------------------------------

  test("C23: the operation keys are execution-scoped — the same idempotency key on two executions yields two independent durable claims", async () => {
    const world = createWorld();
    const first = await world.driveToRunning();
    const second = await world.driveToRunning();
    const process = world.boot(null);
    await process.service.acquireLease(
      { applicationId: APPLICATION_ID, executionId: first, actor, ownerId: "worker-1", ttlMs: 60_000 },
      "same-key",
    );
    await process.service.acquireLease(
      {
        applicationId: APPLICATION_ID,
        executionId: second,
        actor,
        ownerId: "worker-1",
        ttlMs: 60_000,
      },
      "same-key",
    );
    const rows = [...world.store.operations.values()].filter(
      (row) => row.executionId === first || row.executionId === second,
    );
    expect(rows).toHaveLength(2); // two DISTINCT claims, no collapse
    expect(new Set(rows.map((row) => row.executionId))).toEqual(new Set([first, second]));
    // Both leases exist independently (the lease is per-execution).
    expect(world.store.leases.get(first)?.ownerId).toBe("worker-1");
    expect(world.store.leases.get(second)?.ownerId).toBe("worker-1");
  });
});
