/**
 * Media generation store port (deployments module outbound; WORK-026,
 * MOD-011/MOD-013 — the durable state of the media-generation fabric).
 *
 * The durable-state seam for media generation jobs (the closed
 * provider-neutral lifecycle), the append-only provider-observation
 * ledger, the immutable artifact-adoption records and the DURABLE,
 * RECOVERABLE OPERATION STATE (migration 0021). The arbitration
 * contract (the WORK-011/012/017/023/024/025 discipline):
 *
 *   - job creation converges on (application, submission key) with
 *     creation-fingerprint arbitration (a same-key/different-body
 *     submission fails closed — IDEMPOTENCY_KEY_REUSED);
 *   - job mutations are GUARDED: the store takes the expected current
 *     status and the physical single-row update arbitrates concurrent
 *     duplicates — first writer wins, duplicates converge on the
 *     committed row; the identity core (tenant/deployment/pin/
 *     execution/generation kind/submission key/fingerprint) is
 *     immutable on every UPDATE path; terminal statuses are fully
 *     immutable;
 *   - the observation ledger is APPEND-ONLY and the OBSERVATION
 *     IDEMPOTENCY LEDGER: appending converges on the physical UNIQUE
 *     (application, job, observation_key) — the winner proceeds, a
 *     duplicate converges on the committed row (same body digest; a
 *     same-key/different-body append fails closed);
 *   - artifact-adoption records are WRITE-ONCE: the adoption converges
 *     on the physical UNIQUE (application, artifact_key) — the
 *     content-addressed digest is recorded, never the media bytes;
 *   - the DURABLE, RECOVERABLE OPERATION STATE (the WORK-024
 *     crash-safety standard): every governed media side-effect
 *     operation owns ONE row in the operations ledger with a
 *     PENDING → COMPLETED|FAILED machine. `beginMediaOperation`
 *     converges on the physical UNIQUE (application, operation_key)
 *     and bumps `attempts` on re-claim; `completed`/`failed` are
 *     terminal-immutable (physical trigger); a crash between claim
 *     and completion leaves the row PENDING and a retry MUST resume
 *     it;
 *   - every read is scope-filtered (application); tenant identity is
 *     carried on every row and never dropped.
 */

import type {
  MediaArtifactRecord,
  MediaArtifactRole,
  MediaCriteriaRef,
  MediaJobRecord,
  MediaJobStatus,
  MediaObservationRecord,
  MediaObservationSource,
  MediaOperationCheckpoint,
  MediaOperationKind,
  MediaOperationRecord,
  MediaProviderObservation,
  MediaVerificationMode,
} from "../domain/media";

