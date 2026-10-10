/**
 * PPR-027 — the observed-distributions analysis (the study's read-out over
 * the committed cell results).
 *
 * This module is PURE: it reads nothing, writes nothing — it derives the
 * observed distributions, axis views, the maturity view and the honest
 * weakness tallies from the cell results the sweep committed. Every number
 * it emits is an OBSERVED value from this sandbox's runs (the honest
 * measurement law) or a median over observed per-cell values — never a
 * scenario, never a projection.
 *
 * Cost figures are synthetic micro-USD under the declared price schedule
 * (experiment configuration — never provider invoices); the cost per
 * resolved outcome is FAILURE-ADJUSTED by construction (the numerator
 * includes the cost of failed attempts, the denominator only resolved
 * tasks — the work order's quality-adjusted and failure-adjusted cost at
 * the corpus's own mechanical success definition).
 */

import type { CellResult } from "./sweep";

/** One arm's totals over a set of cells. */
export interface ArmTotals {
  readonly attempts: number;
  readonly resolved: number;
  /** The resolved-task rate (0-1, observed). */
  readonly resolvedRate: number;
  readonly providerFaults: number;
  readonly retries: number;
  readonly nanoCost: number;
  /** Synthetic micro-USD per resolved task (failure-adjusted; null if none resolved). */
  readonly microPerResolved: number | null;
}

/** One axis slice's view (volume / providerConfig / modality / maturity). */
export interface AxisSlice {
  readonly label: string;
  readonly cells: number;
  readonly zeck: ArmTotals;
  readonly direct: ArmTotals;
  readonly optimized: ArmTotals;
  /** The median over the slice's cells of the zeck arm's micro per resolved. */
  readonly zeckMicroMedian: number | null;
  readonly directMicroMedian: number | null;
  readonly optimizedMicroMedian: number | null;
}

export interface PerSubjectRollup {
  readonly subjectId: string;
  readonly cells: number;
  readonly zeck: ArmTotals;
  readonly direct: ArmTotals;
  readonly optimized: ArmTotals;
  readonly zeckMicroMedian: number | null;
}

export interface ObservedDistributions {
  readonly version: 1;
  readonly cells: number;
  readonly overall: {
    readonly zeck: ArmTotals;
    readonly direct: ArmTotals;
    readonly optimized: ArmTotals;
  };
  readonly reuse: {
    readonly requests: number;
    readonly replays: number;
    readonly replayRate: number;
  };
  readonly telemetry: {
    readonly traces: number;
    readonly correlated: number;
    readonly reconstructible: number;
  };
  readonly canary: { readonly cells: number; readonly blocked: number };
  readonly byVolume: readonly AxisSlice[];
  readonly byProviderConfig: readonly AxisSlice[];
  readonly byModality: readonly AxisSlice[];
  readonly maturityView: readonly AxisSlice[];
  readonly perSubject: readonly PerSubjectRollup[];
  readonly honestWeaknesses: {
    readonly cellsWithZeckTaskFailures: number;
    readonly cellsWhereABaselineResolvedMore: number;
    readonly cellsWhereDirectResolvedMore: number;
    readonly zeckVsOptimizedResolutionGap: number;
    readonly cellIdsWhereABaselineResolvedMore: readonly string[];
  };
}

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function armTotalsOf(
  cells: readonly CellResult[],
  arm: "zeck" | "direct" | "optimized",
): ArmTotals {
  let attempts = 0;
  let resolved = 0;
  let faults = 0;
  let retries = 0;
  let nanoCost = 0;
  for (const cell of cells) {
    if (arm === "zeck") {
      attempts += cell.zeck.outcomes.attempts;
      resolved += cell.zeck.outcomes.successes;
      faults += cell.zeck.providerFaults;
      retries += cell.zeck.policyRetries;
      nanoCost += cell.zeck.nanoCost;
    } else {
      const baseline = cell.baselines[arm];
      attempts += baseline.tasksTotal;
      resolved += baseline.tasksResolved;
      faults += baseline.providerFaults;
      if (arm === "optimized") {
        retries += baseline.appOwnedRetries;
      }
      nanoCost += baseline.nanoCost;
    }
  }
  return {
    attempts,
    resolved,
    resolvedRate: attempts === 0 ? 0 : resolved / attempts,
    providerFaults: faults,
    retries,
    nanoCost,
    microPerResolved: resolved === 0 ? null : nanoCost / 1000 / resolved,
  };
}

function microMediansOf(cells: readonly CellResult[]): {
  zeck: number | null;
  direct: number | null;
  optimized: number | null;
} {
  return {
    zeck: medianOf(
      cells.map((cell) => cell.zeck.microPerResolved).filter((v): v is number => v !== null),
    ),
    direct: medianOf(
      cells
        .map((cell) => cell.baselines.direct.microPerResolved)
        .filter((v): v is number => v !== null),
    ),
    optimized: medianOf(
      cells
        .map((cell) => cell.baselines.optimized.microPerResolved)
        .filter((v): v is number => v !== null),
    ),
  };
}

