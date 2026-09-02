/**
 * SQL realtime store (deployments module adapter; WORK-024).
 *
 * The durable implementation of the `RealtimeStore` port over the
 * provider-neutral `DatabasePort` (migration
 * `0018_realtime_sessions.sql`). Physical invariants live in the
 * migration (session identity-core immutability, pinned plan version,
 * the frozen realtime status machine, monotonic channel epoch,
 * append-only channel journal, inbound idempotency UNIQUE, the
 * stale-callback freshness trigger); this adapter maps rows <-> domain
 * records and converges exactly like the WORK-023 SQL store:
 *
 *  - session insert: UNIQUE (application, idempotency_key) with
 *    fingerprint arbitration + the physical channel-coordinate UNIQUE;
 *  - `applyGuardedSessionMutation`: the single-row guarded UPDATE
 *    arbitrates concurrent mutations (first writer wins; duplicates
 *    converge on the committed row);
 *  - `appendChannelEvent`: ON CONFLICT (application, session, event_key) DO
 *    NOTHING + digest-checked convergence — the channel journal IS the
 *    inbound idempotency ledger (a duplicate inbound event converges on
 *    the committed row; a same-key/different-body insert fails closed);
 *  - every read is scope-filtered (application);
 *  - trigger-raised guard violations are mapped to the typed error
 *    taxonomy (the migration is defense-in-depth behind the service's
 *    own guards).
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type {
  RealtimeEventDirection,
  RealtimeEventKind,
  RealtimeEventRecord,
  RealtimeOperationCheckpoint,
  RealtimeOperationKind,
  RealtimeOperationRecord,
  RealtimeOperationStatus,
  RealtimeRouteClass,
  RealtimeSessionRecord,
  RealtimeSessionStatus,
} from "../domain/realtime";
import type {
  RealtimeEventAppendInput,
  RealtimeEventAppendOutcome,
  RealtimeOperationBeginInput,
  RealtimeOperationBeginOutcome,
  RealtimeSessionInsertInput,
  RealtimeSessionInsertOutcome,
  RealtimeSessionMutation,
  RealtimeSessionMutationOutcome,
  RealtimeStore,
} from "../ports/realtime-store";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Map migration-trigger guard violations to the typed taxonomy. */
function toTypedGuardError(error: unknown): PlatformError {
  const message = messageOf(error);
  if (message.includes("stale realtime callback")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "rt_events_channel_fresh_guard" },
    });
  }
  if (
    message.includes("terminal-immutable") ||
    message.includes("cannot move from status") ||
    message.includes("channel epoch must not regress") ||
    message.includes("cannot change channel reference") ||
    (message.includes("realtime session") && message.includes("inbound events are rejected"))
  ) {
    return new PlatformError({ code: "INVALID_STATE_TRANSITION", message });
  }
  if (message.includes("realtime_operations identity core is immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "rt_ops_core_guard" },
    });
  }
  if (message.includes("realtime operation") && message.includes("cannot move from status")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "rt_ops_lifecycle_guard" },
    });
  }
  if (message.includes("realtime_operations is terminal-immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "rt_ops_lifecycle_guard" },
    });
  }
  if (message.includes("realtime session") && message.includes("identity core is immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "rt_sessions_core_guard" },
    });
  }
  if (message.includes("append-only")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "rt_events_append_only_guard" },
    });
  }
  // The operations ledger's (application_id, tenant_id) FK: a claim for
  // a tenant that does not own the application IS a tenant-scope
  // violation (the claim is the first durable write of an operation).
  if (
    message.includes("realtime_operations") &&
    message.includes("violates foreign key constraint")
  ) {
    return new PlatformError({
      code: "TENANT_SCOPE_VIOLATION",
      message: "realtime operation claims require a tenant that owns the application",
      details: { guard: "rt_ops_tenant_fk", cause: message },
    });
  }
  return new PlatformError({
    code: "PROVIDER_ERROR",
    message: "realtime store guard rejection",
    details: { cause: message },
  });
}

