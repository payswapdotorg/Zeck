/**
 * In-memory training store (sandbox module; WORK-030).
 *
 * The unit-tier implementation of the `TrainingStore` port — the
 * behavioral twin of the SQL adapter over migration 0025: same
 * arbitration contract (unique-key convergence, guarded transitions,
 * write-once bindings, append-only checkpoints, monotonic lease
 * epochs), no persistence. The crash-injection proofs wrap this store
 * in a process-death Proxy exactly like the media/computer-use
 * precedents.
 */

import { PlatformError } from "../../../shared/errors";
import type {
  TrainingCheckpointRecord,
  TrainingOperationRecord,
  TrainingRunLeaseRecord,
  TrainingWorkloadRecord,
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
  record: TrainingWorkloadRecord;
}

export class InMemoryTrainingStore implements TrainingStore {
  private readonly workloads = new Map<string, WorkloadRow>(); // key: `${applicationId}:${workloadKey}`
  private readonly workloadIds = new Map<string, string>(); // key: `${applicationId}:${workloadId}`
  private readonly checkpoints = new Map<string, TrainingCheckpointRecord>(); // key: `${applicationId}:${digest}`
  private readonly checkpointSeq = new Map<string, TrainingCheckpointRecord>(); // key: `${applicationId}:${workloadId}:${seq}`
  private readonly operations = new Map<string, TrainingOperationRecord>(); // key: `${applicationId}:${operationKey}`
  private readonly leases = new Map<string, TrainingRunLeaseRecord>(); // key: `${applicationId}:${workloadId}`

  private rowOf(applicationId: string, workloadKey: string): WorkloadRow | undefined {
    return this.workloads.get(`${applicationId}:${workloadKey}`);
  }

