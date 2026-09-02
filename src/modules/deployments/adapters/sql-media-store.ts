/**
 * SQL media store (deployments module adapter; WORK-026).
 *
 * The durable implementation of the `MediaStore` port over the
 * provider-neutral `DatabasePort` (migration
 * `0021_media_generation_jobs.sql`). Physical invariants live in the
 * migration (job identity-core immutability, pinned plan version, the
 * CLOSED provider-neutral job lifecycle with terminal immutability,
 * the verification-before-completion output projection, the
 * append-only observation ledger with the observation-key idempotency
 * UNIQUE, the write-once artifact-adoption records, and the durable,
 * recoverable operation state); this adapter maps rows <-> domain
 * records and converges exactly like the WORK-023/024/025 SQL stores:
 *
 *  - job insert: UNIQUE (application, submission_key) with
 *    creation-fingerprint arbitration;
 *  - `applyGuardedJobMutation`: the single-row guarded UPDATE
 *    arbitrates concurrent mutations (first writer wins; duplicates
 *    converge on the committed row); the migration triggers make
 *    out-of-vocabulary moves, terminal rewrites and identity-core
 *    drift physically unrepresentable;
 *  - `appendObservation`: ON CONFLICT (application, job,
 *    observation_key) DO NOTHING + body-digest-checked convergence —
 *    the observation ledger IS the poll/callback idempotency ledger
 *    (a duplicate poll/callback converges on the committed row; a
 *    same-key/different-body append fails closed);
 *  - `insertArtifact`: ON CONFLICT (application, artifact_key) DO
 *    NOTHING + digest-checked convergence (write-once adoptions);
 *  - `beginMediaOperation`: ON CONFLICT (application, operation_key)
 *    DO NOTHING + the attempts bump (PENDING rows only; terminal rows
 *    replay without a bump);
 *  - every read is scope-filtered (application);
 *  - trigger-raised guard violations are mapped to the typed error
 *    taxonomy (the migration is defense-in-depth behind the service's
 *    own guards).
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type {
  MediaArtifactRecord,
  MediaJobRecord,
  MediaObservationRecord,
  MediaOperationCheckpoint,
  MediaOperationRecord,
} from "../domain/media";
import { isMediaJobForwardProgression, mediaObservationBodyDigestBase } from "../domain/media";
import type {
  MediaArtifactInsertInput,
  MediaArtifactInsertOutcome,
  MediaJobInsertInput,
  MediaJobInsertOutcome,
  MediaJobMutation,
  MediaJobMutationOutcome,
  MediaObservationAppendInput,
  MediaObservationAppendOutcome,
  MediaOperationBeginInput,
  MediaOperationBeginOutcome,
  MediaStore,
} from "../ports/media-store";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map migration-trigger guard violations to the typed taxonomy. */
function toTypedGuardError(error: unknown): PlatformError {
  const message = messageOf(error);
  if (message.includes("media_jobs identity core is immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "media_jobs_core_guard" },
    });
  }
  if (
    message.includes("media_jobs is terminal-immutable") ||
    (message.includes("media job") && message.includes("cannot move from status"))
  ) {
    return new PlatformError({ code: "INVALID_STATE_TRANSITION", message });
  }
  if (message.includes("must record the rail''s opaque job reference")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "media_jobs_lifecycle_guard" },
    });
  }
  if (message.includes("cannot carry an output artifact digest")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "media_jobs_output_projection_guard" },
    });
  }
  if (message.includes("cannot carry a postprocessing digest")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "media_jobs_output_projection_guard" },
    });
  }
  if (message.includes("media_jobs rows are never deleted")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "media_jobs_no_delete_guard" },
    });
  }
  if (message.includes("media_observations is append-only")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "media_obs_append_only_guard" },
    });
  }
  if (message.includes("must not carry raw payload bytes")) {
    return new PlatformError({
      code: "PROVIDER_ERROR",
      message,
      details: { guard: "media_obs_descriptor_shape_guard" },
    });
  }
  if (message.includes("media_artifacts is write-once")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "media_art_immutable_guard" },
    });
  }
  if (message.includes("media_artifacts rows are never deleted")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "media_art_immutable_guard" },
    });
  }
  if (message.includes("media_operations identity core is immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "media_ops_core_guard" },
    });
  }
  if (message.includes("media operation") && message.includes("cannot move from status")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "media_ops_lifecycle_guard" },
    });
  }
  if (message.includes("media_operations is terminal-immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "media_ops_lifecycle_guard" },
    });
  }
  if (message.includes("media_operations rows are never deleted")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "media_ops_no_delete_guard" },
    });
  }
  // The operations ledger's (application_id, tenant_id) FK: a claim for
  // a tenant that does not own the application IS a tenant-scope
  // violation (the claim is the first durable write of an operation).
  if (message.includes("media_operations") && message.includes("violates foreign key constraint")) {
    return new PlatformError({
      code: "TENANT_SCOPE_VIOLATION",
      message: "media operation claims require a tenant that owns the application",
      details: { guard: "media_ops_tenant_fk", cause: message },
    });
  }
  return new PlatformError({
    code: "PROVIDER_ERROR",
    message: "media store guard rejection",
    details: { cause: message },
  });
}

