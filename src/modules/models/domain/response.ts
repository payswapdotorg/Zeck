/**
 * Provider-neutral model response contracts (models module domain).
 *
 * Adapters normalize every provider's response into this shape, including
 * usage/cost accounting (`spec/architecture.md` §12 "pricing/usage").
 */

import type { StopReason } from "./request";

/** Normalized token/cost accounting. Unknown values are null, never zero-invented. */
export interface NormalizedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number | null;
  /** Provider-reported cost in USD when the rail reports it (aggregation rails do). */
  readonly costUsd: number | null;
}

/** A schema-conforming structured output, parsed out of the provider response. */
export interface NormalizedStructuredOutput {
  readonly name: string;
  readonly json: Readonly<Record<string, unknown>>;
}

export interface ModelResponse {
  /** Text parts in delivery order (empty when only structured output was produced). */
  readonly content: readonly string[];
  readonly stopReason: StopReason;
  readonly structuredOutput: NormalizedStructuredOutput | null;
  readonly usage: NormalizedUsage;
  /** Provider-side latency in milliseconds as measured by the adapter. */
  readonly providerLatencyMs: number | null;
}

export const EMPTY_USAGE: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUsd: null,
};
