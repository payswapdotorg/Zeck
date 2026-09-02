/**
 * In-memory long-running execution store (unit-test infrastructure;
 * WORK-028).
 *
 * Faithful to the durable contract the SQL adapter implements over
 * migration 0022:
 *  - checkpoints converge on the per-execution gapless sequence and a
 *    same-sequence different-digest insert fails closed
 *    (`IDEMPOTENCY_KEY_REUSED`);
 *  - lease acquisition fails CLOSED on a live-held lease; re-acquisition
 *    of a free lease advances the epoch; renew/release require the exact
 *    (owner, epoch) claim and classify mismatches typed;
 *  - wake-up application is write-once (applied/superseded terminal);
 *  - operation claims converge on the stable key with fingerprint
 *    arbitration and the monotonic attempts ledger; stage checkpoints
 *    are writable only while PENDING.
 *
 * Same-key calls are NOT interleaved here (single-threaded store) — the
 * real-PostgreSQL suites own the physical concurrency proofs
 * (the WORK-002..004 precedent).
 */

import { PlatformError } from "../../../shared/errors";
import type { CheckpointContents, CheckpointRecord } from "../domain/checkpoint";
import type { LeaseRecord, LeaseReleaseCause } from "../domain/lease";
import type { LongRunningOperationKind, LongRunningOperationRecord } from "../domain/longrunning";
import type { WakeUpRecord, WakeUpStatus } from "../domain/wakeup";
import type {
  AcquireLeaseInput,
  BeginOperationInput,
  BeginOperationOutcome,
  CheckpointInsertOutcome,
  ForceReleaseLeaseInput,
  InsertCheckpointInput,
  InsertWakeUpInput,
  LeaseAcquireOutcome,
  LongRunningExecutionStore,
  MarkWakeUpAppliedInput,
  MarkWakeUpsSupersededInput,
  RecordOperationStageInput,
  ReleaseLeaseInput,
  RenewLeaseInput,
  WakeUpInsertOutcome,
} from "../ports/long-running-store";

function expiryOf(now: string, ttlMs: number): string {
  return new Date(new Date(now).getTime() + ttlMs).toISOString();
}

export class InMemoryLongRunningExecutionStore implements LongRunningExecutionStore {
  readonly checkpoints = new Map<string, CheckpointRecord>();
  readonly leases = new Map<string, LeaseRecord>();
  readonly wakeUps = new Map<string, WakeUpRecord>();
  readonly operations = new Map<string, LongRunningOperationRecord>();

  private wakeKey(applicationId: string, executionId: string, wakeKey: string): string {
    return `${applicationId}|${executionId}|${wakeKey}`;
  }

  private opKey(applicationId: string, operationKey: string): string {
    return `${applicationId}|${operationKey}`;
  }

  // -- checkpoints ----------------------------------------------------------