function iso(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : String(value);
}

interface JobRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly deployment_id: string;
  readonly pinned_plan_id: string;
  readonly pinned_plan_version: number;
  readonly execution_id: string;
  readonly generation_kind: string;
  readonly status: string;
  readonly submission_key: string;
  readonly creation_fingerprint: string;
  readonly provider_job_ref: string | null;
  readonly provider_state_label: string | null;
  readonly verification_mode: string;
  readonly verification_criteria: unknown;
  readonly reservation_id: string | null;
  readonly preprocessing_digest: string | null;
  readonly postprocessing_digest: string | null;
  readonly output_artifact_digest: string | null;
  readonly input_artifact_digest: string | null;
  readonly retry_of_job_id: string | null;
  readonly failure_cause: string | null;
  readonly created_by: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly completed_at: Date | string | null;
}

function toJob(row: JobRow): MediaJobRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    deploymentId: row.deployment_id,
    pinnedPlanId: row.pinned_plan_id,
    pinnedPlanVersion: Number(row.pinned_plan_version),
    executionId: row.execution_id,
    generationKind: row.generation_kind as MediaJobRecord["generationKind"],
    status: row.status as MediaJobRecord["status"],
    submissionKey: row.submission_key,
    creationFingerprint: row.creation_fingerprint,
    providerJobRef: row.provider_job_ref,
    providerStateLabel: row.provider_state_label,
    verificationMode: row.verification_mode as MediaJobRecord["verificationMode"],
    verificationCriteria: Array.isArray(row.verification_criteria)
      ? (row.verification_criteria as MediaJobRecord["verificationCriteria"])
      : [],
    reservationId: row.reservation_id,
    preprocessingDigest: row.preprocessing_digest,
    postprocessingDigest: row.postprocessing_digest,
    outputArtifactDigest: row.output_artifact_digest,
    inputArtifactDigest: row.input_artifact_digest,
    retryOfJobId: row.retry_of_job_id,
    failureCause: row.failure_cause,
    createdBy: row.created_by,
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
    completedAt: iso(row.completed_at),
  };
}

const JOB_COLUMNS = `id, application_id, tenant_id, deployment_id, pinned_plan_id, pinned_plan_version,
    execution_id, generation_kind, status, submission_key, creation_fingerprint, provider_job_ref,
    provider_state_label, verification_mode, verification_criteria, reservation_id,
    preprocessing_digest, postprocessing_digest, output_artifact_digest, input_artifact_digest,
    retry_of_job_id, failure_cause, created_by, created_at, updated_at, completed_at`;

interface ObservationRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly job_id: string;
  readonly deployment_id: string;
  readonly observation_key: string;
  readonly source: string;
  readonly observation: string;
  readonly provider_job_ref: string | null;
  readonly provider_state_label: string | null;
  readonly progress: string | number | null;
  readonly output_descriptor: unknown;
  readonly execution_id: string | null;
  readonly ledger_sequence: string | number | null;
  readonly actor_id: string;
  readonly event_seq: string | number;
  readonly created_at: Date | string;
}

