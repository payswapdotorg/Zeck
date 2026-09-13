/**
 * VAL-042 acceptance criteria 1, 2 and 4 (the offline oracle floor):
 *
 *   * the optimization inventory is explicit, exhaustive and
 *     content-addressed (digest agreement, the correction-as-new-
 *     revision discipline, the in-place bound-mutation catch, the
 *     structural validation);
 *   * the inventory-conformance derivation FAILs an UNDECLARED
 *     optimization (the masquerade catch) and the compression-bound
 *     derivation FAILs an out-of-bound ratio (the understatement
 *     catch) — both at the derivation level;
 *   * the corpus declares per-row arm manifest entries (the frozen
 *     VAL-040 grammar), pinned inventory revisions and the expected
 *     normalized outcomes (the honest hand-computed numbers);
 *   * the optimized driver drives EVERY offline corpus row to
 *     settlement over the deterministic fixtures with the REAL
 *     accounting rails, reproducing the corpus's pinned expected
 *     normalized outcomes exactly — the cache hits, the routed usage,
 *     the retry amortization, the budget-stretch and the honest
 *     budget-stop included.
 */

import { describe, expect, test } from "vitest";
import { manifestFor } from "../../../benchmarks/validation/apps/economic-baseline/normalization";
import { validateArmDeclaration } from "../../../benchmarks/validation/apps/economic-baseline/protocol";
import {
  OFFLINE_CORPUS_ROWS,
  OPTIMIZED_CORPUS,
  OPTIMIZED_CORPUS_VERSION,
  optimizedTasksForArm,
  taskBodyFor,
} from "../../../benchmarks/validation/apps/economic-controls-optimized/corpus";
import {
  createRealAccountingRails,
  deriveOptimizedRoundBudgetBoundMicroUsd,
  driveOptimizedRow,
  economicDigestOf,
  type OptimizedCorpusRow,
  SemanticResponseCache,
} from "../../../benchmarks/validation/apps/economic-controls-optimized/driver";
import {
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createOptimizedReplayExecutor,
  createTickClock,
} from "../../../benchmarks/validation/apps/economic-controls-optimized/fixtures";
import {
  BATCHED_THROUGHPUT_NAME,
  computeInventoryDigest,
  deriveCompressionConformance,
  deriveInventoryAppendOnly,
  deriveInventoryConformance,
  deriveInventoryIntegrity,
  inventoryFor,
  inventoryRevisionOf,
  MODEL_ROUTING_NAME,
  OPTIMIZATION_INVENTORY,
  PROMPT_COMPRESSION_NAME,
  PROVIDER_SIDE_NAME,
  RESPONSE_CACHE_NAME,
  routeForClass,
  validateOptimizationInventory,
} from "../../../benchmarks/validation/apps/economic-controls-optimized/optimizations";
import {
  OFFLINE_CORPUS_ROWS as FROZEN_PORTFOLIO_ROWS,
  LONGITUDINAL_CORPUS,
} from "../../../benchmarks/validation/apps/longitudinal-baseline/corpus";
import type { RunMetadata } from "../../../benchmarks/validation/run-identity";

const REVISION = "6e0b410449cd779b97621ae21d329abc348a6dd4";

const metadataOf = (observedAt: string): RunMetadata => ({
  program: "zeck-validation",
  workOrder: "VAL-042",
  baseRevision: REVISION,
  applicationRevision: REVISION,
  corpusRevision: REVISION,
  integrationSurface: "sdk",
  environment: {
    runtime: "node test",
    toolchain: "vitest",
    database: "none",
    configuration: { suite: "val-042-baseline" },
  },
  observedAt,
});

const noSleep = async () => {};