interface SessionRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly deployment_id: string;
  readonly pinned_plan_id: string;
  readonly pinned_plan_version: number;
  readonly execution_id: string;
  readonly channel_kind: string;
  readonly channel_session_ref: string;
  readonly channel_epoch: number;
  readonly caller_ref: string | null;
  readonly status: string;
  readonly creation_fingerprint: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly closed_at: Date | string | null;
}

function toSession(row: SessionRow): RealtimeSessionRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    deploymentId: row.deployment_id,
    pinnedPlanId: row.pinned_plan_id,
    pinnedPlanVersion: row.pinned_plan_version,
    executionId: row.execution_id,
    channelKind: row.channel_kind as RealtimeSessionRecord["channelKind"],
    channelSessionRef: row.channel_session_ref,
    channelEpoch: row.channel_epoch,
    callerRef: row.caller_ref,
    status: row.status as RealtimeSessionStatus,
    creationFingerprint: row.creation_fingerprint,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    closedAt:
      row.closed_at === null
        ? null
        : row.closed_at instanceof Date
          ? row.closed_at.toISOString()
          : String(row.closed_at),
  };
}

const SESSION_COLUMNS = `id, application_id, tenant_id, deployment_id, pinned_plan_id,
    pinned_plan_version, execution_id, channel_kind, channel_session_ref, channel_epoch,
    caller_ref, status, creation_fingerprint, created_at, updated_at, closed_at`;

interface EventRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly session_id: string;
  readonly deployment_id: string;
  readonly kind: string;
  readonly direction: string;
  readonly event_key: string;
  readonly channel_session_ref: string;
  readonly channel_epoch: number;
  readonly execution_id: string | null;
  readonly ledger_sequence: number | null;
  readonly route_class: string | null;
  readonly cause: string | null;
  readonly payload_ref: string | null;
  readonly payload_preview: string | null;
  readonly actor_id: string;
  readonly event_seq: string | number;
  readonly body_digest: string;
  readonly created_at: Date | string;
}

function toEvent(row: EventRow): RealtimeEventRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    deploymentId: row.deployment_id,
    kind: row.kind as RealtimeEventKind,
    direction: row.direction as RealtimeEventDirection,
    eventKey: row.event_key,
    channelSessionRef: row.channel_session_ref,
    channelEpoch: row.channel_epoch,
    executionId: row.execution_id,
    ledgerSequence: row.ledger_sequence === null ? null : Number(row.ledger_sequence),
    routeClass: row.route_class === null ? null : (row.route_class as RealtimeRouteClass),
    cause: row.cause,
    payloadRef: row.payload_ref,
    payloadPreview: row.payload_preview,
    actorId: row.actor_id,
    eventSeq: Number(row.event_seq),
    bodyDigest: row.body_digest,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

const EVENT_COLUMNS = `id, application_id, tenant_id, session_id, deployment_id, kind, direction,
    event_key, channel_session_ref, channel_epoch, execution_id, ledger_sequence, route_class,
    cause, payload_ref, payload_preview, actor_id, event_seq, body_digest, created_at`;

interface OperationRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly session_id: string | null;
  readonly deployment_id: string;
  readonly execution_id: string | null;
  readonly operation_kind: string;
  readonly operation_key: string;
  readonly status: string;
  readonly attempts: number | string;
  readonly checkpoint: RealtimeOperationCheckpoint | null;
  readonly failure_reason: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly completed_at: Date | string | null;
}

function toOperation(row: OperationRow): RealtimeOperationRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    deploymentId: row.deployment_id,
    executionId: row.execution_id,
    operationKind: row.operation_kind as RealtimeOperationKind,
    operationKey: row.operation_key,
    status: row.status as RealtimeOperationStatus,
    attempts: Number(row.attempts),
    checkpoint: row.checkpoint,
    failureReason: row.failure_reason,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    completedAt:
      row.completed_at === null
        ? null
        : row.completed_at instanceof Date
          ? row.completed_at.toISOString()
          : String(row.completed_at),
  };
}

const OPERATION_COLUMNS = `id, application_id, tenant_id, session_id, deployment_id, execution_id,
    operation_kind, operation_key, status, attempts, checkpoint, failure_reason, created_at,
    updated_at, completed_at`;

