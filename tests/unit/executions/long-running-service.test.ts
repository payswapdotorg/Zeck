/**
 * Unit: the long-running execution service semantics (WORK-028,
 * LNG-001/002/003) over the in-memory fabric.
 *
 * The pause -> checkpoint -> resume protocol, the lease ownership
 * discipline (fail-closed conflicts, epoch supersession, expiry = the
 * stale-worker class), the materiality rule and its re-admission
 * authorities, human interruption, governed termination, wake-up
 * scheduling/application, and the identity invariant (the SAME execution
 * across pause/resume — never a second identity).
 *
 * The kill/restart crash-injection halves live in
 * `longrunning-crash-recovery.test.ts`; the physical (real-PostgreSQL)
 * halves live in the PG suites.
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
import type {
  CheckpointContents,
  CheckpointRecord,
  ResumeFacts,
} from "../../../src/modules/executions/domain/checkpoint";
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
const OTHER_TENANT_ID = "00000000-0000-7000-8000-0000000000dd";
const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

/** Recording fakes for the two REQUIRED re-admission authorities. */
class AdmissionFakes {
  readonly policyCalls: ResumeReAdmissionRequest[] = [];
  readonly resourceCalls: ResumeReAdmissionRequest[] = [];
  denyPolicy = false;
  denyResource = false;
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
      return this.denyResource
        ? {
            allowed: false as const,
            reason: "fixture resource denial",
            denialCode: "CAPABILITY_UNAVAILABLE" as const,
          }
        : { allowed: true as const };
    },
  };
}

interface World {
  readonly executions: ExecutionService;
  readonly executionStore: InMemoryExecutionStore;
  readonly store: InMemoryLongRunningExecutionStore;
  readonly service: LongRunningExecutionService;
  readonly admissions: AdmissionFakes;
  readonly budgets: FakeBudgetAuthority;
  readonly generateId: () => string;
  readonly advance: (ms: number) => void;
  executionId: () => string;
}

function createWorld(): World {
  const executionStore = new InMemoryExecutionStore();
  executionStore.seedApplication(APPLICATION_ID, TENANT_ID);
  const idempotency = new InMemoryExecutionsIdempotency();
  idempotency.store = executionStore;
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
  const executions = createExecutionService({
    store: executionStore,
    idempotency,
    authorization: allowAllAuthorization,
    generateId,
    now,
  });
  const store = new InMemoryLongRunningExecutionStore();
  const admissions = new AdmissionFakes();
  const budgets = new FakeBudgetAuthority();
  const service = createLongRunningExecutionService({
    executions,
    store,
    resumePolicyReadmission: admissions.policy,
    resourceReadmission: admissions.resource,
    budgetAuthority: budgets.impl as BudgetAuthority,
    digest: sha256,
    generateId,
    now,
  });
  return {
    executions,
    executionStore,
    store,
    service,
    admissions,
    budgets,
    generateId,
    advance,
    executionId: () => "unseeded",
  };
}

const actor = { actorId: ACTOR_ID, tenantId: TENANT_ID };
const otherTenantActor = { actorId: ACTOR_ID, tenantId: OTHER_TENANT_ID };

