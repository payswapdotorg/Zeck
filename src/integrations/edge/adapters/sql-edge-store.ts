/**
 * SQL adapter for the governed edge fabric (edge integration; WORK-029).
 *
 * Bridges `EdgeStore` to the provider-neutral platform `DatabasePort`
 * (migration 0024 tables). No driver/SDK import happens here — `pg` is
 * owned by the platform DB layer; this adapter is the integration's one
 * durable-state surface (the WORK-031 substrate-federation precedent of
 * integration-owned durable state, now with its own schema).
 *
 * The executions single-write-path discipline is preserved structurally:
 * this adapter never touches the executions module's physical tables —
 * lifecycle movement and ledger evidence stay on the frozen path (the
 * executions transition service + recordStepEvent through the edge
 * integration's `EdgeExecutionLedger` port). Only the WORK-029 edge
 * tables are written here.
 *
 * Convergence mechanics (the physical discipline of migration 0024):
 *   * device/approval/envelope/command inserts converge on the
 *     (application, *_key) UNIQUE with request-fingerprint arbitration
 *     (a same-key/different-body insert fails closed typed —
 *     IDEMPOTENCY_KEY_REUSED); the command insert additionally treats a
 *     violation of the identity-carrying indexes (commands_pkey /
 *     ec_identity_unique) as the keyed convergence path — the
 *     crash-stable staged command id (checkpointed on the operation)
 *     collides on the primary key BEFORE the key arbiter is checked,
 *     and the row behind that id IS the row behind the key, so the
 *     insert falls through to the keyed re-read instead of raising
 *     (the in-memory twin converges by key first by construction);
 *   * guarded status moves are expected-status-gated UPDATEs (first
 *     writer wins, duplicates converge on the committed row); terminal
 *     rows are immutable (the migration's lifecycle guards raise, mapped
 *     typed here);
 *   * the per-device authoritative command sequence is GAPLESS and
 *     INCLUDES denied requests (the sequence gate raises typed on a
 *     hole, a regression or a concurrent double-allocation);
 *   * ledger-sequence bindings, dispatch digests and denial evidence are
 *     write-once (NULL -> value; the core guards raise typed);
 *   * actuation events converge on (application, device, actuation
 *     digest); sensor observations converge on (application,
 *     observation_key) with content-digest arbitration;
 *   * operation claims converge on (application, operation_key) with
 *     fingerprint arbitration and the monotonic attempts ledger; the
 *     stage checkpoint and terminal outcomes move PENDING rows only.
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type {
  EdgeActuationEventRecord,
  EdgeApprovalRecord,
  EdgeCommandRecord,
  EdgeDeviceRecord,
  EdgeEnvelopeRecord,
  EdgeHealthReport,
  EdgeReconciliationRecord,
  EdgeSensorObservationRecord,
} from "../domain/edge";
import type {
  EdgeActuationEventInsertInput,
  EdgeActuationEventInsertOutcome,
  EdgeApprovalDecisionOutcome,
  EdgeApprovalInsertInput,
  EdgeApprovalInsertOutcome,
  EdgeCommandFinalizeInput,
  EdgeCommandInsertInput,
  EdgeCommandInsertOutcome,
  EdgeCommandLedgerBinding,
  EdgeDeviceInsertInput,
  EdgeDeviceInsertOutcome,
  EdgeDeviceRevokeInput,
  EdgeDeviceRevokeOutcome,
  EdgeEnvelopeInsertInput,
  EdgeEnvelopeInsertOutcome,
  EdgeEnvelopeRevokeInput,
  EdgeEnvelopeRevokeOutcome,
  EdgeEnvelopeSupersedeInput,
  EdgeHealthReportInsertInput,
  EdgeOperationBeginInput,
  EdgeOperationBeginOutcome,
  EdgeOperationRecord,
  EdgeReconciliationInsertInput,
  EdgeSensorObservationInsertInput,
  EdgeSensorObservationInsertOutcome,
  EdgeStore,
} from "../ports/edge-store";

type Executor = Pick<DatabasePort, "execute">;

function first<T>(rows: readonly T[]): T | undefined {
  return rows.length > 0 ? rows[0] : undefined;
}

function iso(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : String(value);
}

const requireIso = (value: Date | string): string => iso(value) as string;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The unique indexes that carry the command IDENTITY — the primary key
 * and the (id, application_id) identity constraint. A violation on one
 * of these during a keyed insert is the crash-stable staged-commandId
 * reuse colliding with the SAME-KEY row that already claimed that id
 * (the stage is checkpointed on the operation, whose operation_key is
 * derived from the command key): the racer reuses the checkpointed id,
 * the first insert commits, and PostgreSQL checks a speculative
 * insert's unique indexes in index order — the primary key fires
 * BEFORE the (application_id, command_key) arbiter is consulted, so
 * the convergence that the arbiter WOULD have performed surfaces as a
 * hard `commands_pkey` violation instead. This is the keyed-convergence
 * path, not a semantic violation: the caller falls through to the
 * keyed re-read (which arbitrates the request fingerprint), exactly
 * the in-memory twin's converge-by-key-first semantics. Every OTHER
 * unique violation — the gapless sequence arbiter `ec_sequence_unique`
 * in particular — keeps its typed guard mapping.
 */
function isCommandIdentityConflict(error: unknown): boolean {
  const message = messageOf(error);
  if (!message.includes("violates unique constraint")) {
    return false;
  }
  return message.includes("commands_pkey") || message.includes("ec_identity_unique");
}

/** Map physical guard rejections to the typed error taxonomy. */
function toTypedGuardError(error: unknown): PlatformError {
  const message = messageOf(error);
  if (message.includes("command key") && message.includes("different request")) {
    return new PlatformError({
      code: "IDEMPOTENCY_KEY_REUSED",
      message,
      details: { guard: "ec_commands_sequence_gate" },
    });
  }
  if (message.includes("sensor observation key") && message.includes("different content")) {
    return new PlatformError({
      code: "IDEMPOTENCY_KEY_REUSED",
      message,
      details: { guard: "es_observations_sequence_gate" },
    });
  }
  if (
    message.includes("command sequence must be gapless") ||
    (message.includes("command sequence") &&
      message.includes("already exists with a different key")) ||
    message.includes("ec_sequence_unique") ||
    message.includes("sensor observation sequence must be gapless") ||
    message.includes("es_sequence_unique")
  ) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "sequence_gate" },
    });
  }
  if (
    message.includes("is terminal-immutable") ||
    message.includes("cannot move from") ||
    message.includes("only admitted envelopes") ||
    message.includes("only dispatched commands") ||
    message.includes("supersede links are write-once") ||
    message.includes("are inserted pending only") ||
    message.includes("are inserted admitted only") ||
    message.includes("identity core is immutable") ||
    message.includes("is revoked (terminal-immutable)") ||
    message.includes("cannot move from registered to") ||
    message.includes("cannot move from pending to") ||
    message.includes("cannot move from status") ||
    message.includes("no mutable fields") ||
    message.includes("dispatch timestamp is write-once") ||
    message.includes("ledger bindings are write-once") ||
    message.includes("ledger binding is write-once") ||
    message.includes("wait-human ledger binding is write-once") ||
    message.includes("resume ledger binding is write-once") ||
    message.includes("dispatch digest is write-once") ||
    message.includes("denial evidence is write-once") ||
    message.includes("command count never regresses") ||
    message.includes("sequence counters are monotonic")
  ) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "lifecycle_guard" },
    });
  }
  if (message.includes("violates unique constraint")) {
    return new PlatformError({
      code: "IDEMPOTENCY_KEY_REUSED",
      message: "the keyed row already exists with a different identity (key reuse)",
      details: { cause: message },
    });
  }
  if (message.includes("violates foreign key constraint") && message.includes("tenant")) {
    return new PlatformError({
      code: "TENANT_SCOPE_VIOLATION",
      message: "edge state writes require a tenant that owns the application",
      details: { guard: "tenant_fk", cause: message },
    });
  }
  return new PlatformError({
    code: "PROVIDER_ERROR",
    message: "edge store guard rejection",
    details: { cause: message },
  });
}

