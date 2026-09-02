/**
 * SQL adapter for the long-running execution extension (WORK-028).
 *
 * Bridges `LongRunningExecutionStore` to the provider-neutral platform
 * `DatabasePort` (migration 0022 tables). No driver/SDK import happens
 * here — `pg` is owned by the platform DB layer.
 *
 * The executions SINGLE-WRITE-PATH discipline is preserved structurally:
 * this adapter never touches `executions.executions` or
 * `executions.execution_events` — lifecycle movement and ledger
 * evidence stay on the frozen path (the transition service +
 * recordStepEvent through the public executions service). Only the
 * WORK-028 extension tables are written here.
 *
 * Convergence mechanics (the physical discipline of migration 0022):
 *   * checkpoint inserts converge on the per-execution sequence
 *     (UNIQUE + gapless count-gate); a same-sequence different-digest
 *     insert fails closed `IDEMPOTENCY_KEY_REUSED`;
 *   * lease acquisition fails CLOSED on a live-held lease (the guarded
 *     epoch-advancing UPDATE only matches free rows — concurrent
 *     acquisitions serialize on the row lock and the loser observes
 *     the winner's live lease);
 *   * renew/release require the exact (owner, epoch) claim;
 *   * wake-up application is write-once (scheduled -> applied |
 *     superseded, terminal-immutable);
 *   * operation claims converge on (application, operation_key) with
 *     fingerprint arbitration and the monotonic attempts ledger.
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type { CheckpointContents, CheckpointRecord } from "../domain/checkpoint";
import type { LeaseRecord, LeaseReleaseCause } from "../domain/lease";
import type {
  LongRunningOperationKind,
  LongRunningOperationRecord,
  LongRunningOperationStatus,
} from "../domain/longrunning";
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

type Executor = Pick<DatabasePort, "execute">;

function first<T>(rows: readonly T[]): T | undefined {
  return rows.length > 0 ? rows[0] : undefined;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Map physical guard rejections to the typed error taxonomy. */
function toTypedGuardError(error: unknown): PlatformError {
  const message = messageOf(error);
  if (message.includes("executions.execution_checkpoints is append-only")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "lr_checkpoints_append_only" },
    });
  }
  if (message.includes("checkpoint sequence must be gapless")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "lr_checkpoint_sequence_gate" },
    });
  }
  if (
    message.includes("checkpoint sequence") &&
    message.includes("already exists with a different content digest")
  ) {
    return new PlatformError({
      code: "IDEMPOTENCY_KEY_REUSED",
      message,
      details: { guard: "lr_checkpoint_sequence_gate" },
    });
  }
  if (message.includes("is terminal; checkpoints are append-only evidence")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "lr_checkpoint_terminal_gate" },
    });
  }
  if (message.includes("lease epoch must not regress")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "lr_lease_epoch_monotonic" },
    });
  }
  if (message.includes("lease owner cannot change within epoch")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "lr_lease_owner_guard" },
    });
  }
  if (message.includes("lease is released; it can only be re-acquired")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "lr_lease_release_guard" },
    });
  }
  if (message.includes("lease expiry must not shorten")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "lr_lease_expiry_guard" },
    });
  }
  if (message.includes("is terminal; no lease may be acquired")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "lr_lease_terminal_gate" },
    });
  }
  if (message.includes("execution_wakeups identity core is immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "lr_wakeups_core_guard" },
    });
  }
  if (message.includes("execution_wakeups is terminal-immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "lr_wakeups_lifecycle_guard" },
    });
  }
  if (message.includes("wake-up") && message.includes("cannot move from status")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "lr_wakeups_lifecycle_guard" },
    });
  }
  if (message.includes("execution_operations identity core is immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "lr_ops_core_guard" },
    });
  }
  if (message.includes("execution_operations is terminal-immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "lr_ops_lifecycle_guard" },
    });
  }
  if (message.includes("long-running operation") && message.includes("cannot move from status")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "lr_ops_lifecycle_guard" },
    });
  }
  // The tenant FKs of the extension tables: a write for a tenant that
  // does not own the application IS a tenant-scope violation.
  if (message.includes("violates foreign key constraint") && message.includes("tenant")) {
    return new PlatformError({
      code: "TENANT_SCOPE_VIOLATION",
      message: "long-running state writes require a tenant that owns the application",
      details: { guard: "lr_tenant_fk", cause: message },
    });
  }
  return new PlatformError({
    code: "PROVIDER_ERROR",
    message: "long-running execution store guard rejection",
    details: { cause: message },
  });
}