function toObservation(row: ObservationRow): MediaObservationRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    jobId: row.job_id,
    deploymentId: row.deployment_id,
    observationKey: row.observation_key,
    source: row.source as MediaObservationRecord["source"],
    observation: row.observation as MediaObservationRecord["observation"],
    providerJobRef: row.provider_job_ref,
    providerStateLabel: row.provider_state_label,
    progress: row.progress === null ? null : Number(row.progress),
    outputDescriptor:
      row.output_descriptor === null || row.output_descriptor === undefined
        ? null
        : (row.output_descriptor as Record<string, unknown>),
    executionId: row.execution_id,
    ledgerSequence: row.ledger_sequence === null ? null : Number(row.ledger_sequence),
    actorId: row.actor_id,
    createdAt: iso(row.created_at) as string,
  };
}

const OBSERVATION_COLUMNS = `id, application_id, tenant_id, job_id, deployment_id, observation_key,
    source, observation, provider_job_ref, provider_state_label, progress, output_descriptor,
    execution_id, ledger_sequence, actor_id, event_seq, created_at`;

interface ArtifactRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly job_id: string;
  readonly deployment_id: string;
  readonly pinned_plan_id: string;
  readonly pinned_plan_version: number;
  readonly execution_id: string;
  readonly role: string;
  readonly artifact_key: string;
  readonly artifact_digest: string;
  readonly parent_digests: unknown;
  readonly descriptor_digest: string;
  readonly ledger_sequence: string | number | null;
  readonly created_by: string;
  readonly created_at: Date | string;
}

function toArtifact(row: ArtifactRow): MediaArtifactRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    jobId: row.job_id,
    deploymentId: row.deployment_id,
    pinnedPlanId: row.pinned_plan_id,
    pinnedPlanVersion: Number(row.pinned_plan_version),
    executionId: row.execution_id,
    role: row.role as MediaArtifactRecord["role"],
    artifactKey: row.artifact_key,
    artifactDigest: row.artifact_digest,
    parentDigests: Array.isArray(row.parent_digests)
      ? (row.parent_digests as string[]).map((value) => String(value))
      : [],
    descriptorDigest: row.descriptor_digest,
    ledgerSequence: row.ledger_sequence === null ? null : Number(row.ledger_sequence),
    createdBy: row.created_by,
    createdAt: iso(row.created_at) as string,
  };
}

const ARTIFACT_COLUMNS = `id, application_id, tenant_id, job_id, deployment_id, pinned_plan_id,
    pinned_plan_version, execution_id, role, artifact_key, artifact_digest, parent_digests,
    descriptor_digest, ledger_sequence, created_by, created_at`;

interface OperationRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly job_id: string | null;
  readonly deployment_id: string;
  readonly execution_id: string | null;
  readonly operation_kind: string;
  readonly operation_key: string;
  readonly status: string;
  readonly attempts: string | number;
  readonly checkpoint: unknown;
  readonly failure_reason: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly completed_at: Date | string | null;
}

function toOperation(row: OperationRow): MediaOperationRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    jobId: row.job_id,
    deploymentId: row.deployment_id,
    executionId: row.execution_id,
    operationKind: row.operation_kind as MediaOperationRecord["operationKind"],
    operationKey: row.operation_key,
    status: row.status as MediaOperationRecord["status"],
    attempts: Number(row.attempts),
    checkpoint:
      row.checkpoint === null || row.checkpoint === undefined
        ? null
        : (row.checkpoint as MediaOperationCheckpoint),
    failureReason: row.failure_reason,
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
    completedAt: iso(row.completed_at),
  };
}

const OPERATION_COLUMNS = `id, application_id, tenant_id, job_id, deployment_id, execution_id,
    operation_kind, operation_key, status, attempts, checkpoint, failure_reason, created_at,
    updated_at, completed_at`;

export class SqlMediaStore implements MediaStore {
  private readonly digest: (canonical: string) => string;

  constructor(
    private readonly db: DatabasePort,
    digest: (canonical: string) => string,
  ) {
    this.digest = digest;
  }

