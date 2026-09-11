/**
 * Report feed (VAL-006, acceptance criterion 5): accounting outputs
 * feed the cumulative validation report's economic sections
 * mechanically — structured entries plus the markdown table rows the
 * report template consumes.
 */

import type { ArmAggregate } from "./aggregate";

/** One economic report entry (the structured feed). */
export interface EconomicReportEntry {
  readonly arm: string;
  readonly corpusSlice: string;
  readonly runs: number;
  readonly resolved: number;
  readonly resolutionRate: string;
  readonly resolutionConfidence: string;
  readonly measuredCostMicroUsd: string;
  readonly estimatedCostMicroUsd: string;
  readonly costPerResolvedMicroUsd: string;
  readonly latencyMeanMs: number;
  readonly latencyP95Ms: number;
}

/** Convert an aggregate into the report entry. */
export function economicEntryOf(aggregate: ArmAggregate): EconomicReportEntry {
  return {
    arm: aggregate.arm,
    corpusSlice: aggregate.corpusSlice,
    runs: aggregate.runCount,
    resolved: aggregate.resolvedCount,
    resolutionRate: aggregate.resolutionRate.toFixed(3),
    resolutionConfidence: `[${aggregate.resolutionConfidence.low.toFixed(3)}, ${aggregate.resolutionConfidence.high.toFixed(3)}]`,
    measuredCostMicroUsd: aggregate.measuredCostMicroUsd,
    estimatedCostMicroUsd: aggregate.estimatedCostMicroUsd,
    costPerResolvedMicroUsd:
      aggregate.costPerResolvedMicroUsd === null
        ? "n/a (no resolved outcomes — never estimate-backed)"
        : aggregate.costPerResolvedMicroUsd,
    latencyMeanMs: Math.round(aggregate.latency.mean),
    latencyP95Ms: Math.round(aggregate.latency.p95),
  };
}

/** The markdown table rows for the cumulative report's economic section. */
export function economicMarkdownRows(entries: readonly EconomicReportEntry[]): string[] {
  const header =
    "| Arm | Slice | Runs | Resolved | Resolution (95% CI) | Measured µ$ | Estimated µ$ | µ$/resolved | Latency mean/p95 |";
  const separator = "|---|---|---:|---:|---|---:|---:|---:|---|";
  const rows = entries.map(
    (entry) =>
      `| ${entry.arm} | ${entry.corpusSlice} | ${entry.runs} | ${entry.resolved} | ` +
      `${entry.resolutionRate} ${entry.resolutionConfidence} | ${entry.measuredCostMicroUsd} | ` +
      `${entry.estimatedCostMicroUsd} | ${entry.costPerResolvedMicroUsd} | ` +
      `${entry.latencyMeanMs}ms / ${entry.latencyP95Ms}ms |`,
  );
  return [header, separator, ...rows];
}