export interface MediaJobInsertInput {
  readonly jobId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deploymentId: string;
  readonly pinnedPlanId: string;
  readonly pinnedPlanVersion: number;
  readonly executionId: string;
  readonly generationKind: string;
  readonly submissionKey: string;
  readonly creationFingerprint: string;
  readonly verificationMode: string;
  readonly verificationCriteria: readonly MediaCriteriaRef[];
  readonly preprocessingDigest: string | null;
  readonly inputArtifactDigest: string | null;
  readonly retryOfJobId: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export type MediaJobInsertOutcome =
  | { readonly status: "created"; readonly job: MediaJobRecord }
  | { readonly status: "converged"; readonly job: MediaJobRecord };

export interface MediaJobMutation {
  readonly applicationId: string;
  readonly jobId: string;
  /** The expected CURRENT status (the guard). */
  readonly expectedStatus: MediaJobStatus;
  /** The target status (the guarded status move). */
  readonly toStatus: MediaJobStatus;
  /** The opaque rail job reference to record (dispatch/generating moves only). */
  readonly providerJobRef?: string | null;
  /** The rail's raw state label (reference-only evidence). */
  readonly providerStateLabel?: string | null;
  readonly reservationId?: string | null;
  readonly postprocessingDigest?: string | null;
  readonly outputArtifactDigest?: string | null;
  readonly failureCause?: string | null;
  readonly completedAt?: string | null;
  readonly updatedAt: string;
}

export type MediaJobMutationOutcome =
  | { readonly status: "applied"; readonly job: MediaJobRecord }
  | { readonly status: "converged"; readonly job: MediaJobRecord };

export interface MediaObservationAppendInput {
  readonly observationId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly jobId: string;
  readonly deploymentId: string;
  readonly observationKey: string;
  readonly source: MediaObservationSource;
  readonly observation: MediaProviderObservation;
  readonly providerJobRef: string | null;
  readonly providerStateLabel: string | null;
  readonly progress: number | null;
  readonly outputDescriptor: Readonly<Record<string, unknown>> | null;
  readonly executionId: string | null;
  readonly ledgerSequence: number | null;
  readonly actorId: string;
  readonly createdAt: string;
}

export type MediaObservationAppendOutcome =
  | { readonly status: "appended"; readonly observation: MediaObservationRecord }
  | { readonly status: "converged"; readonly observation: MediaObservationRecord };

export interface MediaArtifactInsertInput {
  readonly artifactRowId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly jobId: string;
  readonly deploymentId: string;
  readonly pinnedPlanId: string;
  readonly pinnedPlanVersion: number;
  readonly executionId: string;
  readonly role: MediaArtifactRole;
  readonly artifactKey: string;
  readonly artifactDigest: string;
  readonly parentDigests: readonly string[];
  readonly descriptorDigest: string;
  readonly ledgerSequence: number | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export type MediaArtifactInsertOutcome =
  | { readonly status: "appended"; readonly artifact: MediaArtifactRecord }
  | { readonly status: "converged"; readonly artifact: MediaArtifactRecord };

/** Input of `beginMediaOperation` (the durable operation claim). */
export interface MediaOperationBeginInput {
  readonly operationId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /**
   * Provenance reference only (NO physical FK): a job-submission
   * operation row is durably claimed BEFORE its job row exists —
   * that ordering is exactly the crash window this ledger closes.
   */
  readonly jobId: string | null;
  readonly deploymentId: string;
  readonly executionId: string | null;
  readonly operationKind: MediaOperationKind;
  readonly operationKey: string;
  readonly createdAt: string;
}

export type MediaOperationBeginOutcome =
  | { readonly status: "begun"; readonly record: MediaOperationRecord }
  | { readonly status: "existing"; readonly record: MediaOperationRecord };

export interface MediaStore {
  insertJob(input: MediaJobInsertInput): Promise<MediaJobInsertOutcome>;
  findJob(applicationId: string, jobId: string): Promise<MediaJobRecord | null>;
  /** The idempotent-replay fast path (the job-submission key lookup). */
  findJobBySubmissionKey(
    applicationId: string,
    submissionKey: string,
  ): Promise<MediaJobRecord | null>;
  /**
   * The GUARDED single-row status move (the closed lifecycle): the
   * expected current status arbitrates concurrent duplicates — first
   * writer wins, a duplicate converges on the committed row when the
   * committed row already satisfies the target.
   */
  applyGuardedJobMutation(input: MediaJobMutation): Promise<MediaJobMutationOutcome>;
  /** The observation ledger of one job in append order. */
  listObservations(
    applicationId: string,
    jobId: string,
  ): Promise<readonly MediaObservationRecord[]>;
  /** One observation by its stable key (the dedupe lookup). */
  findObservation(
    applicationId: string,
    jobId: string,
    observationKey: string,
  ): Promise<MediaObservationRecord | null>;
  /**
   * Append one provider-observation EVIDENCE row (the ledger converges
   * on the physical UNIQUE (application, job, observation_key); a
   * same-key/different-body replay fails closed).
   */
  appendObservation(input: MediaObservationAppendInput): Promise<MediaObservationAppendOutcome>;
  /** Insert the immutable artifact-adoption record (idempotent by artifact key). */
  insertArtifact(input: MediaArtifactInsertInput): Promise<MediaArtifactInsertOutcome>;
  findArtifact(applicationId: string, artifactKey: string): Promise<MediaArtifactRecord | null>;
  /** The adoption records of one job in adoption order. */
  listArtifacts(applicationId: string, jobId: string): Promise<readonly MediaArtifactRecord[]>;

  // -- the durable, recoverable operation state (WORK-024 standard) ------

  /**
   * Claim (or re-claim) one governed operation. Converges on the
   * physical UNIQUE (application, operation_key): the first invocation
   * inserts a PENDING row; every later invocation with the same key
   * returns the EXISTING row with `attempts` bumped — the caller MUST
   * distinguish `completed` (pure replay), `failed` (recorded failure
   * replay) and `pending` (crash-resume) before side effects.
   */
  beginMediaOperation(input: MediaOperationBeginInput): Promise<MediaOperationBeginOutcome>;
  /**
   * Persist the stage checkpoint (PENDING rows only; the
   * past-the-point-of-no-return facts a resume completes from).
   */
  recordMediaOperationCheckpoint(
    applicationId: string,
    operationKey: string,
    checkpoint: MediaOperationCheckpoint,
    updatedAt: string,
  ): Promise<MediaOperationRecord>;
  /** PENDING → COMPLETED (idempotent convergence; a failed operation cannot complete). */
  completeMediaOperation(
    applicationId: string,
    operationKey: string,
    completedAt: string,
  ): Promise<MediaOperationRecord>;
  /** PENDING → FAILED with a bounded reason (idempotent convergence when already failed). */
  failMediaOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    failedAt: string,
  ): Promise<MediaOperationRecord>;
  /** The operation lookup by its stable key (the recovery discriminator). */
  findMediaOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<MediaOperationRecord | null>;
}

/** Re-exported for the application layer's convenience (the seam types). */
export type { MediaJobStatus, MediaVerificationMode };
