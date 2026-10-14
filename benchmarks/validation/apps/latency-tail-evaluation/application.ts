/**
 * The latency-tail-evaluation application (PCL-003 — the evaluation's
 * composed entry).
 *
 * Runs the two-configuration paced replay evaluation over the complete
 * PPR-027 latency-cell sweep (102 cells): per cell, both arms
 * (baseline-today / tail-tuned-v1) replay FRESH over the same corpus
 * and the same arm-agnostic deterministic draws; the per-cell results
 * aggregate into the program-level evidence (the per-failure-class
 * percentile tables, the cost truth, the resolution honesty, the
 * mechanical promotion gate) and the evaluation digest.
 *
 * This is the application an evaluation operator invokes (the benchmark
 * app's run entry in the established pattern); `run.ts` is the CLI that
 * persists the artifacts under `experiments/pcl-003/results/`.
 */

import { createNodeDigestPort, type DigestPort } from "./canonical";
import { pinnedEvaluationCorpusDigest } from "./corpus";
import {
  aggregateEvaluation,
  type CellEvaluationResult,
  declaredThresholdsDigest,
  type EvaluationAggregate,
  evaluationCells,
  loadDeclaredThresholds,
  runEvaluationCell,
} from "./driver";
import type { PacingResolverFactory } from "./pacing";

/** The evaluation application's run options. */
export interface EvaluationRunOptions {
  /** The cells (defaults to the capstone's complete 102-cell enumeration). */
  readonly cells?: ReturnType<typeof evaluationCells>;
  /** The injected digest port (defaults to the node sha256 adapter). */
  readonly digest?: DigestPort;
  /**
   * The injected pacing resolver factory (defaults to the app-local
   * mirror). The test suites inject the REAL PCL-002 seam factory and
   * require the byte-identical evaluation digest — the mirror pin.
   */
  readonly resolverFactory?: PacingResolverFactory;
  /** Progress callback (per completed cell). */
  readonly onCell?: (result: CellEvaluationResult, index: number, total: number) => void;
}

/** The evaluation application's full result. */
export interface EvaluationRunResult {
  readonly aggregate: EvaluationAggregate;
  readonly corpusDigest: string;
  readonly cells: readonly CellEvaluationResult[];
  readonly runStartedAt: string;
}

/**
 * Run the two-configuration paced replay evaluation over the complete
 * latency-cell sweep: every cell's both arms FRESH at this revision,
 * the aggregation, the mechanical promotion gate, and the evaluation
 * digest. Deterministic by construction: the same cells, resolver and
 * digest always produce the byte-identical aggregate (wall-clock and
 * run identities excluded from every digest projection).
 */
export async function runLatencyTailEvaluation(
  options: EvaluationRunOptions = {},
): Promise<EvaluationRunResult> {
  const digest = options.digest ?? createNodeDigestPort();
  const cells = options.cells ?? evaluationCells();
  const thresholds = loadDeclaredThresholds();
  const corpusDigest = pinnedEvaluationCorpusDigest(digest);
  const thresholdsDigest = declaredThresholdsDigest(digest);
  const runStartedAt = new Date().toISOString();
  const results: CellEvaluationResult[] = [];
  for (const [index, cell] of cells.entries()) {
    const result = runEvaluationCell(cell, {
      thresholds,
      digest,
      ...(options.resolverFactory === undefined
        ? {}
        : { resolverFactory: options.resolverFactory }),
    });
    results.push(result);
    options.onCell?.(result, index + 1, cells.length);
  }
  return {
    aggregate: aggregateEvaluation(results, { corpusDigest, thresholds, thresholdsDigest, digest }),
    corpusDigest,
    cells: results,
    runStartedAt,
  };
}
