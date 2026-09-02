/**
 * SQL training store (sandbox module; WORK-030).
 *
 * The durable implementation of the `TrainingStore` port over migration
 * 0025 (`sandbox.training_*`) — the SQL twin of the in-memory store:
 * unique-key convergence through ON CONFLICT arbitration, guarded
 * transitions (the migration's physical trigger guards are the
 * authority; typed errors surface here), the write-once bindings, the
 * append-only content/lineage-addressable checkpoint ledger and the
 * monotonic-epoch run lease.
 *
 * The migration's physical guards (append-only, gapless sequences,
 * terminal immutability, runtime-metadata immutability) fire as typed
 * errors here; the store NEVER writes other modules' tables.
 */

import type { DatabasePort, QueryResult } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type {
  TrainingCheckpointContents,
  TrainingCheckpointRecord,
  TrainingOperationRecord,
  TrainingRunLeaseRecord,
  TrainingWorkloadRecord,
  TrainingWorkloadStatus,
} from "../domain/workload";
import { canTransitionTrainingWorkload } from "../domain/workload";
import type {
  AcquireTrainingRunLeaseInput,
  BindWorkloadAllocationInput,
  BindWorkloadLedgerSequenceInput,
  BindWorkloadOutputInput,
  BindWorkloadReleaseInput,
  BindWorkloadResumePointInput,
  BumpWorkloadAttemptsInput,
  CompleteTrainingOperationInput,
  InsertTrainingCheckpointInput,
  InsertTrainingOperationInput,
  InsertTrainingWorkloadInput,
  ReleaseTrainingRunLeaseInput,
  TrainingClaimOutcome,
  TrainingStore,
  TransitionTrainingWorkloadInput,
} from "../ports/training-store";

interface WorkloadRow {
  id: string;
  application_id: string;
  tenant_id: string;
  execution_id: string;
  workload_key: string;
  request_fingerprint: string;
  workload_kind: string;
  status: string;
  runtime_metadata: Record<string, unknown>;
  denial_class: string | null;
  denial_code: string | null;
  denial_reason: string | null;
  attempts: number;
  failure_class: string | null;
  failure_message: string | null;
  output_artifact_digest: string | null;
  output_descriptor: Record<string, unknown> | null;
  usage_micro_usd: string | null;
  budget_operation_id: string | null;
  allocation_id: string | null;
  substrate_id: string | null;
  adapter_ref: string | null;
  last_checkpoint_identity: string | null;
  verified_release_at: Date | null;
  verification_evaluation_id: string | null;
  ledger_admitted_sequence: number | null;
  ledger_completed_sequence: number | null;
  created_at: Date;
  allocated_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
}

interface CheckpointRow {
  id: string;
  application_id: string;
  tenant_id: string;
  execution_id: string;
  workload_id: string;
  workload_key: string;
  checkpoint_sequence: number;
  step_position: number;
  lineage: Record<string, unknown>;
  metrics_digest: string;
  substrate_id: string;
  resource_class: string;
  recorded_by: string;
  content_digest: string;
  created_at: Date;
}