function sliceOf(label: string, cells: readonly CellResult[]): AxisSlice {
  const medians = microMediansOf(cells);
  return {
    label,
    cells: cells.length,
    zeck: armTotalsOf(cells, "zeck"),
    direct: armTotalsOf(cells, "direct"),
    optimized: armTotalsOf(cells, "optimized"),
    zeckMicroMedian: medians.zeck,
    directMicroMedian: medians.direct,
    optimizedMicroMedian: medians.optimized,
  };
}

/** The three named maturity points (the config's declared operational views). */
const MATURITY_POINTS: readonly {
  readonly maturity: string;
  readonly volume: CellResult["dimensions"]["volume"];
  readonly providerConfig: CellResult["dimensions"]["providerConfig"];
  readonly modality: CellResult["dimensions"]["modality"];
  readonly label: string;
}[] = [
  { maturity: "early", volume: "S", providerConfig: "single", modality: "mono", label: "early" },
  { maturity: "growing", volume: "M", providerConfig: "multi", modality: "full", label: "growing" },
  { maturity: "mature", volume: "L", providerConfig: "multi", modality: "full", label: "mature" },
];

/** Derive the full observed-distributions read-out from the committed cells. */
export function computeObservedDistributions(cells: readonly CellResult[]): ObservedDistributions {
  const requests = cells.reduce((sum, cell) => sum + cell.zeck.reuse.requests, 0);
  const replays = cells.reduce((sum, cell) => sum + cell.zeck.reuse.replays, 0);
  const traces = cells.reduce((sum, cell) => sum + cell.zeck.telemetry.traces, 0);
  const correlated = cells.reduce((sum, cell) => sum + cell.zeck.telemetry.correlated, 0);
  const reconstructible = cells.reduce((sum, cell) => sum + cell.zeck.telemetry.reconstructible, 0);

  const subjectIds = [...new Set(cells.map((cell) => cell.subject))].sort();
  const cellsWhereABaselineResolvedMore = cells
    .filter(
      (cell) =>
        Math.max(cell.baselines.direct.tasksResolved, cell.baselines.optimized.tasksResolved) >
        cell.zeck.outcomes.successes,
    )
    .map((cell) => cell.cellId);

  const overallZeck = armTotalsOf(cells, "zeck");
  const overallOptimized = armTotalsOf(cells, "optimized");

  return {
    version: 1,
    cells: cells.length,
    overall: {
      zeck: overallZeck,
      direct: armTotalsOf(cells, "direct"),
      optimized: overallOptimized,
    },
    reuse: { requests, replays, replayRate: requests === 0 ? 0 : replays / requests },
    telemetry: { traces, correlated, reconstructible },
    canary: {
      cells: cells.length,
      blocked: cells.filter((cell) => cell.canary.blocked && cell.canary.observed).length,
    },
    byVolume: (["S", "M", "L"] as const).map((volume) =>
      sliceOf(
        `volume ${volume}`,
        cells.filter((cell) => cell.dimensions.volume === volume),
      ),
    ),
    byProviderConfig: (["single", "multi"] as const).map((providerConfig) =>
      sliceOf(
        `providerConfig ${providerConfig}`,
        cells.filter((cell) => cell.dimensions.providerConfig === providerConfig),
      ),
    ),
    byModality: (["mono", "full"] as const).map((modality) =>
      sliceOf(
        `modality ${modality}`,
        cells.filter((cell) => cell.dimensions.modality === modality),
      ),
    ),
    maturityView: MATURITY_POINTS.map((point) =>
      sliceOf(
        point.label,
        cells.filter(
          (cell) =>
            cell.dimensions.volume === point.volume &&
            cell.dimensions.providerConfig === point.providerConfig &&
            cell.dimensions.modality === point.modality,
        ),
      ),
    ),
    perSubject: subjectIds.map((subjectId) => {
      const subjectCells = cells.filter((cell) => cell.subject === subjectId);
      return {
        subjectId,
        cells: subjectCells.length,
        zeck: armTotalsOf(subjectCells, "zeck"),
        direct: armTotalsOf(subjectCells, "direct"),
        optimized: armTotalsOf(subjectCells, "optimized"),
        zeckMicroMedian: microMediansOf(subjectCells).zeck,
      };
    }),
    honestWeaknesses: {
      cellsWithZeckTaskFailures: cells.filter((cell) => cell.zeck.outcomes.failures > 0).length,
      cellsWhereABaselineResolvedMore: cellsWhereABaselineResolvedMore.length,
      cellsWhereDirectResolvedMore: cells.filter(
        (cell) => cell.baselines.direct.tasksResolved > cell.zeck.outcomes.successes,
      ).length,
      zeckVsOptimizedResolutionGap: overallOptimized.resolved - overallZeck.resolved,
      cellIdsWhereABaselineResolvedMore: cellsWhereABaselineResolvedMore,
    },
  };
}
