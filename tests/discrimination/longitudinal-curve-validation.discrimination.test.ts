/**
 * VAL-047 acceptance criterion 6 — discrimination tests proving the
 * LONGITUDINAL COST-CURVE families against controlled fakes (every
 * family FAILs mechanically; every family has an honest control that
 * PASSES):
 *
 *   * WINDOW CHERRY-PICKING — a declared window that does not match the
 *     recorded data (the curated slice hiding the inconvenient prefix
 *     or suffix): the window-honesty oracle FAILs with every omitted
 *     recorded generation named;
 *   * REGIME NORMALIZATION — a price-regime change silently normalized
 *     away (the pre-change revision claimed for post-change points, the
 *     actual change left undeclared) or a fabricated marking: the
 *     price-regime-marking oracle FAILs named;
 *   * EXTRAPOLATION — a curve point (or window) beyond the recorded
 *     evidence: the no-extrapolation oracle FAILs with the point named;
 *   * RESIDUAL HIDING — an attribution bundle claiming a residual below
 *     the recorded one (or an inflated mechanism share), or a
 *     decomposition that does not reconcile EXACTLY: the
 *     improvement-rate-reconciliation oracle FAILs with BOTH sides named;
 *   * COHORT HIDING — a regressing mechanism cohort reported otherwise
 *     (or omitted): the cohort-honesty oracle FAILs with the cohort and
 *     its recorded attributed series named;
 *   * POST-HOC EXCLUSION — a pre-registered curve point dropped from the
 *     executed set (or an undeclared point added): the
 *     confidence-and-minimum oracle FAILs named;
 *   * SAMPLE-SIZE VIOLATION — a curve below the pre-registered minimums
 *     that CLAIMS a trajectory verdict: the below-minimum-refusal-honesty
 *     oracle FAILs named (the honest outcome is the refusal);
 *   * RE-MEASUREMENT MASQUERADE — an input bundle whose facts are not
 *     the RECORDED ledger's own derivation (a re-measured number, a
 *     disagreeing digest, an unresolvable reference): the
 *     input-integrity oracle FAILs field by field;
 *   * ESTIMATE CONFLATION — a point claimed on an estimate basis (the
 *     planner quote folded into the trajectory): the
 *     estimate/measure-separation oracle FAILs named.
 *
 * Plus the Wilson-confidence application (a confidence-less comparison
 * FAILs; every honest comparison brackets the pooled outcome rate), the
 * digest discipline (deterministic + discriminating, payload-free) and
 * the honest controls over the whole fixture stack (every honest
 * control row COMPLETES over the leaky stack; every adversarial probe
 * row FAILs its NAMED criterion honestly).
 *
 * The leaky stack is the purpose-built fake world: the fake ledger +
 * lifecycle + submission seam (imported from the VAL-040 fixtures,
 * never copied) under the REAL accounting rails — the same platform
 * path the crown drives over REAL PostgreSQL. Digest-only assertions
 * throughout (payload bytes never journaled); no credentials.
 */

import { describe, expect, test } from "vitest";
import { wilsonInterval } from "../../benchmarks/validation/accounting/aggregate";
import { economicDigestOf } from "../../benchmarks/validation/apps/economic-baseline/driver";
import {
  CURVE_CORPUS,
  curveRowById,
  fabricatedExtrapolatedPointOf,
  honestCurveInputsOf,
  LONGITUDINAL_LEDGERS,
  OFFLINE_CONTROL_ROWS,
  PROBE_ROWS,
  taskBodyFor,
} from "../../benchmarks/validation/apps/economic-longitudinal-curve/corpus";
import type {
  CohortVerdict,
  CurveCorpusRow,
  CurvePointInput,
  CurvePointReference,
  RecordedCurvePoint,
} from "../../benchmarks/validation/apps/economic-longitudinal-curve/driver";
import {
  curveAttributionDigestOf,
  deriveBelowMinimumRefusalHonesty,
  deriveCohortHonesty,
  deriveCohortVerdicts,
  deriveConfidenceAndMinimum,
  deriveCurveInputIntegrity,
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
  pooledCurveFactsOf,
  recordedCurvePointDigestOf,
  WILSON_CONFIG,
} from "../../benchmarks/validation/apps/economic-longitudinal-curve/driver";
import {
  applyCurveAdversarialVariant,
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createRealAccountingRails,
  createTickClock,
  curveInputsForRow,
} from "../../benchmarks/validation/apps/economic-longitudinal-curve/fixtures";
import type { LabVerificationCriterion } from "../../benchmarks/validation/platform/derive";
import type { RunMetadata } from "../../benchmarks/validation/run-identity";

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
    configuration: { suite: "val-047-discrimination" },
  },
  observedAt,
});

