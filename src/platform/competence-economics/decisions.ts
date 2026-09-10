/**
 * Competence decision records (platform competence-economics plane;
 * WORK-056 / E1.1 — ADR-0020 "Required decision evidence").
 *
 * THE RECORD-CONSTRUCTION SEAM: every material promotion decision
 * (a gated advance of a competence record) and every bounded
 * rollback (a degradation-driven revert to the prior
 * representation) is recorded through the WORK-049 evidence
 * contract (`buildOptimizationDecision`) — APPEND-ONLY EVIDENCE,
 * built here as VALUES, appended by the CALLER through the EXISTING
 * WORK-049 store at its seam (no new durable surface — architecture
 * invariant 8):
 *
 *  - the PROMOTION record's candidate corpus is the
 *    evidence-honest pair: the INCUMBENT probabilistic representation
 *    (the work's current path, with its own explicit-basis claim)
 *    and the DETERMINISTIC REPLACEMENT (the promoted path, with its
 *    own claim) — the selected candidate is the replacement, the
 *    transformation basis is `representation-substitution`, and the
 *    bounded detail carries the promotion provenance (record
 *    identity, stage transition, replacement identity, gate
 *    evidence, equivalence verdict);
 *  - the ROLLBACK record's candidate corpus is the promoted
 *    representation and the REVERTED prior representation; the
 *    selected candidate is the reverted one, and the bounded detail
 *    carries the rollback provenance (rollback identity, reason,
 *    stage transition);
 *  - `recordedAt` is an explicit INPUT (determinism — the same
 *    inputs always produce the byte-identical record, so the
 *    content-addressed decisionId is stable and re-recording is a
 *    bounded no-op at the store's unique index);
 *  - the promotion/rollback identities ride the evidence (the
 *    content-addressed recordId / replacementId / rollbackId in the
 *    transformation-basis detail), so the durable record is
 *    replayable by deterministic audit (trajectory observation →
 *    mining → competence record → promotion verdict / rollback —
 *    EXECUTION-PROVENANCE);
 *  - foundation rejections are wrapped into this plane's closed
 *    `decision-invalid` error (fail closed — a record that fails
 *    its own total validation is never emitted).
 *
 * When the promotion verdict is `hold` or `reject`, NO record
 * exists: the typed outcome IS the evidence (a not-yet-promoted or
 * inadmissible promotion is never recorded as an optimization
 * decision — exactly the sibling planes' no-selection discipline).
 */

import type { OptimizationConstraint } from "../execution-ir/constraints";
import { validateConstraintSet } from "../execution-ir/constraints";
import type { CandidateRepresentation } from "../execution-ir/cost-model";
import type { OptimizationDecisionRecord } from "../execution-ir/decision-record";
import { buildOptimizationDecision } from "../execution-ir/decision-record";
import type { ExecutionIr, IrDigestPort } from "../execution-ir/ir";
import { boundedDetail, DETERMINISTIC_REPLACEMENT_CLASS, reject } from "./catalog";
import type { DeterministicReplacementCandidate } from "./equivalence";
import type { PromotionVerdict } from "./promotion";
import type { CompetenceRecord } from "./record";
import { competenceCandidateOf } from "./retrieval";
import type { RollbackRecord } from "./rollback";

// ---------------------------------------------------------------------------
// The shared scope and provenance discipline
// ---------------------------------------------------------------------------

/** The decision-record scope + the explicit recorded-at instant. */
export interface CompetenceDecisionScope {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId?: string;
  /** The explicit recorded-at instant — an INPUT, never ambient time. */
  readonly recordedAt: string;
}

/** The bounded provenance-detail ceiling (the foundation's own rule). */
const DETAIL_MAX = 500;

// ---------------------------------------------------------------------------
// The promotion decision-record builder
// ---------------------------------------------------------------------------

/** The promotion decision-record input. */
export interface PromotionDecisionRecordInput {
  /** The competence record BEFORE the promotion (the from-stage evidence). */
  readonly record: CompetenceRecord;
  /** The promotion verdict to record (must be a `promoted` verdict). */
  readonly verdict: PromotionVerdict;
  /** The deterministic replacement the promotion selected. */
  readonly replacement: DeterministicReplacementCandidate;
  /** The governed Execution IR the promotion belongs to. */
  readonly ir: ExecutionIr;
  /** The governing constraint set the promotion ran under. */
  readonly constraints: readonly OptimizationConstraint[];
  /** The decision-record scope + the explicit recorded-at instant. */
  readonly scope: CompetenceDecisionScope;
  readonly digest: IrDigestPort;
}

/**
 * Build the WORK-049 record of a gated promotion. Fail-closed BEFORE
 * the record exists:
 *  - the verdict must be `promoted` (hold/reject verdicts record
 *    nothing — their typed outcome is the evidence);
 *  - the advanced record must be present and coherent with the
 *    verdict's target stage;
 *  - the corpus must carry the incumbent and the replacement, with
 *    the selected replacement among them;
 *  - the foundation's own total validation (claims, selection, hard
 *    constraints, quality threshold) applies WHOLESALE.
 */
