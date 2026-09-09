/**
 * Fresh-escalation decision hooks (platform model-economics plane;
 * WORK-053 / E1.1 — ADR-0020 "Model escalation should be
 * evidence-driven").
 *
 * RECORDS decisions ONLY (WORK-053 architecture invariant 6 and
 * acceptance criterion 6): the hook decides — by bounded, typed,
 * explicit-basis arithmetic — WHEN escalation-to-fresh-context is
 * economically justified, and produces the typed decision value (plus
 * the WORK-049-format decision record as a VALUE through
 * `decisions.ts`). The recovery behavior itself (fresh context
 * construction, continuation packages, environment fingerprinting) is
 * WORK-055's surface, out of scope here — this hook RECORDS the
 * economically-justified escalation decisions for WORK-055 to
 * consume.
 *
 * The economics (the typed comparison):
 *
 *   escalate iff the fresh-context path MEETS the inviolable quality
 *   floor AND [ (its expected successful-resolution cost is STRICTLY
 *   below the continuation's) OR (the continuation is below the floor
 *   — quality-preserving economics: a degraded continuation is never
 *   preferred over a sufficient fresh start) ]
 *   — while respecting hard budget/latency ceilings on both sides.
 *
 * Equal expected costs CONTINUE (the default — no churn without
 * strict economic justification). Both paths below the floor produce
 * the typed `no-admissible-candidate` outcome (neither path is
 * sufficient; the recovery authority decides — recorded honestly).
 *
 * Pure and deterministic (invariant 5); decision evidence only,
 * never an authorization and never a behavior (invariants 4 and 6).
 */

import type { OptimizationConstraint } from "../execution-ir/constraints";
import type { CostClaim } from "../execution-ir/cost-model";
import { evaluateCandidate } from "../execution-ir/cost-model";
import type { CandidateAdmissibility, GoverningFacts } from "./admissibility";
import { governingFacts } from "./admissibility";
import type { QualityFacts } from "./vocabulary";
import { reject, validateQualityFacts } from "./vocabulary";

// ---------------------------------------------------------------------------
// The hook input and result (typed, bounded)
// ---------------------------------------------------------------------------

/**
 * The fresh-escalation hook input: the two explicit-basis paths of
 * the escalation decision.
 */
export interface FreshEscalationInput {
  /**
   * The continuation path's claim: expected cost/latency/quality/
   * reliability of CONTINUING in the current (possibly degraded)
   * context.
   */
  readonly continuation: CostClaim;
  /**
   * The fresh-context path's claim: expected cost/latency/quality/
   * reliability of escalating to a FRESH context (restart + replay —
   * the WORK-055 recovery surface this hook records decisions for).
   */
  readonly freshContext: CostClaim;
  /** The quality facts (the assurance floor — inviolable). */
  readonly qualityFacts: QualityFacts;
  /** The governing constraint set (hard constraints enforced). */
  readonly constraints: readonly OptimizationConstraint[];
}

/** The typed comparison evidence of an escalation decision. */
export interface FreshEscalationComparison {
  /** The continuation path's evaluation (against the floor). */
  readonly continuation: CandidateAdmissibility["evaluation"];
  /** The fresh-context path's evaluation (against the floor). */
  readonly freshContext: CandidateAdmissibility["evaluation"];
  /** The signed expected-cost delta: continuation − fresh (micro-USD). */
  readonly continuationPremiumMicroUsd: string;
}

/**
 * The fresh-escalation decision — a RECORDED typed value:
 *
 *  - `escalate-fresh-context` — escalation is economically justified
 *    (the evidence below carries the arithmetic);
 *  - `continue-current-context` — continuation is sufficient and not
 *    strictly more expensive (the default);
 *  - `no-admissible-candidate` — NEITHER path meets the floor (the
 *    honest typed outcome; the recovery authority decides).
 */
