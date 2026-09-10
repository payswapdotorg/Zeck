/**
 * Recovery decision records (platform failure-recovery plane; WORK-055 /
 * E1.1 — ADR-0020 "Required decision evidence").
 *
 * THE RECORD-CONSTRUCTION SEAM: every material recovery decision
 * (the selected retry / re-route / escalate-fresh strategy over an
 * attributed failure) is recorded through the WORK-049 evidence
 * contract (`buildOptimizationDecision`) — APPEND-ONLY EVIDENCE,
 * built here as VALUES, appended by the CALLER through the EXISTING
 * WORK-049 store at its seam (no new durable surface — architecture
 * invariant 8):
 *
 *  - the record's candidate corpus is the evidence-honest subset:
 *    every strategy candidate that reached the shared admissibility
 *    pass (admissible OR below-assurance — recorded with its invalid
 *    evaluation, the auditable "why the cheaper path did not win"
 *    evidence), plus the structurally inadmissible strategy verdicts
 *    that CARRY an evaluation (the retry/escalation discipline
 *    rejections — their typed reason codes ride the transformation
 *    basis detail; strategy verdicts with NO claim at all
 *    (no-alternative-route / no-substrate-selection) are excluded —
 *    their typed outcomes live in the selection result, exactly the
 *    sibling planes' discipline for hard-violating candidates);
 *  - the transformation basis comes from the closed WORK-049
 *    vocabulary, derived from the selected strategy: `identity` for
 *    retry (the same representation re-executed), and
 *    `representation-substitution` for re-route and escalate-fresh
 *    (the work's execution path is substituted), with a bounded
 *    detail carrying the failure-recovery provenance (attribution
 *    identity + class + signal, strategy, candidate, governing
 *    floor);
 *  - `recordedAt` is an explicit INPUT (determinism — the same
 *    inputs always produce the byte-identical record, so the
 *    content-addressed decisionId is stable and re-recording is a
 *    bounded no-op at the store's unique index);
 *  - the ATTRIBUTION rides the evidence: the attribution identity
 *    (content-addressed), class and signal are carried in the
 *    transformation-basis detail and the candidates' basis sources,
 *    so the durable record is replayable by deterministic audit
 *    (failure observation → attribution → recovery decision —
 *    EXECUTION-PROVENANCE);
 *  - foundation rejections are wrapped into this plane's closed
 *    `decision-invalid` error (fail closed — a record that fails its
 *    own total validation is never emitted).
 *
 * When the selection is `fail-closed` (the zero-recovery outcome),
 * NO record exists: the typed outcome IS the evidence (a
 * below-justification recovery is never recorded as an optimization
 * decision — exactly the sibling planes' no-selection discipline).
 */

import type { OptimizationConstraint } from "../execution-ir/constraints";
import { validateConstraintSet } from "../execution-ir/constraints";
import type { CandidateRepresentation, CostClaim } from "../execution-ir/cost-model";
import type { OptimizationDecisionRecord } from "../execution-ir/decision-record";
import { buildOptimizationDecision } from "../execution-ir/decision-record";
import type { ExecutionIr, IrDigestPort } from "../execution-ir/ir";
import type { FailureAttribution } from "./attribution";
import { boundedDetail, reject } from "./catalog";
import type { RecoverySelection, StrategyVerdict } from "./strategy";

// ---------------------------------------------------------------------------
// The shared scope and provenance discipline
// ---------------------------------------------------------------------------

/** The decision-record scope + the explicit recorded-at instant. */
export interface RecoveryDecisionScope {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId?: string;
  /** The explicit recorded-at instant — an INPUT, never ambient time. */
  readonly recordedAt: string;
}

/** The bounded provenance-detail ceiling (the foundation's own rule). */
const DETAIL_MAX = 500;

// ---------------------------------------------------------------------------
// The recovery decision-record builder
// ---------------------------------------------------------------------------

/** The recovery decision-record input. */
export interface RecoveryDecisionRecordInput {
  /** The attributed failure the recovery decided for (validated). */
  readonly attribution: FailureAttribution;
  /** The selection result to record (must carry a RECOVER outcome). */
  readonly selection: RecoverySelection;
  /**
   * The ORIGINAL strategy claims the selection ran on (the caller's
   * explicit-basis values, keyed by candidateId — the record's claim
   * corpus must correspond exactly to the selection's evaluated
   * verdicts).
   */
  readonly claims: ReadonlyMap<string, CostClaim>;
  /** The governed Execution IR the recovery belongs to. */
  readonly ir: ExecutionIr;
  /** The governing constraint set the selection ran under. */
  readonly constraints: readonly OptimizationConstraint[];
  /** The decision-record scope + the explicit recorded-at instant. */
  readonly scope: RecoveryDecisionScope;
  readonly digest: IrDigestPort;
}

