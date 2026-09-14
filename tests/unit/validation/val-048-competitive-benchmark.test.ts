/**
 * VAL-048 acceptance criteria 4, 5 and 6 (the driver's oracles + the
 * discrimination floor): the cross-workload competitive families'
 * mechanical verification over the RECORDED arm corpora.
 *
 *   * the statistics: the exact paired sign test's p-values numerically
 *     pinned; the Bonferroni policy arithmetic verified; the Wilson
 *     interval carried on every verdict;
 *   * the oracle matrices: portfolio honesty (the declared portfolio IS
 *     the recorded portfolio — a cherry-picked subset FAILs with the
 *     omitted classes named), unit comparability (pooled incomparable
 *     units FAIL named), cost-basis integrity (a mid-comparison basis
 *     switch FAILs with both sides named), paired-statistics
 *     correctness (an unpaired claim over paired evidence FAILs
 *     named), multiple-comparison honesty (a verdict below its
 *     evidence FAILs named), minimum-sample enforcement (a
 *     below-minimum verdict claim FAILs named — the honest verdict is
 *     the under-powered refusal), weighting disclosure (the
 *     aggregate's weights explicit, positive, sum-checked), failure-cost
 *     completeness (a dropped failure cost FAILs named) and the
 *     estimate/measure separation;
 *   * the input-integrity matrix: the honest digest-referenced arm
 *     bundles verify against the RECORDED corpora field-by-field +
 *     cross-checked against each arm's own corpus extractor; a
 *     re-measurement masquerade FAILs; a disagreeing digest FAILs; an
 *     unresolvable reference FAILs;
 *   * the digest discipline (deterministic + discriminating);
 *   * the driver over EVERY offline row (the 7 honest verdict rows
 *     COMPLETE reproducing the pinned competitive outcomes; the 6
 *     adversarial probes FAIL their named criteria with the read-back
 *     agreeing).
 */

import { describe, expect, test } from "vitest";
import {
  COMPETITIVE_CORPUS,
  HEADLINE_COHORT,
  honestCompetitiveInputsOf,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  pinnedCompetitiveInputDigest,
  RECORDED_COMPETITIVE_CLASSES,
  STOP_COHORT,
  taskBodyFor,
  ZERO_COHORT,
} from "../../../benchmarks/validation/apps/economic-competitive-benchmark/corpus";
import type {
  CompetitiveCorpusRow,
  MultipleComparisonPolicy,
  RecordedCompetitiveArm,
  RecordedCompetitiveFacts,
} from "../../../benchmarks/validation/apps/economic-competitive-benchmark/driver";
import {
  analyzePairwiseComparison,
  DEFAULT_MINIMUM_DISTINCT_ARMS,
  DEFAULT_MINIMUM_PAIRED_ROUNDS,
  deriveCompetitiveInputIntegrity,
  deriveCompetitiveSynthesis,
  deriveCostBasisIntegrity,
  deriveEstimateMeasureSeparation,
  deriveFailureCostCompleteness,
  deriveMinimumSampleEnforcement,
  deriveMultipleComparisonHonesty,
  derivePairedStatisticsCorrectness,
  derivePortfolioHonesty,
  deriveUnitComparability,
  deriveWeightingDisclosure,
  driveCompetitiveRow,
  exactTwoSidedSignTestPValue,
  familyAdjustedPerResolvedMicroUsd,
  liveCompetitivePlanDigestOf,
  MULTIPLE_COMPARISON_POLICY,
  recordedCompetitiveArmOf,
  recordedCompetitiveDigestOf,
  WILSON_CONFIG,
} from "../../../benchmarks/validation/apps/economic-competitive-benchmark/driver";
import {
  applyCompetitiveAdversarialVariant,
  competitiveInputsForRow,
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createRealAccountingRails,
  createTickClock,
} from "../../../benchmarks/validation/apps/economic-competitive-benchmark/fixtures";
import type { LabVerificationCriterion } from "../../../benchmarks/validation/platform/derive";
import type { RunMetadata } from "../../../benchmarks/validation/run-identity";

const REVISION = "a48d09be1d4c05e3f6a2b8d9e0c1a2b3c4d5e6f";

const metadataOf = (observedAt: string): RunMetadata => ({
  program: "zeck-validation",
  workOrder: "VAL-048",
  baseRevision: REVISION,
  applicationRevision: REVISION,
  corpusRevision: "val-048-competitive-benchmark-v1",
  integrationSurface: "competitive:recorded-arm-history",
  environment: {
    runtime: "node test",
    toolchain: "vitest",
    database: "none",
    configuration: { suite: "val-048-unit" },
  },
  observedAt,
});