// ---------------------------------------------------------------------------
// Row mappings
// ---------------------------------------------------------------------------

interface CheckpointRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly checkpoint_sequence: number;
  readonly plan_id: string;
  readonly plan_revision: number;
  readonly context_artifacts: string[];
  readonly last_event_position: number;
  readonly resource_class: string;
  readonly environment_id: string | null;
  readonly environment_spec_digest: string | null;
  readonly required_capabilities: string[];
  readonly max_cost_micro_usd: string | null;
  readonly content_digest: string;
  readonly recorded_by: string;
  readonly created_at: Date | string;
}

const CHECKPOINT_COLUMNS = `id, application_id, tenant_id, execution_id, checkpoint_sequence, plan_id,
plan_revision, context_artifacts, last_event_position, resource_class, environment_id,
environment_spec_digest, required_capabilities, max_cost_micro_usd, content_digest, recorded_by, created_at`;

function toCheckpoint(row: CheckpointRow): CheckpointRecord {
  const contents: CheckpointContents = {
    executionId: row.execution_id,
    planId: row.plan_id,
    planRevision: Number(row.plan_revision),
    contextArtifactRefs: row.context_artifacts ?? [],
    lastEventPosition: Number(row.last_event_position),
    resourceClass: row.resource_class,
    environmentId: row.environment_id,
    environmentSpecDigest: row.environment_spec_digest,
    requiredCapabilities: row.required_capabilities ?? [],
    maxCostMicroUsd: row.max_cost_micro_usd,
  };
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    checkpointSequence: Number(row.checkpoint_sequence),
    contents,
    contentDigest: row.content_digest,
    recordedBy: row.recorded_by,
    createdAt: iso(row.created_at),
  };
}

interface LeaseRow {
  readonly execution_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly owner_id: string;
  readonly epoch: number;
  readonly acquired_at: Date | string;
  readonly expires_at: Date | string;
  readonly last_heartbeat_at: Date | string;
  readonly heartbeat_count: number;
  readonly released_at: Date | string | null;
  readonly release_cause: string | null;
}

const LEASE_COLUMNS = `execution_id, application_id, tenant_id, owner_id, epoch, acquired_at, expires_at,
last_heartbeat_at, heartbeat_count, released_at, release_cause, updated_at`;

function toLease(row: LeaseRow): LeaseRecord {
  return {
    executionId: row.execution_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    ownerId: row.owner_id,
    epoch: Number(row.epoch),
    acquiredAt: iso(row.acquired_at),
    expiresAt: iso(row.expires_at),
    lastHeartbeatAt: iso(row.last_heartbeat_at),
    heartbeatCount: Number(row.heartbeat_count),
    releasedAt: row.released_at === null ? null : iso(row.released_at),
    releaseCause: row.release_cause,
  };
}

interface WakeUpRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly wake_key: string;
  readonly cause: string;
  readonly earliest_wake_at: Date | string;
  readonly status: WakeUpStatus;
  readonly applied_at: Date | string | null;
  readonly applied_operation_key: string | null;
  readonly supersede_cause: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const WAKEUP_COLUMNS = `id, application_id, tenant_id, execution_id, wake_key, cause, earliest_wake_at,
status, applied_at, applied_operation_key, supersede_cause, created_at, updated_at`;

function toWakeUp(row: WakeUpRow): WakeUpRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    wakeKey: row.wake_key,
    cause: row.cause,
    earliestWakeAt: iso(row.earliest_wake_at),
    status: row.status,
    appliedAt: row.applied_at === null ? null : iso(row.applied_at),
    appliedOperationKey: row.applied_operation_key,
    supersedeCause: row.supersede_cause,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

interface OperationRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly operation_kind: LongRunningOperationKind;
  readonly operation_key: string;
  readonly request_fingerprint: string;
  readonly status: LongRunningOperationStatus;
  readonly attempts: number;
  readonly stage: Record<string, unknown> | null;
  readonly failure_reason: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly completed_at: Date | string | null;
}

