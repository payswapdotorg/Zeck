/**
 * VAL-048 acceptance criterion 6 — the discrimination battery: the
 * competitive comparison families against controlled fakes.
 *
 * Every comparison family the work order names is probed adversarially
 * at THREE levels: the derivation-level catch (the PURE oracle over
 * the denatured inputs — the NAMED evidence asserted verbatim), the
 * row-level catch (the probe row over the purpose-built leaky stack —
 * the landed execution chain with the REAL accounting rails), and the
 * honest control (the honest derivation PASSING the same oracle):
 *
 *   * subset cherry-picking (portfolio honesty),
 *   * unit pooling (unit comparability),
 *   * cost-basis switching (cost-basis integrity),
 *   * unpaired statistics (paired-statistics correctness),
 *   * confidence inflation (multiple-comparison honesty),
 *   * sample starvation (minimum-sample enforcement);
 * plus the paired-sign-test application, the Bonferroni policy
 * discipline, the Wilson interval and the digest discipline; and the
 * honest controls over the fixture stack (every honest row COMPLETES;
 * every probe FAILs its NAMED criterion with the read-back agreeing).
 */

import { describe, expect, test } from "vitest";
import {
  COMPETITIVE_CORPUS,
  HEADLINE_COHORT,
  honestCompetitiveInputsOf,
  OFFLINE_CORPUS_ROWS,
  RECORDED_COMPETITIVE_CLASSES,
  STOP_COHORT,
  taskBodyFor,
} from "../../benchmarks/validation/apps/economic-competitive-benchmark/corpus";
import type {
  CompetitiveCorpusRow,
  RecordedCompetitiveArm,
} from "../../benchmarks/validation/apps/economic-competitive-benchmark/driver";
import {
  deriveCompetitiveInputIntegrity,
  deriveCompetitiveSynthesis,
  deriveCostBasisIntegrity,
  deriveMinimumSampleEnforcement,
  deriveMultipleComparisonHonesty,
  derivePairedStatisticsCorrectness,
  derivePortfolioHonesty,
  deriveUnitComparability,
  driveCompetitiveRow,
  exactTwoSidedSignTestPValue,
  MULTIPLE_COMPARISON_POLICY,
  recordedCompetitiveDigestOf,
} from "../../benchmarks/validation/apps/economic-competitive-benchmark/driver";
import {
  applyCompetitiveAdversarialVariant,
  competitiveInputsForRow,
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createRealAccountingRails,
  createTickClock,
} from "../../benchmarks/validation/apps/economic-competitive-benchmark/fixtures";
import type { LabVerificationCriterion } from "../../benchmarks/validation/platform/derive";
import type { RunMetadata } from "../../benchmarks/validation/run-identity";

const REVISION = "b52e17cf2f9d16a0e7b4c3d2a1908f7e6d5c4b3a2";

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
    configuration: { suite: "val-048-discrimination" },
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

const honestInputsOfRow = (row: CompetitiveCorpusRow): readonly RecordedCompetitiveArm[] =>
  honestCompetitiveInputsOf(row.armSet);

/** Drive one row over the leaky stack (the landed execution chain). */
async function driveRowOverLeakyStack(options: {
  readonly row: CompetitiveCorpusRow;
  readonly arms?: readonly RecordedCompetitiveArm[];
}) {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const seam = createFakeSubmissionSeam({ ledger });
  const lifecycle = createFakeLifecycle({ ledger });
  const baseline = ledger.facts();
  const inputs = options.arms ?? competitiveInputsForRow(options.row);
  const submission = await seam({
    key: `val-048-disc-${options.row.rowId}`,
    body: taskBodyFor({ row: options.row }),
  });
  const result = await driveCompetitiveRow({
    row: options.row,
    lifecycle,
    arms: inputs,
    recordedClasses: RECORDED_COMPETITIVE_CLASSES,
    rails: createRealAccountingRails(),
    metadata: metadataOf(clock.now().toISOString()),
    environmentIdentity: `val-048-disc-${options.row.rowId}`,
    baseline,
    worldFacts: ledger.facts,
    landedProvider: async () => [submission.executionId],
    now: clock.now,
  });
  return { result, lifecycle, ledger };
}

// ---------------------------------------------------------------------------
// 1. subset cherry-picking (portfolio honesty)
// ---------------------------------------------------------------------------