const rowById = (rowId: string): CompetitiveCorpusRow => {
  const row = COMPETITIVE_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const criterionOf = (
  result: { criteria: readonly LabVerificationCriterion[] },
  id: string | undefined,
) => result.criteria.find((criterion) => criterion.criterionId === id);

/** Drive one row over the honest offline stack (the unit oracle floor). */
async function driveRowOverHonestStack(row: CompetitiveCorpusRow) {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const seam = createFakeSubmissionSeam({ ledger });
  const lifecycle = createFakeLifecycle({ ledger });
  const baseline = ledger.facts();
  const submission = await seam({ key: `val-048-unit-${row.rowId}`, body: taskBodyFor({ row }) });
  const result = await driveCompetitiveRow({
    row,
    lifecycle,
    arms: competitiveInputsForRow(row),
    recordedClasses: RECORDED_COMPETITIVE_CLASSES,
    rails: createRealAccountingRails(),
    metadata: metadataOf(clock.now().toISOString()),
    environmentIdentity: `val-048-unit-${row.rowId}`,
    baseline,
    worldFacts: ledger.facts,
    landedProvider: async () => [submission.executionId],
    now: clock.now,
  });
  return { result, lifecycle, ledger };
}

// ---------------------------------------------------------------------------
// The pinned vocabulary
// ---------------------------------------------------------------------------

describe("VAL-048 competitive vocabulary (the pinned policies)", () => {
  test("the Wilson configuration and the statistical floors are pinned", () => {
    expect(WILSON_CONFIG.confidenceLevel).toBe(0.95);
    expect(DEFAULT_MINIMUM_PAIRED_ROUNDS).toBe(5);
    expect(DEFAULT_MINIMUM_DISTINCT_ARMS).toBe(4);
  });

  test("the Bonferroni policy arithmetic holds (the family-wise honesty)", () => {
    expect(MULTIPLE_COMPARISON_POLICY.method).toBe("bonferroni");
    expect(MULTIPLE_COMPARISON_POLICY.familyWiseLevel).toBe(0.05);
    expect(MULTIPLE_COMPARISON_POLICY.familySize).toBe(3);
    expect(MULTIPLE_COMPARISON_POLICY.perComparisonLevel).toBeCloseTo(0.05 / 3, 12);
  });

  test("every ranking row declares a policy covering its pairwise family", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      if (row.family === "portfolio-weighted-aggregate") {
        continue;
      }
      const pairwise = row.armSet.filter((reference) => reference.armKind !== "zeck").length;
      expect(row.multipleComparison.familySize, row.rowId).toBeGreaterThanOrEqual(pairwise);
      expect(row.multipleComparison.perComparisonLevel, row.rowId).toBeCloseTo(
        row.multipleComparison.familyWiseLevel / row.multipleComparison.familySize,
        12,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The exact paired sign test (numerically pinned)
// ---------------------------------------------------------------------------

describe("VAL-048 the exact paired sign test", () => {
  test("the exact two-sided p-values are numerically pinned", () => {
    expect(exactTwoSidedSignTestPValue(0, 0)).toBeNull();
    expect(exactTwoSidedSignTestPValue(1, 0)).toBe(1);
    expect(exactTwoSidedSignTestPValue(4, 2)).toBeCloseTo(0.6875, 12);
    expect(exactTwoSidedSignTestPValue(2, 0)).toBeCloseTo(0.5, 12);
    expect(exactTwoSidedSignTestPValue(8, 0)).toBeCloseTo(0.0078125, 12);
    expect(exactTwoSidedSignTestPValue(5, 0)).toBeCloseTo(0.0625, 12);
    expect(exactTwoSidedSignTestPValue(3, 3)).toBe(1);
    expect(exactTwoSidedSignTestPValue(0, 8)).toBeCloseTo(0.0078125, 12);
  });

  test("a decisive 7-of-7 majority is the Bonferroni-significant boundary", () => {
    // 2 × (1/2)^7 = 0.015625 ≤ 0.016667 — the smallest block count that
    // can reach the corrected level; 6-of-6 (0.03125) cannot.
    expect(exactTwoSidedSignTestPValue(7, 0)!).toBeLessThanOrEqual(
      MULTIPLE_COMPARISON_POLICY.perComparisonLevel,
    );
    expect(exactTwoSidedSignTestPValue(6, 0)!).toBeGreaterThan(
      MULTIPLE_COMPARISON_POLICY.perComparisonLevel,
    );
  });
});

// ---------------------------------------------------------------------------
// The family-adjusted derivations (numerically pinned over the recorded corpora)
// ---------------------------------------------------------------------------

describe("VAL-048 the family-adjusted derivations (the adjusted basis)", () => {
  const honest = honestCompetitiveInputsOf(HEADLINE_COHORT.armSet);
  const zeck = honest.find((arm) => arm.reference.armKind === "zeck") as RecordedCompetitiveArm;
  const direct = honest.find((arm) => arm.reference.armKind === "direct") as RecordedCompetitiveArm;
  const optimized = honest.find(
    (arm) => arm.reference.armKind === "optimized",
  ) as RecordedCompetitiveArm;
  const competing = honest.find(
    (arm) => arm.reference.armKind === "competing",
  ) as RecordedCompetitiveArm;

  test("the headline cohort's per-arm recorded aggregates (the extractor floor)", () => {
    expect(zeck.facts.runCount).toBe(8);
    expect(zeck.facts.resolvedCount).toBe(8);
    expect(direct.facts.runCount).toBe(8);
    expect(direct.facts.resolvedCount).toBe(8);
    expect(optimized.facts.runCount).toBe(8);
    expect(optimized.facts.resolvedCount).toBe(8);
    expect(competing.facts.runCount).toBe(8);
    expect(competing.facts.resolvedCount).toBe(8);
  });

  test("the failure-adjusted per-resolved costs are numerically pinned", () => {
    const family = "failure-adjusted-ranking" as const;
    expect(familyAdjustedPerResolvedMicroUsd({ family, facts: zeck.facts })).toBe("22");
    expect(familyAdjustedPerResolvedMicroUsd({ family, facts: direct.facts })).toBe("24");
    expect(familyAdjustedPerResolvedMicroUsd({ family, facts: optimized.facts })).toBe("69");
    expect(familyAdjustedPerResolvedMicroUsd({ family, facts: competing.facts })).toBe("26");
  });

  test("the quality-adjusted per-resolved costs penalize the attainment gap exactly", () => {
    const family = "quality-adjusted-ranking" as const;
    expect(familyAdjustedPerResolvedMicroUsd({ family, facts: zeck.facts })).toBe("22");
    expect(familyAdjustedPerResolvedMicroUsd({ family, facts: optimized.facts })).toBe("69");
    // The stop cohort's 2-of-3 attainment is penalized: (measured ×
    // runs) / (resolved × resolved) — the quality gap prices in.
    const stopInputs = honestCompetitiveInputsOf(STOP_COHORT.armSet);
    const stopZeck = stopInputs.find(
      (arm) => arm.reference.armKind === "zeck",
    ) as RecordedCompetitiveArm;
    const failureAdjusted = familyAdjustedPerResolvedMicroUsd({
      family: "failure-adjusted-ranking",
      facts: stopZeck.facts,
    }) as string;
    const qualityAdjusted = familyAdjustedPerResolvedMicroUsd({
      family,
      facts: stopZeck.facts,
    }) as string;
    expect(BigInt(qualityAdjusted)).toBeGreaterThan(BigInt(failureAdjusted));
  });

  test("the latency-adjusted per-resolved costs weigh the compliance (the overage priced in)", () => {
    const family = "latency-adjusted-ranking" as const;
    expect(
      familyAdjustedPerResolvedMicroUsd({ family, facts: zeck.facts, latencyBudgetMs: 1000 }),
    ).toBe("22");
    // The competing arm's two overage blocks (1270ms each against the
    // 1000ms budget) price into its latency-adjusted cost.
    const compliant = familyAdjustedPerResolvedMicroUsd({
      family,
      facts: competing.facts,
      latencyBudgetMs: 1000,
    }) as string;
    const failureOnly = familyAdjustedPerResolvedMicroUsd({
      family: "failure-adjusted-ranking",
      facts: competing.facts,
    }) as string;
    expect(BigInt(compliant)).toBeGreaterThan(BigInt(failureOnly));
  });

  test("a null basis stays NULL (never a zero-denominator fabrication)", () => {
    const zeroInputs = honestCompetitiveInputsOf(ZERO_COHORT.armSet);
    for (const arm of zeroInputs) {
      expect(arm.facts.resolvedCount).toBe(0);
      expect(arm.facts.costPerResolvedMicroUsd).toBeNull();
      for (const family of [
        "quality-adjusted-ranking",
        "latency-adjusted-ranking",
        "failure-adjusted-ranking",
      ] as const) {
        expect(
          familyAdjustedPerResolvedMicroUsd({
            family,
            facts: arm.facts,
            ...(family === "latency-adjusted-ranking" ? { latencyBudgetMs: 1000 } : {}),
          }),
        ).toBeNull();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The pairwise block analysis (the paired structure)
// ---------------------------------------------------------------------------

describe("VAL-048 the pairwise block analysis (the paired structure preserved)", () => {
  const honest = honestCompetitiveInputsOf(HEADLINE_COHORT.armSet);
  const zeck = honest.find((arm) => arm.reference.armKind === "zeck") as RecordedCompetitiveArm;

  test("the headline pairwise comparisons derive the pinned statistics", () => {
    for (const armKind of ["direct", "optimized", "competing"] as const) {
      const alternative = honest.find(
        (candidate) => candidate.reference.armKind === armKind,
      ) as RecordedCompetitiveArm;
      const comparison = analyzePairwiseComparison({
        family: "quality-adjusted-ranking",
        minimumPairedRounds: 5,
        policy: MULTIPLE_COMPARISON_POLICY,
        zeck,
        alternative,
      });
      expect(comparison.totalBlocks, armKind).toBe(8);
      expect(comparison.minimumMet, armKind).toBe(true);
      expect(comparison.verdict, armKind).toBe("statistical-tie");
    }
  });

  test("the both-unresolved blocks are excluded and the one-resolved blocks disclosed", () => {
    const stopInputs = honestCompetitiveInputsOf(STOP_COHORT.armSet);
    const stopZeck = stopInputs.find(
      (arm) => arm.reference.armKind === "zeck",
    ) as RecordedCompetitiveArm;
    const stopDirect = stopInputs.find(
      (arm) => arm.reference.armKind === "direct",
    ) as RecordedCompetitiveArm;
    const comparison = analyzePairwiseComparison({
      family: "quality-adjusted-ranking",
      minimumPairedRounds: 5,
      policy: MULTIPLE_COMPARISON_POLICY,
      zeck: stopZeck,
      alternative: stopDirect,
    });
    expect(comparison.totalBlocks).toBe(3);
    // The third block is both-unresolved (both arms' third round
    // failed) — excluded from the cost test.
    expect(comparison.excludedBlocks).toBe(1);
    expect(comparison.zeckFavoring).toBe(0);
    expect(comparison.alternativeFavoring).toBe(0);
    expect(comparison.pValueTwoSided).toBeNull();
    expect(comparison.verdict).toBe("under-powered");
  });

  test("a decisive block majority yields the significant verdict (the machinery exists)", () => {
    // A synthetic 6-of-6 zeck-favoring block set: the paired machinery
    // DOES produce significant verdicts when the evidence supports
    // them (the honest corpus simply does not — the honest tie).
    const syntheticFacts = (cost: string): RecordedCompetitiveFacts => ({
      rounds: Array.from({ length: 6 }, (_, index) => ({
        roundIndex: index,
        resolved: true,
        measuredCostMicroUsd: cost,
        retryOverheadMicroUsd: "0",
        latencyMs: 800,
        failedAttempts: 0,
      })),
      runCount: 6,
      resolvedCount: 6,
      measuredCostMicroUsd: (BigInt(cost) * 6n).toString(),
      estimatedCostMicroUsd: "0",
      costPerResolvedMicroUsd: cost,
      resolutionConfidence: { low: 0.6, high: 0.9 },
      retryOverheadMicroUsd: "0",
      failedAttemptsCount: 0,
      resolvedRoundsMicroUsd: (BigInt(cost) * 6n).toString(),
      failedRoundsMicroUsd: "0",
    });
    const cheap: RecordedCompetitiveArm = {
      reference: {
        armKind: "zeck",
        corpusRowId: "synthetic-cheap",
        recordedDigest: "deadbeef",
        priceRevision: "rev-001",
        workloadClass: "synthetic",
      },
      facts: syntheticFacts("10"),
    };
    const expensive: RecordedCompetitiveArm = {
      reference: {
        armKind: "direct",
        corpusRowId: "synthetic-expensive",
        recordedDigest: "deadbeef",
        priceRevision: "rev-001",
        workloadClass: "synthetic",
      },
      facts: syntheticFacts("40"),
    };
    const comparison = analyzePairwiseComparison({
      family: "failure-adjusted-ranking",
      minimumPairedRounds: 5,
      policy: MULTIPLE_COMPARISON_POLICY,
      zeck: cheap,
      alternative: expensive,
    });
    expect(comparison.zeckFavoring).toBe(6);
    expect(comparison.alternativeFavoring).toBe(0);
    expect(comparison.pValueTwoSided).toBeCloseTo(0.03125, 12);
    // 0.03125 > the Bonferroni level 0.016667 — still an honest tie at
    // the corrected level (multiple-comparison honesty carried).
    expect(comparison.verdict).toBe("statistical-tie");
    const lenient: MultipleComparisonPolicy = {
      method: "bonferroni",
      familyWiseLevel: 0.05,
      familySize: 1,
      perComparisonLevel: 0.05,
    };
    const significant = analyzePairwiseComparison({
      family: "failure-adjusted-ranking",
      minimumPairedRounds: 5,
      policy: lenient,
      zeck: cheap,
      alternative: expensive,
    });
    expect(significant.verdict).toBe("zeck-wins-significant");
  });
});

// ---------------------------------------------------------------------------
// The oracle matrices (each adversarial shape FAILs its NAMED criterion)
// ---------------------------------------------------------------------------

describe("VAL-048 portfolio honesty (the cherry-picking catch)", () => {
  test("the honest rows declare the recorded portfolio", () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.adversarial === undefined,
    )) {
      const verdict = derivePortfolioHonesty({
        row,
        recordedClasses: RECORDED_COMPETITIVE_CLASSES,
      });
      expect(verdict.conformant, row.rowId).toBe(true);
    }
  });

  test("the subset-cherry-picking probe FAILs with the omitted classes named", () => {
    const row = rowById("probe-subset-cherry-picking");
    const verdict = derivePortfolioHonesty({
      row,
      recordedClasses: RECORDED_COMPETITIVE_CLASSES,
    });
    expect(verdict.conformant).toBe(false);
    expect(verdict.omittedClasses).toContain("zero-resolved-honest");
    expect(verdict.omittedClasses).toContain("budget-stop-prefix");
    expect(verdict.evidence.join(" ")).toContain("CHERRY-PICKED PORTFOLIO");
  });

  test("an unknown declared class FAILs named", () => {
    const row = rowById("confirmation-fixed-quality-quality-adjusted-ranking");
    const verdict = derivePortfolioHonesty({
      row: { ...row, workloadClass: "fabricated-class" },
      recordedClasses: RECORDED_COMPETITIVE_CLASSES,
    });
    expect(verdict.conformant).toBe(false);
    expect(verdict.unknownClasses).toContain("fabricated-class");
  });
});

describe("VAL-048 unit comparability (the pooling catch)", () => {
  test("the honest bundles verify (every block the cohort's own recorded round)", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const verdict = deriveUnitComparability({
        row,
        arms: honestCompetitiveInputsOf(row.armSet),
      });
      expect(verdict.conformant, row.rowId).toBe(true);
    }
  });

  test("the unit-pooling knob FAILs with the pooled blocks named", () => {
    const row = rowById("probe-unit-pooling");
    const pooled = applyCompetitiveAdversarialVariant(honestCompetitiveInputsOf(row.armSet), {
      unitPooling: true,
    });
    const verdict = deriveUnitComparability({ row, arms: pooled });
    expect(verdict.conformant).toBe(false);
    expect(verdict.pooledBlocks.length).toBeGreaterThan(0);
    expect(verdict.evidence.join(" ")).toContain("POOLED INCOMPARABLE UNITS");
    for (const arm of pooled) {
      // 8 headline blocks + 6 zero-cohort blocks = 14 pooled blocks.
      expect(arm.facts.rounds.length).toBe(14);
    }
  });
});

describe("VAL-048 cost-basis integrity (the basis-switching catch)", () => {
  test("the honest rows hold the family basis on both sides", () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.adversarial === undefined,
    )) {
      const synthesis = deriveCompetitiveSynthesis({
        row,
        arms: honestCompetitiveInputsOf(row.armSet),
      });
      const verdict = deriveCostBasisIntegrity({ row, comparisons: synthesis.comparisons });
      expect(verdict.conformant, row.rowId).toBe(true);
    }
  });

  test("the basis-switching probe FAILs with both sides named", () => {
    const row = rowById("probe-cost-basis-switching");
    const synthesis = deriveCompetitiveSynthesis({
      row,
      arms: honestCompetitiveInputsOf(row.armSet),
    });
    const verdict = deriveCostBasisIntegrity({ row, comparisons: synthesis.comparisons });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("MIXED BASES");
    expect(evidence).toContain("unadjusted-measured-total");
    expect(evidence).toContain("COST-BASIS SWITCHING");
  });
});

describe("VAL-048 paired-statistics correctness (the unpaired claim catch)", () => {
  test("the honest rows ride the paired sign test", () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.adversarial === undefined,
    )) {
      const synthesis = deriveCompetitiveSynthesis({
        row,
        arms: honestCompetitiveInputsOf(row.armSet),
      });
      const verdict = derivePairedStatisticsCorrectness({
        row,
        comparisons: synthesis.comparisons,
      });
      expect(verdict.conformant, row.rowId).toBe(true);
      expect(verdict.evidence.join(" ")).toContain("statistic:paired-sign-test");
    }
  });

  test("the unpaired-statistics probe FAILs named", () => {
    const row = rowById("probe-unpaired-statistics");
    const synthesis = deriveCompetitiveSynthesis({
      row,
      arms: honestCompetitiveInputsOf(row.armSet),
    });
    const verdict = derivePairedStatisticsCorrectness({
      row,
      comparisons: synthesis.comparisons,
    });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("UNPAIRED STATISTIC OVER PAIRED EVIDENCE");
  });
});

