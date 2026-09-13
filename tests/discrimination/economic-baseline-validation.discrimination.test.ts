/**
 * VAL-040 acceptance criterion 6 — discrimination tests proving the
 * normalization core and the experiment protocol against controlled
 * fakes (every family FAILS mechanically; every family has an honest
 * control that PASSES):
 *
 *   * MIXED-CURRENCY CONFLATION — usage denominated in a currency
 *     that mismatches the pinned price's denomination, or a
 *     GBP-denominated table with no pinned FX rate: the normalization
 *     FAILS (at the derivation level and at the row level);
 *   * ESTIMATE-BACKED COST-PER-RESOLUTION — an arm whose rounds
 *     report ONLY planner quotes (no measured usage) with resolved
 *     outcomes: the cost-per-resolved is REFUSED and the comparison
 *     FAILS (the VAL-006 discipline: estimates never conflate);
 *   * POST-HOC ARM EXCLUSION — an executor that drops the failed
 *     rounds from the executed slice: the slice-conformance oracle
 *     FAILS (a fixed-quality arm must execute its full
 *     pre-registered slice);
 *   * THRESHOLD GAMING on a fixed-quality arm — an arm that claims
 *     attainment its observed resolution does not support, and the
 *     post-hoc threshold MOVE (the digest-frozen declaration drift):
 *     both FAIL mechanically;
 *   * UNPINNED PRICING — an arm pricing against a MUTATED manifest
 *     table (an in-place price edit with a stale digest), a
 *     negotiated-source table, and an undeclared-revision pricing
 *     basis: each FAILS (the manifest-integrity digest agreement);
 *   * SAMPLE-SIZE VIOLATION — an executor that truncates the sample
 *     below the declared statistical minimum: the sufficiency oracle
 *     FAILS (the below-minimum arm of AC4);
 *   * the AC4 probes: the mutated price entry, the below-minimum arm
 *     and the CONFIDENCE-LESS comparison each FAIL mechanically.
 */

import { describe, expect, test } from "vitest";
import type { ArmAggregate } from "../../benchmarks/validation/accounting/aggregate";
import {
  ECONOMIC_CORPUS,
  ECONOMIC_CORPUS_VERSION,
  economicTasksForArm,
  taskBodyFor,
} from "../../benchmarks/validation/apps/economic-baseline/corpus";
import {
  createRealAccountingRails,
  driveEconomicRow,
  type EconomicCorpusRow,
} from "../../benchmarks/validation/apps/economic-baseline/driver";
import {
  correctedManifestRevision,
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createRecordedReplayExecutor,
  createTickClock,
  mutatedManifestOf,
  type ReplayExecutorKnobs,
} from "../../benchmarks/validation/apps/economic-baseline/fixtures";
import {
  deriveCostPerResolved,
  normalizeUsageFact,
} from "../../benchmarks/validation/apps/economic-baseline/normalization";
import {
  deriveManifestIntegrity,
  type ListPriceEntry,
  manifestRevisionOf,
  type PriceManifestRevision,
  validatePriceTableEntry,
} from "../../benchmarks/validation/apps/economic-baseline/pricing";
import {
  deriveNormalizedComparison,
  deriveSampleSufficiency,
  deriveSliceConformance,
  deriveThresholdAttainment,
  type FixedQualityArm,
  pinExperiment,
  validateNormalizedComparison,
  verifyDeclarationDrift,
  wilsonInterval,
} from "../../benchmarks/validation/apps/economic-baseline/protocol";
import type { RunMetadata } from "../../benchmarks/validation/run-identity";

const REVISION = "d63a77e684f6097dd974caabe4a05d6c39302fe3";

const noSleep = async () => {};

const metadataOf = (observedAt: string): RunMetadata => ({
  program: "zeck-validation",
  workOrder: "VAL-040",
  baseRevision: REVISION,
  applicationRevision: REVISION,
  corpusRevision: REVISION,
  integrationSurface: "sdk",
  environment: {
    runtime: "node test",
    toolchain: "vitest",
    database: "none",
    configuration: { suite: "val-040-discrimination" },
  },
  observedAt,
});