// ---------------------------------------------------------------------------
// Row mappings
// ---------------------------------------------------------------------------

interface DeviceRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly device_key: string;
  readonly request_fingerprint: string;
  readonly label: string;
  readonly workload_classes: readonly string[];
  readonly capability_atoms: readonly string[];
  readonly controller_ref: string;
  readonly status: string;
  readonly health: EdgeHealthReport | null;
  readonly last_command_sequence: number;
  readonly last_dispatched_sequence: number;
  readonly created_at: Date | string;
  readonly revoked_at: Date | string | null;
  readonly revocation_reason: string | null;
}

const DEVICE_COLUMNS = `id, application_id, tenant_id, device_key, request_fingerprint, label, workload_classes, capability_atoms, controller_ref, status, health, last_command_sequence, last_dispatched_sequence, created_at, revoked_at, revocation_reason`;

function toDeviceRecord(row: DeviceRow): EdgeDeviceRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    deviceKey: row.device_key,
    requestFingerprint: row.request_fingerprint,
    label: row.label,
    workloadClasses: [...row.workload_classes] as EdgeDeviceRecord["workloadClasses"],
    capabilityAtoms: [...row.capability_atoms],
    controllerRef: row.controller_ref,
    status: row.status as EdgeDeviceRecord["status"],
    health: row.health,
    lastCommandSequence: row.last_command_sequence,
    lastDispatchedSequence: row.last_dispatched_sequence,
    createdAt: requireIso(row.created_at),
    revokedAt: iso(row.revoked_at),
    revocationReason: row.revocation_reason,
  };
}

interface ApprovalRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly device_id: string;
  readonly subject_kind: string;
  readonly subject_fingerprint: string;
  readonly policy_basis: string;
  readonly status: string;
  readonly approval_key: string;
  readonly requested_at: Date | string;
  readonly decided_at: Date | string | null;
  readonly approver_id: string | null;
  readonly decision: string | null;
  readonly expires_at: Date | string | null;
  readonly ledger_wait_sequence: number | null;
  readonly ledger_resume_sequence: number | null;
}

const APPROVAL_COLUMNS = `id, application_id, tenant_id, execution_id, device_id, subject_kind, subject_fingerprint, policy_basis, status, approval_key, requested_at, decided_at, approver_id, decision, expires_at, ledger_wait_sequence, ledger_resume_sequence`;

function toApprovalRecord(row: ApprovalRow): EdgeApprovalRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    deviceId: row.device_id,
    subjectKind: row.subject_kind as EdgeApprovalRecord["subjectKind"],
    subjectFingerprint: row.subject_fingerprint,
    policyBasis: row.policy_basis,
    status: row.status as EdgeApprovalRecord["status"],
    approvalKey: row.approval_key,
    requestedAt: requireIso(row.requested_at),
    decidedAt: iso(row.decided_at),
    approverId: row.approver_id,
    decision: (row.decision ?? null) as EdgeApprovalRecord["decision"],
    expiresAt: iso(row.expires_at),
    ledgerWaitSequence: row.ledger_wait_sequence,
    ledgerResumeSequence: row.ledger_resume_sequence,
  };
}

interface EnvelopeRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly device_id: string;
  readonly envelope_key: string;
  readonly request_fingerprint: string;
  readonly content_digest: string;
  readonly content: EdgeEnvelopeRecord["content"];
  readonly status: string;
  readonly admission: EdgeEnvelopeRecord["admission"];
  readonly supersedes_envelope_id: string | null;
  readonly superseded_by_envelope_id: string | null;
  readonly command_count: number;
  readonly created_at: Date | string;
  readonly superseded_at: Date | string | null;
  readonly revoked_at: Date | string | null;
  readonly revocation_reason: string | null;
}

const ENVELOPE_COLUMNS = `id, application_id, tenant_id, execution_id, device_id, envelope_key, request_fingerprint, content_digest, content, status, admission, supersedes_envelope_id, superseded_by_envelope_id, command_count, created_at, superseded_at, revoked_at, revocation_reason`;

function toEnvelopeRecord(row: EnvelopeRow): EdgeEnvelopeRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    deviceId: row.device_id,
    envelopeKey: row.envelope_key,
    requestFingerprint: row.request_fingerprint,
    contentDigest: row.content_digest,
    content: row.content,
    status: row.status as EdgeEnvelopeRecord["status"],
    admission: row.admission,
    supersedesEnvelopeId: row.supersedes_envelope_id,
    supersededByEnvelopeId: row.superseded_by_envelope_id,
    commandCount: row.command_count,
    createdAt: requireIso(row.created_at),
    supersededAt: iso(row.superseded_at),
    revokedAt: iso(row.revoked_at),
    revocationReason: row.revocation_reason,
  };
}

interface CommandRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly device_id: string;
  readonly envelope_id: string;
  readonly command_key: string;
  readonly request_fingerprint: string;
  readonly sequence: number;
  readonly command_kind: string;
  readonly effect_class: string;
  readonly channel: string;
  readonly magnitude: number;
  readonly payload_digest: string;
  readonly estimated_micro_usd: string;
  readonly not_before: Date | string;
  readonly not_after: Date | string;
  readonly status: string;
  readonly denial_class: string | null;
  readonly denial_reason: string | null;
  readonly approval_id: string | null;
  readonly failure_class: string | null;
  readonly failure_message: string | null;
  readonly dispatch_digest: string | null;
  readonly usage_micro_usd: string | null;
  readonly dispatched_at: Date | string | null;
  readonly settled_at: Date | string | null;
  readonly reconciled_at: Date | string | null;
  readonly created_at: Date | string;
  readonly ledger_requested_sequence: number | null;
  readonly ledger_result_sequence: number | null;
}

