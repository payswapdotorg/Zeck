/**
 * Constraint-conditioned admissibility and the deterministic
 * selection order (platform model-economics plane; WORK-053).
 *
 * The shared economics core every model-economics selection runs on:
 *
 *  - QUALITY FLOORS ARE INVIOLABLE (WORK-053 invariant 8): the
 *    effective floor is the MAXIMUM of the Work Order assurance
 *    threshold (the quality facts) and every HARD quality constraint
 *    in the governing set — hard constraints can RAISE the floor,
 *    never lower it. A candidate below the floor is inadmissible
 *    regardless of cost (never merely more expensive);
 *  - hard ceilings (budget, latency) and hard policy route
 *    restrictions are enforced per candidate — the foundation's own
 *    sanctioned semantics (`routeAllowedByPolicy`, the planning
 *    module's denylists-dominate mirror), never re-invented;
 *  - the deterministic ORDER (invariant 5): expected
 *    successful-resolution cost ascending (the foundation's
 *    `ceil(cost / reliability)` bounded integer arithmetic), ties
 *    broken by the canonical representation ladder (cheaper rung
 *    first), then by candidateId — the same auditable comparison
 *    basis the WORK-049 cost model freezes, so model-economics
 *    selections and compiler ladder selections order IDENTICALLY
 *    under identical facts.
 *
 * Everything here is a pure function of its inputs (no clock, no
 * randomness, no ambient state — architecture invariant 5).
 */

import type { OptimizationConstraint } from "../execution-ir/constraints";
import { routeAllowedByPolicy, validateConstraintSet } from "../execution-ir/constraints";
import type {
  CandidateEvaluation,
  CandidateRepresentation,
  CostClaim,
} from "../execution-ir/cost-model";
import { evaluateCandidate, representationLadderRank } from "../execution-ir/cost-model";
import type { QualityFacts } from "./vocabulary";
import { reject } from "./vocabulary";

// ---------------------------------------------------------------------------
// The effective floors and ceilings (constraint-conditioned, deterministic)
// ---------------------------------------------------------------------------

/**
 * Why a candidate is inadmissible (typed, bounded evidence — recorded
 * per candidate in every selection result).
 */
export const CANDIDATE_INADMISSIBLE_CODES = [
  "quality-below-floor",
  "reliability-below-floor",
  "policy-forbidden-route",
  "budget-ceiling",
  "latency-ceiling",
  "quality-gain-below-threshold",
] as const;
export type CandidateInadmissibleCode = (typeof CANDIDATE_INADMISSIBLE_CODES)[number];

/** The effective governing facts of one selection (deterministic). */
export interface GoverningFacts {
  /** The inviolable effective quality floor (max of all sources). */
  readonly qualityFloor: number;
  /** The effective reliability floor (hard constraints only). */
  readonly reliabilityFloor: number;
  /** Hard budget ceilings (integer micro-USD strings). */
  readonly budgetCeilingsMicroUsd: readonly string[];
  /** Hard latency ceilings (milliseconds). */
  readonly latencyCeilingsMs: readonly number[];
  /** Hard policy provider/model restriction payloads. */
  readonly policyRestrictions: readonly PolicyProviderModelRestriction[];
}

/** One hard policy constraint's provider/model restriction payload. */
export interface PolicyProviderModelRestriction {
  readonly constraintId: string;
  readonly providerModel: {
    readonly allowedProviders?: readonly string[];
    readonly deniedProviders?: readonly string[];
    readonly allowedModels?: readonly string[];
    readonly deniedModels?: readonly string[];
  };
}

const NO_FLOOR = 0;

/**
 * Derive the effective governing facts from the quality facts and the
 * constraint set: the floor is the MAXIMUM of the assurance threshold
 * and every HARD quality constraint floor (soft constraints are
 * recorded, never enforced — the foundation's rule); ceilings and
 * policy restrictions come from the HARD budget / latency / policy
 * constraints only.
 */
