/**
 * SQL adapter for the executions module (WORK-006).
 *
 * Bridges `ExecutionStore` and the module `ExecutionsIdempotencyPort` to
 * the provider-neutral platform `DatabasePort`. No driver/SDK import
 * happens here — `pg` is owned by the platform DB layer (SDK boundary
 * table); this file only speaks the neutral port.
 *
 * The idempotency ledger reuses `platform.idempotency_records` (migration
 * 0001) with application-scoped arbitration keys — the same durable
 * arbitration contract as auth/applications/connections/budgets
 * (`spec/contracts.md` "Idempotency response rule").
 *
 * Single write path (the architecture-gated boundary):
 *   - the ONLY `UPDATE executions.executions` statement in the codebase is
 *     `updateExecutionForTransition` (called only by the transition
 *     service, always after `appendEvent` in the same transaction);
 *   - the ONLY `INSERT INTO executions.execution_events` statement is
 *     `appendEvent`;
 *   - migration 0004 makes the coupling physical: an UPDATE that does not
 *     advance `last_event_sequence` by exactly one WITH a matching
 *     envelope is rejected by trigger, terminal rows reject every UPDATE,
 *     and the ledger rejects UPDATE/DELETE outright.
 *
 * Concurrency: `lockExecution` takes the execution row `FOR UPDATE` and
 * returns the CURRENT committed row — legality + next sequence are always
 * re-derived under the lock (WORK-002 discipline), so per-execution
 * transition writers totally order and sequences stay gapless.
 */

import type { DatabasePort, Transaction } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type { AppendEventInput, EventEnvelope } from "../domain/event";
import type { ExecutionConstraints, ExecutionRecord } from "../domain/execution";
import type { ExecutionStatus } from "../domain/state-machine";
import type { VerificationResultRecord } from "../domain/verification";
import type {
  ExecutionsIdempotencyArbitration,
  ExecutionsIdempotencyPort,
  ExecutionsIdempotencyScope,
  ExecutionsTx,
} from "../ports/execution-idempotency";
import type {
  ApplicationTenantRow,
  ApplyTransitionInput,
  EnvironmentRow,
  ExecutionStore,
  InsertExecutionInput,
  InsertVerificationResultInput,
} from "../ports/execution-store";

type Executor = Pick<DatabasePort, "execute">;

function first<T>(rows: readonly T[]): T | undefined {
  return rows.length > 0 ? rows[0] : undefined;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

interface ExecutionRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly environment_id: string | null;
  readonly user_id: string;
  readonly status: ExecutionStatus;
  readonly task: Record<string, unknown>;
  readonly input_artifacts: string[];
  readonly execution_constraints: Record<string, unknown> | null;
  readonly user_metadata: Record<string, unknown>;
  readonly request_fingerprint: string;
  readonly last_event_sequence: number;
  readonly verification_refs: string[];
  readonly completed_at: Date | string | null;
  readonly failed_at: Date | string | null;
  readonly cancelled_at: Date | string | null;
  readonly expired_at: Date | string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const EXECUTION_COLUMNS = `id, application_id, tenant_id, environment_id, user_id, status, task,
input_artifacts, execution_constraints, user_metadata, request_fingerprint, last_event_sequence,
verification_refs, completed_at, failed_at, cancelled_at, expired_at, created_at, updated_at`;

function toExecution(row: ExecutionRow): ExecutionRecord {
  const terminalAt = row.completed_at ?? row.failed_at ?? row.cancelled_at ?? row.expired_at;
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    environmentId: row.environment_id,
    userId: row.user_id,
    status: row.status,
    task: row.task,
    inputArtifactRefs: row.input_artifacts ?? [],
    constraints: (row.execution_constraints as ExecutionConstraints | null) ?? null,
    metadata: row.user_metadata ?? {},
    requestFingerprint: row.request_fingerprint,
    lastEventSequence: Number(row.last_event_sequence),
    verificationRefs: row.verification_refs ?? [],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    terminalAt: terminalAt === null || terminalAt === undefined ? null : iso(terminalAt),
  };
}