  async insertCheckpoint(input: InsertCheckpointInput): Promise<CheckpointInsertOutcome> {
    const existingAtSequence = [...this.checkpoints.values()].find(
      (record) =>
        record.executionId === input.executionId &&
        record.checkpointSequence === input.checkpointSequence,
    );
    if (existingAtSequence !== undefined) {
      // The physical ON CONFLICT (execution_id, checkpoint_sequence)
      // convergence: same digest = the same row; different digest = key
      // reuse (fail closed).
      if (existingAtSequence.contentDigest !== input.contentDigest) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message:
            "checkpoint sequence already exists with a different content digest (same key, different body)",
          details: {
            executionId: input.executionId,
            checkpointSequence: input.checkpointSequence,
          },
        });
      }
      return { status: "converged", checkpoint: existingAtSequence };
    }
    const expected = this.checkpointCount(input.executionId) + 1;
    if (input.checkpointSequence !== expected) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `execution ${input.executionId} checkpoint sequence must be gapless (expected ${expected}, got ${input.checkpointSequence})`,
        details: { expected, got: input.checkpointSequence },
      });
    }
    const record: CheckpointRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      executionId: input.executionId,
      checkpointSequence: input.checkpointSequence,
      contents: input.contents,
      contentDigest: input.contentDigest,
      recordedBy: input.recordedBy,
      createdAt: input.now,
    };
    this.checkpoints.set(input.id, record);
    return { status: "appended", checkpoint: record };
  }

  async getCheckpoint(
    applicationId: string,
    executionId: string,
    checkpointId: string,
  ): Promise<CheckpointRecord | null> {
    const record = this.checkpoints.get(checkpointId);
    return record !== undefined &&
      record.applicationId === applicationId &&
      record.executionId === executionId
      ? record
      : null;
  }

  async latestCheckpoint(
    applicationId: string,
    executionId: string,
  ): Promise<CheckpointRecord | null> {
    const all = this.listByExecution(applicationId, executionId);
    return all.length === 0 ? null : (all[all.length - 1] ?? null);
  }

  async listCheckpoints(
    applicationId: string,
    executionId: string,
  ): Promise<readonly CheckpointRecord[]> {
    return this.listByExecution(applicationId, executionId);
  }

  private listByExecution(applicationId: string, executionId: string): CheckpointRecord[] {
    return [...this.checkpoints.values()]
      .filter(
        (record) => record.applicationId === applicationId && record.executionId === executionId,
      )
      .sort((a, b) => a.checkpointSequence - b.checkpointSequence);
  }

  private checkpointCount(executionId: string): number {
    return [...this.checkpoints.values()].filter((record) => record.executionId === executionId)
      .length;
  }

  /** Test seam: tamper with a stored checkpoint's digest (corruption proof). */
  tamperCheckpointDigest(checkpointId: string, digest: string): void {
    const record = this.checkpoints.get(checkpointId);
    if (record === undefined) {
      throw new Error(`unknown checkpoint ${checkpointId}`);
    }
    this.checkpoints.set(checkpointId, { ...record, contentDigest: digest });
  }

  /** Test seam: tamper with a stored checkpoint's contents (corruption proof). */
  tamperCheckpointContents(checkpointId: string, contents: Partial<CheckpointContents>): void {
    const record = this.checkpoints.get(checkpointId);
    if (record === undefined) {
      throw new Error(`unknown checkpoint ${checkpointId}`);
    }
    this.checkpoints.set(checkpointId, {
      ...record,
      contents: { ...record.contents, ...contents } as CheckpointContents,
    });
  }

  // -- lease ----------------------------------------------------------------

  async acquireLease(input: AcquireLeaseInput): Promise<LeaseAcquireOutcome> {
    const existing = this.leases.get(input.executionId);
    if (existing === undefined) {
      const lease: LeaseRecord = {
        executionId: input.executionId,
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        ownerId: input.ownerId,
        epoch: 1,
        acquiredAt: input.now,
        expiresAt: expiryOf(input.now, input.ttlMs),
        lastHeartbeatAt: input.now,
        heartbeatCount: 0,
        releasedAt: null,
        releaseCause: null,
      };
      this.leases.set(input.executionId, lease);
      return { status: "acquired", lease, fresh: true };
    }
    const live = existing.releasedAt === null && existing.expiresAt > input.now;
    if (live && existing.ownerId === input.ownerId) {
      // Same-owner convergence (the crash-resume re-acquisition): the
      // owner already holds the live lease — return it unchanged.
      return { status: "acquired", lease: existing, fresh: false };
    }
    if (live) {
      return {
        status: "refused",
        lease: existing,
        reason: `the execution lease is live-held by ${existing.ownerId} (epoch ${existing.epoch}) until ${existing.expiresAt}; lease conflicts fail closed`,
      };
    }
    const lease: LeaseRecord = {
      executionId: input.executionId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      epoch: existing.epoch + 1,
      acquiredAt: input.now,
      expiresAt: expiryOf(input.now, input.ttlMs),
      lastHeartbeatAt: input.now,
      heartbeatCount: 0,
      releasedAt: null,
      releaseCause: null,
    };
    this.leases.set(input.executionId, lease);
    return { status: "acquired", lease, fresh: false };
  }

  async renewLease(input: RenewLeaseInput): Promise<LeaseRecord> {
    const lease = this.leases.get(input.executionId);
    if (lease === undefined || lease.applicationId !== input.applicationId) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: "no execution lease is held to renew",
        details: { executionId: input.executionId },
      });
    }
    if (lease.epoch !== input.epoch) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `lease epoch mismatch: the execution lease is at epoch ${lease.epoch}; a stale worker at epoch ${input.epoch} is not authoritative`,
        details: { currentEpoch: lease.epoch, workerEpoch: input.epoch },
      });
    }
    if (lease.ownerId !== input.ownerId) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `the execution lease is held by another owner (${lease.ownerId}); lease conflicts fail closed`,
        details: { leaseOwner: lease.ownerId },
      });
    }
    if (lease.releasedAt !== null) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `the execution lease was released (${lease.releaseCause ?? "released"})`,
      });
    }
    if (lease.expiresAt <= input.now) {
      throw new PlatformError({
        code: "EXPIRED",
        message: `the execution lease expired at ${lease.expiresAt}; stale workers cannot commit side effects`,
        details: { expiresAt: lease.expiresAt },
      });
    }
    const renewed: LeaseRecord = {
      ...lease,
      expiresAt:
        expiryOf(input.now, input.ttlMs) > lease.expiresAt
          ? expiryOf(input.now, input.ttlMs)
          : lease.expiresAt,
      lastHeartbeatAt: input.now,
      heartbeatCount: lease.heartbeatCount + 1,
    };
    this.leases.set(input.executionId, renewed);
    return renewed;
  }

  async releaseLease(input: ReleaseLeaseInput): Promise<LeaseRecord | null> {
    const lease = this.leases.get(input.executionId);
    if (lease === undefined || lease.applicationId !== input.applicationId) {
      return null;
    }
    if (lease.releasedAt !== null) {
      return lease;
    }
    if (lease.epoch !== input.epoch || lease.ownerId !== input.ownerId) {
      return null;
    }
    const released: LeaseRecord = {
      ...lease,
      releasedAt: input.now,
      releaseCause: input.cause,
    };
    this.leases.set(input.executionId, released);
    return released;
  }

  async forceReleaseLease(input: ForceReleaseLeaseInput): Promise<LeaseRecord | null> {
    const lease = this.leases.get(input.executionId);
    if (lease === undefined || lease.applicationId !== input.applicationId) {
      return null;
    }
    if (lease.releasedAt !== null) {
      return lease;
    }
    const released: LeaseRecord = {
      ...lease,
      releasedAt: input.now,
      releaseCause: input.cause,
    };
    this.leases.set(input.executionId, released);
    return released;
  }

  async getLease(applicationId: string, executionId: string): Promise<LeaseRecord | null> {
    const lease = this.leases.get(executionId);
    return lease !== undefined && lease.applicationId === applicationId ? lease : null;
  }

  // -- wake-ups -------------------------------------------------------------

  async insertWakeUp(input: InsertWakeUpInput): Promise<WakeUpInsertOutcome> {
    const key = this.wakeKey(input.applicationId, input.executionId, input.wakeKey);
    const existing = this.wakeUps.get(key);
    if (existing !== undefined) {
      return { status: "converged", wakeUp: existing };
    }
    const record: WakeUpRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      executionId: input.executionId,
      wakeKey: input.wakeKey,
      cause: input.cause,
      earliestWakeAt: input.earliestWakeAt,
      status: "scheduled",
      appliedAt: null,
      appliedOperationKey: null,
      supersedeCause: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.wakeUps.set(key, record);
    return { status: "appended", wakeUp: record };
  }

  async dueWakeUps(applicationId: string, at: string): Promise<readonly WakeUpRecord[]> {
    return [...this.wakeUps.values()]
      .filter(
        (record) =>
          record.applicationId === applicationId &&
          record.status === "scheduled" &&
          record.earliestWakeAt <= at,
      )
      .sort((a, b) => {
        if (a.earliestWakeAt !== b.earliestWakeAt) {
          return a.earliestWakeAt < b.earliestWakeAt ? -1 : 1;
        }
        return a.id < b.id ? -1 : 1;
      });
  }

  async markWakeUpApplied(input: MarkWakeUpAppliedInput): Promise<WakeUpRecord> {
    const key = this.wakeKey(input.applicationId, input.executionId, input.wakeKey);
    const record = this.wakeUps.get(key);
    if (record === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "wake-up row disappeared during application",
        details: { wakeKey: input.wakeKey },
      });
    }
    if (record.status !== "scheduled") {
      return record;
    }
    const applied: WakeUpRecord = {
      ...record,
      status: "applied",
      appliedAt: input.now,
      appliedOperationKey: input.appliedOperationKey,
      updatedAt: input.now,
    };
    this.wakeUps.set(key, applied);
    return applied;
  }

  async markWakeUpsSuperseded(input: MarkWakeUpsSupersededInput): Promise<readonly WakeUpRecord[]> {
    const superseded: WakeUpRecord[] = [];
    for (const [key, record] of this.wakeUps) {
      if (
        record.applicationId === input.applicationId &&
        record.executionId === input.executionId &&
        record.status === "scheduled"
      ) {
        const next: WakeUpRecord = {
          ...record,
          status: "superseded",
          supersedeCause: input.cause,
          updatedAt: input.now,
        };
        this.wakeUps.set(key, next);
        superseded.push(next);
      }
    }
    return superseded;
  }

  async getWakeUp(
    applicationId: string,
    executionId: string,
    wakeKey: string,
  ): Promise<WakeUpRecord | null> {
    return this.wakeUps.get(this.wakeKey(applicationId, executionId, wakeKey)) ?? null;
  }

  async listWakeUps(applicationId: string, executionId: string): Promise<readonly WakeUpRecord[]> {
    return [...this.wakeUps.values()]
      .filter(
        (record) => record.applicationId === applicationId && record.executionId === executionId,
      )
      .sort((a, b) => {
        if (a.earliestWakeAt !== b.earliestWakeAt) {
          return a.earliestWakeAt < b.earliestWakeAt ? -1 : 1;
        }
        return a.id < b.id ? -1 : 1;
      });
  }

  // -- the durable, recoverable operation state ------------------------------

  async beginOperation(input: BeginOperationInput): Promise<BeginOperationOutcome> {
    const key = this.opKey(input.applicationId, input.operationKey);
    const existing = this.operations.get(key);
    if (existing !== undefined) {
      if (existing.requestFingerprint !== input.requestFingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message:
            "long-running operation key already exists with a different request fingerprint (same key, different body)",
          details: { operationKey: input.operationKey },
        });
      }
      if (existing.status !== "pending") {
        return { status: "existing", record: existing };
      }
      const bumped: LongRunningOperationRecord = {
        ...existing,
        attempts: existing.attempts + 1,
        updatedAt: input.now,
      };
      this.operations.set(key, bumped);
      return { status: "existing", record: bumped };
    }
    const record: LongRunningOperationRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      executionId: input.executionId,
      operationKind: input.operationKind,
      operationKey: input.operationKey,
      requestFingerprint: input.requestFingerprint,
      status: "pending",
      attempts: 1,
      stage: null,
      failureReason: null,
      createdAt: input.now,
      updatedAt: input.now,
      completedAt: null,
    };
    this.operations.set(key, record);
    return { status: "begun", record };
  }

  async recordOperationStage(
    input: RecordOperationStageInput,
  ): Promise<LongRunningOperationRecord> {
    const key = this.opKey(input.applicationId, input.operationKey);
    const record = this.operations.get(key);
    if (record === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "long-running operation row disappeared",
        details: { operationKey: input.operationKey },
      });
    }
    if (record.status !== "pending") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `long-running operation ${input.operationKey} is ${record.status}; a stage checkpoint is writable only while pending`,
      });
    }
    const staged: LongRunningOperationRecord = {
      ...record,
      stage: input.stage,
      updatedAt: input.now,
    };
    this.operations.set(key, staged);
    return staged;
  }

  async completeOperation(
    applicationId: string,
    operationKey: string,
    now: string,
  ): Promise<LongRunningOperationRecord> {
    const key = this.opKey(applicationId, operationKey);
    const record = this.operations.get(key);
    if (record === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "long-running operation row disappeared",
        details: { operationKey },
      });
    }
    if (record.status === "completed") {
      return record;
    }
    if (record.status === "failed") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `long-running operation ${operationKey} is failed; a failed operation cannot be completed`,
      });
    }
    const completed: LongRunningOperationRecord = {
      ...record,
      status: "completed",
      completedAt: now,
      updatedAt: now,
    };
    this.operations.set(key, completed);
    return completed;
  }

  async failOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    now: string,
  ): Promise<LongRunningOperationRecord> {
    const key = this.opKey(applicationId, operationKey);
    const record = this.operations.get(key);
    if (record === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "long-running operation row disappeared",
        details: { operationKey },
      });
    }
    if (record.status === "failed") {
      return record;
    }
    if (record.status === "completed") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `long-running operation ${operationKey} is completed; a completed operation cannot be failed`,
      });
    }
    const failed: LongRunningOperationRecord = {
      ...record,
      status: "failed",
      failureReason: reason.slice(0, 512),
      updatedAt: now,
    };
    this.operations.set(key, failed);
    return failed;
  }

  async findOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<LongRunningOperationRecord | null> {
    return this.operations.get(this.opKey(applicationId, operationKey)) ?? null;
  }
}

export type { LeaseReleaseCause, LongRunningOperationKind, WakeUpStatus };