export function governingFacts(
  qualityFacts: QualityFacts,
  constraints: readonly OptimizationConstraint[],
): GoverningFacts {
  const validated = validateConstraintSet(constraints);
  let qualityFloor = qualityFacts.requiredQuality;
  let reliabilityFloor = NO_FLOOR;
  const budgetCeilingsMicroUsd: string[] = [];
  const latencyCeilingsMs: number[] = [];
  const policyRestrictions: PolicyProviderModelRestriction[] = [];
  for (const constraint of validated) {
    if (constraint.enforcement === "soft") {
      // Recorded, never enforced — by construction.
      continue;
    }
    switch (constraint.kind) {
      case "quality": {
        const payload = constraint.payload as { minQuality?: number; minReliability?: number };
        if (payload.minQuality !== undefined) {
          qualityFloor = Math.max(qualityFloor, payload.minQuality);
        }
        if (payload.minReliability !== undefined) {
          reliabilityFloor = Math.max(reliabilityFloor, payload.minReliability);
        }
        break;
      }
      case "budget": {
        const payload = constraint.payload as { maxCostMicroUsd: string };
        budgetCeilingsMicroUsd.push(payload.maxCostMicroUsd);
        break;
      }
      case "latency": {
        const payload = constraint.payload as { maxLatencyMs?: number };
        if (payload.maxLatencyMs !== undefined) {
          latencyCeilingsMs.push(payload.maxLatencyMs);
        }
        break;
      }
      case "policy": {
        const payload = constraint.payload as { providerModel?: unknown };
        if (payload.providerModel !== undefined) {
          policyRestrictions.push({
            constraintId: constraint.constraintId,
            providerModel: payload.providerModel as PolicyProviderModelRestriction["providerModel"],
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return {
    qualityFloor,
    reliabilityFloor,
    budgetCeilingsMicroUsd,
    latencyCeilingsMs,
    policyRestrictions,
  };
}

// ---------------------------------------------------------------------------
// Per-candidate admissibility (typed, total)
// ---------------------------------------------------------------------------

/** The per-candidate verdict: the evaluation plus admissibility. */
export interface CandidateAdmissibility {
  readonly candidateId: string;
  readonly representationClass: string;
  /** False when the candidate violates the inviolable economics. */
  readonly admissible: boolean;
  readonly inadmissibleCode?: CandidateInadmissibleCode;
  /** The WORK-049 evaluation (expected successful-resolution cost). */
  readonly evaluation: CandidateEvaluation;
}

function microUsdAtMost(value: string, ceiling: string): boolean {
  return BigInt(value) <= BigInt(ceiling);
}

/**
 * Evaluate ONE candidate's admissibility under the governing facts:
 * quality floor, reliability floor, budget ceilings, latency
 * ceilings. Route policy eligibility is checked separately (only
 * route-bearing candidates have one).
 */
export function evaluateAdmissibility(
  candidate: CandidateRepresentation,
  facts: GoverningFacts,
): CandidateAdmissibility {
  const evaluation = evaluateCandidate(candidate, facts.qualityFloor);
  const claim = candidate.claim as CostClaim;
  const code = (() => {
    if (claim.expectedQuality < facts.qualityFloor) {
      return "quality-below-floor" as const;
    }
    if (claim.expectedReliability < facts.reliabilityFloor) {
      return "reliability-below-floor" as const;
    }
    for (const ceiling of facts.budgetCeilingsMicroUsd) {
      if (!microUsdAtMost(claim.expectedCostMicroUsd, ceiling)) {
        return "budget-ceiling" as const;
      }
    }
    for (const ceiling of facts.latencyCeilingsMs) {
      if (claim.expectedLatencyMs > ceiling) {
        return "latency-ceiling" as const;
      }
    }
    return undefined;
  })();
  return {
    candidateId: candidate.candidateId,
    representationClass: candidate.representationClass,
    admissible: code === undefined,
    ...(code === undefined ? {} : { inadmissibleCode: code }),
    evaluation,
  };
}

/**
 * Route policy eligibility for a route-bearing candidate: the
 * foundation's `routeAllowedByPolicy` over EVERY hard policy
 * restriction (denylists dominate — the planning module's own
 * sanctioned semantics, consumed not re-invented).
 */
export function routeEligibility(
  route: { readonly provider: string; readonly model: string },
  facts: GoverningFacts,
): { eligible: boolean; constraintId: string | null } {
  for (const restriction of facts.policyRestrictions) {
    // The sanctioned mirror: the foundation's own planning-module
    // semantics, consumed not re-invented.
    if (!routeAllowedByPolicy(route.provider, route.model, restriction.providerModel)) {
      return { eligible: false, constraintId: restriction.constraintId };
    }
  }
  return { eligible: true, constraintId: null };
}

// ---------------------------------------------------------------------------
// The deterministic selection order (the auditable comparison basis)
// ---------------------------------------------------------------------------

/**
 * Compare two ADMISSIBLE candidate verdicts by the deterministic
 * order: expected successful-resolution cost ascending, ties by the
 * canonical representation ladder (cheaper rung first), ties by
 * candidateId. Identical inputs can never produce a different order
 * (architecture invariant 5 — non-deterministic tie-breaks are
 * impossible because every tie resolves on content).
 */
export function compareAdmissible(a: CandidateAdmissibility, b: CandidateAdmissibility): number {
  const costA = BigInt(a.evaluation.expectedSuccessfulResolutionCostMicroUsd);
  const costB = BigInt(b.evaluation.expectedSuccessfulResolutionCostMicroUsd);
  if (costA !== costB) {
    return costA < costB ? -1 : 1;
  }
  const rankA = representationLadderRank(a.representationClass as never);
  const rankB = representationLadderRank(b.representationClass as never);
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  if (a.candidateId !== b.candidateId) {
    return a.candidateId < b.candidateId ? -1 : 1;
  }
  return 0;
}

/**
 * Order every verdict: ADMISSIBLE first in the deterministic order,
 * inadmissible after (in input order — their ordering is not a
 * selection fact; their recorded verdicts are). The selected is the
 * first admissible or none (typed outcome, never a below-floor
 * selection).
 */
export function orderVerdicts(verdicts: readonly CandidateAdmissibility[]): {
  ordered: readonly CandidateAdmissibility[];
  selected: CandidateAdmissibility | null;
} {
  const admissible = verdicts.filter((verdict) => verdict.admissible).sort(compareAdmissible);
  const inadmissible = verdicts.filter((verdict) => !verdict.admissible);
  return { ordered: [...admissible, ...inadmissible], selected: admissible[0] ?? null };
}

/** Reject duplicate candidate ids within one decision (ambiguity hazard). */
export function rejectDuplicateIds(candidateIds: readonly string[]): void {
  const seen = new Set<string>();
  for (const candidateId of candidateIds) {
    if (seen.has(candidateId)) {
      reject("candidate-shape", "candidate ids must be unique within a decision", {
        candidateId,
      });
    }
    seen.add(candidateId);
  }
}
