/**
 * PPR-027 hermetic tests — the observed-distributions analysis over
 * synthetic cell fixtures (pure function verification; the real committed
 * cells are covered by the analyze step and the evidence record).
 */

import { describe, expect, it } from "vitest";
import { computeObservedDistributions } from "../analysis";
import type { CellResult } from "../sweep";

function cellOf(overrides: {
  cellId: string;
  subject: string;
  volume: "S" | "M" | "L";
  providerConfig: "single" | "multi";
  modality: "mono" | "full";
  zeck: {
    attempts: number;
    successes: number;
    failures?: number;
    nano: number;
    faults?: number;
    retries?: number;
    replays?: number;
    requests?: number;
    microPerResolved?: number | null;
  };
  direct: { resolved: number; total: number; nano: number; microPerResolved?: number | null };
  optimized: { resolved: number; total: number; nano: number; microPerResolved?: number | null };
}): CellResult {
  const latency = { samples: 1, medianMs: 10, p95Ms: 20, meanMs: 10 };
  return {
    cellId: overrides.cellId,
    subject: overrides.subject,
    dimensions: {
      volume: overrides.volume,
      repetitions: 1,
      providerConfig: overrides.providerConfig,
      modality: overrides.modality,
      modalityDegenerate: false,
    },
    corpus: { tasks: overrides.zeck.attempts, requests: overrides.zeck.attempts },
    zeck: {
      outcomes: {
        attempts: overrides.zeck.attempts,
        successes: overrides.zeck.successes,
        failures: overrides.zeck.failures ?? overrides.zeck.attempts - overrides.zeck.successes,
        notRun: 0,
        bypass: 0,
      },
      latency,
      inputTokens: 100,
      outputTokens: 10,
      nanoCost: overrides.zeck.nano,
      microPerResolved: overrides.zeck.microPerResolved ?? null,
      requestFailures: overrides.zeck.failures ?? 0,
      policyRetries: overrides.zeck.retries ?? 0,
      providerFaults: overrides.zeck.faults ?? 0,
      reuse: { requests: overrides.zeck.requests ?? 1, replays: overrides.zeck.replays ?? 0 },
      telemetry: { traces: 1, correlated: 1, reconstructible: 1 },
      measurements: { entries: [] },
    },
    baselines: {
      direct: {
        kind: "direct-baseline",
        label: "BASELINE direct-baseline (never Zeck evidence)",
        tasksResolved: overrides.direct.resolved,
        tasksTotal: overrides.direct.total,
        latency,
        inputTokens: 100,
        outputTokens: 10,
        nanoCost: overrides.direct.nano,
        microPerResolved: overrides.direct.microPerResolved ?? null,
        appOwnedRetries: 0,
        providerFaults: 0,
        cacheHits: null,
      },
      optimized: {
        kind: "optimized-baseline",
        label: "BASELINE optimized-baseline (never Zeck evidence)",
        tasksResolved: overrides.optimized.resolved,
        tasksTotal: overrides.optimized.total,
        latency,
        inputTokens: 100,
        outputTokens: 10,
        nanoCost: overrides.optimized.nano,
        microPerResolved: overrides.optimized.microPerResolved ?? null,
        appOwnedRetries: 0,
        providerFaults: 0,
        cacheHits: 0,
      },
    },
    canary: { host: "api.openai.com", blocked: true, observed: true },
    wallMs: 1,
    notes: [],
  };
}

describe("the observed-distributions analysis", () => {
  const cells: CellResult[] = [
    cellOf({
      cellId: "aider-S-single-mono",
      subject: "aider",
      volume: "S",
      providerConfig: "single",
      modality: "mono",
      zeck: { attempts: 5, successes: 5, nano: 50_000, microPerResolved: 10 },
      direct: { resolved: 3, total: 5, nano: 150_000, microPerResolved: 100 },
      optimized: { resolved: 5, total: 5, nano: 40_000, microPerResolved: 8 },
    }),
    cellOf({
      cellId: "aider-L-multi-full",
      subject: "aider",
      volume: "L",
      providerConfig: "multi",
      modality: "full",
      zeck: {
        attempts: 10,
        successes: 9,
        nano: 90_000,
        replays: 5,
        requests: 20,
        faults: 2,
        retries: 2,
        microPerResolved: 10,
      },
      direct: { resolved: 4, total: 10, nano: 400_000, microPerResolved: 100 },
      optimized: { resolved: 10, total: 10, nano: 80_000, microPerResolved: 8 },
    }),
  ];

  const distributions = computeObservedDistributions(cells);

  it("aggregates the arms' totals over all cells", () => {
    expect(distributions.cells).toBe(2);
    expect(distributions.overall.zeck.attempts).toBe(15);
    expect(distributions.overall.zeck.resolved).toBe(14);
    expect(distributions.overall.zeck.resolvedRate).toBeCloseTo(14 / 15, 10);
    expect(distributions.overall.zeck.nanoCost).toBe(140_000);
    // Failure-adjusted micro per resolved: 140 micro over 14 resolved.
    expect(distributions.overall.zeck.microPerResolved).toBeCloseTo(10, 10);
    expect(distributions.overall.direct.resolved).toBe(7);
    expect(distributions.overall.optimized.resolved).toBe(15);
  });

  it("computes the reuse rate over the committed reuse facts", () => {
    expect(distributions.reuse.requests).toBe(21);
    expect(distributions.reuse.replays).toBe(5);
    expect(distributions.reuse.replayRate).toBeCloseTo(5 / 21, 10);
  });

  it("slices by volume, provider configuration and modality", () => {
    expect(distributions.byVolume.map((slice) => slice.cells)).toEqual([1, 0, 1]);
    expect(distributions.byProviderConfig.map((slice) => slice.cells)).toEqual([1, 1]);
    expect(distributions.byModality.map((slice) => slice.cells)).toEqual([1, 1]);
    const large = distributions.byVolume.find((slice) => slice.label === "volume L");
    expect(large?.zeck.resolved).toBe(9);
  });

  it("builds the maturity view over the named operational points", () => {
    // early = S/single/mono, growing = M/multi/full, mature = L/multi/full.
    expect(distributions.maturityView.map((slice) => slice.cells)).toEqual([1, 0, 1]);
    expect(distributions.maturityView[0]?.zeck.resolved).toBe(5);
    expect(distributions.maturityView[2]?.zeck.resolved).toBe(9);
  });

  it("tallies the honest weaknesses, including where a baseline resolved more", () => {
    expect(distributions.honestWeaknesses.cellsWithZeckTaskFailures).toBe(1);
    expect(distributions.honestWeaknesses.cellsWhereABaselineResolvedMore).toBe(1);
    expect(distributions.honestWeaknesses.cellIdsWhereABaselineResolvedMore).toEqual([
      "aider-L-multi-full",
    ]);
    expect(distributions.honestWeaknesses.zeckVsOptimizedResolutionGap).toBe(1);
  });

  it("counts only observed-and-blocked canaries", () => {
    expect(distributions.canary).toEqual({ cells: 2, blocked: 2 });
  });
});
