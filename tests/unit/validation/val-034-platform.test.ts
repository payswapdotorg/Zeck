/**
 * VAL-034 acceptance criteria 1, 2, 4, 5: the shadow-execution
 * platform slice against controlled fakes — the shadow vocabulary
 * (the observation-only mode; the served-source pin; the shadow /
 * refusal / probe vocabularies; the lifecycle ladder's shadow walk),
 * the PURE derivations that make a regression comparison trustworthy
 * (the serving-isolation matrix — an incumbent-served pass and each
 * leak shape FAILing; the population-completeness matrix — a full pass
 * and the dropped / duplicated / foreign / mix-mismatch shapes each
 * FAILing; the regression-honesty matrix — a per-case pass, an honest
 * divergence recorded case-by-case, and the aggregate-only /
 * subset-agreement / smoothed / false-divergence shapes each FAILing;
 * the cost-separation matrix — a separated pass and each
 * double-booking shape FAILing; the stage-discipline matrix — the
 * evidenced walk passing while a skipped stage, a wrong-stage landing,
 * an evidence-less transition and a premature candidate each FAIL),
 * the containment carry-over (an escape mid-shadow FAILs), the digest
 * discipline (deterministic, canonical, payload-free), the identity
 * determinism, the append-only ledgers, and the driver over every
 * offline corpus row — including the ADVERSARIAL worlds: the
 * ESCAPING/AGGREGATE-ONLY/SUBSET-COMPARED/SMOOTHING/UNMEASURED shadow
 * runtimes, the LEAKY/DISGUISED serving paths, the
 * DROPPED/DUPLICATED/MIXED-UP traffic sources, the
 * SKIP-TO-CANARIED/WRONG-STAGE/EVIDENCE-LESS/REWRITE-REGISTRY
 * lifecycle ledgers, the DOUBLE-BOOKING shadow cost ledger, the
 * DIVERGENT incumbent executor and the dispatch seam contract.
 */

import { describe, expect, test } from "vitest";
import {
  OFFLINE_CORPUS_ROWS,
  PINNED_REGISTRY_ENTRIES,
  pinnedShadowRunOf,
  priorWalkOf,
  SHADOW_EXECUTION_CORPUS,
} from "../../../benchmarks/validation/apps/shadow-execution/corpus";
import {
  createCandidateRegistry,
  createIncumbentExecutor,
  createLifecycleLedger,
  createServingPath,
  createShadowLedger,
  createShadowRuntime,
  createTickClock,
  createTrafficSource,
  type FakeLifecycleVariant,
  type FakeServingPathVariant,
  type FakeShadowLedgerVariant,
  type FakeShadowRuntimeVariant,
  type FakeTrafficSourceVariant,
} from "../../../benchmarks/validation/apps/shadow-execution/fixtures";
import {
  deriveReplacementIsolation,
  ISOLATION_ESCAPE_DIRECTIONS,
} from "../../../benchmarks/validation/platform/equivalence-testing";
import type { ControlDispatch } from "../../../benchmarks/validation/platform/longitudinal-baseline";
import {
  longitudinalDigestOf,
  trajectoryDigestOf,
} from "../../../benchmarks/validation/platform/longitudinal-baseline";
import type {
  LifecycleTransitionRecord,
  ShadowCaseOutcome,
  ShadowCorpusRow,
  ShadowRunResult,
  ShadowTrafficCase,
} from "../../../benchmarks/validation/platform/shadow-execution";
import {
  deriveRegressionHonesty,
  deriveServingIsolation,
  deriveShadowCostSeparation,
  deriveShadowPopulationCompleteness,
  deriveShadowRefusalHonesty,
  deriveShadowStageDiscipline,
  deriveShadowVerdictKind,
  driveShadowRun,
  isBeyondShadowScope,
  isServedSource,
  isShadowMode,
  isShadowProbeKind,
  isShadowRefusalReason,
  isShadowVerdictKind,
  lifecycleStageIndexOf,
  referenceShadowMeasurementOf,
  SERVED_SOURCE_PIN,
  SERVED_SOURCE_VALUES,
  SHADOW_EXPERIMENT_KIND,
  SHADOW_LEARNING_PHASE,
  SHADOW_MODES,
  SHADOW_PROBE_KINDS,
  SHADOW_REFUSAL_REASONS,
  SHADOW_SOURCE_STAGE,
  SHADOW_STAGE,
  SHADOW_VERDICTS,
  shadowComparisonDigestOf,
  shadowCostDigestOf,
  shadowDivergenceDigestOf,
  shadowPopulationDigestOf,
  shadowTrafficCaseDigestOf,
  shadowTrajectoryStepsOf,
} from "../../../benchmarks/validation/platform/shadow-execution";