describe("VAL-048 multiple-comparison honesty (the confidence-inflation catch)", () => {
  test("the honest rows carry the declared family-wise policy", () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.adversarial === undefined,
    )) {
      const synthesis = deriveCompetitiveSynthesis({
        row,
        arms: honestCompetitiveInputsOf(row.armSet),
      });
      const verdict = deriveMultipleComparisonHonesty({
        row,
        comparisons: synthesis.comparisons,
      });
      expect(verdict.conformant, row.rowId).toBe(true);
    }
  });

  test("the confidence-inflation probe FAILs with the derived p-values named", () => {
    const row = rowById("probe-confidence-inflation");
    const synthesis = deriveCompetitiveSynthesis({
      row,
      arms: honestCompetitiveInputsOf(row.armSet),
    });
    const verdict = deriveMultipleComparisonHonesty({
      row,
      comparisons: synthesis.comparisons,
    });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("CONFIDENCE INFLATION");
    expect(evidence).toContain("0.008000");
  });

  test("a mutated policy arithmetic FAILs named", () => {
    const row = rowById("confirmation-fixed-quality-quality-adjusted-ranking");
    const synthesis = deriveCompetitiveSynthesis({
      row,
      arms: honestCompetitiveInputsOf(row.armSet),
    });
    const verdict = deriveMultipleComparisonHonesty({
      row: {
        ...row,
        multipleComparison: {
          method: "bonferroni",
          familyWiseLevel: 0.05,
          familySize: 3,
          perComparisonLevel: 0.05,
        },
      },
      comparisons: synthesis.comparisons,
    });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("POLICY ARITHMETIC");
  });
});

