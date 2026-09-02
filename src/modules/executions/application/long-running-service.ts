/**
 * Long-running execution service (executions module application;
 * WORK-028, LNG-001/002/003).
 *
 * THE checkpoint/lease/resume/interruption/wake-up orchestration of
 * long-running executions — an EXTENSION that composes with the FROZEN
 * lifecycle (WORK-006) without touching it:
 *
 *   * pause moves the execution ONLY through the frozen `wait-tool` /
 *     `wait-user` transitions; human interruption ONLY through
 *     `wait-human`; resume ONLY through the frozen `resume` command;
 *     governed termination ONLY through the frozen `cancel` command.
 *     The transition service stays THE single status write path — this
 *     service delegates to it and never writes execution status itself;
 *   * checkpoint/lease/wake-up/interruption evidence rides the CANONICAL
 *     EventEnvelope ledger through the public `recordStepEvent` seam of
 *     the SAME executions service (status-preserving observations);
 *   * there is NO second execution identity: every durable row of
 *     migration 0022 references the existing execution id; resume
 *     returns the SAME identity it was given, always;
 *   * lease discipline: every side-effecting worker operation
 *     (checkpoint commit, pause, worker transition) carries the
 *     lease-validity guard — stale workers (expired / superseded /
 *     foreign-held) fail closed typed BEFORE any write. Lease conflicts
 *     FAIL CLOSED. Human interruption and governed termination are
 *     human-authoritative: they force-release a live lease with an
 *     explicit recorded cause instead of being blocked by it;
 *   * crash safety (the WORK-024 standard): every governed operation
 *     flows through the DURABLE, RECOVERABLE operation state (stable
 *     execution-scoped keys, monotonic attempts, stage checkpoints,
 *     terminal immutability) and every ledger write carries its own
 *     stable idempotency key — a crash at any boundary leaves the
 *     honest PENDING row, and the retry resumes from the recorded stage
 *     with exactly-once side effects per key;
 *   * materiality (LNG-003): a resume whose facts differ from the
 *     checkpointed facts on any admission-relevant dimension re-enters
 *     the CURRENT policy / resource / budget admission BEFORE the
 *     resume commits; a denial is journaled on the ledger
 *     (`resume-denied`) and the resume fails closed.
 */

import { PlatformError } from "../../../shared/errors";
import type { BudgetAuthority } from "../../budgets/public";
import type {
  CheckpointContents,
  CheckpointRecord,
  MaterialChangeDimension,
  ResumeFacts,
} from "../domain/checkpoint";
import {
  checkpointDigestInput,
  checkpointIncompatibility,
  checkpointIntegrityFailure,
  materialChangeBetween,
  materialFactsOf,
  validateCheckpointContents,
  validateResumeFacts,
} from "../domain/checkpoint";
import type { EventEnvelope } from "../domain/event";
import type { ExecutionRecord } from "../domain/execution";
import type { LeaseRecord, LeaseReleaseCause } from "../domain/lease";
import { leaseGuardRejection, throwLeaseRejection } from "../domain/lease";
import type { LongRunningOperationKind, LongRunningOperationRecord } from "../domain/longrunning";
import { executionScopedDiscriminator, longRunningOperationKey } from "../domain/longrunning";
import { isTerminal } from "../domain/state-machine";
import type { WakeUpRecord } from "../domain/wakeup";
import { canonicalFingerprint } from "../ports/execution-idempotency";
import type { LongRunningExecutionStore } from "../ports/long-running-store";
import type { ResourceReAdmission, ResumePolicyReAdmission } from "../ports/resume-admission";
import type {
  ExecutionService,
  ExecutionTransitionCommand,
  TransitionOutcome,
} from "./execution-service";

// ---------------------------------------------------------------------------
// Commands and outcomes
// ---------------------------------------------------------------------------

export interface LongRunningActor {
  readonly actorId: string;
  readonly tenantId: string;
}

export interface WorkerClaim {
  readonly ownerId: string;
  readonly epoch: number;
}

export interface AcquireLeaseCommand {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: LongRunningActor;
  readonly ownerId: string;
  readonly ttlMs: number;
  readonly reason?: string;
}

export interface LeaseOutcome {
  readonly executionId: string;
  readonly lease: LeaseRecord;
  readonly replayed: boolean;
}

export interface RenewLeaseCommand {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: LongRunningActor;
  readonly worker: WorkerClaim;
  readonly ttlMs: number;
}

export interface ReleaseLeaseCommand {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: LongRunningActor;
  readonly worker: WorkerClaim;
  readonly cause?: LeaseReleaseCause;
}

export interface LeaseReleaseOutcome {
  readonly executionId: string;
  readonly lease: LeaseRecord | null;
  readonly replayed: boolean;
}

export interface RecordCheckpointCommand {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: LongRunningActor;
  readonly worker: WorkerClaim;
  readonly contents: CheckpointContents;
}

export interface CheckpointOutcome {
  readonly executionId: string;
  readonly checkpointId: string;
  readonly checkpointSequence: number;
  readonly contentDigest: string;
  readonly lastEventPosition: number;
  readonly ledgerSequence: number;
  readonly replayed: boolean;
}

export interface PauseWakeUpRequest {
  readonly wakeKey: string;
  readonly cause: string;
  readonly earliestWakeAt: string;
}

export interface PauseExecutionCommand {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: LongRunningActor;
  readonly worker: WorkerClaim;
  /** Which frozen wait transition pauses the execution. */
  readonly waitKind: "tool" | "user";
  readonly checkpoint: CheckpointContents;
  readonly wakeUp?: PauseWakeUpRequest;
}

export interface PauseOutcome {
  readonly executionId: string;
  readonly status: string;
  readonly checkpointId: string;
  readonly checkpointSequence: number;
  readonly wakeUpScheduled: boolean;
  readonly leaseReleased: boolean;
  readonly replayed: boolean;
}

export interface ResumeWorkerRequest {
  readonly ownerId: string;
  readonly ttlMs: number;
}

export interface ResumeExecutionCommand {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: LongRunningActor;
  /** The facts the resumer intends to run under (the materiality input). */
  readonly resumeFacts: ResumeFacts;
  /** Resumes a specific checkpoint (default: the latest). */
  readonly checkpointId?: string;
  /** The worker that adopts the execution on resume (acquires the lease). */
  readonly worker?: ResumeWorkerRequest;
}

export interface ResumeOutcome {
  readonly executionId: string;
  readonly status: string;
  readonly checkpointId: string;
  readonly checkpointSequence: number;
  readonly materialChange: readonly MaterialChangeDimension[];
  readonly readmitted: boolean;
  readonly lease: LeaseRecord | null;
  readonly replayed: boolean;
}

export interface InterruptExecutionCommand {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: LongRunningActor;
  readonly reason: string;
}

export interface InterruptOutcome {
  readonly executionId: string;
  readonly status: string;
  readonly wakeUpsSuperseded: number;
  readonly leaseReleased: boolean;
  readonly replayed: boolean;
}

export interface TerminateExecutionCommand {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: LongRunningActor;
  readonly reason: string;
  readonly verificationResults?: readonly {
    readonly criterionId: string;
    readonly strategy: string;
    readonly status: "PASS" | "FAIL" | "INCONCLUSIVE";
    readonly evidence?: readonly string[];
    readonly recordedBy: string;
  }[];
}

