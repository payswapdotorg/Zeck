/**
 * The per-failure-class percentile reporting (PCL-003 — ACR-010 §5's
 * first evidence leg).
 *
 * THE LAW (the work order): p50/p95/p99 for EACH failure class and
 * route, computed ONLY from the PCL-001 typed facts — never
 * aggregate-only reporting (an aggregate line without its per-class
 * decomposition is a contract miss). The decomposition reads the typed
 * fact blocks directly:
 *
 *  - the LEG-LEVEL table: for every (failure class, route) pair, the
 *    completion-latency percentiles of the legs carrying that class on
 *    that route — every member of the closed taxonomy is present (a
 *    class with zero samples renders the honest no-samples spelling,
 *    never an omission), plus the no-failure (clean-leg) group;
 *  - the OUTCOME-LEVEL table: the end-to-end outcome latency
 *    percentiles overall and by outcome class (the tail the promotion
 *    gate judges), with the per-failure-class ENCOUNTERED outcome
 *    percentiles (the classes the execution's legs met).
 *
 * THE PERCENTILE CONVENTION (the capstone's own, quoted): nearest-rank
 * — p = sorted[min(n - 1, ceil(n * p) - 1)]; the median is
 * sorted[floor(n / 2)] (the sweep's `summarize` convention); no
 * samples → null (the honest spelling, never a fabricated zero).
 */

import {
  OUTCOME_CLASSES,
  OUTCOME_FAILURE_CLASSES,
  type OutcomeFailureClass,
  type OutcomeLatencyFacts,
} from "./facts";

/** One percentile row (the honest spelling for empty populations). */
export interface PercentileRow {
  /** The row's key (the failure class and route, or the outcome class). */
  readonly key: string;
  readonly failureClass: string;
  readonly route: string;
  readonly samples: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly meanMs: number | null;
  readonly maxMs: number | null;
}

/** The percentile under the capstone's own nearest-rank convention (null when no samples). */
export function percentileOf(samples: readonly number[], p: 0.5 | 0.95 | 0.99): number | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  if (p === 0.5) {
    return sorted[Math.floor(sorted.length / 2)] ?? null;
  }
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? null;
}

function rowOf(
  key: string,
  failureClass: string,
  route: string,
  samples: readonly number[],
): PercentileRow {
  if (samples.length === 0) {
    return {
      key,
      failureClass,
      route,
      samples: 0,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      meanMs: null,
      maxMs: null,
    };
  }
  const sum = samples.reduce((total, value) => total + value, 0);
  return {
    key,
    failureClass,
    route,
    samples: samples.length,
    p50Ms: percentileOf(samples, 0.5),
    p95Ms: percentileOf(samples, 0.95),
    p99Ms: percentileOf(samples, 0.99),
    meanMs: Math.round(sum / samples.length),
    maxMs: Math.max(...samples),
  };
}

/** The route label of one leg (provider/model — the neutral route). */
function routeLabelOf(route: { readonly provider: string; readonly model: string }): string {
  return `${route.provider}/${route.model}`;
}

/**
 * THE LEG-LEVEL PER-FAILURE-CLASS/ROUTE TABLE: for every member of the
 * closed failure taxonomy (plus the no-failure clean-leg group) and
 * every route observed, the completion-latency percentiles of the legs
 * carrying that class on that route. Every closed-vocabulary member is
 * present; zero-sample rows render the honest no-samples spelling.
 */
export function legPercentilesByFailureClassAndRoute(
  factsBlocks: readonly OutcomeLatencyFacts[],
): readonly PercentileRow[] {
  // (class, route) → completion samples of legs with that class on that route.
  const pools = new Map<string, number[]>();
  const routeKeys = new Map<string, string>();
  const collect = (failureClass: string, route: string, latencyMs: number): void => {
    const key = `${failureClass}@${route}`;
    const pool = pools.get(key) ?? [];
    pool.push(latencyMs);
    pools.set(key, pool);
    routeKeys.set(key, route);
  };
  for (const facts of factsBlocks) {
    for (const leg of facts.legs) {
      const completion = leg.completion.kind === "measured" ? leg.completion.milliseconds : null;
      if (completion === null) {
        continue; // an honestly not-run completion never contributes a sample
      }
      const route = routeLabelOf(leg.route);
      collect(leg.failureClass ?? "no-failure", route, completion);
    }
  }
  const rows: PercentileRow[] = [];
  // The closed taxonomy, in the frozen order — every member present.
  for (const failureClass of [...OUTCOME_FAILURE_CLASSES, "no-failure"] as const) {
    for (const key of [...pools.keys()].sort()) {
      if (!key.startsWith(`${failureClass}@`)) {
        continue;
      }
      const route = routeKeys.get(key) ?? key.slice(failureClass.length + 1);
      rows.push(rowOf(key, failureClass, route, pools.get(key) ?? []));
    }
    // A class with no observed route at all still renders its honest
    // zero-sample row (the closed taxonomy is fully present).
    if (![...pools.keys()].some((key) => key.startsWith(`${failureClass}@`))) {
      rows.push(rowOf(`${failureClass}@(none)`, failureClass, "(none)", []));
    }
  }
  return rows;
}