describe("VAL-048 minimum-sample enforcement (the starvation catch)", () => {
  test("the honest under-powered refusal PASSES (the class reported, never dropped)", () => {
    const row = rowById("budget-stop-prefix-quality-adjusted-underpowered");
    const synthesis = deriveCompetitiveSynthesis({
      row,
      arms: honestCompetitiveInputsOf(row.armSet),
    });
    const verdict = deriveMinimumSampleEnforcement({
      row,
      comparisons: synthesis.comparisons,
    });
    expect(verdict.conformant).toBe(true);
    expect(synthesis.verdict).toBe("under-powered");
    expect(verdict.evidence.join(" ")).toContain("UNDER-POWERED");
  });

  test("the sample-starvation probe FAILs named", () => {
    const row = rowById("probe-sample-starvation");
    const synthesis = deriveCompetitiveSynthesis({
      row,
      arms: honestCompetitiveInputsOf(row.armSet),
    });
    const verdict = deriveMinimumSampleEnforcement({
      row,
      comparisons: synthesis.comparisons,
    });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("BELOW-MINIMUM VERDICT CLAIM");
  });

  test("an under-powered claim on a POWERED class FAILs named", () => {
    const row = rowById("confirmation-fixed-quality-quality-adjusted-ranking");
    const synthesis = deriveCompetitiveSynthesis({
      row,
      arms: honestCompetitiveInputsOf(row.armSet),
    });
    const verdict = deriveMinimumSampleEnforcement({
      row: { ...row, expected: { ...row.expected, verdict: "under-powered" } },
      comparisons: synthesis.comparisons,
    });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("UNDER-POWERED CLAIM WITH POWER");
  });
});