const COMMAND_COLUMNS = `id, application_id, tenant_id, execution_id, device_id, envelope_id, command_key, request_fingerprint, sequence, command_kind, effect_class, channel, magnitude, payload_digest, estimated_micro_usd, not_before, not_after, status, denial_class, denial_reason, approval_id, failure_class, failure_message, dispatch_digest, usage_micro_usd, dispatched_at, settled_at, reconciled_at, created_at, ledger_requested_sequence, ledger_result_sequence`;

function toCommandRecord(row: CommandRow): EdgeCommandRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    deviceId: row.device_id,
    envelopeId: row.envelope_id,
    commandKey: row.command_key,
    requestFingerprint: row.request_fingerprint,
    sequence: row.sequence,
    commandKind: row.command_kind as EdgeCommandRecord["commandKind"],
    effectClass: row.effect_class as EdgeCommandRecord["effectClass"],
    channel: row.channel as EdgeCommandRecord["channel"],
    magnitude: row.magnitude,
    payloadDigest: row.payload_digest,
    estimatedMicroUsd: row.estimated_micro_usd,
    notBefore: requireIso(row.not_before),
    notAfter: requireIso(row.not_after),
    status: row.status as EdgeCommandStatus,
    denialClass: row.denial_class,
    denialReason: row.denial_reason,
    approvalId: row.approval_id,
    failureClass: row.failure_class,
    failureMessage: row.failure_message,
    dispatchDigest: row.dispatch_digest,
    usageMicroUsd: row.usage_micro_usd,
    dispatchedAt: iso(row.dispatched_at),
    settledAt: iso(row.settled_at),
    reconciledAt: iso(row.reconciled_at),
    createdAt: requireIso(row.created_at),
    ledgerRequestedSequence: row.ledger_requested_sequence,
    ledgerResultSequence: row.ledger_result_sequence,
  };
}

type EdgeCommandStatus = EdgeCommandRecord["status"];

interface ActuationRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string | null;
  readonly device_id: string;
  readonly command_id: string | null;
  readonly command_key: string | null;
  readonly sequence: number | null;
  readonly actuation_class: string;
  readonly violation_kind: string | null;
  readonly channel: string | null;
  readonly magnitude: number | null;
  readonly actuation_digest: string;
  readonly occurred_at: Date | string;
  readonly reconciled_at: Date | string;
  readonly reconciliation_id: string | null;
}

const ACTUATION_COLUMNS = `id, application_id, tenant_id, execution_id, device_id, command_id, command_key, sequence, actuation_class, violation_kind, channel, magnitude, actuation_digest, occurred_at, reconciled_at, reconciliation_id`;

function toActuationRecord(row: ActuationRow): EdgeActuationEventRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    deviceId: row.device_id,
    commandId: row.command_id,
    commandKey: row.command_key,
    sequence: row.sequence,
    actuationClass: row.actuation_class as EdgeActuationEventRecord["actuationClass"],
    violationKind: row.violation_kind,
    channel: (row.channel ?? null) as EdgeActuationEventRecord["channel"],
    magnitude: row.magnitude,
    actuationDigest: row.actuation_digest,
    occurredAt: requireIso(row.occurred_at),
    reconciledAt: requireIso(row.reconciled_at),
    reconciliationId: row.reconciliation_id,
  };
}

interface SensorRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly device_id: string;
  readonly sequence: number;
  readonly observation_key: string;
  readonly observation_type: string;
  readonly retention: string;
  readonly content_digest: string;
  readonly content: string | null;
  readonly observed_at: Date | string;
  readonly ledger_sequence: number | null;
}

const SENSOR_COLUMNS = `id, application_id, tenant_id, execution_id, device_id, sequence, observation_key, observation_type, retention, content_digest, content, observed_at, ledger_sequence`;

function toSensorRecord(row: SensorRow): EdgeSensorObservationRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    deviceId: row.device_id,
    sequence: row.sequence,
    observationKey: row.observation_key,
    observationType: row.observation_type as EdgeSensorObservationRecord["observationType"],
    retention: row.retention as EdgeSensorObservationRecord["retention"],
    contentDigest: row.content_digest,
    content: row.content,
    observedAt: requireIso(row.observed_at),
    ledgerSequence: row.ledger_sequence,
  };
}

interface ReconciliationRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly device_id: string;
  readonly report_digest: string;
  readonly status: string;
  readonly confirmed_count: number;
  readonly autonomous_count: number;
  readonly violation_count: number;
  readonly settled_count: number;
  readonly reconciled_at: Date | string;
}

function toReconciliationRecord(row: ReconciliationRow): EdgeReconciliationRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    deviceId: row.device_id,
    reportDigest: row.report_digest,
    status: row.status as EdgeReconciliationRecord["status"],
    confirmedCount: row.confirmed_count,
    autonomousCount: row.autonomous_count,
    violationCount: row.violation_count,
    settledCount: row.settled_count,
    reconciledAt: requireIso(row.reconciled_at),
  };
}

interface OperationRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly device_id: string | null;
  readonly execution_id: string | null;
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

const OPERATION_COLUMNS = `id, application_id, tenant_id, device_id, execution_id, operation_kind, operation_key, request_fingerprint, status, attempts, stage, failure_reason, created_at, updated_at, completed_at`;

