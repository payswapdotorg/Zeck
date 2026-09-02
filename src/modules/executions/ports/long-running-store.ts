/**
 * Long-running execution store port (executions module outbound;
 * WORK-028).
 *
 * The durable state authority surface of the long-running extension:
 * checkpoints (write-once, digest-protected, per-execution sequence),
 * the execution lease (single row per execution, guarded owner/epoch
 * transitions), wake-ups (deterministic due-ordering, write-once
 * application) and the durable, recoverable operation state (the
 * WORK-024 standard). Every table lives in the executions schema and
 * references the EXISTING execution identity through composite keys —
 * there is no second execution identity anywhere in this port.
 *
 * Convergence contract (the crash-safety discipline):
 *   * `insertCheckpoint` converges on the physical per-execution
 *     sequence (same sequence + same digest = the same row; a same-
 *     sequence different-digest insert fails closed);
 *   * `findCheckpointByDigest` is the COMMITTED-EFFECT probe: a checkpoint
 *     row with the same content digest for the same execution PROVES the
 *     checkpoint side effect already committed (the crash window between
 *     the durable insert and the operation-stage write) — the recovery
 *     tail converges onto it instead of inserting a duplicate (the Work
 *     Order's "crash recovery must distinguish committed external
 *     effects from reversible internal work");
 *   * `acquireLease` fails CLOSED when a live lease is held (one
 *     authoritative owner per live mutable execution);
 *   * `renewLease`/`releaseLease` require the exact (ownerId, epoch)
 *     claim and fail closed typed on every mismatch (stale workers
 *     never mutate the lease);
 *   * wake-up application is write-once (applied/superseded are
 *     terminal, immutable);
 *   * `beginOperation` converges on the stable operation key (attempts
 *     bump while PENDING; terminal rows replay without a bump);
 *     `recordOperationStage` is writable only while PENDING
 *     (race-tolerant re-read convergence is the CALLER's recovery
 *     branch — the WORK-024/025 lesson: a concurrent terminal move is
 *     re-read, not retried).
 */

import type { CheckpointContents, CheckpointRecord } from "../domain/checkpoint";
import type { LeaseRecord, LeaseReleaseCause } from "../domain/lease";
import type { LongRunningOperationKind, LongRunningOperationRecord } from "../domain/longrunning";
import type { WakeUpRecord } from "../domain/wakeup";

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export interface InsertCheckpointInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  /** Must equal (existing checkpoint count) + 1 of the same execution. */
  readonly checkpointSequence: number;
  readonly contents: CheckpointContents;
  readonly contentDigest: string;
  readonly recordedBy: string;
  readonly now: string;
}

export type CheckpointInsertOutcome =
  | { readonly status: "appended"; readonly checkpoint: CheckpointRecord }
  | { readonly status: "converged"; readonly checkpoint: CheckpointRecord };

// ---------------------------------------------------------------------------
// Lease
// ---------------------------------------------------------------------------

export interface AcquireLeaseInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly ownerId: string;
  /** Lease time-to-live in milliseconds (> 0). */
  readonly ttlMs: number;
  readonly now: string;
}

export type LeaseAcquireOutcome =
  | { readonly status: "acquired"; readonly lease: LeaseRecord; readonly fresh: true }
  | { readonly status: "acquired"; readonly lease: LeaseRecord; readonly fresh: false }
  | { readonly status: "refused"; readonly lease: LeaseRecord; readonly reason: string };

export interface RenewLeaseInput {
  readonly applicationId: string;
  readonly executionId: string;
  readonly ownerId: string;
  readonly epoch: number;
  readonly ttlMs: number;
  readonly now: string;
}

export interface ReleaseLeaseInput {
  readonly applicationId: string;
  readonly executionId: string;
  readonly ownerId: string;
  readonly epoch: number;
  readonly cause: LeaseReleaseCause;
  readonly now: string;
}

export interface ForceReleaseLeaseInput {
  readonly applicationId: string;
  readonly executionId: string;
  /** Human-authority release cause (interruption/termination). */
  readonly cause: LeaseReleaseCause;
  readonly now: string;
}