describe("VAL-048 weighting disclosure (the aggregate's explicit weights)", () => {
  test("the aggregate's declared weights are explicit, positive and sum to one", () => {
    const row = rowById("cross-workload-portfolio-weighted-aggregate");
    const verdict = deriveWeightingDisclosure({
      row,
      recordedClasses: RECORDED_COMPETITIVE_CLASSES,
    });
    expect(verdict.conformant).toBe(true);
    const sum = (row.declaredWeights ?? []).reduce((total, entry) => total + entry.weight, 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  test("a weight sum away from one FAILs named", () => {
    const row = rowById("cross-workload-portfolio-weighted-aggregate");
    const mutated = {
      ...row,
      declaredWeights: (row.declaredWeights ?? []).map((entry, index) =>
        index === 0 ? { ...entry, weight: 0.7 } : entry,
      ),
    };
    const verdict = deriveWeightingDisclosure({
      row: mutated,
      recordedClasses: RECORDED_COMPETITIVE_CLASSES,
    });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("WEIGHTS SUM");
  });

  test("a non-positive weight FAILs named", () => {
    const row = rowById("cross-workload-portfolio-weighted-aggregate");
    const mutated = {
      ...row,
      declaredWeights: (row.declaredWeights ?? []).map((entry, index) =>
        index === 1 ? { ...entry, weight: 0 } : entry,
      ),
    };
    const verdict = deriveWeightingDisclosure({
      row: mutated,
      recordedClasses: RECORDED_COMPETITIVE_CLASSES,
    });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("NON-POSITIVE WEIGHT");
  });
});

describe("VAL-048 failure-cost completeness + estimate/measure separation", () => {
  test("the honest bundles' failure costs amortize exactly", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const arms = honestCompetitiveInputsOf(row.armSet);
      const failure = deriveFailureCostCompleteness({ arms });
      expect(failure.conformant, row.rowId).toBe(true);
      const separation = deriveEstimateMeasureSeparation({ arms });
      expect(separation.conformant, row.rowId).toBe(true);
    }
  });

  test("a dropped failure cost FAILs named", () => {
    // The STOP cohort's direct arm holds a real failed round (the third
    // block's honest failure) — zeroing its share while keeping the
    // measured total drops a failure cost.
    const arms = honestCompetitiveInputsOf(STOP_COHORT.armSet);
    const denatured = arms.map((arm) =>
      arm.reference.armKind === "direct"
        ? {
            ...arm,
            facts: {
              ...arm.facts,
              failedRoundsMicroUsd: "0",
            },
          }
        : arm,
    );
    const verdict = deriveFailureCostCompleteness({ arms: denatured });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("FAILURE COST DROPPED");
  });
});

// ---------------------------------------------------------------------------
// The input-integrity matrix (the re-measurement masquerade catch)
// ---------------------------------------------------------------------------

describe("VAL-048 competitive input integrity (the strongest anchor)", () => {
  test("every honest arm bundle IS the recorded corpus's own derivation", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const verdict = deriveCompetitiveInputIntegrity({
        arms: honestCompetitiveInputsOf(row.armSet),
      });
      expect(verdict.conformant, row.rowId).toBe(true);
      expect(verdict.verdicts).toHaveLength(row.armSet.length);
    }
  });

  test("a re-measured cost FAILs field by field", () => {
    const arms = applyCompetitiveAdversarialVariant(
      honestCompetitiveInputsOf(HEADLINE_COHORT.armSet),
      { remeasurement: true },
    );
    const verdict = deriveCompetitiveInputIntegrity({ arms });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("RE-MEASUREMENT MASQUERADE");
  });

  test("a disagreeing digest FAILs named", () => {
    const arms = honestCompetitiveInputsOf(HEADLINE_COHORT.armSet).map((arm) =>
      arm.reference.armKind === "zeck"
        ? {
            ...arm,
            reference: { ...arm.reference, recordedDigest: "ffffffff" },
          }
        : arm,
    );
    const verdict = deriveCompetitiveInputIntegrity({ arms });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("digest");
  });

  test("an unresolvable reference FAILs named", () => {
    const arms = honestCompetitiveInputsOf(HEADLINE_COHORT.armSet).map((arm) =>
      arm.reference.armKind === "zeck"
        ? {
            ...arm,
            reference: { ...arm.reference, corpusRowId: "no-such-row" },
          }
        : arm,
    );
    const verdict = deriveCompetitiveInputIntegrity({ arms });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("no recorded arm");
  });
});

