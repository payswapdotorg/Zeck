/**
 * VAL-047 acceptance criteria 4, 5 and 6 (the driver's oracles + the
 * discrimination floor): the longitudinal cost-curve families'
 * mechanical verification over the RECORDED longitudinal ledgers.
 *
 *   * the oracle matrices: window honesty (the declared window IS the
 *     recorded span — a cherry-picked window FAILs with the omitted
 *     generations named), price-regime marking (every point pinned at
 *     a manifest-verified revision; the marked rev-001 -> rev-002
 *     change verified; a normalized regime FAILs named; a fabricated
 *     marking FAILs), no extrapolation (a point beyond the recorded
 *     evidence FAILs named), the improvement-rate reconciliation (the
 *     identity holds EXACTLY over every honest ledger — numerically
 *     pinned; residual hiding FAILs with both sides named), cohort
 *     honesty (the regressing cohort reported as regressing; hiding it
 *     FAILs named), the estimate/measure separation, the
 *     confidence-and-minimum enforcement (Wilson carried, minimums
 *     held, no post-hoc exclusions) and the below-minimum refusal
 *     honesty;
 *   * the input-integrity matrix: the honest digest-referenced bundles
 *     verify against the RECORDED ledgers + the imported VAL-045
 *     attribution results; a re-measurement masquerade FAILs field by
 *     field; a disagreeing digest FAILs; an unresolvable reference
 *     FAILs;
 *   * the digest discipline (deterministic + discriminating);
 *   * the driver over EVERY offline row (the 4 honest verdict rows
 *     COMPLETE reproducing the pinned curve outcomes; the 8
 *     adversarial probes FAIL their named criteria with the read-back
 *     agreeing).
 */

import { describe, expect, test } from "vitest";
import {
  CURVE_CORPUS,
  curveLedgerById,
  fabricatedExtrapolatedPointOf,
  honestCurveInputsOf,
  taskBodyFor,
} from "../../../benchmarks/validation/apps/economic-longitudinal-curve/corpus";
import type {
  CurveCorpusRow,
  CurvePointInput,
  RecordedCurvePoint,
} from "../../../benchmarks/validation/apps/economic-longitudinal-curve/driver";
import {
  deriveBelowMinimumRefusalHonesty,
  deriveCohortHonesty,
  deriveConfidenceAndMinimum,
  deriveCurveFamilySynthesis,
  deriveCurveInputIntegrity,
  deriveCurveRowCriteria,
  deriveCurveVerdictKind,
  deriveEstimateMeasureSeparation,
  deriveImprovementRateReconciliation,
  deriveNoExtrapolation,
  derivePriceRegimeMarking,
  deriveWindowHonesty,
  driveCurveRow,
  liveCurvePlanDigestOf,
  MINIMUM_GENERATIONS_FOR_CURVE,
  MINIMUM_OUTCOMES_PER_POINT,
  PLATEAU_RATE_THRESHOLD,
  recordedCurvePointDigestOf,
  STABILITY_WINDOW_GENERATIONS,
  totalCostOfPoint,
  WILSON_CONFIG,
} from "../../../benchmarks/validation/apps/economic-longitudinal-curve/driver";
import {
  applyCurveAdversarialVariant,
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createRealAccountingRails,
  createTickClock,
  curveInputsForRow,
} from "../../../benchmarks/validation/apps/economic-longitudinal-curve/fixtures";
import type { LabVerificationCriterion } from "../../../benchmarks/validation/platform/derive";
import type { RunMetadata } from "../../../benchmarks/validation/run-identity";

const REVISION = "7c31a09be1d4c05e3f6a2b8d9e0c1a2b3c4d5e6f";

const metadataOf = (observedAt: string): RunMetadata => ({
  program: "zeck-validation",
  workOrder: "VAL-047",
  baseRevision: REVISION,
  applicationRevision: REVISION,
  corpusRevision: "val-047-longitudinal-curve-v1",
  integrationSurface: "curve:recorded-longitudinal-history",
  environment: {
    runtime: "node test",
    toolchain: "vitest",
    database: "none",
    configuration: { suite: "val-047-unit" },
  },
  observedAt,
});

