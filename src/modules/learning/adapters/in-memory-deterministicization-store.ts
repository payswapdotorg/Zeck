/**
 * In-memory deterministicization store (learning module adapter;
 * WORK-021; unit-test infrastructure + reference semantics for the SQL
 * adapter of migration 0019).
 *
 * Faithful to the durable contract the SQL adapter implements:
 *  - candidate/evidence/rollout/decision inserts converge on their
 *    content-derived PRIMARY identities; a DIFFERENT record claiming
 *    the same physical slot (candidate id, or the settled
 *    (candidate, stage) evidence slot, or the (candidate, mode)
 *    rollout slot, or the decision id) fails closed
 *    `IDEMPOTENCY_KEY_REUSED`;
 *  - per-key promise-queue serialization stands in for the physical
 *    UNIQUE-index arbitration of concurrent duplicates;
 *  - candidate status moves are guarded single-step transitions
 *    (first writer wins; duplicates converge on the committed row;
 *    illegal moves fail closed INVALID_STATE_TRANSITION; terminal
 *    statuses are immutable);
 *  - the operations ledger implements the PENDING → COMPLETED|FAILED
 *    machine with monotonic attempts, bounded checkpoints, terminal
 *    immutability and no delete — the crash-safety discriminator.
 *
 * True concurrency/locking cannot be simulated here — the
 * real-PostgreSQL suites own those proofs (WORK-002..012 precedent).
 */

import { PlatformError } from "../../../shared/errors";
import type {
  DeterministicizationCandidate,
  DeterministicizationCandidateStatus,
  PromotionDecisionRecord,
  RolloutRecord,
  StageEvidenceRecord,
} from "../domain/deterministicization";
import { CANDIDATE_STATUS_TRANSITIONS } from "../domain/deterministicization";
import type { ExecutionOutcomeTelemetry } from "../domain/telemetry";
import type {
  CandidateInsertOutcome,
  CandidateTransitionOutcome,
  DecisionAppendOutcome,
  DeterministicizationOperationKind,
  DeterministicizationOperationRecord,
  DeterministicizationScope,
  DeterministicizationStore,
  OperationBeginInput,
  OperationBeginOutcome,
  RolloutConclusionInput,
  RolloutInsertOutcome,
  StageEvidenceInsertOutcome,
} from "../ports/deterministicization-store";

const CHECKPOINT_BOUND = 4096;
const FAILURE_REASON_BOUND = 512;

export class InMemoryDeterministicizationStore implements DeterministicizationStore {
  readonly candidates = new Map<string, DeterministicizationCandidate>();
  readonly stageEvidence = new Map<string, StageEvidenceRecord>();
  readonly rollouts = new Map<string, RolloutRecord>();
  readonly decisions = new Map<string, PromotionDecisionRecord>();
  readonly operations = new Map<string, DeterministicizationOperationRecord>();
  private readonly telemetry: readonly ExecutionOutcomeTelemetry[];
  /** Per-key serialization (stands in for the unique-index arbitration). */
  private readonly queues = new Map<string, Promise<unknown>>();
  private decisionSeq = 0;

  constructor(telemetry: readonly ExecutionOutcomeTelemetry[] = []) {
    this.telemetry = [...telemetry];
  }

  private queue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.queues.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private scopeKey(applicationId: string, local: string): string {
    return `${applicationId}|${local}`;
  }