export interface TerminateOutcome {
  readonly executionId: string;
  readonly status: string;
  readonly wakeUpsSuperseded: number;
  readonly leaseReleased: boolean;
  readonly replayed: boolean;
}

export interface ScheduleWakeUpCommand {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: LongRunningActor;
  readonly wakeKey: string;
  readonly cause: string;
  readonly earliestWakeAt: string;
}

export interface WakeUpOutcome {
  readonly executionId: string;
  readonly wakeKey: string;
  readonly status: string;
  readonly earliestWakeAt: string;
  readonly replayed: boolean;
}

export interface ApplyWakeUpsCommand {
  readonly applicationId: string;
  readonly actor: LongRunningActor;
}

export type WakeUpApplicationAction =
  | { readonly action: "resumed"; readonly wakeKey: string; readonly executionId: string }
  | { readonly action: "already-running"; readonly wakeKey: string; readonly executionId: string }
  | {
      readonly action: "superseded";
      readonly wakeKey: string;
      readonly executionId: string;
      readonly reason: string;
    }
  | { readonly action: "replayed"; readonly wakeKey: string; readonly executionId: string };

export interface ApplyWakeUpsOutcome {
  readonly applications: readonly WakeUpApplicationAction[];
}

export interface WorkerTransitionCommand {
  readonly applicationId: string;
  readonly command: ExecutionTransitionCommand;
  readonly worker: WorkerClaim;
}

export interface LongRunningExecutionService {
  acquireLease(input: AcquireLeaseCommand, idempotencyKey: string): Promise<LeaseOutcome>;
  renewLease(input: RenewLeaseCommand, idempotencyKey: string): Promise<LeaseOutcome>;
  releaseLease(input: ReleaseLeaseCommand, idempotencyKey: string): Promise<LeaseReleaseOutcome>;
  recordCheckpoint(
    input: RecordCheckpointCommand,
    idempotencyKey: string,
  ): Promise<CheckpointOutcome>;
  pauseExecution(input: PauseExecutionCommand, idempotencyKey: string): Promise<PauseOutcome>;
  resumeExecution(input: ResumeExecutionCommand, idempotencyKey: string): Promise<ResumeOutcome>;
  requestInterruption(
    input: InterruptExecutionCommand,
    idempotencyKey: string,
  ): Promise<InterruptOutcome>;
  terminateExecution(
    input: TerminateExecutionCommand,
    idempotencyKey: string,
  ): Promise<TerminateOutcome>;
  scheduleWakeUp(input: ScheduleWakeUpCommand, idempotencyKey: string): Promise<WakeUpOutcome>;
  applyWakeUps(input: ApplyWakeUpsCommand): Promise<ApplyWakeUpsOutcome>;
  workerTransition(
    input: WorkerTransitionCommand,
    idempotencyKey: string,
  ): Promise<TransitionOutcome>;
  getLease(applicationId: string, executionId: string): Promise<LeaseRecord | null>;
  getLatestCheckpoint(applicationId: string, executionId: string): Promise<CheckpointRecord | null>;
  listCheckpoints(applicationId: string, executionId: string): Promise<readonly CheckpointRecord[]>;
  listWakeUps(applicationId: string, executionId: string): Promise<readonly WakeUpRecord[]>;
}

export interface LongRunningExecutionServiceDeps {
  /** The FROZEN executions service — composed, never bypassed. */
  readonly executions: ExecutionService;
  readonly store: LongRunningExecutionStore;
  /** REQUIRED policy re-admission seam (no default-allow exists). */
  readonly resumePolicyReadmission: ResumePolicyReAdmission;
  /** REQUIRED resource re-admission seam (no default-allow exists). */
  readonly resourceReadmission: ResourceReAdmission;
  /** OPTIONAL budget seam (WORK-004): fail-closed on materially changed cost. */
  readonly budgetAuthority?: BudgetAuthority;
  /** One-way digest (sha256 hex) of the canonical checkpoint form. */
  readonly digest: (input: string) => string;
  readonly generateId: () => string;
  readonly now: () => Date;
}