export function buildPromotionDecisionRecord(
  input: PromotionDecisionRecordInput,
): OptimizationDecisionRecord | null {
  if (input.verdict.kind !== "promoted" || input.verdict.advancedRecord === undefined) {
    // The no-promotion outcome: the typed verdict IS the evidence —
    // never a hold/reject recorded as an optimization decision.
    return null;
  }
  const constraints = validateConstraintSet(input.constraints);
  if (constraints.length === 0) {
    reject(
      "decision-invalid",
      "a promotion decision must record at least its governing constraints",
    );
  }
  if (input.verdict.targetStage !== input.verdict.advancedRecord.stage) {
    reject("decision-invalid", "the advanced record's stage contradicts the verdict target", {
      targetStage: input.verdict.targetStage ?? "missing",
      advancedStage: input.verdict.advancedRecord.stage,
    });
  }

  // The evidence-honest corpus: the incumbent representation (the
  // work's current path) and the deterministic replacement (the
  // promoted path).
  const corpus: CandidateRepresentation[] = [
    {
      candidateId: `${input.replacement.incumbent.representationClass}-incumbent`,
      representationClass: input.replacement.incumbent.representationClass,
      description: "the incumbent probabilistic representation",
      claim: input.replacement.incumbent.claim,
    },
    {
      candidateId: `deterministic-${input.replacement.replacementId.slice(0, 32)}`,
      representationClass: DETERMINISTIC_REPLACEMENT_CLASS,
      description: `deterministic replacement;binding=${input.replacement.binding.toolRepresentation}/${input.replacement.binding.ref};stage=${input.verdict.targetStage}`,
      claim: input.replacement.claim,
    },
  ];
  const selectedCandidateId = corpus[1]?.candidateId;
  if (selectedCandidateId === undefined) {
    reject("decision-invalid", "the promotion decision corpus is malformed");
  }

  const detail =
    `competence-economics;feature=promotion-decision;` +
    `record=${input.record.recordId};from=${input.record.stage};` +
    `to=${input.verdict.targetStage};advanced=${input.verdict.advancedRecord.recordId};` +
    `replacement=${input.replacement.replacementId};` +
    `equivalence=${input.verdict.equivalence.admissible ? "admissible" : "failed"};` +
    `floor=${input.verdict.facts.qualityFloor}`.slice(0, DETAIL_MAX);

  try {
    return buildOptimizationDecision(
      {
        applicationId: input.scope.applicationId,
        tenantId: input.scope.tenantId,
        ...(input.scope.executionId === undefined ? {} : { executionId: input.scope.executionId }),
        ir: input.ir,
        constraints,
        candidates: corpus,
        selectedCandidateId,
        qualityThreshold: input.verdict.facts.qualityFloor,
        transformationBasis: {
          code: "representation-substitution",
          detail: boundedDetail(detail),
        },
        recordedAt: input.scope.recordedAt,
      },
      input.digest,
    );
  } catch (error) {
    reject("decision-invalid", "the promotion decision record failed its total validation", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// The rollback decision-record builder
// ---------------------------------------------------------------------------

/** The rollback decision-record input. */
export interface RollbackDecisionRecordInput {
  /** The bounded rollback record to record (validated). */
  readonly rollback: RollbackRecord;
  /** The governed Execution IR the rollback belongs to. */
  readonly ir: ExecutionIr;
  /** The governing constraint set the promotion ran under. */
  readonly constraints: readonly OptimizationConstraint[];
  /**
   * The governing quality floor the rollback reverts under (the
   * promoted path failed it; the reverted path must still meet it).
   */
  readonly qualityThreshold: number;
  /** The decision-record scope + the explicit recorded-at instant. */
  readonly scope: CompetenceDecisionScope;
  readonly digest: IrDigestPort;
}

/**
 * Build the WORK-049 record of a bounded rollback: the corpus is
 * the promoted representation and the reverted prior representation
 * (both through the record's own candidate shape); the selected
 * candidate is the REVERTED one (the prior representation restored).
 * Fail-closed wholesale (the foundation's total validation).
 */
export function buildRollbackDecisionRecord(
  input: RollbackDecisionRecordInput,
): OptimizationDecisionRecord {
  const constraints = validateConstraintSet(input.constraints);
  if (constraints.length === 0) {
    reject(
      "decision-invalid",
      "a rollback decision must record at least its governing constraints",
    );
  }
  const promotedCandidate = competenceCandidateOf(input.rollback.promotedRecord);
  const revertedCandidate = competenceCandidateOf(input.rollback.revertedRecord);
  const corpus: CandidateRepresentation[] = [
    {
      ...promotedCandidate,
      description: `promoted competence;stage=${input.rollback.fromStage};reason=${input.rollback.reason}`,
    },
    {
      ...revertedCandidate,
      description: `reverted competence;stage=${input.rollback.toStage};the prior representation restored`,
    },
  ];
  const selectedCandidateId = revertedCandidate.candidateId;

  const detail =
    `competence-economics;feature=rollback-decision;` +
    `rollback=${input.rollback.rollbackId};record=${input.rollback.promotedRecord.recordId};` +
    `from=${input.rollback.fromStage};to=${input.rollback.toStage};` +
    `reason=${input.rollback.reason};` +
    `evidence=${input.rollback.degradedEvidence.length};` +
    `requestedBy=${input.rollback.requestedBy}`.slice(0, DETAIL_MAX);

  try {
    return buildOptimizationDecision(
      {
        applicationId: input.scope.applicationId,
        tenantId: input.scope.tenantId,
        ...(input.scope.executionId === undefined ? {} : { executionId: input.scope.executionId }),
        ir: input.ir,
        constraints,
        candidates: corpus,
        selectedCandidateId,
        qualityThreshold: input.qualityThreshold,
        transformationBasis: {
          code: "representation-substitution",
          detail: boundedDetail(detail),
        },
        recordedAt: input.scope.recordedAt,
      },
      input.digest,
    );
  } catch (error) {
    reject("decision-invalid", "the rollback decision record failed its total validation", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
