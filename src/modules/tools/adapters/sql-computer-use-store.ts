/**
 * SQL adapter for the governed computer-use fabric (WORK-027).
 *
 * Bridges `ComputerUseStore` to the provider-neutral platform
 * `DatabasePort` (migration 0023 tables). No driver/SDK import happens
 * here — `pg` is owned by the platform DB layer.
 *
 * The tools SINGLE-WRITE-PATH discipline is preserved structurally: this
 * adapter never touches `executions.executions` or
 * `executions.execution_events` — lifecycle movement and ledger evidence
 * stay on the frozen path (the executions transition service +
 * recordStepEvent through the tools module's `ExecutionLedger` port).
 * Only the WORK-027 computer-use tables are written here.
 *
 * Convergence mechanics (the physical discipline of migration 0023):
 *   * session inserts converge on the (application, session_key) UNIQUE
 *     with request-fingerprint arbitration; guarded status moves are
 *     expected-status-gated UPDATEs (first writer wins, duplicates
 *     converge on the committed row);
 *   * escalation inserts converge on the (application, session, to_mode)
 *     UNIQUE behind the convergence-aware gapless sequence gate;
 *   * action inserts converge on the (application, session, action_key)
 *     UNIQUE with input-digest arbitration; finalization is a guarded
 *     dispatching → terminal UPDATE; the ledger bindings are write-once;
 *   * observation inserts converge on the convergence-aware gapless
 *     sequence gate (same sequence + same digest converges; different
 *     digest fails closed typed);
 *   * operation claims converge on (application, operation_key) with
 *     fingerprint arbitration and the monotonic attempts ledger; the
 *     stage checkpoint and terminal outcomes move PENDING rows only.
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type {
  ComputerUseActionRecord,
  ComputerUseEscalationRecord,
  ComputerUseObservationRecord,
  ComputerUseOperationRecord,
  ComputerUseRouteEvidence,
  ComputerUseSessionRecord,
  ComputerUseSessionStatus,
} from "../domain/computer-use";
import type {
  ComputerUseActionFinalizeInput,
  ComputerUseActionInsertInput,
  ComputerUseActionLedgerBinding,
  ComputerUseEscalationInsertInput,
  ComputerUseObservationInsertInput,
  ComputerUseSessionInsertInput,
  ComputerUseSessionPatch,
  ComputerUseSessionStatusMutation,
  ComputerUseStore,
} from "../ports/computer-use-store";

type Executor = Pick<DatabasePort, "execute">;

function first<T>(rows: readonly T[]): T | undefined {
  return rows.length > 0 ? rows[0] : undefined;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map physical guard rejections to the typed error taxonomy. */
function toTypedGuardError(error: unknown): PlatformError {
  const message = messageOf(error);
  if (message.includes("computer-use sessions are inserted active or denied only")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "cu_sessions_insert_gate" },
    });
  }
  if (message.includes("no active computer-use session may be created on it")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "cu_sessions_insert_gate" },
    });
  }
  if (message.includes("computer_use_sessions identity core is immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "cu_sessions_core_guard" },
    });
  }
  if (message.includes("denied computer-use session is terminal-immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "cu_sessions_core_guard" },
    });
  }
  if (message.includes("computer-use session") && message.includes("is terminal-immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "cu_sessions_lifecycle_guard" },
    });
  }
  if (message.includes("escalation ladder only ascends")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "cu_sessions_lifecycle_guard" },
    });
  }
  if (message.includes("escalation sequence must be gapless")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "cu_escalations_sequence_gate" },
    });
  }
  if (message.includes("escalations require an active session")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "cu_escalations_sequence_gate" },
    });
  }
  if (
    message.includes("escalation sequence") &&
    message.includes("already exists with a different target mode")
  ) {
    return new PlatformError({
      code: "IDEMPOTENCY_KEY_REUSED",
      message,
      details: { guard: "cu_escalations_sequence_gate" },
    });
  }
  if (message.includes("action sequence must be gapless")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "cu_actions_sequence_gate" },
    });
  }
  if (message.includes("actions require an active session")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "cu_actions_sequence_gate" },
    });
  }
  if (message.includes("computer_use_actions identity core is immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "cu_actions_lifecycle_guard" },
    });
  }
  if (message.includes("computer_use_actions is terminal-immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "cu_actions_lifecycle_guard" },
    });
  }
  if (
    message.includes("observation sequence") &&
    message.includes("already exists with a different content digest")
  ) {
    return new PlatformError({
      code: "IDEMPOTENCY_KEY_REUSED",
      message,
      details: { guard: "cu_observations_sequence_gate" },
    });
  }
  if (message.includes("observation sequence must be gapless")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "cu_observations_sequence_gate" },
    });
  }
  if (message.includes("observations require an active session")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "cu_observations_sequence_gate" },
    });
  }
  if (message.includes("computer_use_operations identity core is immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "cu_ops_core_guard" },
    });
  }
  if (message.includes("computer_use_operations is terminal-immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "cu_ops_lifecycle_guard" },
    });
  }
  if (message.includes("computer-use operation") && message.includes("cannot move from status")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "cu_ops_lifecycle_guard" },
    });
  }
  if (message.includes("does not exist in application")) {
    return new PlatformError({
      code: "TENANT_SCOPE_VIOLATION",
      message,
      details: { guard: "cu_existence_gate", cause: message },
    });
  }
  // The tenant FKs of the extension tables: a write for a tenant that
  // does not own the application IS a tenant-scope violation.
  if (message.includes("violates foreign key constraint") && message.includes("tenant")) {
    return new PlatformError({
      code: "TENANT_SCOPE_VIOLATION",
      message: "computer-use state writes require a tenant that owns the application",
      details: { guard: "cu_tenant_fk", cause: message },
    });
  }
  return new PlatformError({
    code: "PROVIDER_ERROR",
    message: "computer-use store guard rejection",
    details: { cause: message },
  });
}