// ---------------------------------------------------------------------------
// The digest discipline
// ---------------------------------------------------------------------------

describe("VAL-048 the digest discipline", () => {
  test("the arm digests are deterministic and discriminating (8-hex)", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      for (const reference of row.armSet) {
        expect(reference.recordedDigest, `${row.rowId}/${reference.armKind}`).toMatch(
          /^[0-9a-f]{8}$/,
        );
      }
    }
    const first = honestCompetitiveInputsOf(HEADLINE_COHORT.armSet);
    const second = honestCompetitiveInputsOf(HEADLINE_COHORT.armSet);
    for (const [index, arm] of first.entries()) {
      const other = second[index] as RecordedCompetitiveArm;
      expect(
        recordedCompetitiveDigestOf({
          armKind: arm.reference.armKind,
          corpusRowId: arm.reference.corpusRowId,
          facts: arm.facts,
        }),
      ).toBe(
        recordedCompetitiveDigestOf({
          armKind: other.reference.armKind,
          corpusRowId: other.reference.corpusRowId,
          facts: other.facts,
        }),
      );
    }
    // Discriminating: a one-micro-USD denaturation changes the digest.
    const denaturedZeck = first.find(
      (arm) => arm.reference.armKind === "zeck",
    ) as RecordedCompetitiveArm;
    const honestDigest = recordedCompetitiveDigestOf({
      armKind: "zeck",
      corpusRowId: denaturedZeck.reference.corpusRowId,
      facts: denaturedZeck.facts,
    });
    const denatured = applyCompetitiveAdversarialVariant(first, { remeasurement: true });
    const denaturedDigest = recordedCompetitiveDigestOf({
      armKind: "zeck",
      corpusRowId: denaturedZeck.reference.corpusRowId,
      facts: (denatured.find((arm) => arm.reference.armKind === "zeck") as RecordedCompetitiveArm)
        .facts,
    });
    expect(denaturedDigest).not.toBe(honestDigest);
  });

  test("the corpus input digest is deterministic + discriminating", () => {
    expect(pinnedCompetitiveInputDigest()).toMatch(/^[0-9a-f]{8}$/);
    expect(pinnedCompetitiveInputDigest()).toBe(pinnedCompetitiveInputDigest());
  });

  test("the live plan digest is deterministic (the declaration reference)", () => {
    expect(liveCompetitivePlanDigestOf()).toMatch(/^[0-9a-f]{8}$/);
    expect(liveCompetitivePlanDigestOf()).toBe(liveCompetitivePlanDigestOf());
  });
});

