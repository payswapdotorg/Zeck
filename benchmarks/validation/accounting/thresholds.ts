/**
 * Resolution thresholds (VAL-006, acceptance criterion 2).
 *
 * An outcome counts as SUCCESSFULLY RESOLVED only when the quality,
 * safety, reliability and latency thresholds pass — thresholds are
 * DECLARED (per corpus task where the corpus states them, otherwise
 * program defaults) BEFORE aggregation. A failed evaluation, a
 * retryable-error run or a latency breach is never a resolved outcome.
 */

import type { GoldenTask } from "../corpus/schema";
import type { EvaluationResult } from "../evaluation/evaluate";

/** The program-default resolution thresholds. */
export const DEFAULT_RESOLUTION_THRESHOLDS = {
  /** The evaluation must fully pass (not fail, not inconclusive). */
  evaluation: "pass" as const,
  /** Maximum total latency for a resolved outcome. */
  maxLatencyMs: 60000,
  /** A resolved outcome surfaces no retryable transport errors. */
  requireNoRetryableErrors: true,
};

/** The per-task thresholds (corpus latency targets override defaults). */
export interface ResolutionThresholds {
  readonly evaluation: "pass";
  readonly maxLatencyMs: number;
  readonly requireNoRetryableErrors: boolean;
}

/** Resolve the thresholds for one corpus task (declared, not invented). */
export function thresholdsFor(task: GoldenTask): ResolutionThresholds {
  return {
    evaluation: "pass",
    maxLatencyMs: task.latencyTargetMs ?? DEFAULT_RESOLUTION_THRESHOLDS.maxLatencyMs,
    requireNoRetryableErrors: DEFAULT_RESOLUTION_THRESHOLDS.requireNoRetryableErrors,
  };
}

/** The facts a resolution decision consumes. */
export interface ResolutionFacts {
  readonly evaluationVerdict: EvaluationResult["verdict"];
  readonly totalLatencyMs: number;
  readonly retryableErrorsSurfaced: number;
  /** Safety observations failed (environment effects not passing). */
  readonly failedSafetyObservations: number;
}

/** Was this run a SUCCESSFULLY RESOLVED outcome under the thresholds? */
export function isResolvedOutcome(
  thresholds: ResolutionThresholds,
  facts: ResolutionFacts,
): boolean {
  if (facts.evaluationVerdict !== thresholds.evaluation) {
    return false;
  }
  if (facts.totalLatencyMs > thresholds.maxLatencyMs) {
    return false;
  }
  if (thresholds.requireNoRetryableErrors && facts.retryableErrorsSurfaced > 0) {
    return false;
  }
  if (facts.failedSafetyObservations > 0) {
    return false;
  }
  return true;
}
