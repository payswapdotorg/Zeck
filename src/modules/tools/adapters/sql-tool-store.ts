/**
 * SQL adapter for the tools module (WORK-010).
 *
 * Bridges `ToolInvocationStore` to the provider-neutral platform
 * `DatabasePort`. No driver/SDK import happens here — `pg` is owned by the
 * platform DB layer; this file only speaks the neutral port.
 *
 * Physical invariants (migration 0005) mirrored by this adapter:
 *   - one durable row per (application_id, invocation_key) — the request
 *     idempotency anchor; the INSERT ... ON CONFLICT DO NOTHING claim
 *     pattern makes concurrent identical requests converge (the loser's
 *     insert waits on the winner's transaction through the unique index
 *     arbitration, then re-reads the committed row);
 *   - fingerprint mismatch on convergence → IDEMPOTENCY_KEY_REUSED (same
 *     key, different logical request — never silently adopted);
 *   - terminal rows (denied | succeeded | tool-failed) are IMMUTABLE: the
 *     outcome recording is a guarded UPDATE `WHERE status = 'dispatching'`
 *     (first writer wins; the loser re-reads the winner's committed
 *     outcome);
 *   - rows are never deleted;
 *   - the outcome vocabulary is CHECK-bound to the tool axis
 *     (tool-success | tool-failure) — verification/provider classes are
 *     unrepresentable at the storage boundary.
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type {
  ToolDenialClass,
  ToolFailureClass,
  ToolInvocationRecord,
  ToolInvocationStatus,
  ToolOutcomeClass,
  ToolPolicyEvidence,
} from "../domain/invocation";
import { TOOL_INVOCATION_STATUSES } from "../domain/invocation";
import type {
  BindLedgerSequenceInput,
  ClaimDispatchingInput,
  ClaimOutcome,
  RecordDeniedInput,
  RecordOutcomeInput,
  ToolInvocationStore,
} from "../ports/tool-invocation-store";

interface InvocationRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly invocation_key: string;
  readonly request_fingerprint: string;
  readonly tool_id: string;
  readonly tool_version: string;
  readonly capability_id: string;
  readonly status: string;
  readonly outcome_class: string | null;
  readonly denial_class: string | null;
  readonly denial_code: string | null;
  readonly denial_reason: string | null;
  readonly failure_class: string | null;
  readonly failure_message: string | null;
  readonly retryable: boolean;
  readonly input_digest: string;
  readonly input_artifacts: string[];
  readonly output: Record<string, unknown> | null;
  readonly output_artifacts: string[];
  readonly usage_micro_usd: string | null;
  readonly budget_operation_id: string | null;
  readonly policy_evidence: ToolPolicyEvidence | null;
  readonly capability_satisfaction: string | null;
  readonly requested_at: Date | string;
  readonly dispatched_at: Date | string | null;
  readonly completed_at: Date | string | null;
  readonly duration_ms: number | null;
  readonly ledger_requested_sequence: number | null;
  readonly ledger_result_sequence: number | null;
}

const INVOCATION_COLUMNS = `id, application_id, tenant_id, execution_id, invocation_key,
request_fingerprint, tool_id, tool_version, capability_id, status, outcome_class,
denial_class, denial_code, denial_reason, failure_class, failure_message, retryable,
input_digest, input_artifacts, output, output_artifacts, usage_micro_usd,
budget_operation_id, policy_evidence, capability_satisfaction, requested_at,
dispatched_at, completed_at, duration_ms, ledger_requested_sequence, ledger_result_sequence`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toRecord(row: InvocationRow): ToolInvocationRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    invocationKey: row.invocation_key,
    requestFingerprint: row.request_fingerprint,
    toolId: row.tool_id,
    toolVersion: row.tool_version,
    capabilityId: row.capability_id,
    status: row.status as ToolInvocationStatus,
    outcomeClass: row.outcome_class === null ? null : (row.outcome_class as ToolOutcomeClass),
    denialClass: row.denial_class === null ? null : (row.denial_class as ToolDenialClass),
    denialCode: row.denial_code,
    denialReason: row.denial_reason,
    failureClass: row.failure_class === null ? null : (row.failure_class as ToolFailureClass),
    failureMessage: row.failure_message,
    retryable: row.retryable,
    inputDigest: row.input_digest,
    inputArtifacts: row.input_artifacts ?? [],
    output: row.output ?? null,
    outputArtifacts: row.output_artifacts ?? [],
    usageMicroUsd: row.usage_micro_usd,
    budgetOperationId: row.budget_operation_id,
    policyEvidence: row.policy_evidence ?? null,
    capabilitySatisfaction: row.capability_satisfaction,
    requestedAt: iso(row.requested_at),
    dispatchedAt: row.dispatched_at === null ? null : iso(row.dispatched_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    ledgerRequestedSequence:
      row.ledger_requested_sequence === null ? null : Number(row.ledger_requested_sequence),
    ledgerResultSequence:
      row.ledger_result_sequence === null ? null : Number(row.ledger_result_sequence),
  };
}

function first<T>(rows: readonly T[]): T | undefined {
  return rows.length > 0 ? rows[0] : undefined;
}

export class SqlToolInvocationStore implements ToolInvocationStore {
  constructor(private readonly db: DatabasePort) {}

  async findByKey(
    applicationId: string,
    invocationKey: string,
  ): Promise<ToolInvocationRecord | null> {
    const result = await this.db.execute<InvocationRow>({
      sql: `SELECT ${INVOCATION_COLUMNS} FROM tools.tool_invocations
WHERE application_id = $1 AND invocation_key = $2`,
      parameters: [applicationId, invocationKey],
    });
    const row = first(result.rows);
    return row === undefined ? null : toRecord(row);
  }

  async findById(
    applicationId: string,
    invocationId: string,
  ): Promise<ToolInvocationRecord | null> {
    const result = await this.db.execute<InvocationRow>({
      sql: `SELECT ${INVOCATION_COLUMNS} FROM tools.tool_invocations
WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, invocationId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toRecord(row);
  }

  async claimDispatching(input: ClaimDispatchingInput): Promise<ClaimOutcome> {
    const inserted = await this.db.execute<InvocationRow>({
      sql: `INSERT INTO tools.tool_invocations
  (id, application_id, tenant_id, execution_id, invocation_key, request_fingerprint,
   tool_id, tool_version, capability_id, status, input_digest, input_artifacts,
   budget_operation_id, policy_evidence, capability_satisfaction, requested_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'dispatching', $10, $11::jsonb, $12,
        $13::jsonb, $14, $15)
ON CONFLICT (application_id, invocation_key) DO NOTHING
RETURNING ${INVOCATION_COLUMNS}`,
      parameters: [
        input.id,
        input.applicationId,
        input.tenantId,
        input.executionId,
        input.invocationKey,
        input.requestFingerprint,
        input.toolId,
        input.toolVersion,
        input.capabilityId,
        input.inputDigest,
        JSON.stringify([...input.inputArtifacts]),
        input.budgetOperationId,
        input.policyEvidence === null ? null : JSON.stringify(input.policyEvidence),
        input.capabilitySatisfaction,
        input.requestedAt,
      ],
    });
    const row = first(inserted.rows);
    if (row !== undefined) {
      return { claimed: true, record: toRecord(row) };
    }
    // A concurrent/previous request owns the key (the unique-index
    // arbitration waited for the winner's commit). Same fingerprint
    // converges; a different fingerprint is key reuse.
    const existing = await this.expectByKey(input.applicationId, input.invocationKey);
    if (existing.requestFingerprint !== input.requestFingerprint) {
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "idempotency key was already used with a different request fingerprint",
        details: { invocationId: existing.id },
      });
    }
    return { claimed: false, record: existing };
  }

  async recordDenied(input: RecordDeniedInput): Promise<ClaimOutcome> {
    const inserted = await this.db.execute<InvocationRow>({
      sql: `INSERT INTO tools.tool_invocations
  (id, application_id, tenant_id, execution_id, invocation_key, request_fingerprint,
   tool_id, tool_version, capability_id, status, denial_class, denial_code,
   denial_reason, input_digest, input_artifacts, requested_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'denied', $10, $11, $12, $13, $14::jsonb, $15)
ON CONFLICT (application_id, invocation_key) DO NOTHING
RETURNING ${INVOCATION_COLUMNS}`,
      parameters: [
        input.id,
        input.applicationId,
        input.tenantId,
        input.executionId,
        input.invocationKey,
        input.requestFingerprint,
        input.toolId,
        input.toolVersion,
        input.capabilityId,
        input.denialClass,
        input.denialCode,
        input.denialReason,
        input.inputDigest,
        JSON.stringify([...input.inputArtifacts]),
        input.requestedAt,
      ],
    });
    const row = first(inserted.rows);
    if (row !== undefined) {
      return { claimed: true, record: toRecord(row) };
    }
    const existing = await this.expectByKey(input.applicationId, input.invocationKey);
    if (existing.requestFingerprint !== input.requestFingerprint) {
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "idempotency key was already used with a different request fingerprint",
        details: { invocationId: existing.id },
      });
    }
    return { claimed: false, record: existing };
  }

  async recordOutcome(input: RecordOutcomeInput): Promise<ToolInvocationRecord> {
    const updated = await this.db.execute<InvocationRow>({
      sql: `UPDATE tools.tool_invocations SET
  status = $3, outcome_class = $4, output = $5::jsonb, output_artifacts = $6::jsonb,
  failure_class = $7, failure_message = $8, retryable = $9, usage_micro_usd = $10,
  dispatched_at = $11, completed_at = $12, duration_ms = $13
WHERE application_id = $1 AND invocation_key = $2 AND status = 'dispatching'
RETURNING ${INVOCATION_COLUMNS}`,
      parameters: [
        input.applicationId,
        input.invocationKey,
        input.status,
        input.outcomeClass,
        input.output === null ? null : JSON.stringify(input.output),
        JSON.stringify([...input.outputArtifacts]),
        input.failureClass,
        input.failureMessage,
        input.retryable,
        input.usageMicroUsd,
        input.dispatchedAt,
        input.completedAt,
        input.durationMs,
      ],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return toRecord(row);
    }
    // The guarded window closed: a concurrent writer finalized first (our
    // UPDATE waited on the row lock and re-evaluated). Converge on the
    // winner's committed outcome.
    return this.expectByKey(input.applicationId, input.invocationKey);
  }

  async bindLedgerSequence(input: BindLedgerSequenceInput): Promise<void> {
    const column =
      input.phase === "requested" ? "ledger_requested_sequence" : "ledger_result_sequence";
    await this.db.execute({
      sql: `UPDATE tools.tool_invocations SET ${column} = $3
WHERE application_id = $1 AND invocation_key = $2 AND status = 'dispatching' AND ${column} IS NULL`,
      parameters: [input.applicationId, input.invocationKey, input.sequence],
    });
  }

  async listByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly ToolInvocationRecord[]> {
    const result = await this.db.execute<InvocationRow>({
      sql: `SELECT ${INVOCATION_COLUMNS} FROM tools.tool_invocations
WHERE application_id = $1 AND execution_id = $2 ORDER BY requested_at, id`,
      parameters: [applicationId, executionId],
    });
    return result.rows.map(toRecord);
  }

  isKnownStatus(status: string): status is ToolInvocationStatus {
    return (TOOL_INVOCATION_STATUSES as readonly string[]).includes(status);
  }

  private async expectByKey(
    applicationId: string,
    invocationKey: string,
  ): Promise<ToolInvocationRecord> {
    const existing = await this.findByKey(applicationId, invocationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "tool invocation row disappeared during arbitration (rows are never deleted)",
      });
    }
    return existing;
  }
}