interface EventRow {
  readonly id: string;
  readonly execution_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly sequence: number;
  readonly type: string;
  readonly command: string;
  readonly actor: Record<string, unknown>;
  readonly cause: string | null;
  readonly reference: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly occurred_at: Date | string;
  readonly producer_module: string;
  readonly schema_version: number;
}

const EVENT_COLUMNS = `id, execution_id, application_id, tenant_id, sequence, type, command, actor,
cause, reference, payload, occurred_at, producer_module, schema_version`;

function toEvent(row: EventRow): EventEnvelope {
  return {
    eventId: row.id,
    executionId: row.execution_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    sequence: Number(row.sequence),
    type: row.type,
    command: row.command,
    actor: row.actor,
    cause: row.cause,
    reference: row.reference ?? {},
    payload: row.payload ?? {},
    occurredAt: iso(row.occurred_at),
    producerModule: row.producer_module,
    schemaVersion: Number(row.schema_version),
  };
}

interface VerificationRow {
  readonly id: string;
  readonly execution_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly criterion_id: string;
  readonly strategy: string;
  readonly status: string;
  readonly evidence: string[];
  readonly recorded_by: string;
  readonly recorded_at: Date | string;
}

function toVerification(row: VerificationRow): VerificationResultRecord {
  return {
    id: row.id,
    executionId: row.execution_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    criterionId: row.criterion_id,
    strategy: row.strategy,
    status: row.status as VerificationResultRecord["status"],
    evidence: row.evidence ?? [],
    recordedBy: row.recorded_by,
    recordedAt: iso(row.recorded_at),
  };
}

export class SqlExecutionStore implements ExecutionStore {
  constructor(private readonly db: Executor) {}

  async findApplication(applicationId: string): Promise<ApplicationTenantRow | null> {
    const result = await this.db.execute<{ id: string; tenant_id: string }>({
      sql: "SELECT id, tenant_id FROM applications.applications WHERE id = $1",
      parameters: [applicationId],
    });
    const row = first(result.rows);
    return row === undefined ? null : { applicationId: row.id, tenantId: row.tenant_id };
  }

  async findEnvironment(environmentId: string): Promise<EnvironmentRow | null> {
    const result = await this.db.execute<{ id: string; application_id: string }>({
      sql: "SELECT id, application_id FROM applications.environments WHERE id = $1",
      parameters: [environmentId],
    });
    const row = first(result.rows);
    return row === undefined ? null : { id: row.id, applicationId: row.application_id };
  }

