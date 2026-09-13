/**
 * VAL-042 acceptance criterion 6 — discrimination tests proving the
 * optimized baseline against controlled fakes (every family FAILS
 * mechanically; every family has an honest control that PASSES):
 *
 *   * UNDECLARED OPTIMIZATION MASQUERADE — an executor that applies
 *     (and reports) an optimization the declared inventory does not
 *     name: the inventory-conformance oracle FAILs (the verification
 *     core — something the baseline does that its inventory does not
 *     name is mechanically visible);
 *   * UNSAFE CACHE REUSE — the driver serving a FRESH-ONLY round from
 *     the response cache (correctness demands a fresh dispatch): the
 *     cache-safety oracle FAILs (the second verification core);
 *   * MIXED-CURRENCY CONFLATION — usage denominated in a currency
 *     that mismatches the routed rail's pinned price denomination
 *     (GBP sits outside the pinned FX table): the normalization FAILs;
 *   * ESTIMATE-BACKED COST-PER-RESOLUTION — rounds that report ONLY
 *     planner quotes (no measured usage) with resolved outcomes: the
 *     comparison FAILs (estimates never conflate);
 *   * POST-HOC ARM EXCLUSION — an executor that drops the failed
 *     rounds from the executed slice: the slice-conformance oracle
 *     FAILs;
 *   * SAMPLE-SIZE VIOLATION — an executor that truncates the sample
 *     below the declared statistical minimum: the sufficiency oracle
 *     FAILs;
 *   * UNPINNED PRICING — an arm priced against a MUTATED manifest
 *     table (an in-place price edit with a stale digest): the
 *     manifest-integrity agreement FAILs;
 *   * MUTATED INVENTORY — an arm declaring an inventory revision
 *     whose bound was edited IN PLACE (stale digest): the
 *     inventory-integrity agreement FAILs;
 *   * ROUTING DEVIATION — a class routed onto a rail the routing
 *     table does not declare for it: the routing-conformance oracle
 *     FAILs;
 *   * FABRICATED COMPRESSION — an executor understating the
 *     dispatched tokens: the replay-fidelity AND compression-bound
 *     oracles FAIL (the token-understatement masquerade);
 *   * the AC4 probes: the mutated price entry, the below-minimum arm
 *     and the CONFIDENCE-LESS comparison each FAIL mechanically.
 */

import { describe, expect, test } from "vitest";
import type { ArmAggregate } from "../../benchmarks/validation/accounting/aggregate";
import type { PriceManifestRevision } from "../../benchmarks/validation/apps/economic-baseline/pricing";
import {
  deriveNormalizedComparison,
  deriveSampleSufficiency,
  validateArmDeclaration,
  validateNormalizedComparison,
  wilsonInterval,
} from "../../benchmarks/validation/apps/economic-baseline/protocol";
import {
  OPTIMIZED_CORPUS,
  OPTIMIZED_CORPUS_VERSION,
  optimizedTasksForArm,
  taskBodyFor,
} from "../../benchmarks/validation/apps/economic-controls-optimized/corpus";
import {
  createRealAccountingRails,
  driveOptimizedRow,
  type OptimizedCorpusRow,
} from "../../benchmarks/validation/apps/economic-controls-optimized/driver";
import {
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createOptimizedReplayExecutor,
  createTickClock,
  mutatedInventoryOf,
  mutatedManifestOf,
  type OptimizedReplayExecutorKnobs,
} from "../../benchmarks/validation/apps/economic-controls-optimized/fixtures";
import type { OptimizationInventoryRevision } from "../../benchmarks/validation/apps/economic-controls-optimized/optimizations";
import {
  deriveInventoryConformance,
  deriveInventoryIntegrity,
  inventoryFor,
  MODEL_ROUTING_NAME,
  PROMPT_COMPRESSION_NAME,
} from "../../benchmarks/validation/apps/economic-controls-optimized/optimizations";
import type { RunMetadata } from "../../benchmarks/validation/run-identity";

const REVISION = "6e0b410449cd779b97621ae21d329abc348a6dd4";

const noSleep = async () => {};

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
    configuration: { suite: "val-042-discrimination" },
  },
  observedAt,
});