/**
 * THE OUTCOME-LEVEL TABLE: the end-to-end outcome latency percentiles
 * by outcome class (every member of the closed outcome classification
 * present) — the tail distribution the promotion gate judges.
 */
export function outcomePercentilesByOutcomeClass(
  outcomes: readonly { readonly outcomeClass: string; readonly outcomeLatencyMs: number }[],
): readonly PercentileRow[] {
  const rows: PercentileRow[] = [];
  for (const outcomeClass of OUTCOME_CLASSES) {
    const samples = outcomes
      .filter((outcome) => outcome.outcomeClass === outcomeClass)
      .map((outcome) => outcome.outcomeLatencyMs);
    rows.push(rowOf(outcomeClass, outcomeClass, "-", samples));
  }
  return rows;
}

/**
 * THE OVERALL OUTCOME TAIL: the end-to-end outcome latency percentiles
 * over every execution (the aggregate line — always accompanied by the
 * decompositions above, never alone).
 */
export function overallOutcomePercentiles(
  outcomes: readonly { readonly outcomeClass: string; readonly outcomeLatencyMs: number }[],
): PercentileRow {
  return rowOf(
    "overall",
    "overall",
    "-",
    outcomes.map((outcome) => outcome.outcomeLatencyMs),
  );
}

/**
 * THE RESOLVED-OUTCOME TAIL: the end-to-end latency percentiles over
 * the SUCCESSFUL outcomes only — the capstone's own latency-tail
 * definition (quoted: "Successful-outcome end-to-end task latency over
 * N resolved task(s)") — the pool the promotion gate's T1 leg judges;
 * the resolution-honesty leg (T2) guards the no-failure-hiding side of
 * this pool (a configuration may never improve it by dropping
 * resolutions).
 */
export function resolvedOutcomePercentiles(
  outcomes: readonly { readonly outcomeClass: string; readonly outcomeLatencyMs: number }[],
): PercentileRow {
  const resolved = outcomes.filter((outcome) => outcome.outcomeClass !== "failed-terminal");
  return rowOf(
    "resolved-overall",
    "resolved-overall",
    "-",
    resolved.map((outcome) => outcome.outcomeLatencyMs),
  );
}

/**
 * THE ENCOUNTERED-CLASS OUTCOME TAIL: for every member of the closed
 * failure taxonomy, the end-to-end outcome latency percentiles of the
 * executions whose legs ENCOUNTERED that class (the tail each failure
 * class produces at the outcome level).
 */
export function outcomePercentilesByEncounteredClass(
  outcomes: readonly {
    readonly outcomeLatencyMs: number;
    readonly facts: OutcomeLatencyFacts;
  }[],
): readonly PercentileRow[] {
  const pools = new Map<string, number[]>();
  for (const outcome of outcomes) {
    const encountered = new Set<string>();
    for (const leg of outcome.facts.legs) {
      if (leg.failureClass !== undefined && leg.failureClass !== null) {
        encountered.add(leg.failureClass);
      }
    }
    for (const failureClass of encountered) {
      const pool = pools.get(failureClass) ?? [];
      pool.push(outcome.outcomeLatencyMs);
      pools.set(failureClass, pool);
    }
  }
  const rows: PercentileRow[] = [];
  for (const failureClass of OUTCOME_FAILURE_CLASSES) {
    rows.push(rowOf(failureClass, failureClass, "-", pools.get(failureClass) ?? []));
  }
  return rows;
}

/** The failure classes actually encountered across a set of facts (attribution). */
export function encounteredFailureClasses(
  factsBlocks: readonly OutcomeLatencyFacts[],
): readonly OutcomeFailureClass[] {
  const encountered = new Set<OutcomeFailureClass>();
  for (const facts of factsBlocks) {
    for (const leg of facts.legs) {
      if (leg.failureClass !== undefined && leg.failureClass !== null) {
        encountered.add(leg.failureClass);
      }
    }
  }
  return OUTCOME_FAILURE_CLASSES.filter((failureClass) => encountered.has(failureClass));
}