// ---------------------------------------------------------------------------
// Row mappings
// ---------------------------------------------------------------------------

interface SessionRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly session_key: string;
  readonly request_fingerprint: string;
  readonly task_kind: string;
  readonly status: string;
  readonly initial_mode: string;
  readonly current_mode: string;
  readonly route_evidence: ComputerUseRouteEvidence;
  readonly admission: ComputerUseSessionRecord["admission"];
  readonly mode_context: ComputerUseSessionRecord["modeContext"];
  readonly environment_ref: string | null;
  readonly environment_opened_mode: string | null;
  readonly denial_class: string | null;
  readonly denial_reason: string | null;
  readonly escalation_count: number;
  readonly usage_micro_usd: string;
  readonly requested_at: Date | string;
  readonly activated_at: Date | string | null;
  readonly terminal_at: Date | string | null;
  readonly terminal_cause: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const SESSION_COLUMNS = `id, application_id, tenant_id, execution_id, session_key, request_fingerprint, task_kind, status, initial_mode, current_mode, route_evidence, admission, mode_context, environment_ref, environment_opened_mode, denial_class, denial_reason, escalation_count, usage_micro_usd, requested_at, activated_at, terminal_at, terminal_cause, created_at, updated_at`;

function toSessionRecord(row: SessionRow): ComputerUseSessionRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    sessionKey: row.session_key,
    requestFingerprint: row.request_fingerprint,
    taskKind: row.task_kind as ComputerUseSessionRecord["taskKind"],
    status: row.status as ComputerUseSessionStatus,
    initialMode: row.initial_mode as ComputerUseSessionRecord["initialMode"],
    currentMode: row.current_mode as ComputerUseSessionRecord["currentMode"],
    routeEvidence: row.route_evidence,
    admission: row.admission,
    modeContext: row.mode_context,
    environmentRef: row.environment_ref,
    environmentOpenedMode: (row.environment_opened_mode ??
      null) as ComputerUseSessionRecord["environmentOpenedMode"],
    denialClass: (row.denial_class ?? null) as ComputerUseSessionRecord["denialClass"],
    denialReason: row.denial_reason,
    escalationCount: row.escalation_count,
    usageMicroUsd: row.usage_micro_usd,
    requestedAt: iso(row.requested_at),
    activatedAt: row.activated_at === null ? null : iso(row.activated_at),
    terminalAt: row.terminal_at === null ? null : iso(row.terminal_at),
    terminalCause: row.terminal_cause,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

interface EscalationRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly session_id: string;
  readonly execution_id: string;
  readonly escalation_sequence: number;
  readonly from_mode: string;
  readonly to_mode: string;
  readonly reason_code: string;
  readonly reason_detail: string;
  readonly insufficiency_digest: string;
  readonly capability_id: string;
  readonly admitted_at: Date | string;
  readonly ledger_sequence: number | null;
}

