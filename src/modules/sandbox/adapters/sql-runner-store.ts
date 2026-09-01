/**
 * SQL runner fleet store adapter (sandbox module; WORK-019, ENV-003).
 *
 * Implements the `RunnerStore` port over the provider-neutral `DatabasePort`
 * against migration `0015_runner_fleet.sql` — the WORK-012 SQL-store
 * discipline restated for the fleet axis:
 *
 *   - every insert converges through ON CONFLICT DO NOTHING arbitration
 *     (runners on (application_id, slug); assignments on
 *     (application_id, assignment_key) AND the runner's single-active-slot
 *     partial unique index — `ON CONFLICT DO NOTHING` without an arbiter
 *     covers every unique violation);
 *   - the assignment insert is GUARDED IN THE SAME STATEMENT by the
 *     runner's authorization + explicit health + heartbeat freshness
 *     (M20: a dead runner is physically unassignable, even under a race);
 *   - the only mutations are the GUARDED one-shot transitions (authorize,
 *     revoke, dispatch claim, result report, release, expiry) —
 *     first-writer-wins with re-read convergence;
 *   - the runner identity core (environment, version, capabilities, token
 *     fingerprint, provenance) has NO update path in this file — the
 *     migration's triggers make it physically write-once;
 *   - terminal assignment rows and revoked runners are physically
 *     immutable (triggers); this adapter never issues a statement that
 *     would violate them;
 *   - assignment events are INSERT-ONLY (append with a per-assignment
 *     sequence computed under the assignment row lock — no gaps, no
 *     duplicates);
 *   - every read is application-scoped.
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import { uuidv7 } from "../../../shared/ids";
import type {
  RunnerAssignmentProvenance,
  RunnerAssignmentRecord,
  RunnerAssignmentStatus,
  RunnerAuthorizationStatus,
  RunnerConnectionStatus,
  RunnerHealthStatus,
  RunnerProvenance,
  RunnerRecord,
} from "../domain/runner";
import {
  isRunnerAssignmentStatus,
  isRunnerAuthorizationStatus,
  isRunnerConnectionStatus,
  isRunnerHealthStatus,
} from "../domain/runner";
import type {
  AppendRunnerAssignmentEventInput,
  AuthorizeRunnerInput,
  ClaimOutcome,
  ClaimRunnerDispatchInput,
  ExpireRunnerAssignmentInput,
  InsertRunnerAssignmentInput,
  InsertRunnerInput,
  ObserveRunnerConnectionInput,
  ObserveRunnerHealthInput,
  RecordRunnerReconnectInput,
  RecordRunnerResultInput,
  ReleaseRunnerAssignmentInput,
  RevokeRunnerInput,
  RunnerAssignmentEventRecord,
  RunnerStore,
} from "../ports/runner-store";

interface RunnerRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly environment_id: string;
  readonly slug: string;
  readonly name: string;
  readonly runner_version: string;
  readonly declared_capabilities: unknown;
  readonly token_fingerprint: string;
  readonly provenance: unknown;
  readonly authorization_status: string;
  readonly authorized_at: Date | null;
  readonly authorized_by_actor_id: string | null;
  readonly revoked_at: Date | null;
  readonly revocation_reason: string | null;
  readonly health_status: string;
  readonly last_heartbeat_at: Date | null;
  readonly connection_status: string;
  readonly last_connected_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface AssignmentRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly sandbox_id: string;
  readonly environment_id: string;
  readonly runner_id: string;
  readonly assignment_key: string;
  readonly request_fingerprint: string;
  readonly status: string;
  readonly required_capabilities: unknown;
  readonly lease_leased_at: Date;
  readonly lease_expires_at: Date;
  readonly lease_duration_ms: number;
  readonly dispatched_at: Date | null;
  readonly handoff_nonce: string | null;
  readonly reported_at: Date | null;
  readonly outcome_class: string | null;
  readonly failure_class: string | null;
  readonly output_digest: string | null;
  readonly usage_micro_usd: string | null;
  readonly provenance: unknown;
  readonly reconnect_count: number;
  readonly released_reason: string | null;
  readonly released_at: Date | null;
  readonly expired_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface AssignmentEventRow {
  readonly id: string;
  readonly application_id: string;
  readonly assignment_id: string;
  readonly runner_id: string;
  readonly execution_id: string;
  readonly sequence: number;
  readonly event: string;
  readonly actor_id: string;
  readonly cause: string;
  readonly detail: unknown;
  readonly occurred_at: Date;
}

const RUNNER_COLUMNS =
  "id, application_id, tenant_id, environment_id, slug, name, runner_version, declared_capabilities, token_fingerprint, provenance, authorization_status, authorized_at, authorized_by_actor_id, revoked_at, revocation_reason, health_status, last_heartbeat_at, connection_status, last_connected_at, created_at, updated_at";
const ASSIGNMENT_COLUMNS =
  "id, application_id, tenant_id, execution_id, sandbox_id, environment_id, runner_id, assignment_key, request_fingerprint, status, required_capabilities, lease_leased_at, lease_expires_at, lease_duration_ms, dispatched_at, handoff_nonce, reported_at, outcome_class, failure_class, output_digest, usage_micro_usd, provenance, reconnect_count, released_reason, released_at, expired_at, created_at, updated_at";
const EVENT_COLUMNS =
  "id, application_id, assignment_id, runner_id, execution_id, sequence, event, actor_id, cause, detail, occurred_at";

function first<T>(rows: readonly T[]): T | undefined {
  return rows[0];
}

function isoOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : isoOf(value);
}

function toRunner(row: RunnerRow): RunnerRecord {
  if (!isRunnerAuthorizationStatus(row.authorization_status)) {
    throw new PlatformError({
      code: "SANDBOX_ERROR",
      message: `stored runner ${row.id} carries an unknown authorization status "${row.authorization_status}"`,
    });
  }
  if (!isRunnerHealthStatus(row.health_status)) {
    throw new PlatformError({
      code: "SANDBOX_ERROR",
      message: `stored runner ${row.id} carries an unknown health status "${row.health_status}"`,
    });
  }
  if (!isRunnerConnectionStatus(row.connection_status)) {
    throw new PlatformError({
      code: "SANDBOX_ERROR",
      message: `stored runner ${row.id} carries an unknown connection status "${row.connection_status}"`,
    });
  }
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    environmentId: row.environment_id,
    slug: row.slug,
    name: row.name,
    runnerVersion: row.runner_version,
    declaredCapabilities: (row.declared_capabilities as string[]) ?? [],
    tokenFingerprint: row.token_fingerprint,
    provenance: row.provenance as RunnerProvenance,
    authorizationStatus: row.authorization_status as RunnerAuthorizationStatus,
    authorizedAt: isoOrNull(row.authorized_at),
    authorizedByActorId: row.authorized_by_actor_id,
    revokedAt: isoOrNull(row.revoked_at),
    revocationReason: row.revocation_reason,
    healthStatus: row.health_status as RunnerHealthStatus,
    lastHeartbeatAt: isoOrNull(row.last_heartbeat_at),
    connectionStatus: row.connection_status as RunnerConnectionStatus,
    lastConnectedAt: isoOrNull(row.last_connected_at),
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at),
  };
}

function toAssignment(row: AssignmentRow): RunnerAssignmentRecord {
  if (!isRunnerAssignmentStatus(row.status)) {
    throw new PlatformError({
      code: "SANDBOX_ERROR",
      message: `stored assignment ${row.id} carries an unknown status "${row.status}"`,
    });
  }
  const outcomeClass =
    row.outcome_class === "sandbox-success" || row.outcome_class === "sandbox-failure"
      ? row.outcome_class
      : null;
  const failureClass =
    row.failure_class === null
      ? null
      : (
            ["sandbox-execution", "timeout", "adapter-error", "runtime-unavailable"] as const
          ).includes(row.failure_class as never)
        ? (row.failure_class as RunnerAssignmentRecord["failureClass"])
        : null;
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    sandboxId: row.sandbox_id,
    environmentId: row.environment_id,
    runnerId: row.runner_id,
    assignmentKey: row.assignment_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status as RunnerAssignmentStatus,
    requiredCapabilities: (row.required_capabilities as string[]) ?? [],
    lease: {
      leasedAt: isoOf(row.lease_leased_at),
      leaseExpiresAt: isoOf(row.lease_expires_at),
      leaseDurationMs: row.lease_duration_ms,
    },
    dispatchedAt: isoOrNull(row.dispatched_at),
    handoffNonce: row.handoff_nonce,
    reportedAt: isoOrNull(row.reported_at),
    outcomeClass,
    failureClass,
    outputDigest: row.output_digest,
    usageMicroUsd: row.usage_micro_usd,
    provenance: row.provenance as RunnerAssignmentProvenance,
    reconnectCount: row.reconnect_count,
    releasedReason: row.released_reason,
    releasedAt: isoOrNull(row.released_at),
    expiredAt: isoOrNull(row.expired_at),
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at),
  };
}

function toEvent(row: AssignmentEventRow): RunnerAssignmentEventRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    assignmentId: row.assignment_id,
    runnerId: row.runner_id,
    executionId: row.execution_id,
    sequence: row.sequence,
    event: row.event as RunnerAssignmentEventRecord["event"],
    actorId: row.actor_id,
    cause: row.cause,
    detail: (row.detail as Record<string, unknown>) ?? {},
    occurredAt: isoOf(row.occurred_at),
  };
}

export class SqlRunnerStore implements RunnerStore {
  constructor(private readonly db: DatabasePort) {}

  // ---- runner identity -----------------------------------------------------

  async insertRunner(input: InsertRunnerInput): Promise<ClaimOutcome<RunnerRecord>> {
    const inserted = await this.db.execute<RunnerRow>({
      sql: `INSERT INTO sandbox.runners (id, application_id, tenant_id, environment_id, slug, name, runner_version, declared_capabilities, token_fingerprint, provenance, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $11)
ON CONFLICT (application_id, slug) DO NOTHING
RETURNING ${RUNNER_COLUMNS}`,
      parameters: [
        input.id,
        input.applicationId,
        input.tenantId,
        input.environmentId,
        input.slug,
        input.name,
        input.runnerVersion,
        JSON.stringify(input.declaredCapabilities),
        input.tokenFingerprint,
        JSON.stringify(input.provenance),
        input.createdAt,
      ],
    });
    const row = first(inserted.rows);
    if (row !== undefined) {
      return { claimed: true, record: toRunner(row) };
    }
    const existing = await this.findRunnerBySlug(input.applicationId, input.slug);
    if (existing === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "runner insert converged but the committed row is unreadable",
      });
    }
    return { claimed: false, record: existing };
  }

  async findRunner(applicationId: string, runnerId: string): Promise<RunnerRecord | null> {
    const result = await this.db.execute<RunnerRow>({
      sql: `SELECT ${RUNNER_COLUMNS} FROM sandbox.runners WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, runnerId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toRunner(row);
  }

  async findRunnerBySlug(applicationId: string, slug: string): Promise<RunnerRecord | null> {
    const result = await this.db.execute<RunnerRow>({
      sql: `SELECT ${RUNNER_COLUMNS} FROM sandbox.runners WHERE application_id = $1 AND slug = $2`,
      parameters: [applicationId, slug],
    });
    const row = first(result.rows);
    return row === undefined ? null : toRunner(row);
  }

  async listRunners(applicationId: string): Promise<readonly RunnerRecord[]> {
    const result = await this.db.execute<RunnerRow>({
      sql: `SELECT ${RUNNER_COLUMNS} FROM sandbox.runners WHERE application_id = $1 ORDER BY created_at, id`,
      parameters: [applicationId],
    });
    return result.rows.map(toRunner);
  }

  async authorizeRunner(input: AuthorizeRunnerInput): Promise<ClaimOutcome<RunnerRecord>> {
    const updated = await this.db.execute<RunnerRow>({
      sql: `UPDATE sandbox.runners
SET authorization_status = 'authorized', authorized_at = $1, authorized_by_actor_id = $2, updated_at = $1
WHERE application_id = $3 AND id = $4 AND authorization_status = 'untrusted'
RETURNING ${RUNNER_COLUMNS}`,
      parameters: [input.authorizedAt, input.actorId, input.applicationId, input.runnerId],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return { claimed: true, record: toRunner(row) };
    }
    return {
      claimed: false,
      record: await this.mustReadRunner(input.applicationId, input.runnerId),
    };
  }

  async revokeRunner(input: RevokeRunnerInput): Promise<ClaimOutcome<RunnerRecord>> {
    const updated = await this.db.execute<RunnerRow>({
      sql: `UPDATE sandbox.runners
SET authorization_status = 'revoked', authorized_at = NULL, authorized_by_actor_id = NULL, revoked_at = $1, revocation_reason = $2, updated_at = $1
WHERE application_id = $3 AND id = $4 AND authorization_status IN ('untrusted', 'authorized')
RETURNING ${RUNNER_COLUMNS}`,
      parameters: [input.revokedAt, input.reason, input.applicationId, input.runnerId],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return { claimed: true, record: toRunner(row) };
    }
    return {
      claimed: false,
      record: await this.mustReadRunner(input.applicationId, input.runnerId),
    };
  }

  async observeRunnerHealth(input: ObserveRunnerHealthInput): Promise<RunnerRecord> {
    const updated = await this.db.execute<RunnerRow>({
      sql: `UPDATE sandbox.runners
SET health_status = $1, last_heartbeat_at = $2, updated_at = $2
WHERE application_id = $3 AND id = $4 AND authorization_status <> 'revoked'
RETURNING ${RUNNER_COLUMNS}`,
      parameters: [input.health, input.heartbeatAt, input.applicationId, input.runnerId],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return toRunner(row);
    }
    // A revoked runner is inert: the observation no-ops and the committed
    // row replays (revoked rows are physically immutable).
    return this.mustReadRunner(input.applicationId, input.runnerId);
  }

  async observeRunnerConnection(input: ObserveRunnerConnectionInput): Promise<RunnerRecord> {
    const updated = await this.db.execute<RunnerRow>({
      sql: `UPDATE sandbox.runners
SET connection_status = $1, last_connected_at = CASE WHEN $1 = 'connected' THEN $2 ELSE last_connected_at END, updated_at = $2
WHERE application_id = $3 AND id = $4 AND authorization_status <> 'revoked'
RETURNING ${RUNNER_COLUMNS}`,
      parameters: [input.connection, input.observedAt, input.applicationId, input.runnerId],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return toRunner(row);
    }
    return this.mustReadRunner(input.applicationId, input.runnerId);
  }

  private async mustReadRunner(applicationId: string, runnerId: string): Promise<RunnerRecord> {
    const existing = await this.findRunner(applicationId, runnerId);
    if (existing === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "runner transition converged but the committed row is unreadable",
      });
    }
    return existing;
  }

  private async mustReadAssignment(
    applicationId: string,
    assignmentId: string,
  ): Promise<RunnerAssignmentRecord> {
    const existing = await this.findRunnerAssignment(applicationId, assignmentId);
    if (existing === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "assignment transition converged but the committed row is unreadable",
      });
    }
    return existing;
  }

  // ---- assignment journal ---------------------------------------------------

  async insertRunnerAssignment(
    input: InsertRunnerAssignmentInput,
  ): Promise<ClaimOutcome<RunnerAssignmentRecord | null>> {
    // The guarded insert: the runner must be authorized, explicitly healthy
    // and heartbeat-fresh IN THE SAME STATEMENT (M20 — the health race is
    // decided by the database, not by a pre-read).
    const inserted = await this.db.execute<AssignmentRow>({
      sql: `INSERT INTO sandbox.runner_assignments (id, application_id, tenant_id, execution_id, sandbox_id, environment_id, runner_id, assignment_key, request_fingerprint, status, required_capabilities, lease_leased_at, lease_expires_at, lease_duration_ms, provenance, created_at, updated_at)
SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, 'assigned', $10::jsonb, $11, $12, $13, $14::jsonb, $15, $15
FROM sandbox.runners r
WHERE r.application_id = $2 AND r.id = $7
  AND r.tenant_id = $3
  AND r.authorization_status = 'authorized'
  AND r.health_status = 'healthy'
  AND r.last_heartbeat_at >= $16
ON CONFLICT DO NOTHING
RETURNING ${ASSIGNMENT_COLUMNS}`,
      parameters: [
        input.id,
        input.applicationId,
        input.tenantId,
        input.executionId,
        input.sandboxId,
        input.environmentId,
        input.runnerId,
        input.assignmentKey,
        input.requestFingerprint,
        JSON.stringify(input.requiredCapabilities),
        input.lease.leasedAt,
        input.lease.leaseExpiresAt,
        input.lease.leaseDurationMs,
        JSON.stringify(input.provenance),
        input.createdAt,
        input.heartbeatCutoff,
      ],
    });
    const row = first(inserted.rows);
    if (row !== undefined) {
      return { claimed: true, record: toAssignment(row) };
    }
    const existing = await this.findRunnerAssignmentByKey(input.applicationId, input.assignmentKey);
    if (existing !== null) {
      return { claimed: false, record: existing };
    }
    // The runner guards (health/trust) or the single-active-slot partial
    // index refused the insert: NULL — the caller re-reads and produces
    // the typed rejection from the CURRENT committed state.
    return { claimed: false, record: null };
  }

  async findRunnerAssignment(
    applicationId: string,
    assignmentId: string,
  ): Promise<RunnerAssignmentRecord | null> {
    const result = await this.db.execute<AssignmentRow>({
      sql: `SELECT ${ASSIGNMENT_COLUMNS} FROM sandbox.runner_assignments WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, assignmentId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toAssignment(row);
  }

  async findRunnerAssignmentByKey(
    applicationId: string,
    assignmentKey: string,
  ): Promise<RunnerAssignmentRecord | null> {
    const result = await this.db.execute<AssignmentRow>({
      sql: `SELECT ${ASSIGNMENT_COLUMNS} FROM sandbox.runner_assignments WHERE application_id = $1 AND assignment_key = $2`,
      parameters: [applicationId, assignmentKey],
    });
    const row = first(result.rows);
    return row === undefined ? null : toAssignment(row);
  }

  async findActiveAssignmentByRunner(
    applicationId: string,
    runnerId: string,
  ): Promise<RunnerAssignmentRecord | null> {
    const result = await this.db.execute<AssignmentRow>({
      sql: `SELECT ${ASSIGNMENT_COLUMNS} FROM sandbox.runner_assignments WHERE application_id = $1 AND runner_id = $2 AND status IN ('assigned', 'dispatched') ORDER BY created_at, id`,
      parameters: [applicationId, runnerId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toAssignment(row);
  }

  async listRunnerAssignmentsBySandbox(
    applicationId: string,
    sandboxId: string,
  ): Promise<readonly RunnerAssignmentRecord[]> {
    const result = await this.db.execute<AssignmentRow>({
      sql: `SELECT ${ASSIGNMENT_COLUMNS} FROM sandbox.runner_assignments WHERE application_id = $1 AND sandbox_id = $2 ORDER BY created_at, id`,
      parameters: [applicationId, sandboxId],
    });
    return result.rows.map(toAssignment);
  }

  async listRunnerAssignmentsByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly RunnerAssignmentRecord[]> {
    const result = await this.db.execute<AssignmentRow>({
      sql: `SELECT ${ASSIGNMENT_COLUMNS} FROM sandbox.runner_assignments WHERE application_id = $1 AND execution_id = $2 ORDER BY created_at, id`,
      parameters: [applicationId, executionId],
    });
    return result.rows.map(toAssignment);
  }

  async claimRunnerDispatch(
    input: ClaimRunnerDispatchInput,
  ): Promise<ClaimOutcome<RunnerAssignmentRecord>> {
    const updated = await this.db.execute<AssignmentRow>({
      sql: `UPDATE sandbox.runner_assignments
SET status = 'dispatched', dispatched_at = $1, handoff_nonce = $2, updated_at = $1
WHERE application_id = $3 AND id = $4 AND status = 'assigned'
RETURNING ${ASSIGNMENT_COLUMNS}`,
      parameters: [input.dispatchedAt, input.handoffNonce, input.applicationId, input.assignmentId],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return { claimed: true, record: toAssignment(row) };
    }
    const existing = await this.findRunnerAssignment(input.applicationId, input.assignmentId);
    if (existing === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "assignment dispatch claim converged but the committed row is unreadable",
      });
    }
    return { claimed: false, record: existing };
  }

  async recordRunnerResult(
    input: RecordRunnerResultInput,
  ): Promise<ClaimOutcome<RunnerAssignmentRecord>> {
    const failureClass = input.report.failure === null ? null : input.report.failure.failureClass;
    const updated = await this.db.execute<AssignmentRow>({
      sql: `UPDATE sandbox.runner_assignments
SET status = $1, outcome_class = $2, failure_class = $3, output_digest = $4, usage_micro_usd = $5, reported_at = $6, updated_at = $6
WHERE application_id = $7 AND id = $8 AND status = 'dispatched'
RETURNING ${ASSIGNMENT_COLUMNS}`,
      parameters: [
        input.status,
        input.report.outcomeClass,
        failureClass,
        input.report.outputDigest,
        input.report.usageMicroUsd,
        input.reportedAt,
        input.applicationId,
        input.assignmentId,
      ],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return { claimed: true, record: toAssignment(row) };
    }
    // A concurrent duplicate finalized first: converge on the committed
    // outcome (first writer wins).
    return {
      claimed: false,
      record: await this.mustReadAssignment(input.applicationId, input.assignmentId),
    };
  }

  async releaseRunnerAssignment(
    input: ReleaseRunnerAssignmentInput,
  ): Promise<ClaimOutcome<RunnerAssignmentRecord>> {
    const updated = await this.db.execute<AssignmentRow>({
      sql: `UPDATE sandbox.runner_assignments
SET status = 'released', released_reason = $1, released_at = $2, updated_at = $2
WHERE application_id = $3 AND id = $4 AND status = $5
RETURNING ${ASSIGNMENT_COLUMNS}`,
      parameters: [
        input.reason,
        input.releasedAt,
        input.applicationId,
        input.assignmentId,
        input.from,
      ],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return { claimed: true, record: toAssignment(row) };
    }
    return {
      claimed: false,
      record: await this.mustReadAssignment(input.applicationId, input.assignmentId),
    };
  }

  async expireRunnerAssignment(
    input: ExpireRunnerAssignmentInput,
  ): Promise<ClaimOutcome<RunnerAssignmentRecord>> {
    const updated = await this.db.execute<AssignmentRow>({
      sql: `UPDATE sandbox.runner_assignments
SET status = 'expired', expired_at = $1, updated_at = $1
WHERE application_id = $2 AND id = $3 AND status IN ('assigned', 'dispatched') AND lease_expires_at < $1
RETURNING ${ASSIGNMENT_COLUMNS}`,
      parameters: [input.expiredAt, input.applicationId, input.assignmentId],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return { claimed: true, record: toAssignment(row) };
    }
    return {
      claimed: false,
      record: await this.mustReadAssignment(input.applicationId, input.assignmentId),
    };
  }

  async recordRunnerReconnect(
    input: RecordRunnerReconnectInput,
  ): Promise<ClaimOutcome<RunnerAssignmentRecord>> {
    const updated = await this.db.execute<AssignmentRow>({
      sql: `UPDATE sandbox.runner_assignments
SET reconnect_count = reconnect_count + 1, updated_at = $1
WHERE application_id = $2 AND id = $3 AND status = 'dispatched'
RETURNING ${ASSIGNMENT_COLUMNS}`,
      parameters: [input.reconnectedAt, input.applicationId, input.assignmentId],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return { claimed: true, record: toAssignment(row) };
    }
    return {
      claimed: false,
      record: await this.mustReadAssignment(input.applicationId, input.assignmentId),
    };
  }

  // ---- append-only evidence ---------------------------------------------------

  async appendRunnerAssignmentEvent(input: AppendRunnerAssignmentEventInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Serialize concurrent appends on the assignment row: the sequence is
      // computed under the row lock (gapless, duplicate-free).
      await tx.execute({
        sql: "SELECT id FROM sandbox.runner_assignments WHERE application_id = $1 AND id = $2 FOR UPDATE",
        parameters: [input.applicationId, input.assignmentId],
      });
      await tx.execute({
        sql: `INSERT INTO sandbox.runner_assignment_events (id, application_id, assignment_id, runner_id, execution_id, sequence, event, actor_id, cause, detail, occurred_at)
VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM sandbox.runner_assignment_events WHERE application_id = $2 AND assignment_id = $3), $6, $7, $8, $9::jsonb, $10)`,
        parameters: [
          uuidv7(),
          input.applicationId,
          input.assignmentId,
          input.runnerId,
          input.executionId,
          input.event,
          input.actorId,
          input.cause,
          JSON.stringify(input.detail),
          input.occurredAt,
        ],
      });
    });
  }

  async listRunnerAssignmentEvents(
    applicationId: string,
    assignmentId: string,
  ): Promise<readonly RunnerAssignmentEventRecord[]> {
    const result = await this.db.execute<AssignmentEventRow>({
      sql: `SELECT ${EVENT_COLUMNS} FROM sandbox.runner_assignment_events WHERE application_id = $1 AND assignment_id = $2 ORDER BY sequence`,
      parameters: [applicationId, assignmentId],
    });
    return result.rows.map(toEvent);
  }
}