interface StagePayload {
  readonly stage: string;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createLongRunningExecutionService(
  deps: LongRunningExecutionServiceDeps,
): LongRunningExecutionService {
  const { executions, store, resumePolicyReadmission, resourceReadmission } = deps;
  const budgetAuthority = deps.budgetAuthority;
  const digest = deps.digest;
  const generateId = deps.generateId;
  const now = deps.now;

  const iso = () => now().toISOString();

  const requireKey = (idempotencyKey: string): void => {
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "a non-empty idempotency key is required",
      });
    }
  };

  /** Tenant-guarded execution read (the identity never changes hands). */
  const scopedExecution = async (
    applicationId: string,
    executionId: string,
    tenantId: string,
  ): Promise<ExecutionRecord> => {
    const execution = await executions.getExecution(applicationId, executionId);
    if (execution === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "execution not found in this application (missing or owned by another application)",
        details: { executionId },
      });
    }
    if (execution.tenantId !== tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "execution belongs to a different tenant",
        details: { executionId },
      });
    }
    return execution;
  };

  /** The lease-validity guard: stale workers fail closed BEFORE any write. */
  const guardLease = async (
    applicationId: string,
    executionId: string,
    worker: WorkerClaim,
  ): Promise<LeaseRecord> => {
    const lease = await store.getLease(applicationId, executionId);
    const rejection = leaseGuardRejection(lease, worker, iso());
    if (rejection !== null) {
      throwLeaseRejection(executionId, rejection);
    }
    return lease as LeaseRecord;
  };

  /**
   * Claim (or re-claim) the durable operation — the crash-safety
   * discriminator. A COMPLETED row replays its recorded outcome; a
   * FAILED resume row replays its durable denial typed; a PENDING row
   * is the crash-resume signal (the caller continues from `record.stage`).
   */
  const beginOperation = async (
    kind: LongRunningOperationKind,
    command: { applicationId: string; executionId: string },
    tenantId: string,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<LongRunningOperationRecord> => {
    const operationKey = longRunningOperationKey(
      kind,
      executionScopedDiscriminator(command.executionId, idempotencyKey),
    );
    const { record } = await store.beginOperation({
      id: generateId(),
      applicationId: command.applicationId,
      tenantId,
      executionId: command.executionId,
      operationKind: kind,
      operationKey,
      requestFingerprint: fingerprint,
      now: iso(),
    });
    return record;
  };

  const stageOf = (record: LongRunningOperationRecord): StagePayload | null => {
    if (record.stage === null || typeof record.stage !== "object") {
      return null;
    }
    return record.stage as StagePayload;
  };

  /**
   * RACE-TOLERANT stage write: a concurrent duplicate may complete or
   * durably fail the operation between our check and this write — the
   * winner owns the outcome and our tail converges through the stable
   * keys (the WORK-024/025 lesson).
   */
  const checkpointOperationStage = async (
    applicationId: string,
    operationKey: string,
    stage: Readonly<Record<string, unknown>>,
  ): Promise<LongRunningOperationRecord | null> => {
    try {
      return await store.recordOperationStage({
        applicationId,
        operationKey,
        stage,
        now: iso(),
      });
    } catch (error) {
      if (error instanceof PlatformError && error.code === "INVALID_STATE_TRANSITION") {
        const reread = await store.findOperation(applicationId, operationKey);
        if (reread !== null && reread.status !== "pending") {
          return reread;
        }
      }
      throw error;
    }
  };

  /** Ledger evidence through the CANONICAL recordStepEvent seam. */
  const recordEvidence = (
    input: {
      readonly applicationId: string;
      readonly executionId: string;
      readonly actor: LongRunningActor;
      readonly command: Parameters<ExecutionService["recordStepEvent"]>[0]["command"];
      readonly cause?: string;
      readonly reference?: Readonly<Record<string, unknown>>;
      readonly payload: Readonly<Record<string, unknown>>;
    },
    idempotencyKey: string,
  ) =>
    executions.recordStepEvent(
      {
        executionId: input.executionId,
        applicationId: input.applicationId,
        actor: { actorId: input.actor.actorId, tenantId: input.actor.tenantId },
        command: input.command,
        cause: input.cause,
        reference: input.reference,
        payload: input.payload,
      },
      idempotencyKey,
    );

  /** Budget reservation for a materially changed cost bound (fail-closed). */
  const reserveResumeBudget = async (
    execution: ExecutionRecord,
    actor: LongRunningActor,
    resumeFacts: ResumeFacts,
    operationKey: string,
  ): Promise<string | null> => {
    if (resumeFacts.maxCostMicroUsd === null) {
      return null;
    }
    if (budgetAuthority === undefined) {
      throw new PlatformError({
        code: "BUDGET_EXCEEDED",
        message:
          "the resume materially changes the cost bound but no budget authority is wired; costed resumes are never unbudgeted (fail closed)",
        details: { executionId: execution.id, amountMicroUsd: resumeFacts.maxCostMicroUsd },
      });
    }
    const reserved = await budgetAuthority.reserve(
      {
        actorId: actor.actorId,
        applicationId: execution.applicationId,
        tenantId: execution.tenantId,
        executionId: execution.id,
        operationId: operationKey,
        userId: execution.userId === "" ? undefined : execution.userId,
        amountMicroUsd: resumeFacts.maxCostMicroUsd,
      },
      operationKey,
    );
    return reserved.reservation.id;
  };

  // ----- lease operations --------------------------------------------------

  const acquireLease = async (
    input: AcquireLeaseCommand,
    idempotencyKey: string,
  ): Promise<LeaseOutcome> => {
    requireKey(idempotencyKey);
    if (input.ttlMs <= 0 || !Number.isInteger(input.ttlMs)) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "lease ttlMs must be a positive integer",
      });
    }
    const fingerprint = canonicalFingerprint([
      "executions.longrunning.lease-acquire",
      input.executionId,
      input.ownerId,
      input.ttlMs,
      input.reason ?? null,
    ]);
    const operationKey = longRunningOperationKey(
      "lease-acquire",
      executionScopedDiscriminator(input.executionId, idempotencyKey),
    );
    let record = await beginOperation(
      "lease-acquire",
      input,
      input.actor.tenantId,
      idempotencyKey,
      fingerprint,
    );
    if (record.status === "completed") {
      const lease = await store.getLease(input.applicationId, input.executionId);
      return {
        executionId: input.executionId,
        lease: lease as LeaseRecord,
        replayed: true,
      };
    }
    const execution = await scopedExecution(
      input.applicationId,
      input.executionId,
      input.actor.tenantId,
    );
    if (isTerminal(execution.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `execution is terminal in ${execution.status}; no lease may be acquired`,
        details: { executionId: input.executionId, status: execution.status },
      });
    }
    const outcome = await store.acquireLease({
      applicationId: input.applicationId,
      tenantId: execution.tenantId,
      executionId: input.executionId,
      ownerId: input.ownerId,
      ttlMs: input.ttlMs,
      now: iso(),
    });
    if (outcome.status === "refused") {
      // LEASE CONFLICT: FAIL CLOSED (one authoritative owner per live
      // mutable execution). The operation row stays PENDING (honestly
      // retryable — the conflict may clear).
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: outcome.reason,
        details: {
          executionId: input.executionId,
          leaseOwner: outcome.lease.ownerId,
          leaseEpoch: outcome.lease.epoch,
          leaseExpiresAt: outcome.lease.expiresAt,
        },
      });
    }
    const staged = await checkpointOperationStage(input.applicationId, operationKey, {
      stage: "acquired",
      ownerId: outcome.lease.ownerId,
      epoch: outcome.lease.epoch,
      expiresAt: outcome.lease.expiresAt,
    });
    record = await store.completeOperation(input.applicationId, operationKey, iso());
    void staged;
    void record;
    return { executionId: input.executionId, lease: outcome.lease, replayed: false };
  };

  const renewLease = async (
    input: RenewLeaseCommand,
    idempotencyKey: string,
  ): Promise<LeaseOutcome> => {
    requireKey(idempotencyKey);
    if (input.ttlMs <= 0 || !Number.isInteger(input.ttlMs)) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "lease ttlMs must be a positive integer",
      });
    }
    const fingerprint = canonicalFingerprint([
      "executions.longrunning.lease-renew",
      input.executionId,
      input.worker.ownerId,
      input.worker.epoch,
      input.ttlMs,
    ]);
    const operationKey = longRunningOperationKey(
      "lease-renew",
      executionScopedDiscriminator(input.executionId, idempotencyKey),
    );
    const record = await beginOperation(
      "lease-renew",
      input,
      input.actor.tenantId,
      idempotencyKey,
      fingerprint,
    );
    if (record.status === "completed") {
      const lease = await store.getLease(input.applicationId, input.executionId);
      return { executionId: input.executionId, lease: lease as LeaseRecord, replayed: true };
    }
    // The renew itself is the heartbeat: (owner, epoch) claim required,
    // expiry extended, monotonic heartbeat ledger advanced.
    const lease = await store.renewLease({
      applicationId: input.applicationId,
      executionId: input.executionId,
      ownerId: input.worker.ownerId,
      epoch: input.worker.epoch,
      ttlMs: input.ttlMs,
      now: iso(),
    });
    await checkpointOperationStage(input.applicationId, operationKey, {
      stage: "renewed",
      expiresAt: lease.expiresAt,
      heartbeatCount: lease.heartbeatCount,
    });
    await store.completeOperation(input.applicationId, operationKey, iso());
    return { executionId: input.executionId, lease, replayed: false };
  };

  const releaseLease = async (
    input: ReleaseLeaseCommand,
    idempotencyKey: string,
  ): Promise<LeaseReleaseOutcome> => {
    requireKey(idempotencyKey);
    const fingerprint = canonicalFingerprint([
      "executions.longrunning.lease-release",
      input.executionId,
      input.worker.ownerId,
      input.worker.epoch,
      input.cause ?? null,
    ]);
    const operationKey = longRunningOperationKey(
      "lease-release",
      executionScopedDiscriminator(input.executionId, idempotencyKey),
    );
    const record = await beginOperation(
      "lease-release",
      input,
      input.actor.tenantId,
      idempotencyKey,
      fingerprint,
    );
    if (record.status === "completed") {
      const lease = await store.getLease(input.applicationId, input.executionId);
      return { executionId: input.executionId, lease, replayed: true };
    }
    const lease = await store.releaseLease({
      applicationId: input.applicationId,
      executionId: input.executionId,
      ownerId: input.worker.ownerId,
      epoch: input.worker.epoch,
      cause: input.cause ?? "worker-released",
      now: iso(),
    });
    await checkpointOperationStage(input.applicationId, operationKey, {
      stage: "released",
      ...(lease === null ? {} : { releasedAt: lease.releasedAt }),
    });
    await store.completeOperation(input.applicationId, operationKey, iso());
    return { executionId: input.executionId, lease, replayed: false };
  };

  // ----- checkpoint commit (the pause/resume backbone) ----------------------

  /**
   * Commit one checkpoint: the write-once row + the canonical ledger
   * evidence + the operation stage. The LEASE GUARD protects the row
   * insert (the side effect); the evidence tail converges through the
   * stable `checkpoint:<executionId>:<sequence>` key regardless of the
   * lease's later fate (the guard protected the commit itself).
   *
   * CRASH RECOVERY (the committed-effect distinction): the digest probe
   * runs FIRST — a checkpoint row with the same content digest for the
   * same execution PROVES the durable side effect already committed
   * (the crash window between the insert and the operation-stage write).
   * The recovery tail then converges onto it WITHOUT the lease guard and
   * WITHOUT a second row — the committed external effect is never
   * duplicated, and a lease that expired during the crash window never
   * blocks the convergence of an effect that is already durable.
   */
  const commitCheckpoint = async (
    input: RecordCheckpointCommand,
    operationKey: string,
  ): Promise<{ checkpoint: CheckpointRecord; ledgerSequence: number }> => {
    validateCheckpointContents(input.contents);
    const execution = await scopedExecution(
      input.applicationId,
      input.executionId,
      input.actor.tenantId,
    );
    if (isTerminal(execution.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `execution is terminal in ${execution.status}; the ledger accepts no further step events`,
        details: { executionId: input.executionId, status: execution.status },
      });
    }
    if (input.contents.executionId !== input.executionId) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message:
          "checkpoint contents bind to a different execution identity (no second execution identity exists)",
        details: {
          contentsExecutionId: input.contents.executionId,
          commandExecutionId: input.executionId,
        },
      });
    }
    if (input.contents.lastEventPosition > execution.lastEventSequence) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message:
          "checkpoint lastEventPosition cannot exceed the durable ledger head (no checkpointing beyond what is committed)",
        details: {
          lastEventPosition: input.contents.lastEventPosition,
          ledgerHead: execution.lastEventSequence,
        },
      });
    }
    const contentDigest = digest(checkpointDigestInput(input.contents));
    // 1. The COMMITTED-EFFECT probe: the digest identifies this exact
    //    checkpoint; a surviving row with the same digest means the side
    //    effect committed (crash between insert and stage write).
    const committed = await store.findCheckpointByDigest(
      input.applicationId,
      input.executionId,
      contentDigest,
    );
    let checkpoint: CheckpointRecord;
    if (committed !== null) {
      checkpoint = committed;
    } else {
      // 2. The side effect is NOT yet durable: the lease guard applies
      //    (a stale worker never commits a checkpoint).
      await guardLease(input.applicationId, input.executionId, input.worker);
      const existing = await store.listCheckpoints(input.applicationId, input.executionId);
      const checkpointSequence = existing.length + 1;
      const inserted = await store.insertCheckpoint({
        id: generateId(),
        applicationId: input.applicationId,
        tenantId: execution.tenantId,
        executionId: input.executionId,
        checkpointSequence,
        contents: input.contents,
        contentDigest,
        recordedBy: input.worker.ownerId,
        now: iso(),
      });
      checkpoint = inserted.checkpoint;
      // The durable stage: past this point the recovery tail converges
      // through stable keys even if the lease later expires.
      await checkpointOperationStage(input.applicationId, operationKey, {
        stage: "checkpoint-committed",
        checkpointId: checkpoint.id,
        checkpointSequence: checkpoint.checkpointSequence,
        contentDigest,
      });
    }
    // 3. The canonical ledger evidence (status-preserving step event);
    //    converges through the stable per-sequence key.
    const evidence = await recordEvidence(
      {
        applicationId: input.applicationId,
        executionId: input.executionId,
        actor: input.actor,
        command: "checkpoint-recorded",
        cause: `checkpoint ${checkpoint.checkpointSequence} recorded by worker ${input.worker.ownerId} (epoch ${input.worker.epoch})`,
        reference: {
          checkpointId: checkpoint.id,
          checkpointSequence: checkpoint.checkpointSequence,
          contentDigest,
          lastEventPosition: input.contents.lastEventPosition,
          planId: input.contents.planId,
          planRevision: input.contents.planRevision,
          recordedBy: input.worker.ownerId,
          worker: { ownerId: input.worker.ownerId, epoch: input.worker.epoch },
        },
        payload: {
          checkpointSequence: checkpoint.checkpointSequence,
          lastEventPosition: input.contents.lastEventPosition,
          planId: input.contents.planId,
          planRevision: input.contents.planRevision,
          resourceClass: input.contents.resourceClass,
          contextArtifactRefs: input.contents.contextArtifactRefs,
        },
      },
      `checkpoint:${input.executionId}:${checkpoint.checkpointSequence}`,
    );
    return { checkpoint, ledgerSequence: evidence.sequence };
  };

  const recordCheckpoint = async (
    input: RecordCheckpointCommand,
    idempotencyKey: string,
  ): Promise<CheckpointOutcome> => {
    requireKey(idempotencyKey);
    validateCheckpointContents(input.contents);
    const fingerprint = canonicalFingerprint([
      "executions.longrunning.checkpoint",
      input.executionId,
      input.contents,
    ]);
    const operationKey = longRunningOperationKey(
      "checkpoint",
      executionScopedDiscriminator(input.executionId, idempotencyKey),
    );
    const record = await beginOperation(
      "checkpoint",
      input,
      input.actor.tenantId,
      idempotencyKey,
      fingerprint,
    );
    const stage = stageOf(record);
    if (record.status === "completed" && stage !== null) {
      const checkpoint = await store.getCheckpoint(
        input.applicationId,
        input.executionId,
        String(stage.checkpointId),
      );
      void checkpoint;
      return {
        executionId: input.executionId,
        checkpointId: String(stage.checkpointId),
        checkpointSequence: Number(stage.checkpointSequence),
        contentDigest: String(stage.contentDigest),
        lastEventPosition: Number(stage.lastEventPosition),
        ledgerSequence: Number(stage.ledgerSequence ?? 0),
        replayed: true,
      };
    }
    const { checkpoint, ledgerSequence } = await commitCheckpoint(input, operationKey);
    await checkpointOperationStage(input.applicationId, operationKey, {
      stage: "evidence-recorded",
      checkpointId: checkpoint.id,
      checkpointSequence: checkpoint.checkpointSequence,
      contentDigest: checkpoint.contentDigest,
      lastEventPosition: checkpoint.contents.lastEventPosition,
      ledgerSequence,
    });
    await store.completeOperation(input.applicationId, operationKey, iso());
    return {
      executionId: input.executionId,
      checkpointId: checkpoint.id,
      checkpointSequence: checkpoint.checkpointSequence,
      contentDigest: checkpoint.contentDigest,
      lastEventPosition: checkpoint.contents.lastEventPosition,
      ledgerSequence,
      replayed: false,
    };
  };

  // ----- pause --------------------------------------------------------------

  const pauseExecution = async (
    input: PauseExecutionCommand,
    idempotencyKey: string,
  ): Promise<PauseOutcome> => {
    requireKey(idempotencyKey);
    validateCheckpointContents(input.checkpoint);
    const fingerprint = canonicalFingerprint([
      "executions.longrunning.pause",
      input.executionId,
      input.waitKind,
      input.checkpoint,
      input.wakeUp ?? null,
    ]);
    const operationKey = longRunningOperationKey(
      "pause",
      executionScopedDiscriminator(input.executionId, idempotencyKey),
    );
    const record = await beginOperation(
      "pause",
      input,
      input.actor.tenantId,
      idempotencyKey,
      fingerprint,
    );
    const stage = stageOf(record);
    if (record.status === "completed" && stage !== null) {
      return {
        executionId: input.executionId,
        status: String(stage.status),
        checkpointId: String(stage.checkpointId),
        checkpointSequence: Number(stage.checkpointSequence),
        wakeUpScheduled: Boolean(stage.wakeUpScheduled),
        leaseReleased: Boolean(stage.leaseReleased),
        replayed: true,
      };
    }

    // 1. The checkpoint commit (lease-guarded unless the durable row
    //    already committed — the digest committed-effect probe inside).
    const { checkpoint } = await commitCheckpoint(
      {
        applicationId: input.applicationId,
        executionId: input.executionId,
        actor: input.actor,
        worker: input.worker,
        contents: input.checkpoint,
      },
      operationKey,
    );

    // 2. The frozen wait transition (RUNNING -> WAITING_TOOL/USER) —
    //    converged by the transition service's own idempotency key.
    const command: ExecutionTransitionCommand = {
      applicationId: input.applicationId,
      tenantId: input.actor.tenantId,
      actorId: input.actor.actorId,
      executionId: input.executionId,
      command: input.waitKind === "tool" ? "wait-tool" : "wait-user",
      reason: `paused by worker ${input.worker.ownerId} (checkpoint ${checkpoint.checkpointSequence})`,
    } as ExecutionTransitionCommand;
    const transitioned = await executions.transition(command, `${operationKey}:wait`);
    await checkpointOperationStage(input.applicationId, operationKey, {
      stage: "paused",
      checkpointId: checkpoint.id,
      checkpointSequence: checkpoint.checkpointSequence,
      status: transitioned.execution.status,
    });

    // 3. The optional wake-up (idempotent by wake key).
    let wakeUpScheduled = false;
    if (input.wakeUp !== undefined) {
      await store.insertWakeUp({
        id: generateId(),
        applicationId: input.applicationId,
        tenantId: input.actor.tenantId,
        executionId: input.executionId,
        wakeKey: input.wakeUp.wakeKey,
        cause: input.wakeUp.cause,
        earliestWakeAt: input.wakeUp.earliestWakeAt,
        now: iso(),
      });
      await recordEvidence(
        {
          applicationId: input.applicationId,
          executionId: input.executionId,
          actor: input.actor,
          command: "wake-up-scheduled",
          cause: `wake-up ${input.wakeUp.wakeKey} scheduled for ${input.wakeUp.earliestWakeAt}`,
          reference: {
            wakeKey: input.wakeUp.wakeKey,
            earliestWakeAt: input.wakeUp.earliestWakeAt,
            checkpointId: checkpoint.id,
          },
          payload: { wakeKey: input.wakeUp.wakeKey, cause: input.wakeUp.cause },
        },
        `wakeup:${input.executionId}:${input.wakeUp.wakeKey}`,
      );
      wakeUpScheduled = true;
    }

    // 4. Release the lease (the paused execution needs no live worker;
    //    the wake-up or the resumer acquires fresh). Converges when the
    //    claim was superseded in the meantime.
    const released = await store.releaseLease({
      applicationId: input.applicationId,
      executionId: input.executionId,
      ownerId: input.worker.ownerId,
      epoch: input.worker.epoch,
      cause: "paused",
      now: iso(),
    });
    const leaseReleased = released !== null;

    await checkpointOperationStage(input.applicationId, operationKey, {
      stage: "completed",
      checkpointId: checkpoint.id,
      checkpointSequence: checkpoint.checkpointSequence,
      status: transitioned.execution.status,
      wakeUpScheduled,
      leaseReleased,
    });
    await store.completeOperation(input.applicationId, operationKey, iso());
    return {
      executionId: input.executionId,
      status: transitioned.execution.status,
      checkpointId: checkpoint.id,
      checkpointSequence: checkpoint.checkpointSequence,
      wakeUpScheduled,
      leaseReleased,
      replayed: false,
    };
  };

  // ----- resume -------------------------------------------------------------

  const resumeExecution = async (
    input: ResumeExecutionCommand,
    idempotencyKey: string,
  ): Promise<ResumeOutcome> => {
    requireKey(idempotencyKey);
    validateResumeFacts(input.resumeFacts);
    const fingerprint = canonicalFingerprint([
      "executions.longrunning.resume",
      input.executionId,
      input.resumeFacts,
      input.checkpointId ?? null,
      input.worker ?? null,
    ]);
    const operationKey = longRunningOperationKey(
      "resume",
      executionScopedDiscriminator(input.executionId, idempotencyKey),
    );
    const record = await beginOperation(
      "resume",
      input,
      input.actor.tenantId,
      idempotencyKey,
      fingerprint,
    );
    const stage = stageOf(record);
    if (record.status === "completed" && stage !== null) {
      const lease = await store.getLease(input.applicationId, input.executionId);
      const current = await executions.getExecution(input.applicationId, input.executionId);
      return {
        executionId: input.executionId,
        status: current === null ? String(stage.status) : current.status,
        checkpointId: String(stage.checkpointId),
        checkpointSequence: Number(stage.checkpointSequence),
        materialChange: (stage.materialChange as MaterialChangeDimension[]) ?? [],
        readmitted: Boolean(stage.readmitted),
        lease,
        replayed: true,
      };
    }
    if (record.status === "failed") {
      // A durably recorded terminal failure (a journaled re-admission
      // denial) replays typed.
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: record.failureReason ?? "the resume was durably denied",
        details: { executionId: input.executionId, operationKey },
      });
    }

    // 1. The target checkpoint + INTEGRITY + COMPATIBILITY.
    const execution = await scopedExecution(
      input.applicationId,
      input.executionId,
      input.actor.tenantId,
    );
    const checkpoint =
      input.checkpointId === undefined
        ? await store.latestCheckpoint(input.applicationId, input.executionId)
        : await store.getCheckpoint(input.applicationId, input.executionId, input.checkpointId);
    if (checkpoint === null) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message:
          "no durable checkpoint to resume from — the long-running resume protocol only resumes checkpointed pauses (validate checkpoint integrity first)",
        details: { executionId: input.executionId },
      });
    }
    const integrityFailure = checkpointIntegrityFailure(checkpoint, digest);
    if (integrityFailure !== null) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: integrityFailure,
        details: { executionId: input.executionId, checkpointId: checkpoint.id },
      });
    }
    const incompatibility = checkpointIncompatibility(checkpoint.contents, input.resumeFacts);
    if (incompatibility !== null) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: incompatibility,
        details: {
          executionId: input.executionId,
          checkpointId: checkpoint.id,
          checkpointPlanId: checkpoint.contents.planId,
          checkpointPlanRevision: checkpoint.contents.planRevision,
          resumePlanId: input.resumeFacts.planId,
          resumePlanRevision: input.resumeFacts.planRevision,
        },
      });
    }

    // 2. The lease: a resuming worker ACQUIRES (conflicts fail closed).
    let lease: LeaseRecord | null = null;
    if (input.worker !== undefined) {
      const outcome = await store.acquireLease({
        applicationId: input.applicationId,
        tenantId: execution.tenantId,
        executionId: input.executionId,
        ownerId: input.worker.ownerId,
        ttlMs: input.worker.ttlMs,
        now: iso(),
      });
      if (outcome.status === "refused") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: outcome.reason,
          details: {
            executionId: input.executionId,
            leaseOwner: outcome.lease.ownerId,
            leaseEpoch: outcome.lease.epoch,
          },
        });
      }
      lease = outcome.lease;
    }

    // 3. THE MATERIALIZITY RULE: re-enter CURRENT admission on changed facts.
    const materialChange = materialChangeBetween(checkpoint.contents, input.resumeFacts);
    const readmitted = materialChange.length > 0;
    let reservationId: string | null = null;
    if (readmitted) {
      const request = {
        execution,
        actorId: input.actor.actorId,
        resumeFacts: input.resumeFacts,
        checkpointedFacts: materialFactsOf(checkpoint.contents),
        materialChange,
      };
      const policy = await resumePolicyReadmission.readmit(request);
      if (!policy.allowed) {
        await recordEvidence(
          {
            applicationId: input.applicationId,
            executionId: input.executionId,
            actor: input.actor,
            command: "resume-denied",
            cause: "resume re-admission denied by the policy authority",
            reference: {
              materialChange,
              reason: policy.reason ?? "policy re-admission denied the resume",
              checkpointId: checkpoint.id,
            },
            payload: { materialChange, denied: true },
          },
          `${operationKey}:denied`,
        );
        await store.failOperation(
          input.applicationId,
          operationKey,
          `resume re-admission denied: ${policy.reason ?? "policy authority denial"}`,
          iso(),
        );
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: `resume re-admission denied (materially changed: ${materialChange.join(", ")})`,
          details: {
            reason: policy.reason,
            materialChange,
            executionId: input.executionId,
          },
        });
      }
      const resourceChanged = materialChange.some(
        (dimension) =>
          dimension === "resourceClass" ||
          dimension === "environmentId" ||
          dimension === "environmentSpecDigest" ||
          dimension === "requiredCapabilities",
      );
      if (resourceChanged) {
        const resource = await resourceReadmission.readmit(request);
        if (!resource.allowed) {
          await recordEvidence(
            {
              applicationId: input.applicationId,
              executionId: input.executionId,
              actor: input.actor,
              command: "resume-denied",
              cause: "resume resource re-admission denied",
              reference: {
                materialChange,
                reason: resource.reason ?? "resource re-admission denied the resume",
                checkpointId: checkpoint.id,
              },
              payload: { materialChange, denied: true },
            },
            `${operationKey}:denied:resource`,
          );
          await store.failOperation(
            input.applicationId,
            operationKey,
            `resume resource re-admission denied: ${resource.reason ?? "resource authority denial"}`,
            iso(),
          );
          throw new PlatformError({
            code: resource.denialCode ?? "POLICY_DENIED",
            message: `resume resource re-admission denied (materially changed: ${materialChange.join(", ")})`,
            details: { reason: resource.reason, materialChange, executionId: input.executionId },
          });
        }
      }
      if (materialChange.includes("maxCostMicroUsd")) {
        reservationId = await reserveResumeBudget(
          execution,
          input.actor,
          input.resumeFacts,
          operationKey,
        );
      }
    }

    // 4. The resume move — ONLY through the frozen lifecycle: the
    //    `resume` command from a WAITING_* state. A RUNNING execution
    //    (the crash-recovery re-adoption) records the recovery evidence
    //    instead (status-preserving; the identity was never lost).
    let status: string;
    if (execution.status === "RUNNING") {
      const evidence = await recordEvidence(
        {
          applicationId: input.applicationId,
          executionId: input.executionId,
          actor: input.actor,
          command: "resume-recorded",
          cause: `recovery resume from checkpoint ${checkpoint.checkpointSequence} (execution already RUNNING)`,
          reference: {
            checkpointId: checkpoint.id,
            checkpointSequence: checkpoint.checkpointSequence,
            contentDigest: checkpoint.contentDigest,
            materialChange,
            readmitted,
            ...(lease === null ? {} : { lease: { ownerId: lease.ownerId, epoch: lease.epoch } }),
          },
          payload: { checkpointSequence: checkpoint.checkpointSequence, materialChange },
        },
        `${operationKey}:recovery`,
      );
      status = execution.status;
      void evidence;
    } else {
      const transitioned = await executions.transition(
        {
          applicationId: input.applicationId,
          tenantId: input.actor.tenantId,
          actorId: input.actor.actorId,
          executionId: input.executionId,
          command: "resume",
          reason: `resumed from checkpoint ${checkpoint.checkpointSequence}${readmitted ? " after re-admission" : ""}`,
        } as ExecutionTransitionCommand,
        `${operationKey}:resume`,
      );
      status = transitioned.execution.status;
    }

    await checkpointOperationStage(input.applicationId, operationKey, {
      stage: "resumed",
      checkpointId: checkpoint.id,
      checkpointSequence: checkpoint.checkpointSequence,
      status,
      materialChange,
      readmitted,
      ...(lease === null ? {} : { leaseEpoch: lease.epoch, ownerId: lease.ownerId }),
      ...(reservationId === null ? {} : { reservationId }),
    });
    await store.completeOperation(input.applicationId, operationKey, iso());
    return {
      executionId: input.executionId,
      status,
      checkpointId: checkpoint.id,
      checkpointSequence: checkpoint.checkpointSequence,
      materialChange,
      readmitted,
      lease,
      replayed: false,
    };
  };

  // ----- human interruption ---------------------------------------------------

  const requestInterruption = async (
    input: InterruptExecutionCommand,
    idempotencyKey: string,
  ): Promise<InterruptOutcome> => {
    requireKey(idempotencyKey);
    if (input.reason.length === 0) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "interruption requires a non-empty reason (auditable provenance)",
      });
    }
    const fingerprint = canonicalFingerprint([
      "executions.longrunning.interrupt",
      input.executionId,
      input.reason,
    ]);
    const operationKey = longRunningOperationKey(
      "interrupt",
      executionScopedDiscriminator(input.executionId, idempotencyKey),
    );
    const record = await beginOperation(
      "interrupt",
      input,
      input.actor.tenantId,
      idempotencyKey,
      fingerprint,
    );
    const stage = stageOf(record);
    if (record.status === "completed" && stage !== null) {
      return {
        executionId: input.executionId,
        status: String(stage.status),
        wakeUpsSuperseded: Number(stage.wakeUpsSuperseded ?? 0),
        leaseReleased: Boolean(stage.leaseReleased),
        replayed: true,
      };
    }
    const execution = await scopedExecution(
      input.applicationId,
      input.executionId,
      input.actor.tenantId,
    );
    if (isTerminal(execution.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `execution is terminal in ${execution.status}; it cannot be interrupted`,
        details: { executionId: input.executionId, status: execution.status },
      });
    }

    // 1. The DURABLE interruption request — auditable BEFORE the pause
    //    move (journal-then-act).
    await recordEvidence(
      {
        applicationId: input.applicationId,
        executionId: input.executionId,
        actor: input.actor,
        command: "interruption-requested",
        cause: `human interruption: ${input.reason}`,
        reference: { requestedBy: input.actor.actorId, reason: input.reason },
        payload: { reason: input.reason, requestedBy: input.actor.actorId },
      },
      `${operationKey}:requested`,
    );
    await checkpointOperationStage(input.applicationId, operationKey, {
      stage: "requested",
    });

    // 2. Human authority revokes auto-resume FIRST (a wake cannot fire
    //    between the request and the pause move).
    const superseded = await store.markWakeUpsSuperseded({
      applicationId: input.applicationId,
      executionId: input.executionId,
      cause: `human-interruption: ${input.reason}`.slice(0, 500),
      now: iso(),
    });

    // 3. Force-release any live worker lease (the human authority
    //    trumps worker ownership — never silently).
    const released = await store.forceReleaseLease({
      applicationId: input.applicationId,
      executionId: input.executionId,
      cause: "human-interruption",
      now: iso(),
    });

    // 4. The pause move: RUNNING -> WAITING_HUMAN through the frozen
    //    wait-human transition. Already-waiting executions stay put
    //    (the durable request above is the interruption record).
    let status = execution.status;
    if (execution.status === "RUNNING") {
      const transitioned = await executions.transition(
        {
          applicationId: input.applicationId,
          tenantId: input.actor.tenantId,
          actorId: input.actor.actorId,
          executionId: input.executionId,
          command: "wait-human",
          reason: `human interruption: ${input.reason}`,
        } as ExecutionTransitionCommand,
        `${operationKey}:wait-human`,
      );
      status = transitioned.execution.status;
    }

    await checkpointOperationStage(input.applicationId, operationKey, {
      stage: "interrupted",
      status,
      wakeUpsSuperseded: superseded.length,
      leaseReleased: released !== null,
    });
    await store.completeOperation(input.applicationId, operationKey, iso());
    return {
      executionId: input.executionId,
      status,
      wakeUpsSuperseded: superseded.length,
      leaseReleased: released !== null,
      replayed: false,
    };
  };

  // ----- governed termination -------------------------------------------------

  const terminateExecution = async (
    input: TerminateExecutionCommand,
    idempotencyKey: string,
  ): Promise<TerminateOutcome> => {
    requireKey(idempotencyKey);
    if (input.reason.length === 0) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "termination requires a non-empty reason (auditable provenance)",
      });
    }
    const fingerprint = canonicalFingerprint([
      "executions.longrunning.terminate",
      input.executionId,
      input.reason,
    ]);
    const operationKey = longRunningOperationKey(
      "terminate",
      executionScopedDiscriminator(input.executionId, idempotencyKey),
    );
    const record = await beginOperation(
      "terminate",
      input,
      input.actor.tenantId,
      idempotencyKey,
      fingerprint,
    );
    const stage = stageOf(record);
    if (record.status === "completed" && stage !== null) {
      return {
        executionId: input.executionId,
        status: String(stage.status),
        wakeUpsSuperseded: Number(stage.wakeUpsSuperseded ?? 0),
        leaseReleased: Boolean(stage.leaseReleased),
        replayed: true,
      };
    }
    const execution = await scopedExecution(
      input.applicationId,
      input.executionId,
      input.actor.tenantId,
    );
    if (isTerminal(execution.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `execution is already terminal in ${execution.status}; terminal states are final`,
        details: { executionId: input.executionId, status: execution.status },
      });
    }

    // 1. Revoke auto-resume (no wake fires after a termination request).
    const superseded = await store.markWakeUpsSuperseded({
      applicationId: input.applicationId,
      executionId: input.executionId,
      cause: `terminated: ${input.reason}`.slice(0, 500),
      now: iso(),
    });
    // 2. Force-release the lease (termination is human-authoritative).
    const released = await store.forceReleaseLease({
      applicationId: input.applicationId,
      executionId: input.executionId,
      cause: "terminated",
      now: iso(),
    });
    // 3. The governed terminal path: the frozen `cancel` command (legal
    //    from every non-terminal state; terminal rows are physically
    //    immutable afterwards).
    const transitioned = await executions.transition(
      {
        applicationId: input.applicationId,
        tenantId: input.actor.tenantId,
        actorId: input.actor.actorId,
        executionId: input.executionId,
        command: "cancel",
        reason: `governed termination: ${input.reason}`,
        ...(input.verificationResults === undefined
          ? {}
          : { verificationResults: input.verificationResults }),
      } as ExecutionTransitionCommand,
      `${operationKey}:cancel`,
    );

    await checkpointOperationStage(input.applicationId, operationKey, {
      stage: "terminated",
      status: transitioned.execution.status,
      wakeUpsSuperseded: superseded.length,
      leaseReleased: released !== null,
    });
    await store.completeOperation(input.applicationId, operationKey, iso());
    return {
      executionId: input.executionId,
      status: transitioned.execution.status,
      wakeUpsSuperseded: superseded.length,
      leaseReleased: released !== null,
      replayed: false,
    };
  };

  // ----- wake-ups -------------------------------------------------------------

  const scheduleWakeUp = async (
    input: ScheduleWakeUpCommand,
    idempotencyKey: string,
  ): Promise<WakeUpOutcome> => {
    requireKey(idempotencyKey);
    if (input.wakeKey.length === 0 || input.cause.length === 0) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "wake-up scheduling requires a non-empty wakeKey and cause",
      });
    }
    const fingerprint = canonicalFingerprint([
      "executions.longrunning.wakeup-schedule",
      input.executionId,
      input.wakeKey,
      input.cause,
      input.earliestWakeAt,
    ]);
    const operationKey = longRunningOperationKey(
      "wakeup-schedule",
      executionScopedDiscriminator(input.executionId, idempotencyKey),
    );
    const record = await beginOperation(
      "wakeup-schedule",
      input,
      input.actor.tenantId,
      idempotencyKey,
      fingerprint,
    );
    if (record.status === "completed") {
      const wakeUp = await store.getWakeUp(input.applicationId, input.executionId, input.wakeKey);
      return {
        executionId: input.executionId,
        wakeKey: input.wakeKey,
        status: wakeUp === null ? "scheduled" : wakeUp.status,
        earliestWakeAt: input.earliestWakeAt,
        replayed: true,
      };
    }
    const execution = await scopedExecution(
      input.applicationId,
      input.executionId,
      input.actor.tenantId,
    );
    if (isTerminal(execution.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `execution is terminal in ${execution.status}; no wake-up may be scheduled`,
        details: { executionId: input.executionId, status: execution.status },
      });
    }
    const { wakeUp } = await store.insertWakeUp({
      id: generateId(),
      applicationId: input.applicationId,
      tenantId: execution.tenantId,
      executionId: input.executionId,
      wakeKey: input.wakeKey,
      cause: input.cause,
      earliestWakeAt: input.earliestWakeAt,
      now: iso(),
    });
    await recordEvidence(
      {
        applicationId: input.applicationId,
        executionId: input.executionId,
        actor: input.actor,
        command: "wake-up-scheduled",
        cause: `wake-up ${input.wakeKey} scheduled for ${input.earliestWakeAt}`,
        reference: { wakeKey: input.wakeKey, earliestWakeAt: input.earliestWakeAt },
        payload: { wakeKey: input.wakeKey, cause: input.cause },
      },
      `wakeup:${input.executionId}:${input.wakeKey}`,
    );
    await store.completeOperation(input.applicationId, operationKey, iso());
    return {
      executionId: input.executionId,
      wakeKey: input.wakeKey,
      status: wakeUp.status,
      earliestWakeAt: wakeUp.earliestWakeAt,
      replayed: false,
    };
  };

  const applyWakeUps = async (input: ApplyWakeUpsCommand): Promise<ApplyWakeUpsOutcome> => {
    const due = await store.dueWakeUps(input.applicationId, iso());
    const applications: WakeUpApplicationAction[] = [];
    for (const wakeUp of due) {
      const operationKey = longRunningOperationKey(
        "wakeup-apply",
        executionScopedDiscriminator(wakeUp.executionId, `wake:${wakeUp.wakeKey}`),
      );
      const record = await beginOperation(
        "wakeup-apply",
        { applicationId: input.applicationId, executionId: wakeUp.executionId },
        input.actor.tenantId,
        `wake:${wakeUp.wakeKey}`,
        canonicalFingerprint([
          "executions.longrunning.wakeup-apply",
          wakeUp.executionId,
          wakeUp.wakeKey,
        ]),
      );
      if (record.status === "completed") {
        applications.push({
          action: "replayed",
          wakeKey: wakeUp.wakeKey,
          executionId: wakeUp.executionId,
        });
        continue;
      }
      const execution = await executions.getExecution(input.applicationId, wakeUp.executionId);
      if (execution === null || execution.tenantId !== input.actor.tenantId) {
        applications.push({
          action: "superseded",
          wakeKey: wakeUp.wakeKey,
          executionId: wakeUp.executionId,
          reason: "execution not found in this application",
        });
        continue;
      }
      if (isTerminal(execution.status)) {
        const supersededRow = await store.markWakeUpApplied({
          applicationId: input.applicationId,
          executionId: wakeUp.executionId,
          wakeKey: wakeUp.wakeKey,
          appliedOperationKey: operationKey,
          now: iso(),
        });
        void supersededRow;
        applications.push({
          action: "superseded",
          wakeKey: wakeUp.wakeKey,
          executionId: wakeUp.executionId,
          reason: `execution is terminal in ${execution.status}`,
        });
        continue;
      }
      if (execution.status === "RUNNING") {
        // Already awake: the wake is satisfied without a resume.
        await store.markWakeUpApplied({
          applicationId: input.applicationId,
          executionId: wakeUp.executionId,
          wakeKey: wakeUp.wakeKey,
          appliedOperationKey: operationKey,
          now: iso(),
        });
        await recordEvidence(
          {
            applicationId: input.applicationId,
            executionId: wakeUp.executionId,
            actor: input.actor,
            command: "wake-up-applied",
            cause: `wake-up ${wakeUp.wakeKey} applied (execution already RUNNING)`,
            reference: { wakeKey: wakeUp.wakeKey, cause: wakeUp.cause },
            payload: { wakeKey: wakeUp.wakeKey },
          },
          `wakeup-applied:${wakeUp.executionId}:${wakeUp.wakeKey}`,
        );
        await store.completeOperation(input.applicationId, operationKey, iso());
        applications.push({
          action: "already-running",
          wakeKey: wakeUp.wakeKey,
          executionId: wakeUp.executionId,
        });
        continue;
      }
      // The sleeping execution: apply the wake by resuming through the
      // SAME resume protocol (integrity, materiality, lease-free
      // platform resume). A typed rejection supersedes the wake with
      // the recorded reason (the schedule is never silently retried).
      try {
        await resumeExecution(
          {
            applicationId: input.applicationId,
            executionId: wakeUp.executionId,
            actor: input.actor,
            resumeFacts: await wakeResumeFacts(input.applicationId, wakeUp.executionId),
          },
          `wake:${wakeUp.wakeKey}`,
        );
      } catch (error) {
        if (error instanceof PlatformError) {
          await store.markWakeUpApplied({
            applicationId: input.applicationId,
            executionId: wakeUp.executionId,
            wakeKey: wakeUp.wakeKey,
            appliedOperationKey: operationKey,
            now: iso(),
          });
          applications.push({
            action: "superseded",
            wakeKey: wakeUp.wakeKey,
            executionId: wakeUp.executionId,
            reason: `${error.code}: ${error.message}`,
          });
          continue;
        }
        throw error;
      }
      await store.markWakeUpApplied({
        applicationId: input.applicationId,
        executionId: wakeUp.executionId,
        wakeKey: wakeUp.wakeKey,
        appliedOperationKey: operationKey,
        now: iso(),
      });
      await recordEvidence(
        {
          applicationId: input.applicationId,
          executionId: wakeUp.executionId,
          actor: input.actor,
          command: "wake-up-applied",
          cause: `wake-up ${wakeUp.wakeKey} applied (execution resumed)`,
          reference: { wakeKey: wakeUp.wakeKey, cause: wakeUp.cause },
          payload: { wakeKey: wakeUp.wakeKey },
        },
        `wakeup-applied:${wakeUp.executionId}:${wakeUp.wakeKey}`,
      );
      await store.completeOperation(input.applicationId, operationKey, iso());
      applications.push({
        action: "resumed",
        wakeKey: wakeUp.wakeKey,
        executionId: wakeUp.executionId,
      });
    }
    return { applications };
  };

  /**
   * The wake-driven resume runs under the checkpointed facts (the
   * schedule resumes what was paused — UNCHANGED facts, no
   * re-admission). No checkpoint => the wake supersedes (recorded).
   */
  const wakeResumeFacts = async (
    applicationId: string,
    executionId: string,
  ): Promise<ResumeFacts> => {
    const checkpoint = await store.latestCheckpoint(applicationId, executionId);
    if (checkpoint === null) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: "wake-up targets an execution without a durable checkpoint",
        details: { executionId },
      });
    }
    return materialFactsOf(checkpoint.contents);
  };

  // ----- the lease-guarded worker transition ---------------------------------

  const workerTransition = async (
    input: WorkerTransitionCommand,
    idempotencyKey: string,
  ): Promise<TransitionOutcome> => {
    requireKey(idempotencyKey);
    // The lease-validity guard BEFORE the delegated frozen transition:
    // a stale worker (expired / superseded / foreign) never commits a
    // lifecycle side effect through the worker surface.
    await guardLease(input.applicationId, input.command.executionId, input.worker);
    return executions.transition(input.command, idempotencyKey);
  };

  return {
    acquireLease,
    renewLease,
    releaseLease,
    recordCheckpoint,
    pauseExecution,
    resumeExecution,
    requestInterruption,
    terminateExecution,
    scheduleWakeUp,
    applyWakeUps,
    workerTransition,
    async getLease(applicationId, executionId) {
      return store.getLease(applicationId, executionId);
    },
    async getLatestCheckpoint(applicationId, executionId) {
      return store.latestCheckpoint(applicationId, executionId);
    },
    async listCheckpoints(applicationId, executionId) {
      return store.listCheckpoints(applicationId, executionId);
    },
    async listWakeUps(applicationId, executionId) {
      return store.listWakeUps(applicationId, executionId);
    },
  };
}

export type { EventEnvelope, LeaseReleaseCause };