// ---------------------------------------------------------------------------
// The driver over every offline row (the honest outcome contract)
// ---------------------------------------------------------------------------

describe("VAL-048 the driver over every offline row (the honest outcome contract)", () => {
  /** Each adversarial probe row's NAMED criterion (the honest failure). */
  const probeNamedCriterion: Readonly<Record<string, string>> = {
    "probe-subset-cherry-picking": "portfolio-honesty",
    "probe-unit-pooling": "unit-comparability",
    "probe-cost-basis-switching": "cost-basis-integrity",
    "probe-unpaired-statistics": "paired-statistics",
    "probe-confidence-inflation": "multiple-comparison-honesty",
    "probe-sample-starvation": "minimum-sample-enforcement",
  };

  test("every honest control row COMPLETES reproducing the pinned competitive outcomes", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.adversarial === undefined,
    )) {
      const { result } = await driveRowOverHonestStack(row);
      expect(result.terminal, row.rowId).toBe("COMPLETED");
      expect(result.failure, row.rowId).toBeNull();
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(result.observedTerminal, row.rowId).toBe("COMPLETED");
      // The pinned synthesis reproduces field-for-field.
      const synthesis = result.synthesis;
      const expected = row.expected.synthesis;
      if (expected !== undefined && synthesis !== null) {
        expect(synthesis.verdict, row.rowId).toBe(expected.verdict);
        expect(synthesis.ranking.join(","), row.rowId).toBe(expected.ranking.join(","));
        expect(
          synthesis.arms
            .map((arm) => `${arm.armKind}=${arm.adjustedPerResolvedMicroUsd}`)
            .join(","),
          row.rowId,
        ).toBe(
          expected.arms.map((arm) => `${arm.armKind}=${arm.adjustedPerResolvedMicroUsd}`).join(","),
        );
      }
      expect(result.arms).toHaveLength(row.armSet.length);
      for (const arm of result.arms) {
        expect(arm.integrity, `${row.rowId}/${arm.reference.armKind}`).toBe(true);
      }
    }
  });

  test("every adversarial PROBE row FAILs its NAMED criterion honestly", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.adversarial !== undefined,
    )) {
      const { result } = await driveRowOverHonestStack(row);
      expect(result.terminal, row.rowId).toBe("FAILED");
      expect(result.observedTerminal, row.rowId).toBe("FAILED");
      const named = probeNamedCriterion[row.rowId];
      expect(named, row.rowId).toBeDefined();
      const criterion = criterionOf(result, named);
      expect(criterion?.status, `${row.rowId} ${named}`).toBe("FAIL");
      expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
      expect(criterionOf(result, "row-outcome-contract")?.status).toBe("PASS");
    }
  });
});