const OPERATION_COLUMNS = `id, application_id, tenant_id, execution_id, operation_kind, operation_key,
request_fingerprint, status, attempts, stage, failure_reason, created_at, updated_at, completed_at`;

function toOperation(row: OperationRow): LongRunningOperationRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    operationKind: row.operation_kind,
    operationKey: row.operation_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    attempts: Number(row.attempts),
    stage: row.stage ?? null,
    failureReason: row.failure_reason,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
  };
}

function expiryOf(now: string, ttlMs: number): string {
  return new Date(new Date(now).getTime() + ttlMs).toISOString();
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class SqlLongRunningExecutionStore implements LongRunningExecutionStore {
  constructor(private readonly db: Executor) {}

  // -- checkpoints ----------------------------------------------------------

  async insertCheckpoint(input: InsertCheckpointInput): Promise<CheckpointInsertOutcome> {
    try {
      const result = await this.db.execute<CheckpointRow>({
        sql: `INSERT INTO executions.execution_checkpoints
  (id, application_id, tenant_id, execution_id, checkpoint_sequence, plan_id, plan_revision,
   context_artifacts, last_event_position, resource_class, environment_id,
   environment_spec_digest, required_capabilities, max_cost_micro_usd, content_digest,
   recorded_by, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17)
ON CONFLICT (execution_id, checkpoint_sequence) DO NOTHING
RETURNING ${CHECKPOINT_COLUMNS}`,
        parameters: [
          input.id,
          input.applicationId,
          input.tenantId,
          input.executionId,
          input.checkpointSequence,
          input.contents.planId,
          input.contents.planRevision,
          JSON.stringify(input.contents.contextArtifactRefs),
          input.contents.lastEventPosition,
          input.contents.resourceClass,
          input.contents.environmentId,
          input.contents.environmentSpecDigest,
          JSON.stringify(input.contents.requiredCapabilities),
          input.contents.maxCostMicroUsd,
          input.contentDigest,
          input.recordedBy,
          input.now,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return { status: "appended", checkpoint: toCheckpoint(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // Conflict: the sequence is already taken — same digest converges,
    // a different digest is key reuse (fail closed).
    const existing = await this.requireCheckpoint(
      input.applicationId,
      input.executionId,
      input.checkpointSequence,
    );
    if (existing.contentDigest !== input.contentDigest) {
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
    return { status: "converged", checkpoint: existing };
  }

  async getCheckpoint(
    applicationId: string,
    executionId: string,
    checkpointId: string,
  ): Promise<CheckpointRecord | null> {
    const result = await this.db.execute<CheckpointRow>({
      sql: `SELECT ${CHECKPOINT_COLUMNS} FROM executions.execution_checkpoints
WHERE application_id = $1 AND execution_id = $2 AND id = $3`,
      parameters: [applicationId, executionId, checkpointId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toCheckpoint(row);
  }

  async findCheckpointByDigest(
    applicationId: string,
    executionId: string,
    contentDigest: string,
  ): Promise<CheckpointRecord | null> {
    const result = await this.db.execute<CheckpointRow>({
      sql: `SELECT ${CHECKPOINT_COLUMNS} FROM executions.execution_checkpoints
WHERE application_id = $1 AND execution_id = $2 AND content_digest = $3
ORDER BY checkpoint_sequence LIMIT 1`,
      parameters: [applicationId, executionId, contentDigest],
    });
    const row = first(result.rows);
    return row === undefined ? null : toCheckpoint(row);
  }

  async latestCheckpoint(
    applicationId: string,
    executionId: string,
  ): Promise<CheckpointRecord | null> {
    const result = await this.db.execute<CheckpointRow>({
      sql: `SELECT ${CHECKPOINT_COLUMNS} FROM executions.execution_checkpoints
WHERE application_id = $1 AND execution_id = $2 ORDER BY checkpoint_sequence DESC LIMIT 1`,
      parameters: [applicationId, executionId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toCheckpoint(row);
  }

  async listCheckpoints(
    applicationId: string,
    executionId: string,
  ): Promise<readonly CheckpointRecord[]> {
    const result = await this.db.execute<CheckpointRow>({
      sql: `SELECT ${CHECKPOINT_COLUMNS} FROM executions.execution_checkpoints
WHERE application_id = $1 AND execution_id = $2 ORDER BY checkpoint_sequence`,
      parameters: [applicationId, executionId],
    });
    return result.rows.map(toCheckpoint);
  }

  private async requireCheckpoint(
    applicationId: string,
    executionId: string,
    checkpointSequence: number,
  ): Promise<CheckpointRecord> {
    const result = await this.db.execute<CheckpointRow>({
      sql: `SELECT ${CHECKPOINT_COLUMNS} FROM executions.execution_checkpoints
WHERE application_id = $1 AND execution_id = $2 AND checkpoint_sequence = $3`,
      parameters: [applicationId, executionId, checkpointSequence],
    });
    const row = first(result.rows);
    if (row === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "checkpoint row disappeared after convergence conflict",
        details: { executionId, checkpointSequence },
      });
    }
    return toCheckpoint(row);
  }

  // -- lease ----------------------------------------------------------------

  async acquireLease(input: AcquireLeaseInput): Promise<LeaseAcquireOutcome> {
    const expiresAt = expiryOf(input.now, input.ttlMs);
    // 0. Same-owner convergence (the crash-resume re-acquisition): the
    //    owner already holds the LIVE lease — return it unchanged.
    const held = await this.db.execute<LeaseRow>({
      sql: `SELECT ${LEASE_COLUMNS} FROM executions.execution_leases
WHERE execution_id = $1 AND application_id = $2 AND owner_id = $3
  AND released_at IS NULL AND expires_at > $4`,
      parameters: [input.executionId, input.applicationId, input.ownerId, input.now],
    });
    const heldRow = first(held.rows);
    if (heldRow !== undefined) {
      return { status: "acquired", lease: toLease(heldRow), fresh: false };
    }
    // 1. The fresh-row insert (no lease row exists for this execution).
    try {
      const inserted = await this.db.execute<LeaseRow>({
        sql: `INSERT INTO executions.execution_leases
  (execution_id, application_id, tenant_id, owner_id, epoch, acquired_at, expires_at,
   last_heartbeat_at, heartbeat_count, released_at, release_cause, updated_at)
VALUES ($1, $2, $3, $4, 1, $5, $6, $5, 0, NULL, NULL, $5)
ON CONFLICT (execution_id) DO NOTHING
RETURNING ${LEASE_COLUMNS}`,
        parameters: [
          input.executionId,
          input.applicationId,
          input.tenantId,
          input.ownerId,
          input.now,
          expiresAt,
        ],
      });
      const row = first(inserted.rows);
      if (row !== undefined) {
        return { status: "acquired", lease: toLease(row), fresh: true };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // 2. A row exists: acquire only a FREE lease (released or expired),
    //    advancing the epoch. Concurrent acquires serialize on the row
    //    lock; the loser's guarded UPDATE matches nothing and observes
    //    the winner's live lease (fail closed).
    try {
      const stolen = await this.db.execute<LeaseRow>({
        sql: `UPDATE executions.execution_leases
SET owner_id = $3, epoch = epoch + 1, acquired_at = $4, expires_at = $5,
    last_heartbeat_at = $4, heartbeat_count = 0, released_at = NULL, release_cause = NULL,
    updated_at = $4
WHERE execution_id = $1 AND application_id = $2
  AND (released_at IS NOT NULL OR expires_at <= $4)
RETURNING ${LEASE_COLUMNS}`,
        parameters: [input.executionId, input.applicationId, input.ownerId, input.now, expiresAt],
      });
      const row = first(stolen.rows);
      if (row !== undefined) {
        return { status: "acquired", lease: toLease(row), fresh: false };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // 3. Live-held by someone else: refuse (fail closed).
    const existing = await this.getLease(input.applicationId, input.executionId);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "lease row disappeared during acquisition",
        details: { executionId: input.executionId },
      });
    }
    return {
      status: "refused",
      lease: existing,
      reason: `the execution lease is live-held by ${existing.ownerId} (epoch ${existing.epoch}) until ${existing.expiresAt}; lease conflicts fail closed`,
    };
  }

  async renewLease(input: RenewLeaseInput): Promise<LeaseRecord> {
    const newExpiry = expiryOf(input.now, input.ttlMs);
    try {
      const result = await this.db.execute<LeaseRow>({
        sql: `UPDATE executions.execution_leases
SET expires_at = GREATEST(expires_at, $5), last_heartbeat_at = $4, heartbeat_count = heartbeat_count + 1,
    updated_at = $4
WHERE execution_id = $1 AND application_id = $2 AND owner_id = $3 AND epoch = $6 AND released_at IS NULL
  AND expires_at > $4
RETURNING ${LEASE_COLUMNS}`,
        parameters: [
          input.executionId,
          input.applicationId,
          input.ownerId,
          input.now,
          newExpiry,
          input.epoch,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toLease(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    throw await this.leaseMismatch(input.applicationId, input.executionId, {
      ownerId: input.ownerId,
      epoch: input.epoch,
      at: input.now,
    });
  }

  async releaseLease(input: ReleaseLeaseInput): Promise<LeaseRecord | null> {
    try {
      const result = await this.db.execute<LeaseRow>({
        sql: `UPDATE executions.execution_leases
SET released_at = $4, release_cause = $5, updated_at = $4
WHERE execution_id = $1 AND application_id = $2 AND owner_id = $3 AND epoch = $6 AND released_at IS NULL
RETURNING ${LEASE_COLUMNS}`,
        parameters: [
          input.executionId,
          input.applicationId,
          input.ownerId,
          input.now,
          input.cause,
          input.epoch,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toLease(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // Convergence: already released by this claim -> the released row;
    // live under a different (owner, epoch) claim -> nothing to release.
    const existing = await this.getLease(input.applicationId, input.executionId);
    if (existing === null) {
      return null;
    }
    if (existing.releasedAt !== null) {
      return existing;
    }
    return null;
  }

  async forceReleaseLease(input: ForceReleaseLeaseInput): Promise<LeaseRecord | null> {
    try {
      const result = await this.db.execute<LeaseRow>({
        sql: `UPDATE executions.execution_leases
SET released_at = $3, release_cause = $4, updated_at = $3
WHERE execution_id = $1 AND application_id = $2 AND released_at IS NULL
RETURNING ${LEASE_COLUMNS}`,
        parameters: [input.executionId, input.applicationId, input.now, input.cause],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toLease(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    return await this.getLease(input.applicationId, input.executionId);
  }

  async getLease(applicationId: string, executionId: string): Promise<LeaseRecord | null> {
    const result = await this.db.execute<LeaseRow>({
      sql: `SELECT ${LEASE_COLUMNS} FROM executions.execution_leases
WHERE application_id = $1 AND execution_id = $2`,
      parameters: [applicationId, executionId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toLease(row);
  }

  private async leaseMismatch(
    applicationId: string,
    executionId: string,
    claim: { ownerId: string; epoch: number; at: string },
  ): Promise<PlatformError> {
    // Classification from the CURRENT row (typed, fail-closed).
    const current = await this.getLease(applicationId, executionId);
    if (current === null) {
      return new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: "no execution lease is held to renew",
        details: { executionId, claim },
      });
    }
    if (current.epoch !== claim.epoch) {
      return new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `lease epoch mismatch: the execution lease is at epoch ${current.epoch}; a stale worker at epoch ${claim.epoch} is not authoritative`,
        details: { executionId, currentEpoch: current.epoch, workerEpoch: claim.epoch },
      });
    }
    if (current.ownerId !== claim.ownerId) {
      return new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `the execution lease is held by another owner (${current.ownerId}); lease conflicts fail closed`,
        details: { executionId, leaseOwner: current.ownerId },
      });
    }
    if (current.releasedAt !== null) {
      return new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `the execution lease was released (${current.releaseCause ?? "released"})`,
        details: { executionId },
      });
    }
    return new PlatformError({
      code: "EXPIRED",
      message: `the execution lease expired at ${current.expiresAt}; stale workers cannot commit side effects`,
      details: { executionId, expiresAt: current.expiresAt },
    });
  }

  // -- wake-ups -------------------------------------------------------------

  async insertWakeUp(input: InsertWakeUpInput): Promise<WakeUpInsertOutcome> {
    try {
      const result = await this.db.execute<WakeUpRow>({
        sql: `INSERT INTO executions.execution_wakeups
  (id, application_id, tenant_id, execution_id, wake_key, cause, earliest_wake_at, status,
   applied_at, applied_operation_key, supersede_cause, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled', NULL, NULL, NULL, $8, $8)
ON CONFLICT (application_id, execution_id, wake_key) DO NOTHING
RETURNING ${WAKEUP_COLUMNS}`,
        parameters: [
          input.id,
          input.applicationId,
          input.tenantId,
          input.executionId,
          input.wakeKey,
          input.cause,
          input.earliestWakeAt,
          input.now,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return { status: "appended", wakeUp: toWakeUp(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.getWakeUp(input.applicationId, input.executionId, input.wakeKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "wake-up row disappeared after convergence conflict",
        details: { executionId: input.executionId, wakeKey: input.wakeKey },
      });
    }
    return { status: "converged", wakeUp: existing };
  }

  async dueWakeUps(applicationId: string, at: string): Promise<readonly WakeUpRecord[]> {
    const result = await this.db.execute<WakeUpRow>({
      sql: `SELECT ${WAKEUP_COLUMNS} FROM executions.execution_wakeups
WHERE application_id = $1 AND status = 'scheduled' AND earliest_wake_at <= $2
ORDER BY earliest_wake_at, id`,
      parameters: [applicationId, at],
    });
    return result.rows.map(toWakeUp);
  }

  async markWakeUpApplied(input: MarkWakeUpAppliedInput): Promise<WakeUpRecord> {
    try {
      const result = await this.db.execute<WakeUpRow>({
        sql: `UPDATE executions.execution_wakeups
SET status = 'applied', applied_at = $4, applied_operation_key = $5, updated_at = $4
WHERE application_id = $1 AND execution_id = $2 AND wake_key = $3 AND status = 'scheduled'
RETURNING ${WAKEUP_COLUMNS}`,
        parameters: [
          input.applicationId,
          input.executionId,
          input.wakeKey,
          input.now,
          input.appliedOperationKey,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toWakeUp(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.getWakeUp(input.applicationId, input.executionId, input.wakeKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "wake-up row disappeared during application",
        details: { executionId: input.executionId, wakeKey: input.wakeKey },
      });
    }
    return existing;
  }

  async markWakeUpsSuperseded(input: MarkWakeUpsSupersededInput): Promise<readonly WakeUpRecord[]> {
    try {
      const result = await this.db.execute<WakeUpRow>({
        sql: `UPDATE executions.execution_wakeups
SET status = 'superseded', supersede_cause = $3, updated_at = $4
WHERE application_id = $1 AND execution_id = $2 AND status = 'scheduled'
RETURNING ${WAKEUP_COLUMNS}`,
        parameters: [input.applicationId, input.executionId, input.cause, input.now],
      });
      return result.rows.map(toWakeUp);
    } catch (error) {
      throw toTypedGuardError(error);
    }
  }

  async getWakeUp(
    applicationId: string,
    executionId: string,
    wakeKey: string,
  ): Promise<WakeUpRecord | null> {
    const result = await this.db.execute<WakeUpRow>({
      sql: `SELECT ${WAKEUP_COLUMNS} FROM executions.execution_wakeups
WHERE application_id = $1 AND execution_id = $2 AND wake_key = $3`,
      parameters: [applicationId, executionId, wakeKey],
    });
    const row = first(result.rows);
    return row === undefined ? null : toWakeUp(row);
  }

  async listWakeUps(applicationId: string, executionId: string): Promise<readonly WakeUpRecord[]> {
    const result = await this.db.execute<WakeUpRow>({
      sql: `SELECT ${WAKEUP_COLUMNS} FROM executions.execution_wakeups
WHERE application_id = $1 AND execution_id = $2 ORDER BY earliest_wake_at, id`,
      parameters: [applicationId, executionId],
    });
    return result.rows.map(toWakeUp);
  }

  // -- the durable, recoverable operation state ------------------------------

  async beginOperation(input: BeginOperationInput): Promise<BeginOperationOutcome> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `INSERT INTO executions.execution_operations
  (id, application_id, tenant_id, execution_id, operation_kind, operation_key,
   request_fingerprint, status, attempts, stage, failure_reason, created_at, updated_at, completed_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 1, NULL, NULL, $8, $8, NULL)
ON CONFLICT (application_id, operation_key) DO NOTHING
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [
          input.id,
          input.applicationId,
          input.tenantId,
          input.executionId,
          input.operationKind,
          input.operationKey,
          input.requestFingerprint,
          input.now,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return { status: "begun", record: toOperation(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // Conflict: the operation row exists — fingerprint arbitration, then
    // the attempts bump (PENDING rows only; terminal rows replay).
    const existing = await this.findOperation(input.applicationId, input.operationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "long-running operation begin returned no row",
        details: { operationKey: input.operationKey },
      });
    }
    if (existing.requestFingerprint !== input.requestFingerprint) {
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message:
          "long-running operation key already exists with a different request fingerprint (same key, different body)",
        details: { operationKey: input.operationKey, operationKind: input.operationKind },
      });
    }
    if (existing.status !== "pending") {
      return { status: "existing", record: existing };
    }
    try {
      const bumped = await this.db.execute<OperationRow>({
        sql: `UPDATE executions.execution_operations
SET attempts = attempts + 1, updated_at = $3
WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [input.applicationId, input.operationKey, input.now],
      });
      const row = first(bumped.rows);
      if (row !== undefined) {
        return { status: "existing", record: toOperation(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const committed = await this.findOperation(input.applicationId, input.operationKey);
    if (committed === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "long-running operation row disappeared after begin",
        details: { operationKey: input.operationKey },
      });
    }
    return { status: "existing", record: committed };
  }

  async recordOperationStage(
    input: RecordOperationStageInput,
  ): Promise<LongRunningOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE executions.execution_operations
SET stage = $3::jsonb, updated_at = $4
WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [
          input.applicationId,
          input.operationKey,
          JSON.stringify(input.stage),
          input.now,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toOperation(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.requireOperation(input.applicationId, input.operationKey);
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `long-running operation ${input.operationKey} is ${existing.status}; a stage checkpoint is writable only while pending`,
    });
  }

  async completeOperation(
    applicationId: string,
    operationKey: string,
    now: string,
  ): Promise<LongRunningOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE executions.execution_operations
SET status = 'completed', completed_at = $3, updated_at = $3
WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [applicationId, operationKey, now],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toOperation(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.requireOperation(applicationId, operationKey);
    if (existing.status === "completed") {
      return existing;
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `long-running operation ${operationKey} is ${existing.status}; a failed operation cannot be completed`,
      details: { failureReason: existing.failureReason },
    });
  }

  async failOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    now: string,
  ): Promise<LongRunningOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE executions.execution_operations
SET status = 'failed', failure_reason = $3, updated_at = $4
WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [applicationId, operationKey, reason.slice(0, 512), now],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toOperation(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.requireOperation(applicationId, operationKey);
    if (existing.status === "failed") {
      return existing;
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `long-running operation ${operationKey} is ${existing.status}; a completed operation cannot be failed`,
    });
  }

  async findOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<LongRunningOperationRecord | null> {
    const result = await this.db.execute<OperationRow>({
      sql: `SELECT ${OPERATION_COLUMNS} FROM executions.execution_operations
WHERE application_id = $1 AND operation_key = $2`,
      parameters: [applicationId, operationKey],
    });
    const row = first(result.rows);
    return row === undefined ? null : toOperation(row);
  }

  async pendingWakeUpApplies(
    applicationId: string,
  ): Promise<readonly LongRunningOperationRecord[]> {
    // The lr_ops_pending_scan partial index backs this recovery scan; the
    // deterministic (created_at, id) order mirrors the due-ordering
    // discipline (a stable replay order across processes).
    const result = await this.db.execute<OperationRow>({
      sql: `SELECT ${OPERATION_COLUMNS} FROM executions.execution_operations
WHERE application_id = $1 AND operation_kind = 'wakeup-apply' AND status = 'pending'
ORDER BY created_at, id`,
      parameters: [applicationId],
    });
    return result.rows.map(toOperation);
  }

  private async requireOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<LongRunningOperationRecord> {
    const existing = await this.findOperation(applicationId, operationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "long-running operation row disappeared",
        details: { operationKey },
      });
    }
    return existing;
  }
}

export type { LeaseReleaseCause };