interface OperationRow {
  id: string;
  application_id: string;
  tenant_id: string;
  execution_id: string;
  workload_id: string | null;
  operation_kind: string;
  operation_key: string;
  request_fingerprint: string;
  status: string;
  attempts: number;
  stage: Record<string, unknown> | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

interface LeaseRow {
  workload_id: string;
  application_id: string;
  tenant_id: string;
  execution_id: string;
  owner_id: string;
  epoch: number;
  acquired_at: Date;
  expires_at: Date;
  last_heartbeat_at: Date;
  heartbeat_count: number;
  released_at: Date | null;
  release_cause: string | null;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function first<T>(rows: readonly T[]): T | undefined {
  return rows[0];
}

function toWorkload(row: WorkloadRow): TrainingWorkloadRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    workloadKey: row.workload_key,
    requestFingerprint: row.request_fingerprint,
    workloadKind: row.workload_kind as TrainingWorkloadRecord["workloadKind"],
    status: row.status as TrainingWorkloadStatus,
    runtimeMetadata: row.runtime_metadata as unknown as TrainingWorkloadRecord["runtimeMetadata"],
    denialClass: row.denial_class as TrainingWorkloadRecord["denialClass"],
    denialCode: row.denial_code as TrainingWorkloadRecord["denialCode"],
    denialReason: row.denial_reason,
    attempts: row.attempts,
    failureClass: row.failure_class as TrainingWorkloadRecord["failureClass"],
    failureMessage: row.failure_message,
    outputArtifactDigest: row.output_artifact_digest,
    outputDescriptor: row.output_descriptor,
    usageMicroUsd: row.usage_micro_usd,
    budgetOperationId: row.budget_operation_id,
    allocationId: row.allocation_id,
    substrateId: row.substrate_id,
    adapterRef: row.adapter_ref,
    lastCheckpointIdentity: row.last_checkpoint_identity,
    verifiedReleaseAt: iso(row.verified_release_at),
    verificationEvaluationId: row.verification_evaluation_id,
    ledgerAdmittedSequence: row.ledger_admitted_sequence,
    ledgerCompletedSequence: row.ledger_completed_sequence,
    createdAt: row.created_at.toISOString(),
    allocatedAt: iso(row.allocated_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    cancelledAt: iso(row.cancelled_at),
  };
}

function toCheckpoint(row: CheckpointRow): TrainingCheckpointRecord {
  const lineage = row.lineage as unknown as TrainingCheckpointContents["lineage"];
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    workloadId: row.workload_id,
    workloadKey: row.workload_key,
    checkpointSequence: row.checkpoint_sequence,
    contents: {
      executionId: row.execution_id,
      workloadId: row.workload_id,
      workloadKey: row.workload_key,
      checkpointSequence: row.checkpoint_sequence,
      stepPosition: row.step_position,
      lineage,
      metricsDigest: row.metrics_digest,
      substrateId: row.substrate_id,
      resourceClass: row.resource_class,
      recordedBy: row.recorded_by,
    },
    contentDigest: row.content_digest,
    createdAt: row.created_at.toISOString(),
  };
}

function toOperation(row: OperationRow): TrainingOperationRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    workloadId: row.workload_id,
    operationKind: row.operation_kind as TrainingOperationRecord["operationKind"],
    operationKey: row.operation_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status as TrainingOperationRecord["status"],
    attempts: row.attempts,
    stage: row.stage,
    failureReason: row.failure_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: iso(row.completed_at),
  };
}

function toLease(row: LeaseRow): TrainingRunLeaseRecord {
  return {
    workloadId: row.workload_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    ownerId: row.owner_id,
    epoch: row.epoch,
    acquiredAt: row.acquired_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    lastHeartbeatAt: row.last_heartbeat_at.toISOString(),
    heartbeatCount: row.heartbeat_count,
    releasedAt: iso(row.released_at),
    releaseCause: row.release_cause,
  };
}

/** Surface the migration's physical guard errors as typed PlatformErrors. */
function toTypedGuardError(error: unknown): never {
  if (error instanceof PlatformError) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    /identity core|terminal-immutable|append-only|never deleted|write-once|cannot move from status|is released|lease epoch|lease owner|lease expiry|must be gapless|release precedes acquisition|attempt ledger/.test(
      message,
    )
  ) {
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `the training durable-state guard rejected the write: ${message}`,
      details: { guard: message },
    });
  }
  throw error;
}

const WORKLOAD_COLUMNS = `id, application_id, tenant_id, execution_id, workload_key, request_fingerprint,
  workload_kind, status, runtime_metadata, denial_class, denial_code, denial_reason, attempts,
  failure_class, failure_message, output_artifact_digest, output_descriptor, usage_micro_usd,
  budget_operation_id, allocation_id, substrate_id, adapter_ref, last_checkpoint_identity,
  verified_release_at, verification_evaluation_id, ledger_admitted_sequence, ledger_completed_sequence,
  created_at, allocated_at, started_at, completed_at, cancelled_at`;

const CHECKPOINT_COLUMNS = `id, application_id, tenant_id, execution_id, workload_id, workload_key,
  checkpoint_sequence, step_position, lineage, metrics_digest, substrate_id, resource_class,
  recorded_by, content_digest, created_at`;