  async insertExecution(input: InsertExecutionInput): Promise<ExecutionRecord> {
    const inserted = await this.db.execute<ExecutionRow>({
      sql: `INSERT INTO executions.executions
  (id, application_id, tenant_id, environment_id, user_id, status, task,
   input_artifacts, execution_constraints, user_metadata, request_fingerprint,
   last_event_sequence, verification_refs, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, 'CREATED', $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10,
  1, '[]'::jsonb, $11, $11)
RETURNING ${EXECUTION_COLUMNS}`,
      parameters: [
        input.id,
        input.applicationId,
        input.tenantId,
        input.environmentId,
        input.userId,
        JSON.stringify(input.task),
        JSON.stringify(input.inputArtifactRefs),
        input.constraints === null ? "{}" : JSON.stringify(input.constraints),
        JSON.stringify(input.metadata),
        input.requestFingerprint,
        input.now,
      ],
    });
    const row = first(inserted.rows);
    if (row === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "execution insert returned no row",
      });
    }
    return toExecution(row);
  }

  async lockExecution(applicationId: string, executionId: string): Promise<ExecutionRecord | null> {
    const result = await this.db.execute<ExecutionRow>({
      sql: `SELECT ${EXECUTION_COLUMNS} FROM executions.executions
WHERE application_id = $1 AND id = $2 FOR UPDATE`,
      parameters: [applicationId, executionId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toExecution(row);
  }

  async updateExecutionForTransition(input: ApplyTransitionInput): Promise<ExecutionRecord> {
    // The ONLY execution-row status write in the codebase. The forward-only
    // trigger requires exactly-one-new-envelope + rejects terminal updates.
    const terminalColumn =
      input.nextStatus === "COMPLETED"
        ? "completed_at"
        : input.nextStatus === "FAILED"
          ? "failed_at"
          : input.nextStatus === "CANCELLED"
            ? "cancelled_at"
            : input.nextStatus === "EXPIRED"
              ? "expired_at"
              : null;
    const updated = await this.db.execute<ExecutionRow>({
      sql: terminalColumn
        ? `UPDATE executions.executions
SET status = $3, last_event_sequence = $4, verification_refs = $5::jsonb,
    ${terminalColumn} = $6, updated_at = $6
WHERE application_id = $1 AND id = $2
RETURNING ${EXECUTION_COLUMNS}`
        : `UPDATE executions.executions
SET status = $3, last_event_sequence = $4, verification_refs = $5::jsonb, updated_at = $6
WHERE application_id = $1 AND id = $2
RETURNING ${EXECUTION_COLUMNS}`,
      parameters: [
        input.applicationId,
        input.executionId,
        input.nextStatus,
        input.nextSequence,
        JSON.stringify(input.verificationRefs),
        input.now,
      ],
    });
    const row = first(updated.rows);
    if (row === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "execution transition update matched no row",
      });
    }
    return toExecution(row);
  }

  async getExecution(applicationId: string, executionId: string): Promise<ExecutionRecord | null> {
    const result = await this.db.execute<ExecutionRow>({
      sql: `SELECT ${EXECUTION_COLUMNS} FROM executions.executions
WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, executionId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toExecution(row);
  }

  async appendEvent(input: AppendEventInput): Promise<EventEnvelope> {
    const inserted = await this.db.execute<EventRow>({
      sql: `INSERT INTO executions.execution_events
  (id, execution_id, application_id, tenant_id, sequence, type, command, actor,
   cause, reference, payload, occurred_at, producer_module, schema_version)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12, 'executions', 1)
RETURNING ${EVENT_COLUMNS}`,
      parameters: [
        input.eventId,
        input.executionId,
        input.applicationId,
        input.tenantId,
        input.sequence,
        input.type,
        input.command,
        JSON.stringify({ actorId: input.actor.actorId, tenantId: input.actor.tenantId }),
        input.cause ?? null,
        JSON.stringify(input.reference ?? {}),
        JSON.stringify(input.payload),
        input.occurredAt,
      ],
    });
    const row = first(inserted.rows);
    if (row === undefined) {
      throw new PlatformError({ code: "PROVIDER_ERROR", message: "event insert returned no row" });
    }
    return toEvent(row);
  }

  async listEvents(applicationId: string, executionId: string): Promise<readonly EventEnvelope[]> {
    const result = await this.db.execute<EventRow>({
      sql: `SELECT ${EVENT_COLUMNS} FROM executions.execution_events
WHERE application_id = $1 AND execution_id = $2 ORDER BY sequence`,
      parameters: [applicationId, executionId],
    });
    return result.rows.map(toEvent);
  }

  async insertVerificationResult(
    input: InsertVerificationResultInput,
  ): Promise<VerificationResultRecord> {
    const inserted = await this.db.execute<VerificationRow>({
      sql: `INSERT INTO executions.verification_results
  (id, execution_id, application_id, tenant_id, criterion_id, strategy, status, evidence, recorded_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
RETURNING id, execution_id, application_id, tenant_id, criterion_id, strategy, status, evidence, recorded_by, recorded_at`,
      parameters: [
        input.id,
        input.executionId,
        input.applicationId,
        input.tenantId,
        input.criterionId,
        input.strategy,
        input.status,
        JSON.stringify(input.evidence),
        input.recordedBy,
      ],
    });
    const row = first(inserted.rows);
    if (row === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "verification result insert returned no row",
      });
    }
    return toVerification(row);
  }

  async listVerificationResults(
    applicationId: string,
    executionId: string,
  ): Promise<readonly VerificationResultRecord[]> {
    const result = await this.db.execute<VerificationRow>({
      sql: `SELECT id, execution_id, application_id, tenant_id, criterion_id, strategy, status,
evidence, recorded_by, recorded_at FROM executions.verification_results
WHERE application_id = $1 AND execution_id = $2 ORDER BY recorded_at, id`,
      parameters: [applicationId, executionId],
    });
    return result.rows.map(toVerification);
  }
}

interface IdempotencyLedgerRow {
  readonly durable_outcome: unknown;
  readonly request_fingerprint: string;
}

/**
 * Transaction-bound idempotency arbitration over
 * `platform.idempotency_records` — the exact durable contract of the
 * auth/applications/connections/budgets ledgers: the ledger row, the
 * guarded writes and the durable outcome commit in ONE transaction;
 * concurrent identical requests converge through the partial unique index
 * arbitration (the loser replays the winner's committed outcome).
 */
export class SqlExecutionsIdempotency implements ExecutionsIdempotencyPort {
  constructor(
    private readonly db: DatabasePort,
    private readonly storeFactory: (tx: Transaction) => ExecutionStore,
    private readonly generateId: () => string,
  ) {}

  async arbitrate<T>(
    scope: ExecutionsIdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (tx: ExecutionsTx) => Promise<T>,
  ): Promise<ExecutionsIdempotencyArbitration<T>> {
    return this.db.transaction(async (tx) => {
      const txStore = this.storeFactory(tx);

      const inserted = await tx.execute<{ id: string }>({
        sql: `INSERT INTO platform.idempotency_records
  (id, actor_id, application_id, operation_name, idempotency_key, request_fingerprint, durable_outcome)
VALUES ($1, $2, $3, $4, $5, $6, '"pending"'::jsonb)
ON CONFLICT (application_id, operation_name, idempotency_key) WHERE application_id IS NOT NULL
DO NOTHING
RETURNING id`,
        parameters: [
          this.generateId(),
          scope.actorId,
          scope.applicationId,
          operationName,
          idempotencyKey,
          requestFingerprint,
        ],
      });

      if (inserted.rows.length === 0) {
        // A previous request (committed, or committing concurrently — the
        // unique index arbitration makes this call wait for the winner)
        // already owns the key. Same fingerprint replays the durable
        // outcome; different fingerprint is key reuse.
        const existing = await tx.execute<IdempotencyLedgerRow>({
          sql: `SELECT durable_outcome, request_fingerprint FROM platform.idempotency_records
WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
          parameters: [scope.applicationId, operationName, idempotencyKey],
        });
        const row = first(existing.rows);
        if (row === undefined) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "idempotency key conflict disappeared during arbitration",
          });
        }
        if (row.request_fingerprint !== requestFingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "idempotency key was already used with a different request fingerprint",
            details: { operationName },
          });
        }
        return { outcome: row.durable_outcome as T, replayed: true };
      }

      const ledgerRow = first(inserted.rows);
      if (ledgerRow === undefined) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "ledger insert returned no row",
        });
      }
      const outcome = await work({ store: txStore });
      await tx.execute({
        sql: "UPDATE platform.idempotency_records SET durable_outcome = $1 WHERE id = $2",
        parameters: [JSON.stringify(outcome), ledgerRow.id],
      });
      return { outcome, replayed: false };
    });
  }
}

/** Composition wiring: SQL store + arbitration over one DatabasePort. */
export function createSqlExecutionsStoreFabric(db: DatabasePort, generateId: () => string) {
  return {
    store: new SqlExecutionStore(db),
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
  };
}