const rowById = (rowId: string): CurveCorpusRow => {
  const row = CURVE_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

/** Drive one row over the honest offline stack (the unit oracle floor). */
async function driveRowOverHonestStack(row: CurveCorpusRow) {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const seam = createFakeSubmissionSeam({ ledger });
  const lifecycle = createFakeLifecycle({ ledger });
  const baseline = ledger.facts();
  const honest = honestCurveInputsOf(row);
  const submission = await seam({ key: `val-047-unit-${row.rowId}`, body: taskBodyFor({ row }) });
  const result = await driveCurveRow({
    row,
    lifecycle,
    points: curveInputsForRow(row).points,
    attribution: curveInputsForRow(row).attribution,
    recordedLedger: honest.recordedLedger,
    recordedAttribution: honest.recordedAttribution,
    rails: createRealAccountingRails(),
    metadata: metadataOf(clock.now().toISOString()),
    environmentIdentity: `val-047-unit-${row.rowId}`,
    baseline,
    worldFacts: ledger.facts,
    landedProvider: async () => [submission.executionId],
    now: clock.now,
  });
  return { result, lifecycle, ledger };
}

const criterionOf = (
  result: { readonly criteria: readonly LabVerificationCriterion[] },
  id: string,
): LabVerificationCriterion | undefined =>
  result.criteria.find((criterion) => criterion.criterionId === id);

const invoicePoints = (): readonly CurvePointInput[] =>
  curveInputsForRow(rowById("invoice-extraction-cost-per-outcome-trajectory")).points;

const ragPoints = (): readonly CurvePointInput[] =>
  curveInputsForRow(rowById("rag-retrieval-improvement-rate-decomposition")).points;

const codeSearchPoints = (): readonly CurvePointInput[] =>
  curveInputsForRow(rowById("code-search-plateau-maturity-verdict")).points;

// ---------------------------------------------------------------------------
// The vocabulary pins
// ---------------------------------------------------------------------------

describe("VAL-047 curve vocabulary (the pinned thresholds)", () => {
  test("the Wilson configuration + the statistical minimums + the plateau thresholds are pinned", () => {
    expect(WILSON_CONFIG.confidenceLevel).toBe(0.95);
    expect(MINIMUM_GENERATIONS_FOR_CURVE).toBe(3);
    expect(MINIMUM_OUTCOMES_PER_POINT).toBe(5);
    expect(PLATEAU_RATE_THRESHOLD).toBe(0.02);
    expect(STABILITY_WINDOW_GENERATIONS).toBe(2);
  });

  test("the corpus holds 12 offline rows (4 honest + 8 probes) + 1 env-gated live row", () => {
    expect(CURVE_CORPUS).toHaveLength(13);
    const offline = CURVE_CORPUS.filter((row) => !row.needsDispatch);
    expect(offline).toHaveLength(12);
    expect(offline.filter((row) => row.adversarial === undefined)).toHaveLength(4);
    expect(offline.filter((row) => row.adversarial !== undefined)).toHaveLength(8);
    expect(CURVE_CORPUS.filter((row) => row.needsDispatch)).toHaveLength(1);
  });

  test("every honest ledger reconciles EXACTLY with the VAL-045 attribution (the identity)", () => {
    for (const rowId of [
      "invoice-extraction-cost-per-outcome-trajectory",
      "code-search-plateau-maturity-verdict",
      "tool-routing-never-materialized",
      "rag-retrieval-improvement-rate-decomposition",
    ]) {
      const row = rowById(rowId);
      const inputs = curveInputsForRow(row);
      const reconciliation = deriveImprovementRateReconciliation({
        points: inputs.points,
        attribution: inputs.attribution,
      });
      expect(reconciliation.conformant, rowId).toBe(true);
      expect(reconciliation.decomposition.length, rowId).toBe(inputs.points.length - 1);
    }
  });
});

// ---------------------------------------------------------------------------
// The window-honesty oracle
// ---------------------------------------------------------------------------

describe("VAL-047 window honesty (the cherry-picking catch)", () => {
  test("every honest row's declared window IS its ledger's recorded span", () => {
    for (const row of CURVE_CORPUS.filter((candidate) => candidate.adversarial === undefined)) {
      if (row.needsDispatch) {
        continue;
      }
      const ledger = curveLedgerById(row.workloadClass);
      const window = deriveWindowHonesty({ row, recordedLedger: ledger?.points ?? [] });
      expect(window.conformant, row.rowId).toBe(true);
      expect(window.omittedGenerations, row.rowId).toEqual([]);
    }
  });

  test("the cherry-picked PROBE row FAILs with the omitted generations named", () => {
    const row = rowById("probe-cherry-picked-window");
    const ledger = curveLedgerById(row.workloadClass);
    const window = deriveWindowHonesty({ row, recordedLedger: ledger?.points ?? [] });
    expect(window.conformant).toBe(false);
    expect(window.omittedGenerations).toEqual([0, 1, 2]);
    expect(window.evidence.join(" ")).toContain("CHERRY-PICKED WINDOW");
  });
});

// ---------------------------------------------------------------------------
// The price-regime-marking oracle
// ---------------------------------------------------------------------------

describe("VAL-047 price-regime marking (the normalization catch)", () => {
  test("the invoice class's marked rev-001 -> rev-002 change verifies (the actual change point)", () => {
    const row = rowById("invoice-extraction-cost-per-outcome-trajectory");
    const regime = derivePriceRegimeMarking({ row, points: invoicePoints() });
    expect(regime.conformant).toBe(true);
    expect(regime.actualChangePoints).toEqual([
      { atGeneration: 2, dimension: "model", fromRevision: "rev-001", toRevision: "rev-002" },
    ]);
    expect(row.regimeChangePoints).toHaveLength(1);
  });

  test("a silently-normalized regime FAILs named (REGIME-NORMALIZED + UNMARKED)", () => {
    const row = rowById("probe-regime-normalizing");
    const { points } = curveInputsForRow(row);
    const regime = derivePriceRegimeMarking({ row, points });
    expect(regime.conformant).toBe(false);
    const evidence = regime.evidence.join(" ");
    expect(evidence).toContain("REGIME-NORMALIZED");
    expect(evidence).toContain("UNMARKED REGIME CHANGE");
    expect(evidence).toContain("rev-001->rev-002");
  });

  test("a FABRICATED marking (a declared change with no actual change) FAILs named", () => {
    const row = rowById("code-search-plateau-maturity-verdict");
    const fabricatedRow = {
      ...row,
      regimeChangePoints: [
        {
          atGeneration: 2,
          dimension: "model" as const,
          fromRevision: "rev-001",
          toRevision: "rev-002",
        },
      ],
    };
    const regime = derivePriceRegimeMarking({ row: fabricatedRow, points: codeSearchPoints() });
    expect(regime.conformant).toBe(false);
    expect(regime.evidence.join(" ")).toContain("FABRICATED MARKING");
  });

  test("an unpinned model revision FAILs named", () => {
    const row = rowById("invoice-extraction-cost-per-outcome-trajectory");
    const denatured = invoicePoints().map((point, index) =>
      index === 0
        ? {
            ...point,
            modelPriceRevision: "rev-999",
            facts: { ...point.facts, modelPriceRevision: "rev-999" },
          }
        : point,
    );
    const regime = derivePriceRegimeMarking({ row, points: denatured });
    expect(regime.conformant).toBe(false);
    expect(regime.evidence.join(" ")).toContain("UNPINNED MODEL PRICING");
  });
});

// ---------------------------------------------------------------------------
// The no-extrapolation oracle
// ---------------------------------------------------------------------------

describe("VAL-047 no extrapolation (the beyond-evidence catch)", () => {
  test("every honest row's points sit within the recorded evidence", () => {
    for (const row of CURVE_CORPUS.filter((candidate) => !candidate.needsDispatch)) {
      const honest = honestCurveInputsOf(row);
      const extrapolation = deriveNoExtrapolation({
        row,
        recordedLedger: honest.recordedLedger,
        points: curveInputsForRow(row).points,
      });
      expect(extrapolation.conformant, row.rowId).toBe(row.adversarial !== "extrapolating");
    }
  });

  test("the extrapolating PROBE row FAILs with the point named (generation 4)", () => {
    const row = rowById("probe-extrapolating");
    const honest = honestCurveInputsOf(row);
    const extrapolation = deriveNoExtrapolation({
      row,
      recordedLedger: honest.recordedLedger,
      points: curveInputsForRow(row).points,
    });
    expect(extrapolation.conformant).toBe(false);
    const evidence = extrapolation.evidence.join(" ");
    expect(evidence).toContain("EXTRAPOLATED POINT");
    expect(evidence).toContain("generation 4");
    expect(evidence).toContain("ends at generation 3");
  });
});

// ---------------------------------------------------------------------------
// The improvement-rate reconciliation oracle
// ---------------------------------------------------------------------------

describe("VAL-047 improvement-rate reconciliation (the exact identity)", () => {
  test("the rag class's deltas decompose EXACTLY (190 = 150 + 10 + 30; 180 = 140 + 10 + 30; 155 = 110 + 10 + 35)", () => {
    const row = rowById("rag-retrieval-improvement-rate-decomposition");
    const inputs = curveInputsForRow(row);
    const reconciliation = deriveImprovementRateReconciliation(inputs);
    expect(reconciliation.decomposition).toEqual([
      {
        generation: 1,
        measuredDeltaMicroUsd: 190,
        attributedMicroUsd: 150,
        substrateSavingsMicroUsd: 10,
        residualMicroUsd: 30,
        reconciles: true,
      },
      {
        generation: 2,
        measuredDeltaMicroUsd: 180,
        attributedMicroUsd: 140,
        substrateSavingsMicroUsd: 10,
        residualMicroUsd: 30,
        reconciles: true,
      },
      {
        generation: 3,
        measuredDeltaMicroUsd: 155,
        attributedMicroUsd: 110,
        substrateSavingsMicroUsd: 10,
        residualMicroUsd: 35,
        reconciles: true,
      },
    ]);
  });

  test("the invoice class's deltas decompose EXACTLY against the VAL-045 reuse-dominant attribution", () => {
    const row = rowById("invoice-extraction-cost-per-outcome-trajectory");
    const reconciliation = deriveImprovementRateReconciliation(curveInputsForRow(row));
    expect(reconciliation.decomposition.map((entry) => entry.measuredDeltaMicroUsd)).toEqual([
      85, 110, 145,
    ]);
    expect(reconciliation.decomposition.map((entry) => entry.attributedMicroUsd)).toEqual([
      70, 95, 130,
    ]);
    expect(reconciliation.decomposition.map((entry) => entry.residualMicroUsd)).toEqual([
      10, 10, 10,
    ]);
  });

  test("the code-search plateau generations reconcile with the honest EMPTY attribution (0 = 0 + 0 + 0)", () => {
    const row = rowById("code-search-plateau-maturity-verdict");
    const reconciliation = deriveImprovementRateReconciliation(curveInputsForRow(row));
    expect(reconciliation.decomposition.map((entry) => entry.measuredDeltaMicroUsd)).toEqual([
      100, 120, 155, 0, 0,
    ]);
    expect(reconciliation.conformant).toBe(true);
  });

  test("the residual-hiding claim FAILs named with both sides (claimed 0 vs the recorded residual)", () => {
    const row = rowById("probe-residual-hiding");
    const inputs = curveInputsForRow(row);
    const reconciliation = deriveImprovementRateReconciliation(inputs);
    expect(reconciliation.conformant).toBe(false);
    const evidence = reconciliation.evidence.join(" ");
    expect(evidence).toContain("RESIDUAL-HIDING");
    expect(evidence).toContain("!= the recorded 30");
  });

  test("an unexplained residual FAILs with BOTH sides named (a denatured cost basis)", () => {
    const row = rowById("rag-retrieval-improvement-rate-decomposition");
    const inputs = curveInputsForRow(row);
    const denatured = inputs.points.map((point, index) =>
      index === 2
        ? {
            ...point,
            facts: {
              ...point.facts,
              measuredModelCostMicroUsd: point.facts.measuredModelCostMicroUsd - 10,
            },
          }
        : point,
    );
    const reconciliation = deriveImprovementRateReconciliation({
      points: denatured,
      attribution: inputs.attribution,
    });
    expect(reconciliation.conformant).toBe(false);
    const evidence = reconciliation.evidence.join(" ");
    expect(evidence).toContain("UNEXPLAINED RESIDUAL");
    expect(evidence).toContain("the measured delta 190 != the decomposition 180");
  });
});

// ---------------------------------------------------------------------------
// The cohort-honesty oracle
// ---------------------------------------------------------------------------

describe("VAL-047 cohort honesty (the regressing-cohort catch)", () => {
  test("the rag class's deterministicization cohort derives REGRESSING (120 -> 40) and is reported honestly", () => {
    const row = rowById("rag-retrieval-improvement-rate-decomposition");
    const inputs = curveInputsForRow(row);
    const cohort = deriveCohortHonesty({ row, attribution: inputs.attribution });
    expect(cohort.conformant).toBe(true);
    const derived = new Map(cohort.derivedCohorts.map((entry) => [entry.mechanism, entry.verdict]));
    expect(derived.get("deterministicization")).toBe("regressing");
    expect(derived.get("reuse")).toBe("improving");
    expect(derived.get("cache")).toBe("newly-appearing");
    expect(
      row.declaredCohorts.find((entry) => entry.mechanism === "deterministicization")?.reported,
    ).toBe("regressing");
  });

  test("the cohort-hiding PROBE row FAILs named (the regressing cohort reported as improving)", () => {
    const row = rowById("probe-cohort-hiding");
    const inputs = curveInputsForRow(row);
    const cohort = deriveCohortHonesty({ row, attribution: inputs.attribution });
    expect(cohort.conformant).toBe(false);
    const evidence = cohort.evidence.join(" ");
    expect(evidence).toContain("COHORT-HIDING");
    expect(evidence).toContain("deterministicization");
    expect(evidence).toContain("[120, 40, 0]");
  });

  test("an omitted cohort with recorded savings FAILs named", () => {
    const row = rowById("rag-retrieval-improvement-rate-decomposition");
    const inputs = curveInputsForRow(row);
    const omittedRow = {
      ...row,
      declaredCohorts: row.declaredCohorts.filter((entry) => entry.mechanism !== "reuse"),
    };
    const cohort = deriveCohortHonesty({ row: omittedRow, attribution: inputs.attribution });
    expect(cohort.conformant).toBe(false);
    expect(cohort.evidence.join(" ")).toContain("COHORT-OMITTED: reuse");
  });
});

// ---------------------------------------------------------------------------
// The estimate/measure separation + the confidence-and-minimum oracles
// ---------------------------------------------------------------------------

describe("VAL-047 estimate/measure separation + confidence and minimum", () => {
  test("every honest point carries its measured basis (the planner quotes ride separately)", () => {
    const estimate = deriveEstimateMeasureSeparation({ points: invoicePoints() });
    expect(estimate.conformant).toBe(true);
    const g0 = invoicePoints()[0];
    expect(g0?.facts.estimatedQuoteMicroUsd).toBeGreaterThan(0);
    expect(g0?.facts.measuredModelCostMicroUsd).toBeGreaterThan(0);
  });

  test("a claimed estimate basis FAILs named", () => {
    const { points, attribution } = applyCurveAdversarialVariant(
      invoicePoints(),
      curveInputsForRow(rowById("invoice-extraction-cost-per-outcome-trajectory")).attribution,
      { estimateBasis: true },
    );
    const estimate = deriveEstimateMeasureSeparation({ points });
    expect(estimate.conformant).toBe(false);
    expect(estimate.evidence.join(" ")).toContain("ESTIMATE-BASIS CLAIM");
  });

  test("the Wilson 95% brackets the pooled outcome rate on every honest row", () => {
    for (const rowId of [
      "invoice-extraction-cost-per-outcome-trajectory",
      "code-search-plateau-maturity-verdict",
      "tool-routing-never-materialized",
      "rag-retrieval-improvement-rate-decomposition",
    ]) {
      const row = rowById(rowId);
      const confidence = deriveConfidenceAndMinimum({ row, points: curveInputsForRow(row).points });
      expect(confidence.conformant, rowId).toBe(true);
      expect(confidence.belowMinimum, rowId).toBe(false);
      expect(confidence.wilson, rowId).not.toBeNull();
    }
  });

  test("the post-hoc-exclusion PROBE row FAILs naming the dropped generation (g4)", () => {
    const row = rowById("probe-post-hoc-exclusion");
    const confidence = deriveConfidenceAndMinimum({ row, points: curveInputsForRow(row).points });
    expect(confidence.conformant).toBe(false);
    expect(confidence.evidence.join(" ")).toContain("post-hoc-excluded:g4");
  });

  test("the sample-size PROBE row is below the pre-registered minimum and its verdict claim FAILs named", () => {
    const row = rowById("probe-sample-size-violation");
    const confidence = deriveConfidenceAndMinimum({ row, points: curveInputsForRow(row).points });
    expect(confidence.belowMinimum).toBe(true);
    expect(confidence.evidence.join(" ")).toContain("BELOW-MINIMUM: 2 points < 3");
    const refusal = deriveBelowMinimumRefusalHonesty({
      row,
      points: curveInputsForRow(row).points,
    });
    expect(refusal.conformant).toBe(false);
    expect(refusal.evidence.join(" ")).toContain("BELOW-MINIMUM VERDICT CLAIM");
  });
});

// ---------------------------------------------------------------------------
// The input-integrity oracle (the re-measurement catch)
// ---------------------------------------------------------------------------

describe("VAL-047 curve input integrity (the re-measurement masquerade catch)", () => {
  test("the honest digest-referenced bundles verify against the recorded ledgers + the VAL-045 attribution", () => {
    for (const row of CURVE_CORPUS.filter(
      (candidate) => candidate.adversarial === undefined && !candidate.needsDispatch,
    )) {
      const honest = honestCurveInputsOf(row);
      const integrity = deriveCurveInputIntegrity({
        recordedLedger: honest.recordedLedger,
        points: honest.points,
        recordedAttribution: honest.recordedAttribution,
        attribution: honest.attribution,
      });
      expect(integrity.conformant, row.rowId).toBe(true);
      expect(integrity.verdicts, row.rowId).toHaveLength(honest.points.length);
    }
  });

  test("the re-measurement PROBE row FAILs field by field (the re-measured model cost named)", () => {
    const row = rowById("probe-remeasurement-masquerade");
    const honest = honestCurveInputsOf(row);
    const integrity = deriveCurveInputIntegrity({
      recordedLedger: honest.recordedLedger,
      points: curveInputsForRow(row).points,
      recordedAttribution: honest.recordedAttribution,
      attribution: curveInputsForRow(row).attribution,
    });
    expect(integrity.conformant).toBe(false);
    const evidence = integrity.evidence.join(" ");
    expect(evidence).toContain("RE-MEASUREMENT MASQUERADE");
    expect(evidence).toContain("measuredModelCost 316 != recorded 315");
  });

  test("a disagreeing digest FAILs named; an unresolvable reference FAILs named", () => {
    const row = rowById("invoice-extraction-cost-per-outcome-trajectory");
    const honest = honestCurveInputsOf(row);
    const digestDenatured = honest.points.map((point, index) =>
      index === 0 ? { ...point, recordedDigest: "deadbeef" } : point,
    );
    const digestIntegrity = deriveCurveInputIntegrity({
      recordedLedger: honest.recordedLedger,
      points: digestDenatured,
      recordedAttribution: honest.recordedAttribution,
      attribution: honest.attribution,
    });
    expect(digestIntegrity.conformant).toBe(false);
    expect(digestIntegrity.evidence.join(" ")).toContain("DIGEST-DISAGREED");

    const phantom: CurvePointInput = {
      workloadClass: "invoice-extraction",
      generation: 9,
      recordedDigest: "deadbeef",
      modelPriceRevision: "rev-001",
      substratePriceRevision: "sub-rev-001",
      facts: {
        workloadClass: "invoice-extraction",
        generation: 9,
        runs: 12,
        successfulOutcomes: 10,
        measuredModelCostMicroUsd: 500,
        substrateOverheadMicroUsd: 60,
        modelPriceRevision: "rev-001",
        substratePriceRevision: "sub-rev-001",
        costBasis: "measured",
      },
    };
    const phantomIntegrity = deriveCurveInputIntegrity({
      recordedLedger: honest.recordedLedger,
      points: [phantom],
      recordedAttribution: honest.recordedAttribution,
      attribution: honest.attribution,
    });
    expect(phantomIntegrity.conformant).toBe(false);
    expect(phantomIntegrity.evidence.join(" ")).toContain("UNRESOLVABLE DIGEST REFERENCE");
  });
});

// ---------------------------------------------------------------------------
// The digest discipline + the verdict derivation
// ---------------------------------------------------------------------------

describe("VAL-047 digest discipline + verdict derivation", () => {
  test("the recorded point digest is deterministic and discriminating", () => {
    const ledger = curveLedgerById("invoice-extraction");
    const points = ledger?.points ?? [];
    const first = points[0] as RecordedCurvePoint;
    const digest = recordedCurvePointDigestOf(first);
    expect(digest).toMatch(/^[0-9a-f]{8}$/);
    expect(
      recordedCurvePointDigestOf({
        ...first,
        measuredModelCostMicroUsd: first.measuredModelCostMicroUsd + 1,
      }),
    ).not.toBe(digest);
    expect(recordedCurvePointDigestOf(first)).toBe(digest);
  });

  test("the verdict derivation classifies the four honest shapes over the pinned thresholds", () => {
    const invoice = rowById("invoice-extraction-cost-per-outcome-trajectory");
    const codeSearch = rowById("code-search-plateau-maturity-verdict");
    const toolRouting = rowById("tool-routing-never-materialized");
    const rag = rowById("rag-retrieval-improvement-rate-decomposition");
    expect(
      deriveCurveVerdictKind({
        minimumGenerations: invoice.minimumGenerations,
        minimumOutcomesPerPoint: invoice.minimumOutcomesPerPoint,
        points: curveInputsForRow(invoice).points.map((point) => point.facts),
        cohorts: [],
      }),
    ).toBe("trajectory-improving");
    expect(
      deriveCurveVerdictKind({
        minimumGenerations: codeSearch.minimumGenerations,
        minimumOutcomesPerPoint: codeSearch.minimumOutcomesPerPoint,
        points: curveInputsForRow(codeSearch).points.map((point) => point.facts),
        cohorts: [],
      }),
    ).toBe("trajectory-plateaued");
    expect(
      deriveCurveVerdictKind({
        minimumGenerations: toolRouting.minimumGenerations,
        minimumOutcomesPerPoint: toolRouting.minimumOutcomesPerPoint,
        points: curveInputsForRow(toolRouting).points.map((point) => point.facts),
        cohorts: [],
      }),
    ).toBe("never-materialized");
    expect(
      deriveCurveVerdictKind({
        minimumGenerations: rag.minimumGenerations,
        minimumOutcomesPerPoint: rag.minimumOutcomesPerPoint,
        points: curveInputsForRow(rag).points.map((point) => point.facts),
        cohorts: [{ verdict: "regressing" }],
      }),
    ).toBe("mixed-cohort-regressing");
  });

  test("the live plan digest is deterministic", () => {
    expect(liveCurvePlanDigestOf()).toBe(liveCurvePlanDigestOf());
    expect(liveCurvePlanDigestOf()).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// The family synthesis (the pinned curve outcomes)
// ---------------------------------------------------------------------------

describe("VAL-047 family synthesis (the honest curve outcomes)", () => {
  test("the invoice trajectory pins 56 -> 43 -> 30 -> 17 micro-USD per successful outcome", () => {
    const row = rowById("invoice-extraction-cost-per-outcome-trajectory");
    const family = deriveCurveFamilySynthesis({
      row,
      points: curveInputsForRow(row).points,
      attribution: curveInputsForRow(row).attribution,
    });
    expect(family.synthesis?.perPointCostPerOutcomeMicroUsd).toEqual(["56", "43", "30", "17"]);
    expect(family.synthesis?.totalImprovementMicroUsd).toBe("340");
    expect(family.synthesis?.verdict).toBe("trajectory-improving");
    expect(family.synthesis?.regimeChangePoints).toBe(1);
  });

  test("the code-search curve plateaus (the last-window rate is exactly zero)", () => {
    const row = rowById("code-search-plateau-maturity-verdict");
    const family = deriveCurveFamilySynthesis({
      row,
      points: curveInputsForRow(row).points,
      attribution: curveInputsForRow(row).attribution,
    });
    expect(family.synthesis?.verdict).toBe("trajectory-plateaued");
    expect(family.synthesis?.lastWindowImprovementRate).toBe(0);
    expect(family.synthesis?.perPointCostPerOutcomeMicroUsd).toEqual([
      "22",
      "18",
      "13",
      "7",
      "7",
      "7",
    ]);
  });

  test("the rag decomposition's verdict is mixed-cohort-regressing with the honest regressing cohort carried", () => {
    const row = rowById("rag-retrieval-improvement-rate-decomposition");
    const family = deriveCurveFamilySynthesis({
      row,
      points: curveInputsForRow(row).points,
      attribution: curveInputsForRow(row).attribution,
    });
    expect(family.synthesis?.verdict).toBe("mixed-cohort-regressing");
    expect(family.synthesis?.cohorts).toContainEqual({
      mechanism: "deterministicization",
      verdict: "regressing",
    });
  });

  test("the total costs pin exactly (BigInt basis, never floating point)", () => {
    const invoice = invoicePoints();
    expect(totalCostOfPoint(invoice[0]?.facts as RecordedCurvePoint).toString()).toBe("560");
    expect(totalCostOfPoint(invoice[3]?.facts as RecordedCurvePoint).toString()).toBe("220");
    const rag = ragPoints();
    expect(totalCostOfPoint(rag[0]?.facts as RecordedCurvePoint).toString()).toBe("720");
    expect(totalCostOfPoint(rag[3]?.facts as RecordedCurvePoint).toString()).toBe("195");
  });
});

// ---------------------------------------------------------------------------
// The driver over every offline row
// ---------------------------------------------------------------------------

describe("VAL-047 driver over every offline row (the honest outcome contract)", () => {
  test("the 4 honest verdict rows COMPLETE reproducing their pinned curve outcomes", async () => {
    for (const rowId of [
      "invoice-extraction-cost-per-outcome-trajectory",
      "code-search-plateau-maturity-verdict",
      "tool-routing-never-materialized",
      "rag-retrieval-improvement-rate-decomposition",
    ]) {
      const { result } = await driveRowOverHonestStack(rowById(rowId));
      expect(result.terminal, rowId).toBe("COMPLETED");
      expect(result.failure, rowId).toBeNull();
      expect(result.observedTerminal, rowId).toBe("COMPLETED");
      const failing = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failing, rowId).toEqual([]);
      expect(result.synthesis, rowId).not.toBeNull();
      expect(criterionOf(result, "observed-terminal-readback")?.status, rowId).toBe("PASS");
    }
  });

  test.each([
    ["probe-cherry-picked-window", "window-honesty", "CHERRY-PICKED WINDOW"],
    ["probe-regime-normalizing", "price-regime-marking", "REGIME-NORMALIZED"],
    ["probe-extrapolating", "no-extrapolation", "EXTRAPOLATED POINT"],
    ["probe-residual-hiding", "improvement-rate-reconciliation", "RESIDUAL-HIDING"],
    ["probe-cohort-hiding", "cohort-honesty", "COHORT-HIDING"],
    ["probe-post-hoc-exclusion", "confidence-and-minimum", "post-hoc-excluded:g4"],
    ["probe-sample-size-violation", "below-minimum-refusal-honesty", "BELOW-MINIMUM VERDICT CLAIM"],
    ["probe-remeasurement-masquerade", "curve-input-integrity", "RE-MEASUREMENT MASQUERADE"],
  ])("%s FAILs its named criterion (%s)", async (rowId, criterionId, marker) => {
    const { result } = await driveRowOverHonestStack(rowById(rowId));
    expect(result.terminal).toBe("FAILED");
    expect(result.observedTerminal).toBe("FAILED");
    const criterion = criterionOf(result, criterionId);
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain(marker);
    expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
  });

  test("the row criteria assembly carries the full oracle set on every row", async () => {
    const row = rowById("invoice-extraction-cost-per-outcome-trajectory");
    const honest = honestCurveInputsOf(row);
    const clock = createTickClock();
    const ledger = createFakeLedger(clock);
    const criteria = deriveCurveRowCriteria({
      row,
      points: honest.points,
      attribution: honest.attribution,
      recordedLedger: honest.recordedLedger,
      recordedAttribution: honest.recordedAttribution,
      observedTerminal: null,
      baseline: ledger.facts(),
      finalFacts: ledger.facts(),
      failure: null,
      totalLatencyMs: 0,
    });
    const ids = criteria.map((criterion) => criterion.criterionId);
    for (const expected of [
      "curve-input-integrity",
      "window-honesty",
      "price-regime-marking",
      "no-extrapolation",
      "improvement-rate-reconciliation",
      "cohort-honesty",
      "estimate-measure-separation",
      "confidence-and-minimum",
      "below-minimum-refusal-honesty",
      "cost-per-outcome-trajectory-derivation",
      "synthesis-outcome-oracle",
      "no-phantom-executions",
      "no-ledger-drift",
      "no-orphan-ledger-transitions",
      "row-outcome-contract",
      "economics-measured",
    ]) {
      expect(ids).toContain(expected);
    }
  });

  test("the CURVE DECISIONS land before any input is consulted (the durable planning decision)", async () => {
    const { lifecycle } = await driveRowOverHonestStack(
      rowById("rag-retrieval-improvement-rate-decomposition"),
    );
    const decisions = lifecycle.journal.decisions;
    expect(decisions.length).toBeGreaterThan(0);
    const decision = decisions[0]?.armDecision as Record<string, unknown>;
    expect(decision?.kind).toBe("longitudinal-cost-curve-plan");
    expect(decision?.deriveOnlyOverRecorded).toContain("never a re-measurement");
  });
});

// ---------------------------------------------------------------------------
// The adversarial worlds (the discrimination floor over the PURE derivations)
// ---------------------------------------------------------------------------

describe("VAL-047 adversarial worlds (every knob FAILs its named criterion)", () => {
  test("each input-level knob FAILs its named criterion over the honest invoice inputs", () => {
    const row = rowById("invoice-extraction-cost-per-outcome-trajectory");
    const honest = honestCurveInputsOf(row);
    const regime = applyCurveAdversarialVariant(honest.points, honest.attribution, {
      regimeNormalizing: true,
    });
    expect(derivePriceRegimeMarking({ row, points: regime.points }).conformant).toBe(false);

    const extrapolated = applyCurveAdversarialVariant(honest.points, honest.attribution, {
      extrapolating: true,
    });
    expect(
      deriveNoExtrapolation({
        row,
        recordedLedger: honest.recordedLedger,
        points: extrapolated.points,
      }).conformant,
    ).toBe(false);

    const hidden = applyCurveAdversarialVariant(honest.points, honest.attribution, {
      residualHiding: true,
    });
    expect(deriveImprovementRateReconciliation(hidden).conformant).toBe(false);

    const remeasured = applyCurveAdversarialVariant(honest.points, honest.attribution, {
      remeasurement: true,
    });
    expect(
      deriveCurveInputIntegrity({
        recordedLedger: honest.recordedLedger,
        points: remeasured.points,
        recordedAttribution: honest.recordedAttribution,
        attribution: remeasured.attribution,
      }).conformant,
    ).toBe(false);
  });

  test("the post-hoc exclusion knob FAILs the confidence-and-minimum oracle over the code-search inputs", () => {
    const row = rowById("code-search-plateau-maturity-verdict");
    const honest = honestCurveInputsOf(row);
    const excluded = applyCurveAdversarialVariant(honest.points, honest.attribution, {
      postHocExclusion: true,
    });
    const confidence = deriveConfidenceAndMinimum({ row, points: excluded.points });
    expect(confidence.conformant).toBe(false);
    expect(confidence.evidence.join(" ")).toContain("post-hoc-excluded:g4");
  });

  test("the point references of every corpus row re-derive identically (the digest discipline)", () => {
    for (const row of CURVE_CORPUS.filter(
      (candidate) => !candidate.needsDispatch && candidate.adversarial !== "extrapolating",
    )) {
      for (const reference of row.pointSet) {
        const ledger = curveLedgerById(reference.workloadClass);
        const point = ledger?.points.find(
          (candidate) => candidate.generation === reference.generation,
        );
        expect(point, `${row.rowId}:g${reference.generation}`).toBeDefined();
        if (point !== undefined) {
          expect(reference.recordedDigest, `${row.rowId}:g${reference.generation}`).toBe(
            recordedCurvePointDigestOf(point),
          );
        }
      }
    }
  });

  test("the extrapolating probe's fabricated reference carries the fabricated point's digest", () => {
    const row = rowById("probe-extrapolating");
    const reference = row.pointSet.find((candidate) => candidate.generation === 4);
    expect(reference).toBeDefined();
    const fabricated = fabricatedExtrapolatedPointOf("invoice-extraction", 4);
    expect(fabricated.measuredModelCostMicroUsd).toBe(35);
    expect(reference?.recordedDigest).toBe(recordedCurvePointDigestOf(fabricated));
  });
});

// ---------------------------------------------------------------------------
// The live-lane declaration honesty
// ---------------------------------------------------------------------------

describe("VAL-047 live lane declaration honesty", () => {
  test("the live row's gate requires the operator credential and the row is honestly NOT RUN without it", () => {
    const live = CURVE_CORPUS.filter((row) => row.needsDispatch);
    expect(live).toHaveLength(1);
    const row = live[0];
    expect(row?.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
    expect(row?.liveGate?.requirement).toContain("operator-authorized");
    expect(row?.expected.synthesis).toBeUndefined();
    expect(row?.pointSet.every((reference) => reference.live === true)).toBe(true);
    expect(
      row?.pointSet.every((reference) => reference.recordedDigest === liveCurvePlanDigestOf()),
    ).toBe(true);
  });

  test("the live references verify manifest-only through the integrity oracle (the measured lane)", () => {
    const row = CURVE_CORPUS.find((candidate) => candidate.needsDispatch);
    if (row === undefined) {
      throw new Error("missing live row");
    }
    const livePoints = row.pointSet.map((reference) => ({
      ...reference,
      facts: {
        workloadClass: reference.workloadClass,
        generation: reference.generation,
        runs: 3,
        successfulOutcomes: 3,
        measuredModelCostMicroUsd: 100,
        substrateOverheadMicroUsd: 20,
        modelPriceRevision: reference.modelPriceRevision,
        substratePriceRevision: reference.substratePriceRevision,
        costBasis: "measured" as const,
      },
    }));
    const integrity = deriveCurveInputIntegrity({
      recordedLedger: [],
      points: livePoints,
      recordedAttribution: [],
      attribution: [],
    });
    expect(integrity.conformant).toBe(true);
    expect(integrity.verdicts).toHaveLength(3);
    expect(integrity.verdicts.every((verdict) => verdict.integrity)).toBe(true);
  });
});