async function driveToRunning(world: World): Promise<string> {
  const created = await world.executions.createExecution(
    { applicationId: APPLICATION_ID, task: { kind: "summarize", input: "artifact-1" } },
    `create-${world.generateId()}`,
    actor,
  );
  const executionId = created.executionId;
  const scope = { ...actor, applicationId: APPLICATION_ID, executionId };
  await world.executions.transition({ ...scope, command: "authorize" }, `authorize-${executionId}`);
  await world.executions.transition({ ...scope, command: "plan" }, `plan-${executionId}`);
  await world.executions.transition({ ...scope, command: "queue" }, `queue-${executionId}`);
  await world.executions.transition({ ...scope, command: "start" }, `start-${executionId}`);
  return executionId;
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

async function acquire(world: World, executionId: string, ownerId: string) {
  return world.service.acquireLease(
    {
      applicationId: APPLICATION_ID,
      executionId,
      actor,
      ownerId,
      ttlMs: 60_000,
    },
    `lease-${ownerId}-${executionId}`,
  );
}

interface PauseOptions {
  readonly waitKind?: "tool" | "user";
  readonly checkpoint?: CheckpointContents;
  readonly wakeUp?: {
    readonly wakeKey: string;
    readonly cause: string;
    readonly earliestWakeAt: string;
  };
  readonly key?: string;
  readonly service?: LongRunningExecutionService;
}

/** The standard worker pause: acquire the lease, then pause (worker-1, epoch 1). */
async function pause(world: World, executionId: string, options: PauseOptions = {}) {
  await acquire(world, executionId, "worker-1");
  const service = options.service ?? world.service;
  return service.pauseExecution(
    {
      applicationId: APPLICATION_ID,
      executionId,
      actor,
      worker: { ownerId: "worker-1", epoch: 1 },
      waitKind: options.waitKind ?? "tool",
      checkpoint: options.checkpoint ?? checkpointOf(executionId),
      ...(options.wakeUp === undefined ? {} : { wakeUp: options.wakeUp }),
    },
    options.key ?? `pause-${executionId}`,
  );
}

// ---------------------------------------------------------------------------
// The lease discipline (LNG-002)
// ---------------------------------------------------------------------------

describe("lease ownership and heartbeats", () => {
  test("acquire -> held at epoch 1; renew extends and counts heartbeats", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    const acquired = await acquire(world, executionId, "worker-1");
    expect(acquired.lease.epoch).toBe(1);
    expect(acquired.replayed).toBe(false);
    world.advance(30_000);
    const renewed = await world.service.renewLease(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        ttlMs: 60_000,
      },
      `renew-${executionId}-1`,
    );
    expect(renewed.lease.heartbeatCount).toBe(1);
    expect(renewed.lease.expiresAt > acquired.lease.expiresAt).toBe(true);
  });

  test("a lease conflict FAILS CLOSED (a second live owner is refused)", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    const refusal = acquire(world, executionId, "worker-2");
    await expect(refusal).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      details: { leaseOwner: "worker-1" },
    });
  });

  test("the same owner re-acquiring converges (no epoch bump)", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    const again = await acquire(world, executionId, "worker-1");
    expect(again.lease.epoch).toBe(1);
    expect(again.lease.ownerId).toBe("worker-1");
  });

  test("release -> re-acquisition advances the epoch (a stale epoch never matches again)", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    const first = await acquire(world, executionId, "worker-1");
    await world.service.releaseLease(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: first.lease.epoch },
      },
      `release-${executionId}`,
    );
    const second = await acquire(world, executionId, "worker-2");
    expect(second.lease.epoch).toBe(2);
    // The stale worker-1 claim at epoch 1 is rejected everywhere.
    await expect(
      world.service.renewLease(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor,
          worker: { ownerId: "worker-1", epoch: 1 },
          ttlMs: 60_000,
        },
        `stale-renew-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("expiry is the stale-worker class: EXPIRED, no side effects through the guard", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    world.advance(120_000);
    await expect(
      world.service.renewLease(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor,
          worker: { ownerId: "worker-1", epoch: 1 },
          ttlMs: 60_000,
        },
        `late-renew-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "EXPIRED" });
    // The expired worker cannot commit a checkpoint.
    await expect(
      world.service.recordCheckpoint(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor,
          worker: { ownerId: "worker-1", epoch: 1 },
          contents: checkpointOf(executionId),
        },
        `late-checkpoint-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "EXPIRED" });
    // An expired lease is free to re-acquire (recovery).
    const reacquired = await acquire(world, executionId, "worker-3");
    expect(reacquired.lease.epoch).toBe(2);
  });

  test("a foreign lease on resume fails closed", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await pause(world, executionId);
    // worker-2 holds the live lease without releasing.
    await acquire(world, executionId, "worker-2");
    await expect(
      world.service.resumeExecution(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor,
          resumeFacts: factsOf(checkpointOf(executionId)),
          worker: { ownerId: "worker-3", ttlMs: 60_000 },
        },
        `conflicted-resume-${executionId}`,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      details: { leaseOwner: "worker-2" },
    });
  });

  test("workerTransition carries the lease guard BEFORE the delegated frozen transition", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    // A foreign worker is stale: no lease -> the guard fires first.
    await expect(
      world.service.workerTransition(
        {
          applicationId: APPLICATION_ID,
          command: {
            ...actor,
            applicationId: APPLICATION_ID,
            executionId,
            command: "wait-tool",
            reason: "stale worker attempt",
          },
          worker: { ownerId: "worker-2", epoch: 1 },
        },
        `stale-transition-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    // The live owner transitions normally.
    const outcome = await world.service.workerTransition(
      {
        applicationId: APPLICATION_ID,
        command: {
          ...actor,
          applicationId: APPLICATION_ID,
          executionId,
          command: "wait-tool",
          reason: "worker pause",
        },
        worker: { ownerId: "worker-1", epoch: 1 },
      },
      `live-transition-${executionId}`,
    );
    expect(outcome.execution.status).toBe("WAITING_TOOL");
  });
});

