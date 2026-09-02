/**
 * In-memory media store (deployments module adapter; WORK-026 default).
 *
 * Implements the `MediaStore` port fully in memory with the SAME
 * arbitration semantics as the SQL twin (migration 0021): submission-
 * key convergence with creation-fingerprint arbitration, guarded job
 * mutations (first writer wins; duplicates converge on the committed
 * row), the append-only observation ledger (observation-key
 * convergence with body-digest arbitration), write-once artifact
 * adoption records, and the durable, recoverable operation state
 * (claim → pending; checkpoint pending-only; terminal immutability).
 *
 * In-memory state is the unit/discrimination tier's surviving world
 * (the WORK-025 in-memory-messaging-store pattern); the durable twin
 * is `sql-media-store.ts`.
 */

import { PlatformError } from "../../../shared/errors";
import type {
  MediaArtifactRecord,
  MediaJobRecord,
  MediaObservationRecord,
  MediaOperationCheckpoint,
  MediaOperationRecord,
  MediaProviderObservation,
} from "../domain/media";
import {
  canTransitionMediaJob,
  isTerminalMediaJobStatus,
  mediaObservationBodyDigestBase,
} from "../domain/media";
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

/** The mutable internal row shapes (the records are frozen read-only views). */
interface MemoryJob {
  id: string;
  applicationId: string;
  tenantId: string;
  deploymentId: string;
  pinnedPlanId: string;
  pinnedPlanVersion: number;
  executionId: string;
  generationKind: string;
  status: string;
  submissionKey: string;
  creationFingerprint: string;
  providerJobRef: string | null;
  providerStateLabel: string | null;
  verificationMode: string;
  verificationCriteria: readonly unknown[];
  reservationId: string | null;
  preprocessingDigest: string | null;
  postprocessingDigest: string | null;
  outputArtifactDigest: string | null;
  inputArtifactDigest: string | null;
  retryOfJobId: string | null;
  failureCause: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface MemoryObservation {
  id: string;
  applicationId: string;
  tenantId: string;
  jobId: string;
  deploymentId: string;
  observationKey: string;
  source: string;
  observation: string;
  providerJobRef: string | null;
  providerStateLabel: string | null;
  progress: number | null;
  outputDescriptor: Readonly<Record<string, unknown>> | null;
  executionId: string | null;
  ledgerSequence: number | null;
  actorId: string;
  createdAt: string;
}

interface MemoryArtifact {
  id: string;
  applicationId: string;
  tenantId: string;
  jobId: string;
  deploymentId: string;
  pinnedPlanId: string;
  pinnedPlanVersion: number;
  executionId: string;
  role: string;
  artifactKey: string;
  artifactDigest: string;
  parentDigests: readonly string[];
  descriptorDigest: string;
  ledgerSequence: number | null;
  createdBy: string;
  createdAt: string;
}

interface MemoryOperation {
  id: string;
  applicationId: string;
  tenantId: string;
  jobId: string | null;
  deploymentId: string;
  executionId: string | null;
  operationKind: string;
  operationKey: string;
  status: string;
  attempts: number;
  checkpoint: MediaOperationCheckpoint | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function toJob(job: MemoryJob): MediaJobRecord {
  return {
    id: job.id,
    applicationId: job.applicationId,
    tenantId: job.tenantId,
    deploymentId: job.deploymentId,
    pinnedPlanId: job.pinnedPlanId,
    pinnedPlanVersion: job.pinnedPlanVersion,
    executionId: job.executionId,
    generationKind: job.generationKind as MediaJobRecord["generationKind"],
    status: job.status as MediaJobRecord["status"],
    submissionKey: job.submissionKey,
    creationFingerprint: job.creationFingerprint,
    providerJobRef: job.providerJobRef,
    providerStateLabel: job.providerStateLabel,
    verificationMode: job.verificationMode as MediaJobRecord["verificationMode"],
    verificationCriteria: job.verificationCriteria as MediaJobRecord["verificationCriteria"],
    reservationId: job.reservationId,
    preprocessingDigest: job.preprocessingDigest,
    postprocessingDigest: job.postprocessingDigest,
    outputArtifactDigest: job.outputArtifactDigest,
    inputArtifactDigest: job.inputArtifactDigest,
    retryOfJobId: job.retryOfJobId,
    failureCause: job.failureCause,
    createdBy: job.createdBy,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

function toObservation(observation: MemoryObservation): MediaObservationRecord {
  return {
    id: observation.id,
    applicationId: observation.applicationId,
    tenantId: observation.tenantId,
    jobId: observation.jobId,
    deploymentId: observation.deploymentId,
    observationKey: observation.observationKey,
    source: observation.source as MediaObservationRecord["source"],
    observation: observation.observation as MediaObservationRecord["observation"],
    providerJobRef: observation.providerJobRef,
    providerStateLabel: observation.providerStateLabel,
    progress: observation.progress,
    outputDescriptor: observation.outputDescriptor,
    executionId: observation.executionId,
    ledgerSequence: observation.ledgerSequence,
    actorId: observation.actorId,
    createdAt: observation.createdAt,
  };
}

function toArtifact(artifact: MemoryArtifact): MediaArtifactRecord {
  return {
    id: artifact.id,
    applicationId: artifact.applicationId,
    tenantId: artifact.tenantId,
    jobId: artifact.jobId,
    deploymentId: artifact.deploymentId,
    pinnedPlanId: artifact.pinnedPlanId,
    pinnedPlanVersion: artifact.pinnedPlanVersion,
    executionId: artifact.executionId,
    role: artifact.role as MediaArtifactRecord["role"],
    artifactKey: artifact.artifactKey,
    artifactDigest: artifact.artifactDigest,
    parentDigests: [...artifact.parentDigests],
    descriptorDigest: artifact.descriptorDigest,
    ledgerSequence: artifact.ledgerSequence,
    createdBy: artifact.createdBy,
    createdAt: artifact.createdAt,
  };
}

function toOperation(operation: MemoryOperation): MediaOperationRecord {
  return {
    id: operation.id,
    applicationId: operation.applicationId,
    tenantId: operation.tenantId,
    jobId: operation.jobId,
    deploymentId: operation.deploymentId,
    executionId: operation.executionId,
    operationKind: operation.operationKind as MediaOperationRecord["operationKind"],
    operationKey: operation.operationKey,
    status: operation.status as MediaOperationRecord["status"],
    attempts: operation.attempts,
    checkpoint: operation.checkpoint,
    failureReason: operation.failureReason,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    completedAt: operation.completedAt,
  };
}

export class InMemoryMediaStore implements MediaStore {
  private readonly jobs = new Map<string, MemoryJob>();
  private readonly jobsBySubmissionKey = new Map<string, string>();
  private readonly observations = new Map<string, MemoryObservation[]>();
  private readonly observationIds = new Map<string, string>();
  private readonly artifacts = new Map<string, MemoryArtifact>();
  private readonly operations = new Map<string, MemoryOperation>();
  private readonly digestFn: (input: string) => string;

  constructor(digest: (input: string) => string = (input) => input) {
    this.digestFn = digest;
  }

  async insertJob(input: MediaJobInsertInput): Promise<MediaJobInsertOutcome> {
    const submissionMapKey = `${input.applicationId}:${input.submissionKey}`;
    const existingId = this.jobsBySubmissionKey.get(submissionMapKey);
    if (existingId !== undefined) {
      const existing = this.jobs.get(existingId);
      if (existing === undefined) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "media job index is inconsistent (submissions key without a job row)",
        });
      }
      if (existing.creationFingerprint !== input.creationFingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "media job submission key already exists with a different creation fingerprint",
          details: { jobId: existing.id },
        });
      }
      return { status: "converged", job: toJob(existing) };
    }
    if (this.jobs.has(input.jobId)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `media job ${input.jobId} already exists`,
      });
    }
    const job: MemoryJob = {
      id: input.jobId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      deploymentId: input.deploymentId,
      pinnedPlanId: input.pinnedPlanId,
      pinnedPlanVersion: input.pinnedPlanVersion,
      executionId: input.executionId,
      generationKind: input.generationKind,
      status: "submitted",
      submissionKey: input.submissionKey,
      creationFingerprint: input.creationFingerprint,
      providerJobRef: null,
      providerStateLabel: null,
      verificationMode: input.verificationMode,
      verificationCriteria: [...input.verificationCriteria],
      reservationId: null,
      preprocessingDigest: input.preprocessingDigest,
      postprocessingDigest: null,
      outputArtifactDigest: null,
      inputArtifactDigest: input.inputArtifactDigest,
      retryOfJobId: input.retryOfJobId,
      failureCause: null,
      createdBy: input.createdBy,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      completedAt: null,
    };
    this.jobs.set(input.jobId, job);
    this.jobsBySubmissionKey.set(submissionMapKey, input.jobId);
    return { status: "created", job: toJob(job) };
  }

  async findJob(applicationId: string, jobId: string): Promise<MediaJobRecord | null> {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.applicationId !== applicationId) {
      return null;
    }
    return toJob(job);
  }

  async findJobBySubmissionKey(
    applicationId: string,
    submissionKey: string,
  ): Promise<MediaJobRecord | null> {
    const id = this.jobsBySubmissionKey.get(`${applicationId}:${submissionKey}`);
    if (id === undefined) {
      return null;
    }
    const job = this.jobs.get(id);
    return job === undefined ? null : toJob(job);
  }

  async applyGuardedJobMutation(input: MediaJobMutation): Promise<MediaJobMutationOutcome> {
    const job = this.jobs.get(input.jobId);
    if (job === undefined || job.applicationId !== input.applicationId) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `media job ${input.jobId} not found in this application`,
      });
    }
    if (job.status === input.toStatus) {
      // The committed row already satisfies the target: convergence.
      return { status: "converged", job: toJob(job) };
    }
    if (job.status !== input.expectedStatus || !canTransitionMediaJob(job.status, input.toStatus)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `media job ${input.jobId} guard disagreed: row is ${job.status}; the guarded mutation expected ${input.expectedStatus} -> ${input.toStatus} (first writer wins; replays converge on the committed state)`,
        details: { jobId: input.jobId, from: job.status, expected: input.expectedStatus },
      });
    }
    if (input.toStatus === "generating" && job.providerJobRef !== null) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `media job ${input.jobId} already carries a rail job reference (the dispatch is recorded exactly once)`,
      });
    }
    job.status = input.toStatus;
    job.updatedAt = input.updatedAt;
    if (input.providerJobRef !== undefined) {
      job.providerJobRef = input.providerJobRef;
    }
    if (input.providerStateLabel !== undefined) {
      job.providerStateLabel = input.providerStateLabel;
    }
    if (input.reservationId !== undefined) {
      job.reservationId = input.reservationId;
    }
    if (input.postprocessingDigest !== undefined) {
      job.postprocessingDigest = input.postprocessingDigest;
    }
    if (input.outputArtifactDigest !== undefined) {
      job.outputArtifactDigest = input.outputArtifactDigest;
    }
    if (input.failureCause !== undefined) {
      job.failureCause = input.failureCause;
    }
    if (isTerminalMediaJobStatus(input.toStatus)) {
      job.completedAt = input.completedAt ?? input.updatedAt;
    }
    return { status: "applied", job: toJob(job) };
  }

  async listObservations(applicationId: string, jobId: string) {
    const rows = this.observations.get(`${applicationId}:${jobId}`) ?? [];
    return rows.map((row) => toObservation(row));
  }

  async findObservation(applicationId: string, jobId: string, observationKey: string) {
    const rows = this.observations.get(`${applicationId}:${jobId}`) ?? [];
    const row = rows.find((candidate) => candidate.observationKey === observationKey);
    return row === undefined ? null : toObservation(row);
  }

  async appendObservation(
    input: MediaObservationAppendInput,
  ): Promise<MediaObservationAppendOutcome> {
    const listKey = `${input.applicationId}:${input.jobId}`;
    const rows = this.observations.get(listKey) ?? [];
    const existing = rows.find((candidate) => candidate.observationKey === input.observationKey);
    if (existing !== undefined) {
      const existingDigest = this.digestFn(
        mediaObservationBodyDigestBase({
          jobId: input.jobId,
          observationKey: existing.observationKey,
          observation: existing.observation as MediaProviderObservation,
          outputDescriptor: existing.outputDescriptor,
        }),
      );
      const incomingDigest = this.digestFn(
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
      return { status: "converged", observation: toObservation(existing) };
    }
    const observation: MemoryObservation = {
      id: input.observationId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      jobId: input.jobId,
      deploymentId: input.deploymentId,
      observationKey: input.observationKey,
      source: input.source,
      observation: input.observation,
      providerJobRef: input.providerJobRef,
      providerStateLabel: input.providerStateLabel,
      progress: input.progress,
      outputDescriptor: input.outputDescriptor,
      executionId: input.executionId,
      ledgerSequence: input.ledgerSequence,
      actorId: input.actorId,
      createdAt: input.createdAt,
    };
    rows.push(observation);
    this.observations.set(listKey, rows);
    this.observationIds.set(input.observationId, input.observationKey);
    return { status: "appended", observation: toObservation(observation) };
  }

  async insertArtifact(input: MediaArtifactInsertInput): Promise<MediaArtifactInsertOutcome> {
    const existing = this.artifacts.get(`${input.applicationId}:${input.artifactKey}`);
    if (existing !== undefined) {
      if (existing.artifactDigest !== input.artifactDigest) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message:
            "media artifact key already exists with a different digest (same-key/different-content adoptions fail closed)",
          details: { artifactKey: input.artifactKey },
        });
      }
      return { status: "converged", artifact: toArtifact(existing) };
    }
    const artifact: MemoryArtifact = {
      id: input.artifactRowId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      jobId: input.jobId,
      deploymentId: input.deploymentId,
      pinnedPlanId: input.pinnedPlanId,
      pinnedPlanVersion: input.pinnedPlanVersion,
      executionId: input.executionId,
      role: input.role,
      artifactKey: input.artifactKey,
      artifactDigest: input.artifactDigest,
      parentDigests: [...input.parentDigests],
      descriptorDigest: input.descriptorDigest,
      ledgerSequence: input.ledgerSequence,
      createdBy: input.createdBy,
      createdAt: input.createdAt,
    };
    this.artifacts.set(`${input.applicationId}:${input.artifactKey}`, artifact);
    return { status: "appended", artifact: toArtifact(artifact) };
  }

  async findArtifact(applicationId: string, artifactKey: string) {
    const artifact = this.artifacts.get(`${applicationId}:${artifactKey}`);
    return artifact === undefined ? null : toArtifact(artifact);
  }

  async listArtifacts(applicationId: string, jobId: string) {
    const out: MediaArtifactRecord[] = [];
    for (const artifact of this.artifacts.values()) {
      if (artifact.applicationId === applicationId && artifact.jobId === jobId) {
        out.push(toArtifact(artifact));
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async beginMediaOperation(input: MediaOperationBeginInput): Promise<MediaOperationBeginOutcome> {
    const existing = this.operations.get(`${input.applicationId}:${input.operationKey}`);
    if (existing === undefined) {
      const operation: MemoryOperation = {
        id: input.operationId,
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        jobId: input.jobId,
        deploymentId: input.deploymentId,
        executionId: input.executionId,
        operationKind: input.operationKind,
        operationKey: input.operationKey,
        status: "pending",
        attempts: 1,
        checkpoint: null,
        failureReason: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        completedAt: null,
      };
      this.operations.set(`${input.applicationId}:${input.operationKey}`, operation);
      return { status: "begun", record: toOperation(operation) };
    }
    if (existing.status !== "pending") {
      return { status: "existing", record: toOperation(existing) };
    }
    existing.attempts += 1;
    existing.updatedAt = input.createdAt;
    return { status: "existing", record: toOperation(existing) };
  }

  async recordMediaOperationCheckpoint(
    applicationId: string,
    operationKey: string,
    checkpoint: MediaOperationCheckpoint,
    updatedAt: string,
  ): Promise<MediaOperationRecord> {
    const operation = this.operations.get(`${applicationId}:${operationKey}`);
    if (operation === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `media operation ${operationKey} not found in this application`,
      });
    }
    if (operation.status !== "pending") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `media operation ${operationKey} is ${operation.status}; a checkpoint is writable only while pending`,
      });
    }
    operation.checkpoint = checkpoint;
    operation.updatedAt = updatedAt;
    return toOperation(operation);
  }

  async completeMediaOperation(
    applicationId: string,
    operationKey: string,
    completedAt: string,
  ): Promise<MediaOperationRecord> {
    const operation = this.operations.get(`${applicationId}:${operationKey}`);
    if (operation === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `media operation ${operationKey} not found in this application`,
      });
    }
    if (operation.status === "completed") {
      return toOperation(operation);
    }
    if (operation.status === "failed") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `media operation ${operationKey} is failed; a failed operation cannot be completed`,
        details: { failureReason: operation.failureReason },
      });
    }
    operation.status = "completed";
    operation.completedAt = completedAt;
    operation.updatedAt = completedAt;
    return toOperation(operation);
  }

  async failMediaOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    failedAt: string,
  ): Promise<MediaOperationRecord> {
    const operation = this.operations.get(`${applicationId}:${operationKey}`);
    if (operation === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `media operation ${operationKey} not found in this application`,
      });
    }
    if (operation.status === "failed") {
      return toOperation(operation);
    }
    if (operation.status === "completed") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `media operation ${operationKey} is completed; a completed operation cannot be failed`,
      });
    }
    operation.status = "failed";
    operation.failureReason = reason.slice(0, 512);
    operation.updatedAt = failedAt;
    return toOperation(operation);
  }

  async findMediaOperation(applicationId: string, operationKey: string) {
    const operation = this.operations.get(`${applicationId}:${operationKey}`);
    return operation === undefined ? null : toOperation(operation);
  }
}