const rowById = (rowId: string): ShadowCorpusRow => {
  const row = SHADOW_EXECUTION_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

/** Drive one offline row over a purpose-built fake stack. */
async function driveRowOverStack(options: {
  readonly row: ShadowCorpusRow;
  readonly runtimeVariant?: FakeShadowRuntimeVariant;
  readonly ledgerVariant?: FakeLifecycleVariant;
  readonly trafficVariant?: FakeTrafficSourceVariant;
  readonly servingVariant?: FakeServingPathVariant;
  readonly costLedgerVariant?: FakeShadowLedgerVariant;
  readonly divergentIncumbent?: boolean;
  readonly dispatch?: ControlDispatch;
}): Promise<ShadowRunResult> {
  const clock = createTickClock();
  const registry = createCandidateRegistry();
  const servingPath = createServingPath({
    ...(options.servingVariant === undefined ? {} : { variant: options.servingVariant }),
  });
  const lifecycle = createLifecycleLedger({
    ...(options.ledgerVariant === undefined ? {} : { variant: options.ledgerVariant }),
    registry,
  });
  const shadowLedger = createShadowLedger({
    ...(options.costLedgerVariant === undefined ? {} : { variant: options.costLedgerVariant }),
    servingPath,
  });
  return driveShadowRun({
    row: options.row,
    registry,
    lifecycle,
    shadowLedger,
    incumbentExecutor: createIncumbentExecutor({
      ...(options.divergentIncumbent === true ? { variant: "divergent" } : {}),
    }),
    trafficSource: createTrafficSource({
      ...(options.trafficVariant === undefined ? {} : { variant: options.trafficVariant }),
    }),
    servingPath,
    shadowRuntime: createShadowRuntime({
      ...(options.runtimeVariant === undefined ? {} : { variant: options.runtimeVariant }),
    }),
    ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
    now: clock.now,
  });
}

/** A synthetic three-case traffic population with single-member classes. */
const syntheticPopulation: readonly ShadowTrafficCase[] = [
  {
    caseId: "exp-workload-replay-aaaaaaaa",
    source: "historical-replay",
    sourceRef: "exp-workload-replay-aaaaaaaa",
    inputDigest: "11111111",
    incumbentDigest: "aaaa1111",
    classDigests: ["aaaa1111"],
  },
  {
    caseId: "exp-workload-replay-bbbbbbbb",
    source: "historical-replay",
    sourceRef: "exp-workload-replay-bbbbbbbb",
    inputDigest: "22222222",
    incumbentDigest: "bbbb1111",
    classDigests: ["bbbb1111", "bbbb2222"],
  },
  {
    caseId: "injected-probe-cccc",
    source: "adversarial",
    sourceRef: "injected-probe-cccc",
    inputDigest: "33333333",
    incumbentDigest: "cccc1111",
    classDigests: ["cccc1111"],
  },
];

const syntheticClasses: Readonly<Record<string, string>> = {
  "exp-workload-replay-aaaaaaaa": "workload-a",
  "exp-workload-replay-bbbbbbbb": "workload-b",
  "injected-probe-cccc": "injected-probe",
};

const syntheticIncumbent: readonly ShadowCaseOutcome[] = syntheticPopulation.map((tcase) => ({
  caseId: tcase.caseId,
  digest: tcase.incumbentDigest,
}));

// ---------------------------------------------------------------------------
// The vocabulary + the lifecycle ladder
// ---------------------------------------------------------------------------

describe("VAL-034 platform vocabulary", () => {
  test("the shadow vocabulary is pinned (shadows observe and record, never serve or promote)", () => {
    expect(SHADOW_LEARNING_PHASE).toBe("shadow");
    expect(SHADOW_EXPERIMENT_KIND).toBe("shadow-execution");
    expect(SHADOW_MODES).toEqual(["observation-only"]);
    expect(isShadowMode("observation-only")).toBe(true);
    expect(isShadowMode("serving-shadow")).toBe(false);
  });

  test("the served-source pin is ALWAYS the incumbent (a replacement serve is a leak, not a mode)", () => {
    expect(SERVED_SOURCE_PIN).toBe("incumbent");
    expect(SERVED_SOURCE_VALUES).toEqual(["incumbent", "replacement"]);
    expect(isServedSource("incumbent")).toBe(true);
    expect(isServedSource("replacement")).toBe(true);
    expect(isServedSource("shadow")).toBe(false);
  });

  test("the verdict / refusal / probe vocabularies are pinned", () => {
    expect(SHADOW_VERDICTS).toEqual([
      "shadow-agreement",
      "honest-divergence",
      "containment-violation",
      "honest-refusal",
      "shadow-invalid",
    ]);
    for (const kind of SHADOW_VERDICTS) {
      expect(isShadowVerdictKind(kind)).toBe(true);
    }
    expect(isShadowVerdictKind("shadow-promotion")).toBe(false);
    expect(SHADOW_REFUSAL_REASONS).toEqual([
      "candidate-unregistered",
      "candidate-not-differentially-evaluated",
    ]);
    for (const reason of SHADOW_REFUSAL_REASONS) {
      expect(isShadowRefusalReason(reason)).toBe(true);
    }
    expect(SHADOW_PROBE_KINDS).toEqual([
      "leaked-outcome",
      "dropped-case",
      "smoothed-aggregate",
      "billed-shadow",
      "skipped-stage",
      "mid-shadow-escape",
    ]);
    for (const kind of SHADOW_PROBE_KINDS) {
      expect(isShadowProbeKind(kind)).toBe(true);
    }
    expect(isShadowProbeKind("empty-traffic")).toBe(false);
  });

  test("the lifecycle ladder is pinned (the shadow slice appends shadow-executed ONLY)", () => {
    expect(SHADOW_STAGE).toBe("shadow-executed");
    expect(SHADOW_SOURCE_STAGE).toBe("differentially-evaluated");
    expect(lifecycleStageIndexOf("differentially-evaluated")).toBe(4);
    expect(lifecycleStageIndexOf(SHADOW_STAGE)).toBe(7);
    expect(isBeyondShadowScope("shadow-executed")).toBe(false);
    for (const stage of ["canaried", "promoted"]) {
      expect(isBeyondShadowScope(stage as never)).toBe(true);
    }
  });

  test("the pinned corpus declares 13 offline rows + 1 live row with every probe vocabulary member", () => {
    expect(OFFLINE_CORPUS_ROWS).toHaveLength(13);
    expect(SHADOW_EXECUTION_CORPUS).toHaveLength(14);
    expect(SHADOW_EXECUTION_CORPUS.filter((row) => row.needsDispatch)).toHaveLength(1);
    for (const kind of SHADOW_PROBE_KINDS) {
      expect(SHADOW_EXECUTION_CORPUS.some((row) => row.probe?.kind === kind)).toBe(true);
    }
    expect(PINNED_REGISTRY_ENTRIES.length).toBeGreaterThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------
// Serving isolation (the served outcome is ALWAYS the incumbent's)
// ---------------------------------------------------------------------------

describe("VAL-034 deriveServingIsolation", () => {
  const shadowOutcomes: readonly ShadowCaseOutcome[] = [
    { caseId: syntheticPopulation[0]?.caseId ?? "", digest: "aaaa9999" },
    { caseId: syntheticPopulation[1]?.caseId ?? "", digest: "bbbb1111" },
    { caseId: syntheticPopulation[2]?.caseId ?? "", digest: "cccc1111" },
  ];

  test("an incumbent-served population is ISOLATED (the shadow is observation-only)", () => {
    const verdict = deriveServingIsolation({
      population: syntheticPopulation,
      incumbentOutcomes: syntheticIncumbent,
      shadowOutcomes,
      servedOutcomes: syntheticPopulation.map((tcase, index) => ({
        caseId: tcase.caseId,
        servedSource: "incumbent",
        servedDigest: syntheticIncumbent[index]?.digest ?? "",
      })),
    });
    expect(verdict.isolated).toBe(true);
    expect(verdict.leakKind).toBeNull();
    expect(verdict.leakedCaseIds).toEqual([]);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("an EXPLICIT leak (the replacement's outcome served) FAILs with the leak named", () => {
    const verdict = deriveServingIsolation({
      population: syntheticPopulation,
      incumbentOutcomes: syntheticIncumbent,
      shadowOutcomes,
      servedOutcomes: syntheticPopulation.map((tcase, index) => ({
        caseId: tcase.caseId,
        servedSource: index === 0 ? "replacement" : "incumbent",
        servedDigest: index === 0 ? "aaaa9999" : (syntheticIncumbent[index]?.digest ?? ""),
      })),
    });
    expect(verdict.isolated).toBe(false);
    expect(verdict.leakKind).toBe("explicit-leak");
    expect(verdict.leakedCaseIds).toEqual([syntheticPopulation[0]?.caseId]);
    const sourceLeg = verdict.criteria.find(
      (criterion) => criterion.criterionId === "serving-source-pinned-incumbent",
    );
    expect(sourceLeg?.status).toBe("FAIL");
    expect(sourceLeg?.evidence.join(" ")).toContain("LEAKED-SHADOW");
    expect(sourceLeg?.evidence.join(" ")).toContain(String(syntheticPopulation[0]?.caseId));
  });

  test("a DISGUISED leak (the shadow's digest served under the incumbent source) FAILs", () => {
    const verdict = deriveServingIsolation({
      population: syntheticPopulation,
      incumbentOutcomes: syntheticIncumbent,
      shadowOutcomes,
      servedOutcomes: syntheticPopulation.map((tcase, index) => ({
        caseId: tcase.caseId,
        servedSource: "incumbent",
        servedDigest: index === 0 ? "aaaa9999" : (syntheticIncumbent[index]?.digest ?? ""),
      })),
    });
    expect(verdict.isolated).toBe(false);
    expect(verdict.leakKind).toBe("disguised-leak");
    const digestLeg = verdict.criteria.find(
      (criterion) => criterion.criterionId === "serving-digest-is-incumbents",
    );
    expect(digestLeg?.status).toBe("FAIL");
    expect(digestLeg?.evidence.join(" ")).toContain("LEAKED-SHADOW-DISGUISED");
  });

  test("a WRONG serve (a digest that is neither side's) FAILs", () => {
    const verdict = deriveServingIsolation({
      population: syntheticPopulation,
      incumbentOutcomes: syntheticIncumbent,
      shadowOutcomes,
      servedOutcomes: syntheticPopulation.map((tcase, index) => ({
        caseId: tcase.caseId,
        servedSource: "incumbent",
        servedDigest: index === 1 ? "deadbeef" : (syntheticIncumbent[index]?.digest ?? ""),
      })),
    });
    expect(verdict.isolated).toBe(false);
    expect(verdict.leakKind).toBeNull();
    expect(verdict.wrongServeCaseIds).toEqual([syntheticPopulation[1]?.caseId]);
  });

  test("an UNSERVED traffic case FAILs (every case of the mix must be served)", () => {
    const verdict = deriveServingIsolation({
      population: syntheticPopulation,
      incumbentOutcomes: syntheticIncumbent,
      shadowOutcomes,
      servedOutcomes: syntheticPopulation.slice(0, 2).map((tcase, index) => ({
        caseId: tcase.caseId,
        servedSource: "incumbent",
        servedDigest: syntheticIncumbent[index]?.digest ?? "",
      })),
    });
    expect(verdict.isolated).toBe(false);
    expect(verdict.unservedCaseIds).toEqual([syntheticPopulation[2]?.caseId]);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "serving-every-case-served")
        ?.status,
    ).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// Shadow population completeness (the FULL recorded workload mix)
// ---------------------------------------------------------------------------

describe("VAL-034 deriveShadowPopulationCompleteness", () => {
  const recordedCaseIds = syntheticPopulation.map((tcase) => tcase.caseId);

  test("the full recorded mix passes (per-class counts identical)", () => {
    const verdict = deriveShadowPopulationCompleteness({
      recordedCaseIds,
      workloadClassByCaseId: syntheticClasses,
      observedCaseIds: recordedCaseIds,
    });
    expect(verdict.complete).toBe(true);
    expect(verdict.mixMatches).toBe(true);
    expect(verdict.recordedMix).toEqual([
      { workloadClass: "injected-probe", count: 1 },
      { workloadClass: "workload-a", count: 1 },
      { workloadClass: "workload-b", count: 1 },
    ]);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a DROPPED case FAILs with the case named", () => {
    const verdict = deriveShadowPopulationCompleteness({
      recordedCaseIds,
      workloadClassByCaseId: syntheticClasses,
      observedCaseIds: recordedCaseIds.slice(0, 2),
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.missingCaseIds).toEqual([recordedCaseIds[2]]);
    const dropped = verdict.criteria.find(
      (criterion) => criterion.criterionId === "population-no-dropped-case",
    );
    expect(dropped?.status).toBe("FAIL");
    expect(dropped?.evidence.join(" ")).toContain("DROPPED-CASE");
  });

  test("a DUPLICATED case FAILs (an inflated mix weight)", () => {
    const verdict = deriveShadowPopulationCompleteness({
      recordedCaseIds,
      workloadClassByCaseId: syntheticClasses,
      observedCaseIds: [recordedCaseIds[0] ?? "", ...recordedCaseIds],
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.duplicatedCaseIds.length).toBeGreaterThan(0);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "population-no-duplicated-case",
      )?.status,
    ).toBe("FAIL");
  });

  test("a FOREIGN case FAILs (a swapped population)", () => {
    const verdict = deriveShadowPopulationCompleteness({
      recordedCaseIds,
      workloadClassByCaseId: syntheticClasses,
      observedCaseIds: [...recordedCaseIds.slice(0, 2), "exp-workload-replay-zzzzzzzz"],
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.foreignCaseIds).toEqual(["exp-workload-replay-zzzzzzzz"]);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "population-no-foreign-case")
        ?.status,
    ).toBe("FAIL");
  });

  test("a MIX mismatch FAILs even when the total count matches", () => {
    // Two workload-a cases + no workload-b case: same total, wrong mix.
    const verdict = deriveShadowPopulationCompleteness({
      recordedCaseIds,
      workloadClassByCaseId: {
        ...syntheticClasses,
        "exp-workload-replay-zzzzzzzz": "workload-a",
      },
      observedCaseIds: [
        recordedCaseIds[0] ?? "",
        recordedCaseIds[2] ?? "",
        "exp-workload-replay-zzzzzzzz",
      ],
    });
    expect(verdict.missingCaseIds).toEqual([recordedCaseIds[1]]);
    expect(verdict.foreignCaseIds).toEqual(["exp-workload-replay-zzzzzzzz"]);
    expect(verdict.mixMatches).toBe(false);
    const mix = verdict.criteria.find(
      (criterion) => criterion.criterionId === "population-workload-mix-matches",
    );
    expect(mix?.status).toBe("FAIL");
    expect(mix?.evidence.join(" ")).toContain("MIX-MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// Regression honesty (per-case evidence, never smoothed aggregates)
// ---------------------------------------------------------------------------

describe("VAL-034 deriveRegressionHonesty", () => {
  const agreeingShadow: readonly (ShadowCaseOutcome & { claimedAgrees: boolean })[] =
    syntheticPopulation.map((tcase, index) => ({
      caseId: tcase.caseId,
      digest: index === 1 ? "bbbb2222" : (syntheticIncumbent[index]?.digest ?? ""), // class member on the two-member case
      claimedAgrees: true,
    }));
  const agreeingIncumbent = syntheticIncumbent;
  const criterion = { kind: "digest-class-equality" } as const;

  test("a per-case agreement over the full population is HONEST (class members agree)", () => {
    const verdict = deriveRegressionHonesty({
      population: syntheticPopulation,
      criterion,
      incumbentOutcomes: agreeingIncumbent,
      shadowOutcomes: agreeingShadow,
      comparedCaseIds: syntheticPopulation.map((tcase) => tcase.caseId),
      aggregateClaim: { assertedAgreement: true, assertedDivergenceCount: 0 },
    });
    expect(verdict.honest).toBe(true);
    expect(verdict.mechanicalDivergenceCaseIds).toEqual([]);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("an honest divergence is recorded case-by-case and FAILs the agreement leg honestly", () => {
    // Under EXACT equality the two-member case diverges — and the
    // honest runtime claims it as the divergence it is (never smoothed).
    const divergentShadow = agreeingShadow.map((outcome, index) =>
      index === 1 ? { ...outcome, claimedAgrees: false } : outcome,
    );
    const verdict = deriveRegressionHonesty({
      population: syntheticPopulation,
      criterion: { kind: "exact-digest-equality" },
      incumbentOutcomes: agreeingIncumbent,
      shadowOutcomes: divergentShadow,
      comparedCaseIds: syntheticPopulation.map((tcase) => tcase.caseId),
      aggregateClaim: { assertedAgreement: false, assertedDivergenceCount: 1 },
    });
    expect(verdict.mechanicalDivergenceCaseIds).toEqual([syntheticPopulation[1]?.caseId]);
    expect(verdict.honest).toBe(true);
    expect(verdict.smoothedCaseIds).toEqual([]);
    const agreement = verdict.criteria.find(
      (criterion) => criterion.criterionId === "regression-agreement-under-criterion",
    );
    expect(agreement?.status).toBe("FAIL");
    expect(agreement?.evidence.join(" ")).toContain("HONEST-DIVERGENCE");
  });

  test("an AGGREGATE-only claim (no per-case records) FAILs with the missing cases named", () => {
    const verdict = deriveRegressionHonesty({
      population: syntheticPopulation,
      criterion,
      incumbentOutcomes: agreeingIncumbent,
      shadowOutcomes: agreeingShadow,
      comparedCaseIds: [],
      aggregateClaim: { assertedAgreement: true, assertedDivergenceCount: 0 },
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.perCaseEvidenceComplete).toBe(false);
    expect(verdict.missingCaseIds).toHaveLength(3);
    const perCase = verdict.criteria.find(
      (criterion) => criterion.criterionId === "regression-per-case-evidence",
    );
    expect(perCase?.status).toBe("FAIL");
    expect(perCase?.evidence.join(" ")).toContain("AGGREGATE-ONLY");
  });

  test("an asserted agreement from a SUBSET of the population FAILs", () => {
    const verdict = deriveRegressionHonesty({
      population: syntheticPopulation,
      criterion,
      incumbentOutcomes: agreeingIncumbent,
      shadowOutcomes: agreeingShadow,
      comparedCaseIds: syntheticPopulation.slice(0, 2).map((tcase) => tcase.caseId),
      aggregateClaim: { assertedAgreement: true, assertedDivergenceCount: 0 },
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.missingCaseIds).toEqual([syntheticPopulation[2]?.caseId]);
    expect(verdict.perCaseEvidenceComplete).toBe(false);
  });

  test("a SMOOTHED divergence (a divergent case claimed agreeing) FAILs the honesty leg", () => {
    const verdict = deriveRegressionHonesty({
      population: syntheticPopulation,
      criterion: { kind: "exact-digest-equality" },
      incumbentOutcomes: agreeingIncumbent,
      shadowOutcomes: agreeingShadow.map((outcome, index) => {
        if (index === 0) {
          // The perturbed case diverges while the runtime CLAIMS agreement.
          return { ...outcome, digest: "deadbeef", claimedAgrees: true };
        }
        if (index === 1) {
          // The two-member case diverges under exact equality — claimed honestly.
          return { ...outcome, claimedAgrees: false };
        }
        return outcome;
      }),
      comparedCaseIds: syntheticPopulation.map((tcase) => tcase.caseId),
      aggregateClaim: { assertedAgreement: false, assertedDivergenceCount: 2 },
    });
    expect(verdict.mechanicalDivergenceCaseIds).toHaveLength(2);
    expect(verdict.smoothedCaseIds).toEqual([syntheticPopulation[0]?.caseId]);
    expect(verdict.honest).toBe(false);
    const smoothing = verdict.criteria.find(
      (criterion) => criterion.criterionId === "regression-no-smoothing",
    );
    expect(smoothing?.status).toBe("FAIL");
    expect(smoothing?.evidence.join(" ")).toContain("DIVERGENCE-SMOOTHING");
  });

  test("a FALSE divergence (an agreeing case claimed diverging) FAILs", () => {
    const verdict = deriveRegressionHonesty({
      population: syntheticPopulation,
      criterion,
      incumbentOutcomes: agreeingIncumbent,
      shadowOutcomes: agreeingShadow.map((outcome) => ({ ...outcome, claimedAgrees: false })),
      comparedCaseIds: syntheticPopulation.map((tcase) => tcase.caseId),
      aggregateClaim: { assertedAgreement: false, assertedDivergenceCount: 3 },
    });
    expect(verdict.falseDivergenceCaseIds).toHaveLength(3);
    expect(verdict.honest).toBe(false);
    const smoothing = verdict.criteria.find(
      (criterion) => criterion.criterionId === "regression-no-smoothing",
    );
    expect(smoothing?.evidence.join(" ")).toContain("FALSE-DIVERGENCE");
  });

  test("an aggregate that CONTRADICTS the per-case evidence FAILs", () => {
    const verdict = deriveRegressionHonesty({
      population: syntheticPopulation,
      criterion,
      incumbentOutcomes: agreeingIncumbent,
      shadowOutcomes: agreeingShadow,
      comparedCaseIds: syntheticPopulation.map((tcase) => tcase.caseId),
      aggregateClaim: { assertedAgreement: true, assertedDivergenceCount: 2 },
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.aggregateMatches).toBe(false);
    const aggregate = verdict.criteria.find(
      (criterion) => criterion.criterionId === "regression-aggregate-honest",
    );
    expect(aggregate?.status).toBe("FAIL");
    expect(aggregate?.evidence.join(" ")).toContain("AGGREGATE-CONTRADICTION");
  });

  test("an ABSENT aggregate and FABRICATED records each FAIL", () => {
    const absent = deriveRegressionHonesty({
      population: syntheticPopulation,
      criterion,
      incumbentOutcomes: agreeingIncumbent,
      shadowOutcomes: agreeingShadow,
      comparedCaseIds: syntheticPopulation.map((tcase) => tcase.caseId),
      aggregateClaim: null,
    });
    expect(absent.honest).toBe(false);
    expect(absent.aggregatePresent).toBe(false);
    expect(
      absent.criteria
        .find((criterion) => criterion.criterionId === "regression-aggregate-honest")
        ?.evidence.join(" "),
    ).toContain("ABSENT-AGGREGATE");

    const fabricated = deriveRegressionHonesty({
      population: syntheticPopulation,
      criterion,
      incumbentOutcomes: agreeingIncumbent,
      shadowOutcomes: agreeingShadow,
      comparedCaseIds: [
        ...syntheticPopulation.map((tcase) => tcase.caseId),
        "exp-workload-replay-phantom",
      ],
      aggregateClaim: { assertedAgreement: true, assertedDivergenceCount: 0 },
    });
    expect(fabricated.honest).toBe(false);
    expect(fabricated.foreignCaseIds).toEqual(["exp-workload-replay-phantom"]);
    expect(
      fabricated.criteria
        .find((criterion) => criterion.criterionId === "regression-per-case-evidence")
        ?.evidence.join(" "),
    ).toContain("FABRICATED-EVIDENCE");
  });
});

// ---------------------------------------------------------------------------
// Shadow cost separation (the customer is never billed for the shadow)
// ---------------------------------------------------------------------------

describe("VAL-034 deriveShadowCostSeparation", () => {
  test("a separated shadow cost passes (booked apart, served bills the incumbent only)", () => {
    const verdict = deriveShadowCostSeparation({
      incumbentCostMicroUsd: 19,
      shadowCostMicroUsd: 13,
      servedTotalMicroUsd: 19,
      shadowLedgerBookedMicroUsd: 13,
    });
    expect(verdict.separated).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a BILLED shadow (the served total inflated) FAILs with the delta named", () => {
    const verdict = deriveShadowCostSeparation({
      incumbentCostMicroUsd: 19,
      shadowCostMicroUsd: 13,
      servedTotalMicroUsd: 32,
      shadowLedgerBookedMicroUsd: 13,
    });
    expect(verdict.separated).toBe(false);
    expect(verdict.billedOntoServedMicroUsd).toBe(13);
    const billed = verdict.criteria.find(
      (criterion) => criterion.criterionId === "cost-served-excludes-shadow",
    );
    expect(billed?.status).toBe("FAIL");
    expect(billed?.evidence.join(" ")).toContain("BILLED-SHADOW");
    expect(billed?.evidence.join(" ")).toContain("13");
  });

  test("an UNMEASURED shadow cost FAILs", () => {
    const verdict = deriveShadowCostSeparation({
      incumbentCostMicroUsd: 19,
      shadowCostMicroUsd: null,
      servedTotalMicroUsd: 19,
      shadowLedgerBookedMicroUsd: null,
    });
    expect(verdict.separated).toBe(false);
    expect(verdict.shadowCostMeasured).toBe(false);
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "cost-shadow-measured")
        ?.evidence.join(" "),
    ).toContain("UNMEASURED-SHADOW-COST");
  });

  test("an UNBOOKED and a MISBOOKED shadow cost each FAIL", () => {
    const unbooked = deriveShadowCostSeparation({
      incumbentCostMicroUsd: 19,
      shadowCostMicroUsd: 13,
      servedTotalMicroUsd: 19,
      shadowLedgerBookedMicroUsd: null,
    });
    expect(unbooked.separated).toBe(false);
    expect(
      unbooked.criteria
        .find((criterion) => criterion.criterionId === "cost-shadow-ledger-books-shadow")
        ?.evidence.join(" "),
    ).toContain("UNBOOKED-SHADOW-COST");

    const misbooked = deriveShadowCostSeparation({
      incumbentCostMicroUsd: 19,
      shadowCostMicroUsd: 13,
      servedTotalMicroUsd: 19,
      shadowLedgerBookedMicroUsd: 5,
    });
    expect(misbooked.separated).toBe(false);
    expect(
      misbooked.criteria
        .find((criterion) => criterion.criterionId === "cost-shadow-ledger-books-shadow")
        ?.evidence.join(" "),
    ).toContain("MISBOOKED-SHADOW-COST");
  });
});

// ---------------------------------------------------------------------------
// Stage discipline (differentially-evaluated → shadow-executed ONLY)
// ---------------------------------------------------------------------------

describe("VAL-034 deriveShadowStageDiscipline", () => {
  const priorWalk = ["offline-replayed", "differentially-evaluated"] as const;

  const transition = (
    toStage: string,
    evidenceDigest = "abcd1234",
    ordinal = 3,
  ): LifecycleTransitionRecord =>
    ({
      proposalId: "cand-learning-discovery-aaaaaaaa",
      toStage,
      evidenceDigest,
      ordinal,
    }) as LifecycleTransitionRecord;

  test("the recorded walk + the single evidenced shadow append is DISCIPLINED", () => {
    const verdict = deriveShadowStageDiscipline({
      priorWalk,
      appendedTransitions: [transition("shadow-executed")],
      expectedLanding: true,
    });
    expect(verdict.disciplined).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a PREMATURE candidate (the walk never reached differentially-evaluated) FAILs", () => {
    const verdict = deriveShadowStageDiscipline({
      priorWalk: [],
      appendedTransitions: [transition("shadow-executed")],
      expectedLanding: true,
    });
    expect(verdict.disciplined).toBe(false);
    const source = verdict.criteria.find(
      (criterion) => criterion.criterionId === "stage-discipline-source-differentially-evaluated",
    );
    expect(source?.status).toBe("FAIL");
    expect(source?.evidence.join(" ")).toContain("PREMATURE-SHADOW");
  });

  test.each(["canaried", "promoted"] as const)(
    "a jump past shadow-executed (%s) FAILs as a skipped-stage promotion",
    (stage) => {
      const verdict = deriveShadowStageDiscipline({
        priorWalk,
        appendedTransitions: [transition(stage)],
        expectedLanding: true,
      });
      expect(verdict.disciplined).toBe(false);
      expect(verdict.beyondScopeStages).toEqual([stage]);
      const never = verdict.criteria.find(
        (criterion) => criterion.criterionId === "stage-discipline-never-beyond-shadow",
      );
      expect(never?.status).toBe("FAIL");
      expect(never?.evidence.join(" ")).toContain("SKIPPED-STAGE");
    },
  );

  test.each(["property-tested", "mutation-tested", "offline-replayed"] as const)(
    "a WRONG-STAGE landing (%s) FAILs (the shadow slice appends shadow-executed only)",
    (stage) => {
      const verdict = deriveShadowStageDiscipline({
        priorWalk,
        appendedTransitions: [transition(stage)],
        expectedLanding: true,
      });
      expect(verdict.disciplined).toBe(false);
      expect(verdict.wrongStageLandings).toEqual([stage]);
      expect(
        verdict.criteria.find(
          (criterion) => criterion.criterionId === "stage-discipline-landing-is-shadow-stage",
        )?.status,
      ).toBe("FAIL");
    },
  );

  test("an EVIDENCE-LESS transition FAILs", () => {
    const verdict = deriveShadowStageDiscipline({
      priorWalk,
      appendedTransitions: [transition("shadow-executed", "", 3)],
      expectedLanding: true,
    });
    expect(verdict.disciplined).toBe(false);
    expect(verdict.evidenceLessOrdinals).toEqual([3]);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "stage-discipline-every-transition-evidenced",
      )?.status,
    ).toBe("FAIL");
  });

  test("a LANDING mismatch (nothing appended when a landing was expected) FAILs", () => {
    const verdict = deriveShadowStageDiscipline({
      priorWalk,
      appendedTransitions: [],
      expectedLanding: true,
    });
    expect(verdict.disciplined).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "stage-discipline-landing")
        ?.status,
    ).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// The containment carry-over (an escape mid-shadow FAILs)
// ---------------------------------------------------------------------------

describe("VAL-034 containment carry-over (mid-shadow isolation)", () => {
  test.each(ISOLATION_ESCAPE_DIRECTIONS)(
    "the %s escape direction exercised MID-SHADOW is a containment VIOLATION",
    (direction) => {
      const verdict = deriveReplacementIsolation({
        declaredCapabilities: ["pure-computation"],
        grantedSurface: ["pure-computation"],
        exercisedCapabilities: ["pure-computation", direction],
      });
      expect(verdict.contained).toBe(false);
      expect(verdict.escapeDirections).toEqual([direction]);
    },
  );

  test("the shadow verdict kind ranks a mid-shadow escape as a containment violation", () => {
    const verdict = deriveShadowVerdictKind({
      refusal: null,
      isolation: deriveReplacementIsolation({
        declaredCapabilities: ["pure-computation"],
        grantedSurface: ["pure-computation"],
        exercisedCapabilities: ["pure-computation", "network-access"],
      }),
      servingIsolation: null,
      populationCompleteness: null,
      regressionHonesty: null,
      costSeparation: null,
    });
    expect(verdict).toBe("containment-violation");
  });
});

// ---------------------------------------------------------------------------
// Refusal honesty (a refusal is justified by the candidate's own state)
// ---------------------------------------------------------------------------

describe("VAL-034 deriveShadowRefusalHonesty", () => {
  test("an unregistered candidate justifies the unregistered refusal", () => {
    const verdict = deriveShadowRefusalHonesty({
      refusal: { reason: "candidate-unregistered" },
      comparisonEmitted: false,
      registryEntry: null,
    });
    expect(verdict.honest).toBe(true);
    expect(verdict.justified).toBe(true);
  });

  test("a walk that never reached differentially-evaluated justifies the premature refusal", () => {
    const verdict = deriveShadowRefusalHonesty({
      refusal: { reason: "candidate-not-differentially-evaluated" },
      comparisonEmitted: false,
      registryEntry: { lifecycleStage: "proposed", walkEndsAtDifferentiallyEvaluated: false },
    });
    expect(verdict.honest).toBe(true);
  });

  test("a refusal that HIDES a shadowable candidate FAILs (unjustified)", () => {
    const verdict = deriveShadowRefusalHonesty({
      refusal: { reason: "candidate-not-differentially-evaluated" },
      comparisonEmitted: false,
      registryEntry: { lifecycleStage: "proposed", walkEndsAtDifferentiallyEvaluated: true },
    });
    expect(verdict.honest).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "refusal-justified")?.status,
    ).toBe("FAIL");
  });

  test("a refusal accompanied by a comparison is a MALFORMED outcome", () => {
    const verdict = deriveShadowRefusalHonesty({
      refusal: { reason: "candidate-unregistered" },
      comparisonEmitted: true,
      registryEntry: null,
    });
    expect(verdict.honest).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "refusal-well-formed")?.status,
    ).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// Digest + identity determinism (payload-free FNV-1a discipline)
// ---------------------------------------------------------------------------

describe("VAL-034 digest + identity determinism", () => {
  test("every shadow digest is deterministic, 8-hex and payload-free", () => {
    const tcase = syntheticPopulation[0];
    if (tcase === undefined) {
      throw new Error("synthetic population is empty");
    }
    expect(shadowTrafficCaseDigestOf(tcase)).toBe(shadowTrafficCaseDigestOf(tcase));
    expect(shadowPopulationDigestOf(syntheticPopulation)).toBe(
      shadowPopulationDigestOf([...syntheticPopulation].reverse()),
    );
    expect(shadowComparisonDigestOf(tcase)).toMatch(/^[0-9a-f]{8}$/);
    expect(
      shadowDivergenceDigestOf({
        proposalId: "cand-1",
        caseId: tcase.caseId,
        incumbentDigest: "aaaa1111",
        shadowDigest: "aaaa9999",
      }),
    ).toMatch(/^[0-9a-f]{8}$/);
    expect(shadowCostDigestOf({ proposalId: "cand-1", microUsd: 13, latencyMs: 26 })).toMatch(
      /^[0-9a-f]{8}$/,
    );
    expect(shadowTrafficCaseDigestOf(tcase)).toMatch(/^[0-9a-f]{8}$/);
    expect(shadowPopulationDigestOf(syntheticPopulation)).toMatch(/^[0-9a-f]{8}$/);
  });

  test("the digests DISCRIMINATE (a changed input changes the digest)", () => {
    const tcase = syntheticPopulation[0];
    if (tcase === undefined) {
      throw new Error("synthetic population is empty");
    }
    expect(shadowTrafficCaseDigestOf(tcase)).not.toBe(
      shadowTrafficCaseDigestOf({ ...tcase, inputDigest: "99999999" }),
    );
    const comparison = {
      caseId: tcase.caseId,
      incumbentDigest: "aaaa1111",
      shadowDigest: "aaaa9999",
      agrees: false,
    };
    expect(shadowComparisonDigestOf(comparison)).not.toBe(
      shadowComparisonDigestOf({ ...comparison, agrees: true }),
    );
    expect(shadowComparisonDigestOf(comparison)).not.toBe(
      shadowComparisonDigestOf({ ...comparison, shadowDigest: "deadbeef" }),
    );
    expect(shadowCostDigestOf({ proposalId: "cand-1", microUsd: 13, latencyMs: 26 })).not.toBe(
      shadowCostDigestOf({ proposalId: "cand-1", microUsd: 14, latencyMs: 26 }),
    );
  });

  test("the trajectory digest is deterministic over the canonical shadow steps", () => {
    const row = rowById("rag-deterministic-function-shadow-agreement");
    const { honestRun, regression } = pinnedShadowRunOf(row);
    const steps = shadowTrajectoryStepsOf({
      proposalId: row.sourceProposalId,
      populationDigest: shadowPopulationDigestOf(row.trafficPopulation),
      servedExecutionDigest: longitudinalDigestOf([
        "incumbent-served",
        ...row.trafficPopulation.map((tcase) => tcase.incumbentDigest),
      ]),
      shadowExecutionDigest: longitudinalDigestOf([
        "shadow-executed",
        ...honestRun.outcomes.map((outcome) => outcome.digest),
      ]),
      isolationContainment: "contained",
      regressionVerdictDigest: regression.digest,
      divergenceCount: row.expected.divergenceCaseIds.length,
      shadowCostDigest: shadowCostDigestOf({
        proposalId: row.sourceProposalId,
        ...referenceShadowMeasurementOf(row.trafficPopulation),
      }),
      refusalReason: null,
      confirmationRounds: 0,
    });
    expect(trajectoryDigestOf(steps)).toBe(row.expectedTrajectoryClass[0]);
    // The honest divergence row's trajectory class carries its own divergence count.
    const divergenceRow = rowById("reuse-removed-call-shadow-honest-divergence");
    expect(divergenceRow.expectedTrajectoryClass).toHaveLength(1);
    expect(divergenceRow.expected.divergenceCaseIds).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// The append-only ledgers
// ---------------------------------------------------------------------------

describe("VAL-034 append-only ledgers", () => {
  test("the lifecycle ledger replays the identical shadow append and refuses the impostor", async () => {
    const ledger = createLifecycleLedger();
    const record = {
      proposalId: "cand-learning-discovery-aaaaaaaa",
      toStage: "shadow-executed" as const,
      evidenceDigest: "abcd1234",
    };
    const first = await ledger.append(record);
    expect(first.accepted).toBe(true);
    expect(first.replayed).toBe(false);
    const second = await ledger.append(record);
    expect(second.accepted).toBe(true);
    expect(second.replayed).toBe(true);
    const impostor = await ledger.append({ ...record, evidenceDigest: "ffff0000" });
    expect(impostor.refused).toBe(true);
    expect(ledger.transitionsFor(record.proposalId)).toHaveLength(1);
  });

  test("the shadow ledger replays the identical divergence + cost bookings and refuses impostors", async () => {
    const ledger = createShadowLedger();
    const divergence = {
      proposalId: "cand-learning-discovery-aaaaaaaa",
      caseId: "exp-workload-replay-aaaaaaaa",
      incumbentDigest: "aaaa1111",
      shadowDigest: "aaaa9999",
    };
    expect((await ledger.appendDivergence(divergence)).replayed).toBe(false);
    expect((await ledger.appendDivergence(divergence)).replayed).toBe(true);
    expect(
      (await ledger.appendDivergence({ ...divergence, shadowDigest: "deadbeef" })).refused,
    ).toBe(true);
    expect(ledger.divergencesFor(divergence.proposalId)).toHaveLength(1);

    const cost = { proposalId: "cand-learning-discovery-aaaaaaaa", microUsd: 13, latencyMs: 26 };
    expect((await ledger.bookShadowCost(cost)).replayed).toBe(false);
    expect((await ledger.bookShadowCost(cost)).replayed).toBe(true);
    expect((await ledger.bookShadowCost({ ...cost, microUsd: 14 })).refused).toBe(true);
    expect(ledger.costsFor(cost.proposalId)).toHaveLength(1);
  });

  test("the lifecycle ledger pre-seeds the recorded VAL-033 walk for every evaluated candidate", () => {
    const ledger = createLifecycleLedger();
    const row = rowById("rag-deterministic-function-shadow-agreement");
    const walk = ledger.transitionsFor(row.sourceProposalId);
    expect(walk.map((transition) => transition.toStage)).toEqual([
      "offline-replayed",
      "differentially-evaluated",
    ]);
    expect(walk.every((transition) => transition.evidenceDigest.length > 0)).toBe(true);
    // The premature candidate's walk NEVER started.
    const premature = rowById("premature-candidate-shadow-refusal");
    expect(ledger.transitionsFor(premature.sourceProposalId)).toHaveLength(0);
    // The pre-seeded walk matches the corpus's canonical prior walk.
    expect(walk).toEqual(priorWalkOf(row) as unknown[]);
  });
});

// ---------------------------------------------------------------------------
// The driver over the honest fake world
// ---------------------------------------------------------------------------

describe("VAL-034 driver over the honest fake world", () => {
  test.each(OFFLINE_CORPUS_ROWS.map((row) => [row.rowId, row]))(
    "the %s row reproduces its pinned verdict over the honest stack",
    async (_rowId, row) => {
      const result = await driveRowOverStack({ row });
      expect(result.terminal).toBe(row.expected.terminal);
      expect(result.verdict).toBe(row.expected.verdict);
      if (row.expected.verdict === "honest-divergence") {
        // An honest divergence FAILs exactly ONE leg — the agreement
        // leg itself (the divergence is the honest record, never smoothed).
        const failing = result.criteria.filter((criterion) => criterion.status === "FAIL");
        expect(failing.map((criterion) => criterion.criterionId)).toEqual([
          "regression-agreement-under-criterion",
        ]);
        expect(failing[0]?.evidence.join(" ")).toContain("HONEST-DIVERGENCE");
      } else {
        expect(result.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
      }
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      if (row.expected.verdict === "honest-divergence") {
        expect(result.divergencesAppended).toBe(row.expected.divergenceCaseIds.length);
        expect(result.ledgerLanding?.accepted).toBe(true);
      }
      if (row.expected.verdict === "honest-refusal") {
        expect(result.refusal?.reason).toBe(row.expected.refusalReason);
        expect(result.ledgerLanding).toBeNull();
        expect(result.divergencesAppended).toBe(0);
      }
    },
  );

  test("an honest divergence still lands the shadow transition and books the shadow cost", async () => {
    const row = rowById("reuse-removed-call-shadow-honest-divergence");
    const result = await driveRowOverStack({ row });
    expect(result.verdict).toBe("honest-divergence");
    expect(result.ledgerLanding?.accepted).toBe(true);
    expect(result.shadowCostBooked).toBe(true);
    expect(result.costSeparation?.separated).toBe(true);
    expect(result.stageDiscipline?.appendedWalk).toEqual(["shadow-executed"]);
  });

  test("a live row without a dispatch seam is a configuration error; with one it completes measured", async () => {
    const row = SHADOW_EXECUTION_CORPUS.find((candidate) => candidate.needsDispatch);
    expect(row).toBeDefined();
    const liveRow = row as ShadowCorpusRow;
    const clock = createTickClock();
    await expect(
      driveShadowRun({
        row: liveRow,
        registry: createCandidateRegistry(),
        lifecycle: createLifecycleLedger(),
        shadowLedger: createShadowLedger(),
        incumbentExecutor: createIncumbentExecutor(),
        trafficSource: createTrafficSource(),
        servingPath: createServingPath(),
        shadowRuntime: createShadowRuntime(),
        now: clock.now,
      }),
    ).rejects.toThrow("demands a dispatch seam");
    // With the seam bound, the run completes honestly: ONE REAL
    // residual-AI round, measured usage, the shadow landing.
    const result = await driveRowOverStack({
      row: liveRow,
      dispatch: async () => ({
        kind: "success" as const,
        usage: { inputTokens: 30, outputTokens: 6, costUsd: 0.001 },
        latencyMs: 40,
      }),
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.observedModelCalls).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 6, costUsd: 0.001 });
    expect(result.verdict).toBe("shadow-agreement");
    expect(result.ledgerLanding?.accepted).toBe(true);
  });

  test("a dispatch FAILURE on the live row FAILs honestly (never a fabricated completion)", async () => {
    const row = SHADOW_EXECUTION_CORPUS.find((candidate) => candidate.needsDispatch);
    expect(row).toBeDefined();
    const liveRow = row as ShadowCorpusRow;
    const result = await driveRowOverStack({
      row: liveRow,
      dispatch: async () => ({
        kind: "failure" as const,
        category: "provider-unavailable",
        message: "the provider is unavailable",
        retryable: true,
        latencyMs: 5,
      }),
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.failure?.category).toBe("provider-unavailable");
    expect(result.observedModelCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The adversarial worlds (the leak / population / regression / cost /
// stage / containment catches)
// ---------------------------------------------------------------------------

describe("VAL-034 adversarial shadow worlds", () => {
  test("a LEAKY serving path (the replacement's outcome served) FAILs and never lands", async () => {
    const row = rowById("probe-leaked-outcome");
    const result = await driveRowOverStack({ row, servingVariant: "leaky" });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("shadow-invalid");
    expect(result.servingIsolation?.isolated).toBe(false);
    expect(result.servingIsolation?.leakKind).toBe("explicit-leak");
    const sourceLeg = result.criteria.find(
      (criterion) => criterion.criterionId === "serving-source-pinned-incumbent",
    );
    expect(sourceLeg?.status).toBe("FAIL");
    expect(sourceLeg?.evidence.join(" ")).toContain("LEAKED-SHADOW");
    expect(result.ledgerLanding).toBeNull();
  });

  test("a DISGUISED leak (the shadow's digest under the incumbent source) FAILs", async () => {
    // The honest-divergence row's shadow digests genuinely differ from
    // the incumbent's — the disguised serve carries the shadow's own
    // digest under a claimed incumbent source.
    const row = rowById("reuse-removed-call-shadow-honest-divergence");
    const result = await driveRowOverStack({ row, servingVariant: "disguised" });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("shadow-invalid");
    expect(result.servingIsolation?.leakKind).toBe("disguised-leak");
    expect(result.servingIsolation?.leakedCaseIds.length).toBeGreaterThan(0);
    expect(result.ledgerLanding).toBeNull();
    // The leak never lands, but the mechanically-derived divergences
    // are still recorded case-by-case (the honest record survives).
    expect(result.divergencesAppended).toBe(row.expected.divergenceCaseIds.length);
  });

  test.each(["dropped", "duplicated", "mixed-up"] as const)(
    "the %s traffic source FAILs the shadow population completeness",
    async (variant) => {
      const row = rowById("probe-dropped-case");
      const result = await driveRowOverStack({ row, trafficVariant: variant });
      expect(result.terminal).toBe("FAILED");
      expect(result.populationCompleteness?.complete).toBe(false);
      expect(result.ledgerLanding).toBeNull();
      const populationLeg = result.criteria.find(
        (criterion) => criterion.criterionId === "population-completeness-summary",
      );
      expect(populationLeg?.status).toBe("FAIL");
      if (variant === "dropped") {
        expect(result.populationCompleteness?.missingCaseIds).toHaveLength(1);
      }
      if (variant === "duplicated") {
        expect(result.populationCompleteness?.duplicatedCaseIds.length).toBeGreaterThan(0);
      }
      if (variant === "mixed-up") {
        expect(result.populationCompleteness?.foreignCaseIds).toHaveLength(1);
      }
    },
  );

  test("an AGGREGATE-ONLY runtime (no per-case records) FAILs the regression honesty", async () => {
    const row = rowById("probe-smoothed-aggregate");
    const result = await driveRowOverStack({ row, runtimeVariant: "aggregate-only" });
    expect(result.terminal).toBe("FAILED");
    expect(result.regressionHonesty?.perCaseEvidenceComplete).toBe(false);
    const perCase = result.criteria.find(
      (criterion) => criterion.criterionId === "regression-per-case-evidence",
    );
    expect(perCase?.status).toBe("FAIL");
    expect(perCase?.evidence.join(" ")).toContain("AGGREGATE-ONLY");
    expect(result.ledgerLanding).toBeNull();
  });

  test("a SUBSET-COMPARED runtime (an asserted agreement from a subset) FAILs", async () => {
    const row = rowById("probe-smoothed-aggregate");
    const result = await driveRowOverStack({ row, runtimeVariant: "subset-compared" });
    expect(result.terminal).toBe("FAILED");
    expect(result.regressionHonesty?.missingCaseIds).toHaveLength(1);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "regression-per-case-evidence")
        ?.status,
    ).toBe("FAIL");
  });

  test("a SMOOTHING runtime (a divergent case claimed agreeing) FAILs the honesty leg", async () => {
    const row = rowById("probe-smoothed-aggregate");
    const result = await driveRowOverStack({ row, runtimeVariant: "smoothing" });
    expect(result.terminal).toBe("FAILED");
    expect(result.regressionHonesty?.mechanicalDivergenceCaseIds).toHaveLength(1);
    expect(result.regressionHonesty?.smoothedCaseIds).toHaveLength(1);
    const smoothing = result.criteria.find(
      (criterion) => criterion.criterionId === "regression-no-smoothing",
    );
    expect(smoothing?.status).toBe("FAIL");
    expect(smoothing?.evidence.join(" ")).toContain("DIVERGENCE-SMOOTHING");
    expect(result.ledgerLanding).toBeNull();
  });

  test("an UNMEASURED shadow cost FAILs the cost separation", async () => {
    const row = rowById("probe-billed-shadow");
    const result = await driveRowOverStack({ row, runtimeVariant: "unmeasured" });
    expect(result.terminal).toBe("FAILED");
    expect(result.costSeparation?.shadowCostMeasured).toBe(false);
    expect(result.ledgerLanding).toBeNull();
  });

  test("a DOUBLE-BOOKING shadow cost ledger (the customer billed) FAILs with the delta named", async () => {
    const row = rowById("probe-billed-shadow");
    const result = await driveRowOverStack({ row, costLedgerVariant: "double-booking" });
    expect(result.terminal).toBe("FAILED");
    expect(result.costSeparation?.separated).toBe(false);
    expect(result.costSeparation?.billedOntoServedMicroUsd).toBeGreaterThan(0);
    const billed = result.criteria.find(
      (criterion) => criterion.criterionId === "cost-served-excludes-shadow",
    );
    expect(billed?.status).toBe("FAIL");
    expect(billed?.evidence.join(" ")).toContain("BILLED-SHADOW");
    expect(result.ledgerLanding).toBeNull();
  });

  test("an ESCAPING runtime (network access mid-shadow) is a containment violation that never lands", async () => {
    const row = rowById("probe-mid-shadow-escape");
    const result = await driveRowOverStack({ row, runtimeVariant: "escaping" });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("containment-violation");
    expect(result.isolation?.contained).toBe(false);
    expect(result.isolation?.escapeDirections).toEqual(["network-access"]);
    const escapeLeg = result.criteria.find(
      (criterion) => criterion.criterionId === "isolation-no-escape",
    );
    expect(escapeLeg?.status).toBe("FAIL");
    expect(escapeLeg?.evidence.join(" ")).toContain("CONTAINMENT-VIOLATION");
    expect(result.ledgerLanding).toBeNull();
  });

  test("a SKIP-TO-CANARIED ledger (a skipped-stage promotion) FAILs the stage discipline", async () => {
    const row = rowById("probe-skipped-stage");
    const result = await driveRowOverStack({ row, ledgerVariant: "skip-to-canaried" });
    expect(result.terminal).toBe("FAILED");
    expect(result.stageDiscipline?.beyondScopeStages).toEqual(["canaried"]);
    const never = result.criteria.find(
      (criterion) => criterion.criterionId === "stage-discipline-never-beyond-shadow",
    );
    expect(never?.status).toBe("FAIL");
    expect(never?.evidence.join(" ")).toContain("SKIPPED-STAGE");
  });

  test("a WRONG-STAGE ledger (a property-tested landing) FAILs the stage discipline", async () => {
    const row = rowById("probe-skipped-stage");
    const result = await driveRowOverStack({ row, ledgerVariant: "wrong-stage" });
    expect(result.terminal).toBe("FAILED");
    expect(result.stageDiscipline?.wrongStageLandings).toEqual(["property-tested"]);
    expect(
      result.criteria.find(
        (criterion) => criterion.criterionId === "stage-discipline-landing-is-shadow-stage",
      )?.status,
    ).toBe("FAIL");
  });

  test("an EVIDENCE-LESS ledger (transitions without evidence) FAILs the stage discipline", async () => {
    const row = rowById("probe-skipped-stage");
    const result = await driveRowOverStack({ row, ledgerVariant: "evidence-less" });
    expect(result.terminal).toBe("FAILED");
    expect(result.stageDiscipline?.evidenceLessOrdinals).toHaveLength(1);
    expect(
      result.criteria.find(
        (criterion) => criterion.criterionId === "stage-discipline-every-transition-evidenced",
      )?.status,
    ).toBe("FAIL");
  });

  test("a REWRITE-REGISTRY ledger (a candidate rewrite) FAILs the read-only discipline", async () => {
    const row = rowById("probe-skipped-stage");
    const clock = createTickClock();
    const registry = createCandidateRegistry();
    const beforeDigest = registry.digest();
    const servingPath = createServingPath();
    const result = await driveShadowRun({
      row,
      registry,
      lifecycle: createLifecycleLedger({ variant: "rewrite-registry", registry }),
      shadowLedger: createShadowLedger({ servingPath }),
      incumbentExecutor: createIncumbentExecutor(),
      trafficSource: createTrafficSource(),
      servingPath,
      shadowRuntime: createShadowRuntime(),
      now: clock.now,
    });
    expect(result.terminal).toBe("FAILED");
    // The shadow itself was honest — the rewrite happened at the
    // append: the registry's frozen digest CHANGED.
    expect(result.regressionHonesty?.honest).toBe(true);
    expect(registry.digest()).not.toBe(beforeDigest);
    const readonly = result.criteria.find(
      (criterion) => criterion.criterionId === "registry-read-only",
    );
    expect(readonly?.status).toBe("FAIL");
    expect(readonly?.evidence.join(" ")).toContain("REGISTRY-MUTATION");
  });

  test("a DIVERGENT incumbent executor (a drifted serve) FAILs the population pin", async () => {
    const row = rowById("rag-deterministic-function-shadow-agreement");
    const result = await driveRowOverStack({ row, divergentIncumbent: true });
    expect(result.terminal).toBe("FAILED");
    const pin = result.criteria.find(
      (criterion) => criterion.criterionId === "population-served-as-pinned",
    );
    expect(pin?.status).toBe("FAIL");
    expect(pin?.evidence.join(" ")).toContain("POPULATION-MISMATCH");
  });

  test("an honest re-drive REPLAYS the shadow walk (append-only idempotence)", async () => {
    const row = rowById("rag-deterministic-function-shadow-agreement");
    const clock = createTickClock();
    const registry = createCandidateRegistry();
    const lifecycle = createLifecycleLedger();
    const servingPath = createServingPath();
    const shadowLedger = createShadowLedger({ servingPath });
    const driveOnce = () =>
      driveShadowRun({
        row,
        registry,
        lifecycle,
        shadowLedger,
        incumbentExecutor: createIncumbentExecutor(),
        trafficSource: createTrafficSource(),
        servingPath,
        shadowRuntime: createShadowRuntime(),
        now: clock.now,
      });
    const first = await driveOnce();
    expect(first.terminal).toBe("COMPLETED");
    const second = await driveOnce();
    expect(second.terminal).toBe("COMPLETED");
    // The identical re-append REPLAYS: still exactly the recorded walk
    // plus the single shadow transition.
    expect(lifecycle.transitionsFor(row.sourceProposalId)).toHaveLength(3);
    expect(second.ledgerLanding?.replayed).toBe(true);
    // The divergence ledger holds no duplicate bookings.
    expect(shadowLedger.costsFor(row.sourceProposalId)).toHaveLength(1);
  });
});