export class SqlRealtimeStore implements RealtimeStore {
  constructor(private readonly db: DatabasePort) {}

  async insertSession(input: RealtimeSessionInsertInput): Promise<RealtimeSessionInsertOutcome> {
    try {
      const result = await this.db.execute<SessionRow>({
        sql: `INSERT INTO deployments.realtime_sessions (
    ${SESSION_COLUMNS}, created_by, idempotency_key)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'live', $12, $13, $13, NULL, $15, $14)
RETURNING ${SESSION_COLUMNS}`,
        parameters: [
          input.sessionId,
          input.applicationId,
          input.tenantId,
          input.deploymentId,
          input.pinnedPlanId,
          input.pinnedPlanVersion,
          input.executionId,
          input.channelKind,
          input.channelSessionRef,
          input.channelEpoch,
          input.callerRef,
          input.creationFingerprint,
          input.createdAt,
          input.idempotencyKey,
          input.createdBy,
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "created", sessionId: row.id };
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        const message = messageOf(error);
        if (message.includes("rt_sessions_key_unique")) {
          // Idempotent replay: converge on the committed row after
          // fingerprint arbitration.
          const existing = await this.findSessionByIdempotencyKey(
            input.applicationId,
            input.idempotencyKey,
          );
          if (existing !== null) {
            if (existing.creation_fingerprint !== input.creationFingerprint) {
              throw new PlatformError({
                code: "IDEMPOTENCY_KEY_REUSED",
                message:
                  "realtime session idempotency key already exists with a different creation fingerprint",
                details: { sessionId: existing.id },
              });
            }
            return { status: "converged", sessionId: existing.id };
          }
        }
        if (message.includes("rt_sessions_channel_unique")) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "the rail channel reference is already bound to another realtime session",
            details: { channelSessionRef: input.channelSessionRef },
          });
        }
      }
      throw toTypedGuardError(error);
    }
    throw new PlatformError({ code: "PROVIDER_ERROR", message: "session insert returned no row" });
  }

  async findSession(applicationId: string, sessionId: string) {
    const result = await this.db.execute<SessionRow>({
      sql: `SELECT ${SESSION_COLUMNS} FROM deployments.realtime_sessions
WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, sessionId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toSession(row);
  }

  async findSessionByChannel(
    applicationId: string,
    channelSessionRef: string,
    channelEpoch: number,
  ) {
    const result = await this.db.execute<SessionRow>({
      sql: `SELECT ${SESSION_COLUMNS} FROM deployments.realtime_sessions
WHERE application_id = $1 AND channel_session_ref = $2 AND channel_epoch = $3`,
      parameters: [applicationId, channelSessionRef, channelEpoch],
    });
    const row = result.rows[0];
    return row === undefined ? null : toSession(row);
  }

  async applyGuardedSessionMutation(
    input: RealtimeSessionMutation,
  ): Promise<RealtimeSessionMutationOutcome> {
    try {
      const result = await this.db.execute<SessionRow>({
        sql: `UPDATE deployments.realtime_sessions
SET status = $1,
    channel_session_ref = COALESCE($2, channel_session_ref),
    channel_epoch = COALESCE($3, channel_epoch),
    updated_at = $4,
    closed_at = COALESCE($5, closed_at)
WHERE application_id = $6 AND id = $7 AND status = $8
  AND ($9::text IS NULL OR channel_session_ref = $9)
  AND ($10::int IS NULL OR channel_epoch = $10)
RETURNING ${SESSION_COLUMNS}`,
        parameters: [
          input.toStatus,
          input.toChannelRef,
          input.toChannelEpoch,
          new Date().toISOString(),
          input.closedAt,
          input.applicationId,
          input.sessionId,
          input.expectedStatus,
          input.expectedChannelRef,
          input.expectedChannelEpoch,
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "applied", session: toSession(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // First writer already moved the row (or the guard disagrees):
    // converge when the committed state equals the target; fail closed
    // when it does not.
    const current = await this.findSessionBySessionId(input.applicationId, input.sessionId);
    if (current === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `realtime session ${input.sessionId} not found in this application`,
      });
    }
    const converged =
      current.status === input.toStatus &&
      (input.toChannelRef === null || current.channelSessionRef === input.toChannelRef) &&
      (input.toChannelEpoch === null || current.channelEpoch === input.toChannelEpoch);
    if (converged) {
      return { status: "converged", session: current };
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `realtime session ${input.sessionId} guard disagreed: row is ${current.status}@channel(${current.channelSessionRef},${current.channelEpoch}); the guarded mutation expected ${input.expectedStatus} (first writer wins; replays converge on the committed state)`,
    });
  }

  async appendChannelEvent(input: RealtimeEventAppendInput): Promise<RealtimeEventAppendOutcome> {
    try {
      const result = await this.db.execute<EventRow>({
        sql: `INSERT INTO deployments.realtime_events (
    id, application_id, tenant_id, session_id, deployment_id, kind, direction, event_key,
    channel_session_ref, channel_epoch, execution_id, ledger_sequence, route_class, cause,
    payload_ref, payload_preview, actor_id, body_digest, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
ON CONFLICT (application_id, session_id, event_key) DO NOTHING
RETURNING ${EVENT_COLUMNS}`,
        parameters: [
          input.eventId,
          input.applicationId,
          input.tenantId,
          input.sessionId,
          input.deploymentId,
          input.kind,
          input.direction,
          input.eventKey,
          input.channelSessionRef,
          input.channelEpoch,
          input.executionId,
          input.ledgerSequence,
          input.routeClass,
          input.cause,
          input.payloadRef,
          input.payloadPreview,
          input.actorId,
          input.bodyDigest,
          input.createdAt,
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "appended", event: toEvent(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // The conflict path: converge on the committed row when the body
    // digest matches; fail closed when it does not (same key, different
    // body — a poisoned replay).
    const existing = await this.findEventByKey(
      input.applicationId,
      input.sessionId,
      input.eventKey,
    );
    if (existing !== null) {
      if (existing.bodyDigest !== input.bodyDigest) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "realtime event key already exists with a different body",
          details: { eventKey: input.eventKey },
        });
      }
      return { status: "converged", event: existing };
    }
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "realtime event insert returned no row",
    });
  }

  async listEvents(applicationId: string, sessionId: string) {
    const result = await this.db.execute<EventRow>({
      sql: `SELECT ${EVENT_COLUMNS} FROM deployments.realtime_events
WHERE application_id = $1 AND session_id = $2 ORDER BY event_seq`,
      parameters: [applicationId, sessionId],
    });
    return result.rows.map(toEvent);
  }

  // -- the durable, recoverable operation state (PR #46 correction) --

  async beginRealtimeOperation(
    input: RealtimeOperationBeginInput,
  ): Promise<RealtimeOperationBeginOutcome> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `INSERT INTO deployments.realtime_operations (
    ${OPERATION_COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 1, NULL, NULL, $9, $9, NULL)
ON CONFLICT (application_id, operation_key) DO NOTHING
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [
          input.operationId,
          input.applicationId,
          input.tenantId,
          input.sessionId,
          input.deploymentId,
          input.executionId,
          input.operationKind,
          input.operationKey,
          input.createdAt,
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "begun", record: toOperation(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // The conflict path: the operation row already exists — bump the
    // attempts ledger (PENDING rows only; a terminal row is immutable,
    // so a completed/failed operation replays without an attempt bump).
    const existing = await this.findRealtimeOperation(input.applicationId, input.operationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "realtime operation begin returned no row",
        details: { operationKey: input.operationKey },
      });
    }
    if (existing.status !== "pending") {
      return { status: "existing", record: existing };
    }
    try {
      const bumped = await this.db.execute<OperationRow>({
        sql: `UPDATE deployments.realtime_operations
SET attempts = attempts + 1, updated_at = $3
WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [input.applicationId, input.operationKey, input.createdAt],
      });
      const row = bumped.rows[0];
      if (row !== undefined) {
        return { status: "existing", record: toOperation(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // A concurrent terminal move won the race: replay the committed row.
    const committed = await this.findRealtimeOperation(input.applicationId, input.operationKey);
    if (committed === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "realtime operation row disappeared after begin",
        details: { operationKey: input.operationKey },
      });
    }
    return { status: "existing", record: committed };
  }

  async recordRealtimeOperationCheckpoint(
    applicationId: string,
    operationKey: string,
    checkpoint: RealtimeOperationCheckpoint,
    updatedAt: string,
  ): Promise<RealtimeOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE deployments.realtime_operations
SET checkpoint = $3::jsonb, updated_at = $4
WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [applicationId, operationKey, JSON.stringify(checkpoint), updatedAt],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return toOperation(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.requireOperation(applicationId, operationKey);
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `realtime operation ${operationKey} is ${existing.status}; a checkpoint is writable only while pending`,
    });
  }

  async completeRealtimeOperation(
    applicationId: string,
    operationKey: string,
    completedAt: string,
  ): Promise<RealtimeOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE deployments.realtime_operations
SET status = 'completed', completed_at = $3, updated_at = $3
WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [applicationId, operationKey, completedAt],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return toOperation(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.requireOperation(applicationId, operationKey);
    if (existing.status === "completed") {
      // Idempotent convergence: the durable outcome already exists.
      return existing;
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `realtime operation ${operationKey} is ${existing.status}; a failed operation cannot be completed`,
      details: { failureReason: existing.failureReason },
    });
  }

  async failRealtimeOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    failedAt: string,
  ): Promise<RealtimeOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE deployments.realtime_operations
SET status = 'failed', failure_reason = $3, updated_at = $4
WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [applicationId, operationKey, reason.slice(0, 512), failedAt],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return toOperation(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.requireOperation(applicationId, operationKey);
    if (existing.status === "failed") {
      // Idempotent convergence: the recorded failure already exists.
      return existing;
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `realtime operation ${operationKey} is ${existing.status}; a completed operation cannot be failed`,
      details: { completedAt: existing.completedAt },
    });
  }

  async findRealtimeOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<RealtimeOperationRecord | null> {
    const result = await this.db.execute<OperationRow>({
      sql: `SELECT ${OPERATION_COLUMNS} FROM deployments.realtime_operations
WHERE application_id = $1 AND operation_key = $2`,
      parameters: [applicationId, operationKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : toOperation(row);
  }

  private async requireOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<RealtimeOperationRecord> {
    const existing = await this.findRealtimeOperation(applicationId, operationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `realtime operation ${operationKey} not found in this application`,
      });
    }
    return existing;
  }

  async findSessionByStartKey(applicationId: string, idempotencyKey: string) {
    const result = await this.db.execute<SessionRow>({
      sql: `SELECT ${SESSION_COLUMNS} FROM deployments.realtime_sessions
WHERE application_id = $1 AND idempotency_key = $2`,
      parameters: [applicationId, idempotencyKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : toSession(row);
  }

  private async findSessionByIdempotencyKey(applicationId: string, idempotencyKey: string) {
    const result = await this.db.execute<
      SessionRow & { idempotency_key: string; creation_fingerprint: string }
    >({
      sql: `SELECT ${SESSION_COLUMNS}, idempotency_key, creation_fingerprint FROM deployments.realtime_sessions
WHERE application_id = $1 AND idempotency_key = $2`,
      parameters: [applicationId, idempotencyKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : row;
  }

  private async findSessionBySessionId(applicationId: string, sessionId: string) {
    const result = await this.db.execute<SessionRow>({
      sql: `SELECT ${SESSION_COLUMNS} FROM deployments.realtime_sessions
WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, sessionId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toSession(row);
  }

  private async findEventByKey(applicationId: string, sessionId: string, eventKey: string) {
    const result = await this.db.execute<EventRow>({
      sql: `SELECT ${EVENT_COLUMNS} FROM deployments.realtime_events
WHERE application_id = $1 AND session_id = $2 AND event_key = $3`,
      parameters: [applicationId, sessionId, eventKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : toEvent(row);
  }
}
