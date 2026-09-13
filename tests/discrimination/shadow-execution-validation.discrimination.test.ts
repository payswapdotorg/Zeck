/**
 * VAL-034 acceptance criteria 4 + 6 — discrimination tests proving the
 * shadow execution against controlled fakes (the six AC6 families over
 * the PURE platform derivations):
 *
 *   * the LEAKED SHADOW OUTCOME — a served outcome sourced from the
 *     REPLACEMENT (an explicit leak) or a served digest that is the
 *     shadow's own while claiming the incumbent source (a disguised
 *     leak) FAILs the serving isolation mechanically — while the
 *     incumbent-served population PASSES (the served-source pin);
 *
 *   * the DROPPED CASE — a shadow comparison that drops a recorded
 *     case, duplicates one, or swaps one for a foreign case (a
 *     population that does not match the recorded workload mix) FAILs
 *     the population completeness — while the FULL recorded mix PASSES;
 *
 *   * the SMOOTHED AGGREGATE — an asserted aggregate without the
 *     per-case records (an aggregate-only claim), an asserted
 *     agreement drawn from a subset of the population, a divergent
 *     case claimed agreeing (a smoothed divergence) and an agreeing
 *     case claimed diverging (a false divergence) each FAIL the
 *     regression honesty — while the per-case evidence PASSES;
 *
 *   * the BILLED SHADOW COST — a served total inflated by the shadow
 *     cost (a billed shadow) FAILs with the billed delta named, and
 *     an unmeasured, unbooked or misbooked shadow cost FAILs — while
 *     the separated booking PASSES;
 *
 *   * the SKIPPED STAGE — any lifecycle append that jumps PAST the
 *     shadow-executed stage (canaried/promoted — VAL-035's scope),
 *     lands at a WRONG stage, or lands without its evidence FAILs the
 *     stage discipline, a PREMATURE candidate (a walk that never
 *     reached differentially-evaluated) FAILs, and a registry REWRITE
 *     (mutating a candidate's own entry) FAILs the read-only
 *     discipline — while the evidenced walk PASSES;
 *
 *   * the CONTAINMENT ESCAPE MID-SHADOW — a replacement exercising ANY
 *     of the four pinned escape directions (network access, platform
 *     state mutation, credential access, tenant-boundary crossing)
 *     DURING the shadow is a containment VIOLATION that FAILs and
 *     never lands — while the within-surface exercise is contained.
 *
 * Plus the honest controls: the verdict-kind derivation orders its
 * failure modes honestly, the refusal honesty (justified refusals vs
 * unjustified vs malformed outcomes), the digest/identity derivations
 * are deterministic and discriminating, the honest shadow run is
 * deterministic and mechanical, `verifyShadowExecutionAppContract`
 * catches every fake-world knob at the boundary, the shadow ledger is
 * append-only exactly-once, and the honest control over the fixture
 * stack behaves per its pin.
 */

import { describe, expect, test } from "vitest";
import { runShadowExecutionApp } from "../../benchmarks/validation/apps/shadow-execution/application";
import {
  OFFLINE_CORPUS_ROWS,
  PINNED_REGISTRY_ENTRIES,
  pinnedShadowRunOf,
  SHADOW_EXECUTION_CORPUS,
  shadowRowById,
} from "../../benchmarks/validation/apps/shadow-execution/corpus";
import {
  createCandidateRegistry,
  createHonestShadowStack,
  createIncumbentExecutor,
  createLifecycleLedger,
  createServingPath,
  createShadowFakeApiWorld,
  createShadowLedger,
  createShadowRuntime,
  createTickClock,
  createTrafficSource,
} from "../../benchmarks/validation/apps/shadow-execution/fixtures";
import type { TransportImplementation } from "../../benchmarks/validation/harness/harness";
import type { ReplacementIsolationVerdict } from "../../benchmarks/validation/platform/equivalence-testing";
import {
  deriveReplacementIsolation,
  ISOLATION_ESCAPE_DIRECTIONS,
} from "../../benchmarks/validation/platform/equivalence-testing";
import { CANDIDATE_LIFECYCLE_STAGES } from "../../benchmarks/validation/platform/learning-discovery";
import { longitudinalDigestOf } from "../../benchmarks/validation/platform/longitudinal-baseline";
import type {
  ShadowCaseOutcome,
  ShadowCorpusRow,
} from "../../benchmarks/validation/platform/shadow-execution";
import {
  deriveHonestShadowRun,
  deriveRegressionHonesty,
  deriveServingIsolation,
  deriveShadowCostSeparation,
  deriveShadowPopulationCompleteness,
  deriveShadowRefusalHonesty,
  deriveShadowStageDiscipline,
  deriveShadowVerdictKind,
  driveShadowRun,
  isBeyondShadowScope,
  lifecycleStageIndexOf,
  SERVED_SOURCE_PIN,
  SHADOW_STAGE,
  shadowComparisonDigestOf,
  shadowCostDigestOf,
  shadowDivergenceDigestOf,
  shadowPopulationDigestOf,
  shadowRegistryDigestOf,
  shadowTrafficCaseDigestOf,
} from "../../benchmarks/validation/platform/shadow-execution";

const REVISION = "439c0b4c11d1c9a5b6f00112233445566778899aa";