function toEscalationRecord(row: EscalationRow): ComputerUseEscalationRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    executionId: row.execution_id,
    sequence: row.escalation_sequence,
    fromMode: row.from_mode as ComputerUseEscalationRecord["fromMode"],
    toMode: row.to_mode as ComputerUseEscalationRecord["toMode"],
    reasonCode: row.reason_code,
    reasonDetail: row.reason_detail,
    insufficiencyDigest: row.insufficiency_digest,
    capabilityId: row.capability_id,
    admittedAt: iso(row.admitted_at),
    ledgerSequence: row.ledger_sequence,
  };
}

interface ActionRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly session_id: string;
  readonly execution_id: string;
  readonly action_key: string;
  readonly action_sequence: number;
  readonly mode: string;
  readonly action_type: string;
  readonly target: string;
  readonly side_effect: string;
  readonly status: string;
  readonly capability_id: string;
  readonly failure_class: string | null;
  readonly failure_message: string | null;
  readonly input_digest: string;
  readonly result_digest: string | null;
  readonly usage_micro_usd: string | null;
  readonly environment_ref: string | null;
  readonly sandbox_execution_id: string | null;
  readonly observation_sequences: number[];
  readonly requested_at: Date | string;
  readonly dispatched_at: Date | string | null;
  readonly completed_at: Date | string | null;
  readonly duration_ms: number | null;
  readonly ledger_requested_sequence: number | null;
  readonly ledger_result_sequence: number | null;
}

const ACTION_COLUMNS = `id, application_id, tenant_id, session_id, execution_id, action_key, action_sequence, mode, action_type, target, side_effect, status, capability_id, failure_class, failure_message, input_digest, result_digest, usage_micro_usd, environment_ref, sandbox_execution_id, observation_sequences, requested_at, dispatched_at, completed_at, duration_ms, ledger_requested_sequence, ledger_result_sequence`;

function toActionRecord(row: ActionRow): ComputerUseActionRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    executionId: row.execution_id,
    actionKey: row.action_key,
    sequence: row.action_sequence,
    mode: row.mode as ComputerUseActionRecord["mode"],
    actionType: row.action_type as ComputerUseActionRecord["actionType"],
    target: row.target,
    sideEffect: row.side_effect as ComputerUseActionRecord["sideEffect"],
    status: row.status as ComputerUseActionRecord["status"],
    capabilityId: row.capability_id,
    failureClass: row.failure_class,
    failureMessage: row.failure_message,
    inputDigest: row.input_digest,
    resultDigest: row.result_digest,
    usageMicroUsd: row.usage_micro_usd,
    environmentRef: row.environment_ref,
    sandboxExecutionId: row.sandbox_execution_id,
    observationSequences: Array.isArray(row.observation_sequences)
      ? [...row.observation_sequences]
      : [],
    requestedAt: iso(row.requested_at),
    dispatchedAt: row.dispatched_at === null ? null : iso(row.dispatched_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
    durationMs: row.duration_ms,
    ledgerRequestedSequence: row.ledger_requested_sequence,
    ledgerResultSequence: row.ledger_result_sequence,
  };
}

interface ObservationRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly session_id: string;
  readonly execution_id: string;
  readonly observation_sequence: number;
  readonly observation_type: string;
  readonly mode: string;
  readonly content_digest: string;
  readonly retention: string;
  readonly redaction: string;
  readonly content: string | null;
  readonly artifact_ref: string | null;
  readonly capability_id: string;
  readonly action_id: string | null;
  readonly observed_at: Date | string;
  readonly ledger_sequence: number | null;
}

const OBSERVATION_COLUMNS = `id, application_id, tenant_id, session_id, execution_id, observation_sequence, observation_type, mode, content_digest, retention, redaction, content, artifact_ref, capability_id, action_id, observed_at, ledger_sequence`;

function toObservationRecord(row: ObservationRow): ComputerUseObservationRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    executionId: row.execution_id,
    sequence: row.observation_sequence,
    observationType: row.observation_type as ComputerUseObservationRecord["observationType"],
    mode: row.mode as ComputerUseObservationRecord["mode"],
    contentDigest: row.content_digest,
    retention: row.retention as ComputerUseObservationRecord["retention"],
    redaction: row.redaction as ComputerUseObservationRecord["redaction"],
    content: row.content,
    artifactRef: row.artifact_ref,
    capabilityId: row.capability_id,
    actionId: row.action_id,
    observedAt: iso(row.observed_at),
    ledgerSequence: row.ledger_sequence,
  };
}