// ---------------------------------------------------------------------------
// Wake-ups
// ---------------------------------------------------------------------------

export interface InsertWakeUpInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly wakeKey: string;
  readonly cause: string;
  readonly earliestWakeAt: string;
  readonly now: string;
}

export type WakeUpInsertOutcome =
  | { readonly status: "appended"; readonly wakeUp: WakeUpRecord }
  | { readonly status: "converged"; readonly wakeUp: WakeUpRecord };

export interface MarkWakeUpAppliedInput {
  readonly applicationId: string;
  readonly executionId: string;
  readonly wakeKey: string;
  readonly appliedOperationKey: string;
  readonly now: string;
}

export interface MarkWakeUpsSupersededInput {
  readonly applicationId: string;
  readonly executionId: string;
  readonly cause: string;
  readonly now: string;
}

// ---------------------------------------------------------------------------
// Durable operation state
// ---------------------------------------------------------------------------

export interface BeginOperationInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly operationKind: LongRunningOperationKind;
  readonly operationKey: string;
  readonly requestFingerprint: string;
  readonly now: string;
}

export type BeginOperationOutcome =
  | { readonly status: "begun"; readonly record: LongRunningOperationRecord }
  | { readonly status: "existing"; readonly record: LongRunningOperationRecord };

export interface RecordOperationStageInput {
  readonly applicationId: string;
  readonly operationKey: string;
  readonly stage: Readonly<Record<string, unknown>>;
  readonly now: string;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export interface LongRunningExecutionStore {
  // -- checkpoints (write-once, digest-protected, per-execution sequence) --

  insertCheckpoint(input: InsertCheckpointInput): Promise<CheckpointInsertOutcome>;
  getCheckpoint(
    applicationId: string,
    executionId: string,
    checkpointId: string,
  ): Promise<CheckpointRecord | null>;
  /** The committed-effect probe: same execution + same content digest. */
  findCheckpointByDigest(
    applicationId: string,
    executionId: string,
    contentDigest: string,
  ): Promise<CheckpointRecord | null>;
  latestCheckpoint(applicationId: string, executionId: string): Promise<CheckpointRecord | null>;
  listCheckpoints(applicationId: string, executionId: string): Promise<readonly CheckpointRecord[]>;

  // -- the execution lease (single live row, guarded owner/epoch moves) --

  acquireLease(input: AcquireLeaseInput): Promise<LeaseAcquireOutcome>;
  renewLease(input: RenewLeaseInput): Promise<LeaseRecord>;
  releaseLease(input: ReleaseLeaseInput): Promise<LeaseRecord | null>;
  forceReleaseLease(input: ForceReleaseLeaseInput): Promise<LeaseRecord | null>;
  getLease(applicationId: string, executionId: string): Promise<LeaseRecord | null>;

  // -- wake-ups (deterministic ordering, idempotent application) --

  insertWakeUp(input: InsertWakeUpInput): Promise<WakeUpInsertOutcome>;
  dueWakeUps(applicationId: string, at: string): Promise<readonly WakeUpRecord[]>;
  markWakeUpApplied(input: MarkWakeUpAppliedInput): Promise<WakeUpRecord>;
  markWakeUpsSuperseded(input: MarkWakeUpsSupersededInput): Promise<readonly WakeUpRecord[]>;
  getWakeUp(
    applicationId: string,
    executionId: string,
    wakeKey: string,
  ): Promise<WakeUpRecord | null>;
  listWakeUps(applicationId: string, executionId: string): Promise<readonly WakeUpRecord[]>;

  // -- the durable, recoverable operation state --

  beginOperation(input: BeginOperationInput): Promise<BeginOperationOutcome>;
  recordOperationStage(input: RecordOperationStageInput): Promise<LongRunningOperationRecord>;
  completeOperation(
    applicationId: string,
    operationKey: string,
    now: string,
  ): Promise<LongRunningOperationRecord>;
  failOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    now: string,
  ): Promise<LongRunningOperationRecord>;
  findOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<LongRunningOperationRecord | null>;
}