const OPERATION_COLUMNS = `id, application_id, tenant_id, execution_id, workload_id, operation_kind,
  operation_key, request_fingerprint, status, attempts, stage, failure_reason, created_at,
  updated_at, completed_at`;

const LEASE_COLUMNS = `workload_id, application_id, tenant_id, execution_id, owner_id, epoch,
  acquired_at, expires_at, last_heartbeat_at, heartbeat_count, released_at, release_cause`;

export class SqlTrainingStore implements TrainingStore {
  constructor(private readonly db: DatabasePort) {}

  // ---- workload journal ----------------------------------------------------

  async insertWorkload(
    input: InsertTrainingWorkloadInput,
  ): Promise<TrainingClaimOutcome<TrainingWorkloadRecord>> {
    let result: QueryResult<WorkloadRow>;
    try {
      result = await this.db.execute<WorkloadRow>({
        sql: `INSERT INTO sandbox.training_workloads
  (id, application_id, tenant_id, execution_id, workload_key, request_fingerprint, workload_kind,
   status, runtime_metadata, denial_class, denial_code, denial_reason, attempts,
   failure_class, failure_message, output_artifact_digest, output_descriptor, usage_micro_usd,
   budget_operation_id, allocation_id, substrate_id, adapter_ref, last_checkpoint_identity,
   verified_release_at, verification_evaluation_id, ledger_admitted_sequence,
   ledger_completed_sequence, created_at, allocated_at, started_at, completed_at, cancelled_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, 1, NULL, NULL, NULL, NULL, NULL,
  $13, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, $14, NULL, NULL, NULL, NULL)
ON CONFLICT (application_id, workload_key) DO NOTHING
RETURNING ${WORKLOAD_COLUMNS}`,
        parameters: [
          input.id,
          input.applicationId,
          input.tenantId,
          input.executionId,
          input.workloadKey,
          input.requestFingerprint,
          input.workloadKind,
          input.status,
          JSON.stringify(input.runtimeMetadata),
          input.denialClass,
          input.denialCode,
          input.denialReason,
          input.budgetOperationId,
          input.createdAt,
        ],
      });
    } catch (error) {
      toTypedGuardError(error);
    }
    const row = first(result.rows);
    if (row !== undefined) {
      return { claimed: true, record: toWorkload(row) };
    }
    const existing = await this.findWorkloadByKey(input.applicationId, input.workloadKey);
    if (existing === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "training workload insert returned no row",
        details: { workloadKey: input.workloadKey },
      });
    }
    return { claimed: false, record: existing };
  }

  async findWorkloadByKey(
    applicationId: string,
    workloadKey: string,
  ): Promise<TrainingWorkloadRecord | null> {
    const result = await this.db.execute<WorkloadRow>({
      sql: `SELECT ${WORKLOAD_COLUMNS} FROM sandbox.training_workloads
WHERE application_id = $1 AND workload_key = $2`,
      parameters: [applicationId, workloadKey],
    });
    const row = first(result.rows);
    return row === undefined ? null : toWorkload(row);
  }

  async findWorkload(
    applicationId: string,
    workloadId: string,
  ): Promise<TrainingWorkloadRecord | null> {
    const result = await this.db.execute<WorkloadRow>({
      sql: `SELECT ${WORKLOAD_COLUMNS} FROM sandbox.training_workloads
WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, workloadId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toWorkload(row);
  }

  async listWorkloadsByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly TrainingWorkloadRecord[]> {
    const result = await this.db.execute<WorkloadRow>({
      sql: `SELECT ${WORKLOAD_COLUMNS} FROM sandbox.training_workloads
WHERE application_id = $1 AND execution_id = $2 ORDER BY created_at, id`,
      parameters: [applicationId, executionId],
    });
    return result.rows.map(toWorkload);
  }

  async transitionWorkload(
    input: TransitionTrainingWorkloadInput,
  ): Promise<TrainingClaimOutcome<TrainingWorkloadRecord>> {
    const current = await this.findWorkloadByKey(input.applicationId, input.workloadKey);
    if (current === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "training workload transition requires an existing workload row",
        details: { workloadKey: input.workloadKey },
      });
    }
    if (!canTransitionTrainingWorkload(current.status, input.to)) {
      return { claimed: false, record: current };
    }
    let result: QueryResult<WorkloadRow>;
    try {
      result = await this.db.execute<WorkloadRow>({
        sql: `UPDATE sandbox.training_workloads SET status = $3,
  failure_class = CASE WHEN $3 = 'allocating' THEN NULL ELSE COALESCE($4, failure_class) END,
  failure_message = CASE WHEN $3 = 'allocating' THEN NULL ELSE $5 END,
  output_artifact_digest = COALESCE($6, output_artifact_digest), output_descriptor = $7::jsonb,
  usage_micro_usd = COALESCE($8, usage_micro_usd), ledger_completed_sequence = COALESCE($9, ledger_completed_sequence),
  completed_at = CASE WHEN $3 = 'completed' THEN $10::timestamptz ELSE completed_at END,
  cancelled_at = CASE WHEN $3 = 'cancelled' THEN $10::timestamptz ELSE cancelled_at END,
  started_at = CASE WHEN $3 = 'running' THEN $10::timestamptz ELSE started_at END
WHERE application_id = $1 AND workload_key = $2 AND status = $11
RETURNING ${WORKLOAD_COLUMNS}`,
        parameters: [
          input.applicationId,
          input.workloadKey,
          input.to,
          input.failure?.failureClass ?? null,
          input.failure?.failureMessage ?? null,
          input.completion?.outputArtifactDigest ?? null,
          input.completion?.outputDescriptor === null ||
          input.completion?.outputDescriptor === undefined
            ? null
            : JSON.stringify(input.completion.outputDescriptor),
          input.completion?.usageMicroUsd ?? null,
          input.completion?.completedLedgerSequence ?? null,
          input.now,
          current.status,
        ],
      });
    } catch (error) {
      toTypedGuardError(error);
    }
    const row = first(result.rows);
    if (row === undefined) {
      // A concurrent writer moved the row first — replay the committed state.
      const committed = await this.findWorkloadByKey(input.applicationId, input.workloadKey);
      return committed === null
        ? { claimed: false, record: current }
        : { claimed: false, record: committed };
    }
    return { claimed: true, record: toWorkload(row) };
  }

  async bindWorkloadLedgerSequence(
    input: BindWorkloadLedgerSequenceInput,
  ): Promise<TrainingWorkloadRecord> {
    try {
      const result = await this.db.execute<WorkloadRow>({
        sql: `UPDATE sandbox.training_workloads
SET ledger_admitted_sequence = CASE WHEN $3 = 'admitted' THEN $4 ELSE ledger_admitted_sequence END,
    ledger_completed_sequence = CASE WHEN $3 = 'completed' THEN $4 ELSE ledger_completed_sequence END
WHERE application_id = $1 AND workload_key = $2
RETURNING ${WORKLOAD_COLUMNS}`,
        parameters: [input.applicationId, input.workloadKey, input.phase, input.sequence],
      });
      const row = first(result.rows);
      if (row === undefined) {
        throw new PlatformError({
          code: "SANDBOX_ERROR",
          message: "training workload ledger binding found no row",
          details: { workloadKey: input.workloadKey },
        });
      }
      return toWorkload(row);
    } catch (error) {
      toTypedGuardError(error);
    }
  }

  async bindWorkloadAllocation(
    input: BindWorkloadAllocationInput,
  ): Promise<TrainingWorkloadRecord> {
    try {
      const result = await this.db.execute<WorkloadRow>({
        sql: `UPDATE sandbox.training_workloads
SET allocation_id = $3, substrate_id = $4, adapter_ref = $5,
    allocated_at = COALESCE(allocated_at, $6::timestamptz)
WHERE application_id = $1 AND workload_key = $2
RETURNING ${WORKLOAD_COLUMNS}`,
        parameters: [
          input.applicationId,
          input.workloadKey,
          input.allocationId,
          input.substrateId,
          input.adapterRef,
          input.allocatedAt,
        ],
      });
      const row = first(result.rows);
      if (row === undefined) {
        throw new PlatformError({
          code: "SANDBOX_ERROR",
          message: "training workload allocation binding found no row",
          details: { workloadKey: input.workloadKey },
        });
      }
      return toWorkload(row);
    } catch (error) {
      toTypedGuardError(error);
    }
  }

  async bindWorkloadResumePoint(
    input: BindWorkloadResumePointInput,
  ): Promise<TrainingWorkloadRecord> {
    // The pointer only ADVANCES (monotonic by checkpoint sequence).
    try {
      const result = await this.db.execute<WorkloadRow>({
        sql: `UPDATE sandbox.training_workloads AS w
SET last_checkpoint_identity = $3
WHERE application_id = $1 AND workload_key = $2
  AND (
    w.last_checkpoint_identity IS NULL
    OR w.last_checkpoint_identity = $3
    OR EXISTS (
      SELECT 1 FROM sandbox.training_checkpoints next
      WHERE next.application_id = $1 AND next.content_digest = $3
        AND next.checkpoint_sequence > COALESCE((
          SELECT prev.checkpoint_sequence FROM sandbox.training_checkpoints prev
          WHERE prev.application_id = $1 AND prev.content_digest = w.last_checkpoint_identity
        ), 0)
    )
  )
RETURNING ${WORKLOAD_COLUMNS}`,
        parameters: [input.applicationId, input.workloadKey, input.checkpointIdentity],
      });
      const row = first(result.rows);
      if (row === undefined) {
        const current = await this.findWorkloadByKey(input.applicationId, input.workloadKey);
        if (current === null) {
          throw new PlatformError({
            code: "SANDBOX_ERROR",
            message: "training workload resume-point binding found no row",
            details: { workloadKey: input.workloadKey },
          });
        }
        return current;
      }
      return toWorkload(row);
    } catch (error) {
      toTypedGuardError(error);
    }
  }

  async bindWorkloadOutput(input: BindWorkloadOutputInput): Promise<TrainingWorkloadRecord> {
    try {
      const result = await this.db.execute<WorkloadRow>({
        sql: `UPDATE sandbox.training_workloads
SET output_artifact_digest = COALESCE(output_artifact_digest, $3),
    output_descriptor = COALESCE(output_descriptor, $4::jsonb)
WHERE application_id = $1 AND workload_key = $2
RETURNING ${WORKLOAD_COLUMNS}`,
        parameters: [
          input.applicationId,
          input.workloadKey,
          input.outputArtifactDigest,
          JSON.stringify(input.outputDescriptor),
        ],
      });
      const row = first(result.rows);
      if (row === undefined) {
        throw new PlatformError({
          code: "SANDBOX_ERROR",
          message: "training workload output binding found no row",
          details: { workloadKey: input.workloadKey },
        });
      }
      return toWorkload(row);
    } catch (error) {
      toTypedGuardError(error);
    }
  }

  async bindWorkloadRelease(input: BindWorkloadReleaseInput): Promise<TrainingWorkloadRecord> {
    try {
      const result = await this.db.execute<WorkloadRow>({
        sql: `UPDATE sandbox.training_workloads
SET verified_release_at = $3::timestamptz, verification_evaluation_id = $4
WHERE application_id = $1 AND workload_key = $2 AND verified_release_at IS NULL
RETURNING ${WORKLOAD_COLUMNS}`,
        parameters: [
          input.applicationId,
          input.workloadKey,
          input.verifiedReleaseAt,
          input.verificationEvaluationId,
        ],
      });
      const row = first(result.rows);
      if (row === undefined) {
        const current = await this.findWorkloadByKey(input.applicationId, input.workloadKey);
        if (current === null) {
          throw new PlatformError({
            code: "SANDBOX_ERROR",
            message: "training workload release binding found no row",
            details: { workloadKey: input.workloadKey },
          });
        }
        if (current.verifiedReleaseAt !== null) {
          throw new PlatformError({
            code: "SANDBOX_ERROR",
            message: "the verification-release binding is write-once (it is never re-bound)",
            details: { workloadId: current.id },
          });
        }
        return current;
      }
      return toWorkload(row);
    } catch (error) {
      toTypedGuardError(error);
    }
  }

  async bumpWorkloadAttempts(input: BumpWorkloadAttemptsInput): Promise<TrainingWorkloadRecord> {
    try {
      const result = await this.db.execute<WorkloadRow>({
        sql: `UPDATE sandbox.training_workloads
SET attempts = attempts + 1,
    budget_operation_id = COALESCE($3, budget_operation_id)
WHERE application_id = $1 AND workload_key = $2
RETURNING ${WORKLOAD_COLUMNS}`,
        parameters: [input.applicationId, input.workloadKey, input.budgetOperationId ?? null],
      });
      const row = first(result.rows);
      if (row === undefined) {
        throw new PlatformError({
          code: "SANDBOX_ERROR",
          message: "training workload attempt bump found no row",
          details: { workloadKey: input.workloadKey },
        });
      }
      return toWorkload(row);
    } catch (error) {
      toTypedGuardError(error);
    }
  }

  // ---- checkpoint ledger (append-only; identity = content digest) ----------

  async insertTrainingCheckpoint(
    input: InsertTrainingCheckpointInput,
  ): Promise<TrainingClaimOutcome<TrainingCheckpointRecord>> {
    let result: QueryResult<CheckpointRow>;
    try {
      result = await this.db.execute<CheckpointRow>({
        sql: `INSERT INTO sandbox.training_checkpoints
  (id, application_id, tenant_id, execution_id, workload_id, workload_key, checkpoint_sequence,
   step_position, lineage, metrics_digest, substrate_id, resource_class, recorded_by,
   content_digest, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15)
ON CONFLICT (application_id, content_digest) DO NOTHING
RETURNING ${CHECKPOINT_COLUMNS}`,
        parameters: [
          input.id,
          input.applicationId,
          input.tenantId,
          input.executionId,
          input.workloadId,
          input.workloadKey,
          input.contents.checkpointSequence,
          input.contents.stepPosition,
          JSON.stringify(input.contents.lineage),
          input.contents.metricsDigest,
          input.contents.substrateId,
          input.contents.resourceClass,
          input.contents.recordedBy,
          input.contentDigest,
          input.createdAt,
        ],
      });
    } catch (error) {
      toTypedGuardError(error);
    }
    const row = first(result.rows);
    if (row !== undefined) {
      return { claimed: true, record: toCheckpoint(row) };
    }
    const existing = await this.findTrainingCheckpointByIdentity(
      input.applicationId,
      input.contentDigest,
    );
    if (existing === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "training checkpoint insert returned no row",
        details: { contentDigest: input.contentDigest },
      });
    }
    return { claimed: false, record: existing };
  }

  async findTrainingCheckpointByIdentity(
    applicationId: string,
    contentDigest: string,
  ): Promise<TrainingCheckpointRecord | null> {
    const result = await this.db.execute<CheckpointRow>({
      sql: `SELECT ${CHECKPOINT_COLUMNS} FROM sandbox.training_checkpoints
WHERE application_id = $1 AND content_digest = $2`,
      parameters: [applicationId, contentDigest],
    });
    const row = first(result.rows);
    return row === undefined ? null : toCheckpoint(row);
  }

  async listTrainingCheckpointsByWorkload(
    applicationId: string,
    workloadKey: string,
  ): Promise<readonly TrainingCheckpointRecord[]> {
    const result = await this.db.execute<CheckpointRow>({
      sql: `SELECT ${CHECKPOINT_COLUMNS} FROM sandbox.training_checkpoints
WHERE application_id = $1 AND workload_key = $2 ORDER BY checkpoint_sequence`,
      parameters: [applicationId, workloadKey],
    });
    return result.rows.map(toCheckpoint);
  }

  // ---- durable recoverable operations ---------------------------------------

  async insertTrainingOperation(
    input: InsertTrainingOperationInput,
  ): Promise<TrainingClaimOutcome<TrainingOperationRecord>> {
    let result: QueryResult<OperationRow>;
    try {
      result = await this.db.execute<OperationRow>({
        sql: `INSERT INTO sandbox.training_operations
  (id, application_id, tenant_id, execution_id, workload_id, operation_kind, operation_key,
   request_fingerprint, status, attempts, stage, failure_reason, created_at, updated_at, completed_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 1, NULL, NULL, $9, $9, NULL)
ON CONFLICT (application_id, operation_key) DO NOTHING
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [
          input.id,
          input.applicationId,
          input.tenantId,
          input.executionId,
          input.workloadId,
          input.operationKind,
          input.operationKey,
          input.requestFingerprint,
          input.createdAt,
        ],
      });
    } catch (error) {
      toTypedGuardError(error);
    }
    const row = first(result.rows);
    if (row !== undefined) {
      return { claimed: true, record: toOperation(row) };
    }
    // Conflict: fingerprint arbitration, then the attempts bump (PENDING only).
    const existing = await this.findTrainingOperation(input.applicationId, input.operationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "training operation insert returned no row",
        details: { operationKey: input.operationKey },
      });
    }
    if (existing.requestFingerprint !== input.requestFingerprint) {
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message:
          "training operation key already exists with a different request fingerprint (same key, different body)",
        details: { operationKey: input.operationKey, operationKind: input.operationKind },
      });
    }
    if (existing.status !== "pending") {
      return { claimed: false, record: existing };
    }
    try {
      const bumped = await this.db.execute<OperationRow>({
        sql: `UPDATE sandbox.training_operations
SET attempts = attempts + 1, updated_at = $3
WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [input.applicationId, input.operationKey, input.createdAt],
      });
      const bumpedRow = first(bumped.rows);
      if (bumpedRow !== undefined) {
        return { claimed: false, record: toOperation(bumpedRow) };
      }
    } catch (error) {
      toTypedGuardError(error);
    }
    const committed = await this.findTrainingOperation(input.applicationId, input.operationKey);
    return committed === null
      ? { claimed: false, record: existing }
      : { claimed: false, record: committed };
  }

  async findTrainingOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<TrainingOperationRecord | null> {
    const result = await this.db.execute<OperationRow>({
      sql: `SELECT ${OPERATION_COLUMNS} FROM sandbox.training_operations
WHERE application_id = $1 AND operation_key = $2`,
      parameters: [applicationId, operationKey],
    });
    const row = first(result.rows);
    return row === undefined ? null : toOperation(row);
  }

  async completeTrainingOperation(
    input: CompleteTrainingOperationInput,
  ): Promise<TrainingOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE sandbox.training_operations
SET status = CASE WHEN $3::text IS NULL THEN 'completed' ELSE 'failed' END,
    stage = COALESCE(stage, $4::jsonb),
    failure_reason = $3,
    completed_at = $5::timestamptz,
    updated_at = $5::timestamptz
WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [
          input.applicationId,
          input.operationKey,
          input.failureReason ?? null,
          input.stage === undefined ? null : JSON.stringify(input.stage),
          input.now,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toOperation(row);
      }
    } catch (error) {
      toTypedGuardError(error);
    }
    const existing = await this.findTrainingOperation(input.applicationId, input.operationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "training operation completion requires an existing operation row",
        details: { operationKey: input.operationKey },
      });
    }
    return existing; // terminal rows are immutable — replay
  }

  // ---- run lease -------------------------------------------------------------

  async acquireTrainingRunLease(
    input: AcquireTrainingRunLeaseInput,
  ): Promise<TrainingRunLeaseRecord> {
    const expiresAt = new Date(new Date(input.now).getTime() + input.leaseDurationMs).toISOString();
    // Idempotent re-acquisition by the SAME owner within the live lease
    // returns the standing lease; a free/expired/released lease takes
    // epoch+1; a LIVE foreign lease fails closed (the 0022 discipline).
    try {
      const result = await this.db.execute<LeaseRow>({
        sql: `INSERT INTO sandbox.training_run_leases
  (workload_id, application_id, tenant_id, execution_id, owner_id, epoch, acquired_at, expires_at,
   last_heartbeat_at, heartbeat_count, released_at, release_cause)
VALUES ($1, $2, $3, (SELECT execution_id FROM sandbox.training_workloads WHERE id = $1 AND application_id = $2), $4, 1, $5, $6, $5, 1, NULL, NULL)
ON CONFLICT (application_id, workload_id) DO NOTHING
RETURNING ${LEASE_COLUMNS}`,
        parameters: [
          input.workloadId,
          input.applicationId,
          input.tenantId,
          input.ownerId,
          input.now,
          expiresAt,
        ],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toLease(row);
      }
    } catch (error) {
      toTypedGuardError(error);
    }
    const existing = await this.findTrainingRunLease(input.applicationId, input.workloadId);
    if (existing === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "training run lease acquire returned no row",
        details: { workloadId: input.workloadId },
      });
    }
    const live = existing.releasedAt === null && existing.expiresAt > input.now;
    if (live && existing.ownerId !== input.ownerId) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `the run lease is live and owned by ${existing.ownerId}; lease conflicts fail closed`,
        details: { workloadId: input.workloadId, ownerId: existing.ownerId },
      });
    }
    if (live && existing.ownerId === input.ownerId) {
      return existing; // the same worker's live lease stands
    }
    // Free (expired or released): re-acquire at epoch+1 (monotonic).
    try {
      const result = await this.db.execute<LeaseRow>({
        sql: `UPDATE sandbox.training_run_leases
SET owner_id = $3, epoch = epoch + 1, acquired_at = $4, expires_at = $5,
    last_heartbeat_at = $4, heartbeat_count = 1, released_at = NULL, release_cause = NULL
WHERE application_id = $1 AND workload_id = $2
RETURNING ${LEASE_COLUMNS}`,
        parameters: [input.applicationId, input.workloadId, input.ownerId, input.now, expiresAt],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toLease(row);
      }
    } catch (error) {
      toTypedGuardError(error);
    }
    const committed = await this.findTrainingRunLease(input.applicationId, input.workloadId);
    if (committed === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "training run lease re-acquire returned no row",
        details: { workloadId: input.workloadId },
      });
    }
    return committed;
  }

  async findTrainingRunLease(
    applicationId: string,
    workloadId: string,
  ): Promise<TrainingRunLeaseRecord | null> {
    const result = await this.db.execute<LeaseRow>({
      sql: `SELECT ${LEASE_COLUMNS} FROM sandbox.training_run_leases
WHERE application_id = $1 AND workload_id = $2`,
      parameters: [applicationId, workloadId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toLease(row);
  }

  async renewTrainingRunLease(input: {
    readonly applicationId: string;
    readonly workloadId: string;
    readonly ownerId: string;
    readonly epoch: number;
    readonly now: string;
    readonly extensionMs: number;
  }): Promise<TrainingRunLeaseRecord> {
    const extended = new Date(new Date(input.now).getTime() + input.extensionMs).toISOString();
    try {
      const result = await this.db.execute<LeaseRow>({
        sql: `UPDATE sandbox.training_run_leases
SET expires_at = GREATEST(expires_at, $5::timestamptz), last_heartbeat_at = $4,
    heartbeat_count = heartbeat_count + 1
WHERE application_id = $1 AND workload_id = $2 AND owner_id = $3 AND epoch = $6 AND released_at IS NULL
RETURNING ${LEASE_COLUMNS}`,
        parameters: [
          input.applicationId,
          input.workloadId,
          input.ownerId,
          input.now,
          extended,
          input.epoch,
        ],
      });
      const row = first(result.rows);
      if (row === undefined) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: "run lease renewal requires the owning live (owner, epoch) pair",
          details: { workloadId: input.workloadId },
        });
      }
      return toLease(row);
    } catch (error) {
      toTypedGuardError(error);
    }
  }

  async releaseTrainingRunLease(
    input: ReleaseTrainingRunLeaseInput,
  ): Promise<TrainingRunLeaseRecord> {
    try {
      const result = await this.db.execute<LeaseRow>({
        sql: `UPDATE sandbox.training_run_leases
SET released_at = $4::timestamptz, release_cause = $3
WHERE application_id = $1 AND workload_id = $2 AND released_at IS NULL
RETURNING ${LEASE_COLUMNS}`,
        parameters: [input.applicationId, input.workloadId, input.cause, input.now],
      });
      const row = first(result.rows);
      if (row !== undefined) {
        return toLease(row);
      }
    } catch (error) {
      toTypedGuardError(error);
    }
    const existing = await this.findTrainingRunLease(input.applicationId, input.workloadId);
    if (existing === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "run lease release requires an existing lease row",
        details: { workloadId: input.workloadId },
      });
    }
    return existing; // one-way release: replay
  }
}