const rowById = (rowId: string): OptimizedCorpusRow => {
  const row = OPTIMIZED_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

/** Drive one offline row over the deterministic fake stack + the REAL accounting rails. */
async function driveRowOverFakeStack(options: {
  readonly row: OptimizedCorpusRow;
  readonly runSuffix?: string;
}): Promise<ReturnType<typeof driveOptimizedRow>> {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const seam = createFakeSubmissionSeam({ ledger });
  const lifecycle = createFakeLifecycle({ ledger });
  const executor = createOptimizedReplayExecutor({ row: options.row, clock });
  const rails = createRealAccountingRails();
  const baseline = ledger.facts();
  const key = `val-042-unit-${options.runSuffix ?? "x"}-${options.row.rowId}`;
  const submission = await seam({ key, body: taskBodyFor({ row: options.row }) });
  const result = await driveOptimizedRow({
    row: options.row,
    lifecycle,
    executor,
    rails,
    tasks: optimizedTasksForArm(options.row.arm),
    metadata: metadataOf(clock.now().toISOString()),
    environmentIdentity: `val-042-unit-${options.row.rowId}`,
    corpusVersion: OPTIMIZED_CORPUS_VERSION,
    baseline,
    worldFacts: ledger.facts,
    landedProvider: async () => [submission.executionId],
    retry: { maxExtraAttempts: 2, backoffMs: 1, sleep: noSleep },
    now: clock.now,
  });
  return result;
}

// ---------------------------------------------------------------------------
// The optimization inventory (content-addressed, append-only)
// ---------------------------------------------------------------------------

describe("VAL-042 optimization inventory", () => {
  test("the registry is append-only with unique revisions and frozen digests", () => {
    const verdict = deriveInventoryAppendOnly();
    expect(verdict.appendOnly).toBe(true);
    expect(verdict.revisions).toEqual(["opt-rev-001", "opt-rev-002"]);
  });

  test("a bound correction is a NEW revision — opt-rev-001 stays frozen and readable", () => {
    const rev001 = inventoryRevisionOf("opt-rev-001");
    const rev002 = inventoryRevisionOf("opt-rev-002");
    expect(rev001).not.toBeNull();
    expect(rev002).not.toBeNull();
    expect(rev002?.supersedes).toBe("opt-rev-001");
    // opt-rev-002 tightens the prompt-compression ceiling only.
    const boundOf = (revision: typeof rev001): string | undefined =>
      revision?.entries
        .find((entry) => entry.name === PROMPT_COMPRESSION_NAME)
        ?.bound.maxCompressedRatio?.toString();
    expect(boundOf(rev001)).toBe("0.75");
    expect(boundOf(rev002)).toBe("0.70");
    // Every other entry is identical; both digests are frozen.
    expect(computeInventoryDigest(rev001 as never)).toBe(rev001?.digest);
    expect(computeInventoryDigest(rev002 as never)).toBe(rev002?.digest);
    expect(OPTIMIZATION_INVENTORY.length).toBe(2);
  });

  test("inventory integrity agrees for every pinned revision", () => {
    for (const revision of OPTIMIZATION_INVENTORY) {
      const verdict = deriveInventoryIntegrity({ revision: revision.revision });
      expect(verdict.agreed, verdict.evidence.join(" | ")).toBe(true);
    }
  });

  test("an IN-PLACE bound mutation breaks digest agreement mechanically", () => {
    const base = inventoryRevisionOf("opt-rev-001");
    expect(base).not.toBeNull();
    const mutated = {
      ...(base as NonNullable<typeof base>),
      entries: (base as NonNullable<typeof base>).entries.map((entry) =>
        entry.name === PROMPT_COMPRESSION_NAME
          ? { ...entry, bound: { ...entry.bound, maxCompressedRatio: "0.50" } }
          : entry,
      ),
    };
    const verdict = deriveInventoryIntegrity({ revision: "opt-rev-001", registry: [mutated] });
    expect(verdict.declaredRevisionKnown).toBe(true);
    expect(verdict.digestAgrees).toBe(false);
    expect(verdict.agreed).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("DISAGREED");
  });

  test("an unknown declared revision fails inventory integrity", () => {
    const verdict = deriveInventoryIntegrity({ revision: "opt-rev-999" });
    expect(verdict.declaredRevisionKnown).toBe(false);
    expect(verdict.agreed).toBe(false);
  });

  test("structural validation rejects malformed inventories", () => {
    const base = inventoryRevisionOf("opt-rev-001") as NonNullable<
      ReturnType<typeof inventoryRevisionOf>
    >;
    expect(validateOptimizationInventory({ ...base, entries: [] }).length).toBeGreaterThan(0);
    expect(
      validateOptimizationInventory({
        ...base,
        entries: [...base.entries, base.entries[0] as never],
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateOptimizationInventory({
        ...base,
        entries: base.entries.map((entry) =>
          entry.name === PROMPT_COMPRESSION_NAME
            ? { ...entry, bound: { minCompressedRatio: "0.9", maxCompressedRatio: "0.5" } }
            : entry,
        ),
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateOptimizationInventory({
        ...base,
        entries: base.entries.map((entry) =>
          entry.kind === "response-cache" ? { ...entry, bound: { key: "x" } } : entry,
        ),
      }).length,
    ).toBeGreaterThan(0);
    expect(validateOptimizationInventory(base)).toEqual([]);
  });

  test("the routing table resolves per class with the conservative fallback", () => {
    const inventory = inventoryFor("opt-rev-001");
    expect(routeForClass(inventory, "summarize").provider).toBe("retry-relay");
    expect(routeForClass(inventory, "extract").provider).toBe("openrouter");
    expect(routeForClass(inventory, "transform-batch").provider).toBe("batch-relay");
    const fallback = routeForClass(inventory, "unknown-class");
    expect(fallback.provider).toBe("openrouter");
    expect(fallback.model).toBe(inventory.fallbackRoute.model);
  });

  test("the inventory-conformance derivation FAILs an UNDECLARED optimization", () => {
    const inventory = inventoryFor("opt-rev-001");
    const honest = deriveInventoryConformance({
      inventory,
      appliedOptimizations: [MODEL_ROUTING_NAME, PROMPT_COMPRESSION_NAME],
    });
    expect(honest.conformant).toBe(true);
    expect(honest.undeclared).toEqual([]);
    const masquerade = deriveInventoryConformance({
      inventory,
      appliedOptimizations: [MODEL_ROUTING_NAME, "request-deduplication"],
    });
    expect(masquerade.conformant).toBe(false);
    expect(masquerade.undeclared).toEqual(["request-deduplication"]);
    expect(masquerade.evidence.join(" ")).toContain("UNDECLARED");
  });

  test("the compression-bound derivation FAILs out-of-bound ratios on BOTH sides", () => {
    const inventory = inventoryFor("opt-rev-001");
    const conformant = deriveCompressionConformance({
      inventory,
      appliedOptimizations: [PROMPT_COMPRESSION_NAME],
      dispatchedInputTokens: 120,
      rawInputTokens: 200,
    });
    expect(conformant.conformant).toBe(true);
    expect(conformant.ratio).toBeCloseTo(0.6, 12);
    // The understatement masquerade: 20/200 = 0.10 < the 0.25 floor.
    const understated = deriveCompressionConformance({
      inventory,
      appliedOptimizations: [PROMPT_COMPRESSION_NAME],
      dispatchedInputTokens: 20,
      rawInputTokens: 200,
    });
    expect(understated.conformant).toBe(false);
    // No compression at all: 190/200 = 0.95 > the 0.75 ceiling.
    const uncompressed = deriveCompressionConformance({
      inventory,
      appliedOptimizations: [PROMPT_COMPRESSION_NAME],
      dispatchedInputTokens: 190,
      rawInputTokens: 200,
    });
    expect(uncompressed.conformant).toBe(false);
    // The corrected revision tightens the ceiling to 0.70: 0.72 fails opt-rev-002.
    const tightened = deriveCompressionConformance({
      inventory: inventoryFor("opt-rev-002"),
      appliedOptimizations: [PROMPT_COMPRESSION_NAME],
      dispatchedInputTokens: 144,
      rawInputTokens: 200,
    });
    expect(tightened.conformant).toBe(false);
    // Not applied: the bound is skipped honestly.
    const inert = deriveCompressionConformance({
      inventory,
      appliedOptimizations: [MODEL_ROUTING_NAME],
      dispatchedInputTokens: 20,
      rawInputTokens: 200,
    });
    expect(inert.conformant).toBe(true);
    expect(inert.ratio).toBeNull();
  });

  test("the semantically-safe response cache keys on content identity", () => {
    const cache = new SemanticResponseCache();
    const key = SemanticResponseCache.keyOf("summarize", "doc-1");
    expect(SemanticResponseCache.keyOf("summarize", "doc-1")).toBe(key);
    expect(SemanticResponseCache.keyOf("extract", "doc-1")).not.toBe(key);
    expect(SemanticResponseCache.keyOf("summarize", "doc-2")).not.toBe(key);
    expect(cache.lookup("summarize", "doc-1")).toBeUndefined();
    cache.store({
      taskClass: "summarize",
      contentDigest: "doc-1",
      responseText: "confirm",
      requestDigest: "d",
      storedByTaskId: "t1",
    });
    expect(cache.lookup("summarize", "doc-1")?.responseText).toBe("confirm");
    expect(cache.lookup("extract", "doc-1")).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  test("the per-round budget bound is the worst case over EVERY routed rail", () => {
    // retry-relay: 6+19; openrouter: 8+16; batch-relay: 5+20 — max 25.
    expect(
      deriveOptimizedRoundBudgetBoundMicroUsd({
        manifest: manifestFor("rev-001"),
        inventory: inventoryFor("opt-rev-001"),
        maxTokens: 64,
      }),
    ).toBe("25");
  });
});

// ---------------------------------------------------------------------------
// The corpus (the per-row oracle)
// ---------------------------------------------------------------------------

describe("VAL-042 corpus", () => {
  test("the corpus declares per-row arm manifest entries and optimization inventories", () => {
    for (const row of OPTIMIZED_CORPUS) {
      expect(validateArmDeclaration(row.arm)).toEqual([]);
      // The declared inventory revision is pinned.
      expect(() => inventoryFor(row.optimizationInventoryRevision)).not.toThrow();
      // Every slice task has a round plan.
      for (const taskId of row.arm.corpusSlice) {
        expect(
          row.optimizedReplay.find((plan) => plan.taskId === taskId),
          `${row.rowId}/${taskId}`,
        ).toBeDefined();
      }
      expect(row.expected.appCreated).toBe(1);
    }
    // The rows never embed list prices or optimization bounds: the
    // body carries references only.
    for (const row of OPTIMIZED_CORPUS) {
      const body = JSON.stringify(taskBodyFor({ row }));
      expect(body).not.toMatch(/"(input|output)Price"/);
      expect(body).not.toMatch(/"fxRate"\s*:/);
      expect(body).not.toMatch(/maxCompressedRatio/);
      expect(body).not.toMatch(/minCompressedRatio/);
      expect(body).toContain(row.arm.priceRevision);
      expect(body).toContain(row.optimizationInventoryRevision);
    }
  });

  test("the pinned expected economics are the honest hand-computed numbers", () => {
    const expectations: Readonly<
      Record<
        string,
        {
          runs: number;
          resolved: number;
          measured: string;
          estimated: string;
          cpr: string | null;
        }
      >
    > = {
      "fixed-quality-optimized-routing-cache-amortized": {
        runs: 8,
        resolved: 8,
        measured: "554",
        estimated: "17",
        cpr: "69",
      },
      "fixed-quality-optimized-prompt-compression": {
        runs: 6,
        resolved: 6,
        measured: "132",
        estimated: "17",
        cpr: "22",
      },
      "fixed-quality-optimized-batch-throughput": {
        runs: 6,
        resolved: 6,
        measured: "1240",
        estimated: "0",
        cpr: "207",
      },
      "fixed-cost-optimized-cache-budget-stretch": {
        runs: 8,
        resolved: 7,
        measured: "42",
        estimated: "0",
        cpr: "6",
      },
      "fixed-cost-optimized-budget-exhausted-honest-stop": {
        runs: 3,
        resolved: 2,
        measured: "59",
        estimated: "0",
        cpr: "30",
      },
      "zero-resolved-optimized-null-discipline": {
        runs: 6,
        resolved: 0,
        measured: "42",
        estimated: "0",
        cpr: null,
      },
      "fresh-only-optimized-cache-inert": {
        runs: 6,
        resolved: 6,
        measured: "54",
        estimated: "0",
        cpr: "9",
      },
    };
    for (const [rowId, expected] of Object.entries(expectations)) {
      const row = rowById(rowId);
      const normalized = row.expected.normalized;
      expect(normalized, rowId).toBeDefined();
      if (normalized !== undefined) {
        expect(normalized.runCount, `${rowId} runs`).toBe(expected.runs);
        expect(normalized.resolvedCount, `${rowId} resolved`).toBe(expected.resolved);
        expect(normalized.measuredCostMicroUsd, `${rowId} measured`).toBe(expected.measured);
        expect(normalized.estimatedCostMicroUsd, `${rowId} estimated`).toBe(expected.estimated);
        expect(normalized.costPerResolvedMicroUsd, `${rowId} cpr`).toBe(expected.cpr);
      }
    }
  });

  test("the frozen-portfolio references are the VAL-030 baseline revisions by digest", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const frozen = FROZEN_PORTFOLIO_ROWS.find(
        (candidate) => candidate.appArtifact.appId === row.frozenPortfolio.appId,
      );
      expect(frozen, row.rowId).toBeDefined();
      expect(row.frozenPortfolio.appDigest).toBe(frozen?.manifest.appDigest);
      expect(row.frozenPortfolio.workloadDigest).toBe(frozen?.manifest.workloadDigest);
      expect(row.frozenPortfolio.manifestDigest).toBe(frozen?.manifest.manifestDigest);
      // The referenced app is a REAL frozen portfolio row (never an invented app).
      expect(
        LONGITUDINAL_CORPUS.some(
          (candidate) => candidate.manifest.manifestDigest === row.frozenPortfolio.manifestDigest,
        ),
        row.rowId,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The driver over every offline row (the REAL rails, the fake platform)
// ---------------------------------------------------------------------------

describe("VAL-042 driver over the offline corpus", () => {
  test("every offline row completes with valid evidence and the pinned normalized outcome", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const result = await driveRowOverFakeStack({ row, runSuffix: "all" });
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(result.terminal, `${row.rowId} terminal`).toBe("COMPLETED");
      expect(result.observedTerminal, `${row.rowId} observed`).toBe("COMPLETED");
      expect(result.comparison).not.toBeNull();
      const expected = row.expected.normalized;
      expect(expected).toBeDefined();
      const comparison = result.comparison;
      if (expected !== undefined && comparison !== null) {
        expect(comparison.runCount, `${row.rowId} runs`).toBe(expected.runCount);
        expect(comparison.resolvedCount, `${row.rowId} resolved`).toBe(expected.resolvedCount);
        expect(comparison.measuredCostMicroUsd, `${row.rowId} measured`).toBe(
          expected.measuredCostMicroUsd,
        );
        expect(comparison.estimatedCostMicroUsd, `${row.rowId} estimated`).toBe(
          expected.estimatedCostMicroUsd,
        );
        expect(comparison.costPerResolvedMicroUsd, `${row.rowId} cpr`).toBe(
          expected.costPerResolvedMicroUsd,
        );
        expect(comparison.resolutionConfidence?.low, `${row.rowId} wilson low`).toBeCloseTo(
          expected.resolutionConfidence.low,
          12,
        );
        expect(comparison.resolutionConfidence?.high, `${row.rowId} wilson high`).toBeCloseTo(
          expected.resolutionConfidence.high,
          12,
        );
      }
      // The comparison carries the Wilson interval of the REAL aggregate.
      if (comparison !== null && result.aggregate !== null) {
        expect(comparison.resolutionConfidence?.low).toBe(
          result.aggregate.resolutionConfidence.low,
        );
      }
    }
  }, 120_000);

  test("the headline row: 6 routed dispatches + 2 cache hits, the retry amortized", async () => {
    const row = rowById("fixed-quality-optimized-routing-cache-amortized");
    const result = await driveRowOverFakeStack({ row, runSuffix: "routing" });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.cacheHits).toBe(2);
    expect(result.dispatches).toBe(6);
    // The hit rounds carry ZERO usage facts and the cached response.
    const hitRounds = result.rounds.filter((round) => round.cacheHit);
    expect(hitRounds.map((round) => round.taskId)).toEqual([
      row.arm.corpusSlice[6],
      row.arm.corpusSlice[7],
    ]);
    for (const round of hitRounds) {
      expect(round.usageFacts).toEqual([]);
      expect(round.observed.responseText).toBe("confirm");
      expect(round.appliedOptimizations).toEqual([RESPONSE_CACHE_NAME]);
    }
    // The routed rails: summarize → retry-relay, extract → openrouter,
    // transform-batch → batch-relay.
    const dispatched = result.rounds.filter((round) => !round.cacheHit);
    expect(dispatched[0]?.route?.provider).toBe("retry-relay");
    expect(dispatched[2]?.route?.provider).toBe("openrouter");
    expect(dispatched[4]?.route?.provider).toBe("batch-relay");
    // The retry-amortized round 2: two attempts, retry-overhead facts.
    const retried = result.rounds.find((round) => round.taskId === row.arm.corpusSlice[1]);
    expect(retried?.attempts).toBe(2);
    const retryOverhead = retried?.usageFacts.filter((fact) => fact.scope === "retry-overhead");
    expect(retryOverhead?.length).toBe(2);
    // The measured basis covers ONLY the 6 dispatched rounds' usage.
    expect(result.comparison?.measuredCostMicroUsd).toBe("554");
    expect(result.comparison?.costPerResolvedMicroUsd).toBe("69");
  });

  test("the compression row rides the corrected inventory revision opt-rev-002", async () => {
    const row = rowById("fixed-quality-optimized-prompt-compression");
    const result = await driveRowOverFakeStack({ row, runSuffix: "compress" });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.cacheHits).toBe(0);
    const compression = result.criteria.find((c) => c.criterionId === "compression-bound");
    expect(compression?.status).toBe("PASS");
    expect(compression?.evidence.join(" ")).toContain("ratio:0.6000");
    expect(result.comparison?.estimatedCostMicroUsd).toBe("17");
    expect(result.comparison?.measuredCostMicroUsd).toBe("132");
  });

  test("the batched row exercises ceil-to-batch on the uneven counts", async () => {
    const row = rowById("fixed-quality-optimized-batch-throughput");
    const result = await driveRowOverFakeStack({ row, runSuffix: "batch" });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.comparison?.measuredCostMicroUsd).toBe("1240");
    // The 520-token round charges 1000 (the ceil-to-batch metering).
    const fifth = result.rounds.find((round) => round.taskId === row.arm.corpusSlice[4]);
    expect(fifth?.usageFacts.find((fact) => fact.tier === "input")?.tokens).toBe(520);
    // The batched rounds report the batched + provider-side optimizations.
    expect(fifth?.appliedOptimizations).toContain(BATCHED_THROUGHPUT_NAME);
    expect(fifth?.appliedOptimizations).toContain(PROVIDER_SIDE_NAME);
  });

  test("the budget-stretch row completes the FULL slice within the pinned budget", async () => {
    const row = rowById("fixed-cost-optimized-cache-budget-stretch");
    const result = await driveRowOverFakeStack({ row, runSuffix: "stretch" });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.budgetStopAfter).toBeNull();
    expect(result.cacheHits).toBe(3);
    expect(result.dispatches).toBe(5);
    // The full 8-round slice executed: the cache stretched the budget.
    expect(result.rounds.length).toBe(8);
    expect(result.rounds.map((round) => round.taskId)).toEqual([...row.arm.corpusSlice]);
    // The failed original round never populated the cache: its duplicate
    // (round 7) dispatched FRESH.
    const seventh = result.rounds.find((round) => round.taskId === row.arm.corpusSlice[6]);
    expect(seventh?.cacheHit).toBe(false);
    // The measured total respects the pinned 61 µ$ budget.
    expect(result.comparison?.budget?.respected).toBe(true);
    expect(result.comparison?.measuredCostMicroUsd).toBe("42");
    expect(result.comparison?.budget?.qualityAttained).toBeCloseTo(0.875, 12);
  });

  test("the budget-stop row stops honestly after the declared prefix", async () => {
    const row = rowById("fixed-cost-optimized-budget-exhausted-honest-stop");
    const result = await driveRowOverFakeStack({ row, runSuffix: "stop" });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.budgetStopAfter).toBe(3);
    expect(result.rounds.map((round) => round.taskId)).toEqual(row.arm.corpusSlice.slice(0, 3));
    expect(result.comparison?.measuredCostMicroUsd).toBe("59");
    expect(result.comparison?.budget?.respected).toBe(true);
  });

  test("the zero-resolved row holds the NULL discipline (never zero, never estimate-backed)", async () => {
    const row = rowById("zero-resolved-optimized-null-discipline");
    const result = await driveRowOverFakeStack({ row, runSuffix: "zero" });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.comparison?.resolvedCount).toBe(0);
    expect(result.comparison?.costPerResolvedMicroUsd).toBeNull();
    expect(result.comparison?.resolutionConfidence?.low).toBe(0);
    expect(result.comparison?.resolutionConfidence?.high).toBeGreaterThan(0);
  });

  test("the fresh-only row NEVER serves the collision pairs from the active cache", async () => {
    const row = rowById("fresh-only-optimized-cache-inert");
    const result = await driveRowOverFakeStack({ row, runSuffix: "fresh" });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.cacheHits).toBe(0);
    expect(result.dispatches).toBe(6);
    // Rounds 2, 4, 6 share the content digests of rounds 1, 3, 5 —
    // and dispatched FRESH anyway (correctness demanded it).
    const evenRounds = [1, 3, 5].map((index) =>
      result.rounds.find((round) => round.taskId === row.arm.corpusSlice[index]),
    );
    for (const round of evenRounds) {
      expect(round?.cacheHit).toBe(false);
      expect(round?.cachePolicy).toBe("fresh-only");
    }
    const safety = result.criteria.find((c) => c.criterionId === "cache-safety");
    expect(safety?.status).toBe("PASS");
    expect(safety?.evidence.join(" ")).toContain("freshOnlyRounds:3");
  });

  test("the arm decisions are journaled BEFORE the first round (the durable planning decision)", async () => {
    const row = rowById("fixed-cost-optimized-cache-budget-stretch");
    const clock = createTickClock();
    const ledger = createFakeLedger(clock);
    const seam = createFakeSubmissionSeam({ ledger });
    const lifecycle = createFakeLifecycle({ ledger });
    const executor = createOptimizedReplayExecutor({ row, clock });
    const submission = await seam({ key: "val-042-unit-decision", body: taskBodyFor({ row }) });
    await driveOptimizedRow({
      row,
      lifecycle,
      executor,
      rails: createRealAccountingRails(),
      tasks: optimizedTasksForArm(row.arm),
      metadata: metadataOf(clock.now().toISOString()),
      environmentIdentity: "val-042-unit-decision",
      corpusVersion: OPTIMIZED_CORPUS_VERSION,
      baseline: ledger.facts(),
      worldFacts: ledger.facts,
      landedProvider: async () => [submission.executionId],
      retry: { maxExtraAttempts: 2, backoffMs: 1, sleep: noSleep },
      now: clock.now,
    });
    const journal = lifecycle.journal;
    // The planning decision carries the OPTIMIZED ARM DECISIONS.
    expect(journal.decisions.length).toBe(1);
    const decision = journal.decisions[0];
    expect(decision?.armDecision.kind).toBe("optimized-fixed-cost-budget-plan");
    expect(decision?.armDecision.optimizationInventoryRevision).toBe("opt-rev-001");
    expect(decision?.armDecision.optimizationInventoryDigest).toBe(
      inventoryFor("opt-rev-001").digest,
    );
    expect(decision?.armDecision.roundBoundMicroUsd).toBe("25");
    expect(decision?.armDecision.cachePolicy).toEqual({
      key: "task-class+content-digest",
      safety: "fresh-only tasks are never served from the cache",
    });
    expect(Array.isArray(decision?.armDecision.routingTable)).toBe(true);
    // The decision's journal record precedes every round record.
    const decisionOrdinal = journal.stepEvents.find((event) => event.record.kind === "arm-decision")
      ?.record.ordinal;
    const firstRoundOrdinal = journal.stepEvents.find(
      (event) => event.record.kind === "round" || event.record.kind === "failure",
    )?.record.ordinal;
    expect(decisionOrdinal).toBeDefined();
    expect(firstRoundOrdinal).toBeDefined();
    expect(decisionOrdinal as number).toBeLessThan(firstRoundOrdinal as number);
    // The call keys are per-decision distinct (the VAL-018 lesson).
    expect(new Set(journal.callKeys).size).toBe(journal.callKeys.length);
    // The canonical transition order holds.
    const steps = journal.transitions.map((transition) => transition.step);
    expect(steps).toEqual(["authorize", "plan", "queue", "start", "verify"]);
  });

  test("the digest helper is deterministic and payload-safe", () => {
    expect(economicDigestOf({ a: 1 })).toBe(economicDigestOf({ a: 1 }));
    expect(economicDigestOf({ a: 1 })).not.toBe(economicDigestOf({ a: 2 }));
    expect(economicDigestOf("secret-payload")).toMatch(/^[0-9a-f]{8}$/);
  });
});
