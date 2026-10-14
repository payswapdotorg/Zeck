/**
 * The promotion gate (PCL-003 — ACR-010 §5's success gate, verbatim).
 *
 * THE LAW (the work order): a configuration is promoted only on
 *   (tail percentile improvement) AND (no resolution regression) AND
 *   (cost within the declared budget delta) AND (explicit
 *   timeout/terminal-failure behavior preserved)
 * — median improvement alone promotes NOTHING. The gate's verdict is
 * DERIVED from the measured aggregates against the DECLARED
 * thresholds (experiments/pcl-003/declared-thresholds.json — declared
 * before the run), never asserted: every leg is independently
 * falsifiable, and any failing leg is named with its numbers.
 *
 * A threshold miss with honest attribution is a VALID delivery (the
 * truth discipline): this module reports the miss, it never repairs
 * it.
 */

/** The declared thresholds (the committed declarations, loaded before the run). */
export interface DeclaredThresholds {
  readonly t1Tail: {
    readonly rule: "p95-and-p99-strictly-improved";
    /** The percentile points compared (fixed: p95 and p99 of the outcome latency). */
    readonly points: readonly ["p95", "p99"];
  };
  readonly t2Resolution: {
    readonly rule: "resolution-rate-not-below-baseline";
  };
  readonly t3Cost: {
    readonly rule: "total-cost-within-budget-delta";
    /** The allowed relative increase of the tuned arm's total cost over the baseline's. */
    readonly budgetDeltaFraction: number;
  };
  readonly t4Preservation: {
    readonly rule: "timeout-and-terminal-preservation";
  };
}

/** The declared thresholds (mirrors of the committed declarations). */
export const DECLARED_THRESHOLDS: DeclaredThresholds = {
  t1Tail: {
    rule: "p95-and-p99-strictly-improved",
    points: ["p95", "p99"],
  },
  t2Resolution: {
    rule: "resolution-rate-not-below-baseline",
  },
  t3Cost: {
    rule: "total-cost-within-budget-delta",
    budgetDeltaFraction: 0.25,
  },
  t4Preservation: {
    rule: "timeout-and-terminal-preservation",
  },
};

/** The measured aggregate facts one arm produced (the gate's inputs — all measured, never asserted). */
export interface ArmGateFacts {
  readonly armId: string;
  readonly executions: number;
  readonly resolved: number;
  readonly resolutionRate: number;
  /** The successful-outcome latency percentiles (the capstone's own latency-tail pool — the T1 pool). */
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly totalCostMicroUsd: number;
  readonly totalCostBasis: string;
  readonly verificationCostMicroUsd: number;
  readonly verificationCostBasis: string;
  readonly terminalFailures: number;
  readonly maskedTerminalFailures: number;
  readonly dispatchBudgetViolations: number;
  readonly censusReconciles: boolean;
}

/** One gate leg's mechanical verdict. */
export interface GateLegVerdict {
  readonly legId: "T1" | "T2" | "T3" | "T4";
  readonly name: string;
  readonly passed: boolean;
  /** The leg's numbers (both sides, every threshold stated). */
  readonly detail: Record<string, unknown>;
  /** Honest attribution on a miss (null when the leg passed). */
  readonly attribution: string | null;
}

/** The promotion gate's mechanical verdict. */
export interface PromotionGateVerdict {
  readonly verdict: "PROMOTED" | "NOT-PROMOTED";
  readonly legs: readonly GateLegVerdict[];
  readonly failingLegs: readonly string[];
  readonly basis: string;
}

/**
 * Apply the promotion gate MECHANICALLY: every leg derived from the
 * measured aggregates against the declared thresholds; the verdict is
 * PROMOTED only when every leg passes.
 */
