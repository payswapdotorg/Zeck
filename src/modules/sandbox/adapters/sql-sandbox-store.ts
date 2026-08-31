/**
 * SQL sandbox store adapter (sandbox module; WORK-012).
 *
 * Implements the `SandboxStore` port over the provider-neutral
 * `DatabasePort` against migration `0007_sandbox.sql` — the WORK-004/006/
 * 010/011 SQL-store discipline:
 *
 *   - every insert converges through ON CONFLICT DO NOTHING unique-key
 *     arbitration (first writer wins; concurrent duplicates converge on
 *     the committed row);
 *   - the only mutations are the GUARDED transitions (environment
 *     lifecycle with `from` status in the WHERE clause; sandbox admitted →
 *     dispatching claim; dispatching → completed/failed finalization) —
 *     first-writer-wins with re-read convergence;
 *   - specification/runtime-metadata immutability and terminal-row
 *     immutability are enforced PHYSICALLY by the migration's triggers;
 *     this adapter never issues a statement that would violate them;
 *   - no UPDATE/DELETE path exists for environment specifications or
 *     runtime metadata anywhere in this file.
 */

import type { DatabasePort, Transaction } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type { ComputeEnvironmentRecord, ComputeEnvironmentSpec } from "../domain/environment";
import { isEnvironmentLifecycleStatus, isSandboxEnvironmentKind } from "../domain/environment";
import type {
  SandboxDenialClass,
  SandboxDenialCode,
  SandboxExecutionRecord,
  SandboxFailureClass,
  SandboxOutcomeClass,
  SandboxRuntimeMetadata,
} from "../domain/sandbox";
import { isSandboxExecutionStatus } from "../domain/sandbox";
import type {
  BindLedgerSequenceInput,
  ClaimOutcome,
  InsertEnvironmentInput,
  InsertSandboxInput,
  RecordOutcomeInput,
  SandboxStore,
  UpdateEnvironmentStatusInput,
} from "../ports/sandbox-store";

interface EnvironmentRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly kind: string;
  readonly spec: unknown;
  readonly spec_digest: string;
  readonly status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface SandboxRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly sandbox_key: string;
  readonly request_fingerprint: string;
  readonly environment_id: string;
  readonly kind: string;
  readonly status: string;
  readonly runtime_metadata: unknown;
  readonly denial_class: string | null;
  readonly denial_code: string | null;
  readonly denial_reason: string | null;
  readonly outcome_class: string | null;
  readonly failure_class: string | null;
  readonly failure_message: string | null;
  readonly retryable: boolean;
  readonly output_digest: string | null;
  readonly usage_micro_usd: string | null;
  readonly budget_operation_id: string | null;
  readonly ledger_admitted_sequence: number | null;
  readonly ledger_completed_sequence: number | null;
  readonly created_at: Date;
  readonly dispatched_at: Date | null;
  readonly completed_at: Date | null;
  readonly duration_ms: number | null;
}

const ENVIRONMENT_COLUMNS =
  "id, application_id, tenant_id, slug, name, description, kind, spec, spec_digest, status, created_at, updated_at";
const SANDBOX_COLUMNS =
  "id, application_id, tenant_id, execution_id, sandbox_key, request_fingerprint, environment_id, kind, status, runtime_metadata, denial_class, denial_code, denial_reason, outcome_class, failure_class, failure_message, retryable, output_digest, usage_micro_usd, budget_operation_id, ledger_admitted_sequence, ledger_completed_sequence, created_at, dispatched_at, completed_at, duration_ms";

function first<T>(rows: readonly T[]): T | undefined {
  return rows[0];
}

function isoOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toEnvironment(row: EnvironmentRow): ComputeEnvironmentRecord {
  if (!isSandboxEnvironmentKind(row.kind)) {
    throw new PlatformError({
      code: "SANDBOX_ERROR",
      message: `stored environment ${row.id} carries an unknown kind "${row.kind}"`,
    });
  }
  if (!isEnvironmentLifecycleStatus(row.status)) {
    throw new PlatformError({
      code: "SANDBOX_ERROR",
      message: `stored environment ${row.id} carries an unknown status "${row.status}"`,
    });
  }
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    kind: row.kind,
    spec: row.spec as ComputeEnvironmentSpec,
    specDigest: row.spec_digest,
    status: row.status,
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at),
  };
}

function toSandbox(row: SandboxRow): SandboxExecutionRecord {
  if (!isSandboxExecutionStatus(row.status)) {
    throw new PlatformError({
      code: "SANDBOX_ERROR",
      message: `stored sandbox ${row.id} carries an unknown status "${row.status}"`,
    });
  }
  if (!isSandboxEnvironmentKind(row.kind)) {
    throw new PlatformError({
      code: "SANDBOX_ERROR",
      message: `stored sandbox ${row.id} carries an unknown kind "${row.kind}"`,
    });
  }
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    sandboxKey: row.sandbox_key,
    requestFingerprint: row.request_fingerprint,
    environmentId: row.environment_id,
    kind: row.kind,
    status: row.status,
    runtimeMetadata: row.runtime_metadata as SandboxRuntimeMetadata,
    denialClass: (row.denial_class as SandboxDenialClass | null) ?? null,
    denialCode: (row.denial_code as SandboxDenialCode | null) ?? null,
    denialReason: row.denial_reason,
    outcomeClass: (row.outcome_class as SandboxOutcomeClass | null) ?? null,
    failureClass: (row.failure_class as SandboxFailureClass | null) ?? null,
    failureMessage: row.failure_message,
    retryable: row.retryable,
    outputDigest: row.output_digest,
    usageMicroUsd: row.usage_micro_usd,
    budgetOperationId: row.budget_operation_id,
    ledgerAdmittedSequence: row.ledger_admitted_sequence,
    ledgerCompletedSequence: row.ledger_completed_sequence,
    createdAt: isoOf(row.created_at),
    dispatchedAt: row.dispatched_at === null ? null : isoOf(row.dispatched_at),
    completedAt: row.completed_at === null ? null : isoOf(row.completed_at),
    durationMs: row.duration_ms,
  };
}

export class SqlSandboxStore implements SandboxStore {
  constructor(private readonly db: DatabasePort) {}

  // ---- environment catalog -------------------------------------------------