export interface FreshEscalationDecision {
  readonly kind: "escalate-fresh-context" | "continue-current-context" | "no-admissible-candidate";
  /** The bounded comparison arithmetic (the recorded evidence). */
  readonly comparison: FreshEscalationComparison;
  /** The governing facts the decision ran under. */
  readonly facts: GoverningFacts;
  /** The frozen, human-auditable decision basis. */
  readonly selectionBasis: string;
}

/** The frozen basis statement of every fresh-escalation decision. */
export const FRESH_ESCALATION_DECISION_BASIS =
  "escalate-iff-fresh-meets-floor-and-is-strictly-cheaper-or-continuation-below-floor;hard-ceilings-on-both-paths;equal-costs-continue;record-only";

// ---------------------------------------------------------------------------
// The hook (pure, deterministic, total)
// ---------------------------------------------------------------------------

function claimOf(value: unknown, what: string): CostClaim {
  if (typeof value !== "object" || value === null) {
    reject("escalation-shape", `${what} must be a cost claim object`);
  }
  return value as CostClaim;
}

/**
 * Decide whether escalation-to-fresh-context is economically
 * justified. RECORDS the decision (typed value + bounded arithmetic
 * evidence) — the recovery behavior is WORK-055's (invariant 6: hooks
 * record; they never act).
 */
export function decideFreshEscalation(input: FreshEscalationInput): FreshEscalationDecision {
  const qualityFacts = validateQualityFacts(input.qualityFacts);
  const continuation = claimOf(input.continuation, "the continuation claim");
  const freshContext = claimOf(input.freshContext, "the fresh-context claim");
  const facts = governingFacts(qualityFacts, input.constraints);

  // Evaluate both paths against the inviolable floor through the
  // foundation's own machinery (expected successful-resolution cost).
  const continuationEvaluation = evaluateCandidate(
    {
      candidateId: "continue-current-context",
      representationClass: "sufficient-model",
      claim: continuation,
    },
    facts.qualityFloor,
  );
  const freshEvaluation = evaluateCandidate(
    {
      candidateId: "escalate-fresh-context",
      representationClass: "sufficient-model",
      claim: freshContext,
    },
    facts.qualityFloor,
  );

  // Hard ceilings on both paths (budget/latency): a path violating a
  // hard ceiling is inadmissible exactly like any candidate.
  const ceilingOk = (claim: CostClaim): boolean => {
    for (const ceiling of facts.budgetCeilingsMicroUsd) {
      if (BigInt(claim.expectedCostMicroUsd) > BigInt(ceiling)) {
        return false;
      }
    }
    for (const ceiling of facts.latencyCeilingsMs) {
      if (claim.expectedLatencyMs > ceiling) {
        return false;
      }
    }
    return true;
  };
  const continuationAdmissible = continuationEvaluation.valid && ceilingOk(continuation);
  const freshAdmissible = freshEvaluation.valid && ceilingOk(freshContext);

  const continuationCost = BigInt(continuationEvaluation.expectedSuccessfulResolutionCostMicroUsd);
  const freshCost = BigInt(freshEvaluation.expectedSuccessfulResolutionCostMicroUsd);

  const kind: FreshEscalationDecision["kind"] = (() => {
    if (!continuationAdmissible && !freshAdmissible) {
      return "no-admissible-candidate" as const;
    }
    if (!continuationAdmissible) {
      // The continuation is below the floor / over a ceiling and the
      // fresh path is sufficient: escalate (quality-preserving).
      return "escalate-fresh-context" as const;
    }
    if (!freshAdmissible) {
      // Only the continuation is sufficient: continue.
      return "continue-current-context" as const;
    }
    // Both sufficient: escalate ONLY on strictly cheaper fresh cost.
    return freshCost < continuationCost
      ? ("escalate-fresh-context" as const)
      : ("continue-current-context" as const);
  })();

  return {
    kind,
    comparison: {
      continuation: continuationEvaluation,
      freshContext: freshEvaluation,
      continuationPremiumMicroUsd: (continuationCost - freshCost).toString(),
    },
    facts,
    selectionBasis: FRESH_ESCALATION_DECISION_BASIS,
  };
}
