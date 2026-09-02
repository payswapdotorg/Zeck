/**
 * Deterministicization store port (learning module outbound; WORK-021
 * / DTR-001..004, migration 0019).
 *
 * The durable boundary of the deterministicization lifecycle, with the
 * WORK-024 crash-safety discipline (the architect's review bar):
 *
 *  - `listTelemetry` — the SAME population read semantics as the
 *    learning store (scope-bound, window-bounded). Discovery reads
 *    ONLY the immutable observation history;
 *  - candidate rows are IMMUTABLE PROPOSALS: `insertCandidate`
 *    converges on the content-derived candidateId (UNIQUE PK); there
 *    is NO rewrite path — a new basis is a NEW candidate. The
 *    lifecycle status moves ONLY through guarded single-step
 *    transitions (`transitionCandidateStatus` — expected-status
 *    arbitration, first writer wins, duplicates converge);
 *  - stage evidence is WRITE-ONCE per (application, candidate, stage):
 *    `insertStageEvidence` converges on the evidenceId (content
 *    identity) and fails closed when a different record claims the
 *    same stage slot (the stage is settled once — a different basis is
 *    a different candidate, never a rewrite);
 *  - rollouts: ONE record per (application, candidate, mode)
 *    (shadow/canary phases are single-epoch); `insertRollout` converges
 *    on the rolloutId; `concludeRollout` is the guarded
 *    observing → concluded move that writes the measurable deltas;
 *  - decisions are an APPEND-ONLY JOURNAL: `appendDecision` converges
 *    on the decisionId; journal order (decision_seq) serializes
 *    concurrent decisions; the latest promoted entry is the derived
 *    active pointer;
 *  - THE DURABLE, RECOVERABLE OPERATION STATE: every governed
 *    lifecycle operation owns ONE row in the operations ledger with
 *    the PENDING → COMPLETED|FAILED machine (the PR #46 correction
 *    pattern). `beginOperation` converges on the physical UNIQUE
 *    (application, operation_key) and bumps `attempts` on re-claim;
 *    `completed`/`failed` are terminal-immutable; a crash between
 *    claim and completion leaves the row PENDING and a retry MUST
 *    resume it with the STABLE operation key — the row is the
 *    discriminator between "fully completed" (replay the recorded
 *    outcome, no side effect) and "claimed but not completed"
 *    (resume);
 *  - every read is scope-filtered (application); tenant identity is
 *    carried on every row and never dropped.
 *
 * The port is provider-neutral: no SQL, no driver types. It exposes NO
 * mutation of anything outside the deterministicization lifecycle
 * tables — there is no path here that could write planner, execution,
 * policy, budget, capability or sandbox state.
 */

import type {
  DeterministicizationCandidate,
  DeterministicizationCandidateStatus,
  DifferentialPair,
  PromotionDecisionRecord,
  RolloutMode,
  RolloutRecord,
  StageEvidenceRecord,
  StageEvidenceStatus,
  ValidationRunObservation,
} from "../domain/deterministicization";
import type { ExecutionOutcomeTelemetry } from "../domain/telemetry";

export interface DeterministicizationScope {
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface CandidateInsertOutcome {
  readonly candidateId: string;
  /** True when an identical proposal was replayed. */
  readonly replayed: boolean;
}

export interface StageEvidenceInsertOutcome {
  readonly evidenceId: string;
  readonly replayed: boolean;
}

export interface RolloutInsertOutcome {
  readonly rolloutId: string;
  readonly replayed: boolean;
}

export interface DecisionAppendOutcome {
  readonly decisionId: string;
  readonly replayed: boolean;
}

export type CandidateTransitionOutcome =
  | { readonly status: "applied"; readonly candidate: DeterministicizationCandidate }
  | { readonly status: "converged"; readonly candidate: DeterministicizationCandidate };

/** The rollout-conclusion input (the measurable deltas of DTR-003). */
export interface RolloutConclusionInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly rolloutId: string;
  readonly population: number;
  readonly matchedCount: number;
  readonly costDeltaMicroUsd: string;
  readonly qualityDelta: number;
  readonly latencyDeltaMs: number;
  readonly evidenceRefs: readonly string[];
  readonly concludedAt: string;
}

/** The frozen operation-kind vocabulary of the lifecycle. */
export const DETERMINISTICIZATION_OPERATION_KINDS = [
  "candidate-registration",
  "stage-evidence",
  "shadow-rollout",
  "canary-rollout",
  "promotion",
  "rollback",
] as const;

export type DeterministicizationOperationKind =
  (typeof DETERMINISTICIZATION_OPERATION_KINDS)[number];

export function isDeterministicizationOperationKind(
  value: string,
): value is DeterministicizationOperationKind {
  return (DETERMINISTICIZATION_OPERATION_KINDS as readonly string[]).includes(value);
}