describe("discrimination: subset cherry-picking", () => {
  test("the derivation-level catch: the omitted classes NAMED", () => {
    const row = rowById("probe-subset-cherry-picking");
    const verdict = derivePortfolioHonesty({
      row,
      recordedClasses: RECORDED_COMPETITIVE_CLASSES,
    });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain(
      "CHERRY-PICKED PORTFOLIO: the declared portfolio omits the recorded classes [zero-resolved-honest, budget-stop-prefix]",
    );
  });

  test("the honest control: the complete declared portfolio PASSES", () => {
    const row = rowById("cross-workload-portfolio-weighted-aggregate");
    const verdict = derivePortfolioHonesty({
      row,
      recordedClasses: RECORDED_COMPETITIVE_CLASSES,
    });
    expect(verdict.conformant).toBe(true);
    expect(verdict.omittedClasses).toEqual([]);
  });

  test("the row-level catch: the probe FAILs portfolio-honesty over the leaky stack", async () => {
    const { result } = await driveRowOverLeakyStack({
      row: rowById("probe-subset-cherry-picking"),
    });
    expect(result.terminal).toBe("FAILED");
    expect(criterionOf(result, "portfolio-honesty")?.status).toBe("FAIL");
    expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// 2. unit pooling (unit comparability)
// ---------------------------------------------------------------------------

describe("discrimination: unit pooling", () => {
  test("the derivation-level catch: the pooled blocks NAMED", () => {
    const row = rowById("probe-unit-pooling");
    const pooled = applyCompetitiveAdversarialVariant(honestInputsOfRow(row), {
      unitPooling: true,
    });
    const verdict = deriveUnitComparability({ row, arms: pooled });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("POOLED INCOMPARABLE UNITS");
    expect(verdict.pooledBlocks.length).toBe(4);
    for (const arm of pooled) {
      expect(arm.facts.rounds.length).toBe(14);
    }
  });

  test("the honest control: the cohort's own blocks PASS", () => {
    const row = rowById("confirmation-fixed-quality-quality-adjusted-ranking");
    const verdict = deriveUnitComparability({ row, arms: honestInputsOfRow(row) });
    expect(verdict.conformant).toBe(true);
    expect(verdict.evidence.join(" ")).toContain("same workload, same gate, same recorded window");
  });

  test("the row-level catch: the probe FAILs unit-comparability over the leaky stack", async () => {
    const row = rowById("probe-unit-pooling");
    const pooled = applyCompetitiveAdversarialVariant(honestInputsOfRow(row), {
      unitPooling: true,
    });
    const { result } = await driveRowOverLeakyStack({ row, arms: pooled });
    expect(result.terminal).toBe("FAILED");
    expect(criterionOf(result, "unit-comparability")?.status).toBe("FAIL");
    expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// 3. cost-basis switching (cost-basis integrity)
// ---------------------------------------------------------------------------

describe("discrimination: cost-basis switching", () => {
  test("the derivation-level catch: both sides NAMED", () => {
    const row = rowById("probe-cost-basis-switching");
    const synthesis = deriveCompetitiveSynthesis({ row, arms: honestInputsOfRow(row) });
    const verdict = deriveCostBasisIntegrity({ row, comparisons: synthesis.comparisons });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("MIXED BASES");
    expect(evidence).toContain("the direct side rides unadjusted-measured-total");
    expect(evidence).toContain("BASIS VALUE NOT RE-DERIVED");
    expect(evidence).toContain("COST-BASIS SWITCHING");
  });

  test("the honest control: the family basis held on both sides", () => {
    for (const rowId of [
      "confirmation-fixed-quality-quality-adjusted-ranking",
      "confirmation-fixed-quality-latency-adjusted-ranking",
      "confirmation-fixed-quality-failure-adjusted-ranking",
    ]) {
      const row = rowById(rowId);
      const synthesis = deriveCompetitiveSynthesis({ row, arms: honestInputsOfRow(row) });
      const verdict = deriveCostBasisIntegrity({ row, comparisons: synthesis.comparisons });
      expect(verdict.conformant, rowId).toBe(true);
      expect(verdict.evidence.join(" "), rowId).toContain(
        "adjusted compared with adjusted — never mixed",
      );
    }
  });

  test("the row-level catch: the probe FAILs cost-basis-integrity over the leaky stack", async () => {
    const { result } = await driveRowOverLeakyStack({
      row: rowById("probe-cost-basis-switching"),
    });
    expect(result.terminal).toBe("FAILED");
    expect(criterionOf(result, "cost-basis-integrity")?.status).toBe("FAIL");
    expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// 4. unpaired statistics (paired-statistics correctness)
// ---------------------------------------------------------------------------

describe("discrimination: unpaired statistics", () => {
  test("the derivation-level catch: the unpaired claim REFUSED", () => {
    const row = rowById("probe-unpaired-statistics");
    const synthesis = deriveCompetitiveSynthesis({ row, arms: honestInputsOfRow(row) });
    const verdict = derivePairedStatisticsCorrectness({
      row,
      comparisons: synthesis.comparisons,
    });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("UNPAIRED STATISTIC OVER PAIRED EVIDENCE");
    expect(evidence).toContain("statistic:paired-sign-test");
  });

  test("the honest control: the paired sign test carried on every verdict", () => {
    const row = rowById("confirmation-fixed-quality-failure-adjusted-ranking");
    const synthesis = deriveCompetitiveSynthesis({ row, arms: honestInputsOfRow(row) });
    const verdict = derivePairedStatisticsCorrectness({
      row,
      comparisons: synthesis.comparisons,
    });
    expect(verdict.conformant).toBe(true);
    expect(verdict.evidence.join(" ")).toContain(
      "the paired statistic's own — the block structure preserved",
    );
  });

  test("the row-level catch: the probe FAILs paired-statistics over the leaky stack", async () => {
    const { result } = await driveRowOverLeakyStack({
      row: rowById("probe-unpaired-statistics"),
    });
    expect(result.terminal).toBe("FAILED");
    expect(criterionOf(result, "paired-statistics")?.status).toBe("FAIL");
    expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// 5. confidence inflation (multiple-comparison honesty)
// ---------------------------------------------------------------------------

describe("discrimination: confidence inflation", () => {
  test("the derivation-level catch: the claimed p not the evidence's own", () => {
    const row = rowById("probe-confidence-inflation");
    const synthesis = deriveCompetitiveSynthesis({ row, arms: honestInputsOfRow(row) });
    const verdict = deriveMultipleComparisonHonesty({
      row,
      comparisons: synthesis.comparisons,
    });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("CONFIDENCE INFLATION");
    expect(evidence).toContain("CLAIMED P-VALUE NOT DERIVED");
    expect(evidence).toContain("0.008000");
  });

  test("the honest control: the family-wise policy carried", () => {
    const row = rowById("confirmation-fixed-quality-quality-adjusted-ranking");
    const synthesis = deriveCompetitiveSynthesis({ row, arms: honestInputsOfRow(row) });
    const verdict = deriveMultipleComparisonHonesty({
      row,
      comparisons: synthesis.comparisons,
    });
    expect(verdict.conformant).toBe(true);
    expect(verdict.evidence.join(" ")).toContain(
      "family-wise error control declared and carried on every verdict",
    );
  });

  test("the row-level catch: the probe FAILs multiple-comparison-honesty over the leaky stack", async () => {
    const { result } = await driveRowOverLeakyStack({
      row: rowById("probe-confidence-inflation"),
    });
    expect(result.terminal).toBe("FAILED");
    expect(criterionOf(result, "multiple-comparison-honesty")?.status).toBe("FAIL");
    expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// 6. sample starvation (minimum-sample enforcement)
// ---------------------------------------------------------------------------

describe("discrimination: sample starvation", () => {
  test("the derivation-level catch: the starved verdict claim REFUSED", () => {
    const row = rowById("probe-sample-starvation");
    const synthesis = deriveCompetitiveSynthesis({ row, arms: honestInputsOfRow(row) });
    const verdict = deriveMinimumSampleEnforcement({
      row,
      comparisons: synthesis.comparisons,
    });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("BELOW-MINIMUM VERDICT CLAIM");
    expect(evidence).toContain("< the pre-registered minimum 5");
    expect(evidence).toContain("never a starved-sample verdict");
  });

  test("the honest control: the starved class reported UNDER-POWERED (never dropped)", () => {
    const row = rowById("budget-stop-prefix-quality-adjusted-underpowered");
    const synthesis = deriveCompetitiveSynthesis({ row, arms: honestInputsOfRow(row) });
    const verdict = deriveMinimumSampleEnforcement({
      row,
      comparisons: synthesis.comparisons,
    });
    expect(verdict.conformant).toBe(true);
    expect(synthesis.verdict).toBe("under-powered");
    expect(verdict.evidence.join(" ")).toContain("UNDER-POWERED — never silently dropped");
  });

  test("the row-level catch: the probe FAILs minimum-sample-enforcement over the leaky stack", async () => {
    const { result } = await driveRowOverLeakyStack({
      row: rowById("probe-sample-starvation"),
    });
    expect(result.terminal).toBe("FAILED");
    expect(criterionOf(result, "minimum-sample-enforcement")?.status).toBe("FAIL");
    expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// 7. the paired-sign-test application + the Bonferroni discipline
// ---------------------------------------------------------------------------

describe("discrimination: the statistical discipline", () => {
  test("the Bonferroni per-comparison level is the family-wise level over the family", () => {
    expect(MULTIPLE_COMPARISON_POLICY.perComparisonLevel).toBeCloseTo(0.0166666667, 9);
    // A 5-of-5 majority (p = 0.0625) is NOT significant at the
    // corrected level — the family-wise honesty bites.
    expect(exactTwoSidedSignTestPValue(5, 0)!).toBeGreaterThan(
      MULTIPLE_COMPARISON_POLICY.perComparisonLevel,
    );
    // A 7-of-7 majority (p = 0.015625) IS — the smallest honest count.
    expect(exactTwoSidedSignTestPValue(7, 0)!).toBeLessThanOrEqual(
      MULTIPLE_COMPARISON_POLICY.perComparisonLevel,
    );
  });

  test("the headline pairwise p-values are the recorded evidence's own", () => {
    const row = rowById("confirmation-fixed-quality-quality-adjusted-ranking");
    const synthesis = deriveCompetitiveSynthesis({ row, arms: honestInputsOfRow(row) });
    const byArm = new Map(synthesis.comparisons.map((c) => [c.armKind, c]));
    expect(byArm.get("direct")?.pValueTwoSided).toBeCloseTo(1, 12);
    expect(byArm.get("optimized")?.pValueTwoSided).toBeCloseTo(0.6875, 12);
    expect(byArm.get("competing")?.pValueTwoSided).toBeCloseTo(1, 12);
    for (const comparison of synthesis.comparisons) {
      expect(comparison.verdict).toBe("statistical-tie");
      expect(comparison.totalBlocks).toBe(8);
    }
  });

  test("the digest discipline: deterministic + discriminating (payload-free)", () => {
    const honest = honestCompetitiveInputsOf(HEADLINE_COHORT.armSet);
    const first = honest.map((arm) =>
      recordedCompetitiveDigestOf({
        armKind: arm.reference.armKind,
        corpusRowId: arm.reference.corpusRowId,
        facts: arm.facts,
      }),
    );
    const second = honestCompetitiveInputsOf(HEADLINE_COHORT.armSet).map((arm) =>
      recordedCompetitiveDigestOf({
        armKind: arm.reference.armKind,
        corpusRowId: arm.reference.corpusRowId,
        facts: arm.facts,
      }),
    );
    expect(first).toEqual(second);
    expect(first.every((digest) => /^[0-9a-f]{8}$/.test(digest))).toBe(true);
    expect(new Set(first).size).toBe(first.length);
    // The stop cohort's digests differ from the headline's (discriminating).
    const stop = honestCompetitiveInputsOf(STOP_COHORT.armSet).map((arm) =>
      recordedCompetitiveDigestOf({
        armKind: arm.reference.armKind,
        corpusRowId: arm.reference.corpusRowId,
        facts: arm.facts,
      }),
    );
    for (const digest of stop) {
      expect(first).not.toContain(digest);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. the honest controls over the fixture stack
// ---------------------------------------------------------------------------

describe("discrimination: the honest controls over the fixture stack", () => {
  /** Each adversarial probe row's NAMED criterion (the honest failure). */
  const probeNamedCriterion: Readonly<Record<string, string>> = {
    "probe-subset-cherry-picking": "portfolio-honesty",
    "probe-unit-pooling": "unit-comparability",
    "probe-cost-basis-switching": "cost-basis-integrity",
    "probe-unpaired-statistics": "paired-statistics",
    "probe-confidence-inflation": "multiple-comparison-honesty",
    "probe-sample-starvation": "minimum-sample-enforcement",
  };

  test("every honest control row COMPLETES over the leaky stack", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.adversarial === undefined,
    )) {
      const { result } = await driveRowOverLeakyStack({ row });
      expect(result.terminal, row.rowId).toBe("COMPLETED");
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(result.observedTerminal, row.rowId).toBe("COMPLETED");
    }
  });

  test("every adversarial PROBE row FAILs its NAMED criterion honestly", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.adversarial !== undefined,
    )) {
      const { result } = await driveRowOverLeakyStack({ row });
      expect(result.terminal, row.rowId).toBe("FAILED");
      const named = probeNamedCriterion[row.rowId];
      expect(named, row.rowId).toBeDefined();
      expect(criterionOf(result, named)?.status, `${row.rowId} ${named}`).toBe("FAIL");
      expect(result.observedTerminal, row.rowId).toBe("FAILED");
      expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
      expect(criterionOf(result, "row-outcome-contract")?.status).toBe("PASS");
    }
  });

  test("the input-integrity oracle over the leaky stack: re-measurements refused", async () => {
    const row = rowById("confirmation-fixed-quality-quality-adjusted-ranking");
    const denatured = applyCompetitiveAdversarialVariant(honestInputsOfRow(row), {
      remeasurement: true,
    });
    const verdict = deriveCompetitiveInputIntegrity({ arms: denatured });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("RE-MEASUREMENT MASQUERADE");
    const { result } = await driveRowOverLeakyStack({ row, arms: denatured });
    expect(result.terminal).toBe("FAILED");
    expect(criterionOf(result, "competitive-input-integrity")?.status).toBe("FAIL");
  });
});