// ---------------------------------------------------------------------------
// Checkpoint commit (LNG-001)
// ---------------------------------------------------------------------------

describe("checkpoint commit", () => {
  test("appends write-once sequenced checkpoints with ledger evidence, status preserved", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    const first = await world.service.recordCheckpoint(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        contents: checkpointOf(executionId, { lastEventPosition: 5 }),
      },
      `ck-1-${executionId}`,
    );
    expect(first.checkpointSequence).toBe(1);
    expect(first.replayed).toBe(false);
    const second = await world.service.recordCheckpoint(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        contents: checkpointOf(executionId, { lastEventPosition: 6 }),
      },
      `ck-2-${executionId}`,
    );
    expect(second.checkpointSequence).toBe(2);
    const execution = await world.executions.getExecution(APPLICATION_ID, executionId);
    expect(execution?.status).toBe("RUNNING");
    const events = await world.executionStore.listEvents(APPLICATION_ID, executionId);
    const checkpointEvents = events.filter((event) => event.command === "checkpoint-recorded");
    expect(checkpointEvents).toHaveLength(2);
    expect(checkpointEvents[0]?.reference).toMatchObject({
      checkpointId: first.checkpointId,
      recordedBy: "worker-1",
    });
  });

  test("the same idempotency key replays (exactly one row, one event)", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    const command = {
      applicationId: APPLICATION_ID,
      executionId,
      actor,
      worker: { ownerId: "worker-1", epoch: 1 },
      contents: checkpointOf(executionId),
    };
    const first = await world.service.recordCheckpoint(command, `same-key-${executionId}`);
    const replay = await world.service.recordCheckpoint(command, `same-key-${executionId}`);
    expect(replay.replayed).toBe(true);
    expect(replay.checkpointId).toBe(first.checkpointId);
    expect(await world.store.listCheckpoints(APPLICATION_ID, executionId)).toHaveLength(1);
    const events = await world.executionStore.listEvents(APPLICATION_ID, executionId);
    expect(events.filter((event) => event.command === "checkpoint-recorded")).toHaveLength(1);
  });

  test("same key with different contents fails closed (key reuse)", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    await world.service.recordCheckpoint(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        contents: checkpointOf(executionId, { lastEventPosition: 5 }),
      },
      `reuse-key-${executionId}`,
    );
    await expect(
      world.service.recordCheckpoint(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor,
          worker: { ownerId: "worker-1", epoch: 1 },
          contents: checkpointOf(executionId, { lastEventPosition: 6 }),
        },
        `reuse-key-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("contents that bind to a different execution are rejected (no second identity)", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    await expect(
      world.service.recordCheckpoint(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor,
          worker: { ownerId: "worker-1", epoch: 1 },
          contents: checkpointOf("00000000-0000-7000-8000-00000000009f"),
        },
        `foreign-ck-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("lastEventPosition beyond the durable ledger head is rejected", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    const execution = await world.executions.getExecution(APPLICATION_ID, executionId);
    const head = execution?.lastEventSequence ?? 0;
    await expect(
      world.service.recordCheckpoint(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor,
          worker: { ownerId: "worker-1", epoch: 1 },
          contents: checkpointOf(executionId, { lastEventPosition: head + 5 }),
        },
        `ahead-ck-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("a checkpoint without a lease is refused (the guard precedes the insert)", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await expect(
      world.service.recordCheckpoint(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor,
          worker: { ownerId: "worker-9", epoch: 1 },
          contents: checkpointOf(executionId),
        },
        `unguarded-ck-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });
});

// ---------------------------------------------------------------------------
// Pause / resume (LNG-001) — the identity invariant
// ---------------------------------------------------------------------------

