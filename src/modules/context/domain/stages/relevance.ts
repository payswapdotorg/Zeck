/**
 * Stage 2 — Relevance filtering (context module; WORK-008 / CTX-001).
 *
 * Pure integer scoring: a candidate's score is the cardinality of the
 * intersection between the (lowercased) task keyword set and the
 * candidate's term set. No floating point anywhere (determinism
 * discipline). Candidates scoring below the policy minimum are EXCLUDED
 * with a recorded reason; survivors are ranked deterministically
 * (score desc, then the retrieval-stage order).
 */

import { type ContextCandidate, candidateTerms } from "../source";

export interface RelevanceStageInput {
  readonly candidates: readonly ContextCandidate[];
  /** Lowercased task keywords driving the scoring. */
  readonly taskKeywords: readonly string[];
  readonly policy: { readonly minScore: number };
}

export interface RankedCandidate {
  readonly candidate: ContextCandidate;
  readonly score: number;
}

export interface ExcludedCandidate {
  readonly candidate: ContextCandidate;
  readonly score: number;
  readonly reason: "below-minimum-score";
}

export interface RelevanceStageOutput {
  readonly kept: readonly RankedCandidate[];
  readonly excluded: readonly ExcludedCandidate[];
}

export function relevanceScore(candidate: ContextCandidate, keywords: readonly string[]): number {
  const keywordSet = new Set(keywords.map((keyword) => keyword.toLowerCase()));
  let score = 0;
  for (const term of candidateTerms(candidate)) {
    if (keywordSet.has(term)) {
      score += 1;
      keywordSet.delete(term); // each task keyword counts at most once
    }
  }
  return score;
}

export function applyRelevanceStage(input: RelevanceStageInput): RelevanceStageOutput {
  const kept: RankedCandidate[] = [];
  const excluded: ExcludedCandidate[] = [];
  for (const candidate of input.candidates) {
    const score = relevanceScore(candidate, input.taskKeywords);
    if (score >= input.policy.minScore) {
      kept.push({ candidate, score });
    } else {
      excluded.push({ candidate, score, reason: "below-minimum-score" });
    }
  }
  // Deterministic ranking: score desc, then incoming (already sorted) order.
  const order = new Map(input.candidates.map((candidate, i) => [candidate, i] as const));
  kept.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return (order.get(a.candidate) ?? 0) - (order.get(b.candidate) ?? 0);
  });
  return { kept, excluded };
}