  async insertEnvironment(
    input: InsertEnvironmentInput,
  ): Promise<ClaimOutcome<ComputeEnvironmentRecord>> {
    const inserted = await this.db.execute<EnvironmentRow>({
      sql: `INSERT INTO sandbox.compute_environments (id, application_id, tenant_id, slug, name, description, kind, spec, spec_digest, status, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'available', $10, $10)
ON CONFLICT (application_id, slug) DO NOTHING
RETURNING ${ENVIRONMENT_COLUMNS}`,
      parameters: [
        input.id,
        input.applicationId,
        input.tenantId,
        input.slug,
        input.name,
        input.description,
        input.kind,
        JSON.stringify(input.spec),
        input.specDigest,
        input.createdAt,
      ],
    });
    const row = first(inserted.rows);
    if (row !== undefined) {
      return { claimed: true, record: toEnvironment(row) };
    }
    const existing = await this.findEnvironmentBySlug(input.applicationId, input.slug);
    if (existing === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "environment insert converged but the committed row is unreadable",
      });
    }
    return { claimed: false, record: existing };
  }

  async findEnvironmentBySlug(
    applicationId: string,
    slug: string,
  ): Promise<ComputeEnvironmentRecord | null> {
    const result = await this.db.execute<EnvironmentRow>({
      sql: `SELECT ${ENVIRONMENT_COLUMNS} FROM sandbox.compute_environments WHERE application_id = $1 AND slug = $2`,
      parameters: [applicationId, slug],
    });
    const row = first(result.rows);
    return row === undefined ? null : toEnvironment(row);
  }

  async findEnvironment(
    applicationId: string,
    environmentId: string,
  ): Promise<ComputeEnvironmentRecord | null> {
    const result = await this.db.execute<EnvironmentRow>({
      sql: `SELECT ${ENVIRONMENT_COLUMNS} FROM sandbox.compute_environments WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, environmentId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toEnvironment(row);
  }

  async listEnvironments(applicationId: string): Promise<readonly ComputeEnvironmentRecord[]> {
    const result = await this.db.execute<EnvironmentRow>({
      sql: `SELECT ${ENVIRONMENT_COLUMNS} FROM sandbox.compute_environments WHERE application_id = $1 ORDER BY created_at, id`,
      parameters: [applicationId],
    });
    return result.rows.map(toEnvironment);
  }

  async updateEnvironmentStatus(
    input: UpdateEnvironmentStatusInput,
  ): Promise<ClaimOutcome<ComputeEnvironmentRecord>> {
    const updated = await this.db.execute<EnvironmentRow>({
      sql: `UPDATE sandbox.compute_environments
SET status = $1, updated_at = $2
WHERE application_id = $3 AND id = $4 AND status = $5
RETURNING ${ENVIRONMENT_COLUMNS}`,
      parameters: [input.to, input.updatedAt, input.applicationId, input.environmentId, input.from],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return { claimed: true, record: toEnvironment(row) };
    }
    const existing = await this.findEnvironment(input.applicationId, input.environmentId);
    if (existing === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "environment status transition converged but the committed row is unreadable",
      });
    }
    return { claimed: false, record: existing };
  }

  // ---- sandbox executions ---------------------------------------------------

  async insertSandbox(input: InsertSandboxInput): Promise<ClaimOutcome<SandboxExecutionRecord>> {
    const inserted = await this.db.execute<SandboxRow>({
      sql: `INSERT INTO sandbox.sandbox_executions (id, application_id, tenant_id, execution_id, sandbox_key, request_fingerprint, environment_id, kind, status, runtime_metadata, denial_class, denial_code, denial_reason, budget_operation_id, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15)
ON CONFLICT (application_id, sandbox_key) DO NOTHING
RETURNING ${SANDBOX_COLUMNS}`,
      parameters: [
        input.id,
        input.applicationId,
        input.tenantId,
        input.executionId,
        input.sandboxKey,
        input.requestFingerprint,
        input.environmentId,
        input.kind,
        input.status,
        JSON.stringify(input.runtimeMetadata),
        input.denialClass,
        input.denialCode,
        input.denialReason,
        input.budgetOperationId,
        input.createdAt,
      ],
    });
    const row = first(inserted.rows);
    if (row !== undefined) {
      return { claimed: true, record: toSandbox(row) };
    }
    const existing = await this.findSandboxByKey(input.applicationId, input.sandboxKey);
    if (existing === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "sandbox insert converged but the committed row is unreadable",
      });
    }
    return { claimed: false, record: existing };
  }

  async findSandboxByKey(
    applicationId: string,
    sandboxKey: string,
  ): Promise<SandboxExecutionRecord | null> {
    const result = await this.db.execute<SandboxRow>({
      sql: `SELECT ${SANDBOX_COLUMNS} FROM sandbox.sandbox_executions WHERE application_id = $1 AND sandbox_key = $2`,
      parameters: [applicationId, sandboxKey],
    });
    const row = first(result.rows);
    return row === undefined ? null : toSandbox(row);
  }

  async findSandbox(
    applicationId: string,
    sandboxId: string,
  ): Promise<SandboxExecutionRecord | null> {
    const result = await this.db.execute<SandboxRow>({
      sql: `SELECT ${SANDBOX_COLUMNS} FROM sandbox.sandbox_executions WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, sandboxId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toSandbox(row);
  }

  async listSandboxesByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly SandboxExecutionRecord[]> {
    const result = await this.db.execute<SandboxRow>({
      sql: `SELECT ${SANDBOX_COLUMNS} FROM sandbox.sandbox_executions WHERE application_id = $1 AND execution_id = $2 ORDER BY created_at, id`,
      parameters: [applicationId, executionId],
    });
    return result.rows.map(toSandbox);
  }

  async claimDispatching(
    applicationId: string,
    sandboxKey: string,
  ): Promise<ClaimOutcome<SandboxExecutionRecord>> {
    const updated = await this.db.execute<SandboxRow>({
      sql: `UPDATE sandbox.sandbox_executions
SET status = 'dispatching', dispatched_at = now()
WHERE application_id = $1 AND sandbox_key = $2 AND status = 'admitted'
RETURNING ${SANDBOX_COLUMNS}`,
      parameters: [applicationId, sandboxKey],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return { claimed: true, record: toSandbox(row) };
    }
    const existing = await this.findSandboxByKey(applicationId, sandboxKey);
    if (existing === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "sandbox dispatch claim converged but the committed row is unreadable",
      });
    }
    return { claimed: false, record: existing };
  }

  async bindLedgerSequence(input: BindLedgerSequenceInput): Promise<SandboxExecutionRecord> {
    const column =
      input.phase === "admitted" ? "ledger_admitted_sequence" : "ledger_completed_sequence";
    const updated = await this.db.execute<SandboxRow>({
      sql: `UPDATE sandbox.sandbox_executions
SET ${column} = $1
WHERE application_id = $2 AND sandbox_key = $3 AND status IN ('admitted', 'dispatching') AND ${column} IS NULL
RETURNING ${SANDBOX_COLUMNS}`,
      parameters: [input.sequence, input.applicationId, input.sandboxKey],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return toSandbox(row);
    }
    const existing = await this.findSandboxByKey(input.applicationId, input.sandboxKey);
    if (existing === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "sandbox sequence binding converged but the committed row is unreadable",
      });
    }
    return existing;
  }

  async recordOutcome(input: RecordOutcomeInput): Promise<SandboxExecutionRecord> {
    const updated = await this.db.execute<SandboxRow>({
      sql: `UPDATE sandbox.sandbox_executions
SET status = $1, outcome_class = $2, failure_class = $3, failure_message = $4, retryable = $5,
    output_digest = $6, usage_micro_usd = $7, ledger_completed_sequence = COALESCE($8, ledger_completed_sequence),
    dispatched_at = $9, completed_at = $10, duration_ms = $11
WHERE application_id = $12 AND sandbox_key = $13 AND status = 'dispatching'
RETURNING ${SANDBOX_COLUMNS}`,
      parameters: [
        input.status,
        input.outcomeClass,
        input.failureClass,
        input.failureMessage,
        input.retryable,
        input.outputDigest,
        input.usageMicroUsd,
        input.completedLedgerSequence,
        input.dispatchedAt,
        input.completedAt,
        input.durationMs,
        input.applicationId,
        input.sandboxKey,
      ],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return toSandbox(row);
    }
    // A concurrent duplicate finalized first: converge on the committed
    // outcome (first writer wins).
    const existing = await this.findSandboxByKey(input.applicationId, input.sandboxKey);
    if (existing === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "sandbox outcome recording converged but the committed row is unreadable",
      });
    }
    return existing;
  }
}

/** Transactional view of the store (composition convenience). */
export function sqlSandboxStoreIn(tx: Transaction): SqlSandboxStore {
  const txPort: DatabasePort = {
    async execute<T>(query: { sql: string; parameters?: readonly unknown[] }) {
      return tx.execute<T>(query);
    },
    async transaction<T>(work: (inner: Transaction) => Promise<T>) {
      return work(tx);
    },
  };
  return new SqlSandboxStore(txPort);
}