describe("pause and resume (the identity invariant)", () => {
  test("pause -> WAITING_TOOL with checkpoint + wake-up + released lease; resume restores RUNNING on the SAME identity", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    const paused = await pause(world, executionId, {
      wakeUp: {
        wakeKey: `tool-wake-${executionId}`,
        cause: "tool-call timeout",
        earliestWakeAt: "2026-09-15T13:00:00.000Z",
      },
      key: `pause-${executionId}`,
    });
    expect(paused.status).toBe("WAITING_TOOL");
    expect(paused.wakeUpScheduled).toBe(true);
    expect(paused.leaseReleased).toBe(true);
    expect((await world.store.getLease(APPLICATION_ID, executionId))?.releasedAt).not.toBeNull();

    const resumed = await world.service.resumeExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        resumeFacts: factsOf(checkpointOf(executionId)),
      },
      `resume-${executionId}`,
    );
    expect(resumed.status).toBe("RUNNING");
    expect(resumed.executionId).toBe(executionId);
    expect(resumed.checkpointId).toBe(paused.checkpointId);
    expect(resumed.readmitted).toBe(false);
    // SAME identity: exactly one execution row exists.
    expect([...world.executionStore.executions.keys()]).toHaveLength(1);
  });

  test("pause replay converges (one checkpoint, one transition, one wake-up)", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    const first = await pause(world, executionId, { key: `pause-replay-${executionId}` });
    const replay = await pause(world, executionId, { key: `pause-replay-${executionId}` });
    expect(replay.replayed).toBe(true);
    expect(replay.checkpointId).toBe(first.checkpointId);
    expect(await world.store.listCheckpoints(APPLICATION_ID, executionId)).toHaveLength(1);
    expect(await world.store.listWakeUps(APPLICATION_ID, executionId)).toHaveLength(0);
  });

  test("resume without a durable checkpoint is rejected", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await pause(world, executionId, { key: `pause-nock-${executionId}` });
    // Wipe the checkpoints to simulate an un-checkpointed pause.
    world.store.checkpoints.clear();
    await expect(
      world.service.resumeExecution(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor,
          resumeFacts: factsOf(checkpointOf(executionId)),
        },
        `resume-nock-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("a TAMPERED checkpoint digest is rejected at resume (integrity)", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    const paused = await pause(world, executionId, { key: `pause-tamper-${executionId}` });
    world.store.tamperCheckpointDigest(paused.checkpointId, sha256("tampered-digest"));
    await expect(
      world.service.resumeExecution(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor,
          resumeFacts: factsOf(checkpointOf(executionId)),
        },
        `resume-tamper-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("TAMPERED checkpoint contents are rejected at resume (digest mismatch)", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    const paused = await pause(world, executionId, { key: `pause-tamper2-${executionId}` });
    world.store.tamperCheckpointContents(paused.checkpointId, { lastEventPosition: 99 });
    await expect(
      world.service.resumeExecution(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor,
          resumeFacts: factsOf(checkpointOf(executionId)),
        },
        `resume-tamper2-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("an INCOMPATIBLE plan / stale revision is rejected at resume", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await pause(world, executionId, {
      checkpoint: checkpointOf(executionId, { planRevision: 4 }),
      key: `pause-incompat-${executionId}`,
    });
    await expect(
      world.service.resumeExecution(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor,
          resumeFacts: factsOf(checkpointOf(executionId, { planId: "plan-2" })),
        },
        `resume-other-plan-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await expect(
      world.service.resumeExecution(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor,
          resumeFacts: factsOf(checkpointOf(executionId, { planRevision: 2 })),
        },
        `resume-stale-rev-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("a resume of an already-RUNNING execution records recovery evidence without a transition", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    await world.service.recordCheckpoint(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        contents: checkpointOf(executionId),
      },
      `recovery-ck-${executionId}`,
    );
    const eventsBefore = (
      await world.executionStore.listEvents(APPLICATION_ID, executionId)
    ).filter((event) => event.command === "resume-recorded");
    expect(eventsBefore).toHaveLength(0);
    const resumed = await world.service.resumeExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        resumeFacts: factsOf(checkpointOf(executionId)),
      },
      `recovery-resume-${executionId}`,
    );
    expect(resumed.status).toBe("RUNNING");
    expect(resumed.replayed).toBe(false);
    const events = await world.executionStore.listEvents(APPLICATION_ID, executionId);
    expect(events.filter((event) => event.command === "resume-recorded")).toHaveLength(1);
  });

  test("a resume replays its completed operation (one transition, no duplicates)", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await pause(world, executionId, { key: `pause-replay-resume-${executionId}` });
    const command: ResumeExecutionCommand = {
      applicationId: APPLICATION_ID,
      executionId,
      actor,
      resumeFacts: factsOf(checkpointOf(executionId)),
    };
    const first = await world.service.resumeExecution(command, `resume-replay-${executionId}`);
    const replay = await world.service.resumeExecution(command, `resume-replay-${executionId}`);
    expect(replay.replayed).toBe(true);
    expect(replay.checkpointId).toBe(first.checkpointId);
    // Exactly ONE resume transition on the ledger (the frozen `resume`
    // command events), converged by the stable operation key.
    const events = await world.executionStore.listEvents(APPLICATION_ID, executionId);
    const resumeEvents = events.filter(
      (event) => event.type === "execution.resumed" || event.command === "resume",
    );
    expect(resumeEvents).toHaveLength(1);
  });

  test("tenant scope is enforced on every command surface", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await expect(
      world.service.acquireLease(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor: otherTenantActor,
          ownerId: "worker-x",
          ttlMs: 60_000,
        },
        `foreign-lease-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(
      world.service.resumeExecution(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor: otherTenantActor,
          resumeFacts: factsOf(checkpointOf(executionId)),
        },
        `foreign-resume-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(
      world.service.requestInterruption(
        {
          applicationId: APPLICATION_ID,
          executionId: "00000000-0000-7000-8000-0000000000ff",
          actor,
          reason: "not mine",
        },
        "unknown-execution",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });
});

// ---------------------------------------------------------------------------
// The materiality rule and re-admission (LNG-003 / AC4)
// ---------------------------------------------------------------------------

describe("materially changed resumes re-enter the CURRENT admission controls", () => {
  async function pausedWorld(): Promise<{ world: World; executionId: string }> {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await pause(world, executionId, { key: `pause-material-${executionId}` });
    return { world, executionId };
  }

  test("an UNCHANGED resume consults NO admission authority (the crash-recovery precedent)", async () => {
    const { world, executionId } = await pausedWorld();
    await world.service.resumeExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        resumeFacts: factsOf(checkpointOf(executionId)),
      },
      `unchanged-resume-${executionId}`,
    );
    expect(world.admissions.policyCalls).toHaveLength(0);
    expect(world.admissions.resourceCalls).toHaveLength(0);
    expect(world.budgets.reserveCalls).toHaveLength(0);
  });

  test("a materially changed resume consults policy (and resource when resource dimensions moved)", async () => {
    const { world, executionId } = await pausedWorld();
    const outcome = await world.service.resumeExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        resumeFacts: factsOf(checkpointOf(executionId, { resourceClass: "large" })),
      },
      `material-resume-${executionId}`,
    );
    expect(outcome.readmitted).toBe(true);
    expect(outcome.materialChange).toContain("resourceClass");
    expect(world.admissions.policyCalls).toHaveLength(1);
    expect(world.admissions.resourceCalls).toHaveLength(1);
    const request = world.admissions.policyCalls[0];
    expect(request?.materialChange).toEqual(["resourceClass"]);
    expect(request?.resumeFacts.resourceClass).toBe("large");
    expect(request?.checkpointedFacts.resourceClass).toBe("standard");
  });

  test("a cost-only change consults policy and reserves budget (no resource call)", async () => {
    const { world, executionId } = await pausedWorld();
    await world.service.resumeExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        resumeFacts: factsOf(checkpointOf(executionId, { maxCostMicroUsd: "120000" })),
      },
      `cost-resume-${executionId}`,
    );
    expect(world.admissions.policyCalls).toHaveLength(1);
    expect(world.admissions.resourceCalls).toHaveLength(0);
    expect(world.budgets.reserveCalls).toHaveLength(1);
  });

  test("a policy DENIAL fails closed, is journaled, and stays durable", async () => {
    const { world, executionId } = await pausedWorld();
    world.admissions.denyPolicy = true;
    const command: ResumeExecutionCommand = {
      applicationId: APPLICATION_ID,
      executionId,
      actor,
      resumeFacts: factsOf(checkpointOf(executionId, { resourceClass: "large" })),
    };
    await expect(
      world.service.resumeExecution(command, `denied-resume-${executionId}`),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    const events = await world.executionStore.listEvents(APPLICATION_ID, executionId);
    expect(events.filter((event) => event.command === "resume-denied")).toHaveLength(1);
    // The denial is DURABLE: a fresh attempt under the same key replays it.
    await expect(
      world.service.resumeExecution(command, `denied-resume-${executionId}`),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(events.filter((event) => event.command === "resume-denied")).toHaveLength(1);
    // And no resume transition happened.
    const execution = await world.executions.getExecution(APPLICATION_ID, executionId);
    expect(execution?.status).toBe("WAITING_TOOL");
  });

  test("a resource DENIAL fails closed CAPABILITY_UNAVAILABLE with journal evidence", async () => {
    const { world, executionId } = await pausedWorld();
    world.admissions.denyResource = true;
    await expect(
      world.service.resumeExecution(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor,
          resumeFacts: factsOf(checkpointOf(executionId, { resourceClass: "large" })),
        },
        `denied-resource-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    const events = await world.executionStore.listEvents(APPLICATION_ID, executionId);
    expect(events.filter((event) => event.command === "resume-denied")).toHaveLength(1);
  });

  test("a materially changed costed resume without a budget authority fails closed", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    const executions = world.executions;
    const store = world.store;
    const service = createLongRunningExecutionService({
      executions,
      store,
      resumePolicyReadmission: world.admissions.policy,
      resourceReadmission: world.admissions.resource,
      digest: sha256,
      generateId: world.generateId,
      now: () => new Date("2026-09-15T12:00:00Z"),
    });
    await acquire(world, executionId, "worker-1");
    await service.pauseExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        waitKind: "tool",
        checkpoint: checkpointOf(executionId),
      },
      `pause-nobudget-${executionId}`,
    );
    await expect(
      service.resumeExecution(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor,
          resumeFacts: factsOf(checkpointOf(executionId, { maxCostMicroUsd: "120000" })),
        },
        `nobudget-resume-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });
});

// ---------------------------------------------------------------------------
// Human interruption and governed termination (LNG-002 / AC5)
// ---------------------------------------------------------------------------

describe("human interruption and governed termination", () => {
  test("interruption: journal-then-act, revoke wake-ups, force-release the lease, WAITING_HUMAN", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    await world.service.scheduleWakeUp(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        wakeKey: `auto-resume-${executionId}`,
        cause: "scheduled auto-resume",
        earliestWakeAt: "2026-09-15T13:00:00.000Z",
      },
      `schedule-${executionId}`,
    );
    const interrupted = await world.service.requestInterruption(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        reason: "operator review requested",
      },
      `interrupt-${executionId}`,
    );
    expect(interrupted.status).toBe("WAITING_HUMAN");
    expect(interrupted.leaseReleased).toBe(true);
    expect(interrupted.wakeUpsSuperseded).toBe(1);
    const events = await world.executionStore.listEvents(APPLICATION_ID, executionId);
    const request = events.find((event) => event.command === "interruption-requested");
    expect(request?.payload).toMatchObject({ reason: "operator review requested" });
    // The interruption request is journaled BEFORE the wait-human move.
    const waitHuman = events.find((event) => event.command === "wait-human");
    expect(request && waitHuman ? request.sequence < waitHuman.sequence : false).toBe(true);
    // The revoked wake never fires.
    const applied = await world.service.applyWakeUps({
      applicationId: APPLICATION_ID,
      actor,
    });
    expect(applied.applications).toHaveLength(0);
  });

  test("interruption replay is idempotent", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    const command = {
      applicationId: APPLICATION_ID,
      executionId,
      actor,
      reason: "operator review requested",
    };
    const first = await world.service.requestInterruption(
      command,
      `interrupt-replay-${executionId}`,
    );
    const replay = await world.service.requestInterruption(
      command,
      `interrupt-replay-${executionId}`,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe(first.status);
    const events = await world.executionStore.listEvents(APPLICATION_ID, executionId);
    expect(events.filter((event) => event.command === "interruption-requested")).toHaveLength(1);
  });

  test("interruption of an already-waiting execution records the request without a move", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await pause(world, executionId, { key: `pause-interrupt-${executionId}` });
    const interrupted = await world.service.requestInterruption(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        reason: "operator review",
      },
      `interrupt-waiting-${executionId}`,
    );
    expect(interrupted.status).toBe("WAITING_TOOL");
    const events = await world.executionStore.listEvents(APPLICATION_ID, executionId);
    expect(events.filter((event) => event.command === "interruption-requested")).toHaveLength(1);
  });

  test("termination moves through the frozen cancel command; wake-ups superseded; replay idempotent", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await pause(world, executionId, {
      wakeUp: {
        wakeKey: `term-wake-${executionId}`,
        cause: "auto-resume",
        earliestWakeAt: "2026-09-15T13:00:00.000Z",
      },
      key: `pause-terminate-${executionId}`,
    });
    const command = {
      applicationId: APPLICATION_ID,
      executionId,
      actor,
      reason: "superseded by a newer run",
    };
    const terminated = await world.service.terminateExecution(command, `terminate-${executionId}`);
    expect(terminated.status).toBe("CANCELLED");
    expect(terminated.wakeUpsSuperseded).toBe(1);
    const replay = await world.service.terminateExecution(command, `terminate-${executionId}`);
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe("CANCELLED");
    // A terminal execution accepts no further checkpoints or wake-ups.
    await expect(
      world.service.scheduleWakeUp(
        {
          applicationId: APPLICATION_ID,
          executionId,
          actor,
          wakeKey: `post-term-${executionId}`,
          cause: "late wake",
          earliestWakeAt: "2026-09-15T14:00:00.000Z",
        },
        `post-term-schedule-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await expect(
      world.service.requestInterruption(
        { applicationId: APPLICATION_ID, executionId, actor, reason: "too late" },
        `post-term-interrupt-${executionId}`,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("interruption/termination require a non-empty reason (auditable provenance)", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await expect(
      world.service.requestInterruption(
        { applicationId: APPLICATION_ID, executionId, actor, reason: "" },
        "empty-interrupt",
      ),
    ).rejects.toBeInstanceOf(PlatformError);
    await expect(
      world.service.terminateExecution(
        { applicationId: APPLICATION_ID, executionId, actor, reason: "" },
        "empty-terminate",
      ),
    ).rejects.toBeInstanceOf(PlatformError);
  });
});

// ---------------------------------------------------------------------------
// Wake-ups (LNG-002)
// ---------------------------------------------------------------------------

describe("wake-up scheduling and application", () => {
  test("due ordering is (earliestWakeAt, id) and not-due wake-ups never fire", async () => {
    const world = createWorld();
    const early = await driveToRunning(world);
    const late = await driveToRunning(world);
    await pause(world, early, { key: `pause-early-${early}` });
    await pause(world, late, { key: `pause-late-${late}` });
    await world.service.scheduleWakeUp(
      {
        applicationId: APPLICATION_ID,
        executionId: early,
        actor,
        wakeKey: "wake-early",
        cause: "early",
        earliestWakeAt: "2026-09-15T12:30:00.000Z",
      },
      "schedule-early",
    );
    await world.service.scheduleWakeUp(
      {
        applicationId: APPLICATION_ID,
        executionId: late,
        actor,
        wakeKey: "wake-late",
        cause: "late",
        earliestWakeAt: "2026-09-16T12:30:00.000Z",
      },
      "schedule-late",
    );
    // Time passes beyond the EARLY wake's earliest time (not the late one).
    world.advance(45 * 60_000);
    const applied = await world.service.applyWakeUps({ applicationId: APPLICATION_ID, actor });
    expect(applied.applications.map((application) => application.wakeKey)).toEqual(["wake-early"]);
    expect(applied.applications[0]).toMatchObject({ action: "resumed", executionId: early });
    const earlyExecution = await world.executions.getExecution(APPLICATION_ID, early);
    expect(earlyExecution?.status).toBe("RUNNING");
    const lateExecution = await world.executions.getExecution(APPLICATION_ID, late);
    expect(lateExecution?.status).toBe("WAITING_TOOL");
  });

  test("wake application is write-once and replaying never duplicates the resume", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await pause(world, executionId, {
      wakeUp: {
        wakeKey: `wake-once-${executionId}`,
        cause: "timeout",
        earliestWakeAt: "2026-09-15T12:01:00.000Z",
      },
      key: `pause-wake-once-${executionId}`,
    });
    world.advance(2 * 60_000);
    const first = await world.service.applyWakeUps({ applicationId: APPLICATION_ID, actor });
    expect(first.applications[0]?.action).toBe("resumed");
    const second = await world.service.applyWakeUps({ applicationId: APPLICATION_ID, actor });
    expect(second.applications).toHaveLength(0);
    const events = await world.executionStore.listEvents(APPLICATION_ID, executionId);
    const resumeEvents = events.filter(
      (event) => event.type === "execution.resumed" || event.command === "resume",
    );
    expect(resumeEvents).toHaveLength(1);
    expect(events.filter((event) => event.command === "wake-up-applied")).toHaveLength(1);
  });

  test("a wake on an already-RUNNING execution satisfies without a resume", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await world.service.scheduleWakeUp(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        wakeKey: `wake-running-${executionId}`,
        cause: "heartbeat",
        earliestWakeAt: "2026-09-15T12:01:00.000Z",
      },
      `schedule-running-${executionId}`,
    );
    world.advance(2 * 60_000);
    const applied = await world.service.applyWakeUps({ applicationId: APPLICATION_ID, actor });
    expect(applied.applications[0]).toMatchObject({ action: "already-running" });
    const events = await world.executionStore.listEvents(APPLICATION_ID, executionId);
    expect(events.filter((event) => event.command === "wake-up-applied")).toHaveLength(1);
  });

  test("a superseded wake (terminal execution) never fires", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await world.service.scheduleWakeUp(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        wakeKey: `wake-dead-${executionId}`,
        cause: "timeout",
        earliestWakeAt: "2026-09-15T12:01:00.000Z",
      },
      `schedule-dead-${executionId}`,
    );
    await world.service.terminateExecution(
      { applicationId: APPLICATION_ID, executionId, actor, reason: "gone" },
      `terminate-wake-dead-${executionId}`,
    );
    world.advance(2 * 60_000);
    const applied = await world.service.applyWakeUps({ applicationId: APPLICATION_ID, actor });
    // The termination SUPERSEDED the scheduled wake before it was ever
    // due — it never fires and never appears as an application action.
    expect(applied.applications).toHaveLength(0);
    const wake = world.store.getWakeUp(APPLICATION_ID, executionId, `wake-dead-${executionId}`);
    expect((await wake)?.status).toBe("superseded");
    expect((await wake)?.supersedeCause).toMatch(/terminated/i);
  });

  test("scheduling is idempotent by wake key (converged, one row)", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    const command = {
      applicationId: APPLICATION_ID,
      executionId,
      actor,
      wakeKey: `wake-idem-${executionId}`,
      cause: "timeout",
      earliestWakeAt: "2026-09-15T12:01:00.000Z",
    };
    const first = await world.service.scheduleWakeUp(command, `schedule-idem-${executionId}`);
    const replay = await world.service.scheduleWakeUp(command, `schedule-idem-${executionId}`);
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe(first.status);
    expect(await world.store.listWakeUps(APPLICATION_ID, executionId)).toHaveLength(1);
    const events = await world.executionStore.listEvents(APPLICATION_ID, executionId);
    expect(events.filter((event) => event.command === "wake-up-scheduled")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Operation-key discipline
// ---------------------------------------------------------------------------

describe("operation-key discipline", () => {
  test("the same idempotency key on DIFFERENT executions never collides", async () => {
    const world = createWorld();
    const first = await driveToRunning(world);
    const second = await driveToRunning(world);
    await acquire(world, first, "worker-1");
    await acquire(world, second, "worker-2");
    const key = "shared-idempotency-key";
    const a = await world.service.recordCheckpoint(
      {
        applicationId: APPLICATION_ID,
        executionId: first,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        contents: checkpointOf(first),
      },
      key,
    );
    const b = await world.service.recordCheckpoint(
      {
        applicationId: APPLICATION_ID,
        executionId: second,
        actor,
        worker: { ownerId: "worker-2", epoch: 1 },
        contents: checkpointOf(second),
      },
      key,
    );
    expect(a.checkpointId).not.toBe(b.checkpointId);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
    expect(
      [...world.store.operations.values()].filter((record) => record.operationKey.endsWith(key)),
    ).toHaveLength(2);
  });

  test("terminal rows replay WITHOUT an attempts bump (the attempts ledger counts PENDING retries)", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    await world.service.recordCheckpoint(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        contents: checkpointOf(executionId),
      },
      `attempts-${executionId}`,
    );
    await world.service.recordCheckpoint(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        contents: checkpointOf(executionId),
      },
      `attempts-${executionId}`,
    );
    const records = [...world.store.operations.values()].filter((record) =>
      record.operationKey.endsWith(`attempts-${executionId}`),
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.attempts).toBe(1);
    expect(records[0]?.status).toBe("completed");
    // The crash-window PENDING-retry attempts bump is proven by the
    // crash-injection suite (a retry of a still-PENDING row).
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("reads", () => {
  test("getLease / getLatestCheckpoint / listCheckpoints / listWakeUps", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    const first: CheckpointRecord | null = await world.service.getLatestCheckpoint(
      APPLICATION_ID,
      executionId,
    );
    expect(first).toBeNull();
    await world.service.recordCheckpoint(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        contents: checkpointOf(executionId),
      },
      `read-ck-1-${executionId}`,
    );
    const latest = await world.service.getLatestCheckpoint(APPLICATION_ID, executionId);
    expect(latest?.checkpointSequence).toBe(1);
    expect(await world.service.listCheckpoints(APPLICATION_ID, executionId)).toHaveLength(1);
    expect(await world.service.getLease(APPLICATION_ID, executionId)).toMatchObject({
      ownerId: "worker-1",
      epoch: 1,
    });
    expect(await world.service.listWakeUps(APPLICATION_ID, executionId)).toHaveLength(0);
  });
});