const rowById = (rowId: string): EconomicCorpusRow => {
  const row = ECONOMIC_CORPUS.find((candidate) => candidate.rowId === rowId);
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
  readonly row: EconomicCorpusRow;
  readonly knobs?: ReplayExecutorKnobs;
  readonly manifestOverride?: PriceManifestRevision;
  readonly claimedThresholdMet?: boolean;
}): Promise<ReturnType<typeof driveEconomicRow>> {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const seam = createFakeSubmissionSeam({ ledger });
  const lifecycle = createFakeLifecycle({ ledger });
  const executor = createRecordedReplayExecutor({
    row: options.row,
    clock,
    ...(options.knobs === undefined ? {} : { knobs: options.knobs }),
  });
  const baseline = ledger.facts();
  const submission = await seam({
    key: `val-040-disc-${options.row.rowId}`,
    body: taskBodyFor({ row: options.row }),
  });
  return driveEconomicRow({
    row: options.row,
    lifecycle,
    executor,
    rails: createRealAccountingRails(),
    tasks: economicTasksForArm(options.row.arm),
    metadata: metadataOf(clock.now().toISOString()),
    environmentIdentity: `val-040-disc-${options.row.rowId}`,
    corpusVersion: ECONOMIC_CORPUS_VERSION,
    baseline,
    worldFacts: ledger.facts,
    landedProvider: async () => [submission.executionId],
    retry: { maxExtraAttempts: 2, backoffMs: 1, sleep: noSleep },
    now: clock.now,
    ...(options.manifestOverride === undefined
      ? {}
      : { manifestOverride: options.manifestOverride }),
    ...(options.claimedThresholdMet === undefined
      ? {}
      : { claimedThresholdMet: options.claimedThresholdMet }),
  });
}

// ---------------------------------------------------------------------------
// Family 1: mixed-currency conflation
// ---------------------------------------------------------------------------

describe("discrimination: mixed-currency conflation", () => {
  test("the derivation-level catch (EUR fact against the JPY table)", () => {
    // The real probe: the pinned manifest's tokyo entry is JPY.
    const manifest = manifestRevisionOf("rev-001");
    expect(manifest).not.toBeNull();
    const outcome = normalizeUsageFact(
      {
        provider: "tokyo-relay",
        model: "tokyo-mini-v1",
        tier: "input",
        currency: "EUR",
        tokens: 300,
        kind: "measured",
        scope: "direct-execution",
      },
      manifest as PriceManifestRevision,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.reason).toContain("MIXED-CURRENCY CONFLATION");
    }
  });

  test("the row-level catch: the tokyo row with conflated currencies FAILS mechanically", async () => {
    const row = rowById("fixed-quality-tokyo-relay-jpy-per-1k");
    const result = await driveRowOverLeakyStack({
      row,
      knobs: { conflateCurrency: "GBP" },
    });
    expect(result.terminal).toBe("FAILED");
    const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed.map((criterion) => criterion.criterionId)).toContain("normalization-integrity");
    // The row-level terminal read-back is honest: FAILED.
    expect(result.observedTerminal).toBe("FAILED");
  });

  test("the honest control: the tokyo row converges (JPY → micro-USD through the pinned FX)", async () => {
    const row = rowById("fixed-quality-tokyo-relay-jpy-per-1k");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.criteria.filter((criterion) => criterion.status === "FAIL")).toEqual([]);
    expect(result.comparison?.measuredCostMicroUsd).toBe("325129");
  });
});

// ---------------------------------------------------------------------------
// Family 2: estimate-backed cost-per-resolution
// ---------------------------------------------------------------------------