  async listTelemetry(query: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly recordedFrom: string | null;
    readonly recordedTo: string;
  }): Promise<readonly ExecutionOutcomeTelemetry[]> {
    return this.telemetry.filter(
      (datum) =>
        datum.applicationId === query.applicationId &&
        datum.tenantId === query.tenantId &&
        (query.recordedFrom === null || datum.recordedAt >= query.recordedFrom) &&
        datum.recordedAt <= query.recordedTo,
    );
  }

  insertCandidate(candidate: DeterministicizationCandidate): Promise<CandidateInsertOutcome> {
    return this.queue(this.scopeKey(candidate.applicationId, candidate.candidateId), async () => {
      const existing = this.candidates.get(candidate.candidateId);
      if (existing !== undefined) {
        if (existing.applicationId !== candidate.applicationId) {
          throw new PlatformError({
            code: "TENANT_SCOPE_VIOLATION",
            message: "candidate identity is already claimed by another application scope",
          });
        }
        return { candidateId: existing.candidateId, replayed: true };
      }
      this.candidates.set(candidate.candidateId, candidate);
      return { candidateId: candidate.candidateId, replayed: false };
    });
  }

  async getCandidate(
    scope: DeterministicizationScope,
    candidateId: string,
  ): Promise<DeterministicizationCandidate | null> {
    const candidate = this.candidates.get(candidateId);
    return candidate !== undefined && candidate.applicationId === scope.applicationId
      ? candidate
      : null;
  }

  async listCandidates(
    scope: DeterministicizationScope,
  ): Promise<readonly DeterministicizationCandidate[]> {
    return [...this.candidates.values()]
      .filter((candidate) => candidate.applicationId === scope.applicationId)
      .sort((left, right) =>
        left.proposedAt < right.proposedAt
          ? -1
          : left.proposedAt > right.proposedAt
            ? 1
            : left.candidateId < right.candidateId
              ? -1
              : 1,
      );
  }

  transitionCandidateStatus(input: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly candidateId: string;
    readonly expectedStatus: DeterministicizationCandidateStatus | null;
    readonly toStatus: DeterministicizationCandidateStatus;
    readonly updatedAt: string;
  }): Promise<CandidateTransitionOutcome> {
    return this.queue(
      this.scopeKey(input.applicationId, `status:${input.candidateId}`),
      async () => {
        const existing = this.candidates.get(input.candidateId);
        if (
          existing === undefined ||
          existing.applicationId !== input.applicationId ||
          existing.tenantId !== input.tenantId
        ) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "candidate not found within the application scope",
            details: { candidateId: input.candidateId },
          });
        }
        if (existing.status === input.toStatus) {
          // Duplicates converge on the committed row.
          return { status: "converged", candidate: existing };
        }
        if (input.expectedStatus !== null && existing.status !== input.expectedStatus) {
          // A concurrent writer moved the row first: converge on the
          // committed row when the target already landed, else the
          // guarded move failed (first writer wins).
          if (CANDIDATE_STATUS_TRANSITIONS[existing.status].includes(input.toStatus)) {
            const updated = { ...existing, status: input.toStatus };
            this.candidates.set(updated.candidateId, updated);
            return { status: "applied", candidate: updated };
          }
          return { status: "converged", candidate: existing };
        }
        const allowed = CANDIDATE_STATUS_TRANSITIONS[existing.status];
        if (!allowed.includes(input.toStatus)) {
          throw new PlatformError({
            code: "INVALID_STATE_TRANSITION",
            message: `deterministicization candidate cannot move from '${existing.status}' to '${input.toStatus}' (single-step forward only)`,
            details: { candidateId: existing.candidateId, from: existing.status, to: input.toStatus },
          });
        }
        const updated = { ...existing, status: input.toStatus };
        this.candidates.set(updated.candidateId, updated);
        return { status: "applied", candidate: updated };
      },
    );
  }

  insertStageEvidence(evidence: StageEvidenceRecord): Promise<StageEvidenceInsertOutcome> {
    return this.queue(
      this.scopeKey(evidence.applicationId, `evidence:${evidence.candidateId}:${evidence.stageKind}`),
      async () => {
        const existing = this.stageEvidence.get(evidence.evidenceId);
        if (existing !== undefined) {
          return { evidenceId: existing.evidenceId, replayed: true };
        }
        // The (candidate, stage) slot is settled once: a different
        // record claiming it fails closed.
        const slotClaimed = [...this.stageEvidence.values()].some(
          (record) =>
            record.applicationId === evidence.applicationId &&
            record.candidateId === evidence.candidateId &&
            record.stageKind === evidence.stageKind,
        );
        if (slotClaimed) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message:
              "the validation stage is already settled for this candidate (a different basis is a different candidate, never a rewrite)",
            details: { candidateId: evidence.candidateId, stageKind: evidence.stageKind },
          });
        }
        this.stageEvidence.set(evidence.evidenceId, evidence);
        return { evidenceId: evidence.evidenceId, replayed: false };
      },
    );
  }

  async listStageEvidence(
    scope: DeterministicizationScope,
    candidateId: string,
  ): Promise<readonly StageEvidenceRecord[]> {
    return [...this.stageEvidence.values()]
      .filter(
        (record) =>
          record.applicationId === scope.applicationId && record.candidateId === candidateId,
      )
      .sort((left, right) =>
        left.recordedAt < right.recordedAt
          ? -1
          : left.recordedAt > right.recordedAt
            ? 1
            : left.evidenceId < right.evidenceId
              ? -1
              : 1,
      );
  }

  insertRollout(rollout: RolloutRecord): Promise<RolloutInsertOutcome> {
    return this.queue(
      this.scopeKey(rollout.applicationId, `rollout:${rollout.candidateId}:${rollout.mode}`),
      async () => {
        const existing = this.rollouts.get(rollout.rolloutId);
        if (existing !== undefined) {
          return { rolloutId: existing.rolloutId, replayed: true };
        }
        const slotClaimed = [...this.rollouts.values()].some(
          (record) =>
            record.applicationId === rollout.applicationId &&
            record.candidateId === rollout.candidateId &&
            record.mode === rollout.mode,
        );
        if (slotClaimed) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: `the ${rollout.mode} rollout phase is already recorded for this candidate`,
            details: { candidateId: rollout.candidateId, mode: rollout.mode },
          });
        }
        this.rollouts.set(rollout.rolloutId, rollout);
        return { rolloutId: rollout.rolloutId, replayed: false };
      },
    );
  }

  async getRollout(scope: DeterministicizationScope, rolloutId: string): Promise<RolloutRecord | null> {
    const rollout = this.rollouts.get(rolloutId);
    return rollout !== undefined && rollout.applicationId === scope.applicationId ? rollout : null;
  }

  async listRollouts(
    scope: DeterministicizationScope,
    candidateId: string,
  ): Promise<readonly RolloutRecord[]> {
    return [...this.rollouts.values()]
      .filter(
        (record) =>
          record.applicationId === scope.applicationId && record.candidateId === candidateId,
      )
      .sort((left, right) =>
        left.beganAt < right.beganAt
          ? -1
          : left.beganAt > right.beganAt
            ? 1
            : left.rolloutId < right.rolloutId
              ? -1
              : 1,
      );
  }

  concludeRollout(input: RolloutConclusionInput): Promise<RolloutRecord> {
    return this.queue(
      this.scopeKey(input.applicationId, `rollout:${input.rolloutId}:conclude`),
      async () => {
        const rollout = this.rollouts.get(input.rolloutId);
        if (
          rollout === undefined ||
          rollout.applicationId !== input.applicationId ||
          rollout.tenantId !== input.tenantId
        ) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "rollout not found within the application scope",
            details: { rolloutId: input.rolloutId },
          });
        }
        if (rollout.status === "concluded") {
          // First writer wins: a duplicate conclusion converges on the
          // committed row (the deltas are already durable).
          return rollout;
        }
        const concluded: RolloutRecord = {
          ...rollout,
          status: "concluded",
          population: input.population,
          matchedCount: input.matchedCount,
          costDeltaMicroUsd: input.costDeltaMicroUsd,
          qualityDelta: input.qualityDelta,
          latencyDeltaMs: input.latencyDeltaMs,
          evidenceRefs: [...input.evidenceRefs],
          concludedAt: input.concludedAt,
        };
        this.rollouts.set(concluded.rolloutId, concluded);
        return concluded;
      },
    );
  }

  appendDecision(decision: PromotionDecisionRecord): Promise<DecisionAppendOutcome> {
    return this.queue(this.scopeKey(decision.applicationId, decision.decisionId), async () => {
      const existing = this.decisions.get(decision.decisionId);
      if (existing !== undefined) {
        return { decisionId: existing.decisionId, replayed: true };
      }
      this.decisionSeq += 1;
      this.decisions.set(decision.decisionId, decision);
      return { decisionId: decision.decisionId, replayed: false };
    });
  }

  async listDecisions(
    scope: DeterministicizationScope,
    candidateId: string,
  ): Promise<readonly PromotionDecisionRecord[]> {
    return [...this.decisions.values()]
      .filter(
        (record) =>
          record.applicationId === scope.applicationId && record.candidateId === candidateId,
      )
      .sort((left, right) => (left.decidedAt < right.decidedAt ? -1 : 1));
  }

  // -- the durable, recoverable operation state --------------------------

  beginOperation(input: OperationBeginInput): Promise<OperationBeginOutcome> {
    return this.queue(this.scopeKey(input.applicationId, input.operationKey), async () => {
      const existing = this.operations.get(input.operationKey);
      if (existing !== undefined) {
        if (existing.applicationId !== input.applicationId) {
          throw new PlatformError({
            code: "TENANT_SCOPE_VIOLATION",
            message: "operation key is already claimed by another application scope",
          });
        }
        if (existing.status === "pending") {
          const bumped: DeterministicizationOperationRecord = {
            ...existing,
            attempts: existing.attempts + 1,
            updatedAt: input.createdAt,
          };
          this.operations.set(bumped.operationKey, bumped);
          return { status: "existing", record: bumped };
        }
        return { status: "existing", record: existing };
      }
      const record: DeterministicizationOperationRecord = {
        id: input.operationId,
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        candidateId: input.candidateId,
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
      this.operations.set(record.operationKey, record);
      return { status: "begun", record };
    });
  }

  async recordOperationCheckpoint(
    applicationId: string,
    operationKey: string,
    checkpoint: Record<string, unknown>,
    updatedAt: string,
  ): Promise<DeterministicizationOperationRecord> {
    const record = this.operations.get(operationKey);
    if (record === undefined || record.applicationId !== applicationId) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "operation not found within the application scope",
        details: { operationKey },
      });
    }
    if (record.status !== "pending") {
      // A terminal operation is frozen; the checkpoint write converges
      // on the committed record (race-tolerant duplicate).
      return record;
    }
    if (JSON.stringify(checkpoint).length > CHECKPOINT_BOUND) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `operation checkpoint exceeds the bounded size of ${CHECKPOINT_BOUND} chars`,
      });
    }
    const updated: DeterministicizationOperationRecord = {
      ...record,
      checkpoint: { ...checkpoint },
      updatedAt,
    };
    this.operations.set(operationKey, updated);
    return updated;
  }

  async completeOperation(
    applicationId: string,
    operationKey: string,
    completedAt: string,
  ): Promise<DeterministicizationOperationRecord> {
    const record = this.operations.get(operationKey);
    if (record === undefined || record.applicationId !== applicationId) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "operation not found within the application scope",
        details: { operationKey },
      });
    }
    if (record.status === "completed") {
      return record;
    }
    if (record.status === "failed") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: "a failed operation cannot be completed (terminal-immutable)",
      });
    }
    const updated: DeterministicizationOperationRecord = {
      ...record,
      status: "completed",
      completedAt,
      updatedAt: completedAt,
    };
    this.operations.set(operationKey, updated);
    return updated;
  }

  async failOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    failedAt: string,
  ): Promise<DeterministicizationOperationRecord> {
    const record = this.operations.get(operationKey);
    if (record === undefined || record.applicationId !== applicationId) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "operation not found within the application scope",
        details: { operationKey },
      });
    }
    if (record.status === "failed") {
      return record;
    }
    if (record.status === "completed") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: "a completed operation cannot be failed (terminal-immutable)",
      });
    }
    if (reason.length > FAILURE_REASON_BOUND) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `operation failure reason exceeds the bounded size of ${FAILURE_REASON_BOUND} chars`,
      });
    }
    const updated: DeterministicizationOperationRecord = {
      ...record,
      status: "failed",
      failureReason: reason,
      updatedAt: failedAt,
    };
    this.operations.set(operationKey, updated);
    return updated;
  }

  async findOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<DeterministicizationOperationRecord | null> {
    const record = this.operations.get(operationKey);
    return record !== undefined && record.applicationId === applicationId ? record : null;
  }
}

export type { DeterministicizationOperationKind };
