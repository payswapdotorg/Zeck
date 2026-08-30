/**
 * Stage 3 — Deduplication (context module; WORK-008 / CTX-001).
 *
 * Pure collapse over EXACT content equality: candidates whose content is
 * byte-identical are the same piece of context and are collapsed to the
 * highest-ranked survivor (input order is the deterministic relevance
 * ranking). Every collapse is recorded (count + locators) so the manifest
 * statistics can prove the stage ran.
 */

import type { ContextCandidate } from "../source";
import type { RankedCandidate } from "./relevance";

export interface DeduplicationStageInput {
  /** Ranked candidates (output of the relevance stage). */
  readonly ranked: readonly RankedCandidate[];
}

export interface DeduplicationStageOutput {
  readonly unique: readonly RankedCandidate[];
  /** How many candidates were collapsed into survivors. */
  readonly collapsedCount: number;
  /** Locators of the collapsed (dropped) duplicates, deterministic order. */
  readonly collapsedLocators: readonly string[];
}

export function applyDeduplicationStage(input: DeduplicationStageInput): DeduplicationStageOutput {
  const seenContent = new Set<string>();
  const unique: RankedCandidate[] = [];
  const collapsedLocators: string[] = [];
  for (const item of input.ranked) {
    if (seenContent.has(item.candidate.content)) {
      collapsedLocators.push(`${item.candidate.sourceId}\u0000${item.candidate.locator}`);
    } else {
      seenContent.add(item.candidate.content);
      unique.push(item);
    }
  }
  return { unique, collapsedCount: collapsedLocators.length, collapsedLocators };
}

/** Structural check helper reused by tests (candidate identity for dedup). */
export function deduplicationKey(candidate: ContextCandidate): string {
  return candidate.content;
}