/**
 * Assemble the evidence-honest candidate corpus from the selection's
 * verdicts and the original claims: every verdict that carries an
 * evaluation (a claim exists) becomes one candidate representation of
 * the `sufficient-model` class (the recovery strategy routes HOW the
 * work recovers — it does not change the work's representation
 * class), carrying the ORIGINAL claim the selection ran on.
 * Verdicts without claims are structurally inadmissible (typed
 * outcomes in the selection result — excluded, the sibling planes'
 * discipline).
 */
function buildCorpus(
  verdicts: readonly StrategyVerdict[],
  claims: ReadonlyMap<string, CostClaim>,
): CandidateRepresentation[] {
  const corpus: CandidateRepresentation[] = [];
  for (const verdict of verdicts) {
    if (verdict.evaluation === undefined) {
      // Structurally inadmissible (no claim exists): the typed
      // outcome lives in the selection result — never a phantom
      // candidate.
      continue;
    }
    const claim = claims.get(verdict.candidateId);
    if (claim === undefined) {
      reject(
        "decision-invalid",
        "an evaluated strategy verdict references a claim the record input does not carry",
        { candidateId: verdict.candidateId },
      );
    }
    corpus.push({
      candidateId: verdict.candidateId,
      representationClass: "sufficient-model",
      description: `the ${verdict.strategy} recovery path`,
      claim,
    });
  }
  return corpus;
}

/**
 * Build the WORK-049 record of a recovery-strategy selection. The
 * basis is `identity` when the selected strategy is RETRY (the same
 * representation re-executed), `representation-substitution` for
 * re-route and escalate-fresh (the execution path is substituted).
 *
 * Fail-closed BEFORE the record exists:
 *  - the selection outcome must be `recover` (a fail-closed selection
 *    is not an optimization decision — its typed outcome is the
 *    evidence);
 *  - the corpus must be non-empty and carry the selected candidate;
 *  - the foundation's own total validation (claims, selection,
 *    hard constraints, quality threshold) applies WHOLESALE.
 */
export function buildRecoveryDecisionRecord(
  input: RecoveryDecisionRecordInput,
): OptimizationDecisionRecord | null {
  if (input.selection.kind !== "recover" || input.selection.selected === null) {
    // The zero-recovery outcome: the typed result IS the evidence —
    // never a below-justification recovery recorded as a decision.
    return null;
  }
  const constraints = validateConstraintSet(input.constraints);
  if (constraints.length === 0) {
    reject(
      "decision-invalid",
      "a recovery decision must record at least its governing constraints",
    );
  }
  const selected = input.selection.selected;
  const corpus = buildCorpus(input.selection.verdicts, input.claims);
  if (corpus.length === 0) {
    reject("decision-invalid", "a recovery decision must record at least one strategy candidate");
  }
  if (!corpus.some((candidate) => candidate.candidateId === selected.candidateId)) {
    reject("decision-invalid", "the selected strategy candidate is absent from the record corpus", {
      selectedCandidateId: selected.candidateId,
    });
  }
  const attribution = input.attribution;
  const detail =
    `failure-recovery;feature=strategy-selection;` +
    `attribution=${attribution.attributionId};class=${attribution.failureClass};` +
    `signal=${attribution.observation.signal};strategy=${selected.strategy};` +
    `candidate=${selected.candidateId};floor=${input.selection.facts.qualityFloor};` +
    `verdicts=${input.selection.verdicts.length}`.slice(0, DETAIL_MAX);

  try {
    return buildOptimizationDecision(
      {
        applicationId: input.scope.applicationId,
        tenantId: input.scope.tenantId,
        ...(input.scope.executionId === undefined ? {} : { executionId: input.scope.executionId }),
        ir: input.ir,
        constraints,
        candidates: corpus,
        selectedCandidateId: selected.candidateId,
        qualityThreshold: input.selection.facts.qualityFloor,
        transformationBasis: {
          code: selected.strategy === "retry" ? "identity" : "representation-substitution",
          detail: boundedDetail(detail),
        },
        recordedAt: input.scope.recordedAt,
      },
      input.digest,
    );
  } catch (error) {
    // The foundation's total validation (hard constraints, selection
    // coherence, digests) rejected the record: the plane's closed
    // fail-closed error — never an unvalidated emission.
    reject("decision-invalid", "the recovery decision record failed its total validation", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
