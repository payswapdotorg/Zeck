/**
 * The economic-recovery-plan-evaluation application (PCR-003 — the
 * evaluation's composed entry).
 *
 * Runs the three-arm replay evaluation over the targeted multi-provider
 * cells: per cell, all three arms (un-retried direct / strong-optimized
 * / mediated-with-plan) run FRESH at ONE revision in ONE process over
 * the same corpus and the same arm-agnostic deterministic synthetic
 * supply (the exact-revision rule); the per-cell results aggregate into
 * the threshold verdicts (ACR-008 §7) and the evaluation digest.
 *
 * This is the application a customer/evaluation operator invokes (the
 * benchmark app's run entry in the established pattern); `run.ts` is
 * the CLI that persists the artifacts under `results/`.
 */

import { type EvaluationCell, pinnedEvaluationCorpusDigest, TARGETED_CELLS } from "./corpus";
import {
  aggregateEvaluation,
  type CellEvaluationResult,
  type ComposedRecoveryPlan,
  type EvaluationAggregate,
  runEvaluationCell,
} from "./driver";

/** The evaluation application's run options. */
export interface EvaluationRunOptions {
  /** The targeted cells (defaults to the pinned corpus's complete multi-provider family). */
  readonly cells?: readonly EvaluationCell[];
  /** The injected clock (ISO strings; wall-clock timestamps only — excluded from digests). */
  readonly now?: () => string;
  /** Progress callback (per completed cell). */
  readonly onCell?: (result: CellEvaluationResult, index: number, total: number) => void;
  /**
   * The plan-artifact validation hook (the hard gate's plan-artifact leg).
   * ABSENT at the standalone run — carried IN-SUITE instead (the test
   * suites inject the recovery plane's own total validation over every
   * composed plan of the full evaluation; the deterministic-replay
   * identity makes it a validation of the committed evidence — see the
   * threshold report's T3 basis).
   */
  readonly planArtifactValidator?: (plan: ComposedRecoveryPlan) => void;
}

/** The evaluation application's full result. */
export interface EvaluationRunResult {
  readonly aggregate: EvaluationAggregate;
  readonly corpusDigest: string;
  readonly runStartedAt: string;
}

/**
 * Run the three-arm replay evaluation over the targeted cells: every
 * cell's three arms FRESH at this revision, the aggregation and the
 * threshold verdicts. Deterministic by construction: the same cells
 * always produce the same digests (the per-attempt evidence is
 * self-verifying against the transport's pure draw functions).
 */
export async function runRecoveryPlanEvaluation(
  options: EvaluationRunOptions = {},
): Promise<EvaluationRunResult> {
  const cells = options.cells ?? TARGETED_CELLS;
  const now = options.now ?? (() => new Date().toISOString());
  const runStartedAt = now();
  const results: CellEvaluationResult[] = [];
  for (const [index, cell] of cells.entries()) {
    const result = await runEvaluationCell({
      cell,
      now,
      ...(options.planArtifactValidator === undefined
        ? {}
        : { planArtifactValidator: options.planArtifactValidator }),
    });
    results.push(result);
    options.onCell?.(result, index + 1, cells.length);
  }
  return {
    aggregate: aggregateEvaluation(results),
    corpusDigest: pinnedEvaluationCorpusDigest(),
    runStartedAt,
  };
}
