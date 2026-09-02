/**
 * Training store port (sandbox module outbound; WORK-030).
 *
 * The durable state surface of the training/batch/accelerator axis:
 * the workload journal (idempotent admission rows, immutable runtime
 * metadata, guarded allocation/run/finalize transitions), the
 * write-once CHECKPOINT ledger (content/lineage-addressable identity =
 * the content digest), the durable recoverable OPERATION state (the
 * WORK-024 crash-safety standard: PENDING -> COMPLETED | FAILED,
 * stable keys, monotonic attempts, stage checkpoints) and the run
 * LEASE (single-owner, monotonic epochs).
 *
 * Arbitration contract (the established durable-identity discipline):
 *
 *   - workloads converge on UNIQUE (application_id, workload_key):
 *     same key + same fingerprint replays the same durable outcome;
 *     same key + different fingerprint fails IDEMPOTENCY_KEY_REUSED
 *     (raised by the service, which owns the fingerprint); concurrent
 *     duplicates converge on the committed row;
 *   - `denied` rows are INSERT-ONLY terminal (journal-then-fail
 *     denials); `completed`/`cancelled` are PHYSICALLY immutable; the
 *     only legal updates are the guarded one-shot transitions of
 *     TRAINING_WORKLOAD_TRANSITIONS (allocating claim, run start,
 *     finalization, cancellation, the retry re-arm) plus the write-once
 *     ledger-sequence bindings, checkpoint-identity pointer, output
 *     adoption, and the verification-release binding (the ONLY writer
 *     of the release dimension — set once, never unset);
 *   - `runtime_metadata` is IMMUTABLE on every update path (write-once
 *     admitted snapshot — the executed work is always the admitted
 *     work);
 *   - checkpoints are APPEND-ONLY with UNIQUE (workload_id,
 *     checkpoint_sequence) and UNIQUE (application_id, content_digest)
 *     — the identity is the content digest; a same-digest duplicate
 *     converges (the emitted checkpoint is the same checkpoint);
 *   - operations converge on UNIQUE (application_id, operation_key);
 *   - one lease row per workload; epochs strictly increase on
 *     re-acquisition.
 */

import type {
  TrainingCheckpointContents,
  TrainingCheckpointRecord,
  TrainingOperationKind,
  TrainingOperationRecord,
  TrainingRunLeaseRecord,
  TrainingWorkloadRecord,
  TrainingWorkloadStatus,
} from "../domain/workload";

/** First-writer-wins arbitration outcome for unique-key inserts. */
export interface TrainingClaimOutcome<T> {
  readonly claimed: boolean;
  readonly record: T;
}

export interface InsertTrainingWorkloadInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly workloadKey: string;
  readonly requestFingerprint: string;
  readonly workloadKind: string;
  readonly status: TrainingWorkloadStatus;
  readonly runtimeMetadata: Readonly<Record<string, unknown>>;
  readonly denialClass: string | null;
  readonly denialCode: string | null;
  readonly denialReason: string | null;
  readonly budgetOperationId: string | null;
  readonly createdAt: string;
}

export interface TransitionTrainingWorkloadInput {
  readonly applicationId: string;
  readonly workloadKey: string;
  readonly to: TrainingWorkloadStatus;
  readonly now: string;
  /** The failure facts (only on transitions into `failed`). */
  readonly failure?: {
    readonly failureClass: string;
    readonly failureMessage: string;
  };
  /** The success facts (only on transitions into `completed`). */
  readonly completion?: {
    readonly outputArtifactDigest: string | null;
    readonly outputDescriptor: Readonly<Record<string, unknown>> | null;
    readonly usageMicroUsd: string | null;
    readonly completedLedgerSequence: number | null;
  };
}

export interface BindWorkloadLedgerSequenceInput {
  readonly applicationId: string;
  readonly workloadKey: string;
  readonly phase: "admitted" | "completed";
  readonly sequence: number;
}

export interface BindWorkloadAllocationInput {
  readonly applicationId: string;
  readonly workloadKey: string;
  readonly allocationId: string;
  readonly substrateId: string;
  readonly adapterRef: string;
  readonly allocatedAt: string;
}

export interface BindWorkloadResumePointInput {
  readonly applicationId: string;
  readonly workloadKey: string;
  readonly checkpointIdentity: string;
}

export interface BindWorkloadOutputInput {
  readonly applicationId: string;
  readonly workloadKey: string;
  readonly outputArtifactDigest: string;
  readonly outputDescriptor: Readonly<Record<string, unknown>>;
}

export interface BindWorkloadReleaseInput {
  readonly applicationId: string;
  readonly workloadKey: string;
  readonly verifiedReleaseAt: string;
  readonly verificationEvaluationId: string;
}

export interface BumpWorkloadAttemptsInput {
  readonly applicationId: string;
  readonly workloadKey: string;
}

export interface InsertTrainingCheckpointInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly workloadId: string;
  readonly workloadKey: string;
  readonly contents: TrainingCheckpointContents;
  readonly contentDigest: string;
  readonly createdAt: string;
}

export interface InsertTrainingOperationInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly workloadId: string | null;
  readonly operationKind: TrainingOperationKind;
  readonly operationKey: string;
  readonly requestFingerprint: string;
  readonly createdAt: string;
}

export interface CompleteTrainingOperationInput {
  readonly applicationId: string;
  readonly operationKey: string;
  readonly stage?: Readonly<Record<string, unknown>>;
  readonly failureReason?: string;
  readonly now: string;
}

export interface AcquireTrainingRunLeaseInput {
  readonly applicationId: string;
  readonly workloadId: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly now: string;
  readonly leaseDurationMs: number;
}

export interface ReleaseTrainingRunLeaseInput {
  readonly applicationId: string;
  readonly workloadId: string;
  readonly cause: string;
  readonly now: string;
}

export interface TrainingStore {
  // ---- workload journal ----
  insertWorkload(
    input: InsertTrainingWorkloadInput,
  ): Promise<TrainingClaimOutcome<TrainingWorkloadRecord>>;
  findWorkloadByKey(
    applicationId: string,
    workloadKey: string,
  ): Promise<TrainingWorkloadRecord | null>;
  findWorkload(applicationId: string, workloadId: string): Promise<TrainingWorkloadRecord | null>;
  listWorkloadsByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly TrainingWorkloadRecord[]>;
  /** The guarded one-shot status transition (first writer wins). */
  transitionWorkload(
    input: TransitionTrainingWorkloadInput,
  ): Promise<TrainingClaimOutcome<TrainingWorkloadRecord>>;
  /** Bind a ledger sequence onto a NON-terminal row (bookkeeping only). */
  bindWorkloadLedgerSequence(
    input: BindWorkloadLedgerSequenceInput,
  ): Promise<TrainingWorkloadRecord>;
  /** Bind the substrate allocation evidence (the allocation step). */
  bindWorkloadAllocation(input: BindWorkloadAllocationInput): Promise<TrainingWorkloadRecord>;
  /** Advance the resume pointer to a NEWER checkpoint identity (monotonic). */
  bindWorkloadResumePoint(input: BindWorkloadResumePointInput): Promise<TrainingWorkloadRecord>;
  /** Adopt the output evidence (write-once; terminal completion). */
  bindWorkloadOutput(input: BindWorkloadOutputInput): Promise<TrainingWorkloadRecord>;
  /** THE verification-release binding (write-once; the only writer of the
   *  release dimension — a completed-but-unverified workload stays null). */
  bindWorkloadRelease(input: BindWorkloadReleaseInput): Promise<TrainingWorkloadRecord>;
  /** Bump the attempt ledger (retry/resume re-arm). */
  bumpWorkloadAttempts(input: BumpWorkloadAttemptsInput): Promise<TrainingWorkloadRecord>;

  // ---- checkpoint ledger (append-only; identity = content digest) ----
  insertTrainingCheckpoint(
    input: InsertTrainingCheckpointInput,
  ): Promise<TrainingClaimOutcome<TrainingCheckpointRecord>>;
  findTrainingCheckpointByIdentity(
    applicationId: string,
    contentDigest: string,
  ): Promise<TrainingCheckpointRecord | null>;
  listTrainingCheckpointsByWorkload(
    applicationId: string,
    workloadKey: string,
  ): Promise<readonly TrainingCheckpointRecord[]>;

  // ---- durable recoverable operations ----
  insertTrainingOperation(
    input: InsertTrainingOperationInput,
  ): Promise<TrainingClaimOutcome<TrainingOperationRecord>>;
  findTrainingOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<TrainingOperationRecord | null>;
  /** Complete (or fail) a PENDING operation; terminal rows immutable. */
  completeTrainingOperation(
    input: CompleteTrainingOperationInput,
  ): Promise<TrainingOperationRecord>;

  // ---- run lease ----
  acquireTrainingRunLease(input: AcquireTrainingRunLeaseInput): Promise<TrainingRunLeaseRecord>;
  findTrainingRunLease(
    applicationId: string,
    workloadId: string,
  ): Promise<TrainingRunLeaseRecord | null>;
  renewTrainingRunLease(input: {
    readonly applicationId: string;
    readonly workloadId: string;
    readonly ownerId: string;
    readonly epoch: number;
    readonly now: string;
    readonly extensionMs: number;
  }): Promise<TrainingRunLeaseRecord>;
  releaseTrainingRunLease(input: ReleaseTrainingRunLeaseInput): Promise<TrainingRunLeaseRecord>;
}
