/**
 * Rubric evaluation (VAL-008, acceptance criterion 3).
 *
 * Scores the corpus quality rubrics from INJECTED judge verdicts: the
 * engine owns the weighting, thresholding and bookkeeping; the judge
 * (an LLM or a human) owns the per-criterion scores. Reproducibility
 * comes from recording the judge identity and configuration digest
 * with every rubric evaluation — two evaluations with the same judge
 * config and the same verdicts produce the same score.
 */

import type { QualityCriterion } from "../corpus/schema";

/** One judge verdict for one criterion (score in [0,1] + rationale). */
export interface JudgeVerdict {
  readonly criterion: string;
  readonly score: number;
  readonly rationale: string;
}

/** The judge identity + configuration (recorded per evaluation). */
export interface JudgeConfiguration {
  readonly judgeId: string;
  /** Digest of the full judge configuration (prompt, model, version). */
  readonly configurationDigest: string;
}

/** One rubric evaluation result. */
export interface RubricEvaluation {
  readonly score: number;
  readonly threshold: number;
  readonly passed: boolean;
  readonly perCriterion: readonly {
    readonly criterion: string;
    readonly weight: number;
    readonly score: number;
    readonly rationale: string;
  }[];
  readonly judge: JudgeConfiguration;
}

/**
 * Evaluate a rubric: every criterion must carry exactly one judge
 * verdict with a score in [0,1]; the weighted sum is compared to the
 * threshold. A missing or out-of-range verdict REJECTS the evaluation
 * (never silently skipped).
 */
export function evaluateRubric(
  rubric: readonly QualityCriterion[],
  verdicts: readonly JudgeVerdict[],
  judge: JudgeConfiguration,
  threshold: number,
): RubricEvaluation {
  if (rubric.length === 0) {
    throw new Error("a rubric evaluation requires at least one criterion");
  }
  if (typeof judge.configurationDigest !== "string" || judge.configurationDigest.length === 0) {
    throw new Error("a rubric evaluation requires the judge configuration digest");
  }
  const perCriterion = rubric.map((criterion) => {
    const verdict = verdicts.find((candidate) => candidate.criterion === criterion.name);
    if (verdict === undefined) {
      throw new Error(`missing judge verdict for criterion "${criterion.name}"`);
    }
    if (typeof verdict.score !== "number" || verdict.score < 0 || verdict.score > 1) {
      throw new Error(`judge verdict for "${criterion.name}" must score in [0,1]`);
    }
    return {
      criterion: criterion.name,
      weight: criterion.weight,
      score: verdict.score,
      rationale: verdict.rationale,
    };
  });
  const score = perCriterion.reduce((sum, entry) => sum + entry.weight * entry.score, 0);
  return {
    score,
    threshold,
    passed: score >= threshold,
    perCriterion,
    judge,
  };
}
