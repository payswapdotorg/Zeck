/**
 * Candidate strategies and deterministic-first selection (planning module
 * domain; WORK-009 / INT-004, ADR-0007, ADR-0011).
 *
 * A `CandidateStrategy` pairs an immutable plan with its typed estimates
 * (expected cost/quality/latency, verification strategy, route rationale)
 * and an ADMISSIBILITY verdict computed against the effective policy —
 * never against a score alone:
 *
 *  - `filterAdmissibility` applies the policy as HARD constraints: a
 *    forbidden provider/model route makes the whole candidate
 *    inadmissible REGARDLESS of how cheap or high-quality it looks (AC-9);
 *    cost/latency ceilings and the quality floor are equally absolute.
 *  - `selectStrategy` implements the deterministic-first preference
 *    (mandatory): when the sufficiency decision is `sufficient` and an
 *    admissible deterministic-only candidate satisfies the task, it is
 *    selected — a cheaper-scoring generative candidate can never win
 *    (AC-5/AC-10, planning-contract "Required future discrimination
 *    proof"). Otherwise selection is cheap-first among admissible
 *    candidates that satisfy the task (INT-004 cascade).
 *
 * All monetary estimates are integer micro-USD strings (never floats).
 */

import { PlatformError } from "../../../shared/errors";
import type { RestrictionSet } from "../../policies/public";
import type { ExecutionPlan } from "./plan";
import type { DeterministicSufficiencyDecision } from "./sufficiency";

export interface CandidateStrategy {
  readonly strategyId: string;
  readonly plan: ExecutionPlan;
  readonly expectedCostMicroUsd: string;
  readonly expectedQuality: number;
  readonly expectedLatencyMs: number;
  readonly verificationStrategy: string;
  /** Machine-readable route rationale code + human detail. */
  readonly routeRationale: RouteRationale;
  readonly modelCalls: number;
  readonly admissible: boolean;
  readonly inadmissibleReason?: InadmissibleReasonCode;
}

export type InadmissibleReasonCode =
  | "policy-forbidden-route"
  | "policy-cost-ceiling"
  | "policy-latency-ceiling"
  | "policy-quality-floor"
  | "no-route-available";

export type RouteRationaleCode =
  | "deterministic-sufficient"
  | "semantic-reasoning-required"
  | "deterministic-quality-gap"
  | "hybrid-composition"
  | "cheap-first-cascade"
  | "bounded-evaluation-of-uncertain-determinism";

export interface RouteRationale {
  readonly code: RouteRationaleCode;
  readonly detail: string;
}

/** Selection outcome: the chosen candidate or a typed no-route failure. */
export type StrategySelection =
  | {
      readonly kind: "selected";
      readonly selected: CandidateStrategy;
      readonly deterministicFirstApplied: boolean;
      readonly rationale: string;
    }
  | {
      readonly kind: "none";
      readonly reason: "no-admissible-candidate";
    };

const MICRO_USD_INT = /^\d{1,19}$/;

function compareMicroUsd(a: string, b: string): number {
  const bigintA = BigInt(a);
  const bigintB = BigInt(b);
  return bigintA < bigintB ? -1 : bigintA > bigintB ? 1 : 0;
}

/** Does this route satisfy the policy provider/model restrictions? */
export function routeAllowedByPolicy(
  provider: string,
  model: string,
  providerModel: RestrictionSet["providerModel"],
): boolean {
  if (providerModel === undefined) {
    return true;
  }
  const { allowedProviders, deniedProviders, allowedModels, deniedModels } = providerModel;
  if (deniedProviders?.includes(provider) === true) {
    return false;
  }
  if (allowedProviders !== undefined && allowedProviders.length > 0) {
    if (!allowedProviders.includes(provider)) {
      return false;
    }
  }
  if (deniedModels?.includes(model) === true) {
    return false;
  }
  if (allowedModels !== undefined && allowedModels.length > 0) {
    if (!allowedModels.includes(model)) {
      return false;
    }
  }
  return true;
}

/**
 * Apply the effective policy as HARD admissibility constraints. Pure.
 * A candidate containing ANY forbidden route is inadmissible even when it
 * is the cheapest/highest-scoring option (the AC-9 boundary).
 */