function toOperationRecord(row: OperationRow): EdgeOperationRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    deviceId: row.device_id,
    executionId: row.execution_id,
    operationKind: row.operation_kind as EdgeOperationRecord["operationKind"],
    operationKey: row.operation_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status as EdgeOperationRecord["status"],
    attempts: row.attempts,
    stage: row.stage,
    failureReason: row.failure_reason,
    createdAt: requireIso(row.created_at),
    updatedAt: requireIso(row.updated_at),
    completedAt: iso(row.completed_at),
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class SqlEdgeStore implements EdgeStore {
  constructor(private readonly db: Executor) {}

  private async findDeviceWhere(
    predicate: string,
    parameters: readonly unknown[],
  ): Promise<EdgeDeviceRecord | null> {
    const result = await this.db.execute<DeviceRow>({
      sql: `SELECT ${DEVICE_COLUMNS} FROM edge.devices WHERE ${predicate}`,
      parameters,
    });
    const row = first(result.rows);
    return row === undefined ? null : toDeviceRecord(row);
  }

  // -- devices ---------------------------------------------------------------

  async insertDevice(input: EdgeDeviceInsertInput): Promise<EdgeDeviceInsertOutcome> {
    try {
      const result = await this.db.execute<DeviceRow>({
        sql: `INSERT INTO edge.devices (id, application_id, tenant_id, device_key, request_fingerprint, label, workload_classes, capability_atoms, controller_ref, status, health, last_command_sequence, last_dispatched_sequence, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, 'registered', NULL, 0, 0, $10::timestamptz)
ON CONFLICT (application_id, device_key) DO NOTHING
RETURNING ${DEVICE_COLUMNS}`,
        parameters: [
          input.deviceId,
          input.applicationId,
          input.tenantId,
          input.deviceKey,
          input.requestFingerprint,
          input.label,
          JSON.stringify([...input.workloadClasses]),
          JSON.stringify([...input.capabilityAtoms]),
          input.controllerRef,
          input.createdAt,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return { status: "inserted", record: toDeviceRecord(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.findDeviceByKey(input.applicationId, input.deviceKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "edge device insert converged but the row is not readable",
      });
    }
    return {
      status: "existing",
      record: existing,
      fingerprintMismatch: existing.requestFingerprint !== input.requestFingerprint,
    };
  }

  async findDevice(applicationId: string, deviceId: string): Promise<EdgeDeviceRecord | null> {
    return this.findDeviceWhere("application_id = $1 AND id = $2", [applicationId, deviceId]);
  }

  async findDeviceByKey(
    applicationId: string,
    deviceKey: string,
  ): Promise<EdgeDeviceRecord | null> {
    return this.findDeviceWhere("application_id = $1 AND device_key = $2", [
      applicationId,
      deviceKey,
    ]);
  }

  async applyGuardedDeviceRevocation(
    input: EdgeDeviceRevokeInput,
  ): Promise<EdgeDeviceRevokeOutcome> {
    try {
      const result = await this.db.execute<DeviceRow>({
        sql: `UPDATE edge.devices SET status = 'revoked', revoked_at = $3::timestamptz, revocation_reason = $4
WHERE application_id = $1 AND id = $2 AND status = $5
RETURNING ${DEVICE_COLUMNS}`,
        parameters: [
          input.applicationId,
          input.deviceId,
          input.revokedAt,
          input.reason,
          input.expectedStatus,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return { status: "revoked", record: toDeviceRecord(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const record = await this.findDevice(input.applicationId, input.deviceId);
    if (record === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge device ${input.deviceId} does not exist in this application`,
      });
    }
    if (record.status === "revoked") {
      return { status: "converged", record };
    }
    return {
      status: "rejected",
      reason: `the device is ${record.status} (expected ${input.expectedStatus})`,
      record,
    };
  }

  async insertHealthReport(input: EdgeHealthReportInsertInput): Promise<EdgeDeviceRecord> {
    try {
      const result = await this.db.execute<DeviceRow>({
        sql: `WITH inserted AS (
  INSERT INTO edge.device_health_reports (id, application_id, tenant_id, device_id, status, metrics, note, reported_at)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz)
  RETURNING id
)
UPDATE edge.devices SET health = $6::jsonb
WHERE application_id = $2 AND id = $4
RETURNING ${DEVICE_COLUMNS}`,
        parameters: [
          input.id,
          input.applicationId,
          input.tenantId,
          input.deviceId,
          input.health.status,
          JSON.stringify(input.health),
          input.health.note ?? null,
          input.reportedAt,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toDeviceRecord(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    throw new PlatformError({
      code: "TENANT_SCOPE_VIOLATION",
      message: `edge device ${input.deviceId} does not exist in this application`,
    });
  }

  async listDevices(applicationId: string): Promise<readonly EdgeDeviceRecord[]> {
    const result = await this.db.execute<DeviceRow>({
      sql: `SELECT ${DEVICE_COLUMNS} FROM edge.devices WHERE application_id = $1 ORDER BY created_at, id`,
      parameters: [applicationId],
    });
    return result.rows.map(toDeviceRecord);
  }

  // -- approvals ---------------------------------------------------------------

  async insertApproval(input: EdgeApprovalInsertInput): Promise<EdgeApprovalInsertOutcome> {
    try {
      const result = await this.db.execute<ApprovalRow>({
        sql: `INSERT INTO edge.approvals (id, application_id, tenant_id, execution_id, device_id, subject_kind, subject_fingerprint, policy_basis, status, approval_key, requested_at, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10::timestamptz, $11::timestamptz)
ON CONFLICT (application_id, approval_key) DO NOTHING
RETURNING ${APPROVAL_COLUMNS}`,
        parameters: [
          input.approvalId,
          input.applicationId,
          input.tenantId,
          input.executionId,
          input.deviceId,
          input.subjectKind,
          input.subjectFingerprint,
          input.policyBasis,
          input.approvalKey,
          input.requestedAt,
          input.expiresAt,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return { status: "inserted", record: toApprovalRecord(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.findApprovalByKey(input.applicationId, input.approvalKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "edge approval insert converged but the row is not readable",
      });
    }
    return { status: "existing", record: existing };
  }

  private async findApprovalWhere(
    predicate: string,
    parameters: readonly unknown[],
  ): Promise<EdgeApprovalRecord | null> {
    const result = await this.db.execute<ApprovalRow>({
      sql: `SELECT ${APPROVAL_COLUMNS} FROM edge.approvals WHERE ${predicate}`,
      parameters,
    });
    const row = first(result.rows);
    return row === undefined ? null : toApprovalRecord(row);
  }

  async findApproval(
    applicationId: string,
    approvalId: string,
  ): Promise<EdgeApprovalRecord | null> {
    return this.findApprovalWhere("application_id = $1 AND id = $2", [applicationId, approvalId]);
  }

  async findApprovalByKey(
    applicationId: string,
    approvalKey: string,
  ): Promise<EdgeApprovalRecord | null> {
    return this.findApprovalWhere("application_id = $1 AND approval_key = $2", [
      applicationId,
      approvalKey,
    ]);
  }

  async listPendingApprovalsForExecution(
    applicationId: string,
    executionId: string,
    excludeApprovalId?: string,
  ): Promise<readonly EdgeApprovalRecord[]> {
    const result = await this.db.execute<ApprovalRow>({
      sql: `SELECT ${APPROVAL_COLUMNS} FROM edge.approvals WHERE application_id = $1 AND execution_id = $2 AND status = 'pending'`,
      parameters: [applicationId, executionId],
    });
    return result.rows
      .filter((row) => row.id !== excludeApprovalId)
      .map((row) => toApprovalRecord(row));
  }

  async applyApprovalDecision(input: EdgeApprovalDecisionOutcome): Promise<EdgeApprovalRecord> {
    try {
      const result = await this.db.execute<ApprovalRow>({
        sql: `UPDATE edge.approvals SET status = $3, decision = $3, decided_at = $4::timestamptz, approver_id = $5
WHERE application_id = $1 AND id = $2 AND status = 'pending'
RETURNING ${APPROVAL_COLUMNS}`,
        parameters: [
          input.applicationId,
          input.approvalId,
          input.decision,
          input.decidedAt,
          input.approverId,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toApprovalRecord(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const record = await this.findApproval(input.applicationId, input.approvalId);
    if (record === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge approval ${input.approvalId} does not exist in this application`,
      });
    }
    if (
      (record.status === "approved" || record.status === "denied") &&
      record.decision === input.decision &&
      record.approverId === input.approverId
    ) {
      return record; // converged replay of the same decision
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `edge approval ${record.id} is already decided (${record.status}); decisions are terminal-immutable`,
    });
  }

  async bindApprovalLedgerSequences(
    applicationId: string,
    approvalId: string,
    sequences: {
      readonly waitSequence?: number;
      readonly resumeSequence?: number;
    },
  ): Promise<EdgeApprovalRecord> {
    try {
      const result = await this.db.execute<ApprovalRow>({
        sql: `UPDATE edge.approvals
SET ledger_wait_sequence = COALESCE($3, ledger_wait_sequence),
    ledger_resume_sequence = COALESCE($4, ledger_resume_sequence)
WHERE application_id = $1 AND id = $2
RETURNING ${APPROVAL_COLUMNS}`,
        parameters: [
          applicationId,
          approvalId,
          sequences.waitSequence ?? null,
          sequences.resumeSequence ?? null,
        ],
      });
      const row = first(result.rows);
      if (row === undefined) {
        const existing = await this.findApproval(applicationId, approvalId);
        if (existing === null) {
          throw new PlatformError({
            code: "TENANT_SCOPE_VIOLATION",
            message: `edge approval ${approvalId} does not exist in this application`,
          });
        }
        return existing;
      }
      return toApprovalRecord(row);
    } catch (error) {
      throw toTypedGuardError(error);
    }
  }

  // -- envelopes ---------------------------------------------------------------

  async insertEnvelope(input: EdgeEnvelopeInsertInput): Promise<EdgeEnvelopeInsertOutcome> {
    try {
      const result = await this.db.execute<EnvelopeRow>({
        sql: `INSERT INTO edge.envelopes (id, application_id, tenant_id, execution_id, device_id, envelope_key, request_fingerprint, content_digest, content, status, admission, supersedes_envelope_id, command_count, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'admitted', $10::jsonb, $11, 0, $12::timestamptz)
ON CONFLICT (application_id, envelope_key) DO NOTHING
RETURNING ${ENVELOPE_COLUMNS}`,
        parameters: [
          input.envelopeId,
          input.applicationId,
          input.tenantId,
          input.executionId,
          input.deviceId,
          input.envelopeKey,
          input.requestFingerprint,
          input.contentDigest,
          JSON.stringify(input.content),
          JSON.stringify(input.admission),
          input.supersedesEnvelopeId,
          input.createdAt,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return { status: "inserted", record: toEnvelopeRecord(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.findEnvelopeByKey(input.applicationId, input.envelopeKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "edge envelope insert converged but the row is not readable",
      });
    }
    return {
      status: "existing",
      record: existing,
      fingerprintMismatch: existing.requestFingerprint !== input.requestFingerprint,
    };
  }

  private async findEnvelopeWhere(
    predicate: string,
    parameters: readonly unknown[],
  ): Promise<EdgeEnvelopeRecord | null> {
    const result = await this.db.execute<EnvelopeRow>({
      sql: `SELECT ${ENVELOPE_COLUMNS} FROM edge.envelopes WHERE ${predicate}`,
      parameters,
    });
    const row = first(result.rows);
    return row === undefined ? null : toEnvelopeRecord(row);
  }

  async findEnvelope(
    applicationId: string,
    envelopeId: string,
  ): Promise<EdgeEnvelopeRecord | null> {
    return this.findEnvelopeWhere("application_id = $1 AND id = $2", [applicationId, envelopeId]);
  }

  async findEnvelopeByKey(
    applicationId: string,
    envelopeKey: string,
  ): Promise<EdgeEnvelopeRecord | null> {
    return this.findEnvelopeWhere("application_id = $1 AND envelope_key = $2", [
      applicationId,
      envelopeKey,
    ]);
  }

  async findActiveEnvelopeForDevice(
    applicationId: string,
    deviceId: string,
  ): Promise<EdgeEnvelopeRecord | null> {
    return this.findEnvelopeWhere(
      "application_id = $1 AND device_id = $2 AND status = 'admitted' ORDER BY created_at DESC, id DESC LIMIT 1",
      [applicationId, deviceId],
    );
  }

  async listEnvelopesByDevice(
    applicationId: string,
    deviceId: string,
  ): Promise<readonly EdgeEnvelopeRecord[]> {
    const result = await this.db.execute<EnvelopeRow>({
      sql: `SELECT ${ENVELOPE_COLUMNS} FROM edge.envelopes WHERE application_id = $1 AND device_id = $2 ORDER BY created_at, id`,
      parameters: [applicationId, deviceId],
    });
    return result.rows.map(toEnvelopeRecord);
  }

  async applyEnvelopeSupersede(input: EdgeEnvelopeSupersedeInput): Promise<EdgeEnvelopeRecord> {
    try {
      const result = await this.db.execute<EnvelopeRow>({
        sql: `UPDATE edge.envelopes SET status = 'superseded', superseded_by_envelope_id = $3, superseded_at = $4::timestamptz
WHERE application_id = $1 AND id = $2 AND status = 'admitted'
RETURNING ${ENVELOPE_COLUMNS}`,
        parameters: [
          input.applicationId,
          input.envelopeId,
          input.supersededByEnvelopeId,
          input.supersededAt,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toEnvelopeRecord(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const record = await this.findEnvelope(input.applicationId, input.envelopeId);
    if (record === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge envelope ${input.envelopeId} does not exist in this application`,
      });
    }
    if (record.status === "superseded") {
      if (record.supersededByEnvelopeId === input.supersededByEnvelopeId) {
        return record; // converged
      }
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `edge envelope ${record.id} is already superseded by a different admission; supersede links are write-once`,
      });
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `edge envelope ${record.id} is ${record.status}; only admitted envelopes are superseded`,
    });
  }

  async applyGuardedEnvelopeRevocation(
    input: EdgeEnvelopeRevokeInput,
  ): Promise<EdgeEnvelopeRevokeOutcome> {
    try {
      const result = await this.db.execute<EnvelopeRow>({
        sql: `UPDATE edge.envelopes SET status = 'revoked', revoked_at = $3::timestamptz, revocation_reason = $4
WHERE application_id = $1 AND id = $2 AND status = $5
RETURNING ${ENVELOPE_COLUMNS}`,
        parameters: [
          input.applicationId,
          input.envelopeId,
          input.revokedAt,
          input.reason,
          input.expectedStatus,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return { status: "revoked", record: toEnvelopeRecord(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const record = await this.findEnvelope(input.applicationId, input.envelopeId);
    if (record === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge envelope ${input.envelopeId} does not exist in this application`,
      });
    }
    if (record.status === "revoked") {
      return { status: "converged", record };
    }
    return {
      status: "rejected",
      reason: `the envelope is ${record.status} (only an admitted envelope can be revoked)`,
      record,
    };
  }

  async bumpEnvelopeCommandCount(input: {
    readonly applicationId: string;
    readonly envelopeId: string;
    readonly increment: number;
  }): Promise<EdgeEnvelopeRecord> {
    try {
      const result = await this.db.execute<EnvelopeRow>({
        sql: `UPDATE edge.envelopes SET command_count = command_count + $3
WHERE application_id = $1 AND id = $2
RETURNING ${ENVELOPE_COLUMNS}`,
        parameters: [input.applicationId, input.envelopeId, input.increment],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toEnvelopeRecord(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    throw new PlatformError({
      code: "TENANT_SCOPE_VIOLATION",
      message: `edge envelope ${input.envelopeId} does not exist in this application`,
    });
  }

  // -- commands ----------------------------------------------------------------

  async insertCommand(input: EdgeCommandInsertInput): Promise<EdgeCommandInsertOutcome> {
    try {
      const result = await this.db.execute<CommandRow>({
        sql: `INSERT INTO edge.commands (id, application_id, tenant_id, execution_id, device_id, envelope_id, command_key, request_fingerprint, sequence, command_kind, effect_class, channel, magnitude, payload_digest, estimated_micro_usd, not_before, not_after, status, denial_class, denial_reason, approval_id, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz, $17::timestamptz, CASE WHEN $18::text IS NULL THEN 'authorized' ELSE 'denied' END, $18::text, $19, $20, $21::timestamptz)
ON CONFLICT (application_id, command_key) DO NOTHING
RETURNING ${COMMAND_COLUMNS}`,
        parameters: [
          input.commandId,
          input.applicationId,
          input.tenantId,
          input.executionId,
          input.deviceId,
          input.envelopeId,
          input.commandKey,
          input.requestFingerprint,
          input.sequence,
          input.commandKind,
          input.effectClass,
          input.channel,
          input.magnitude,
          input.payloadDigest,
          input.estimatedMicroUsd,
          input.notBefore,
          input.notAfter,
          input.denialClass,
          input.denialReason,
          input.approvalId,
          input.requestedAt,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return { status: "claimed", record: toCommandRecord(row) };
      }
    } catch (error) {
      // The staged-commandId reuse (the crash-stable identity above): a
      // same-key racer reusing the checkpointed command id collides on
      // the identity indexes BEFORE the (application_id, command_key)
      // arbiter is checked — that collision IS the same-key convergence
      // (the row behind the id is the row behind the key), so it falls
      // through to the keyed re-read below instead of raising. The
      // sequence-gate trigger has already run (BEFORE INSERT) and the
      // keyed re-read arbitrates the fingerprint, so no semantic check
      // is bypassed; every other violation keeps its typed mapping.
      if (!isCommandIdentityConflict(error)) {
        throw toTypedGuardError(error);
      }
    }
    const existing = await this.findCommandByKey(input.applicationId, input.commandKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "edge command insert converged but the row is not readable",
      });
    }
    return {
      status: "existing",
      record: existing,
      fingerprintMismatch: existing.requestFingerprint !== input.requestFingerprint,
    };
  }

  async finalizeCommand(input: EdgeCommandFinalizeInput): Promise<EdgeCommandRecord> {
    try {
      const result = await this.db.execute<CommandRow>({
        sql: `UPDATE edge.commands SET
  status = $3,
  failure_class = $4,
  failure_message = $5,
  dispatch_digest = COALESCE($6, dispatch_digest),
  usage_micro_usd = $7,
  dispatched_at = CASE WHEN $8::timestamptz IS NULL THEN dispatched_at ELSE $8::timestamptz END,
  settled_at = $9::timestamptz,
  reconciled_at = $10::timestamptz,
  ledger_result_sequence = COALESCE($11, ledger_result_sequence)
WHERE application_id = $1 AND id = $2
  AND (status = 'authorized' AND $3 IN ('dispatched','failed','invalidated')
    OR status = 'dispatched' AND $3 IN ('settled','failed','conflicted'))
RETURNING ${COMMAND_COLUMNS}`,
        parameters: [
          input.applicationId,
          input.commandId,
          input.status,
          input.failureClass,
          input.failureMessage,
          input.dispatchDigest,
          input.usageMicroUsd,
          input.dispatchedAt,
          input.settledAt,
          input.reconciledAt,
          input.ledgerResultSequence,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toCommandRecord(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const record = await this.findCommand(input.applicationId, input.commandId);
    if (record === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge command ${input.commandId} does not exist in this application`,
      });
    }
    if (record.status === input.status) {
      return record; // converged replay of the same terminal outcome
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `edge command ${record.id} cannot move from ${record.status} to ${input.status}`,
      details: { guard: "ec_commands_lifecycle_guard" },
    });
  }

  async bindCommandLedgerSequence(input: EdgeCommandLedgerBinding): Promise<EdgeCommandRecord> {
    try {
      const column =
        input.phase === "requested" ? "ledger_requested_sequence" : "ledger_result_sequence";
      const result = await this.db.execute<CommandRow>({
        sql: `UPDATE edge.commands SET ${column} = $3
WHERE application_id = $1 AND id = $2 AND ${column} IS NULL
RETURNING ${COMMAND_COLUMNS}`,
        parameters: [input.applicationId, input.commandId, input.sequence],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toCommandRecord(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const record = await this.findCommand(input.applicationId, input.commandId);
    if (record === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge command ${input.commandId} does not exist in this application`,
      });
    }
    return record; // already bound (write-once convergence)
  }

  private async findCommandWhere(
    predicate: string,
    parameters: readonly unknown[],
  ): Promise<EdgeCommandRecord | null> {
    const result = await this.db.execute<CommandRow>({
      sql: `SELECT ${COMMAND_COLUMNS} FROM edge.commands WHERE ${predicate}`,
      parameters,
    });
    const row = first(result.rows);
    return row === undefined ? null : toCommandRecord(row);
  }

  async findCommand(applicationId: string, commandId: string): Promise<EdgeCommandRecord | null> {
    return this.findCommandWhere("application_id = $1 AND id = $2", [applicationId, commandId]);
  }

  async findCommandByKey(
    applicationId: string,
    commandKey: string,
  ): Promise<EdgeCommandRecord | null> {
    return this.findCommandWhere("application_id = $1 AND command_key = $2", [
      applicationId,
      commandKey,
    ]);
  }

  async listCommandsByDevice(
    applicationId: string,
    deviceId: string,
  ): Promise<readonly EdgeCommandRecord[]> {
    const result = await this.db.execute<CommandRow>({
      sql: `SELECT ${COMMAND_COLUMNS} FROM edge.commands WHERE application_id = $1 AND device_id = $2 ORDER BY sequence, id`,
      parameters: [applicationId, deviceId],
    });
    return result.rows.map(toCommandRecord);
  }

  async listCommandsByEnvelope(
    applicationId: string,
    envelopeId: string,
  ): Promise<readonly EdgeCommandRecord[]> {
    const result = await this.db.execute<CommandRow>({
      sql: `SELECT ${COMMAND_COLUMNS} FROM edge.commands WHERE application_id = $1 AND envelope_id = $2 ORDER BY sequence, id`,
      parameters: [applicationId, envelopeId],
    });
    return result.rows.map(toCommandRecord);
  }

  async settleCommand(
    applicationId: string,
    commandId: string,
    settledAt: string,
    reconciledAt: string,
  ): Promise<EdgeCommandRecord> {
    try {
      const result = await this.db.execute<CommandRow>({
        sql: `UPDATE edge.commands SET status = 'settled', settled_at = $3::timestamptz, reconciled_at = $4::timestamptz, usage_micro_usd = COALESCE(usage_micro_usd, estimated_micro_usd)
WHERE application_id = $1 AND id = $2 AND status = 'dispatched'
RETURNING ${COMMAND_COLUMNS}`,
        parameters: [applicationId, commandId, settledAt, reconciledAt],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toCommandRecord(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const record = await this.findCommand(applicationId, commandId);
    if (record === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge command ${commandId} does not exist in this application`,
      });
    }
    if (record.status === "settled") {
      return record; // settled EXACTLY ONCE (the convergence)
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `edge command ${record.id} is ${record.status}; only dispatched commands settle`,
      details: { guard: "ec_commands_lifecycle_guard" },
    });
  }

  async conflictCommand(
    applicationId: string,
    commandId: string,
    reconciledAt: string,
  ): Promise<EdgeCommandRecord> {
    try {
      const result = await this.db.execute<CommandRow>({
        sql: `UPDATE edge.commands SET status = 'conflicted', reconciled_at = $3::timestamptz
WHERE application_id = $1 AND id = $2 AND status = 'dispatched'
RETURNING ${COMMAND_COLUMNS}`,
        parameters: [applicationId, commandId, reconciledAt],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toCommandRecord(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const record = await this.findCommand(applicationId, commandId);
    if (record === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge command ${commandId} does not exist in this application`,
      });
    }
    if (record.status === "conflicted") {
      return record;
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `edge command ${record.id} is ${record.status}; only dispatched commands conflict`,
      details: { guard: "ec_commands_lifecycle_guard" },
    });
  }

  // -- actuation events ----------------------------------------------------------

  async insertActuationEvent(
    input: EdgeActuationEventInsertInput,
  ): Promise<EdgeActuationEventInsertOutcome> {
    try {
      const result = await this.db.execute<ActuationRow>({
        sql: `INSERT INTO edge.actuation_events (id, application_id, tenant_id, execution_id, device_id, command_id, command_key, sequence, actuation_class, violation_kind, channel, magnitude, actuation_digest, occurred_at, reconciled_at, reconciliation_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15::timestamptz, $16)
ON CONFLICT (application_id, device_id, actuation_digest) DO NOTHING
RETURNING ${ACTUATION_COLUMNS}`,
        parameters: [
          input.id,
          input.applicationId,
          input.tenantId,
          input.executionId,
          input.deviceId,
          input.commandId,
          input.commandKey,
          input.sequence,
          input.actuationClass,
          input.violationKind,
          input.channel,
          input.magnitude,
          input.actuationDigest,
          input.occurredAt,
          input.reconciledAt,
          input.reconciliationId,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return { status: "inserted", record: toActuationRecord(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const result = await this.db.execute<ActuationRow>({
      sql: `SELECT ${ACTUATION_COLUMNS} FROM edge.actuation_events WHERE application_id = $1 AND device_id = $2 AND actuation_digest = $3`,
      parameters: [input.applicationId, input.deviceId, input.actuationDigest],
    });
    const row = first(result.rows);
    if (row === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "edge actuation insert converged but the row is not readable",
      });
    }
    return { status: "converged", record: toActuationRecord(row) };
  }

  async listActuationEvents(
    applicationId: string,
    deviceId: string,
  ): Promise<readonly EdgeActuationEventRecord[]> {
    const result = await this.db.execute<ActuationRow>({
      sql: `SELECT ${ACTUATION_COLUMNS} FROM edge.actuation_events WHERE application_id = $1 AND device_id = $2 ORDER BY occurred_at, id`,
      parameters: [applicationId, deviceId],
    });
    return result.rows.map(toActuationRecord);
  }

  // -- sensor observations ---------------------------------------------------------

  async insertSensorObservation(
    input: EdgeSensorObservationInsertInput,
  ): Promise<EdgeSensorObservationInsertOutcome> {
    // The gapless per-device sequence is derived HERE (the migration's
    // sequence gate verifies it physically at insert).
    const countResult = await this.db.execute<{ readonly total: string }>({
      sql: `SELECT COUNT(*)::text AS total FROM edge.sensor_observations WHERE application_id = $1 AND device_id = $2`,
      parameters: [input.applicationId, input.deviceId],
    });
    const sequence = Number.parseInt(countResult.rows[0]?.total ?? "0", 10) + 1;
    try {
      const result = await this.db.execute<SensorRow>({
        sql: `INSERT INTO edge.sensor_observations (id, application_id, tenant_id, execution_id, device_id, sequence, observation_key, observation_type, retention, content_digest, content, observed_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)
ON CONFLICT (application_id, observation_key) DO NOTHING
RETURNING ${SENSOR_COLUMNS}`,
        parameters: [
          input.id,
          input.applicationId,
          input.tenantId,
          input.executionId,
          input.deviceId,
          sequence,
          input.observationKey,
          input.observationType,
          input.retention,
          input.contentDigest,
          input.content,
          input.observedAt,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return { status: "inserted", record: toSensorRecord(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.db.execute<SensorRow>({
      sql: `SELECT ${SENSOR_COLUMNS} FROM edge.sensor_observations WHERE application_id = $1 AND observation_key = $2`,
      parameters: [input.applicationId, input.observationKey],
    });
    const row = first(existing.rows);
    if (row === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "edge sensor observation insert converged but the row is not readable",
      });
    }
    if (toSensorRecord(row).contentDigest !== input.contentDigest) {
      return {
        status: "conflict",
        reason: `sensor observation key ${input.observationKey} was already used with different content (key reuse)`,
      };
    }
    return { status: "converged", record: toSensorRecord(row) };
  }

  async bindSensorObservationLedgerSequence(
    applicationId: string,
    observationId: string,
    ledgerSequence: number,
  ): Promise<EdgeSensorObservationRecord> {
    try {
      const result = await this.db.execute<SensorRow>({
        sql: `UPDATE edge.sensor_observations SET ledger_sequence = $3
WHERE application_id = $1 AND id = $2 AND ledger_sequence IS NULL
RETURNING ${SENSOR_COLUMNS}`,
        parameters: [applicationId, observationId, ledgerSequence],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toSensorRecord(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const result = await this.db.execute<SensorRow>({
      sql: `SELECT ${SENSOR_COLUMNS} FROM edge.sensor_observations WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, observationId],
    });
    const row = first(result.rows);
    if (row === undefined) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge sensor observation ${observationId} does not exist in this application`,
      });
    }
    return toSensorRecord(row); // already bound (write-once convergence)
  }

  async listSensorObservations(
    applicationId: string,
    deviceId: string,
  ): Promise<readonly EdgeSensorObservationRecord[]> {
    const result = await this.db.execute<SensorRow>({
      sql: `SELECT ${SENSOR_COLUMNS} FROM edge.sensor_observations WHERE application_id = $1 AND device_id = $2 ORDER BY sequence, id`,
      parameters: [applicationId, deviceId],
    });
    return result.rows.map(toSensorRecord);
  }

  // -- reconciliations ----------------------------------------------------------

  async insertReconciliation(
    input: EdgeReconciliationInsertInput,
  ): Promise<EdgeReconciliationRecord> {
    try {
      const result = await this.db.execute<ReconciliationRow>({
        sql: `INSERT INTO edge.reconciliations (id, application_id, tenant_id, device_id, report_digest, status, confirmed_count, autonomous_count, violation_count, settled_count, reconciled_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)
ON CONFLICT (application_id, report_digest) DO NOTHING
RETURNING id, application_id, tenant_id, device_id, report_digest, status, confirmed_count, autonomous_count, violation_count, settled_count, reconciled_at`,
        parameters: [
          input.id,
          input.applicationId,
          input.tenantId,
          input.deviceId,
          input.reportDigest,
          input.status,
          input.confirmedCount,
          input.autonomousCount,
          input.violationCount,
          input.settledCount,
          input.reconciledAt,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toReconciliationRecord(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.findReconciliationByDigest(input.applicationId, input.reportDigest);
    if (existing !== null) {
      return existing; // the digest-converged replay
    }
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "edge reconciliation insert converged but the row is not readable",
    });
  }

  async findReconciliationByDigest(
    applicationId: string,
    reportDigest: string,
  ): Promise<EdgeReconciliationRecord | null> {
    const result = await this.db.execute<ReconciliationRow>({
      sql: `SELECT id, application_id, tenant_id, device_id, report_digest, status, confirmed_count, autonomous_count, violation_count, settled_count, reconciled_at
FROM edge.reconciliations WHERE application_id = $1 AND report_digest = $2`,
      parameters: [applicationId, reportDigest],
    });
    const row = first(result.rows);
    return row === undefined ? null : toReconciliationRecord(row);
  }

  async findConflictReconciliation(
    applicationId: string,
    deviceId: string,
  ): Promise<EdgeReconciliationRecord | null> {
    const result = await this.db.execute<ReconciliationRow>({
      sql: `SELECT id, application_id, tenant_id, device_id, report_digest, status, confirmed_count, autonomous_count, violation_count, settled_count, reconciled_at
FROM edge.reconciliations WHERE application_id = $1 AND device_id = $2 AND status = 'conflict'
ORDER BY reconciled_at DESC, id DESC LIMIT 1`,
      parameters: [applicationId, deviceId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toReconciliationRecord(row);
  }

  // -- the durable operation state -------------------------------------------------

  async beginEdgeOperation(input: EdgeOperationBeginInput): Promise<EdgeOperationBeginOutcome> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `INSERT INTO edge.operations (id, application_id, tenant_id, device_id, execution_id, operation_kind, operation_key, request_fingerprint, status, attempts, stage, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 1, NULL, $9::timestamptz, $9::timestamptz)
ON CONFLICT (application_id, operation_key) DO NOTHING
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [
          input.operationId,
          input.applicationId,
          input.tenantId,
          input.deviceId,
          input.executionId,
          input.operationKind,
          input.operationKey,
          input.requestFingerprint,
          input.createdAt,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return { status: "begun", record: toOperationRecord(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.findOperation(input.applicationId, input.operationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "edge operation claim converged but the row is not readable",
      });
    }
    if (existing.status === "pending") {
      // A re-claim of a PENDING row is a retry (monotonic attempts).
      try {
        const result = await this.db.execute<OperationRow>({
          sql: `UPDATE edge.operations SET attempts = attempts + 1, updated_at = $3::timestamptz
WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
RETURNING ${OPERATION_COLUMNS}`,
          parameters: [input.applicationId, input.operationKey, input.createdAt],
        });
        const row = first(result.rows);
        if (row !== undefined) {
          return { status: "existing", record: toOperationRecord(row) };
        }
      } catch (error) {
        throw toTypedGuardError(error);
      }
    }
    return { status: "existing", record: existing };
  }

  async recordOperationCheckpoint(
    applicationId: string,
    operationKey: string,
    stage: Readonly<Record<string, unknown>>,
    updatedAt: string,
  ): Promise<EdgeOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE edge.operations SET stage = $3::jsonb, updated_at = $4::timestamptz
WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [applicationId, operationKey, JSON.stringify(stage), updatedAt],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toOperationRecord(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.findOperation(applicationId, operationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge operation ${operationKey} does not exist in this application`,
      });
    }
    return existing; // terminal rows converge (no checkpoint move)
  }

  async completeOperation(
    applicationId: string,
    operationKey: string,
    completedAt: string,
  ): Promise<EdgeOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE edge.operations SET status = 'completed', completed_at = $3::timestamptz, updated_at = $3::timestamptz, failure_reason = NULL
WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [applicationId, operationKey, completedAt],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toOperationRecord(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.findOperation(applicationId, operationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge operation ${operationKey} does not exist in this application`,
      });
    }
    return existing; // terminal rows converge
  }

  async failOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    updatedAt: string,
  ): Promise<EdgeOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE edge.operations SET status = 'failed', failure_reason = $3, updated_at = $4::timestamptz
WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [applicationId, operationKey, reason.slice(0, 512), updatedAt],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toOperationRecord(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.findOperation(applicationId, operationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `edge operation ${operationKey} does not exist in this application`,
      });
    }
    return existing; // terminal rows converge
  }

  async findOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<EdgeOperationRecord | null> {
    const result = await this.db.execute<OperationRow>({
      sql: `SELECT ${OPERATION_COLUMNS} FROM edge.operations WHERE application_id = $1 AND operation_key = $2`,
      parameters: [applicationId, operationKey],
    });
    const row = first(result.rows);
    return row === undefined ? null : toOperationRecord(row);
  }
}