export function applyPromotionGate(input: {
  readonly baseline: ArmGateFacts;
  readonly tuned: ArmGateFacts;
  readonly thresholds: DeclaredThresholds;
}): PromotionGateVerdict {
  const legs: GateLegVerdict[] = [];

  // T1 — the tail percentile improvement: p95 AND p99 of the tuned
  // arm's SUCCESSFUL-OUTCOME latency (the capstone's own latency-tail
  // pool — "Successful-outcome end-to-end task latency over N resolved
  // task(s)") strictly below the baseline's (null vs non-null is an
  // honest miss: an arm with no samples cannot claim improvement; the
  // T2 resolution leg guards this pool against failure-hiding).
  const t1Passed =
    input.tuned.p95Ms !== null &&
    input.baseline.p95Ms !== null &&
    input.tuned.p99Ms !== null &&
    input.baseline.p99Ms !== null &&
    input.tuned.p95Ms < input.baseline.p95Ms &&
    input.tuned.p99Ms < input.baseline.p99Ms;
  legs.push({
    legId: "T1",
    name: "tail percentile improvement (p95 AND p99 of the successful-outcome latency, strictly — the capstone's own latency-tail pool)",
    passed: t1Passed,
    detail: {
      rule: input.thresholds.t1Tail.rule,
      pool: "successful-outcome end-to-end latency (the capstone's latency-tail definition, quoted)",
      baseline: {
        p50Ms: input.baseline.p50Ms,
        p95Ms: input.baseline.p95Ms,
        p99Ms: input.baseline.p99Ms,
      },
      tuned: { p50Ms: input.tuned.p50Ms, p95Ms: input.tuned.p95Ms, p99Ms: input.tuned.p99Ms },
    },
    attribution: t1Passed
      ? null
      : `the tuned arm's outcome-latency tail did not strictly improve at both p95 and p99 under the declared synthetic-latency model (baseline p95 ${input.baseline.p95Ms} ms / p99 ${input.baseline.p99Ms} ms vs tuned p95 ${input.tuned.p95Ms} ms / p99 ${input.tuned.p99Ms} ms); attribution: the paced retry waits and the deeper recovery ladders add latency on the fault paths, and the class-aware cooldown diversion's benefit is bounded by the synthetic supplies' declared fault profile — the tail tradeoff is DISCLOSED per failure class and route in the per-class tables`,
  });

  // T2 — resolution honesty: the tuned arm's resolution rate not below
  // the baseline's (a tail improvement that costs resolution is a
  // MISS, mechanically).
  const t2Passed = input.tuned.resolutionRate >= input.baseline.resolutionRate;
  legs.push({
    legId: "T2",
    name: "resolution honesty (the tuned arm's resolution rate not below the baseline's)",
    passed: t2Passed,
    detail: {
      rule: input.thresholds.t2Resolution.rule,
      baseline: {
        executions: input.baseline.executions,
        resolved: input.baseline.resolved,
        resolutionRate: input.baseline.resolutionRate,
      },
      tuned: {
        executions: input.tuned.executions,
        resolved: input.tuned.resolved,
        resolutionRate: input.tuned.resolutionRate,
      },
    },
    attribution: t2Passed
      ? null
      : `the tuned arm's resolution rate ${input.tuned.resolutionRate} is BELOW the baseline's ${input.baseline.resolutionRate} — a tail improvement that costs resolution is a MISS (ACR-010 §5); attribution: the paced ladder's admissibility or budget excluded recoveries the baseline's policy retry recovered`,
  });

  // T3 — cost truth: the tuned arm's total cost (including duplicate
  // attempts, synthetic-schedule basis) within the declared budget
  // delta of the baseline's.
  const budgetMicroUsd = Math.round(
    input.baseline.totalCostMicroUsd * (1 + input.thresholds.t3Cost.budgetDeltaFraction),
  );
  const t3Passed = input.tuned.totalCostMicroUsd <= budgetMicroUsd;
  legs.push({
    legId: "T3",
    name: "cost truth (total cost including duplicates within the declared budget delta)",
    passed: t3Passed,
    detail: {
      rule: input.thresholds.t3Cost.rule,
      budgetDeltaFraction: input.thresholds.t3Cost.budgetDeltaFraction,
      baseline: {
        totalCostMicroUsd: input.baseline.totalCostMicroUsd,
        basis: input.baseline.totalCostBasis,
        verificationCostMicroUsd: input.baseline.verificationCostMicroUsd,
        verificationBasis: input.baseline.verificationCostBasis,
      },
      tuned: {
        totalCostMicroUsd: input.tuned.totalCostMicroUsd,
        basis: input.tuned.totalCostBasis,
        verificationCostMicroUsd: input.tuned.verificationCostMicroUsd,
        verificationBasis: input.tuned.verificationCostBasis,
      },
      allowedBudgetMicroUsd: budgetMicroUsd,
    },
    attribution: t3Passed
      ? null
      : `the tuned arm's total cost ${input.tuned.totalCostMicroUsd} micro-USD exceeds the declared budget ${budgetMicroUsd} micro-USD (the baseline's ${input.baseline.totalCostMicroUsd} + ${input.thresholds.t3Cost.budgetDeltaFraction * 100}%); attribution: the deeper recovery ladders' duplicate-attempt charges (synthetic-schedule basis)`,
  });

  // T4 — the timeout/terminal-failure preservation: the preservation
  // gate passed at construction (fail-closed — both arms' resolvers
  // constructed, the tuned configuration validated), ZERO terminal
  // failures masked, ZERO dispatch-budget violations, and the census
  // reconciles on every cell of both arms.
  const t4Passed =
    input.tuned.maskedTerminalFailures === 0 &&
    input.baseline.maskedTerminalFailures === 0 &&
    input.tuned.dispatchBudgetViolations === 0 &&
    input.baseline.dispatchBudgetViolations === 0 &&
    input.tuned.censusReconciles &&
    input.baseline.censusReconciles;
  legs.push({
    legId: "T4",
    name: "timeout/terminal-failure preservation (zero masked terminals, zero budget violations, the census reconciles)",
    passed: t4Passed,
    detail: {
      rule: input.thresholds.t4Preservation.rule,
      baseline: {
        terminalFailures: input.baseline.terminalFailures,
        maskedTerminalFailures: input.baseline.maskedTerminalFailures,
        dispatchBudgetViolations: input.baseline.dispatchBudgetViolations,
        censusReconciles: input.baseline.censusReconciles,
      },
      tuned: {
        terminalFailures: input.tuned.terminalFailures,
        maskedTerminalFailures: input.tuned.maskedTerminalFailures,
        dispatchBudgetViolations: input.tuned.dispatchBudgetViolations,
        censusReconciles: input.tuned.censusReconciles,
      },
    },
    attribution: t4Passed
      ? null
      : "the timeout/terminal-failure preservation leg failed: a terminal failure was masked, a dispatch budget was violated, or the attempt census failed to reconcile on some cell (the automatic-void shape — never repairable, always reported)",
  });

  const failingLegs = legs.filter((leg) => !leg.passed).map((leg) => leg.legId);
  return {
    verdict: failingLegs.length === 0 ? "PROMOTED" : "NOT-PROMOTED",
    legs,
    failingLegs,
    basis:
      "the mechanical derivation over the measured aggregates against the declared thresholds (experiments/pcl-003/declared-thresholds.json — declared before the run); median improvement alone promotes nothing (ACR-010 §5, verbatim)",
  };
}