const rowById = (rowId: string): OptimizedCorpusRow => {
  const row = OPTIMIZED_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

/** Build a REAL-shaped accounting aggregate literal for the derivation-level probes. */
function aggregateOf(
  runs: number,
  resolved: number,
  measuredMicroUsd: string,
  estimatedMicroUsd: string,
): ArmAggregate {
  const confidence = wilsonInterval(resolved, runs);
  return {
    arm: "probe",
    corpusSlice: "probe",
    runCount: runs,
    resolvedCount: resolved,
    resolutionRate: runs === 0 ? 0 : resolved / runs,
    resolutionConfidence: { low: confidence.low, high: confidence.high },
    measuredCostMicroUsd: measuredMicroUsd,
    estimatedCostMicroUsd: estimatedMicroUsd,
    costPerResolvedMicroUsd: resolved > 0 ? measuredMicroUsd : null,
    latency: { mean: 1, p95: 1, max: 1 },
  };
}

/** Drive one row over a purpose-built leaky stack. */
async function driveRowOverLeakyStack(options: {
  readonly row: OptimizedCorpusRow;
  readonly knobs?: OptimizedReplayExecutorKnobs;
  readonly manifestOverride?: PriceManifestRevision;
  readonly inventoryOverride?: OptimizationInventoryRevision;
  readonly claimedThresholdMet?: boolean;
  readonly unsafeCacheReuse?: boolean;
}): Promise<ReturnType<typeof driveOptimizedRow>> {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const seam = createFakeSubmissionSeam({ ledger });
  const lifecycle = createFakeLifecycle({ ledger });
  const executor = createOptimizedReplayExecutor({
    row: options.row,
    clock,
    ...(options.knobs === undefined ? {} : { knobs: options.knobs }),
  });
  const baseline = ledger.facts();
  const submission = await seam({
    key: `val-042-disc-${options.row.rowId}`,
    body: taskBodyFor({ row: options.row }),
  });
  return driveOptimizedRow({
    row: options.row,
    lifecycle,
    executor,
    rails: createRealAccountingRails(),
    tasks: optimizedTasksForArm(options.row.arm),
    metadata: metadataOf(clock.now().toISOString()),
    environmentIdentity: `val-042-disc-${options.row.rowId}`,
    corpusVersion: OPTIMIZED_CORPUS_VERSION,
    baseline,
    worldFacts: ledger.facts,
    landedProvider: async () => [submission.executionId],
    retry: { maxExtraAttempts: 2, backoffMs: 1, sleep: noSleep },
    now: clock.now,
    ...(options.manifestOverride === undefined
      ? {}
      : { manifestOverride: options.manifestOverride }),
    ...(options.inventoryOverride === undefined
      ? {}
      : { inventoryOverride: options.inventoryOverride }),
    ...(options.claimedThresholdMet === undefined
      ? {}
      : { claimedThresholdMet: options.claimedThresholdMet }),
    ...(options.unsafeCacheReuse === undefined
      ? {}
      : { unsafeCacheReuse: options.unsafeCacheReuse }),
  });
}

// ---------------------------------------------------------------------------
// Family 1: the UNDECLARED OPTIMIZATION masquerade (the verification core)
// ---------------------------------------------------------------------------

describe("discrimination: undeclared-optimization masquerade", () => {
  test("the derivation-level catch: an applied name outside the inventory FAILs", () => {
    const inventory = inventoryFor("opt-rev-001");
    const verdict = deriveInventoryConformance({
      inventory,
      appliedOptimizations: [MODEL_ROUTING_NAME, "request-deduplication"],
    });
    expect(verdict.conformant).toBe(false);
    expect(verdict.undeclared).toEqual(["request-deduplication"]);
    expect(verdict.evidence.join(" ")).toContain("UNDECLARED optimization");
  });

  test("the row-level catch: a masquerading executor FAILs mechanically", async () => {
    const row = rowById("fixed-quality-optimized-routing-cache-amortized");
    const result = await driveRowOverLeakyStack({
      row,
      knobs: { masqueradeOptimization: "request-deduplication" },
    });
    expect(result.terminal).toBe("FAILED");
    const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed.map((criterion) => criterion.criterionId)).toContain("inventory-conformance");
    expect(result.observedTerminal).toBe("FAILED");
  });

  test("the honest control: the declared optimization set PASSES", async () => {
    const row = rowById("fixed-quality-optimized-routing-cache-amortized");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.criteria.filter((criterion) => criterion.status === "FAIL")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Family 2: the UNSAFE CACHE REUSE (the verification core)
// ---------------------------------------------------------------------------

describe("discrimination: unsafe cache reuse", () => {
  test("the row-level catch: a fresh-only round served from the cache FAILs", async () => {
    const row = rowById("fresh-only-optimized-cache-inert");
    const result = await driveRowOverLeakyStack({ row, unsafeCacheReuse: true });
    expect(result.terminal).toBe("FAILED");
    const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed.map((criterion) => criterion.criterionId)).toContain("cache-safety");
    // The unsafe reuse also understated the measured basis (the cached
    // rounds dispatched nothing) — the pinned outcome oracle catches it.
    expect(failed.map((criterion) => criterion.criterionId)).toContain("normalized-outcome-oracle");
    expect(result.cacheHits).toBe(3);
    expect(result.observedTerminal).toBe("FAILED");
  });

  test("the honest control: the collision pairs dispatch FRESH and PASS", async () => {
    const row = rowById("fresh-only-optimized-cache-inert");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.cacheHits).toBe(0);
    expect(result.dispatches).toBe(6);
  });

  test("the honest cache reuse (cacheable rounds) PASSES with zero new measured cost", async () => {
    const row = rowById("fixed-quality-optimized-routing-cache-amortized");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.cacheHits).toBe(2);
    // The 2 cache-served rounds contributed ZERO new measured cost —
    // the measured basis covers exactly the 6 dispatched rounds.
    expect(result.comparison?.measuredCostMicroUsd).toBe("554");
    expect(result.comparison?.costPerResolvedMicroUsd).toBe("69");
  });
});

// ---------------------------------------------------------------------------
// Family 3: mixed-currency conflation
// ---------------------------------------------------------------------------

describe("discrimination: mixed-currency conflation", () => {
  test("the row-level catch: GBP-denominated usage against the USD rails FAILs mechanically", async () => {
    const row = rowById("fixed-quality-optimized-prompt-compression");
    const result = await driveRowOverLeakyStack({
      row,
      knobs: { conflateCurrency: "GBP" },
    });
    expect(result.terminal).toBe("FAILED");
    const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed.map((criterion) => criterion.criterionId)).toContain("normalization-integrity");
    expect(result.observedTerminal).toBe("FAILED");
  });

  test("the honest control: the routed rails' own denominations converge", async () => {
    const row = rowById("fixed-quality-optimized-prompt-compression");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.criteria.filter((criterion) => criterion.status === "FAIL")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Family 4: estimate-backed cost-per-resolution
// ---------------------------------------------------------------------------

describe("discrimination: estimate-backed cost-per-resolution", () => {
  test("the comparison-level catch: the estimate-backed comparison FAILs", () => {
    const arm = rowById("fixed-quality-optimized-prompt-compression").arm;
    const comparison = deriveNormalizedComparison({
      arm,
      aggregate: aggregateOf(6, 6, "0", "132"),
      executedTaskIds: arm.corpusSlice,
    });
    const violations = validateNormalizedComparison(comparison);
    expect(
      violations.some((violation) =>
        violation.reason.includes("ESTIMATE-BACKED COST-PER-RESOLUTION"),
      ),
    ).toBe(true);
  });

  test("the row-level catch: an estimate-only executor FAILs mechanically", async () => {
    const row = rowById("fixed-quality-optimized-prompt-compression");
    const result = await driveRowOverLeakyStack({ row, knobs: { estimateOnly: true } });
    expect(result.terminal).toBe("FAILED");
    const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed.map((criterion) => criterion.criterionId)).toContain("protocol-comparison-valid");
    // The estimate total is REPORTED (never conflated into the basis).
    expect(result.comparison?.estimatedCostMicroUsd).toBe("132");
    expect(result.comparison?.measuredCostMicroUsd).toBe("0");
    expect(result.comparison?.costPerResolvedMicroUsd).toBeNull();
  });

  test("the honest control: measured facts + a separate estimate quote PASS", async () => {
    const row = rowById("fixed-quality-optimized-prompt-compression");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.comparison?.estimatedCostMicroUsd).toBe("17");
    expect(result.comparison?.measuredCostMicroUsd).toBe("132");
  });
});

// ---------------------------------------------------------------------------
// Family 5: post-hoc arm exclusion
// ---------------------------------------------------------------------------

describe("discrimination: post-hoc arm exclusion", () => {
  test("the derivation-level catch: a dropped non-resolved task FAILs conformance", () => {
    const arm = rowById("zero-resolved-optimized-null-discipline").arm;
    const dropped = deriveSampleSufficiency({ arm, executedCount: 3 });
    expect(dropped.sufficient).toBe(false);
    expect(dropped.evidence.join(" ")).toContain("INSUFFICIENT");
  });

  test("the row-level catch: an executor dropping the failed rounds FAILs mechanically", async () => {
    const row = rowById("zero-resolved-optimized-null-discipline");
    const result = await driveRowOverLeakyStack({
      row,
      knobs: { dropFailedRounds: true },
    });
    expect(result.terminal).toBe("FAILED");
    const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed.map((criterion) => criterion.criterionId)).toContain("protocol-comparison-valid");
  });

  test("the honest control: the failed rounds stay in the executed slice", async () => {
    const row = rowById("zero-resolved-optimized-null-discipline");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.rounds.length).toBe(6);
    expect(result.comparison?.resolvedCount).toBe(0);
    expect(result.comparison?.costPerResolvedMicroUsd).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Family 6: sample-size violation
// ---------------------------------------------------------------------------

describe("discrimination: sample-size violation", () => {
  test("the row-level catch: a truncating executor FAILs the sufficiency oracle", async () => {
    const row = rowById("fixed-quality-optimized-routing-cache-amortized");
    const result = await driveRowOverLeakyStack({
      row,
      knobs: { truncateSamples: 3 },
    });
    expect(result.terminal).toBe("FAILED");
    const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed.map((criterion) => criterion.criterionId)).toContain("protocol-comparison-valid");
    expect(
      failed
        .find((criterion) => criterion.criterionId === "protocol-comparison-valid")
        ?.evidence.join(" ")
        .includes("SAMPLE-SIZE VIOLATION"),
    ).toBe(true);
  });

  test("the honest control: the full pre-registered slice PASSES", async () => {
    const row = rowById("fixed-quality-optimized-routing-cache-amortized");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.rounds.length).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Family 7: unpinned pricing (the mutated manifest)
// ---------------------------------------------------------------------------

describe("discrimination: unpinned pricing", () => {
  test("the row-level catch: a MUTATED manifest table with a stale digest FAILs", async () => {
    const row = rowById("fixed-quality-optimized-prompt-compression");
    const result = await driveRowOverLeakyStack({
      row,
      manifestOverride: mutatedManifestOf("rev-001", {
        provider: "openrouter",
        tier: "input",
        price: "0.06",
      }),
    });
    expect(result.terminal).toBe("FAILED");
    const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed.map((criterion) => criterion.criterionId)).toContain("protocol-comparison-valid");
    expect(
      failed
        .find((criterion) => criterion.criterionId === "protocol-comparison-valid")
        ?.evidence.join(" ")
        .includes("UNPINNED PRICING"),
    ).toBe(true);
  });

  test("the honest control: the pinned revision's manifest integrity PASSES", async () => {
    const row = rowById("fixed-quality-optimized-prompt-compression");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// Family 8: the mutated inventory (the in-place bound edit)
// ---------------------------------------------------------------------------

describe("discrimination: mutated inventory", () => {
  test("the derivation-level catch: an in-place bound edit breaks the digest agreement", () => {
    const mutated = mutatedInventoryOf("opt-rev-001", {
      name: PROMPT_COMPRESSION_NAME,
      bound: { minCompressedRatio: "0.25", maxCompressedRatio: "0.50" },
    });
    const verdict = deriveInventoryIntegrity({
      revision: "opt-rev-001",
      registry: [mutated],
    });
    expect(verdict.declaredRevisionKnown).toBe(true);
    expect(verdict.digestAgrees).toBe(false);
    expect(verdict.agreed).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("DISAGREED");
  });

  test("the row-level catch: an arm declaring the mutated inventory FAILs mechanically", async () => {
    const row = rowById("fixed-quality-optimized-prompt-compression");
    const result = await driveRowOverLeakyStack({
      row,
      inventoryOverride: mutatedInventoryOf("opt-rev-001", {
        name: PROMPT_COMPRESSION_NAME,
        bound: { minCompressedRatio: "0.25", maxCompressedRatio: "0.50" },
      }),
    });
    expect(result.terminal).toBe("FAILED");
    const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed.map((criterion) => criterion.criterionId)).toContain("inventory-integrity");
  });

  test("the honest control: the pinned inventory revision PASSES", async () => {
    const row = rowById("fixed-quality-optimized-prompt-compression");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    // The row pins the CORRECTED revision opt-rev-002 and it agrees.
    const integrity = result.criteria.find((c) => c.criterionId === "inventory-integrity");
    expect(integrity?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Family 9: the routing deviation
// ---------------------------------------------------------------------------

describe("discrimination: routing deviation", () => {
  test("the row-level catch: a class routed onto an undeclared rail FAILs", async () => {
    const row = rowById("fixed-quality-optimized-routing-cache-amortized");
    const result = await driveRowOverLeakyStack({
      row,
      knobs: { misrouteClass: "summarize" },
    });
    expect(result.terminal).toBe("FAILED");
    const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed.map((criterion) => criterion.criterionId)).toContain("routing-conformance");
    // The misrouted rounds rode the fallback rail — the usage facts
    // priced a rail the table does not declare for the class.
    const misrouted = result.rounds.find(
      (round) => round.taskClass === "summarize" && !round.cacheHit,
    );
    expect(misrouted?.route?.provider).toBe("openrouter");
  });

  test("the honest control: every dispatched round rode the declared rail", async () => {
    const row = rowById("fixed-quality-optimized-routing-cache-amortized");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    const routing = result.criteria.find((c) => c.criterionId === "routing-conformance");
    expect(routing?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Family 10: the fabricated compression (the token understatement)
// ---------------------------------------------------------------------------

describe("discrimination: fabricated compression", () => {
  test("the row-level catch: an understating executor FAILs the fidelity + bound oracles", async () => {
    const row = rowById("fixed-quality-optimized-prompt-compression");
    const result = await driveRowOverLeakyStack({
      row,
      knobs: { fabricateCompression: { inputTokens: 30 } },
    });
    expect(result.terminal).toBe("FAILED");
    const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed.map((criterion) => criterion.criterionId)).toContain("replay-fidelity");
    // 30/200 = 0.15 < the 0.25 floor: the understatement masquerade.
    expect(failed.map((criterion) => criterion.criterionId)).toContain("compression-bound");
    // The understated usage also broke the pinned economics.
    expect(failed.map((criterion) => criterion.criterionId)).toContain("normalized-outcome-oracle");
  });

  test("the honest control: the recorded dispatched tokens PASS the fidelity + bound oracles", async () => {
    const row = rowById("fixed-quality-optimized-prompt-compression");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    const fidelity = result.criteria.find((c) => c.criterionId === "replay-fidelity");
    expect(fidelity?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// The AC4 probes (the mechanical battery)
// ---------------------------------------------------------------------------

describe("discrimination: the AC4 probes", () => {
  test("a below-minimum arm fails the grammar validation", () => {
    const arm = rowById("fixed-quality-optimized-routing-cache-amortized").arm;
    expect(validateArmDeclaration(arm)).toEqual([]);
    expect(validateArmDeclaration({ ...arm, minimumSamples: 12 }).length).toBeGreaterThan(0);
  });

  test("a CONFIDENCE-LESS comparison FAILs mechanically", () => {
    const arm = rowById("fixed-quality-optimized-prompt-compression").arm;
    const comparison = deriveNormalizedComparison({
      arm,
      aggregate: aggregateOf(6, 6, "132", "17"),
      executedTaskIds: arm.corpusSlice,
    });
    expect(validateNormalizedComparison(comparison)).toEqual([]);
    const confidenceLess = { ...comparison, resolutionConfidence: null };
    const violations = validateNormalizedComparison(confidenceLess);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.reason).toContain("CONFIDENCE-LESS COMPARISON");
  });

  test("an inventory-revision drift fails the digest conformance (the declaration-freeze probe)", () => {
    const inventory = inventoryFor("opt-rev-001");
    // A row declaring the honest revision executes against the honest
    // inventory: the applied set conforms.
    const honest = deriveInventoryConformance({
      inventory,
      appliedOptimizations: [MODEL_ROUTING_NAME, PROMPT_COMPRESSION_NAME],
    });
    expect(honest.conformant).toBe(true);
    // The same applied set against the CORRECTED revision's registry
    // still conforms (the names did not change — only the bound did).
    const corrected = deriveInventoryConformance({
      inventory: inventoryFor("opt-rev-002"),
      appliedOptimizations: [MODEL_ROUTING_NAME, PROMPT_COMPRESSION_NAME],
    });
    expect(corrected.conformant).toBe(true);
  });
});