interface OperationRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly session_id: string | null;
  readonly execution_id: string;
  readonly operation_kind: string;
  readonly operation_key: string;
  readonly request_fingerprint: string;
  readonly status: string;
  readonly attempts: number;
  readonly stage: Readonly<Record<string, unknown>> | null;
  readonly failure_reason: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly completed_at: Date | string | null;
}

const OPERATION_COLUMNS = `id, application_id, tenant_id, session_id, execution_id, operation_kind, operation_key, request_fingerprint, status, attempts, stage, failure_reason, created_at, updated_at, completed_at`;

function toOperationRecord(row: OperationRow): ComputerUseOperationRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    executionId: row.execution_id,
    operationKind: row.operation_kind as ComputerUseOperationRecord["operationKind"],
    operationKey: row.operation_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status as ComputerUseOperationRecord["status"],
    attempts: row.attempts,
    stage: row.stage,
    failureReason: row.failure_reason,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class SqlComputerUseStore implements ComputerUseStore {
  constructor(private readonly db: Executor) {}

  // -- sessions ---------------------------------------------------------------

  private async findSessionWhere(
    predicate: string,
    parameters: readonly unknown[],
  ): Promise<ComputerUseSessionRecord | null> {
    const result = await this.db.execute<SessionRow>({
      sql: `SELECT ${SESSION_COLUMNS} FROM tools.computer_use_sessions WHERE ${predicate}`,
      parameters,
    });
    const row = first(result.rows);
    return row === undefined ? null : toSessionRecord(row);
  }

  async findSession(
    applicationId: string,
    sessionId: string,
  ): Promise<ComputerUseSessionRecord | null> {
    return this.findSessionWhere("application_id = $1 AND id = $2", [applicationId, sessionId]);
  }

  async findSessionByKey(
    applicationId: string,
    sessionKey: string,
  ): Promise<ComputerUseSessionRecord | null> {
    return this.findSessionWhere("application_id = $1 AND session_key = $2", [
      applicationId,
      sessionKey,
    ]);
  }

  async listSessionsByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly ComputerUseSessionRecord[]> {
    const result = await this.db.execute<SessionRow>({
      sql: `SELECT ${SESSION_COLUMNS} FROM tools.computer_use_sessions WHERE application_id = $1 AND execution_id = $2 ORDER BY created_at, id`,
      parameters: [applicationId, executionId],
    });
    return result.rows.map(toSessionRecord);
  }

  async insertSession(input: ComputerUseSessionInsertInput) {
    try {
      const result = await this.db.execute<SessionRow>({
        sql: `INSERT INTO tools.computer_use_sessions (id, application_id, tenant_id, execution_id, session_key, request_fingerprint, task_kind, status, initial_mode, current_mode, route_evidence, admission, mode_context, denial_class, denial_reason, requested_at, activated_at, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11, $12, $13, $14, $15, CASE WHEN $13 IS NULL THEN $15 ELSE NULL END, $15, $15)
ON CONFLICT (application_id, session_key) DO NOTHING
RETURNING ${SESSION_COLUMNS}`,
        parameters: [
          input.sessionId,
          input.applicationId,
          input.tenantId,
          input.executionId,
          input.sessionKey,
          input.requestFingerprint,
          input.taskKind,
          input.denialClass === null ? "active" : "denied",
          input.initialMode,
          JSON.stringify(input.routeEvidence),
          JSON.stringify(input.admission),
          JSON.stringify(input.modeContext),
          input.denialClass,
          input.denialReason,
          input.createdAt,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return { status: "inserted" as const, record: toSessionRecord(row) };
      }
      const existing = await this.findSessionByKey(input.applicationId, input.sessionKey);
      if (existing === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "computer-use session insert converged without an existing row (durable-state divergence)",
        });
      }
      return {
        status: "existing" as const,
        record: existing,
        fingerprintMismatch: existing.requestFingerprint !== input.requestFingerprint,
      };
    } catch (error) {
      throw error instanceof PlatformError ? error : toTypedGuardError(error);
    }
  }

  async patchSession(input: ComputerUseSessionPatch): Promise<ComputerUseSessionRecord> {
    try {
      const result = await this.db.execute<SessionRow>({
        sql: `UPDATE tools.computer_use_sessions SET
  environment_ref = $3,
  environment_opened_mode = $4,
  current_mode = COALESCE($5, current_mode),
  mode_context = COALESCE($6, mode_context),
  escalation_count = COALESCE($7, escalation_count),
  usage_micro_usd = COALESCE($8, usage_micro_usd),
  updated_at = $9
WHERE application_id = $1 AND id = $2 AND status = 'active'
RETURNING ${SESSION_COLUMNS}`,
        parameters: [
          input.applicationId,
          input.sessionId,
          input.environmentRef,
          input.environmentOpenedMode,
          input.currentMode ?? null,
          input.currentEnvelope === undefined ? null : JSON.stringify(input.currentEnvelope),
          input.escalationCount ?? null,
          input.usageMicroUsd ?? null,
          input.updatedAt,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toSessionRecord(row);
      }
      const existing = await this.findSession(input.applicationId, input.sessionId);
      if (existing === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "computer-use session row disappeared (rows are never deleted)",
        });
      }
      if (isTerminal(existing.status)) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `computer-use session is terminal-immutable in ${existing.status}`,
          details: { guard: "cu_sessions_lifecycle_guard" },
        });
      }
      // A concurrent writer moved the mode: converge by re-reading (the
      // ladder guard still arbitrates).
      return existing;
    } catch (error) {
      throw error instanceof PlatformError ? error : toTypedGuardError(error);
    }
  }

  async applyGuardedSessionMutation(input: ComputerUseSessionStatusMutation) {
    try {
      const result = await this.db.execute<SessionRow>({
        sql: `UPDATE tools.computer_use_sessions SET
  status = $3,
  terminal_at = $5,
  terminal_cause = $3,
  updated_at = $5
WHERE application_id = $1 AND id = $2 AND status = $4
RETURNING ${SESSION_COLUMNS}`,
        parameters: [
          input.applicationId,
          input.sessionId,
          input.targetStatus,
          input.expectedStatus,
          input.updatedAt,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return { status: "moved" as const, record: toSessionRecord(row) };
      }
      const existing = await this.findSession(input.applicationId, input.sessionId);
      if (existing === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "computer-use session row disappeared (rows are never deleted)",
        });
      }
      if (existing.status === input.targetStatus) {
        return { status: "converged" as const, record: existing };
      }
      return {
        status: "rejected" as const,
        reason: `computer-use session is ${existing.status}; the guarded move expects ${input.expectedStatus}`,
        record: existing,
      };
    } catch (error) {
      throw error instanceof PlatformError ? error : toTypedGuardError(error);
    }
  }

  // -- escalations --------------------------------------------------------------

  async listEscalations(
    applicationId: string,
    sessionId: string,
  ): Promise<readonly ComputerUseEscalationRecord[]> {
    const result = await this.db.execute<EscalationRow>({
      sql: `SELECT id, application_id, tenant_id, session_id, execution_id, escalation_sequence, from_mode, to_mode, reason_code, reason_detail, insufficiency_digest, capability_id, admitted_at, ledger_sequence FROM tools.computer_use_escalations WHERE application_id = $1 AND session_id = $2 ORDER BY escalation_sequence`,
      parameters: [applicationId, sessionId],
    });
    return result.rows.map(toEscalationRecord);
  }

  private async findEscalationByMode(
    applicationId: string,
    sessionId: string,
    toMode: string,
  ): Promise<ComputerUseEscalationRecord | null> {
    const result = await this.db.execute<EscalationRow>({
      sql: `SELECT id, application_id, tenant_id, session_id, execution_id, escalation_sequence, from_mode, to_mode, reason_code, reason_detail, insufficiency_digest, capability_id, admitted_at, ledger_sequence FROM tools.computer_use_escalations WHERE application_id = $1 AND session_id = $2 AND to_mode = $3`,
      parameters: [applicationId, sessionId, toMode],
    });
    const row = first(result.rows);
    return row === undefined ? null : toEscalationRecord(row);
  }

  async insertEscalation(input: ComputerUseEscalationInsertInput) {
    try {
      const result = await this.db.execute<EscalationRow>({
        sql: `INSERT INTO tools.computer_use_escalations (id, application_id, tenant_id, session_id, execution_id, escalation_sequence, from_mode, to_mode, reason_code, reason_detail, insufficiency_digest, capability_id, admitted_at, ledger_sequence)
VALUES ($1, $2, $3, $4, (SELECT execution_id FROM tools.computer_use_sessions WHERE application_id = $2 AND id = $4), $5, $6, $7, $8, $9, $10, $11, $12, $13)
ON CONFLICT (application_id, session_id, to_mode) DO NOTHING
RETURNING id, application_id, tenant_id, session_id, execution_id, escalation_sequence, from_mode, to_mode, reason_code, reason_detail, insufficiency_digest, capability_id, admitted_at, ledger_sequence`,
        parameters: [
          input.id,
          input.applicationId,
          input.tenantId,
          input.sessionId,
          input.sequence,
          input.fromMode,
          input.toMode,
          input.reasonCode,
          input.reasonDetail,
          input.insufficiencyDigest,
          input.capabilityId,
          input.admittedAt,
          input.ledgerSequence,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return { status: "inserted" as const, record: toEscalationRecord(row) };
      }
      const existing = await this.findEscalationByMode(
        input.applicationId,
        input.sessionId,
        input.toMode,
      );
      if (existing === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "computer-use escalation insert converged without an existing row (durable-state divergence)",
        });
      }
      return { status: "existing" as const, record: existing };
    } catch (error) {
      throw error instanceof PlatformError ? error : toTypedGuardError(error);
    }
  }

  // -- actions -------------------------------------------------------------------

  async listActions(
    applicationId: string,
    sessionId: string,
  ): Promise<readonly ComputerUseActionRecord[]> {
    const result = await this.db.execute<ActionRow>({
      sql: `SELECT ${ACTION_COLUMNS} FROM tools.computer_use_actions WHERE application_id = $1 AND session_id = $2 ORDER BY action_sequence`,
      parameters: [applicationId, sessionId],
    });
    return result.rows.map(toActionRecord);
  }

  async findActionByKey(
    applicationId: string,
    sessionId: string,
    actionKey: string,
  ): Promise<ComputerUseActionRecord | null> {
    const result = await this.db.execute<ActionRow>({
      sql: `SELECT ${ACTION_COLUMNS} FROM tools.computer_use_actions WHERE application_id = $1 AND session_id = $2 AND action_key = $3`,
      parameters: [applicationId, sessionId, actionKey],
    });
    const row = first(result.rows);
    return row === undefined ? null : toActionRecord(row);
  }

  async insertAction(input: ComputerUseActionInsertInput) {
    try {
      const result = await this.db.execute<ActionRow>({
        sql: `INSERT INTO tools.computer_use_actions (id, application_id, tenant_id, session_id, execution_id, action_key, action_sequence, mode, action_type, target, side_effect, status, capability_id, input_digest, requested_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'dispatching', $12, $13, $14)
ON CONFLICT (application_id, session_id, action_key) DO NOTHING
RETURNING ${ACTION_COLUMNS}`,
        parameters: [
          input.actionId,
          input.applicationId,
          input.tenantId,
          input.sessionId,
          input.executionId,
          input.actionKey,
          input.sequence,
          input.mode,
          input.actionType,
          input.target,
          input.sideEffect,
          input.capabilityId,
          input.inputDigest,
          input.requestedAt,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return { status: "claimed" as const, record: toActionRecord(row) };
      }
      const existing = await this.findActionByKey(
        input.applicationId,
        input.sessionId,
        input.actionKey,
      );
      if (existing === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "computer-use action insert converged without an existing row (durable-state divergence)",
        });
      }
      return {
        status: "existing" as const,
        record: existing,
        fingerprintMismatch: existing.inputDigest !== input.inputDigest,
      };
    } catch (error) {
      throw error instanceof PlatformError ? error : toTypedGuardError(error);
    }
  }

  async finalizeAction(input: ComputerUseActionFinalizeInput): Promise<ComputerUseActionRecord> {
    try {
      const result = await this.db.execute<ActionRow>({
        sql: `UPDATE tools.computer_use_actions SET
  status = $3,
  failure_class = $4,
  failure_message = $5,
  result_digest = $6,
  usage_micro_usd = $7,
  environment_ref = $8,
  sandbox_execution_id = $9,
  observation_sequences = $10,
  dispatched_at = $11,
  completed_at = $12,
  duration_ms = $13,
  ledger_result_sequence = COALESCE($14, ledger_result_sequence)
WHERE application_id = $1 AND id = $2 AND status = 'dispatching'
RETURNING ${ACTION_COLUMNS}`,
        parameters: [
          input.applicationId,
          input.actionId,
          input.status,
          input.failureClass,
          input.failureMessage,
          input.resultDigest,
          input.usageMicroUsd,
          input.environmentRef,
          input.sandboxExecutionId,
          JSON.stringify([...input.observationSequences]),
          input.dispatchedAt,
          input.completedAt,
          input.durationMs,
          input.ledgerResultSequence,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toActionRecord(row);
      }
      const existing = await this.findActionById(input.applicationId, input.actionId);
      if (existing === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "computer-use action row disappeared (rows are never deleted)",
        });
      }
      // Guarded first-writer-wins: converge on the committed outcome.
      return existing;
    } catch (error) {
      throw error instanceof PlatformError ? error : toTypedGuardError(error);
    }
  }

  async bindActionLedgerSequence(
    input: ComputerUseActionLedgerBinding,
  ): Promise<ComputerUseActionRecord> {
    try {
      const column =
        input.phase === "requested" ? "ledger_requested_sequence" : "ledger_result_sequence";
      const result = await this.db.execute<ActionRow>({
        sql: `UPDATE tools.computer_use_actions SET ${column} = $3 WHERE application_id = $1 AND id = $2 AND ${column} IS NULL RETURNING ${ACTION_COLUMNS}`,
        parameters: [input.applicationId, input.actionId, input.sequence],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toActionRecord(row);
      }
      const existing = await this.findActionById(input.applicationId, input.actionId);
      if (existing === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "computer-use action row disappeared (rows are never deleted)",
        });
      }
      // Write-once: the binding already landed; converge.
      return existing;
    } catch (error) {
      throw error instanceof PlatformError ? error : toTypedGuardError(error);
    }
  }

  private async findActionById(
    applicationId: string,
    actionId: string,
  ): Promise<ComputerUseActionRecord | null> {
    const result = await this.db.execute<ActionRow>({
      sql: `SELECT ${ACTION_COLUMNS} FROM tools.computer_use_actions WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, actionId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toActionRecord(row);
  }

  // -- observations -----------------------------------------------------------------

  async listObservations(
    applicationId: string,
    sessionId: string,
  ): Promise<readonly ComputerUseObservationRecord[]> {
    const result = await this.db.execute<ObservationRow>({
      sql: `SELECT ${OBSERVATION_COLUMNS} FROM tools.computer_use_observations WHERE application_id = $1 AND session_id = $2 ORDER BY observation_sequence`,
      parameters: [applicationId, sessionId],
    });
    return result.rows.map(toObservationRecord);
  }

  async insertObservation(input: ComputerUseObservationInsertInput) {
    try {
      const result = await this.db.execute<ObservationRow>({
        sql: `INSERT INTO tools.computer_use_observations (id, application_id, tenant_id, session_id, execution_id, observation_sequence, observation_type, mode, content_digest, retention, redaction, content, artifact_ref, capability_id, action_id, observed_at, ledger_sequence)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
ON CONFLICT (application_id, session_id, observation_sequence) DO NOTHING
RETURNING ${OBSERVATION_COLUMNS}`,
        parameters: [
          input.id,
          input.applicationId,
          input.tenantId,
          input.sessionId,
          input.executionId,
          input.sequence,
          input.observationType,
          input.mode,
          input.contentDigest,
          input.retention,
          input.redaction,
          input.content,
          input.artifactRef,
          input.capabilityId,
          input.actionId,
          input.observedAt,
          input.ledgerSequence,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return { status: "inserted" as const, record: toObservationRecord(row) };
      }
      const existing = await this.findObservationBySequence(
        input.applicationId,
        input.sessionId,
        input.sequence,
      );
      if (existing === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "computer-use observation insert converged without an existing row (durable-state divergence)",
        });
      }
      if (existing.contentDigest !== input.contentDigest) {
        return {
          status: "conflict" as const,
          reason: `computer-use session observation sequence ${input.sequence} already exists with a different content digest (same key, different body)`,
        };
      }
      return { status: "converged" as const, record: existing };
    } catch (error) {
      const message = messageOf(error);
      if (
        message.includes("already exists with a different content digest") ||
        message.includes("observation sequence must be gapless") ||
        message.includes("observations require an active session")
      ) {
        return { status: "conflict" as const, reason: message };
      }
      throw error instanceof PlatformError ? error : toTypedGuardError(error);
    }
  }

  private async findObservationBySequence(
    applicationId: string,
    sessionId: string,
    sequence: number,
  ): Promise<ComputerUseObservationRecord | null> {
    const result = await this.db.execute<ObservationRow>({
      sql: `SELECT ${OBSERVATION_COLUMNS} FROM tools.computer_use_observations WHERE application_id = $1 AND session_id = $2 AND observation_sequence = $3`,
      parameters: [applicationId, sessionId, sequence],
    });
    const row = first(result.rows);
    return row === undefined ? null : toObservationRecord(row);
  }

  // -- the durable operation state ------------------------------------------------------

  async findOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<ComputerUseOperationRecord | null> {
    const result = await this.db.execute<OperationRow>({
      sql: `SELECT ${OPERATION_COLUMNS} FROM tools.computer_use_operations WHERE application_id = $1 AND operation_key = $2`,
      parameters: [applicationId, operationKey],
    });
    const row = first(result.rows);
    return row === undefined ? null : toOperationRecord(row);
  }

  async beginComputerUseOperation(
    input: Parameters<ComputerUseStore["beginComputerUseOperation"]>[0],
  ) {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `INSERT INTO tools.computer_use_operations (id, application_id, tenant_id, session_id, execution_id, operation_kind, operation_key, request_fingerprint, status, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $9)
ON CONFLICT (application_id, operation_key) DO NOTHING
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [
          input.operationId,
          input.applicationId,
          input.tenantId,
          input.sessionId,
          input.executionId,
          input.operationKind,
          input.operationKey,
          input.requestFingerprint,
          input.createdAt,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return { status: "begun" as const, record: toOperationRecord(row) };
      }
      const existing = await this.findOperation(input.applicationId, input.operationKey);
      if (existing === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "computer-use operation claim converged without an existing row (durable-state divergence)",
        });
      }
      if (existing.requestFingerprint !== input.requestFingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message:
            "computer-use operation key was already used with a different request fingerprint",
          details: { operationId: existing.id },
        });
      }
      if (existing.status === "pending") {
        const bumped = await this.db.execute<OperationRow>({
          sql: `UPDATE tools.computer_use_operations SET attempts = attempts + 1, updated_at = $3 WHERE application_id = $1 AND operation_key = $2 AND status = 'pending' RETURNING ${OPERATION_COLUMNS}`,
          parameters: [input.applicationId, input.operationKey, input.createdAt],
        });
        const bumpedRow = first(bumped.rows);
        return {
          status: "existing" as const,
          record: bumpedRow === undefined ? existing : toOperationRecord(bumpedRow),
        };
      }
      return { status: "existing" as const, record: existing };
    } catch (error) {
      throw error instanceof PlatformError ? error : toTypedGuardError(error);
    }
  }

  async recordOperationCheckpoint(
    applicationId: string,
    operationKey: string,
    stage: Readonly<Record<string, unknown>>,
    updatedAt: string,
  ): Promise<ComputerUseOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE tools.computer_use_operations SET stage = $3, updated_at = $4 WHERE application_id = $1 AND operation_key = $2 AND status = 'pending' RETURNING ${OPERATION_COLUMNS}`,
        parameters: [applicationId, operationKey, JSON.stringify(stage), updatedAt],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toOperationRecord(row);
      }
      return await this.requireOperation(applicationId, operationKey);
    } catch (error) {
      throw error instanceof PlatformError ? error : toTypedGuardError(error);
    }
  }

  async completeOperation(
    applicationId: string,
    operationKey: string,
    completedAt: string,
  ): Promise<ComputerUseOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE tools.computer_use_operations SET status = 'completed', completed_at = $3, updated_at = $3 WHERE application_id = $1 AND operation_key = $2 AND status = 'pending' RETURNING ${OPERATION_COLUMNS}`,
        parameters: [applicationId, operationKey, completedAt],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toOperationRecord(row);
      }
      return await this.requireOperation(applicationId, operationKey);
    } catch (error) {
      throw error instanceof PlatformError ? error : toTypedGuardError(error);
    }
  }

  async failOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    updatedAt: string,
  ): Promise<ComputerUseOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE tools.computer_use_operations SET status = 'failed', failure_reason = $3, updated_at = $4 WHERE application_id = $1 AND operation_key = $2 AND status = 'pending' RETURNING ${OPERATION_COLUMNS}`,
        parameters: [applicationId, operationKey, reason, updatedAt],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toOperationRecord(row);
      }
      return await this.requireOperation(applicationId, operationKey);
    } catch (error) {
      throw error instanceof PlatformError ? error : toTypedGuardError(error);
    }
  }

  private async requireOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<ComputerUseOperationRecord> {
    const existing = await this.findOperation(applicationId, operationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "computer-use operation row disappeared (rows are never deleted)",
      });
    }
    return existing;
  }
}

function isTerminal(status: ComputerUseSessionStatus): boolean {
  return (
    status === "denied" || status === "completed" || status === "failed" || status === "cancelled"
  );
}