const rowById = (rowId: string): ShadowCorpusRow => {
  const row = shadowRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const taskIndexOf = (rowId: string): number => {
  const index = SHADOW_EXECUTION_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
};

/** The row's per-case incumbent outcomes (the recorded/pinned digests). */
const incumbentOutcomesOf = (row: ShadowCorpusRow): readonly ShadowCaseOutcome[] =>
  row.trafficPopulation.map((tcase) => ({
    caseId: tcase.caseId,
    digest: tcase.incumbentDigest,
  }));

/** The row's honest shadow leg (the reference runtime's outcomes). */
const honestShadowOutcomesOf = (row: ShadowCorpusRow) =>
  pinnedShadowRunOf(row).honestRun.outcomes.map((outcome) => ({ ...outcome }));

/** The row's served outcomes over the honest incumbent-served path. */
const honestServedOutcomesOf = (row: ShadowCorpusRow) =>
  row.trafficPopulation.map((tcase) => ({
    caseId: tcase.caseId,
    servedSource: SERVED_SOURCE_PIN,
    servedDigest: tcase.incumbentDigest,
  }));

/** The row's shadow digest per case (the reference runtime's outcomes). */
const shadowDigestByCaseOf = (row: ShadowCorpusRow): ReadonlyMap<string, string> => {
  const digests = new Map<string, string>();
  for (const outcome of pinnedShadowRunOf(row).honestRun.outcomes) {
    digests.set(outcome.caseId, outcome.digest);
  }
  return digests;
};

/** The row's LEAKED served outcomes (each leak shape's serve basis). */
const leakedServedOutcomesOf = (
  row: ShadowCorpusRow,
  servedSource: string,
): readonly { caseId: string; servedSource: string; servedDigest: string }[] => {
  const shadowDigests = shadowDigestByCaseOf(row);
  return row.trafficPopulation.map((tcase) => ({
    caseId: tcase.caseId,
    servedSource,
    servedDigest: shadowDigests.get(tcase.caseId) ?? "",
  }));
};

/** Build the regression-honesty input over one row (the honest basis). */
function regressionBasisOf(row: ShadowCorpusRow) {
  const { honestRun, regression } = pinnedShadowRunOf(row);
  return {
    basis: {
      population: [...row.trafficPopulation],
      criterion: row.acceptanceCriterion,
      incumbentOutcomes: incumbentOutcomesOf(row),
      shadowOutcomes: honestRun.outcomes.map((outcome) => ({ ...outcome })),
      comparedCaseIds: [...honestRun.comparedCaseIds],
      aggregateClaim: honestRun.aggregateClaim,
    },
    honestRun,
    regression,
  };
}

// ---------------------------------------------------------------------------
// Family 1: the leaked shadow outcome (the serving-isolation catch)
// ---------------------------------------------------------------------------

describe("VAL-034 discrimination: the leaked shadow outcome", () => {
  // The honest-divergence row's shadow digests genuinely differ from
  // the incumbent's — the leak shapes are visible on every case.
  const row = rowById("reuse-removed-call-shadow-honest-divergence");

  test("an EXPLICIT leak (the replacement's outcome served) FAILs with the leak named", () => {
    const verdict = deriveServingIsolation({
      population: row.trafficPopulation,
      incumbentOutcomes: incumbentOutcomesOf(row),
      shadowOutcomes: honestShadowOutcomesOf(row),
      servedOutcomes: leakedServedOutcomesOf(row, "replacement"),
    });
    expect(verdict.isolated).toBe(false);
    expect(verdict.leakKind).toBe("explicit-leak");
    expect(verdict.leakedCaseIds).toEqual(row.trafficPopulation.map((tcase) => tcase.caseId));
    const source = verdict.criteria.find(
      (criterion) => criterion.criterionId === "serving-source-pinned-incumbent",
    );
    expect(source?.status).toBe("FAIL");
    expect(source?.evidence.join(" ")).toContain("LEAKED-SHADOW");
    const summary = verdict.criteria.find(
      (criterion) => criterion.criterionId === "serving-isolation-summary",
    );
    expect(summary?.status).toBe("FAIL");
    expect(summary?.evidence.join(" ")).toContain("SHADOW-LEAK");
  });

  test("a DISGUISED leak (the shadow's digest under the incumbent source) FAILs", () => {
    const verdict = deriveServingIsolation({
      population: row.trafficPopulation,
      incumbentOutcomes: incumbentOutcomesOf(row),
      shadowOutcomes: honestShadowOutcomesOf(row),
      servedOutcomes: leakedServedOutcomesOf(row, SERVED_SOURCE_PIN),
    });
    expect(verdict.isolated).toBe(false);
    expect(verdict.leakKind).toBe("disguised-leak");
    const digest = verdict.criteria.find(
      (criterion) => criterion.criterionId === "serving-digest-is-incumbents",
    );
    expect(digest?.status).toBe("FAIL");
    expect(digest?.evidence.join(" ")).toContain("LEAKED-SHADOW-DISGUISED");
  });

  test("a WRONG serve (a digest that is neither side's) and an UNSERVED case each FAIL", () => {
    const wrong = deriveServingIsolation({
      population: row.trafficPopulation,
      incumbentOutcomes: incumbentOutcomesOf(row),
      shadowOutcomes: honestShadowOutcomesOf(row),
      servedOutcomes: row.trafficPopulation.map((tcase) => ({
        caseId: tcase.caseId,
        servedSource: SERVED_SOURCE_PIN,
        servedDigest: longitudinalDigestOf(["wrong-serve", tcase.caseId]),
      })),
    });
    expect(wrong.isolated).toBe(false);
    expect(wrong.leakKind).toBeNull();
    expect(wrong.wrongServeCaseIds).toEqual(row.trafficPopulation.map((tcase) => tcase.caseId));
    const digest = wrong.criteria.find(
      (criterion) => criterion.criterionId === "serving-digest-is-incumbents",
    );
    expect(digest?.status).toBe("FAIL");
    expect(digest?.evidence.join(" ")).toContain("WRONG-SERVE");

    const unserved = deriveServingIsolation({
      population: row.trafficPopulation,
      incumbentOutcomes: incumbentOutcomesOf(row),
      shadowOutcomes: honestShadowOutcomesOf(row),
      servedOutcomes: honestServedOutcomesOf(row).slice(0, -1),
    });
    expect(unserved.isolated).toBe(false);
    const last = row.trafficPopulation[row.trafficPopulation.length - 1]?.caseId ?? "";
    expect(unserved.unservedCaseIds).toEqual([last]);
    const served = unserved.criteria.find(
      (criterion) => criterion.criterionId === "serving-every-case-served",
    );
    expect(served?.status).toBe("FAIL");
    expect(served?.evidence.join(" ")).toContain("UNSERVED-CASE");
  });

  test("the INCUMBENT-served population PASSES (the served-source pin — the control)", () => {
    const verdict = deriveServingIsolation({
      population: row.trafficPopulation,
      incumbentOutcomes: incumbentOutcomesOf(row),
      shadowOutcomes: honestShadowOutcomesOf(row),
      servedOutcomes: honestServedOutcomesOf(row),
    });
    expect(verdict.isolated).toBe(true);
    expect(verdict.leakKind).toBeNull();
    expect(verdict.leakedCaseIds).toEqual([]);
    for (const criterion of verdict.criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
  });
});

// ---------------------------------------------------------------------------
// Family 2: the dropped case (the population-completeness catch)
// ---------------------------------------------------------------------------

describe("VAL-034 discrimination: the dropped case", () => {
  const row = rowById("rag-deterministic-function-shadow-agreement");
  const caseIds = row.trafficPopulation.map((tcase) => tcase.caseId);
  const classes = row.trafficWorkloadClasses;

  const completenessOf = (observedCaseIds: readonly string[]) =>
    deriveShadowPopulationCompleteness({
      recordedCaseIds: caseIds,
      workloadClassByCaseId: classes,
      observedCaseIds,
    });

  test("a DROPPED case FAILs with the case named", () => {
    const verdict = completenessOf(caseIds.slice(0, -1));
    expect(verdict.complete).toBe(false);
    expect(verdict.missingCaseIds).toEqual([caseIds[caseIds.length - 1]]);
    const dropped = verdict.criteria.find(
      (criterion) => criterion.criterionId === "population-no-dropped-case",
    );
    expect(dropped?.status).toBe("FAIL");
    expect(dropped?.evidence.join(" ")).toContain("DROPPED-CASE");
  });

  test("a DUPLICATED case FAILs (an inflated mix weight)", () => {
    const verdict = completenessOf([caseIds[0] as string, ...caseIds]);
    expect(verdict.complete).toBe(false);
    const duplicated = verdict.criteria.find(
      (criterion) => criterion.criterionId === "population-no-duplicated-case",
    );
    expect(duplicated?.status).toBe("FAIL");
    expect(duplicated?.evidence.join(" ")).toContain("DUPLICATED-CASE");
  });

  test("a FOREIGN case (a swapped population) FAILs with the case named", () => {
    const foreign = `foreign-traffic-${caseIds[caseIds.length - 1]}`;
    const verdict = completenessOf([...caseIds.slice(0, -1), foreign]);
    expect(verdict.complete).toBe(false);
    expect(verdict.foreignCaseIds).toEqual([foreign]);
    const foreignLeg = verdict.criteria.find(
      (criterion) => criterion.criterionId === "population-no-foreign-case",
    );
    expect(foreignLeg?.status).toBe("FAIL");
    expect(foreignLeg?.evidence.join(" ")).toContain("FOREIGN-CASE");
  });

  test("a MIX mismatch FAILs even when the total count matches (a lookalike mix)", () => {
    // One injected probe is swapped for a foreign case classified in
    // the historical workload's class: the SAME total case count, but
    // the per-class counts differ from the recorded mix — the shadow
    // replays the recorded mix, not a lookalike.
    const foreign = "foreign-traffic-lookalike";
    const classesWithForeign: Record<string, string> = {
      ...classes,
      [foreign]: "rag-retrieval-replay-population",
    };
    const verdict = deriveShadowPopulationCompleteness({
      recordedCaseIds: caseIds,
      workloadClassByCaseId: classesWithForeign,
      observedCaseIds: [...caseIds.slice(0, -1), foreign],
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.mixMatches).toBe(false);
    expect(verdict.recordedMix).toEqual([
      { workloadClass: "injected-probe", count: 2 },
      { workloadClass: "rag-retrieval-replay-population", count: 4 },
    ]);
    expect(verdict.observedMix).toEqual([
      { workloadClass: "injected-probe", count: 1 },
      { workloadClass: "rag-retrieval-replay-population", count: 5 },
    ]);
    const mix = verdict.criteria.find(
      (criterion) => criterion.criterionId === "population-workload-mix-matches",
    );
    expect(mix?.status).toBe("FAIL");
    expect(mix?.evidence.join(" ")).toContain("MIX-MISMATCH");
  });

  test("the FULL recorded mix PASSES (per-class counts identical — the control)", () => {
    const verdict = completenessOf(caseIds);
    expect(verdict.complete).toBe(true);
    expect(verdict.mixMatches).toBe(true);
    expect(verdict.recordedMix.length).toBeGreaterThan(1);
    for (const criterion of verdict.criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
  });
});

// ---------------------------------------------------------------------------
// Family 3: the smoothed aggregate (the regression-honesty catch)
// ---------------------------------------------------------------------------

describe("VAL-034 discrimination: the smoothed aggregate", () => {
  const row = rowById("rag-deterministic-function-shadow-agreement");

  test("an AGGREGATE-ONLY claim (no per-case records) FAILs with the missing cases named", () => {
    const { basis, honestRun } = regressionBasisOf(row);
    const verdict = deriveRegressionHonesty({
      ...basis,
      comparedCaseIds: [],
      aggregateClaim: { assertedAgreement: true, assertedDivergenceCount: 0 },
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.missingCaseIds).toEqual(row.trafficPopulation.map((tcase) => tcase.caseId));
    const perCase = verdict.criteria.find(
      (criterion) => criterion.criterionId === "regression-per-case-evidence",
    );
    expect(perCase?.status).toBe("FAIL");
    expect(perCase?.evidence.join(" ")).toContain("AGGREGATE-ONLY");
    expect(honestRun.outcomes.length).toBe(row.trafficPopulation.length);
  });

  test("an asserted agreement from a SUBSET of the population FAILs", () => {
    const { basis } = regressionBasisOf(row);
    const verdict = deriveRegressionHonesty({
      ...basis,
      comparedCaseIds: basis.comparedCaseIds.slice(0, -1),
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.missingCaseIds).toEqual([
      row.trafficPopulation[row.trafficPopulation.length - 1]?.caseId,
    ]);
    const perCase = verdict.criteria.find(
      (criterion) => criterion.criterionId === "regression-per-case-evidence",
    );
    expect(perCase?.status).toBe("FAIL");
  });

  test("a SMOOTHED divergence (a divergent case claimed agreeing) FAILs the honesty leg", () => {
    const divergenceRow = rowById("reuse-removed-call-shadow-honest-divergence");
    const { basis } = regressionBasisOf(divergenceRow);
    // The removed-call shape diverges on every case; the runtime CLAIMS
    // agreement for the first one (the smoothing).
    const smoothed = basis.shadowOutcomes.map((outcome, index) =>
      index === 0 ? { ...outcome, claimedAgrees: true } : { ...outcome },
    );
    const verdict = deriveRegressionHonesty({ ...basis, shadowOutcomes: smoothed });
    expect(verdict.mechanicalDivergenceCaseIds).toHaveLength(
      divergenceRow.trafficPopulation.length,
    );
    expect(verdict.smoothedCaseIds).toHaveLength(1);
    expect(verdict.honest).toBe(false);
    const noSmoothing = verdict.criteria.find(
      (criterion) => criterion.criterionId === "regression-no-smoothing",
    );
    expect(noSmoothing?.status).toBe("FAIL");
    expect(noSmoothing?.evidence.join(" ")).toContain("DIVERGENCE-SMOOTHING");
  });

  test("a FALSE divergence (an agreeing case claimed diverging) FAILs identically", () => {
    const { basis } = regressionBasisOf(row);
    const lying = basis.shadowOutcomes.map((outcome) => ({
      ...outcome,
      claimedAgrees: false,
    }));
    const verdict = deriveRegressionHonesty({
      ...basis,
      shadowOutcomes: lying,
      aggregateClaim: { assertedAgreement: false, assertedDivergenceCount: lying.length },
    });
    expect(verdict.mechanicalDivergenceCaseIds).toEqual([]);
    expect(verdict.falseDivergenceCaseIds).toHaveLength(row.trafficPopulation.length);
    expect(verdict.honest).toBe(false);
    const noSmoothing = verdict.criteria.find(
      (criterion) => criterion.criterionId === "regression-no-smoothing",
    );
    expect(noSmoothing?.status).toBe("FAIL");
    expect(noSmoothing?.evidence.join(" ")).toContain("FALSE-DIVERGENCE");
  });

  test("an ABSENT aggregate and FABRICATED records each FAIL", () => {
    const { basis } = regressionBasisOf(row);
    const absent = deriveRegressionHonesty({ ...basis, aggregateClaim: null });
    expect(absent.honest).toBe(false);
    expect(absent.aggregatePresent).toBe(false);
    const aggregate = absent.criteria.find(
      (criterion) => criterion.criterionId === "regression-aggregate-honest",
    );
    expect(aggregate?.status).toBe("FAIL");
    expect(aggregate?.evidence.join(" ")).toContain("ABSENT-AGGREGATE");

    const fabricated = deriveRegressionHonesty({
      ...basis,
      comparedCaseIds: [...basis.comparedCaseIds, "fabricated-case-x"],
    });
    expect(fabricated.honest).toBe(false);
    expect(fabricated.foreignCaseIds).toEqual(["fabricated-case-x"]);
    const perCase = fabricated.criteria.find(
      (criterion) => criterion.criterionId === "regression-per-case-evidence",
    );
    expect(perCase?.status).toBe("FAIL");
    expect(perCase?.evidence.join(" ")).toContain("FABRICATED-EVIDENCE");
  });

  test("the HONEST divergence is recorded case-by-case, never smoothed (the control)", () => {
    const divergenceRow = rowById("reuse-removed-call-shadow-honest-divergence");
    const { basis, regression } = regressionBasisOf(divergenceRow);
    const verdict = deriveRegressionHonesty(basis);
    expect(verdict.honest).toBe(true);
    expect(verdict.mechanicalDivergenceCaseIds).toEqual([
      ...divergenceRow.expected.divergenceCaseIds,
    ]);
    expect(verdict.smoothedCaseIds).toEqual([]);
    expect(verdict.aggregateMatches).toBe(true);
    for (const criterion of verdict.criteria) {
      if (criterion.criterionId === "regression-agreement-under-criterion") {
        // The divergence itself FAILs the criterion leg HONESTLY — the
        // row FAILs, the record survives.
        expect(criterion.status).toBe("FAIL");
        expect(criterion.evidence.join(" ")).toContain("HONEST-DIVERGENCE");
      } else {
        expect(criterion.status, criterion.criterionId).toBe("PASS");
      }
    }
    expect(verdict.digest).toBe(regression.digest);
  });

  test("the per-case agreement control PASSES every leg (the clean regression comparison)", () => {
    const { basis } = regressionBasisOf(row);
    const verdict = deriveRegressionHonesty(basis);
    expect(verdict.honest).toBe(true);
    expect(verdict.mechanicalDivergenceCaseIds).toEqual([]);
    for (const criterion of verdict.criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
  });
});

// ---------------------------------------------------------------------------
// Family 4: the billed shadow cost (the accounting catch)
// ---------------------------------------------------------------------------

describe("VAL-034 discrimination: the billed shadow cost", () => {
  const row = rowById("rag-deterministic-function-shadow-agreement");
  const shadowMicroUsd = 2 * row.trafficPopulation.length + 1;
  const incumbentMicroUsd = 3 * row.trafficPopulation.length + 1;

  test("a BILLED shadow (the served total inflated) FAILs with the delta named", () => {
    const verdict = deriveShadowCostSeparation({
      incumbentCostMicroUsd: incumbentMicroUsd,
      shadowCostMicroUsd: shadowMicroUsd,
      servedTotalMicroUsd: incumbentMicroUsd + shadowMicroUsd,
      shadowLedgerBookedMicroUsd: shadowMicroUsd,
    });
    expect(verdict.separated).toBe(false);
    expect(verdict.billedOntoServedMicroUsd).toBe(shadowMicroUsd);
    const billed = verdict.criteria.find(
      (criterion) => criterion.criterionId === "cost-served-excludes-shadow",
    );
    expect(billed?.status).toBe("FAIL");
    expect(billed?.evidence.join(" ")).toContain("BILLED-SHADOW");
    expect(billed?.evidence.join(" ")).toContain(String(shadowMicroUsd));
  });

  test("an UNMEASURED shadow cost FAILs (an honest run measures its shadow cost)", () => {
    const verdict = deriveShadowCostSeparation({
      incumbentCostMicroUsd: incumbentMicroUsd,
      shadowCostMicroUsd: null,
      servedTotalMicroUsd: incumbentMicroUsd,
      shadowLedgerBookedMicroUsd: null,
    });
    expect(verdict.separated).toBe(false);
    expect(verdict.shadowCostMeasured).toBe(false);
    const measured = verdict.criteria.find(
      (criterion) => criterion.criterionId === "cost-shadow-measured",
    );
    expect(measured?.status).toBe("FAIL");
    expect(measured?.evidence.join(" ")).toContain("UNMEASURED-SHADOW-COST");
  });

  test("an UNBOOKED and a MISBOOKED shadow cost each FAIL", () => {
    const unbooked = deriveShadowCostSeparation({
      incumbentCostMicroUsd: incumbentMicroUsd,
      shadowCostMicroUsd: shadowMicroUsd,
      servedTotalMicroUsd: incumbentMicroUsd,
      shadowLedgerBookedMicroUsd: null,
    });
    expect(unbooked.separated).toBe(false);
    const booked = unbooked.criteria.find(
      (criterion) => criterion.criterionId === "cost-shadow-ledger-books-shadow",
    );
    expect(booked?.status).toBe("FAIL");
    expect(booked?.evidence.join(" ")).toContain("UNBOOKED-SHADOW-COST");

    const misbooked = deriveShadowCostSeparation({
      incumbentCostMicroUsd: incumbentMicroUsd,
      shadowCostMicroUsd: shadowMicroUsd,
      servedTotalMicroUsd: incumbentMicroUsd,
      shadowLedgerBookedMicroUsd: shadowMicroUsd + 1,
    });
    expect(misbooked.separated).toBe(false);
    const misbookedLeg = misbooked.criteria.find(
      (criterion) => criterion.criterionId === "cost-shadow-ledger-books-shadow",
    );
    expect(misbookedLeg?.status).toBe("FAIL");
    expect(misbookedLeg?.evidence.join(" ")).toContain("MISBOOKED-SHADOW-COST");
  });

  test("the SEPARATED booking PASSES (booked apart, served bills the incumbent only — the control)", () => {
    const verdict = deriveShadowCostSeparation({
      incumbentCostMicroUsd: incumbentMicroUsd,
      shadowCostMicroUsd: shadowMicroUsd,
      servedTotalMicroUsd: incumbentMicroUsd,
      shadowLedgerBookedMicroUsd: shadowMicroUsd,
    });
    expect(verdict.separated).toBe(true);
    expect(verdict.billedOntoServedMicroUsd).toBe(0);
    for (const criterion of verdict.criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
  });
});

// ---------------------------------------------------------------------------
// Family 5: the skipped stage (the lifecycle discipline catch)
// ---------------------------------------------------------------------------

describe("VAL-034 discrimination: the skipped stage", () => {
  const row = rowById("rag-deterministic-function-shadow-agreement");
  const { regression } = pinnedShadowRunOf(row);

  /** The recorded VAL-033 walk + the evidenced shadow append (the control). */
  const honestShadowAppend = {
    proposalId: row.sourceProposalId,
    toStage: SHADOW_STAGE,
    evidenceDigest: longitudinalDigestOf(["shadow-evidence", row.sourceProposalId]),
    ordinal: 3,
  };

  test("the recorded walk + the single evidenced shadow append is DISCIPLINED (the control)", () => {
    const verdict = deriveShadowStageDiscipline({
      priorWalk: ["offline-replayed", "differentially-evaluated"],
      appendedTransitions: [honestShadowAppend],
      expectedLanding: true,
    });
    expect(verdict.disciplined).toBe(true);
    expect(verdict.appendedWalk).toEqual([SHADOW_STAGE]);
    for (const criterion of verdict.criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
    expect(regression.digest).toMatch(/^[0-9a-f]{8}$/);
  });

  test("any jump PAST the shadow-executed stage FAILs (an out-of-scope promotion)", () => {
    for (const stage of CANDIDATE_LIFECYCLE_STAGES) {
      expect(isBeyondShadowScope(stage)).toBe(
        lifecycleStageIndexOf(stage) > lifecycleStageIndexOf(SHADOW_STAGE),
      );
    }
    const beyond = CANDIDATE_LIFECYCLE_STAGES.filter(isBeyondShadowScope);
    expect(beyond).toEqual(["canaried", "promoted"]);
    for (const stage of beyond) {
      const verdict = deriveShadowStageDiscipline({
        priorWalk: ["offline-replayed", "differentially-evaluated"],
        appendedTransitions: [
          {
            proposalId: row.sourceProposalId,
            toStage: stage,
            evidenceDigest: longitudinalDigestOf(["evidence", stage]),
            ordinal: 3,
          },
        ],
        expectedLanding: true,
      });
      expect(verdict.disciplined, stage).toBe(false);
      expect(verdict.beyondScopeStages).toEqual([stage]);
      const never = verdict.criteria.find(
        (criterion) => criterion.criterionId === "stage-discipline-never-beyond-shadow",
      );
      expect(never?.status, stage).toBe("FAIL");
      expect(never?.evidence.join(" "), stage).toContain("SKIPPED-STAGE");
    }
  });

  test("a WRONG-STAGE landing (a pre-differentially-evaluated stage) FAILs", () => {
    const verdict = deriveShadowStageDiscipline({
      priorWalk: ["offline-replayed", "differentially-evaluated"],
      appendedTransitions: [
        {
          proposalId: row.sourceProposalId,
          toStage: "property-tested",
          evidenceDigest: longitudinalDigestOf(["evidence", "property-tested"]),
          ordinal: 3,
        },
      ],
      expectedLanding: true,
    });
    expect(verdict.disciplined).toBe(false);
    expect(verdict.wrongStageLandings).toEqual(["property-tested"]);
    const landing = verdict.criteria.find(
      (criterion) => criterion.criterionId === "stage-discipline-landing-is-shadow-stage",
    );
    expect(landing?.status).toBe("FAIL");
    expect(landing?.evidence.join(" ")).toContain("WRONG-STAGE-LANDING");
  });

  test("an EVIDENCE-LESS transition FAILs (a landing without its evidence digest)", () => {
    const verdict = deriveShadowStageDiscipline({
      priorWalk: ["offline-replayed", "differentially-evaluated"],
      appendedTransitions: [{ ...honestShadowAppend, evidenceDigest: "" }],
      expectedLanding: true,
    });
    expect(verdict.disciplined).toBe(false);
    expect(verdict.evidenceLessOrdinals).toEqual([3]);
    const evidenced = verdict.criteria.find(
      (criterion) => criterion.criterionId === "stage-discipline-every-transition-evidenced",
    );
    expect(evidenced?.status).toBe("FAIL");
    expect(evidenced?.evidence.join(" ")).toContain("EVIDENCE-LESS-TRANSITION");
  });

  test("a PREMATURE candidate (the walk never reached differentially-evaluated) FAILs", () => {
    const verdict = deriveShadowStageDiscipline({
      priorWalk: ["offline-replayed"],
      appendedTransitions: [honestShadowAppend],
      expectedLanding: true,
    });
    expect(verdict.disciplined).toBe(false);
    const source = verdict.criteria.find(
      (criterion) => criterion.criterionId === "stage-discipline-source-differentially-evaluated",
    );
    expect(source?.status).toBe("FAIL");
    expect(source?.evidence.join(" ")).toContain("PREMATURE-SHADOW");
    // The refusal honesty leg: a premature shadow refuses honestly.
    const refusal = deriveShadowRefusalHonesty({
      refusal: { reason: "candidate-not-differentially-evaluated" },
      comparisonEmitted: false,
      registryEntry: {
        lifecycleStage: "proposed",
        walkEndsAtDifferentiallyEvaluated: false,
      },
    });
    expect(refusal.honest).toBe(true);
    expect(refusal.justified).toBe(true);
  });

  test("a LANDING mismatch (nothing appended when a landing was expected) FAILs", () => {
    const verdict = deriveShadowStageDiscipline({
      priorWalk: ["offline-replayed", "differentially-evaluated"],
      appendedTransitions: [],
      expectedLanding: true,
    });
    expect(verdict.disciplined).toBe(false);
    const landing = verdict.criteria.find(
      (criterion) => criterion.criterionId === "stage-discipline-landing",
    );
    expect(landing?.status).toBe("FAIL");
    expect(landing?.evidence.join(" ")).toContain("LANDING-MISMATCH");
  });

  test("a REGISTRY REWRITE (mutating a candidate's own entry) FAILs the read-only discipline", async () => {
    const clock = createTickClock();
    const registry = createCandidateRegistry();
    const digestBefore = registry.digest();
    const stack = {
      servingPath: createServingPath(),
      shadowLedger: createShadowLedger(),
    };
    const result = await driveShadowRun({
      row: rowById("probe-skipped-stage"),
      registry,
      lifecycle: createLifecycleLedger({ variant: "rewrite-registry", registry }),
      shadowLedger: stack.shadowLedger,
      incumbentExecutor: createIncumbentExecutor(),
      trafficSource: createTrafficSource(),
      servingPath: stack.servingPath,
      shadowRuntime: createShadowRuntime(),
      now: clock.now,
    });
    expect(result.terminal).toBe("FAILED");
    // The verdict itself was honest — the rewrite happened at the
    // append: the registry's frozen digest CHANGED.
    expect(result.servingIsolation?.isolated).toBe(true);
    expect(registry.digest()).not.toBe(digestBefore);
    const readonly = result.criteria.find(
      (criterion) => criterion.criterionId === "registry-read-only",
    );
    expect(readonly?.status).toBe("FAIL");
    expect(readonly?.evidence.join(" ")).toContain("REGISTRY-MUTATION");
  });
});

// ---------------------------------------------------------------------------
// Family 6: the containment escape mid-shadow (the carry-over catch)
// ---------------------------------------------------------------------------

describe("VAL-034 discrimination: the containment escape mid-shadow", () => {
  const declared = ["pure-computation", "granted-fixture-read"];
  const granted = ["pure-computation", "granted-fixture-read"];

  test("EACH escape direction is a containment VIOLATION that FAILs and names the direction", () => {
    for (const direction of ISOLATION_ESCAPE_DIRECTIONS) {
      // The PURE isolation derivation over the escape.
      const verdict: ReplacementIsolationVerdict = deriveReplacementIsolation({
        declaredCapabilities: declared,
        grantedSurface: granted,
        exercisedCapabilities: [...declared, direction],
      });
      expect(verdict.contained, direction).toBe(false);
      expect(verdict.containment, direction).toBe("violation");
      expect(verdict.escapeDirections, direction).toEqual([direction]);
      const escapeLeg = verdict.criteria.find(
        (criterion) => criterion.criterionId === "isolation-no-escape",
      );
      expect(escapeLeg?.status, direction).toBe("FAIL");
      expect(escapeLeg?.evidence.join(" "), direction).toContain("CONTAINMENT-VIOLATION");
      expect(escapeLeg?.evidence.join(" "), direction).toContain(direction);
      // The shadow verdict kind ranks the mid-shadow escape as a
      // containment violation (never a passable outcome).
      expect(
        deriveShadowVerdictKind({
          refusal: null,
          isolation: verdict,
          servingIsolation: null,
          populationCompleteness: null,
          regressionHonesty: null,
          costSeparation: null,
        }),
        direction,
      ).toBe("containment-violation");
    }
  });

  test("the CONTAINED control passes (within surface, within declaration)", () => {
    const verdict = deriveReplacementIsolation({
      declaredCapabilities: declared,
      grantedSurface: granted,
      exercisedCapabilities: declared,
    });
    expect(verdict.contained).toBe(true);
    expect(verdict.containment).toBe("contained");
    expect(verdict.escapeDirections).toEqual([]);
    for (const criterion of verdict.criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
    // An empty surface with an empty exercise is contained (the
    // removed-call shape).
    const empty = deriveReplacementIsolation({
      declaredCapabilities: [],
      grantedSurface: [],
      exercisedCapabilities: [],
    });
    expect(empty.contained).toBe(true);
  });

  test("an ESCAPING shadow runtime (network access mid-shadow) never lands its transition", async () => {
    const clock = createTickClock();
    const registry = createCandidateRegistry();
    const servingPath = createServingPath();
    const lifecycle = createLifecycleLedger();
    const result = await driveShadowRun({
      row: rowById("probe-mid-shadow-escape"),
      registry,
      lifecycle,
      shadowLedger: createShadowLedger(),
      incumbentExecutor: createIncumbentExecutor(),
      trafficSource: createTrafficSource(),
      servingPath,
      shadowRuntime: createShadowRuntime({ variant: "escaping" }),
      now: clock.now,
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("containment-violation");
    expect(result.isolation?.escapeDirections).toEqual(["network-access"]);
    expect(result.ledgerLanding).toBeNull();
    expect(lifecycle.landedProposalIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The honest controls: verdict kinds, refusal honesty, digest determinism
// ---------------------------------------------------------------------------

describe("VAL-034 discrimination: the honest controls", () => {
  test("the verdict-kind derivation orders its failure modes honestly", () => {
    const agreementRow = rowById("rag-deterministic-function-shadow-agreement");
    const divergenceRow = rowById("reuse-removed-call-shadow-honest-divergence");
    const { regression: agreementRegression } = pinnedShadowRunOf(agreementRow);
    const { regression: divergenceRegression } = pinnedShadowRunOf(divergenceRow);
    const isolated = deriveServingIsolation({
      population: agreementRow.trafficPopulation,
      incumbentOutcomes: incumbentOutcomesOf(agreementRow),
      shadowOutcomes: honestShadowOutcomesOf(agreementRow),
      servedOutcomes: honestServedOutcomesOf(agreementRow),
    });
    const complete = deriveShadowPopulationCompleteness({
      recordedCaseIds: agreementRow.trafficPopulation.map((tcase) => tcase.caseId),
      workloadClassByCaseId: agreementRow.trafficWorkloadClasses,
      observedCaseIds: agreementRow.trafficPopulation.map((tcase) => tcase.caseId),
    });
    const separated = deriveShadowCostSeparation({
      incumbentCostMicroUsd: 10,
      shadowCostMicroUsd: 5,
      servedTotalMicroUsd: 10,
      shadowLedgerBookedMicroUsd: 5,
    });
    // A refusal always wins (the honest refusal).
    expect(
      deriveShadowVerdictKind({
        refusal: { reason: "candidate-unregistered" },
        isolation: null,
        servingIsolation: isolated,
        populationCompleteness: complete,
        regressionHonesty: divergenceRegression,
        costSeparation: separated,
      }),
    ).toBe("honest-refusal");
    // A containment violation beats the mechanical legs.
    expect(
      deriveShadowVerdictKind({
        refusal: null,
        isolation: {
          contained: false,
          containment: "violation",
          declaredNotGranted: [],
          undeclaredExercises: ["network-access"],
          escapeDirections: ["network-access"],
          criteria: [],
        },
        servingIsolation: isolated,
        populationCompleteness: complete,
        regressionHonesty: agreementRegression,
        costSeparation: separated,
      }),
    ).toBe("containment-violation");
    // A missing leg or an untrustworthy shape is shadow-invalid.
    expect(
      deriveShadowVerdictKind({
        refusal: null,
        isolation: null,
        servingIsolation: null,
        populationCompleteness: null,
        regressionHonesty: null,
        costSeparation: null,
      }),
    ).toBe("shadow-invalid");
    expect(
      deriveShadowVerdictKind({
        refusal: null,
        isolation: null,
        servingIsolation: { ...isolated, isolated: false },
        populationCompleteness: complete,
        regressionHonesty: agreementRegression,
        costSeparation: separated,
      }),
    ).toBe("shadow-invalid");
    expect(
      deriveShadowVerdictKind({
        refusal: null,
        isolation: null,
        servingIsolation: isolated,
        populationCompleteness: { ...complete, complete: false },
        regressionHonesty: agreementRegression,
        costSeparation: separated,
      }),
    ).toBe("shadow-invalid");
    expect(
      deriveShadowVerdictKind({
        refusal: null,
        isolation: null,
        servingIsolation: isolated,
        populationCompleteness: complete,
        regressionHonesty: { ...agreementRegression, honest: false },
        costSeparation: separated,
      }),
    ).toBe("shadow-invalid");
    expect(
      deriveShadowVerdictKind({
        refusal: null,
        isolation: null,
        servingIsolation: isolated,
        populationCompleteness: complete,
        regressionHonesty: agreementRegression,
        costSeparation: { ...separated, separated: false },
      }),
    ).toBe("shadow-invalid");
    // The honest terminal kinds.
    expect(
      deriveShadowVerdictKind({
        refusal: null,
        isolation: null,
        servingIsolation: isolated,
        populationCompleteness: complete,
        regressionHonesty: divergenceRegression,
        costSeparation: separated,
      }),
    ).toBe("honest-divergence");
    expect(
      deriveShadowVerdictKind({
        refusal: null,
        isolation: null,
        servingIsolation: isolated,
        populationCompleteness: complete,
        regressionHonesty: agreementRegression,
        costSeparation: separated,
      }),
    ).toBe("shadow-agreement");
  });

  test("the refusal honesty (justified, unjustified, malformed)", () => {
    // An unregistered candidate justifies the unregistered refusal.
    expect(
      deriveShadowRefusalHonesty({
        refusal: { reason: "candidate-unregistered" },
        comparisonEmitted: false,
        registryEntry: null,
      }).honest,
    ).toBe(true);
    // A registered, differentially-evaluated candidate hides behind NO
    // honest refusal — both refusal reasons are UNJUSTIFIED.
    const shadowable = {
      lifecycleStage: "differentially-evaluated" as const,
      walkEndsAtDifferentiallyEvaluated: true,
    };
    const reasons = ["candidate-unregistered", "candidate-not-differentially-evaluated"] as const;
    for (const reason of reasons) {
      const verdict = deriveShadowRefusalHonesty({
        refusal: { reason },
        comparisonEmitted: false,
        registryEntry: shadowable,
      });
      expect(verdict.honest).toBe(false);
      expect(verdict.justified).toBe(false);
      const justified = verdict.criteria.find(
        (criterion) => criterion.criterionId === "refusal-justified",
      );
      expect(justified?.status).toBe("FAIL");
      expect(justified?.evidence.join(" ")).toContain("UNJUSTIFIED-REFUSAL");
    }
    // A refusal accompanied by a comparison is a malformed outcome.
    const malformed = deriveShadowRefusalHonesty({
      refusal: { reason: "candidate-unregistered" },
      comparisonEmitted: true,
      registryEntry: null,
    });
    expect(malformed.honest).toBe(false);
    const wellFormed = malformed.criteria.find(
      (criterion) => criterion.criterionId === "refusal-well-formed",
    );
    expect(wellFormed?.status).toBe("FAIL");
    expect(wellFormed?.evidence.join(" ")).toContain("MALFORMED-OUTCOME");
  });

  test("the honest shadow run is deterministic and mechanical (never smoothed claims)", () => {
    const row = rowById("rag-deterministic-function-shadow-agreement");
    const run = deriveHonestShadowRun({
      sourceProposalId: row.sourceProposalId,
      replacementShape: row.replacementShape,
      declaredCapabilities: row.declaredCapabilities,
      acceptanceCriterion: row.acceptanceCriterion,
      trafficPopulation: row.trafficPopulation,
    });
    const again = deriveHonestShadowRun({
      sourceProposalId: row.sourceProposalId,
      replacementShape: row.replacementShape,
      declaredCapabilities: row.declaredCapabilities,
      acceptanceCriterion: row.acceptanceCriterion,
      trafficPopulation: row.trafficPopulation,
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(run));
    // The compared surface is the FULL population; the citation is the
    // source proposal; the exercised capabilities are the declaration.
    expect(run.comparedCaseIds).toEqual(row.trafficPopulation.map((tcase) => tcase.caseId));
    expect(run.citedProposalId).toBe(row.sourceProposalId);
    expect(run.exercisedCapabilities).toEqual([...row.declaredCapabilities]);
    // Every claim is the MECHANICAL criterion evaluation and the
    // asserted aggregate is the mechanical count.
    expect(run.aggregateClaim).toEqual({
      assertedAgreement: true,
      assertedDivergenceCount: 0,
    });
    // The shadow cost is the reference measurement (booked apart).
    expect(run.shadowCost).toEqual({
      microUsd: 2 * row.trafficPopulation.length + 1,
      latencyMs: 4 * row.trafficPopulation.length + 2,
    });
  });

  test("the digest + identity derivations are deterministic, canonical and discriminating", () => {
    const row = rowById("rag-deterministic-function-shadow-agreement");
    const first = row.trafficPopulation[0];
    if (first === undefined) {
      throw new Error("the RAG traffic population is empty");
    }
    // Case digests: deterministic, discriminating, order-independent
    // over the class members.
    expect(shadowTrafficCaseDigestOf(first)).toBe(shadowTrafficCaseDigestOf(first));
    expect(shadowTrafficCaseDigestOf({ ...first, caseId: `${first.caseId}-x` })).not.toBe(
      shadowTrafficCaseDigestOf(first),
    );
    expect(
      shadowTrafficCaseDigestOf({ ...first, classDigests: [...first.classDigests].reverse() }),
    ).toBe(shadowTrafficCaseDigestOf(first));
    // Population digests are order-independent and discriminating.
    expect(shadowPopulationDigestOf(row.trafficPopulation)).toBe(
      shadowPopulationDigestOf([...row.trafficPopulation].reverse()),
    );
    expect(shadowPopulationDigestOf(row.trafficPopulation.slice(0, 1))).not.toBe(
      shadowPopulationDigestOf(row.trafficPopulation),
    );
    // Comparison / divergence / cost digests: deterministic and
    // discriminating (a changed digest or claim changes the digest).
    const comparison = {
      caseId: first.caseId,
      incumbentDigest: first.incumbentDigest,
      shadowDigest: first.inputDigest,
      agrees: true,
    };
    expect(shadowComparisonDigestOf(comparison)).toBe(shadowComparisonDigestOf(comparison));
    expect(shadowComparisonDigestOf({ ...comparison, agrees: false })).not.toBe(
      shadowComparisonDigestOf(comparison),
    );
    const divergence = {
      proposalId: row.sourceProposalId,
      caseId: first.caseId,
      incumbentDigest: first.incumbentDigest,
      shadowDigest: first.inputDigest,
    };
    expect(shadowDivergenceDigestOf(divergence)).toBe(shadowDivergenceDigestOf(divergence));
    expect(shadowDivergenceDigestOf({ ...divergence, shadowDigest: "00000000" })).not.toBe(
      shadowDivergenceDigestOf(divergence),
    );
    const cost = { proposalId: row.sourceProposalId, microUsd: 21, latencyMs: 42 };
    expect(shadowCostDigestOf(cost)).toBe(shadowCostDigestOf(cost));
    expect(shadowCostDigestOf({ ...cost, microUsd: 22 })).not.toBe(shadowCostDigestOf(cost));
    // The registry facts digest is deterministic and discriminating (a
    // rewritten candidate changes it).
    const registry = createCandidateRegistry();
    expect(registry.digest()).toBe(createCandidateRegistry().digest());
    const mutated = createCandidateRegistry();
    const entry = mutated.store().get(row.sourceProposalId);
    if (entry === undefined) {
      throw new Error(`the registry holds no pin for ${row.sourceProposalId}`);
    }
    mutated.store().set(row.sourceProposalId, { ...entry, lifecycleStage: "promoted" });
    expect(mutated.digest()).not.toBe(registry.digest());
    expect(shadowRegistryDigestOf(registry.facts())).toBe(registry.digest());
  });
});

// ---------------------------------------------------------------------------
// The app contract over the fake-world knobs (the boundary catch)
// ---------------------------------------------------------------------------

describe("VAL-034 discrimination: the app contract over the fake-world knobs", () => {
  type Knobs = {
    readonly terminal?: "COMPLETED" | "FAILED";
    readonly leaked?: boolean;
    readonly disguised?: boolean;
    readonly dropped?: boolean;
    readonly aggregateOnly?: boolean;
    readonly smoothed?: boolean;
    readonly billed?: boolean;
    readonly skipped?: boolean;
    readonly escaping?: boolean;
    readonly unmeasured?: boolean;
  };

  async function runAppWithKnobs(
    options: Knobs,
  ): Promise<Awaited<ReturnType<typeof runShadowExecutionApp>>> {
    const clock = createTickClock();
    const world = createShadowFakeApiWorld({
      clock,
      ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
      ...(options.leaked === true ? { leaked: true } : {}),
      ...(options.disguised === true ? { disguised: true } : {}),
      ...(options.dropped === true ? { dropped: true } : {}),
      ...(options.aggregateOnly === true ? { aggregateOnly: true } : {}),
      ...(options.smoothed === true ? { smoothed: true } : {}),
      ...(options.billed === true ? { billed: true } : {}),
      ...(options.skipped === true ? { skipped: true } : {}),
      ...(options.escaping === true ? { escaping: true } : {}),
      ...(options.unmeasured === true ? { unmeasured: true } : {}),
    });
    return runShadowExecutionApp({
      config: {
        applicationId: "app-1",
        baseUrl: "http://fake-zeck.local",
        tokenEnvVar: "ZECK_VALIDATION_TOKEN",
        applicationRevision: REVISION,
        corpusRevision: REVISION,
        integrationSurface: "sdk",
        pollIntervalMs: 1,
        completionTimeoutMs: 5_000,
      },
      token: "zeck-token-fake",
      transport: world.transport as TransportImplementation,
      now: clock.now,
      sleep: async (ms) => {
        clock.advance(ms);
      },
      environment: {
        runtime: "node test",
        toolchain: "vitest",
        database: "none",
        configuration: { suite: "val-034-discrimination" },
      },
      runSuffix: "discrimination",
      // The honest-divergence row: its shadow digests genuinely differ
      // from the incumbent's, so the leak shapes are visible at the
      // boundary read-back.
      taskIndex: taskIndexOf("reuse-removed-call-shadow-honest-divergence"),
    });
  }

  test("the honest world passes the boundary contract (the control)", async () => {
    const outcome = await runAppWithKnobs({});
    // The boundary re-derivation honestly FAILs the criterion leg (the
    // recorded divergence) — never a silent pass — while every other
    // boundary leg passes.
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(outcome.appCriteria.filter((criterion) => criterion.status === "FAIL")).toEqual([
      outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-regression-agreement-under-criterion",
      ),
    ]);
    expect(outcome.verdict?.kind).toBe("honest-divergence");
    expect(outcome.lifecycleLanding?.finalStage).toBe(SHADOW_STAGE);
  });

  test("EVERY fake-world knob FAILs a specific boundary criterion (never a silent pass)", async () => {
    const knobToCriterion: readonly { readonly knob: Knobs; readonly criterionId: string }[] = [
      { knob: { terminal: "COMPLETED" }, criterionId: "app-expected-terminal" },
      { knob: { leaked: true }, criterionId: "app-serving-source-pinned-incumbent" },
      { knob: { disguised: true }, criterionId: "app-serving-digest-is-incumbents" },
      { knob: { dropped: true }, criterionId: "app-regression-per-case-evidence" },
      { knob: { aggregateOnly: true }, criterionId: "app-comparisons-readable" },
      { knob: { smoothed: true }, criterionId: "app-regression-no-smoothing" },
      { knob: { billed: true }, criterionId: "app-cost-served-excludes-shadow" },
      { knob: { skipped: true }, criterionId: "app-lifecycle-landing-shadow-stage-only" },
      { knob: { escaping: true }, criterionId: "app-verdict-kind-pinned" },
      { knob: { unmeasured: true }, criterionId: "app-cost-shadow-measured" },
    ];
    for (const { knob, criterionId } of knobToCriterion) {
      const outcome = await runAppWithKnobs(knob);
      expect(outcome.passed, criterionId).toBe(false);
      const criterion = outcome.appCriteria.find((c) => c.criterionId === criterionId);
      expect(criterion, criterionId).toBeDefined();
      expect(criterion?.status, criterionId).toBe("FAIL");
    }
  });
});

// ---------------------------------------------------------------------------
// The shadow ledger exactly-once + the honest fixture control
// ---------------------------------------------------------------------------

describe("VAL-034 discrimination: the ledger exactly-once and the honest control", () => {
  test("the shadow ledger is append-only exactly-once (divergences + cost bookings)", async () => {
    const ledger = createShadowLedger();
    const divergence = {
      proposalId: "cand-learning-discovery-aaaaaaaa",
      caseId: "exp-workload-replay-11111111",
      incumbentDigest: "11111111",
      shadowDigest: "22222222",
    };
    const first = await ledger.appendDivergence(divergence);
    expect(first).toEqual({ accepted: true, replayed: false, refused: false });
    // The IDENTICAL re-append REPLAYS (idempotent — exactly-once).
    const second = await ledger.appendDivergence(divergence);
    expect(second).toEqual({ accepted: true, replayed: true, refused: false });
    expect(ledger.divergencesFor(divergence.proposalId)).toHaveLength(1);
    // A DIFFERENT record under the recorded (proposalId, caseId) key is
    // REFUSED (the divergence record is immutable).
    const impostor = await ledger.appendDivergence({
      ...divergence,
      shadowDigest: "33333333",
    });
    expect(impostor).toEqual({ accepted: false, replayed: false, refused: true });
    expect(ledger.divergencesFor(divergence.proposalId)).toHaveLength(1);

    // The cost booking rides the same exactly-once discipline.
    const cost = { proposalId: divergence.proposalId, microUsd: 21, latencyMs: 42 };
    const booked = await ledger.bookShadowCost(cost);
    expect(booked).toEqual({ accepted: true, replayed: false, refused: false });
    const rebooked = await ledger.bookShadowCost(cost);
    expect(rebooked).toEqual({ accepted: true, replayed: true, refused: false });
    const misbooked = await ledger.bookShadowCost({ ...cost, microUsd: 22 });
    expect(misbooked).toEqual({ accepted: false, replayed: false, refused: true });
    expect(ledger.costsFor(divergence.proposalId)).toHaveLength(1);
    expect(ledger.divergenceProposalIds).toEqual([divergence.proposalId]);
  });

  test("the honest control: every offline row's shadow run behaves per its pin over the fixture stack", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const stack = createHonestShadowStack();
      const result = await driveShadowRun({
        row,
        registry: stack.registry,
        lifecycle: stack.lifecycle,
        shadowLedger: stack.shadowLedger,
        incumbentExecutor: stack.incumbentExecutor,
        trafficSource: stack.trafficSource,
        servingPath: stack.servingPath,
        shadowRuntime: stack.shadowRuntime,
        now: stack.clock.now,
      });
      expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
      if (row.expected.verdict === "honest-divergence") {
        // The honest divergence FAILs its criterion leg honestly — the
        // divergence is recorded case-by-case, never smoothed — while
        // every OTHER leg passes.
        expect(
          result.criteria.find((c) => c.criterionId === "regression-agreement-under-criterion")
            ?.status,
          `${row.rowId} criterion satisfied`,
        ).toBe("FAIL");
        expect(
          result.criteria.find((c) => c.criterionId === "regression-no-smoothing")?.status,
          `${row.rowId} honesty`,
        ).toBe("PASS");
      } else {
        const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
        expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      }
      expect(result.verdict, `${row.rowId} verdict`).toBe(row.expected.verdict);
      expect(result.observedModelCalls, `${row.rowId} own dispatches`).toBe(
        row.expected.modelCalls,
      );
      expect(result.usage, `${row.rowId} offline usage none-reported`).toBeNull();
      expect(result.latencyMs, `${row.rowId} latency measured`).toBeGreaterThanOrEqual(0);
    }
  });

  test("the honest control's registry facts view mirrors the pinned registry membership", () => {
    const registry = createCandidateRegistry();
    const facts = registry.facts();
    expect(facts.proposals.map((proposal) => proposal.proposalId).sort()).toEqual(
      PINNED_REGISTRY_ENTRIES.map((entry) => entry.proposalId).sort(),
    );
    // Every pinned member sits at the proposed stage (the read-only
    // input the shadow slice appends FROM); zero applied candidates.
    for (const proposal of facts.proposals) {
      expect(proposal.lifecycleStage).toBe("proposed");
    }
    expect(facts.appliedCandidateCount).toBe(0);
    expect(shadowRegistryDigestOf(facts)).toBe(registry.digest());
  });
});