describe("discrimination: estimate-backed cost-per-resolution", () => {
  test("the derivation-level catch: no measured facts, resolved outcomes → REFUSED", () => {
    const outcome = deriveCostPerResolved({
      measuredMicroUsd: "0",
      estimatedMicroUsd: "136",
      resolvedCount: 8,
    });
    expect(outcome.costPerResolvedMicroUsd).toBeNull();
    expect(outcome.estimateBacking).toBe(true);
  });

  test("the comparison-level catch: the estimate-backed comparison FAILS", () => {
    const arm = rowById("fixed-quality-openrouter-usd-metered").arm;
    const comparison = deriveNormalizedComparison({
      arm,
      aggregate: aggregateOf(8, 8, "0", "136"),
      executedTaskIds: arm.corpusSlice,
    });
    const violations = validateNormalizedComparison(comparison);
    expect(
      violations.some((violation) =>
        violation.reason.includes("ESTIMATE-BACKED COST-PER-RESOLUTION"),
      ),
    ).toBe(true);
  });

  test("the row-level catch: an estimate-only executor FAILS mechanically", async () => {
    const row = rowById("fixed-quality-openrouter-usd-metered");
    const result = await driveRowOverLeakyStack({ row, knobs: { estimateOnly: true } });
    expect(result.terminal).toBe("FAILED");
    const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed.map((criterion) => criterion.criterionId)).toContain("protocol-comparison-valid");
    // The estimate total is REPORTED (never conflated into the basis):
    // every round's quote (120+30 tokens) prices to 22 µ$ × 8 = 176.
    expect(result.comparison?.estimatedCostMicroUsd).toBe("176");
    expect(result.comparison?.measuredCostMicroUsd).toBe("0");
    expect(result.comparison?.costPerResolvedMicroUsd).toBeNull();
  });

  test("the honest control: measured facts + a separate estimate quote PASS", async () => {
    const row = rowById("fixed-quality-openrouter-usd-metered");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    // The estimate quote (17 µ$) is reported separately from the
    // measured basis (176 µ$) — never conflated.
    expect(result.comparison?.estimatedCostMicroUsd).toBe("17");
    expect(result.comparison?.measuredCostMicroUsd).toBe("176");
    expect(result.comparison?.costPerResolvedMicroUsd).toBe("22");
  });
});

// ---------------------------------------------------------------------------
// Family 3: post-hoc arm exclusion
// ---------------------------------------------------------------------------

describe("discrimination: post-hoc arm exclusion", () => {
  test("the derivation-level catch: a dropped non-resolved task FAILs conformance", () => {
    const arm = rowById("fixed-quality-euro-relay-eur").arm;
    const dropped = deriveSliceConformance({
      arm,
      executedTaskIds: arm.corpusSlice.filter((_taskId, index) => !(index === 3 || index === 6)),
    });
    expect(dropped.conformant).toBe(false);
    expect(dropped.evidence.join(" ")).toContain("NON-CONFORMANT");
  });

  test("the comparison-level catch: the excluded comparison FAILs", () => {
    const arm = rowById("fixed-quality-euro-relay-eur").arm;
    const comparison = deriveNormalizedComparison({
      arm,
      aggregate: aggregateOf(6, 6, "786", "0"),
      executedTaskIds: arm.corpusSlice.filter((_taskId, index) => !(index === 3 || index === 6)),
    });
    expect(
      validateNormalizedComparison(comparison).some((violation) =>
        violation.reason.includes("POST-HOC ARM EXCLUSION"),
      ),
    ).toBe(true);
  });

  test("the row-level catch: an executor dropping the failed rounds FAILs mechanically", async () => {
    const row = rowById("fixed-quality-euro-relay-eur");
    const result = await driveRowOverLeakyStack({ row, knobs: { dropFailedRounds: true } });
    expect(result.terminal).toBe("FAILED");
    const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed.map((criterion) => criterion.criterionId)).toContain("protocol-comparison-valid");
    // The executed slice dropped the two failed rounds (6 of 8).
    expect(result.rounds.length).toBe(6);
  });

  test("the honest control: the euro row with its honest failures PASSES", async () => {
    const row = rowById("fixed-quality-euro-relay-eur");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.rounds.length).toBe(8);
    expect(result.comparison?.resolvedCount).toBe(6);
    // The failed rounds' cost stays in the arm's measured total
    // (amortized over the resolved outcomes).
    expect(result.comparison?.measuredCostMicroUsd).toBe("970");
    expect(result.comparison?.costPerResolvedMicroUsd).toBe("162");
  });
});

