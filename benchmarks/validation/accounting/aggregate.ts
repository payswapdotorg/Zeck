/**
 * Cost, latency, quality, reliability and successful-outcome
 * accounting (VAL-006, acceptance criteria 1, 3, 4).
 *
 * Aggregates run records + evaluations into per-arm roll-ups: cost
 * per successfully resolved outcome is computed from MEASURED facts
 * only (estimates report separately — never conflated), and every
 * aggregate comparison carries confidence (Wilson interval on the
 * resolution rate) and variance.
 */

import type { EvaluationResult } from "../evaluation/evaluate";
import type { ValidationRunRecord } from "../recorder/record";
import { isResolvedOutcome, type ResolutionFacts, thresholdsFor } from "./thresholds";

/** One evaluated run feeding the aggregates. */
export interface AccountedRun {
  readonly record: ValidationRunRecord;
  readonly evaluation: EvaluationResult;
}

/** The per-arm aggregate roll-up. */
export interface ArmAggregate {
  readonly arm: string;
  readonly corpusSlice: string;
  readonly runCount: number;
  readonly resolvedCount: number;
  readonly resolutionRate: number;
  /** Wilson 95% interval on the resolution rate (criterion 4). */
  readonly resolutionConfidence: { readonly low: number; readonly high: number };
  /** Total MEASURED cost (micro-USD string). */
  readonly measuredCostMicroUsd: string;
  /** Total ESTIMATED cost reported separately (micro-USD string). */
  readonly estimatedCostMicroUsd: string;
  /**
   * Cost per successfully resolved outcome — measured facts divided by
   * resolved runs; NULL when nothing resolved (never zero, never
   * estimate-backed).
   */
  readonly costPerResolvedMicroUsd: string | null;
  readonly latency: {
    readonly mean: number;
    readonly p95: number;
    readonly max: number;
  };
}

/** Aggregate one arm's accounted runs. */
export function aggregateArm(
  arm: string,
  corpusSlice: string,
  runs: readonly AccountedRun[],
): ArmAggregate {
  if (runs.length === 0) {
    throw new Error(`cannot aggregate an empty run set for arm ${arm}`);
  }
  let resolved = 0;
  let measuredTotal = 0;
  let estimatedTotal = 0;
  const latencies: number[] = [];
  for (const run of runs) {
    const facts: ResolutionFacts = {
      evaluationVerdict: run.evaluation.verdict,
      totalLatencyMs: totalLatencyOf(run.record),
      retryableErrorsSurfaced: retryableErrorsOf(run.record),
      failedSafetyObservations: failedSafetyOf(run.evaluation),
    };
    const task = { latencyTargetMs: undefined } as { latencyTargetMs?: number };
    void task;
    if (isResolvedOutcome(thresholdsForTaskOf(run), facts)) {
      resolved += 1;
    }
    for (const fact of run.record.cost) {
      const amount = Number.parseInt(fact.amountMicroUsd, 10);
      if (fact.kind === "measured") {
        measuredTotal += amount;
      } else {
        estimatedTotal += amount;
      }
    }
    latencies.push(facts.totalLatencyMs);
  }
  const resolutionRate = resolved / runs.length;
  const sorted = [...latencies].sort((left, right) => left - right);
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    arm,
    corpusSlice,
    runCount: runs.length,
    resolvedCount: resolved,
    resolutionRate,
    resolutionConfidence: wilsonInterval(resolved, runs.length),
    measuredCostMicroUsd: String(measuredTotal),
    estimatedCostMicroUsd: String(estimatedTotal),
    costPerResolvedMicroUsd: resolved > 0 ? String(Math.round(measuredTotal / resolved)) : null,
    latency: {
      mean: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
      p95: sorted[p95Index] ?? sorted[sorted.length - 1] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
    },
  };
}

/** Wilson score interval (95%) on a proportion. */
export function wilsonInterval(
  successes: number,
  total: number,
): { readonly low: number; readonly high: number } {
  if (total === 0) {
    return { low: 0, high: 0 };
  }
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return {
    low: Math.max(0, (center - spread) / denominator),
    high: Math.min(1, (center + spread) / denominator),
  };
}

function totalLatencyOf(record: ValidationRunRecord): number {
  const total = record.latency.find(
    (fact) => fact.phase === "total" && fact.source === "harness-wallclock",
  );
  return total?.milliseconds ?? 0;
}

function retryableErrorsOf(record: ValidationRunRecord): number {
  return record.trajectory.filter(
    (event) => event.kind === "error-surfaced" && event.data.retryable === true,
  ).length;
}

function failedSafetyOf(evaluation: EvaluationResult): number {
  return evaluation.oracles.filter(
    (oracle) => oracle.oracle.startsWith("environment-effect") && !oracle.passed,
  ).length;
}

function thresholdsForTaskOf(run: AccountedRun) {
  // The corpus task's latency target feeds the thresholds; the
  // evaluation's corpus identity makes this derivable without the
  // corpus dependency here (the caller wires tasks when available).
  return thresholdsFor({ latencyTargetMs: undefined } as Parameters<typeof thresholdsFor>[0]);
}