  private requireRow(applicationId: string, workloadKey: string, what: string): WorkloadRow {
    const row = this.rowOf(applicationId, workloadKey);
    if (row === undefined) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: `training workload ${what} requires an existing workload row`,
        details: { applicationId, workloadKey },
      });
    }
    return row;
  }

  private put(row: WorkloadRow): void {
    this.workloads.set(`${row.record.applicationId}:${row.record.workloadKey}`, row);
    this.workloadIds.set(`${row.record.applicationId}:${row.record.id}`, row.record.workloadKey);
  }

  async insertWorkload(
    input: InsertTrainingWorkloadInput,
  ): Promise<TrainingClaimOutcome<TrainingWorkloadRecord>> {
    const existing = this.rowOf(input.applicationId, input.workloadKey);
    if (existing !== undefined) {
      return { claimed: false, record: existing.record };
    }
    const record: TrainingWorkloadRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      executionId: input.executionId,
      workloadKey: input.workloadKey,
      requestFingerprint: input.requestFingerprint,
      workloadKind: input.workloadKind as TrainingWorkloadRecord["workloadKind"],
      status: input.status,
      runtimeMetadata:
        input.runtimeMetadata as unknown as TrainingWorkloadRecord["runtimeMetadata"],
      denialClass: (input.denialClass ?? null) as TrainingWorkloadRecord["denialClass"],
      denialCode: (input.denialCode ?? null) as TrainingWorkloadRecord["denialCode"],
      denialReason: input.denialReason,
      attempts: 1,
      failureClass: null,
      failureMessage: null,
      outputArtifactDigest: null,
      outputDescriptor: null,
      usageMicroUsd: null,
      budgetOperationId: input.budgetOperationId,
      allocationId: null,
      substrateId: null,
      adapterRef: null,
      lastCheckpointIdentity: null,
      verifiedReleaseAt: null,
      verificationEvaluationId: null,
      ledgerAdmittedSequence: null,
      ledgerCompletedSequence: null,
      createdAt: input.createdAt,
      allocatedAt: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
    };
    this.put({ record });
    return { claimed: true, record };
  }

  async findWorkloadByKey(
    applicationId: string,
    workloadKey: string,
  ): Promise<TrainingWorkloadRecord | null> {
    return this.rowOf(applicationId, workloadKey)?.record ?? null;
  }

  async findWorkload(
    applicationId: string,
    workloadId: string,
  ): Promise<TrainingWorkloadRecord | null> {
    const key = this.workloadIds.get(`${applicationId}:${workloadId}`);
    return key === undefined ? null : (this.rowOf(applicationId, key)?.record ?? null);
  }

  async listWorkloadsByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly TrainingWorkloadRecord[]> {
    const out: TrainingWorkloadRecord[] = [];
    for (const row of this.workloads.values()) {
      if (row.record.applicationId === applicationId && row.record.executionId === executionId) {
        out.push(row.record);
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async transitionWorkload(
    input: TransitionTrainingWorkloadInput,
  ): Promise<TrainingClaimOutcome<TrainingWorkloadRecord>> {
    const row = this.requireRow(input.applicationId, input.workloadKey, "transition");
    const from = row.record.status;
    if (!canTransitionTrainingWorkload(from, input.to)) {
      return { claimed: false, record: row.record };
    }
    const record: TrainingWorkloadRecord = {
      ...row.record,
      status: input.to,
      ...(input.to === "failed" && input.failure
        ? {
            failureClass: input.failure.failureClass as TrainingWorkloadRecord["failureClass"],
            failureMessage: input.failure.failureMessage,
          }
        : {}),
      ...(input.to === "completed" && input.completion
        ? {
            outputArtifactDigest: input.completion.outputArtifactDigest,
            outputDescriptor: input.completion.outputDescriptor,
            usageMicroUsd: input.completion.usageMicroUsd,
            ledgerCompletedSequence: input.completion.completedLedgerSequence,
            completedAt: input.now,
          }
        : {}),
      ...(input.to === "cancelled" ? { cancelledAt: input.now } : {}),
      ...(input.to === "allocating"
        ? { startedAt: null, failureClass: null, failureMessage: null }
        : {}),
      ...(input.to === "running" ? { startedAt: input.now } : {}),
    };
    row.record = record;
    return { claimed: true, record };
  }

  async bindWorkloadLedgerSequence(
    input: BindWorkloadLedgerSequenceInput,
  ): Promise<TrainingWorkloadRecord> {
    const row = this.requireRow(input.applicationId, input.workloadKey, "ledger binding");
    if (row.record.status === "denied") {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "denied training workloads are insert-only (no ledger bindings)",
      });
    }
    const record: TrainingWorkloadRecord = {
      ...row.record,
      ...(input.phase === "admitted"
        ? { ledgerAdmittedSequence: input.sequence }
        : { ledgerCompletedSequence: input.sequence }),
    };
    row.record = record;
    return record;
  }

  async bindWorkloadAllocation(
    input: BindWorkloadAllocationInput,
  ): Promise<TrainingWorkloadRecord> {
    const row = this.requireRow(input.applicationId, input.workloadKey, "allocation binding");
    if (row.record.allocationId !== null && row.record.allocationId !== input.allocationId) {
      // Converge on the FIRST allocation (the stable key's owner).
      return row.record;
    }
    const record: TrainingWorkloadRecord = {
      ...row.record,
      allocationId: input.allocationId,
      substrateId: input.substrateId,
      adapterRef: input.adapterRef,
      allocatedAt: input.allocatedAt,
    };
    row.record = record;
    return record;
  }

  async bindWorkloadResumePoint(
    input: BindWorkloadResumePointInput,
  ): Promise<TrainingWorkloadRecord> {
    const row = this.requireRow(input.applicationId, input.workloadKey, "resume-point binding");
    if (row.record.lastCheckpointIdentity !== null) {
      // The pointer only ADVANCES: a same-or-older identity is a replay.
      const existing = await this.findTrainingCheckpointByIdentity(
        input.applicationId,
        row.record.lastCheckpointIdentity,
      );
      const next = await this.findTrainingCheckpointByIdentity(
        input.applicationId,
        input.checkpointIdentity,
      );
      if (
        existing !== null &&
        next !== null &&
        next.checkpointSequence <= existing.checkpointSequence
      ) {
        return row.record;
      }
    }
    const record: TrainingWorkloadRecord = {
      ...row.record,
      lastCheckpointIdentity: input.checkpointIdentity,
    };
    row.record = record;
    return record;
  }

  async bindWorkloadOutput(input: BindWorkloadOutputInput): Promise<TrainingWorkloadRecord> {
    const row = this.requireRow(input.applicationId, input.workloadKey, "output binding");
    if (row.record.outputArtifactDigest !== null) {
      return row.record; // write-once output adoption
    }
    const record: TrainingWorkloadRecord = {
      ...row.record,
      outputArtifactDigest: input.outputArtifactDigest,
      outputDescriptor: input.outputDescriptor,
    };
    row.record = record;
    return record;
  }

  async bindWorkloadRelease(input: BindWorkloadReleaseInput): Promise<TrainingWorkloadRecord> {
    const row = this.requireRow(input.applicationId, input.workloadKey, "release binding");
    if (row.record.verifiedReleaseAt !== null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "the verification-release binding is write-once (it is never re-bound)",
        details: { workloadId: row.record.id },
      });
    }
    const record: TrainingWorkloadRecord = {
      ...row.record,
      verifiedReleaseAt: input.verifiedReleaseAt,
      verificationEvaluationId: input.verificationEvaluationId,
    };
    row.record = record;
    return record;
  }

  async bumpWorkloadAttempts(input: BumpWorkloadAttemptsInput): Promise<TrainingWorkloadRecord> {
    const row = this.requireRow(input.applicationId, input.workloadKey, "attempt bump");
    const record: TrainingWorkloadRecord = {
      ...row.record,
      attempts: row.record.attempts + 1,
    };
    row.record = record;
    return record;
  }

  async insertTrainingCheckpoint(
    input: InsertTrainingCheckpointInput,
  ): Promise<TrainingClaimOutcome<TrainingCheckpointRecord>> {
    const identityKey = `${input.applicationId}:${input.contentDigest}`;
    const existing = this.checkpoints.get(identityKey);
    if (existing !== undefined) {
      return { claimed: false, record: existing };
    }
    const seqKey = `${input.applicationId}:${input.workloadId}:${input.contents.checkpointSequence}`;
    const seqExisting = this.checkpointSeq.get(seqKey);
    if (seqExisting !== undefined) {
      return { claimed: false, record: seqExisting };
    }
    const record: TrainingCheckpointRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      executionId: input.executionId,
      workloadId: input.workloadId,
      workloadKey: input.workloadKey,
      checkpointSequence: input.contents.checkpointSequence,
      contents: input.contents,
      contentDigest: input.contentDigest,
      createdAt: input.createdAt,
    };
    this.checkpoints.set(identityKey, record);
    this.checkpointSeq.set(seqKey, record);
    return { claimed: true, record };
  }

  async findTrainingCheckpointByIdentity(
    applicationId: string,
    contentDigest: string,
  ): Promise<TrainingCheckpointRecord | null> {
    return this.checkpoints.get(`${applicationId}:${contentDigest}`) ?? null;
  }

  async listTrainingCheckpointsByWorkload(
    applicationId: string,
    workloadKey: string,
  ): Promise<readonly TrainingCheckpointRecord[]> {
    const out: TrainingCheckpointRecord[] = [];
    for (const record of this.checkpoints.values()) {
      if (record.applicationId === applicationId && record.workloadKey === workloadKey) {
        out.push(record);
      }
    }
    return out.sort((a, b) => a.checkpointSequence - b.checkpointSequence);
  }

  async insertTrainingOperation(
    input: InsertTrainingOperationInput,
  ): Promise<TrainingClaimOutcome<TrainingOperationRecord>> {
    const existing = this.operations.get(`${input.applicationId}:${input.operationKey}`);
    if (existing !== undefined) {
      return {
        claimed: false,
        record: { ...existing, attempts: existing.attempts + 1, updatedAt: input.createdAt },
      };
    }
    const record: TrainingOperationRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      executionId: input.executionId,
      workloadId: input.workloadId,
      operationKind: input.operationKind,
      operationKey: input.operationKey,
      requestFingerprint: input.requestFingerprint,
      status: "pending",
      attempts: 1,
      stage: null,
      failureReason: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      completedAt: null,
    };
    this.operations.set(`${input.applicationId}:${input.operationKey}`, record);
    return { claimed: true, record };
  }

  async findTrainingOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<TrainingOperationRecord | null> {
    return this.operations.get(`${applicationId}:${operationKey}`) ?? null;
  }

  async completeTrainingOperation(
    input: CompleteTrainingOperationInput,
  ): Promise<TrainingOperationRecord> {
    const record = this.operations.get(`${input.applicationId}:${input.operationKey}`);
    if (record === undefined) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "training operation completion requires an existing operation row",
        details: { operationKey: input.operationKey },
      });
    }
    if (record.status !== "pending") {
      return record; // terminal rows are immutable — replay
    }
    const updated: TrainingOperationRecord = {
      ...record,
      status: input.failureReason === undefined ? "completed" : "failed",
      ...(input.stage === undefined ? {} : { stage: input.stage }),
      ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
      updatedAt: input.now,
      completedAt: input.now,
    };
    this.operations.set(`${input.applicationId}:${input.operationKey}`, updated);
    return updated;
  }

  async acquireTrainingRunLease(
    input: AcquireTrainingRunLeaseInput,
  ): Promise<TrainingRunLeaseRecord> {
    const key = `${input.applicationId}:${input.workloadId}`;
    const existing = this.leases.get(key);
    if (existing !== undefined && existing.releasedAt === null && existing.expiresAt > input.now) {
      if (existing.ownerId === input.ownerId) {
        return existing; // same owner, same epoch — the live lease stands
      }
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `the run lease is live and owned by ${existing.ownerId}; lease conflicts fail closed`,
        details: { workloadId: input.workloadId, ownerId: existing.ownerId },
      });
    }
    const epoch = (existing?.epoch ?? 0) + 1;
    const record: TrainingRunLeaseRecord = {
      workloadId: input.workloadId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      epoch,
      acquiredAt: input.now,
      expiresAt: new Date(new Date(input.now).getTime() + input.leaseDurationMs).toISOString(),
      lastHeartbeatAt: input.now,
      heartbeatCount: 1,
      releasedAt: null,
      releaseCause: null,
    };
    this.leases.set(key, record);
    return record;
  }

  async findTrainingRunLease(
    applicationId: string,
    workloadId: string,
  ): Promise<TrainingRunLeaseRecord | null> {
    return this.leases.get(`${applicationId}:${workloadId}`) ?? null;
  }

  async renewTrainingRunLease(input: {
    readonly applicationId: string;
    readonly workloadId: string;
    readonly ownerId: string;
    readonly epoch: number;
    readonly now: string;
    readonly extensionMs: number;
  }): Promise<TrainingRunLeaseRecord> {
    const key = `${input.applicationId}:${input.workloadId}`;
    const existing = this.leases.get(key);
    if (existing === undefined || existing.releasedAt !== null) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: "run lease renewal requires a live lease",
        details: { workloadId: input.workloadId },
      });
    }
    if (existing.epoch !== input.epoch || existing.ownerId !== input.ownerId) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: "run lease renewal requires the owning (owner, epoch) pair",
        details: { workloadId: input.workloadId },
      });
    }
    const extended = new Date(new Date(input.now).getTime() + input.extensionMs).toISOString();
    const record: TrainingRunLeaseRecord = {
      ...existing,
      expiresAt: extended > existing.expiresAt ? extended : existing.expiresAt,
      lastHeartbeatAt: input.now,
      heartbeatCount: existing.heartbeatCount + 1,
    };
    this.leases.set(key, record);
    return record;
  }

  async releaseTrainingRunLease(
    input: ReleaseTrainingRunLeaseInput,
  ): Promise<TrainingRunLeaseRecord> {
    const key = `${input.applicationId}:${input.workloadId}`;
    const existing = this.leases.get(key);
    if (existing === undefined) {
      // A lease-less workload (denied/pre-allocation) — the release is a no-op.
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "run lease release requires an existing lease row",
        details: { workloadId: input.workloadId },
      });
    }
    if (existing.releasedAt !== null) {
      return existing; // one-way release: replay
    }
    const record: TrainingRunLeaseRecord = {
      ...existing,
      releasedAt: input.now,
      releaseCause: input.cause,
    };
    this.leases.set(key, record);
    return record;
  }
}