  async insertJob(input: MediaJobInsertInput): Promise<MediaJobInsertOutcome> {
    try {
      const result = await this.db.execute<JobRow>({
        sql: `INSERT INTO deployments.media_jobs (
    ${JOB_COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'submitted', $9, $10, NULL, NULL, $11, $12::jsonb, NULL,
    $13, NULL, NULL, $14, $15, NULL, $16, $17, $17, NULL)
RETURNING ${JOB_COLUMNS}`,
        parameters: [
          input.jobId,
          input.applicationId,
          input.tenantId,
          input.deploymentId,
          input.pinnedPlanId,
          input.pinnedPlanVersion,
          input.executionId,
          input.generationKind,
          input.submissionKey,
          input.creationFingerprint,
          input.verificationMode,
          JSON.stringify(input.verificationCriteria),
          input.preprocessingDigest,
          input.inputArtifactDigest,
          input.retryOfJobId,
          input.createdBy,
          input.createdAt,
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "created", job: toJob(row) };
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        const message = messageOf(error);
        if (message.includes("media_jobs_submission_key_unique")) {
          // Idempotent replay: converge on the committed row after
          // fingerprint arbitration.
          const existing = await this.findJobBySubmissionKey(
            input.applicationId,
            input.submissionKey,
          );
          if (existing !== null) {
            if (existing.creationFingerprint !== input.creationFingerprint) {
              throw new PlatformError({
                code: "IDEMPOTENCY_KEY_REUSED",
                message:
                  "media job submission key already exists with a different creation fingerprint",
                details: { jobId: existing.id },
              });
            }
            return { status: "converged", job: existing };
          }
        }
        if (message.includes("media_jobs_pkey")) {
          // The concurrent-duplicate convergence: the operation claim
          // pinned THIS durable job id for every racer (the claim is
          // unique per submission key), so a pkey conflict means a
          // concurrent invocation committed the SAME job under the SAME
          // submission key — converge on it exactly like the
          // submission-key unique branch (the in-memory store's
          // semantics: same key + same fingerprint = the same job). A
          // pkey hit with a DIFFERENT submission key is a genuine
          // integrity violation and fails closed.
          const byId = await this.findJob(input.applicationId, input.jobId);
          if (byId !== null && byId.submissionKey === input.submissionKey) {
            if (byId.creationFingerprint !== input.creationFingerprint) {
              throw new PlatformError({
                code: "IDEMPOTENCY_KEY_REUSED",
                message:
                  "media job submission key already exists with a different creation fingerprint",
                details: { jobId: byId.id },
              });
            }
            return { status: "converged", job: byId };
          }
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: `media job ${input.jobId} already exists`,
          });
        }
      }
      throw toTypedGuardError(error);
    }
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "media job insert returned no row",
    });
  }

  async findJob(applicationId: string, jobId: string): Promise<MediaJobRecord | null> {
    const result = await this.db.execute<JobRow>({
      sql: `SELECT ${JOB_COLUMNS} FROM deployments.media_jobs
WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, jobId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toJob(row);
  }

  async findJobBySubmissionKey(
    applicationId: string,
    submissionKey: string,
  ): Promise<MediaJobRecord | null> {
    const result = await this.db.execute<JobRow>({
      sql: `SELECT ${JOB_COLUMNS} FROM deployments.media_jobs
WHERE application_id = $1 AND submission_key = $2`,
      parameters: [applicationId, submissionKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : toJob(row);
  }

  async applyGuardedJobMutation(input: MediaJobMutation): Promise<MediaJobMutationOutcome> {
    try {
      const result = await this.db.execute<JobRow>({
        sql: `UPDATE deployments.media_jobs
SET status = $1,
    updated_at = $2,
    provider_job_ref = COALESCE($3, provider_job_ref),
    provider_state_label = COALESCE($4, provider_state_label),
    reservation_id = COALESCE($5, reservation_id),
    postprocessing_digest = COALESCE($6, postprocessing_digest),
    output_artifact_digest = COALESCE($7, output_artifact_digest),
    failure_cause = $8,
    completed_at = COALESCE($9, completed_at)
WHERE application_id = $10 AND id = $11 AND status = $12
RETURNING ${JOB_COLUMNS}`,
        parameters: [
          input.toStatus,
          input.updatedAt,
          input.providerJobRef ?? null,
          input.providerStateLabel ?? null,
          input.reservationId ?? null,
          input.postprocessingDigest ?? null,
          input.outputArtifactDigest ?? null,
          input.failureCause ?? null,
          input.completedAt ?? null,
          input.applicationId,
          input.jobId,
          input.expectedStatus,
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "applied", job: toJob(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // First writer already moved the row (or the guard disagrees):
    // converge when the committed state equals the target, or when the
    // row has already PROGRESSED PAST the target along the forward
    // pipeline (a concurrent duplicate of the same logical operation
    // won the race and moved further — the durable outcome exists);
    // fail closed on genuine regressions and foreign-terminal states.
    const current = await this.findJob(input.applicationId, input.jobId);
    if (current === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `media job ${input.jobId} not found in this application`,
      });
    }
    if (current.status === input.toStatus) {
      return { status: "converged", job: current };
    }
    if (isMediaJobForwardProgression(current.status, input.toStatus)) {
      return { status: "converged", job: current };
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `media job ${input.jobId} guard disagreed: row is ${current.status}; the guarded mutation expected ${input.expectedStatus} -> ${input.toStatus} (first writer wins; replays converge on the committed state)`,
      details: { jobId: input.jobId, from: current.status, expected: input.expectedStatus },
    });
  }

  async listObservations(applicationId: string, jobId: string) {
    const result = await this.db.execute<ObservationRow>({
      sql: `SELECT ${OBSERVATION_COLUMNS} FROM deployments.media_observations
WHERE application_id = $1 AND job_id = $2 ORDER BY event_seq`,
      parameters: [applicationId, jobId],
    });
    return result.rows.map(toObservation);
  }

  async findObservation(applicationId: string, jobId: string, observationKey: string) {
    const result = await this.db.execute<ObservationRow>({
      sql: `SELECT ${OBSERVATION_COLUMNS} FROM deployments.media_observations
WHERE application_id = $1 AND job_id = $2 AND observation_key = $3`,
      parameters: [applicationId, jobId, observationKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : toObservation(row);
  }

  async appendObservation(
    input: MediaObservationAppendInput,
  ): Promise<MediaObservationAppendOutcome> {
    try {
      const result = await this.db.execute<ObservationRow>({
        sql: `INSERT INTO deployments.media_observations (
    ${OBSERVATION_COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, DEFAULT, $16)
ON CONFLICT (application_id, job_id, observation_key) DO NOTHING
RETURNING ${OBSERVATION_COLUMNS}`,
        parameters: [
          input.observationId,
          input.applicationId,
          input.tenantId,
          input.jobId,
          input.deploymentId,
          input.observationKey,
          input.source,
          input.observation,
          input.providerJobRef,
          input.providerStateLabel,
          input.progress,
          input.outputDescriptor === null ? null : JSON.stringify(input.outputDescriptor),
          input.executionId,
          input.ledgerSequence,
          input.actorId,
          input.createdAt,
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "appended", observation: toObservation(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // The conflict path: the observation row already exists — converge
    // after body-digest arbitration (same body = idempotent replay;
    // different body = key reuse, fail closed).
    const existing = await this.findObservation(
      input.applicationId,
      input.jobId,
      input.observationKey,
    );
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "media observation insert returned no row",
        details: { observationKey: input.observationKey },
      });
    }
    const existingDigest = this.digest(
      mediaObservationBodyDigestBase({
        jobId: existing.jobId,
        observationKey: existing.observationKey,
        observation: existing.observation,
        outputDescriptor: existing.outputDescriptor,
      }),
    );
    const incomingDigest = this.digest(
      mediaObservationBodyDigestBase({
        jobId: input.jobId,
        observationKey: input.observationKey,
        observation: input.observation,
        outputDescriptor: input.outputDescriptor,
      }),
    );
    if (existingDigest !== incomingDigest) {
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message:
          "media observation key already exists with a different body (same-key/different-body replays fail closed)",
        details: { observationKey: input.observationKey },
      });
    }
    return { status: "converged", observation: existing };
  }

  async insertArtifact(input: MediaArtifactInsertInput): Promise<MediaArtifactInsertOutcome> {
    try {
      const result = await this.db.execute<ArtifactRow>({
        sql: `INSERT INTO deployments.media_artifacts (
    ${ARTIFACT_COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16)
ON CONFLICT (application_id, artifact_key) DO NOTHING
RETURNING ${ARTIFACT_COLUMNS}`,
        parameters: [
          input.artifactRowId,
          input.applicationId,
          input.tenantId,
          input.jobId,
          input.deploymentId,
          input.pinnedPlanId,
          input.pinnedPlanVersion,
          input.executionId,
          input.role,
          input.artifactKey,
          input.artifactDigest,
          JSON.stringify(input.parentDigests),
          input.descriptorDigest,
          input.ledgerSequence,
          input.createdBy,
          input.createdAt,
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "appended", artifact: toArtifact(row) };
      }
    } catch (error) {
      if (isUniqueViolation(error) && messageOf(error).includes("media_art_key_unique")) {
        const existing = await this.findArtifact(input.applicationId, input.artifactKey);
        if (existing !== null) {
          if (existing.artifactDigest !== input.artifactDigest) {
            throw new PlatformError({
              code: "IDEMPOTENCY_KEY_REUSED",
              message:
                "media artifact key already exists with a different digest (same-key/different-content adoptions fail closed)",
              details: { artifactKey: input.artifactKey },
            });
          }
          return { status: "converged", artifact: existing };
        }
      }
      throw toTypedGuardError(error);
    }
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "media artifact insert returned no row",
    });
  }

  async findArtifact(applicationId: string, artifactKey: string) {
    const result = await this.db.execute<ArtifactRow>({
      sql: `SELECT ${ARTIFACT_COLUMNS} FROM deployments.media_artifacts
WHERE application_id = $1 AND artifact_key = $2`,
      parameters: [applicationId, artifactKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : toArtifact(row);
  }

  async listArtifacts(applicationId: string, jobId: string) {
    const result = await this.db.execute<ArtifactRow>({
      sql: `SELECT ${ARTIFACT_COLUMNS} FROM deployments.media_artifacts
WHERE application_id = $1 AND job_id = $2 ORDER BY created_at, id`,
      parameters: [applicationId, jobId],
    });
    return result.rows.map(toArtifact);
  }

  // -- the durable, recoverable operation state (WORK-024 standard) --

  async beginMediaOperation(input: MediaOperationBeginInput): Promise<MediaOperationBeginOutcome> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `INSERT INTO deployments.media_operations (
    ${OPERATION_COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 1, NULL, NULL, $9, $9, NULL)
ON CONFLICT (application_id, operation_key) DO NOTHING
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [
          input.operationId,
          input.applicationId,
          input.tenantId,
          input.jobId,
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
    const existing = await this.findMediaOperation(input.applicationId, input.operationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "media operation begin returned no row",
        details: { operationKey: input.operationKey },
      });
    }
    if (existing.status !== "pending") {
      return { status: "existing", record: existing };
    }
    try {
      const bumped = await this.db.execute<OperationRow>({
        sql: `UPDATE deployments.media_operations
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
    const committed = await this.findMediaOperation(input.applicationId, input.operationKey);
    if (committed === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "media operation row disappeared after begin",
        details: { operationKey: input.operationKey },
      });
    }
    return { status: "existing", record: committed };
  }

  async recordMediaOperationCheckpoint(
    applicationId: string,
    operationKey: string,
    checkpoint: MediaOperationCheckpoint,
    updatedAt: string,
  ): Promise<MediaOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE deployments.media_operations
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
      message: `media operation ${operationKey} is ${existing.status}; a checkpoint is writable only while pending`,
    });
  }

  async completeMediaOperation(
    applicationId: string,
    operationKey: string,
    completedAt: string,
  ): Promise<MediaOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE deployments.media_operations
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
      message: `media operation ${operationKey} is ${existing.status}; a failed operation cannot be completed`,
      details: { failureReason: existing.failureReason },
    });
  }

  async failMediaOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    failedAt: string,
  ): Promise<MediaOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE deployments.media_operations
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
      message: `media operation ${operationKey} is ${existing.status}; a completed operation cannot be failed`,
      details: { completedAt: existing.completedAt },
    });
  }

  async findMediaOperation(applicationId: string, operationKey: string) {
    const result = await this.db.execute<OperationRow>({
      sql: `SELECT ${OPERATION_COLUMNS} FROM deployments.media_operations
WHERE application_id = $1 AND operation_key = $2`,
      parameters: [applicationId, operationKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : toOperation(row);
  }

  private async requireOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<MediaOperationRecord> {
    const existing = await this.findMediaOperation(applicationId, operationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `media operation ${operationKey} not found in this application`,
      });
    }
    return existing;
  }
}