export function filterAdmissibility(
  candidate: Omit<CandidateStrategy, "admissible" | "inadmissibleReason">,
  policy: RestrictionSet,
): CandidateStrategy {
  if (candidate.plan.hasRouteRef) {
    for (const step of candidate.plan.steps) {
      if (step.routeRef === undefined) {
        continue;
      }
      if (
        !routeAllowedByPolicy(step.routeRef.provider, step.routeRef.model, policy.providerModel)
      ) {
        return {
          ...candidate,
          admissible: false,
          inadmissibleReason: "policy-forbidden-route",
        };
      }
    }
  }
  if (policy.cost?.maxCostMicroUsd !== undefined) {
    if (!MICRO_USD_INT.test(candidate.expectedCostMicroUsd)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "candidate expected cost must be an integer micro-USD string",
        details: { got: candidate.expectedCostMicroUsd },
      });
    }
    if (compareMicroUsd(candidate.expectedCostMicroUsd, policy.cost.maxCostMicroUsd) > 0) {
      return {
        ...candidate,
        admissible: false,
        inadmissibleReason: "policy-cost-ceiling",
      };
    }
  }
  if (policy.latency?.maxLatencyMs !== undefined) {
    if (candidate.expectedLatencyMs > policy.latency.maxLatencyMs) {
      return { ...candidate, admissible: false, inadmissibleReason: "policy-latency-ceiling" };
    }
  }
  if (policy.quality?.minQuality !== undefined) {
    if (candidate.expectedQuality < policy.quality.minQuality) {
      return { ...candidate, admissible: false, inadmissibleReason: "policy-quality-floor" };
    }
  }
  return { ...candidate, admissible: true };
}

/**
 * Deterministic-first selection (ADR-0007 mandatory preference):
 *
 *  1. If sufficiency is `sufficient` and an admissible deterministic-only
 *     candidate satisfies the task quality target, it MUST be selected —
 *     regardless of how attractive a generative candidate scores.
 *  2. Otherwise: cheap-first among admissible candidates that satisfy the
 *     task quality target (cascade ordering, INT-004); ties break on
 *     higher expected quality, then lower latency, then fewer model
 *     calls (the zero-model preference expressed as an ordering key).
 *  3. No admissible satisfying candidate ⇒ typed `NO_ELIGIBLE_ROUTE`
 *     (raised by the caller from the `none` outcome).
 */
export function selectStrategy(
  candidates: readonly CandidateStrategy[],
  sufficiency: DeterministicSufficiencyDecision,
  qualityTarget: number,
): StrategySelection {
  const admissible = candidates.filter((candidate) => candidate.admissible);
  const satisfying = admissible.filter((candidate) => candidate.expectedQuality >= qualityTarget);

  if (sufficiency.outcome === "sufficient") {
    const deterministic = satisfying.find(
      (candidate) => candidate.plan.strategyClass === "deterministic-only",
    );
    if (deterministic !== undefined) {
      return {
        kind: "selected",
        selected: deterministic,
        deterministicFirstApplied: true,
        rationale:
          "deterministic-first preference applied: an admissible deterministic capability satisfies the task without materially reducing the verified outcome (ADR-0007)",
      };
    }
  }

  if (satisfying.length === 0) {
    return { kind: "none", reason: "no-admissible-candidate" };
  }

  const ordered = [...satisfying].sort(compareCheapFirst);
  const [best] = ordered;
  if (best === undefined) {
    return { kind: "none", reason: "no-admissible-candidate" };
  }
  return {
    kind: "selected",
    selected: best,
    deterministicFirstApplied: false,
    rationale: `cheap-first cascade selection among ${satisfying.length} admissible candidate(s) satisfying the quality target (INT-004); zero-model candidates break ties first`,
  };
}

/** Cheap-first ordering (cost, then quality, then latency, then model calls). */
export function compareCheapFirst(a: CandidateStrategy, b: CandidateStrategy): number {
  const byCost = compareMicroUsd(a.expectedCostMicroUsd, b.expectedCostMicroUsd);
  if (byCost !== 0) {
    return byCost;
  }
  if (a.expectedQuality !== b.expectedQuality) {
    return b.expectedQuality - a.expectedQuality;
  }
  if (a.expectedLatencyMs !== b.expectedLatencyMs) {
    return a.expectedLatencyMs - b.expectedLatencyMs;
  }
  return a.modelCalls - b.modelCalls;
}