/** The durable, recoverable operation row (migration 0019 shape). */
export interface DeterministicizationOperationRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /**
   * Provenance reference WITHOUT physical FK: an operation row is
   * durably claimed BEFORE its candidate/evidence row exists — that
   * ordering is exactly the crash window this ledger closes.
   */
  readonly candidateId: string | null;
  readonly operationKind: DeterministicizationOperationKind;
  readonly operationKey: string;
  readonly status: "pending" | "completed" | "failed";
  readonly attempts: number;
  /** Bounded stage checkpoint (jsonb; the resume facts). */
  readonly checkpoint: Record<string, unknown> | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface OperationBeginInput {
  readonly operationId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly candidateId: string | null;
  readonly operationKind: DeterministicizationOperationKind;
  readonly operationKey: string;
  readonly createdAt: string;
}

export type OperationBeginOutcome =
  | { readonly status: "begun"; readonly record: DeterministicizationOperationRecord }
  | { readonly status: "existing"; readonly record: DeterministicizationOperationRecord };

/**
 * The stable operation-key scheme: `<kind>:<discriminator>` where the
 * discriminator is the content-derived identity of the logical
 * operation (the candidate/evidence/rollout/decision id). Bounded to
 * the migration's 200-char CHECK.
 */
export function deterministicizationOperationKey(
  kind: DeterministicizationOperationKind,
  discriminator: string,
): string {
  const key = `dtr-${kind}:${discriminator}`;
  if (key.length > 200) {
    return `dtr-${kind}:${discriminator.slice(0, 200 - kind.length - 5)}`;
  }
  return key;
}

export interface DeterministicizationStore {
  /** The immutable telemetry population read (scope + window). */
  listTelemetry(query: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly recordedFrom: string | null;
    readonly recordedTo: string;
  }): Promise<readonly ExecutionOutcomeTelemetry[]>;

  // -- the candidate lifecycle -------------------------------------------

  insertCandidate(candidate: DeterministicizationCandidate): Promise<CandidateInsertOutcome>;
  getCandidate(
    scope: DeterministicizationScope,
    candidateId: string,
  ): Promise<DeterministicizationCandidate | null>;
  listCandidates(
    scope: DeterministicizationScope,
  ): Promise<readonly DeterministicizationCandidate[]>;
  /**
   * The guarded status move (single-step forward only; duplicates
   * converge on the committed row). A status regression or illegal
   * move fails closed INVALID_STATE_TRANSITION.
   */
  transitionCandidateStatus(input: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly candidateId: string;
    readonly expectedStatus: DeterministicizationCandidateStatus | null;
    readonly toStatus: DeterministicizationCandidateStatus;
    readonly updatedAt: string;
  }): Promise<CandidateTransitionOutcome>;

  // -- the validation-stage evidence (write-once per stage) -------------

  insertStageEvidence(evidence: StageEvidenceRecord): Promise<StageEvidenceInsertOutcome>;
  listStageEvidence(
    scope: DeterministicizationScope,
    candidateId: string,
  ): Promise<readonly StageEvidenceRecord[]>;

  // -- the rollout phases (shadow/canary, one per mode) ------------------

  insertRollout(rollout: RolloutRecord): Promise<RolloutInsertOutcome>;
  getRollout(scope: DeterministicizationScope, rolloutId: string): Promise<RolloutRecord | null>;
  listRollouts(
    scope: DeterministicizationScope,
    candidateId: string,
  ): Promise<readonly RolloutRecord[]>;
  /** The guarded observing → concluded move (writes the deltas). */
  concludeRollout(input: RolloutConclusionInput): Promise<RolloutRecord>;

  // -- the decision journal (append-only) --------------------------------

  appendDecision(decision: PromotionDecisionRecord): Promise<DecisionAppendOutcome>;
  listDecisions(
    scope: DeterministicizationScope,
    candidateId: string,
  ): Promise<readonly PromotionDecisionRecord[]>;

  // -- the durable, recoverable operation state (crash safety) -----------

  beginOperation(input: OperationBeginInput): Promise<OperationBeginOutcome>;
  recordOperationCheckpoint(
    applicationId: string,
    operationKey: string,
    checkpoint: Record<string, unknown>,
    updatedAt: string,
  ): Promise<DeterministicizationOperationRecord>;
  completeOperation(
    applicationId: string,
    operationKey: string,
    completedAt: string,
  ): Promise<DeterministicizationOperationRecord>;
  failOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    failedAt: string,
  ): Promise<DeterministicizationOperationRecord>;
  findOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<DeterministicizationOperationRecord | null>;
}

/** Re-exported domain types used by port consumers (type-only). */
export type {
  DeterministicizationCandidate,
  DeterministicizationCandidateStatus,
  DifferentialPair,
  PromotionDecisionRecord,
  RolloutMode,
  RolloutRecord,
  StageEvidenceRecord,
  StageEvidenceStatus,
  ValidationRunObservation,
};