// ---------------------------------------------------------------------------
// Family 4: threshold gaming on a fixed-quality arm
// ---------------------------------------------------------------------------

describe("discrimination: threshold gaming", () => {
  test("the derivation-level catch: a claim above the observed rate is gamed", () => {
    const arm = rowById("fixed-quality-euro-relay-eur").arm as FixedQualityArm;
    // The gaming probe: an arm whose observed rate (0.75) is BELOW its
    // pinned threshold (0.9), with a claim that it IS attained.
    const raised = { ...arm, pinnedThreshold: { resolutionRate: 0.9 } };
    const caught = deriveThresholdAttainment({
      arm: raised,
      observedResolutionRate: 0.75,
      claimedMet: true,
    });
    expect(caught.met).toBe(false);
    expect(caught.evidence.join(" ")).toContain("THRESHOLD GAMING");
    // The honest sub-case: the same arm WITHOUT a claim simply reports
    // not-attained (no gaming flag).
    const honest = deriveThresholdAttainment({
      arm: raised,
      observedResolutionRate: 0.75,
    });
    expect(honest.met).toBe(false);
    expect(honest.evidence.join(" ")).not.toContain("THRESHOLD GAMING");
  });

  test("the comparison-level catch: the gamed claim and the not-attained arm both FAIL", () => {
    const arm = rowById("fixed-quality-euro-relay-eur").arm as FixedQualityArm;
    const gamed = deriveNormalizedComparison({
      arm: { ...arm, pinnedThreshold: { resolutionRate: 0.9 } },
      aggregate: aggregateOf(8, 6, "970", "0"),
      executedTaskIds: arm.corpusSlice,
      claimedThresholdMet: true,
    });
    const violations = validateNormalizedComparison(gamed);
    expect(violations.some((violation) => violation.reason.includes("THRESHOLD GAMING"))).toBe(
      true,
    );
    expect(
      violations.some((violation) => violation.reason.includes("THRESHOLD NOT ATTAINED")),
    ).toBe(true);
  });

  test("the declaration-drift catch: a post-hoc threshold MOVE fails the digest-frozen plan", () => {
    const arm = rowById("fixed-quality-euro-relay-eur").arm as FixedQualityArm;
    const pinned = pinExperiment([arm]);
    // The post-hoc move: the executed arm lowers the threshold to
    // make the observed 0.75 "attained".
    const moved = { ...arm, pinnedThreshold: { resolutionRate: 0.5 } };
    expect(verifyDeclarationDrift(pinned, [moved]).length).toBeGreaterThan(0);
    expect(verifyDeclarationDrift(pinned, [arm])).toEqual([]);
  });

  test("the row-level catch: a gamed claim on a below-threshold arm FAILs mechanically", async () => {
    const row = rowById("fixed-quality-euro-relay-eur");
    const gamedArm = {
      ...row.arm,
      pinnedThreshold: { resolutionRate: 0.9 },
    };
    const gamedRow: EconomicCorpusRow = { ...row, arm: gamedArm };
    const result = await driveRowOverLeakyStack({
      row: gamedRow,
      claimedThresholdMet: true,
    });
    expect(result.terminal).toBe("FAILED");
    const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed.map((criterion) => criterion.criterionId)).toContain("protocol-comparison-valid");
  });

  test("the honest control: the euro row at its honest threshold PASSES", async () => {
    const result = await driveRowOverLeakyStack({
      row: rowById("fixed-quality-euro-relay-eur"),
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.comparison?.threshold?.met).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Family 5: unpinned pricing (the mutated price entry)
// ---------------------------------------------------------------------------

describe("discrimination: unpinned pricing", () => {
  test("the derivation-level catch: an in-place mutated table FAILS digest agreement", () => {
    const mutated = mutatedManifestOf("rev-001", {
      provider: "openrouter",
      tier: "input",
      price: "0.06",
    });
    const verdict = deriveManifestIntegrity({ revision: "rev-001", registry: [mutated] });
    expect(verdict.digestAgrees).toBe(false);
    expect(verdict.agreed).toBe(false);
    // The honest registry agrees.
    expect(deriveManifestIntegrity({ revision: "rev-001" }).agreed).toBe(true);
  });

  test("negotiated and bulk pricing sources are FORBIDDEN in any table entry", () => {
    const mutated = mutatedManifestOf("rev-001", {
      provider: "openrouter",
      tier: "input",
      price: "0.03",
    });
    const honest = mutated.tables[0] as ListPriceEntry;
    const negotiated: ListPriceEntry = { ...honest, source: "negotiated" as never };
    const bulk: ListPriceEntry = { ...honest, source: "bulk" as never };
    expect(validatePriceTableEntry(negotiated).length).toBeGreaterThan(0);
    expect(validatePriceTableEntry(bulk).length).toBeGreaterThan(0);
    expect(validatePriceTableEntry(honest)).toEqual([]);
  });

  test("the row-level catch: pricing against a MUTATED manifest FAILs mechanically", async () => {
    const row = rowById("fixed-quality-openrouter-usd-metered");
    const mutated = mutatedManifestOf("rev-001", {
      provider: "openrouter",
      tier: "input",
      price: "0.06",
    });
    const result = await driveRowOverLeakyStack({ row, manifestOverride: mutated });
    expect(result.terminal).toBe("FAILED");
    const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed.map((criterion) => criterion.criterionId)).toContain("protocol-comparison-valid");
    // The mutated price halved the observed costs (the outcome oracle
    // catches the drift against the pinned expected economics).
    expect(failed.map((criterion) => criterion.criterionId)).toContain("normalized-outcome-oracle");
    expect(result.comparison?.manifestAgreed).toBe(false);
  });

  test("pricing at a DIFFERENT revision than declared FAILs (undeclared pricing)", async () => {
    const row = rowById("fixed-quality-openrouter-usd-metered");
    // An HONEST corrected revision (digest recomputed) — but the arm
    // declares rev-001: pricing at another revision is undeclared
    // pricing (the arm must declare the revision that priced it).
    const base = manifestRevisionOf("rev-001");
    expect(base).not.toBeNull();
    const corrected = correctedManifestRevision(
      base as PriceManifestRevision,
      { provider: "openrouter", tier: "input", price: "0.1128" },
      "rev-002-corrected",
    );
    const result = await driveRowOverLeakyStack({ row, manifestOverride: corrected });
    expect(result.comparison?.manifestAgreed).toBe(false);
    expect(result.terminal).toBe("FAILED");
  });

  test("the honest control: the openrouter row at its declared revision PASSES", async () => {
    const result = await driveRowOverLeakyStack({
      row: rowById("fixed-quality-openrouter-usd-metered"),
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.comparison?.manifestAgreed).toBe(true);
    expect(result.comparison?.measuredCostMicroUsd).toBe("176");
  });
});

// ---------------------------------------------------------------------------
// Family 6: sample-size violation (the below-minimum arm)
// ---------------------------------------------------------------------------

describe("discrimination: sample-size violation", () => {
  test("the derivation-level catch: the below-minimum arm FAILs sufficiency", () => {
    const arm = rowById("fixed-quality-openrouter-usd-metered").arm;
    const insufficient = deriveSampleSufficiency({ arm, executedCount: 5 });
    expect(insufficient.sufficient).toBe(false);
    expect(insufficient.evidence.join(" ")).toContain("INSUFFICIENT");
    expect(deriveSampleSufficiency({ arm, executedCount: 8 }).sufficient).toBe(true);
  });

  test("the comparison-level catch: the below-minimum comparison FAILs", () => {
    const arm = rowById("fixed-quality-openrouter-usd-metered").arm;
    const comparison = deriveNormalizedComparison({
      arm,
      aggregate: aggregateOf(5, 5, "110", "0"),
      executedTaskIds: arm.corpusSlice.slice(0, 5),
    });
    expect(
      validateNormalizedComparison(comparison).some((violation) =>
        violation.reason.includes("SAMPLE-SIZE VIOLATION"),
      ),
    ).toBe(true);
  });

  test("the row-level catch: a truncating executor FAILs mechanically", async () => {
    const row = rowById("fixed-quality-openrouter-usd-metered");
    const result = await driveRowOverLeakyStack({ row, knobs: { truncateSamples: 5 } });
    expect(result.terminal).toBe("FAILED");
    expect(result.rounds.length).toBe(5);
    const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed.map((criterion) => criterion.criterionId)).toContain("protocol-comparison-valid");
  });

  test("the honest control: the full 8-round sample PASSES", async () => {
    const result = await driveRowOverLeakyStack({
      row: rowById("fixed-quality-openrouter-usd-metered"),
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.rounds.length).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// The AC4 probes: the confidence-less comparison
// ---------------------------------------------------------------------------

describe("discrimination: the confidence-less comparison (AC4)", () => {
  test("a comparison without the Wilson interval FAILs mechanically", () => {
    const arm = rowById("fixed-quality-openrouter-usd-metered").arm;
    const comparison = deriveNormalizedComparison({
      arm,
      aggregate: aggregateOf(8, 8, "176", "17"),
      executedTaskIds: arm.corpusSlice,
    });
    expect(validateNormalizedComparison(comparison)).toEqual([]);
    const confidenceLess = { ...comparison, resolutionConfidence: null };
    const violations = validateNormalizedComparison(confidenceLess);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.reason).toContain("CONFIDENCE-LESS COMPARISON");
  });

  test("the honest control: every comparison carries the Wilson 95% interval", async () => {
    const result = await driveRowOverLeakyStack({
      row: rowById("fixed-quality-euro-relay-eur"),
    });
    expect(result.comparison?.resolutionConfidence).not.toBeNull();
    const expected = wilsonInterval(6, 8);
    expect(result.comparison?.resolutionConfidence?.low).toBeCloseTo(expected.low, 12);
    expect(result.comparison?.resolutionConfidence?.high).toBeCloseTo(expected.high, 12);
  });
});

// ---------------------------------------------------------------------------
// The zero-resolved NULL discipline (the symmetric honest control)
// ---------------------------------------------------------------------------

describe("discrimination: the zero-resolved NULL discipline", () => {
  test("nothing resolved → costPerResolved is NULL (never zero) and the row is honest", async () => {
    const result = await driveRowOverLeakyStack({
      row: rowById("zero-resolved-null-cost-per-resolved"),
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.comparison?.resolvedCount).toBe(0);
    expect(result.comparison?.costPerResolvedMicroUsd).toBeNull();
    expect(result.comparison?.resolutionConfidence?.low).toBe(0);
    // A claimed number on a nothing-resolved arm FAILs mechanically.
    const arm = rowById("zero-resolved-null-cost-per-resolved").arm;
    const comparison = deriveNormalizedComparison({
      arm,
      aggregate: aggregateOf(6, 0, "552", "0"),
      executedTaskIds: arm.corpusSlice,
    });
    const claimed = {
      ...comparison,
      costPerResolvedMicroUsd: "92",
    };
    expect(
      validateNormalizedComparison(claimed).some((violation) =>
        violation.reason.includes("must be NULL when nothing resolved"),
      ),
    ).toBe(true);
  });
});
