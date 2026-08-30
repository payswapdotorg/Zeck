/**
 * Stage 4 — Compression (context module; WORK-008 / CTX-001).
 *
 * Deterministic, lossy-but-accounted size discipline with NO floating
 * point and NO randomness:
 *  1. per-item budget: content longer than `perItemCharBudget` is
 *     truncated to `budget - 3` characters + a literal `...` marker
 *     (ASCII, locale-independent); `truncated` flags the loss;
 *  2. total budget: if the sum still exceeds `totalCharBudget`, the
 *     LOWEST-RANKED items (tail of the deterministic ranking) are dropped
 *     entirely, one at a time, until the budget holds; every drop is
 *     recorded. Source references of surviving items are ALWAYS preserved
 *     — provenance is never compressed away (CTX-002).
 */

import type { RankedCandidate } from "./relevance";

export interface CompressionStageInput {
  readonly ranked: readonly RankedCandidate[];
  readonly policy: { readonly perItemCharBudget: number; readonly totalCharBudget: number };
}

export interface CompressedItem {
  readonly sourceId: string;
  readonly locator: string;
  readonly title: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly originalChars: number;
  readonly compressedChars: number;
}

export interface CompressionStageOutput {
  readonly items: readonly CompressedItem[];
  readonly inputChars: number;
  readonly outputChars: number;
  /** Ranked items dropped entirely by the total-budget rule (tail first). */
  readonly droppedLocators: readonly string[];
}

const ELLIPSIS = "...";

function truncate(content: string, budget: number): { content: string; truncated: boolean } {
  if (content.length <= budget) {
    return { content, truncated: false };
  }
  const keep = Math.max(0, budget - ELLIPSIS.length);
  return { content: `${content.slice(0, keep)}${ELLIPSIS}`, truncated: true };
}

export function applyCompressionStage(input: CompressionStageInput): CompressionStageOutput {
  const perItem: CompressedItem[] = input.ranked.map((item) => {
    const compressed = truncate(item.candidate.content, input.policy.perItemCharBudget);
    return {
      sourceId: item.candidate.sourceId,
      locator: item.candidate.locator,
      title: item.candidate.title,
      content: compressed.content,
      truncated: compressed.truncated,
      originalChars: item.candidate.content.length,
      compressedChars: compressed.content.length,
    };
  });

  const inputChars = perItem.reduce((sum, item) => sum + item.originalChars, 0);
  const droppedLocators: string[] = [];

  let items = perItem;
  let outputChars = items.reduce((sum, item) => sum + item.compressedChars, 0);
  while (outputChars > input.policy.totalCharBudget && items.length > 0) {
    const dropped = items[items.length - 1];
    if (dropped === undefined) {
      break;
    }
    droppedLocators.unshift(`${dropped.sourceId}\u0000${dropped.locator}`);
    items = items.slice(0, -1);
    outputChars = items.reduce((sum, item) => sum + item.compressedChars, 0);
  }

  return { items, inputChars, outputChars, droppedLocators };
}
