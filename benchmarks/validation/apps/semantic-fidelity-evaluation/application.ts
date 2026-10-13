/**
 * The semantic-fidelity evaluation application (PCS-004 — the
 * evaluation's composed entry).
 *
 * Runs the complete evaluation over the committed corpus (the quality
 * fixtures, the gating controls, the replay lines), aggregates the
 * threshold verdicts and computes the evaluation digest.
 *
 * This is the application a customer/evaluation operator invokes (the
 * benchmark app's run entry in the established pattern); `run.ts` is
 * the CLI that persists the artifacts under `results/`.
 */

import { pinnedEvaluationCorpusDigest } from "./corpus";
import { type EvaluationResult, runEvaluation } from "./driver";

/** The evaluation application's run options. */
export interface EvaluationRunOptions {
  /** The injected clock (ISO strings; wall-clock timestamps only — excluded from digests). */
  readonly now?: () => string;
}

/** The evaluation application's full result. */
export interface EvaluationRunResult {
  readonly result: EvaluationResult;
  readonly corpusDigest: string;
  readonly runStartedAt: string;
}

/**
 * Run the complete semantic-fidelity evaluation. Deterministic by
 * construction: the same committed corpus always produces the same
 * records, verdicts and digests (the re-run comparison in run.ts and
 * the in-suite determinism proof both rely on it).
 */
export function runSemanticFidelityEvaluation(
  options: EvaluationRunOptions = {},
): EvaluationRunResult {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    result: runEvaluation(),
    corpusDigest: pinnedEvaluationCorpusDigest(),
    runStartedAt: now(),
  };
}