// ---------------------------------------------------------------------------
// The live lane declaration honesty
// ---------------------------------------------------------------------------

describe("VAL-048 the live lane declaration", () => {
  test("the live row is env-gated on the operator credential", () => {
    const row = rowById("live-competitive-real-dispatch-slice");
    expect(row.needsDispatch).toBe(true);
    expect(row.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
    expect(liveGateOpen(row, {})).toBe(false);
    expect(liveGateOpen(row, { OPENROUTER_API_KEY: "" })).toBe(false);
    expect(liveGateOpen(row, { OPENROUTER_API_KEY: "test-key" })).toBe(true);
  });

  test("the live row's primary pair declares 4 rounds at the honest floor of 3", () => {
    const row = rowById("live-competitive-real-dispatch-slice");
    expect(row.minimumPairedRounds).toBe(3);
    expect(row.armSet).toHaveLength(2);
    expect(row.armSet.every((reference) => reference.live === true)).toBe(true);
    // 4 paired blocks cannot reach even the uncorrected 0.05 level
    // (2 × (1/2)^4 = 0.125) — the honest a-priori verdict is the tie.
    expect(exactTwoSidedSignTestPValue(4, 0)!).toBeGreaterThan(0.05);
    expect(row.expected.verdict).toBe("statistical-tie");
  });

  test("the recorded extractor refuses fabricated references", () => {
    expect(
      recordedCompetitiveArmOf({
        armKind: "zeck",
        corpusRowId: "no-such-row",
        recordedDigest: "00000000",
        priceRevision: "rev-001",
        workloadClass: "sdk",
      }),
    ).toBeNull();
  });
});