const rowById = (rowId: string): CurveCorpusRow => {
  const row = curveRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const criterionOf = (
  result: { readonly criteria: readonly LabVerificationCriterion[] },
  id: string,
): LabVerificationCriterion | undefined =>
  result.criteria.find((criterion) => criterion.criterionId === id);

/** The headline trajectory row's honest recorded inputs (the comparable basis). */
const headline = (): ReturnType<typeof honestCurveInputsOf> =>
  honestCurveInputsOf(rowById("invoice-extraction-cost-per-outcome-trajectory"));

/** The rag decomposition row's honest recorded inputs (the mixed-cohort basis). */
const ragBasis = (): ReturnType<typeof honestCurveInputsOf> =>
  honestCurveInputsOf(rowById("rag-retrieval-improvement-rate-decomposition"));

/** Drive one row over a purpose-built leaky stack (the discrimination harness). */
async function driveRowOverLeakyStack(options: {
  readonly row: CurveCorpusRow;
  /** The denatured input bundles (the adversarial knobs' output). */
  readonly points?: readonly CurvePointInput[];
}): Promise<ReturnType<typeof driveCurveRow>> {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const seam = createFakeSubmissionSeam({ ledger });
  const lifecycle = createFakeLifecycle({ ledger });
  const honest = honestCurveInputsOf(options.row);
  const baseline = ledger.facts();
  const submission = await seam({
    key: `val-047-disc-${options.row.rowId}`,
    body: taskBodyFor({ row: options.row }),
  });
  const inputs = curveInputsForRow(options.row);
  return driveCurveRow({
    row: options.row,
    lifecycle,
    points: options.points ?? inputs.points,
    attribution: inputs.attribution,
    recordedLedger: honest.recordedLedger,
    recordedAttribution: honest.recordedAttribution,
    rails: createRealAccountingRails(),
    metadata: metadataOf(clock.now().toISOString()),
    environmentIdentity: `val-047-disc-${options.row.rowId}`,
    baseline,
    worldFacts: ledger.facts,
    landedProvider: async () => [submission.executionId],
    now: clock.now,
  });
}

/** A row shaped like another but with an overridden declared window (PURE). */
function withWindow(
  row: CurveCorpusRow,
  fromGeneration: number,
  toGeneration: number,
): CurveCorpusRow {
  return { ...row, declaredWindow: { fromGeneration, toGeneration } };
}

// ---------------------------------------------------------------------------
// Family 1: the WINDOW CHERRY-PICKING curve
// ---------------------------------------------------------------------------

describe("discrimination: window cherry-picking", () => {
  test("the derivation-level catch: a suffix-window hiding the improving prefix FAILs with the omitted generations named", () => {
    // The code-search class improved g0..g3 then plateaued; a [3, 5]
    // window tells a never-improved story.
    const row = withWindow(rowById("code-search-plateau-maturity-verdict"), 3, 5);
    const basis = honestCurveInputsOf(row);
    const verdict = deriveWindowHonesty({ row, recordedLedger: basis.recordedLedger });
    expect(verdict.conformant).toBe(false);
    expect(verdict.omittedGenerations).toEqual([0, 1, 2]);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("CHERRY-PICKED WINDOW");
    expect(evidence).toContain("omits recorded generations [0, 1, 2]");
    expect(evidence).toContain("declaredWindow:[3, 5]");
    expect(evidence).toContain("recordedSpan:[0, 5]");
  });

  test("the derivation-level catch: a prefix-omitting window FAILs with the omitted generation named", () => {
    const row = withWindow(rowById("invoice-extraction-cost-per-outcome-trajectory"), 1, 3);
    const basis = honestCurveInputsOf(row);
    const verdict = deriveWindowHonesty({ row, recordedLedger: basis.recordedLedger });
    expect(verdict.conformant).toBe(false);
    expect(verdict.omittedGenerations).toEqual([0]);
    expect(verdict.evidence.join(" ")).toContain("omits recorded generations [0]");
  });

  test("the honest control: every honest row's declared window IS its ledger's recorded span", () => {
    for (const row of OFFLINE_CONTROL_ROWS) {
      const basis = honestCurveInputsOf(row);
      const verdict = deriveWindowHonesty({ row, recordedLedger: basis.recordedLedger });
      expect(verdict.conformant, row.rowId).toBe(true);
      expect(verdict.omittedGenerations, row.rowId).toEqual([]);
      expect(verdict.recordedSpan, row.rowId).toEqual({
        from: row.declaredWindow.fromGeneration,
        to: row.declaredWindow.toGeneration,
      });
      expect(verdict.evidence.join(" "), row.rowId).toContain(
        "honest (the declared window IS the recorded data's own span)",
      );
    }
  });

  test("the row-level catch: the cherry-picked-window PROBE row FAILs its named criterion", async () => {
    const row = rowById("probe-cherry-picked-window");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const window = criterionOf(result, "window-honesty");
    expect(window?.status).toBe("FAIL");
    expect(window?.evidence.join(" ")).toContain("CHERRY-PICKED WINDOW");
    expect(window?.evidence.join(" ")).toContain("omits recorded generations [0, 1, 2]");
    expect(result.observedTerminal).toBe("FAILED");
    expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Family 2: the REGIME-NORMALIZING curve
// ---------------------------------------------------------------------------

describe("discrimination: regime normalization", () => {
  test("the derivation-level catch: the pre-change revision claimed for post-change points FAILs named", () => {
    const basis = headline();
    const denatured = applyCurveAdversarialVariant(basis.points, basis.attribution, {
      regimeNormalizing: true,
    });
    const verdict = derivePriceRegimeMarking({
      row: rowById("invoice-extraction-cost-per-outcome-trajectory"),
      points: denatured.points,
    });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    // The normalized claims are named per point, with both revisions.
    expect(evidence).toContain("REGIME-NORMALIZED: invoice-extraction@g2");
    expect(evidence).toContain("claimed rev-001 != the recorded rev-002");
    expect(evidence).toContain("REGIME-NORMALIZED: invoice-extraction@g3");
    expect(evidence).toContain("REFERENCE-DISAGREED");
  });

  test("the derivation-level catch: an actual change left undeclared FAILs named (UNMARKED)", () => {
    const row = rowById("invoice-extraction-cost-per-outcome-trajectory");
    const basis = honestCurveInputsOf(row);
    const undeclaring: CurveCorpusRow = { ...row, regimeChangePoints: [] };
    const verdict = derivePriceRegimeMarking({ row: undeclaring, points: basis.points });
    expect(verdict.conformant).toBe(false);
    expect(verdict.actualChangePoints).toEqual([
      { atGeneration: 2, dimension: "model", fromRevision: "rev-001", toRevision: "rev-002" },
    ]);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("UNMARKED REGIME CHANGE: g2 model rev-001->rev-002");
    expect(evidence).toContain("normalizing it away FAILs");
  });

  test("the derivation-level catch: a FABRICATED marking (a declared change that never happened) FAILs named", () => {
    const row = rowById("tool-routing-never-materialized");
    const basis = honestCurveInputsOf(row);
    const fabricating: CurveCorpusRow = {
      ...row,
      regimeChangePoints: [
        { atGeneration: 2, dimension: "model", fromRevision: "rev-001", toRevision: "rev-002" },
      ],
    };
    const verdict = derivePriceRegimeMarking({ row: fabricating, points: basis.points });
    expect(verdict.conformant).toBe(false);
    expect(verdict.actualChangePoints).toEqual([]);
    expect(verdict.evidence.join(" ")).toContain("FABRICATED MARKING: 2:model:rev-001->rev-002");
  });

  test("the honest control: the marked rev-001 -> rev-002 change verifies with the manifest-pinned revisions", () => {
    const row = rowById("invoice-extraction-cost-per-outcome-trajectory");
    const basis = honestCurveInputsOf(row);
    const verdict = derivePriceRegimeMarking({ row, points: basis.points });
    expect(verdict.conformant).toBe(true);
    expect(verdict.actualChangePoints).toHaveLength(1);
    expect(verdict.evidence.join(" ")).toContain("regime-change:g2:model:rev-001->rev-002");
    expect(verdict.evidence.join(" ")).toContain(
      "every point pinned at a manifest-verified revision and every regime change marked",
    );
  });

  test("the row-level catch: the regime-normalizing PROBE row FAILs its named criterion", async () => {
    const row = rowById("probe-regime-normalizing");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const regime = criterionOf(result, "price-regime-marking");
    expect(regime?.status).toBe("FAIL");
    const evidence = regime?.evidence.join(" ") ?? "";
    expect(evidence).toContain("REGIME-NORMALIZED: invoice-extraction@g2");
    expect(evidence).toContain("UNMARKED REGIME CHANGE: g2 model rev-001->rev-002");
  });
});

// ---------------------------------------------------------------------------
// Family 3: the EXTRAPOLATING curve
// ---------------------------------------------------------------------------

describe("discrimination: extrapolation", () => {
  test("the derivation-level catch: a fabricated beyond-evidence point FAILs and is named", () => {
    const row = rowById("invoice-extraction-cost-per-outcome-trajectory");
    const basis = honestCurveInputsOf(row);
    const fabricated = fabricatedExtrapolatedPointOf("invoice-extraction", 4);
    const reference: CurvePointReference = {
      workloadClass: "invoice-extraction",
      generation: 4,
      recordedDigest: recordedCurvePointDigestOf(fabricated),
      modelPriceRevision: fabricated.modelPriceRevision,
      substratePriceRevision: fabricated.substratePriceRevision,
    };
    const extrapolating: CurvePointInput = { ...reference, facts: fabricated };
    const verdict = deriveNoExtrapolation({
      row,
      recordedLedger: basis.recordedLedger,
      points: [...basis.points, extrapolating],
    });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("EXTRAPOLATED POINT: invoice-extraction@g4");
    expect(evidence).toContain("the recorded evidence ends at generation 3");
    expect(evidence).toContain("a point beyond the recorded evidence is named and FAILs");
  });

  test("the derivation-level catch: a window beyond the evidence FAILs named", () => {
    const row = withWindow(rowById("invoice-extraction-cost-per-outcome-trajectory"), 0, 4);
    const basis = honestCurveInputsOf(row);
    const verdict = deriveNoExtrapolation({
      row,
      recordedLedger: basis.recordedLedger,
      points: basis.points,
    });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain(
      "EXTRAPOLATED WINDOW: the declared window ends at generation 4 while the recorded evidence ends at generation 3",
    );
  });

  test("the honest control: every honest row's points sit within the recorded evidence", () => {
    for (const row of OFFLINE_CONTROL_ROWS) {
      const basis = honestCurveInputsOf(row);
      const verdict = deriveNoExtrapolation({
        row,
        recordedLedger: basis.recordedLedger,
        points: basis.points,
      });
      expect(verdict.conformant, row.rowId).toBe(true);
      expect(verdict.evidence.join(" "), row.rowId).toContain(
        "every point sits within the recorded evidence",
      );
    }
  });

  test("the row-level catch: the extrapolating PROBE row FAILs its named criterion", async () => {
    const row = rowById("probe-extrapolating");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const extrapolation = criterionOf(result, "no-extrapolation");
    expect(extrapolation?.status).toBe("FAIL");
    const evidence = extrapolation?.evidence.join(" ") ?? "";
    expect(evidence).toContain("EXTRAPOLATED POINT: invoice-extraction@g4");
    expect(evidence).toContain("EXTRAPOLATED WINDOW");
  });
});

// ---------------------------------------------------------------------------
// Family 4: the RESIDUAL-HIDING decomposition
// ---------------------------------------------------------------------------

describe("discrimination: residual hiding", () => {
  test("the derivation-level catch: a claimed residual below the recorded one FAILs with both sides named", () => {
    const basis = ragBasis();
    const hidden = applyCurveAdversarialVariant(basis.points, basis.attribution, {
      residualHiding: true,
    });
    const verdict = deriveImprovementRateReconciliation({
      points: hidden.points,
      attribution: hidden.attribution,
    });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    // The rag class's honest residuals are 30 / 30 / 35 micro-USD — the
    // zeroed claims are named against them, generation by generation.
    expect(evidence).toContain("RESIDUAL-HIDING: g1 (claimed residual 0 != the recorded 30");
    expect(evidence).toContain("RESIDUAL-HIDING: g2 (claimed residual 0 != the recorded 30");
    expect(evidence).toContain("RESIDUAL-HIDING: g3 (claimed residual 0 != the recorded 35");
    expect(evidence).toContain("never hidden, never forced into a mechanism");
  });

  test("the derivation-level catch: an inflated mechanism share FAILs named (the residual absorbed)", () => {
    const basis = ragBasis();
    const inflated = basis.attribution.map((bundle) => ({
      ...bundle,
      claimed: { ...bundle.claimed, attributedTotalMicroUsd: 1000 },
    }));
    const verdict = deriveImprovementRateReconciliation({
      points: basis.points,
      attribution: inflated,
    });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("INFLATED ATTRIBUTION: g1");
    expect(evidence).toContain("the mechanism share never absorbs the residual");
  });

  test("the derivation-level catch: an unexplained residual FAILs with BOTH sides named", () => {
    const basis = ragBasis();
    // A denatured cost basis: g1's measured model cost re-measured one
    // micro-USD off — the measured delta no longer decomposes exactly.
    const denatured = basis.points.map((point) =>
      point.facts.generation === 1
        ? {
            ...point,
            facts: {
              ...point.facts,
              measuredModelCostMicroUsd: point.facts.measuredModelCostMicroUsd + 1,
            },
          }
        : point,
    );
    const verdict = deriveImprovementRateReconciliation({
      points: denatured,
      attribution: basis.attribution,
    });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("UNEXPLAINED RESIDUAL: g1");
    // Both sides named: the measured delta 189 against the decomposition 190.
    expect(evidence).toContain("the measured delta 189 != the decomposition 190");
    expect(evidence).toContain("attributed 150 + substrate 10 + residual 30");
    expect(evidence).toContain("both sides named");
  });

  test("the honest control: the exactly-reconciled decomposition PASSES with the deltas pinned", () => {
    const basis = ragBasis();
    const verdict = deriveImprovementRateReconciliation({
      points: basis.points,
      attribution: basis.attribution,
    });
    expect(verdict.conformant).toBe(true);
    expect(verdict.decomposition).toEqual([
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
    expect(verdict.evidence.join(" ")).toContain(
      "reconciles EXACTLY against the VAL-045 attribution on every generation",
    );
  });

  test("the row-level catch: the residual-hiding PROBE row FAILs its named criterion", async () => {
    const row = rowById("probe-residual-hiding");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const reconciliation = criterionOf(result, "improvement-rate-reconciliation");
    expect(reconciliation?.status).toBe("FAIL");
    expect(reconciliation?.evidence.join(" ")).toContain("RESIDUAL-HIDING: g1");
  });
});

// ---------------------------------------------------------------------------
// Family 5: the COHORT-HIDING curve
// ---------------------------------------------------------------------------

describe("discrimination: cohort hiding", () => {
  test("the derivation-level catch: the regressing cohort reported as improving FAILs with its series named", () => {
    const row = rowById("rag-retrieval-improvement-rate-decomposition");
    const basis = honestCurveInputsOf(row);
    const hiding: CurveCorpusRow = {
      ...row,
      declaredCohorts: [
        { mechanism: "reuse", reported: "improving" },
        { mechanism: "cache", reported: "newly-appearing" },
        { mechanism: "competence", reported: "newly-appearing" },
        { mechanism: "deterministicization", reported: "improving" },
      ],
    };
    const verdict = deriveCohortHonesty({ row: hiding, attribution: basis.attribution });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("COHORT-HIDING: deterministicization");
    // The recorded attributed series is named: 120 -> 40 (the honest regression).
    expect(evidence).toContain("[120, 40, 0]");
    expect(evidence).toContain("derives regressing");
    expect(evidence).toContain("reported as improving");
    expect(evidence).toContain("a regressing cohort is reported as regressing, never hidden");
  });

  test("the derivation-level catch: an omitted cohort with recorded savings FAILs named", () => {
    const row = rowById("rag-retrieval-improvement-rate-decomposition");
    const basis = honestCurveInputsOf(row);
    const omitting: CurveCorpusRow = {
      ...row,
      declaredCohorts: [{ mechanism: "reuse", reported: "improving" }],
    };
    const verdict = deriveCohortHonesty({ row: omitting, attribution: basis.attribution });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("COHORT-OMITTED: cache");
    expect(evidence).toContain("COHORT-OMITTED: deterministicization");
  });

  test("the honest control: the honestly-reported regressing cohort PASSES with the derived verdicts pinned", () => {
    const row = rowById("rag-retrieval-improvement-rate-decomposition");
    const basis = honestCurveInputsOf(row);
    const verdict = deriveCohortHonesty({ row, attribution: basis.attribution });
    expect(verdict.conformant).toBe(true);
    expect(verdict.derivedCohorts).toEqual([
      { mechanism: "reuse", verdict: "improving" },
      { mechanism: "cache", verdict: "newly-appearing" },
      { mechanism: "competence", verdict: "newly-appearing" },
      { mechanism: "deterministicization", verdict: "regressing" },
    ]);
    expect(verdict.evidence.join(" ")).toContain("deterministicization=regressing");
    expect(verdict.evidence.join(" ")).toContain("regressing cohorts reported as regressing");
  });

  test("the row-level catch: the cohort-hiding PROBE row FAILs its named criterion", async () => {
    const row = rowById("probe-cohort-hiding");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const cohort = criterionOf(result, "cohort-honesty");
    expect(cohort?.status).toBe("FAIL");
    expect(cohort?.evidence.join(" ")).toContain("COHORT-HIDING: deterministicization");
  });
});

// ---------------------------------------------------------------------------
// Family 6: the POST-HOC-EXCLUDING curve
// ---------------------------------------------------------------------------

describe("discrimination: post-hoc exclusion", () => {
  test("the derivation-level catch: a dropped pre-registered point FAILs named", () => {
    const row = rowById("probe-post-hoc-exclusion");
    const basis = honestCurveInputsOf(row);
    // The honest executed set holds g0..g5; the post-hoc shape drops g4.
    const excluded = deriveConfidenceAndMinimum({
      row,
      points: basis.points.filter((point) => point.facts.generation !== 4),
    });
    expect(excluded.conformant).toBe(false);
    expect(excluded.evidence.join(" ")).toContain(
      "post-hoc-excluded:g4 (a pre-registered curve point is absent",
    );
    expect(excluded.evidence.join(" ")).toContain("the pre-registered window decides");
  });

  test("the derivation-level catch: an undeclared point FAILs named", () => {
    const row = rowById("invoice-extraction-cost-per-outcome-trajectory");
    const basis = honestCurveInputsOf(row);
    const ghost = basis.points[0];
    if (ghost === undefined) {
      throw new Error("the headline point set is empty");
    }
    const impostor: CurvePointInput = {
      ...ghost,
      generation: 9,
      facts: { ...ghost.facts, generation: 9 },
    };
    const undeclared = deriveConfidenceAndMinimum({
      row,
      points: [...basis.points, impostor],
    });
    expect(undeclared.conformant).toBe(false);
    expect(undeclared.evidence.join(" ")).toContain(
      "undeclared-point:g9 (a point outside the pre-registered set)",
    );
  });

  test("the honest control: the pre-registered set holds with the Wilson interval bracketing the pooled rate", () => {
    for (const row of OFFLINE_CONTROL_ROWS) {
      const basis = honestCurveInputsOf(row);
      const confidence = deriveConfidenceAndMinimum({ row, points: basis.points });
      expect(confidence.conformant, row.rowId).toBe(true);
      expect(confidence.belowMinimum, row.rowId).toBe(false);
      expect(confidence.wilson, row.rowId).not.toBeNull();
      const pooled = pooledCurveFactsOf(basis.points);
      if (confidence.wilson !== null) {
        expect(confidence.wilson.low).toBeLessThanOrEqual(pooled.successfulOutcomes / pooled.runs);
        expect(confidence.wilson.high).toBeGreaterThanOrEqual(
          pooled.successfulOutcomes / pooled.runs,
        );
        const pinned = wilsonInterval(pooled.successfulOutcomes, pooled.runs);
        expect(confidence.wilson.low).toBeCloseTo(pinned.low, 12);
        expect(confidence.wilson.high).toBeCloseTo(pinned.high, 12);
      }
    }
  });

  test("the row-level catch: the post-hoc-exclusion PROBE row FAILs its named criterion", async () => {
    const row = rowById("probe-post-hoc-exclusion");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const confidence = criterionOf(result, "confidence-and-minimum");
    expect(confidence?.status).toBe("FAIL");
    expect(confidence?.evidence.join(" ")).toContain("post-hoc-excluded:g4");
  });
});

// ---------------------------------------------------------------------------
// Family 7: the SAMPLE-SIZE VIOLATION (the below-minimum verdict claim)
// ---------------------------------------------------------------------------

describe("discrimination: sample-size violation", () => {
  test("the derivation-level catch: a below-minimum curve claiming a trajectory verdict FAILs named", () => {
    const row = rowById("probe-sample-size-violation");
    const basis = honestCurveInputsOf(row);
    expect(basis.points).toHaveLength(2);
    const refusal = deriveBelowMinimumRefusalHonesty({ row, points: basis.points });
    expect(refusal.belowMinimum).toBe(true);
    expect(refusal.conformant).toBe(false);
    const evidence = refusal.evidence.join(" ");
    expect(evidence).toContain("BELOW-MINIMUM VERDICT CLAIM");
    expect(evidence).toContain("claims a verdict it cannot support");
    expect(evidence).toContain("the honest outcome is the refusal");
  });

  test("the honest control: the sufficient-sample rows' verdict claims stand", () => {
    for (const row of OFFLINE_CONTROL_ROWS) {
      const basis = honestCurveInputsOf(row);
      const refusal = deriveBelowMinimumRefusalHonesty({ row, points: basis.points });
      expect(refusal.belowMinimum, row.rowId).toBe(false);
      expect(refusal.conformant, row.rowId).toBe(true);
      expect(refusal.evidence.join(" "), row.rowId).toContain(
        "the verdict claim stands on a sufficient sample",
      );
    }
  });

  test("the row-level catch: the sample-size PROBE row FAILs its named criterion", async () => {
    const row = rowById("probe-sample-size-violation");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const refusal = criterionOf(result, "below-minimum-refusal-honesty");
    expect(refusal?.status).toBe("FAIL");
    expect(refusal?.evidence.join(" ")).toContain("BELOW-MINIMUM VERDICT CLAIM");
  });
});

// ---------------------------------------------------------------------------
// Family 8: the RE-MEASUREMENT MASQUERADE (the input-integrity oracle)
// ---------------------------------------------------------------------------

describe("discrimination: re-measurement masquerade", () => {
  test("the derivation-level catch: a re-measured model cost FAILs named, field by field", () => {
    const basis = headline();
    const reMeasured = applyCurveAdversarialVariant(basis.points, basis.attribution, {
      remeasurement: true,
    });
    const verdict = deriveCurveInputIntegrity({
      recordedLedger: basis.recordedLedger,
      points: reMeasured.points,
      recordedAttribution: basis.recordedAttribution,
      attribution: reMeasured.attribution,
    });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("RE-MEASUREMENT MASQUERADE: invoice-extraction@g2");
    expect(evidence).toContain("measuredModelCost 316 != recorded 315");
    expect(evidence).toContain("the curve derives over RECORDED results");
    const failed = verdict.verdicts.find((entry) => !entry.integrity);
    expect(failed?.failureReason).toBe("re-measurement-masquerade");
  });

  test("the derivation-level catch: a disagreeing digest FAILs named; an unresolvable reference FAILs named", () => {
    const basis = headline();
    const first = basis.points[0];
    if (first === undefined) {
      throw new Error("the headline point set is empty");
    }
    const digestMismatch = deriveCurveInputIntegrity({
      recordedLedger: basis.recordedLedger,
      points: [first, ...basis.points.slice(1)].map((point, index) =>
        index === 0 ? { ...point, recordedDigest: "deadbeef" } : point,
      ),
      recordedAttribution: basis.recordedAttribution,
      attribution: basis.attribution,
    });
    expect(digestMismatch.conformant).toBe(false);
    expect(digestMismatch.evidence.join(" ")).toContain("DIGEST-DISAGREED: invoice-extraction@g0");
    expect(digestMismatch.verdicts[0]?.failureReason).toBe("digest-disagreed");
    // A reference at a generation no recorded ledger holds.
    const ghost: CurvePointInput = {
      ...first,
      generation: 9,
      facts: { ...first.facts, generation: 9 },
    };
    const unresolvable = deriveCurveInputIntegrity({
      recordedLedger: basis.recordedLedger,
      points: [ghost],
      recordedAttribution: basis.recordedAttribution,
      attribution: basis.attribution,
    });
    expect(unresolvable.conformant).toBe(false);
    expect(unresolvable.evidence.join(" ")).toContain(
      "UNRESOLVABLE DIGEST REFERENCE: invoice-extraction@g9",
    );
    expect(unresolvable.verdicts[0]?.failureReason).toBe("unresolvable-reference");
  });

  test("the derivation-level catch: a disagreeing attribution bundle FAILs named (the VAL-045 digest reference)", () => {
    const basis = ragBasis();
    const first = basis.attribution[0];
    if (first === undefined) {
      throw new Error("the rag attribution series is empty");
    }
    const verdict = deriveCurveInputIntegrity({
      recordedLedger: basis.recordedLedger,
      points: basis.points,
      recordedAttribution: basis.recordedAttribution,
      attribution: [
        { ...first, residualMicroUsd: first.residualMicroUsd + 1 },
        ...basis.attribution.slice(1),
      ],
    });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("ATTRIBUTION-RESIDUAL-DISAGREED: rag-retrieval@g1");
    expect(evidence).toContain("!= recorded 30");
  });

  test("the honest control: the digest-verified recorded bundles all verify", () => {
    for (const row of OFFLINE_CONTROL_ROWS) {
      const basis = honestCurveInputsOf(row);
      const verdict = deriveCurveInputIntegrity({
        recordedLedger: basis.recordedLedger,
        points: basis.points,
        recordedAttribution: basis.recordedAttribution,
        attribution: basis.attribution,
      });
      expect(verdict.conformant, row.rowId).toBe(true);
      for (const entry of verdict.verdicts) {
        expect(entry.integrity, `${row.rowId}`).toBe(true);
        expect(entry.failureReason, `${row.rowId}`).toBeNull();
        expect(entry.detail.join(" "), `${row.rowId}`).toContain("digest:AGREED");
        expect(entry.detail.join(" "), `${row.rowId}`).toContain(
          "identical-to-the-recorded-ledger",
        );
      }
    }
  });

  test("the row-level catch: the re-measurement PROBE row FAILs its named criterion", async () => {
    const row = rowById("probe-remeasurement-masquerade");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const integrity = criterionOf(result, "curve-input-integrity");
    expect(integrity?.status).toBe("FAIL");
    expect(integrity?.evidence.join(" ")).toContain("RE-MEASUREMENT MASQUERADE");
    expect(integrity?.evidence.join(" ")).toContain("measuredModelCost 316 != recorded 315");
  });
});

// ---------------------------------------------------------------------------
// Family 9: the ESTIMATE-CONFLATING curve
// ---------------------------------------------------------------------------

describe("discrimination: estimate conflation", () => {
  test("the derivation-level catch: a claimed estimate basis FAILs named on every point", () => {
    const basis = headline();
    const estimateBacked = applyCurveAdversarialVariant(basis.points, basis.attribution, {
      estimateBasis: true,
    });
    const verdict = deriveEstimateMeasureSeparation({ points: estimateBacked.points });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("ESTIMATE-BASIS CLAIM: invoice-extraction@g0");
    expect(evidence).toContain(
      "the estimate/measure separation never folds a quote into the trajectory",
    );
    expect(evidence).toContain("ESTIMATE/MEASURE SEPARATION FAILED");
  });

  test("the derivation-level catch: an absorbed estimate (zero measured cost beside a quote) FAILs named", () => {
    const basis = headline();
    const absorbed = basis.points.map((point) =>
      point.facts.generation === 3
        ? {
            ...point,
            facts: { ...point.facts, measuredModelCostMicroUsd: 0, estimatedQuoteMicroUsd: 42 },
          }
        : point,
    );
    const verdict = deriveEstimateMeasureSeparation({ points: absorbed });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("ABSORBED ESTIMATE: invoice-extraction@g3");
    expect(verdict.evidence.join(" ")).toContain("the estimate was absorbed into the curve");
  });

  test("the honest control: the planner quotes ride SEPARATELY (never on the trajectory)", () => {
    const basis = headline();
    const verdict = deriveEstimateMeasureSeparation({ points: basis.points });
    expect(verdict.conformant).toBe(true);
    // The invoice class's baseline carries an 8-micro-USD planner quote
    // beside its measured basis — the quote is data, never the basis.
    const quoting = basis.points.filter((point) => (point.facts.estimatedQuoteMicroUsd ?? 0) > 0);
    expect(quoting.length).toBeGreaterThan(0);
    for (const point of quoting) {
      expect(point.facts.costBasis).toBe("measured");
      expect(point.facts.measuredModelCostMicroUsd).toBeGreaterThan(0);
    }
    expect(verdict.evidence.join(" ")).toContain("estimates ride separately as quotes");
  });
});

// ---------------------------------------------------------------------------
// Family 10: the WILSON-confidence application + the digest discipline
// ---------------------------------------------------------------------------

describe("discrimination: the Wilson-confidence application + the digest discipline", () => {
  test("a confidence-less comparison FAILs the frozen battery (the interval is required)", () => {
    const liveRow = CURVE_CORPUS.find((candidate) => candidate.needsDispatch);
    expect(liveRow).toBeDefined();
    if (liveRow === undefined) {
      throw new Error("the corpus declares no live row");
    }
    const confidence = deriveConfidenceAndMinimum({ row: liveRow, points: [] });
    expect(confidence.wilson).toBeNull();
    expect(confidence.conformant).toBe(false);
    expect(confidence.evidence.join(" ")).toContain("CONFIDENCE-LESS COMPARISON");
    expect(confidence.evidence.join(" ")).toContain("BELOW-MINIMUM");
    expect(WILSON_CONFIG.confidenceLevel).toBe(0.95);
    expect(MINIMUM_GENERATIONS_FOR_CURVE).toBe(3);
    expect(MINIMUM_OUTCOMES_PER_POINT).toBe(5);
  });

  test("the recorded point digest is deterministic and discriminating (payload-free)", () => {
    const ledger = LONGITUDINAL_LEDGERS.find(
      (candidate) => candidate.workloadClass === "invoice-extraction",
    );
    const point = ledger?.points[0];
    if (point === undefined) {
      throw new Error("the invoice ledger holds no baseline point");
    }
    const digest = recordedCurvePointDigestOf(point);
    expect(digest).toBe(recordedCurvePointDigestOf(point));
    expect(digest).toMatch(/^[0-9a-f]{8}$/);
    // A re-measured run count changes the digest (the digest IS the content).
    expect(digest).not.toBe(recordedCurvePointDigestOf({ ...point, runs: point.runs + 1 }));
    // A normalized revision changes the digest (the regime is content).
    expect(digest).not.toBe(
      recordedCurvePointDigestOf({ ...point, modelPriceRevision: "rev-002" }),
    );
  });

  test("the attribution digest discriminates a hidden residual (never a copy)", () => {
    const basis = ragBasis();
    const first = basis.attribution[0];
    if (first === undefined) {
      throw new Error("the rag attribution series is empty");
    }
    const digest = first.attributionDigest;
    expect(digest).toBe(
      curveAttributionDigestOf({
        workloadClass: first.workloadClass,
        generation: first.generation,
        attributedMicroUsd: first.attributedMicroUsd,
        residualMicroUsd: first.residualMicroUsd,
        ledgerEntryDigests: first.ledgerEntryDigests,
        recordedTotalDigests: first.recordedTotalDigests,
      }),
    );
    // The hidden-residual claim carries a DIFFERENT digest than the
    // recorded result — the unattributed share is never copyable away.
    expect(digest).not.toBe(
      curveAttributionDigestOf({
        workloadClass: first.workloadClass,
        generation: first.generation,
        attributedMicroUsd: first.attributedMicroUsd,
        residualMicroUsd: 0,
        ledgerEntryDigests: first.ledgerEntryDigests,
        recordedTotalDigests: first.recordedTotalDigests,
      }),
    );
    // The honest and denatured input bundles carry separable digests.
    const hidden = applyCurveAdversarialVariant(basis.points, basis.attribution, {
      residualHiding: true,
    });
    expect(
      economicDigestOf(
        basis.attribution.map((bundle) => [bundle.workloadClass, bundle.residualMicroUsd]),
      ),
    ).not.toBe(
      economicDigestOf(
        hidden.attribution.map((bundle) => [
          bundle.workloadClass,
          bundle.claimed?.residualMicroUsd ?? bundle.residualMicroUsd,
        ]),
      ),
    );
  });

  test("the live plan digest binds the measured lane's declaration (never an outcome copy)", () => {
    const digest = liveCurvePlanDigestOf();
    expect(digest).toBe(liveCurvePlanDigestOf());
    expect(digest).toMatch(/^[0-9a-f]{8}$/);
    // The declaration digest is not any recorded point's own digest.
    const basis = headline();
    for (const point of basis.points) {
      expect(digest).not.toBe(point.recordedDigest);
    }
  });
});

// ---------------------------------------------------------------------------
// Family 11: the honest controls over the whole fixture stack
// ---------------------------------------------------------------------------

describe("discrimination: the honest controls over the fixture stack", () => {
  test("every honest control row COMPLETES over the leaky stack", async () => {
    for (const row of OFFLINE_CONTROL_ROWS) {
      const result = await driveRowOverLeakyStack({ row });
      expect(result.terminal, `${row.rowId} terminal`).toBe("COMPLETED");
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(result.observedTerminal, `${row.rowId} observed`).toBe("COMPLETED");
      expect(result.failure, `${row.rowId} failure`).toBeNull();
      // The honest classification IS the verified outcome — improving,
      // plateaued, never-materialized and mixed-cohort-regressing alike.
      expect(result.synthesis?.verdict, `${row.rowId} verdict`).toBe(row.expected.verdict);
    }
  });

  test("every adversarial PROBE row FAILs its NAMED criterion honestly", async () => {
    const named: Readonly<Record<string, string>> = {
      "probe-cherry-picked-window": "window-honesty",
      "probe-regime-normalizing": "price-regime-marking",
      "probe-extrapolating": "no-extrapolation",
      "probe-residual-hiding": "improvement-rate-reconciliation",
      "probe-cohort-hiding": "cohort-honesty",
      "probe-post-hoc-exclusion": "confidence-and-minimum",
      "probe-sample-size-violation": "below-minimum-refusal-honesty",
      "probe-remeasurement-masquerade": "curve-input-integrity",
    };
    expect(PROBE_ROWS).toHaveLength(8);
    for (const row of PROBE_ROWS) {
      const result = await driveRowOverLeakyStack({ row });
      expect(result.terminal, `${row.rowId} terminal`).toBe("FAILED");
      const criterion = criterionOf(result, named[row.rowId] ?? "");
      expect(criterion?.status, `${row.rowId} ${named[row.rowId] ?? "?"}`).toBe("FAIL");
      // The honest failure shape: the row's own read-back agrees and
      // the observed terminal is FAILED (never a fabricated pass) — the
      // derived terminal comes from the named criterion's FAIL, and the
      // row-outcome contract itself PASSes on the expected FAILED.
      expect(result.observedTerminal, `${row.rowId} observed`).toBe("FAILED");
      expect(criterionOf(result, "observed-terminal-readback")?.status, row.rowId).toBe("PASS");
      expect(criterionOf(result, "row-outcome-contract")?.status, row.rowId).toBe("PASS");
    }
  });

  test("the verdict derivation orders the honest classifications over the pinned thresholds", () => {
    const cohorts = deriveCohortVerdicts({ attribution: ragBasis().attribution });
    const emptyCohorts = deriveCohortVerdicts({ attribution: [] });
    const invoice = honestCurveInputsOf(
      rowById("invoice-extraction-cost-per-outcome-trajectory"),
    ).points.map((point) => point.facts);
    const codeSearch = honestCurveInputsOf(
      rowById("code-search-plateau-maturity-verdict"),
    ).points.map((point) => point.facts);
    const toolRouting = honestCurveInputsOf(rowById("tool-routing-never-materialized")).points.map(
      (point) => point.facts,
    );
    expect(
      deriveCurveVerdictKindFor({
        points: invoice,
        cohorts: emptyCohorts,
      }),
    ).toBe("trajectory-improving");
    expect(deriveCurveVerdictKindFor({ points: codeSearch, cohorts: emptyCohorts })).toBe(
      "trajectory-plateaued",
    );
    expect(deriveCurveVerdictKindFor({ points: toolRouting, cohorts: emptyCohorts })).toBe(
      "never-materialized",
    );
    // The rag class: still trending, but a regressing cohort is REPORTED
    // (mixed), never hidden behind the improving aggregate.
    expect(
      deriveCurveVerdictKindFor({ points: ragBasis().points.map((p) => p.facts), cohorts }),
    ).toBe("mixed-cohort-regressing");
  });
});

/** The verdict derivation with the corpus's pinned minimums (the test-local binding). */
function deriveCurveVerdictKindFor(input: {
  readonly points: readonly RecordedCurvePoint[];
  readonly cohorts: readonly { readonly verdict: CohortVerdict }[];
}): string {
  return deriveCurveVerdictKind({
    minimumGenerations: MINIMUM_GENERATIONS_FOR_CURVE,
    minimumOutcomesPerPoint: MINIMUM_OUTCOMES_PER_POINT,
    points: input.points,
    cohorts: input.cohorts,
  });
}
