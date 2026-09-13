/**
 * VAL-035 acceptance criteria 1, 2, 4, 5: the canary-promotion
 * platform slice against controlled fakes — the canary vocabulary
 * (the governed-ramp mode; the decision / verdict / refusal / probe
 * vocabularies; the lifecycle ladder's canaried → promoted walk — the
 * FINAL stage), the PURE derivations that make a governed promotion
 * trustworthy (the policy-explicitness matrix — a stated-and-checked
 * pass and each unstated / unchecked / malformed-ramp /
 * decisionless-step shape FAILing with the item named; the
 * lifecycle-completeness matrix — the full evidenced chain passing
 * while each skipped stage, broken walk, unevidenced transition,
 * jumped rung, wrong-stage landing and landing-shape mismatch FAILs;
 * the breach-honesty matrix — a within-budget advance, an honest
 * beyond-budget rollback, and the smoothed-breach /
 * uncontrolled-rollback / unjustified-rollback / smoothed-count shapes
 * each FAILing; the rollback-completeness matrix — a complete
 * exercised rollback passing while each partial-residual,
 * unexercised-plan, unrecorded-plan and unjustified-event shape FAILs;
 * the slice-isolation matrix — a within-slice pass and the
 * over-slice / out-of-slice-tenant / ramp-adherence shapes each
 * FAILing, with the post-promotion full serve legal; the
 * cost-separation matrix — a separated pass and each billed /
 * unmarked / unmeasured / unbooked shape FAILing), the containment
 * carry-over (an escape mid-canary FAILs), the digest discipline
 * (deterministic, canonical, payload-free), the identity determinism,
 * the append-only ledgers, and the driver over every offline corpus
 * row — including the ADVERSARIAL worlds: the
 * ESCAPING/BREACHING/UNMEASURED canary runtimes, the
 * OVER-SLICE/PARTIAL-ROLLBACK serving paths, the
 * JUMP-TO-PROMOTED/BROKEN-WALK/WRONG-STAGE/EVIDENCE-LESS/REWRITE-REGISTRY
 * lifecycle ledgers, the SMOOTHING-DECISIONS/DECISIONLESS/UNMARKED-
 * DOUBLE-BOOKING canary ledgers and the dispatch seam contract.
 */

import { describe, expect, test } from "vitest";
import {
  CANARY_PROMOTION_CORPUS,
  OFFLINE_CORPUS_ROWS,
  PINNED_REGISTRY_ENTRIES,
  pinnedCanaryRampOf,
  priorWalkOf,
} from "../../../benchmarks/validation/apps/canary-promotion/corpus";
import {
  createCanaryLedger,
  createCanaryRuntime,
  createCanaryServingPath,
  createCandidateRegistry,
  createIncumbentExecutor,
  createLifecycleLedger,
  createTickClock,
  createTrafficSource,
  type FakeCanaryLedgerVariant,
  type FakeCanaryRuntimeVariant,
  type FakeLifecycleVariant,
  type FakeServingPathVariant,
} from "../../../benchmarks/validation/apps/canary-promotion/fixtures";
import type {
  CanaryBreachLeg,
  CanaryCorpusRow,
  CanaryDecisionPolicyLeg,
  CanaryRunResult,
  CanarySliceServeStep,
  RampStep,
} from "../../../benchmarks/validation/platform/canary-promotion";
import {
  CANARY_DECISION_KINDS,
  CANARY_EXPERIMENT_KIND,
  CANARY_LEARNING_PHASE,
  CANARY_MODES,
  CANARY_PROBE_KINDS,
  CANARY_REFUSAL_REASONS,
  CANARY_REQUIRED_PRIOR_WALK,
  CANARY_SOURCE_STAGE,
  CANARY_STAGE,
  CANARY_VERDICTS,
  canaryCostDigestOf,
  canaryDecisionDigestOf,
  canaryDivergenceDigestOf,
  canaryLifecycleStageIndexOf,
  canarySliceDigestOf,
  canaryTenantIdOf,
  canaryTrajectoryStepsOf,
  deriveBreachHonesty,
  deriveCanaryCostSeparation,
  deriveCanaryPolicyExplicitness,
  deriveCanaryRefusalHonesty,
  deriveCanaryVerdictKind,
  derivePromotionLifecycleCompleteness,
  deriveRollbackCompleteness,
  deriveSliceIsolation,
  driveCanaryRun,
  failureBudgetDigestOf,
  isBeyondPromotionScope,
  isCanaryDecisionKind,
  isCanaryMode,
  isCanaryProbeKind,
  isCanaryRefusalReason,
  isCanaryVerdictKind,
  isRampScheduleWellFormed,
  PROMOTED_STAGE,
  rampScheduleDigestOf,
  referenceCanaryMeasurementOf,
  rollbackEventDigestOf,
  rollbackPlanDigestOf,
  sliceCaseIdsOf,
} from "../../../benchmarks/validation/platform/canary-promotion";
import type { LifecycleTransitionRecord } from "../../../benchmarks/validation/platform/equivalence-testing";
import {
  deriveReplacementIsolation,
  ISOLATION_ESCAPE_DIRECTIONS,
} from "../../../benchmarks/validation/platform/equivalence-testing";
import type { ControlDispatch } from "../../../benchmarks/validation/platform/longitudinal-baseline";
import {
  longitudinalDigestOf,
  trajectoryDigestOf,
} from "../../../benchmarks/validation/platform/longitudinal-baseline";

const rowById = (rowId: string): CanaryCorpusRow => {
  const row = CANARY_PROMOTION_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

/** Drive one offline row over a purpose-built fake stack. */
async function driveRowOverStack(options: {
  readonly row: CanaryCorpusRow;
  readonly runtimeVariant?: FakeCanaryRuntimeVariant;
  readonly ledgerVariant?: FakeLifecycleVariant;
  readonly servingVariant?: FakeServingPathVariant;
  readonly canaryLedgerVariant?: FakeCanaryLedgerVariant;
  readonly dispatch?: ControlDispatch;
}): Promise<CanaryRunResult> {
  const clock = createTickClock();
  const registry = createCandidateRegistry();
  const servingPath = createCanaryServingPath({
    ...(options.servingVariant === undefined ? {} : { variant: options.servingVariant }),
  });
  const lifecycle = createLifecycleLedger({
    ...(options.ledgerVariant === undefined ? {} : { variant: options.ledgerVariant }),
    registry,
  });
  const canaryLedger = createCanaryLedger({
    ...(options.canaryLedgerVariant === undefined ? {} : { variant: options.canaryLedgerVariant }),
    servingPath,
  });
  return driveCanaryRun({
    row: options.row,
    registry,
    lifecycle,
    canaryLedger,
    incumbentExecutor: createIncumbentExecutor(),
    trafficSource: createTrafficSource(),
    servingPath,
    canaryRuntime: createCanaryRuntime({
      ...(options.runtimeVariant === undefined ? {} : { variant: options.runtimeVariant }),
    }),
    ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
    now: clock.now,
  });
}

/** The RAG clean-promotion row's population case ids (the isolation basis). */
const RAG_CASE_IDS = rowById("rag-deterministic-function-clean-promotion").trafficPopulation.map(
  (tcase) => tcase.caseId,
);

/** The honest slice-serve steps for a synthetic within-slice control. */
const withinSliceSteps = (fractions: readonly number[]): CanarySliceServeStep[] =>
  fractions.map((fraction, index) => ({
    stepIndex: index + 1,
    pinnedFraction: fraction,
    populationCaseIds: RAG_CASE_IDS,
    servedReplacementCaseIds: [...sliceCaseIdsOf(RAG_CASE_IDS, fraction)],
    servedReplacementTenantIds: [
      ...new Set(sliceCaseIdsOf(RAG_CASE_IDS, fraction).map((caseId) => canaryTenantIdOf(caseId))),
    ],
  }));

/** A stated-and-checked decision leg for one step. */
const explicitLeg = (stepIndex: number, scheduleDigest: string): CanaryDecisionPolicyLeg => ({
  stepIndex,
  citations: {
    rampScheduleDigest: scheduleDigest,
    failureBudgetStated: true,
    toleranceStated: true,
  },
  checks: { rampChecked: true, budgetChecked: true, toleranceChecked: true },
});

/** A well-formed four-step ramp (the default governed schedule). */
const WELL_FORMED_RAMP: readonly RampStep[] = [
  { stepIndex: 1, trafficFraction: 0.05 },
  { stepIndex: 2, trafficFraction: 0.25 },
  { stepIndex: 3, trafficFraction: 0.5 },
  { stepIndex: 4, trafficFraction: 1 },
];

/** A prior-walk transition helper (the full evidenced chain). */
const priorTransition = (
  proposalId: string,
  stage: LifecycleTransitionRecord["toStage"],
  ordinal: number,
): LifecycleTransitionRecord => ({
  proposalId,
  toStage: stage,
  evidenceDigest: longitudinalDigestOf(["prior-evidence", proposalId, stage, ordinal]),
  ordinal,
});

// ---------------------------------------------------------------------------
// The vocabulary + the lifecycle ladder
// ---------------------------------------------------------------------------

describe("VAL-035 platform vocabulary", () => {
  test("the canary vocabulary is pinned (canaries serve a governed slice under explicit policy)", () => {
    expect(CANARY_LEARNING_PHASE).toBe("canary");
    expect(CANARY_EXPERIMENT_KIND).toBe("canary-promotion");
    expect(CANARY_MODES).toEqual(["governed-ramp"]);
    expect(isCanaryMode("governed-ramp")).toBe(true);
    expect(isCanaryMode("ungoverned-slice")).toBe(false);
  });

  test("the decision / verdict / refusal / probe vocabularies are pinned", () => {
    expect(CANARY_DECISION_KINDS).toEqual(["advance", "breach-rollback", "refuse"]);
    expect(isCanaryDecisionKind("advance")).toBe(true);
    expect(isCanaryDecisionKind("promote-anyway")).toBe(false);
    expect(CANARY_VERDICTS).toEqual([
      "clean-promotion",
      "honest-rollback",
      "containment-violation",
      "honest-refusal",
      "canary-invalid",
    ]);
    expect(isCanaryVerdictKind("clean-promotion")).toBe(true);
    expect(isCanaryVerdictKind("promoted")).toBe(false);
    expect(CANARY_REFUSAL_REASONS).toEqual([
      "candidate-unregistered",
      "candidate-not-shadow-executed",
    ]);
    expect(isCanaryRefusalReason("candidate-not-shadow-executed")).toBe(true);
    expect(isCanaryRefusalReason("candidate-not-canaried")).toBe(false);
    expect(CANARY_PROBE_KINDS).toEqual([
      "skipped-lifecycle",
      "unchecked-policy",
      "smoothed-breach",
      "over-slice",
      "partial-rollback",
      "mid-canary-escape",
    ]);
    expect(isCanaryProbeKind("over-slice")).toBe(true);
    expect(isCanaryProbeKind("under-slice")).toBe(false);
  });

  test("the lifecycle ladder is pinned (canaried → promoted — the FINAL stage, one rung at a time)", () => {
    expect(CANARY_STAGE).toBe("canaried");
    expect(PROMOTED_STAGE).toBe("promoted");
    expect(CANARY_SOURCE_STAGE).toBe("shadow-executed");
    expect(CANARY_REQUIRED_PRIOR_WALK).toEqual([
      "offline-replayed",
      "differentially-evaluated",
      "shadow-executed",
    ]);
    expect(canaryLifecycleStageIndexOf("canaried")).toBe(
      canaryLifecycleStageIndexOf("shadow-executed") + 1,
    );
    expect(canaryLifecycleStageIndexOf("promoted")).toBe(
      canaryLifecycleStageIndexOf("canaried") + 1,
    );
    expect(isBeyondPromotionScope("promoted")).toBe(false);
    // Nothing on the pinned ladder lies beyond the final stage today.
    expect(
      [
        "observed",
        "characterized",
        "proposed",
        "offline-replayed",
        "differentially-evaluated",
        "property-tested",
        "mutation-tested",
        "shadow-executed",
        "canaried",
        "promoted",
      ].every((stage) => !isBeyondPromotionScope(stage as never)),
    ).toBe(true);
  });

  test("the ramp grammar is pinned (fractions strictly increasing in (0, 1], ending at full traffic)", () => {
    expect(isRampScheduleWellFormed(WELL_FORMED_RAMP)).toBe(true);
    expect(isRampScheduleWellFormed([{ stepIndex: 1, trafficFraction: 1 }])).toBe(true);
    expect(isRampScheduleWellFormed([])).toBe(false);
    expect(isRampScheduleWellFormed([{ stepIndex: 1, trafficFraction: 0 }])).toBe(false);
    expect(
      isRampScheduleWellFormed([
        { stepIndex: 1, trafficFraction: 0.25 },
        { stepIndex: 2, trafficFraction: 0.05 },
      ]),
    ).toBe(false);
    expect(
      isRampScheduleWellFormed([
        { stepIndex: 1, trafficFraction: 0.25 },
        { stepIndex: 2, trafficFraction: 0.25 },
      ]),
    ).toBe(false);
    expect(
      isRampScheduleWellFormed([
        { stepIndex: 1, trafficFraction: 0.25 },
        { stepIndex: 2, trafficFraction: 0.5 },
      ]),
    ).toBe(false);
    expect(
      isRampScheduleWellFormed([
        { stepIndex: 2, trafficFraction: 0.25 },
        { stepIndex: 1, trafficFraction: 1 },
      ]),
    ).toBe(false);
  });

  test("the pinned corpus declares 13 offline rows + 1 live row with every probe vocabulary member", () => {
    expect(OFFLINE_CORPUS_ROWS.length).toBe(13);
    expect(CANARY_PROMOTION_CORPUS.length).toBe(14);
    expect(CANARY_PROMOTION_CORPUS.filter((row) => row.needsDispatch).length).toBe(1);
    const probes = new Set(
      CANARY_PROMOTION_CORPUS.filter((row) => row.probe !== undefined).map(
        (row) => row.probe?.kind,
      ),
    );
    expect([...probes].sort()).toEqual([...CANARY_PROBE_KINDS].sort());
    // 4 clean offline rows + 4 clean-expected probe rows + the live row;
    // the honest-rollback row + the smoothed-breach/partial-rollback probes.
    expect(
      CANARY_PROMOTION_CORPUS.filter((row) => row.expected.verdict === "clean-promotion").length,
    ).toBe(9);
    expect(
      CANARY_PROMOTION_CORPUS.filter((row) => row.expected.verdict === "honest-rollback").length,
    ).toBe(3);
    expect(
      CANARY_PROMOTION_CORPUS.filter((row) => row.expected.verdict === "honest-refusal").length,
    ).toBe(2);
  });

  test("every corpus row's ramp schedule is well-formed and the registry membership is pinned", () => {
    for (const row of CANARY_PROMOTION_CORPUS) {
      expect(isRampScheduleWellFormed(row.rampSchedule)).toBe(true);
    }
    expect(PINNED_REGISTRY_ENTRIES.length).toBeGreaterThanOrEqual(8);
    // The phantom identity is NOT a member; every non-refusal row's
    // candidate IS.
    for (const row of CANARY_PROMOTION_CORPUS) {
      if (row.expected.refusalReason === "candidate-unregistered") {
        expect(PINNED_REGISTRY_ENTRIES.some((pin) => pin.proposalId === row.sourceProposalId)).toBe(
          false,
        );
      } else {
        expect(PINNED_REGISTRY_ENTRIES.some((pin) => pin.proposalId === row.sourceProposalId)).toBe(
          true,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Policy explicitness
// ---------------------------------------------------------------------------

describe("VAL-035 deriveCanaryPolicyExplicitness", () => {
  const tolerance = rowById("rag-deterministic-function-clean-promotion").acceptanceCriterion;
  const budget = { maxDivergencesPerStep: 1 };
  const scheduleDigest = rampScheduleDigestOf(WELL_FORMED_RAMP);

  test("a stated-and-checked policy over a well-formed ramp is EXPLICIT", () => {
    const verdict = deriveCanaryPolicyExplicitness({
      rampSchedule: WELL_FORMED_RAMP,
      failureBudget: budget,
      tolerance,
      decisions: WELL_FORMED_RAMP.map((step) => explicitLeg(step.stepIndex, scheduleDigest)),
      executedStepIndexes: WELL_FORMED_RAMP.map((step) => step.stepIndex),
    });
    expect(verdict.explicit).toBe(true);
    expect(verdict.unstatedItems).toEqual([]);
    expect(verdict.uncheckedItems).toEqual([]);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("an UNSTATED policy item FAILs with the item named", () => {
    const verdict = deriveCanaryPolicyExplicitness({
      rampSchedule: WELL_FORMED_RAMP,
      failureBudget: budget,
      tolerance,
      decisions: [
        {
          stepIndex: 1,
          citations: {
            rampScheduleDigest: scheduleDigest,
            failureBudgetStated: false,
            toleranceStated: true,
          },
          checks: { rampChecked: true, budgetChecked: true, toleranceChecked: true },
        },
        ...WELL_FORMED_RAMP.slice(1).map((step) => explicitLeg(step.stepIndex, scheduleDigest)),
      ],
      executedStepIndexes: WELL_FORMED_RAMP.map((step) => step.stepIndex),
    });
    expect(verdict.explicit).toBe(false);
    expect(verdict.unstatedItems).toEqual(["step-1:failure-budget"]);
    expect(verdict.criteria.find((c) => c.criterionId === "policy-every-item-stated")?.status).toBe(
      "FAIL",
    );
  });

  test("a stated-but-UNCHECKED budget/tolerance FAILs with the unchecked item named", () => {
    const verdict = deriveCanaryPolicyExplicitness({
      rampSchedule: WELL_FORMED_RAMP,
      failureBudget: budget,
      tolerance,
      decisions: [
        {
          stepIndex: 2,
          citations: {
            rampScheduleDigest: scheduleDigest,
            failureBudgetStated: true,
            toleranceStated: true,
          },
          checks: { rampChecked: true, budgetChecked: false, toleranceChecked: false },
        },
        ...WELL_FORMED_RAMP.filter((step) => step.stepIndex !== 2).map((step) =>
          explicitLeg(step.stepIndex, scheduleDigest),
        ),
      ],
      executedStepIndexes: WELL_FORMED_RAMP.map((step) => step.stepIndex),
    });
    expect(verdict.explicit).toBe(false);
    expect(verdict.uncheckedItems).toEqual([
      "step-2:failure-budget",
      "step-2:divergence-tolerance",
    ]);
    expect(
      verdict.criteria.find((c) => c.criterionId === "policy-every-item-checked")?.status,
    ).toBe("FAIL");
  });

  test("a MALFORMED ramp schedule (not increasing / not ending at full traffic) FAILs", () => {
    const malformed: readonly RampStep[] = [
      { stepIndex: 1, trafficFraction: 0.25 },
      { stepIndex: 2, trafficFraction: 0.5 },
    ];
    const digest = rampScheduleDigestOf(malformed);
    const verdict = deriveCanaryPolicyExplicitness({
      rampSchedule: malformed,
      failureBudget: budget,
      tolerance,
      decisions: [explicitLeg(1, digest), explicitLeg(2, digest)],
      executedStepIndexes: [1, 2],
    });
    expect(verdict.rampScheduleWellFormed).toBe(false);
    expect(verdict.explicit).toBe(false);
    expect(
      verdict.criteria.find((c) => c.criterionId === "policy-ramp-schedule-well-formed")?.status,
    ).toBe("FAIL");
  });

  test("an executed step WITHOUT its decision FAILs (a policy the run never stated)", () => {
    const verdict = deriveCanaryPolicyExplicitness({
      rampSchedule: WELL_FORMED_RAMP,
      failureBudget: budget,
      tolerance,
      decisions: WELL_FORMED_RAMP.slice(1).map((step) =>
        explicitLeg(step.stepIndex, scheduleDigest),
      ),
      executedStepIndexes: WELL_FORMED_RAMP.map((step) => step.stepIndex),
    });
    expect(verdict.explicit).toBe(false);
    expect(verdict.decisionlessStepIndexes).toEqual([1]);
    expect(
      verdict.criteria.find((c) => c.criterionId === "policy-every-executed-step-decided")?.status,
    ).toBe("FAIL");
  });

  test("a run-level unstated policy (null schedule/budget/tolerance) FAILs with all three named", () => {
    const verdict = deriveCanaryPolicyExplicitness({
      rampSchedule: null,
      failureBudget: null,
      tolerance: null,
      decisions: [],
      executedStepIndexes: [],
    });
    expect(verdict.explicit).toBe(false);
    expect(verdict.unstatedItems).toEqual([
      "ramp-schedule",
      "failure-budget",
      "divergence-tolerance",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Promotion lifecycle completeness
// ---------------------------------------------------------------------------

describe("VAL-035 derivePromotionLifecycleCompleteness", () => {
  const proposalId = "cand-lifecycle-test";
  const fullPrior: readonly LifecycleTransitionRecord[] = [
    priorTransition(proposalId, "offline-replayed", 1),
    priorTransition(proposalId, "differentially-evaluated", 2),
    priorTransition(proposalId, "shadow-executed", 3),
  ];
  const canariedAppend: LifecycleTransitionRecord = {
    proposalId,
    toStage: "canaried",
    evidenceDigest: longitudinalDigestOf(["canary-evidence", proposalId]),
    ordinal: 4,
  };
  const promotedAppend: LifecycleTransitionRecord = {
    proposalId,
    toStage: "promoted",
    evidenceDigest: longitudinalDigestOf(["promoted-evidence", proposalId]),
    ordinal: 5,
  };

  test("the full evidenced chain + the canaried→promoted append (one rung at a time) is COMPLETE", () => {
    const verdict = derivePromotionLifecycleCompleteness({
      priorTransitions: fullPrior,
      appendedTransitions: [canariedAppend, promotedAppend],
      expectedLanding: "promoted",
    });
    expect(verdict.complete).toBe(true);
    expect(verdict.appendedWalk).toEqual(["canaried", "promoted"]);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("the rollback landing (canaried only) is COMPLETE for an honest rollback", () => {
    const verdict = derivePromotionLifecycleCompleteness({
      priorTransitions: fullPrior,
      appendedTransitions: [canariedAppend],
      expectedLanding: "canaried",
    });
    expect(verdict.complete).toBe(true);
  });

  test("each SKIPPED prior stage FAILs (a skipped lifecycle never promotes)", () => {
    for (const skipped of [
      "offline-replayed",
      "differentially-evaluated",
      "shadow-executed",
    ] as const) {
      const brokenPrior = fullPrior.filter((transition) => transition.toStage !== skipped);
      const verdict = derivePromotionLifecycleCompleteness({
        priorTransitions: brokenPrior,
        appendedTransitions: [canariedAppend, promotedAppend],
        expectedLanding: "promoted",
      });
      expect(verdict.complete).toBe(false);
      expect(verdict.missingPriorStages).toEqual([skipped]);
      expect(
        verdict.criteria.find((c) => c.criterionId === "lifecycle-prior-walk-complete")?.status,
      ).toBe("FAIL");
    }
  });

  test("a BROKEN walk (out-of-order stages) FAILs even with every stage present", () => {
    const brokenPrior: readonly LifecycleTransitionRecord[] = [
      priorTransition(proposalId, "offline-replayed", 1),
      priorTransition(proposalId, "shadow-executed", 2),
      priorTransition(proposalId, "differentially-evaluated", 3),
    ];
    const verdict = derivePromotionLifecycleCompleteness({
      priorTransitions: brokenPrior,
      appendedTransitions: [canariedAppend],
      expectedLanding: "canaried",
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.brokenWalk).toBe(true);
  });

  test("an UNEVIDENCED prior transition FAILs", () => {
    const unevidenced: readonly LifecycleTransitionRecord[] = [
      priorTransition(proposalId, "offline-replayed", 1),
      priorTransition(proposalId, "differentially-evaluated", 2),
      { proposalId, toStage: "shadow-executed", evidenceDigest: "", ordinal: 3 },
    ];
    const verdict = derivePromotionLifecycleCompleteness({
      priorTransitions: unevidenced,
      appendedTransitions: [canariedAppend],
      expectedLanding: "canaried",
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.unevidencedPriorOrdinals).toEqual([3]);
  });

  test("a JUMPED rung (promoted appended without canaried) FAILs", () => {
    const verdict = derivePromotionLifecycleCompleteness({
      priorTransitions: fullPrior,
      appendedTransitions: [promotedAppend],
      expectedLanding: "promoted",
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.jumpedRungOrdinals).toEqual([5]);
    expect(
      verdict.criteria.find((c) => c.criterionId === "lifecycle-one-rung-at-a-time")?.status,
    ).toBe("FAIL");
  });

  test("a WRONG-STAGE landing and an EVIDENCE-LESS append each FAIL", () => {
    const wrongStage = derivePromotionLifecycleCompleteness({
      priorTransitions: fullPrior,
      appendedTransitions: [
        { proposalId, toStage: "property-tested", evidenceDigest: "aaaaaaaa", ordinal: 4 },
      ],
      expectedLanding: "none",
    });
    expect(wrongStage.complete).toBe(false);
    expect(wrongStage.wrongStageLandings).toEqual(["property-tested"]);
    const evidenceLess = derivePromotionLifecycleCompleteness({
      priorTransitions: fullPrior,
      appendedTransitions: [{ proposalId, toStage: "canaried", evidenceDigest: "", ordinal: 4 }],
      expectedLanding: "canaried",
    });
    expect(evidenceLess.complete).toBe(false);
    expect(evidenceLess.unevidencedAppendedOrdinals).toEqual([4]);
  });

  test("a LANDING-SHAPE mismatch (nothing appended where a landing was pinned) FAILs", () => {
    const verdict = derivePromotionLifecycleCompleteness({
      priorTransitions: fullPrior,
      appendedTransitions: [],
      expectedLanding: "promoted",
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.landingMatches).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Breach honesty
// ---------------------------------------------------------------------------

describe("VAL-035 deriveBreachHonesty", () => {
  const withinBudgetLeg = (stepIndex: number): CanaryBreachLeg => ({
    stepIndex,
    budgetLimit: 1,
    mechanicalDivergenceCaseIds: ["case-a"],
    recordedDivergenceCaseIds: ["case-a"],
    decisionKind: "advance",
    assertedDivergenceCount: 1,
    rollbackTriggered: false,
  });

  test("a WITHIN-BUDGET step advances honestly", () => {
    const verdict = deriveBreachHonesty({ steps: [withinBudgetLeg(1), withinBudgetLeg(2)] });
    expect(verdict.honest).toBe(true);
    expect(verdict.breachingStepIndexes).toEqual([]);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a BEYOND-BUDGET step with the breach-rollback decision + the triggered rollback is HONEST (the step FAILs honestly)", () => {
    const verdict = deriveBreachHonesty({
      steps: [
        withinBudgetLeg(1),
        {
          stepIndex: 2,
          budgetLimit: 0,
          mechanicalDivergenceCaseIds: ["case-a", "case-b"],
          recordedDivergenceCaseIds: ["case-a", "case-b"],
          decisionKind: "breach-rollback",
          assertedDivergenceCount: 2,
          rollbackTriggered: true,
        },
      ],
    });
    expect(verdict.honest).toBe(true);
    expect(verdict.breachingStepIndexes).toEqual([2]);
    // The breach observation FAILs honestly — the row FAILs, the run rolls back.
    const breachCriterion = verdict.criteria.find(
      (criterion) => criterion.criterionId === "breach-observed-beyond-budget",
    );
    expect(breachCriterion?.status).toBe("FAIL");
    expect(breachCriterion?.evidence.join(" ")).toContain("HONEST-BREACH");
  });

  test("a SMOOTHED BREACH (a beyond-budget step that advances anyway) FAILs", () => {
    const verdict = deriveBreachHonesty({
      steps: [
        {
          stepIndex: 1,
          budgetLimit: 0,
          mechanicalDivergenceCaseIds: ["case-a"],
          recordedDivergenceCaseIds: ["case-a"],
          decisionKind: "advance",
          assertedDivergenceCount: 0,
          rollbackTriggered: false,
        },
      ],
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.smoothedBreachStepIndexes).toEqual([1]);
    expect(verdict.countSmoothedStepIndexes).toEqual([1]);
    expect(
      verdict.criteria.find((c) => c.criterionId === "breach-beyond-budget-rolls-back")?.status,
    ).toBe("FAIL");
  });

  test("a BREACH-ROLLBACK decision WITHOUT the rollback trigger FAILs (uncontrolled)", () => {
    const verdict = deriveBreachHonesty({
      steps: [
        {
          stepIndex: 1,
          budgetLimit: 0,
          mechanicalDivergenceCaseIds: ["case-a"],
          recordedDivergenceCaseIds: ["case-a"],
          decisionKind: "breach-rollback",
          assertedDivergenceCount: 1,
          rollbackTriggered: false,
        },
      ],
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.uncontrolledRollbackStepIndexes).toEqual([1]);
  });

  test("an UNJUSTIFIED rollback (a within-budget step that rolls back) FAILs", () => {
    const verdict = deriveBreachHonesty({
      steps: [
        {
          stepIndex: 1,
          budgetLimit: 2,
          mechanicalDivergenceCaseIds: ["case-a"],
          recordedDivergenceCaseIds: ["case-a"],
          decisionKind: "breach-rollback",
          assertedDivergenceCount: 1,
          rollbackTriggered: true,
        },
      ],
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.unjustifiedRollbackStepIndexes).toEqual([1]);
    expect(
      verdict.criteria.find((c) => c.criterionId === "breach-within-budget-advances")?.status,
    ).toBe("FAIL");
  });

  test("a RECORDED-count mismatch (the ledger contradicts the per-case record) FAILs", () => {
    const verdict = deriveBreachHonesty({
      steps: [
        {
          stepIndex: 1,
          budgetLimit: 5,
          mechanicalDivergenceCaseIds: ["case-a", "case-b"],
          recordedDivergenceCaseIds: ["case-a"],
          decisionKind: "advance",
          assertedDivergenceCount: 2,
          rollbackTriggered: false,
        },
      ],
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.recordMismatchStepIndexes).toEqual([1]);
  });

  test("a step WITHOUT its decision FAILs (missing decision)", () => {
    const verdict = deriveBreachHonesty({
      steps: [
        {
          stepIndex: 1,
          budgetLimit: 1,
          mechanicalDivergenceCaseIds: [],
          recordedDivergenceCaseIds: [],
          decisionKind: null,
          assertedDivergenceCount: null,
          rollbackTriggered: false,
        },
      ],
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.missingDecisionStepIndexes).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// Rollback completeness
// ---------------------------------------------------------------------------

describe("VAL-035 deriveRollbackCompleteness", () => {
  test("a demanded rollback with the recorded + EXERCISED complete revert is COMPLETE", () => {
    const verdict = deriveRollbackCompleteness({
      rollbackDemanded: true,
      planRecorded: true,
      rollbackEvents: [{ ordinal: 1, stepIndex: 1, residualReplacementCaseIds: [] }],
      sliceCaseIdsAtBreach: ["case-a", "case-b"],
    });
    expect(verdict.complete).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a PARTIAL rollback (a residual case still serving the replacement) FAILs with the residual named", () => {
    const verdict = deriveRollbackCompleteness({
      rollbackDemanded: true,
      planRecorded: true,
      rollbackEvents: [{ ordinal: 1, stepIndex: 1, residualReplacementCaseIds: ["case-b"] }],
      sliceCaseIdsAtBreach: ["case-a", "case-b"],
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.residualReplacementCaseIds).toEqual(["case-b"]);
    const partial = verdict.criteria.find(
      (criterion) => criterion.criterionId === "rollback-complete-mechanical",
    );
    expect(partial?.status).toBe("FAIL");
    expect(partial?.evidence.join(" ")).toContain("PARTIAL-ROLLBACK");
    expect(partial?.evidence.join(" ")).toContain("case-b");
  });

  test("an UNEXERCISED plan (a demanded rollback with no event) FAILs", () => {
    const verdict = deriveRollbackCompleteness({
      rollbackDemanded: true,
      planRecorded: true,
      rollbackEvents: [],
      sliceCaseIdsAtBreach: ["case-a"],
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.criteria.find((c) => c.criterionId === "rollback-plan-exercised")?.status).toBe(
      "FAIL",
    );
  });

  test("an UNRECORDED plan FAILs (production promotion must be reversible)", () => {
    const verdict = deriveRollbackCompleteness({
      rollbackDemanded: true,
      planRecorded: false,
      rollbackEvents: [{ ordinal: 1, stepIndex: 1, residualReplacementCaseIds: [] }],
      sliceCaseIdsAtBreach: ["case-a"],
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.criteria.find((c) => c.criterionId === "rollback-plan-recorded")?.status).toBe(
      "FAIL",
    );
  });

  test("a clean promotion (no demand, recorded plan, no events) is COMPLETE; an UNJUSTIFIED event FAILs", () => {
    const clean = deriveRollbackCompleteness({
      rollbackDemanded: false,
      planRecorded: true,
      rollbackEvents: [],
      sliceCaseIdsAtBreach: [],
    });
    expect(clean.complete).toBe(true);
    const unjustified = deriveRollbackCompleteness({
      rollbackDemanded: false,
      planRecorded: true,
      rollbackEvents: [{ ordinal: 1, stepIndex: 2, residualReplacementCaseIds: [] }],
      sliceCaseIdsAtBreach: [],
    });
    expect(unjustified.complete).toBe(false);
    expect(unjustified.unjustifiedEventOrdinals).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// Slice isolation
// ---------------------------------------------------------------------------

describe("VAL-035 deriveSliceIsolation", () => {
  test("a within-slice serve at every step is ISOLATED (the exact pinned membership)", () => {
    const verdict = deriveSliceIsolation({
      steps: withinSliceSteps([0.05, 0.25, 0.5, 1]),
      promoted: false,
      postPromotionServedReplacementCaseIds: null,
      populationCaseIds: RAG_CASE_IDS,
    });
    expect(verdict.isolated).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("an OVER-SLICE serve (a case beyond the pinned slice) FAILs with the case named", () => {
    const steps = withinSliceSteps([0.25]);
    const baseStep = steps[0];
    if (baseStep === undefined) {
      throw new Error("the slice-serve step is missing");
    }
    const overServeCaseId = RAG_CASE_IDS[5] ?? "rag-case-5-fallback";
    const overServed = [...baseStep.servedReplacementCaseIds, overServeCaseId];
    const verdict = deriveSliceIsolation({
      steps: [{ ...baseStep, servedReplacementCaseIds: overServed }],
      promoted: false,
      postPromotionServedReplacementCaseIds: null,
      populationCaseIds: RAG_CASE_IDS,
    });
    expect(verdict.isolated).toBe(false);
    expect(verdict.overSliceCaseIds.length).toBe(1);
    expect(verdict.overSliceCaseIds[0]).toContain(overServeCaseId);
    const overSlice = verdict.criteria.find(
      (criterion) => criterion.criterionId === "slice-no-over-slice-serve",
    );
    expect(overSlice?.status).toBe("FAIL");
    expect(overSlice?.evidence.join(" ")).toContain("OVER-SLICE");
  });

  test("an OUT-OF-SLICE TENANT served the replacement FAILs with the tenant named", () => {
    // Serve a foreign case whose tenant is derived outside the granted slice.
    const foreignCaseId = "foreign-tenant-case";
    const steps = withinSliceSteps([0.25]);
    const baseStep = steps[0];
    if (baseStep === undefined) {
      throw new Error("the slice-serve step is missing");
    }
    const verdict = deriveSliceIsolation({
      steps: [
        {
          ...baseStep,
          servedReplacementCaseIds: [...baseStep.servedReplacementCaseIds, foreignCaseId],
          servedReplacementTenantIds: [
            ...baseStep.servedReplacementTenantIds,
            canaryTenantIdOf(foreignCaseId),
          ],
        },
      ],
      promoted: false,
      postPromotionServedReplacementCaseIds: null,
      populationCaseIds: RAG_CASE_IDS,
    });
    expect(verdict.isolated).toBe(false);
    expect(verdict.outOfSliceTenantIds.length).toBeGreaterThan(0);
    expect(verdict.outOfSliceTenantIds[0]).toContain(canaryTenantIdOf(foreignCaseId));
    expect(
      verdict.criteria.find((c) => c.criterionId === "slice-no-out-of-slice-tenant")?.status,
    ).toBe("FAIL");
  });

  test("an UNDER-SERVE breaks the ramp's pinned adherence and FAILs", () => {
    const steps = withinSliceSteps([0.5]);
    const underServeStep = steps[0];
    if (underServeStep === undefined) {
      throw new Error("the under-serve step is missing");
    }
    const verdict = deriveSliceIsolation({
      steps: [
        {
          ...underServeStep,
          servedReplacementCaseIds: underServeStep.servedReplacementCaseIds.slice(0, 1),
        },
      ],
      promoted: false,
      postPromotionServedReplacementCaseIds: null,
      populationCaseIds: RAG_CASE_IDS,
    });
    expect(verdict.isolated).toBe(false);
    expect(verdict.underServedStepIndexes).toEqual([1]);
    expect(verdict.criteria.find((c) => c.criterionId === "slice-ramp-adherence")?.status).toBe(
      "FAIL",
    );
  });

  test("the POST-PROMOTION full serve is legal (only after the promoted rung)", () => {
    const verdict = deriveSliceIsolation({
      steps: [],
      promoted: true,
      postPromotionServedReplacementCaseIds: RAG_CASE_IDS,
      populationCaseIds: RAG_CASE_IDS,
    });
    expect(verdict.postPromotionServeLegal).toBe(true);
    expect(verdict.isolated).toBe(true);
    const foreign = deriveSliceIsolation({
      steps: [],
      promoted: true,
      postPromotionServedReplacementCaseIds: [...RAG_CASE_IDS, "foreign-case"],
      populationCaseIds: RAG_CASE_IDS,
    });
    expect(foreign.postPromotionServeLegal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Canary cost separation
// ---------------------------------------------------------------------------

describe("VAL-035 deriveCanaryCostSeparation", () => {
  test("a measured canary cost booked apart under its marker is SEPARATED", () => {
    const verdict = deriveCanaryCostSeparation({
      incumbentCostMicroUsd: 25,
      canaryCostMicroUsd: 11,
      servedTotalMicroUsd: 25,
      canaryLedgerBookedMicroUsd: 11,
      canaryMarkerPresent: true,
    });
    expect(verdict.separated).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a BILLED canary (the served total inflated by the canary cost) FAILs with the delta named", () => {
    const verdict = deriveCanaryCostSeparation({
      incumbentCostMicroUsd: 25,
      canaryCostMicroUsd: 11,
      servedTotalMicroUsd: 36,
      canaryLedgerBookedMicroUsd: 11,
      canaryMarkerPresent: true,
    });
    expect(verdict.separated).toBe(false);
    expect(verdict.billed).toBe(true);
    const billed = verdict.criteria.find((c) => c.criterionId === "canary-cost-never-billed");
    expect(billed?.status).toBe("FAIL");
    expect(billed?.evidence.join(" ")).toContain("BILLED-CANARY");
  });

  test("an UNMARKED booking (a canary cost billed as ordinary served traffic) FAILs", () => {
    const verdict = deriveCanaryCostSeparation({
      incumbentCostMicroUsd: 25,
      canaryCostMicroUsd: 11,
      servedTotalMicroUsd: 25,
      canaryLedgerBookedMicroUsd: 11,
      canaryMarkerPresent: false,
    });
    expect(verdict.separated).toBe(false);
    expect(verdict.markerMissing).toBe(true);
    expect(
      verdict.criteria.find((c) => c.criterionId === "canary-cost-marker-present")?.status,
    ).toBe("FAIL");
  });

  test("an UNMEASURED and an UNBOOKED canary cost each FAIL", () => {
    const unmeasured = deriveCanaryCostSeparation({
      incumbentCostMicroUsd: 25,
      canaryCostMicroUsd: null,
      servedTotalMicroUsd: 25,
      canaryLedgerBookedMicroUsd: null,
      canaryMarkerPresent: null,
    });
    expect(unmeasured.unmeasured).toBe(true);
    expect(unmeasured.separated).toBe(false);
    const unbooked = deriveCanaryCostSeparation({
      incumbentCostMicroUsd: 25,
      canaryCostMicroUsd: 11,
      servedTotalMicroUsd: 25,
      canaryLedgerBookedMicroUsd: null,
      canaryMarkerPresent: null,
    });
    expect(unbooked.unbooked).toBe(true);
    expect(unbooked.separated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Containment carry-over + the verdict ranking
// ---------------------------------------------------------------------------

describe("VAL-035 containment carry-over (mid-canary isolation)", () => {
  test("an escape DURING the canary is a containment violation that FAILs", () => {
    const verdict = deriveReplacementIsolation({
      declaredCapabilities: ["pure-computation"],
      grantedSurface: ["pure-computation"],
      exercisedCapabilities: ["pure-computation", "network-access"],
    });
    expect(verdict.contained).toBe(false);
    expect(verdict.escapeDirections).toContain("network-access");
    expect(ISOLATION_ESCAPE_DIRECTIONS).toContain("network-access");
  });

  test("the canary verdict kind ranks a mid-canary escape as a containment violation", () => {
    const row = rowById("rag-deterministic-function-clean-promotion");
    const escapeVerdict = deriveReplacementIsolation({
      declaredCapabilities: row.declaredCapabilities,
      grantedSurface: row.grantedIsolationSurface,
      exercisedCapabilities: [...row.declaredCapabilities, "network-access"],
    });
    const verdict = deriveCanaryVerdictKind({
      refusal: null,
      isolation: escapeVerdict,
      policyExplicitness: null,
      lifecycleCompleteness: null,
      breachHonesty: null,
      rollbackCompleteness: null,
      sliceIsolation: null,
      costSeparation: null,
    });
    expect(verdict).toBe("containment-violation");
  });

  test("the verdict ranking: refusal > containment > invalid > honest rollback > clean promotion", () => {
    const row = rowById("rag-deterministic-function-clean-promotion");
    const contained = deriveReplacementIsolation({
      declaredCapabilities: row.declaredCapabilities,
      grantedSurface: row.grantedIsolationSurface,
      exercisedCapabilities: row.declaredCapabilities,
    });
    const passDerivations = {
      refusal: null,
      isolation: contained,
      policyExplicitness: deriveCanaryPolicyExplicitness({
        rampSchedule: row.rampSchedule,
        failureBudget: row.failureBudget,
        tolerance: row.acceptanceCriterion,
        decisions: row.rampSchedule.map((step) =>
          explicitLeg(step.stepIndex, rampScheduleDigestOf(row.rampSchedule)),
        ),
        executedStepIndexes: row.rampSchedule.map((step) => step.stepIndex),
      }),
      lifecycleCompleteness: derivePromotionLifecycleCompleteness({
        priorTransitions: [
          priorTransition(row.sourceProposalId, "offline-replayed", 1),
          priorTransition(row.sourceProposalId, "differentially-evaluated", 2),
          priorTransition(row.sourceProposalId, "shadow-executed", 3),
        ],
        appendedTransitions: [
          {
            proposalId: row.sourceProposalId,
            toStage: "canaried",
            evidenceDigest: "aaaaaaaa",
            ordinal: 4,
          },
          {
            proposalId: row.sourceProposalId,
            toStage: "promoted",
            evidenceDigest: "bbbbbbbb",
            ordinal: 5,
          },
        ],
        expectedLanding: "promoted",
      }),
      breachHonesty: deriveBreachHonesty({
        steps: row.rampSchedule.map((step) => ({
          stepIndex: step.stepIndex,
          budgetLimit: row.failureBudget.maxDivergencesPerStep,
          mechanicalDivergenceCaseIds: [],
          recordedDivergenceCaseIds: [],
          decisionKind: "advance" as const,
          assertedDivergenceCount: 0,
          rollbackTriggered: false,
        })),
      }),
      rollbackCompleteness: deriveRollbackCompleteness({
        rollbackDemanded: false,
        planRecorded: true,
        rollbackEvents: [],
        sliceCaseIdsAtBreach: [],
      }),
      sliceIsolation: deriveSliceIsolation({
        steps: withinSliceSteps(row.rampSchedule.map((step) => step.trafficFraction)),
        promoted: false,
        postPromotionServedReplacementCaseIds: null,
        populationCaseIds: RAG_CASE_IDS,
      }),
      costSeparation: deriveCanaryCostSeparation({
        incumbentCostMicroUsd: 25,
        canaryCostMicroUsd: 11,
        servedTotalMicroUsd: 25,
        canaryLedgerBookedMicroUsd: 11,
        canaryMarkerPresent: true,
      }),
    };
    expect(deriveCanaryVerdictKind(passDerivations)).toBe("clean-promotion");
    expect(
      deriveCanaryVerdictKind({
        ...passDerivations,
        breachHonesty: deriveBreachHonesty({
          steps: [
            {
              stepIndex: 1,
              budgetLimit: 0,
              mechanicalDivergenceCaseIds: ["case-a"],
              recordedDivergenceCaseIds: ["case-a"],
              decisionKind: "breach-rollback",
              assertedDivergenceCount: 1,
              rollbackTriggered: true,
            },
          ],
        }),
      }),
    ).toBe("honest-rollback");
    expect(deriveCanaryVerdictKind({ ...passDerivations, sliceIsolation: null })).toBe(
      "canary-invalid",
    );
    expect(
      deriveCanaryVerdictKind({
        ...passDerivations,
        refusal: { reason: "candidate-unregistered" },
      }),
    ).toBe("honest-refusal");
  });
});

// ---------------------------------------------------------------------------
// Refusal honesty
// ---------------------------------------------------------------------------

describe("VAL-035 deriveCanaryRefusalHonesty", () => {
  test("an unregistered candidate justifies the unregistered refusal", () => {
    const verdict = deriveCanaryRefusalHonesty({
      refusal: { reason: "candidate-unregistered" },
      canaryExecuted: false,
      registryEntry: null,
    });
    expect(verdict.honest).toBe(true);
    expect(verdict.justified).toBe(true);
  });

  test("a walk that never reached shadow-executed justifies the premature refusal", () => {
    const verdict = deriveCanaryRefusalHonesty({
      refusal: { reason: "candidate-not-shadow-executed" },
      canaryExecuted: false,
      registryEntry: {
        lifecycleStage: "differentially-evaluated",
        walkEndsAtShadowExecuted: false,
      },
    });
    expect(verdict.honest).toBe(true);
  });

  test("a refusal that HIDES a canaryable candidate FAILs (unjustified)", () => {
    const verdict = deriveCanaryRefusalHonesty({
      refusal: { reason: "candidate-not-shadow-executed" },
      canaryExecuted: false,
      registryEntry: {
        lifecycleStage: "shadow-executed",
        walkEndsAtShadowExecuted: true,
      },
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.justified).toBe(false);
    expect(verdict.criteria.find((c) => c.criterionId === "canary-refusal-justified")?.status).toBe(
      "FAIL",
    );
  });

  test("a refusal accompanied by a canary execution is a MALFORMED outcome", () => {
    const verdict = deriveCanaryRefusalHonesty({
      refusal: { reason: "candidate-unregistered" },
      canaryExecuted: true,
      registryEntry: null,
    });
    expect(verdict.honest).toBe(false);
    expect(
      verdict.criteria.find((c) => c.criterionId === "canary-refusal-well-formed")?.status,
    ).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// Digest + identity determinism
// ---------------------------------------------------------------------------

describe("VAL-035 digest + identity determinism", () => {
  test("every canary digest is deterministic, 8-hex and payload-free", () => {
    const decision = {
      proposalId: "cand-digest-test",
      stepIndex: 1,
      kind: "advance" as const,
      sliceFraction: 0.25,
      observedDivergenceCount: 0,
      budgetLimit: 1,
      policyCitations: {
        rampScheduleDigest: rampScheduleDigestOf(WELL_FORMED_RAMP),
        failureBudgetStated: true,
        toleranceStated: true,
      },
      policyChecks: { rampChecked: true, budgetChecked: true, toleranceChecked: true },
    };
    const digests = [
      canaryDecisionDigestOf(decision),
      canaryDivergenceDigestOf({
        proposalId: decision.proposalId,
        stepIndex: 1,
        caseId: "case-a",
        incumbentDigest: "aaaaaaaa",
        replacementDigest: "bbbbbbbb",
      }),
      canaryCostDigestOf({
        proposalId: decision.proposalId,
        marker: "canary",
        microUsd: 11,
        latencyMs: 22,
      }),
      rollbackPlanDigestOf({
        proposalId: decision.proposalId,
        revertsServingTo: "incumbent",
        scopeFraction: 1,
      }),
      rollbackEventDigestOf({
        proposalId: decision.proposalId,
        stepIndex: 1,
        planDigest: "cccccccc",
        residualReplacementCaseIds: [],
      }),
      rampScheduleDigestOf(WELL_FORMED_RAMP),
      failureBudgetDigestOf({ maxDivergencesPerStep: 1 }),
      canarySliceDigestOf({
        proposalId: decision.proposalId,
        stepIndex: 1,
        sliceCaseIds: ["case-a"],
      }),
    ];
    for (const digest of digests) {
      expect(digest).toMatch(/^[0-9a-f]{8}$/);
      expect(canaryDecisionDigestOf(decision)).toBe(canaryDecisionDigestOf(decision));
    }
    expect(new Set(digests).size).toBe(digests.length);
  });

  test("the digests DISCRIMINATE (a changed input changes the digest)", () => {
    const base = rampScheduleDigestOf(WELL_FORMED_RAMP);
    const changed = rampScheduleDigestOf([
      { stepIndex: 1, trafficFraction: 0.05 },
      { stepIndex: 2, trafficFraction: 0.25 },
      { stepIndex: 3, trafficFraction: 0.5 },
      { stepIndex: 4, trafficFraction: 1 },
      { stepIndex: 5, trafficFraction: 1.5 },
    ]);
    expect(base).not.toBe(changed);
    expect(
      rollbackPlanDigestOf({
        proposalId: "cand-a",
        revertsServingTo: "incumbent",
        scopeFraction: 1,
      }),
    ).not.toBe(
      rollbackPlanDigestOf({
        proposalId: "cand-b",
        revertsServingTo: "incumbent",
        scopeFraction: 1,
      }),
    );
  });

  test("the slice membership + the tenant identity are deterministic pure functions", () => {
    expect(sliceCaseIdsOf(RAG_CASE_IDS, 1)).toEqual([...RAG_CASE_IDS].sort());
    expect(sliceCaseIdsOf(RAG_CASE_IDS, 0.05)).toEqual([
      [...RAG_CASE_IDS].sort()[0] ?? "rag-case-0-fallback",
    ]);
    expect(sliceCaseIdsOf(RAG_CASE_IDS, 0.05)).toEqual(sliceCaseIdsOf(RAG_CASE_IDS, 0.05));
    expect(canaryTenantIdOf("case-a")).toBe(canaryTenantIdOf("case-a"));
    expect(canaryTenantIdOf("case-a")).toMatch(/^tenant-\d+$/);
    const reference = referenceCanaryMeasurementOf(["case-a", "case-b"]);
    expect(reference.microUsd).toBe(5);
    expect(reference.latencyMs).toBe(10);
  });

  test("the trajectory digest is deterministic over the canonical canary steps", () => {
    const steps = canaryTrajectoryStepsOf({
      proposalId: "cand-traj-test",
      populationDigest: "12345678",
      steps: [
        {
          stepIndex: 1,
          sliceDigest: "87654321",
          decisionKind: "advance",
          divergenceCount: 0,
          rollbackExercised: false,
        },
        {
          stepIndex: 2,
          sliceDigest: "87654322",
          decisionKind: "breach-rollback",
          divergenceCount: 2,
          rollbackExercised: true,
        },
      ],
      canaryCostDigest: "abcdef01",
      landedStages: ["canaried"],
      refusalReason: null,
      confirmationRounds: 0,
    });
    expect(steps.length).toBeGreaterThan(5);
    expect(trajectoryDigestOf(steps)).toBe(
      trajectoryDigestOf(
        canaryTrajectoryStepsOf({
          proposalId: "cand-traj-test",
          populationDigest: "12345678",
          steps: [
            {
              stepIndex: 1,
              sliceDigest: "87654321",
              decisionKind: "advance",
              divergenceCount: 0,
              rollbackExercised: false,
            },
            {
              stepIndex: 2,
              sliceDigest: "87654322",
              decisionKind: "breach-rollback",
              divergenceCount: 2,
              rollbackExercised: true,
            },
          ],
          canaryCostDigest: "abcdef01",
          landedStages: ["canaried"],
          refusalReason: null,
          confirmationRounds: 0,
        }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Append-only ledgers
// ---------------------------------------------------------------------------

describe("VAL-035 append-only ledgers", () => {
  test("the lifecycle ledger replays the identical canary append and refuses the impostor", async () => {
    const ledger = createLifecycleLedger();
    const record = {
      proposalId: "cand-ledger-test",
      toStage: "canaried" as const,
      evidenceDigest: "aaaaaaaa",
    };
    const first = await ledger.append(record);
    expect(first.accepted).toBe(true);
    expect(first.replayed).toBe(false);
    const replay = await ledger.append(record);
    expect(replay.replayed).toBe(true);
    const impostor = await ledger.append({ ...record, evidenceDigest: "bbbbbbbb" });
    expect(impostor.refused).toBe(true);
    expect(ledger.transitionsFor("cand-ledger-test").length).toBe(1);
  });

  test("the canary ledger replays the identical decision + cost bookings and refuses impostors", async () => {
    const ledger = createCanaryLedger();
    const decision = {
      proposalId: "cand-canary-ledger-test",
      stepIndex: 1,
      kind: "advance" as const,
      sliceFraction: 0.25,
      observedDivergenceCount: 0,
      budgetLimit: 1,
      policyCitations: {
        rampScheduleDigest: rampScheduleDigestOf(WELL_FORMED_RAMP),
        failureBudgetStated: true,
        toleranceStated: true,
      },
      policyChecks: { rampChecked: true, budgetChecked: true, toleranceChecked: true },
    };
    expect((await ledger.appendDecision(decision)).accepted).toBe(true);
    expect((await ledger.appendDecision(decision)).replayed).toBe(true);
    expect((await ledger.appendDecision({ ...decision, observedDivergenceCount: 3 })).refused).toBe(
      true,
    );
    expect(ledger.decisionsFor(decision.proposalId).length).toBe(1);

    const cost = {
      proposalId: decision.proposalId,
      marker: "canary" as const,
      microUsd: 11,
      latencyMs: 22,
    };
    expect((await ledger.bookCanaryCost(cost)).accepted).toBe(true);
    expect((await ledger.bookCanaryCost(cost)).replayed).toBe(true);
    expect(ledger.canaryCostsFor(decision.proposalId).length).toBe(1);

    const rollbackEvent = {
      proposalId: decision.proposalId,
      stepIndex: 2,
      planDigest: "cccccccc",
      residualReplacementCaseIds: [],
    };
    expect((await ledger.appendRollbackEvent(rollbackEvent)).accepted).toBe(true);
    expect((await ledger.appendRollbackEvent(rollbackEvent)).replayed).toBe(true);
    expect(ledger.rollbackEventsFor(decision.proposalId).length).toBe(1);
  });

  test("the lifecycle ledger pre-seeds the recorded VAL-033 + VAL-034 walk for every canaried candidate", () => {
    const ledger = createLifecycleLedger();
    for (const row of CANARY_PROMOTION_CORPUS) {
      if (row.expected.refusalReason === null) {
        const walk = ledger.transitionsFor(row.sourceProposalId).map((t) => t.toStage);
        expect(walk).toEqual(["offline-replayed", "differentially-evaluated", "shadow-executed"]);
      }
    }
    // The not-yet-shadow-executed entry's walk ends one rung short.
    const notYetRow = rowById("not-yet-shadow-executed-canary-refusal");
    expect(ledger.transitionsFor(notYetRow.sourceProposalId).map((t) => t.toStage)).toEqual([
      "offline-replayed",
      "differentially-evaluated",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The driver over the honest fake world
// ---------------------------------------------------------------------------

describe("VAL-035 driver over the honest fake world", () => {
  test.each(OFFLINE_CORPUS_ROWS.map((row) => [row.rowId, row] as const))(
    "the honest driver reproduces the pinned verdict for %s",
    async (_rowId, row) => {
      const result = await driveRowOverStack({ row });
      expect(result.verdict).toBe(row.expected.verdict);
      expect(result.terminal).toBe(row.expected.terminal);
      expect(result.refusal?.reason ?? null).toBe(row.expected.refusalReason);
      if (row.expected.verdict === "honest-rollback") {
        // Only the honest-breach criterion FAILs — everything else is honest.
        const failing = result.criteria.filter((criterion) => criterion.status === "FAIL");
        expect(failing.map((criterion) => criterion.criterionId)).toEqual([
          "breach-observed-beyond-budget",
        ]);
        expect(failing[0]?.evidence.join(" ")).toContain("HONEST-BREACH");
      } else {
        expect(result.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
      }
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      const observedFinalStage =
        result.landings.promoted !== null
          ? "promoted"
          : result.landings.canaried !== null
            ? "canaried"
            : null;
      expect(observedFinalStage).toBe(row.expected.finalStage);
      if (row.expected.verdict === "honest-refusal") {
        expect(result.decisionsAppended).toBe(0);
        expect(result.rollbackEventsAppended).toBe(0);
      }
    },
  );

  test("an honest rollback lands ONLY the canaried rung, exercises the rollback and books the canary cost", async () => {
    const row = rowById("reuse-removed-call-budget-breach-rollback");
    const result = await driveRowOverStack({ row });
    expect(result.verdict).toBe("honest-rollback");
    expect(result.landings.canaried?.accepted).toBe(true);
    expect(result.landings.promoted).toBeNull();
    expect(result.rollbackEventsAppended).toBe(1);
    expect(result.rollbackCompleteness?.rollbackExercised).toBe(true);
    expect(result.rollbackCompleteness?.residualReplacementCaseIds).toEqual([]);
    expect(result.canaryCostBooked).toBe(true);
    expect(result.costSeparation?.separated).toBe(true);
    expect(result.breachHonesty?.breachingStepIndexes).toEqual([1]);
    expect(result.lifecycleCompleteness?.appendedWalk).toEqual(["canaried"]);
    // The ramp stopped at the breaching step: one decision only.
    expect(result.decisionsAppended).toBe(1);
    expect(result.divergencesAppended).toBe(1);
  });

  test("a clean promotion lands canaried THEN promoted with the full ramp decided", async () => {
    const row = rowById("rag-deterministic-function-clean-promotion");
    const result = await driveRowOverStack({ row });
    expect(result.landings.canaried?.accepted).toBe(true);
    expect(result.landings.promoted?.accepted).toBe(true);
    expect(result.decisionsAppended).toBe(4);
    expect(result.rollbackEventsAppended).toBe(0);
    expect(result.rollbackCompleteness?.planRecorded).toBe(true);
    expect(result.lifecycleCompleteness?.appendedWalk).toEqual(["canaried", "promoted"]);
    expect(result.breachHonesty?.breachingStepIndexes).toEqual([]);
  });

  test("a live row without a dispatch seam is a configuration error; with one it completes measured", async () => {
    const row = CANARY_PROMOTION_CORPUS.find((candidate) => candidate.needsDispatch);
    expect(row).toBeDefined();
    const liveRow = row as CanaryCorpusRow;
    const clock = createTickClock();
    const registry = createCandidateRegistry();
    const servingPath = createCanaryServingPath();
    await expect(
      driveCanaryRun({
        row: liveRow,
        registry,
        lifecycle: createLifecycleLedger({ registry }),
        canaryLedger: createCanaryLedger({ servingPath }),
        incumbentExecutor: createIncumbentExecutor(),
        trafficSource: createTrafficSource(),
        servingPath,
        canaryRuntime: createCanaryRuntime(),
        now: clock.now,
      }),
    ).rejects.toThrow(/dispatch seam/);

    const dispatch: ControlDispatch = async () => ({
      kind: "success" as const,
      usage: { inputTokens: 30, outputTokens: 6, costUsd: 0.000022 },
      latencyMs: 12,
    });
    const result = await driveRowOverStack({ row: liveRow, dispatch });
    expect(result.verdict).toBe("clean-promotion");
    expect(result.terminal).toBe("COMPLETED");
    expect(result.observedModelCalls).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 6, costUsd: 0.000022 });
  });

  test("a dispatch FAILURE on the live row FAILs honestly (never a fabricated completion)", async () => {
    const row = CANARY_PROMOTION_CORPUS.find((candidate) => candidate.needsDispatch);
    const liveRow = row as CanaryCorpusRow;
    const dispatch: ControlDispatch = async () => ({
      kind: "failure" as const,
      category: "provider-unavailable",
      message: "the model gateway is unreachable",
      latencyMs: 3,
    });
    const result = await driveRowOverStack({ row: liveRow, dispatch });
    expect(result.terminal).toBe("FAILED");
    expect(result.failure?.category).toBe("provider-unavailable");
    expect(result.observedModelCalls).toBe(0);
  });

  test("an honest re-drive REPLAYS the canary walk (append-only idempotence)", async () => {
    const row = rowById("rag-deterministic-function-clean-promotion");
    const clock = createTickClock();
    const registry = createCandidateRegistry();
    const servingPath = createCanaryServingPath();
    const lifecycle = createLifecycleLedger({ registry });
    const canaryLedger = createCanaryLedger({ servingPath });
    const stackArgs = {
      row,
      registry,
      lifecycle,
      canaryLedger,
      incumbentExecutor: createIncumbentExecutor(),
      trafficSource: createTrafficSource(),
      servingPath,
      canaryRuntime: createCanaryRuntime(),
      now: clock.now,
    };
    const first = await driveCanaryRun(stackArgs);
    const second = await driveCanaryRun(stackArgs);
    expect(first.terminal).toBe("COMPLETED");
    expect(second.terminal).toBe("COMPLETED");
    expect(second.landings.canaried?.replayed).toBe(true);
    expect(second.landings.promoted?.replayed).toBe(true);
    expect(lifecycle.transitionsFor(row.sourceProposalId).length).toBe(5);
    expect(canaryLedger.decisionsFor(row.sourceProposalId).length).toBe(4);
    // The registry is unchanged by both runs.
    expect(registry.digest()).toBe(registry.digest());
  });
});

// ---------------------------------------------------------------------------
// Adversarial canary worlds
// ---------------------------------------------------------------------------

describe("VAL-035 adversarial canary worlds", () => {
  test("an ESCAPING runtime (network access mid-canary) is a containment violation that never lands", async () => {
    const row = rowById("probe-mid-canary-escape");
    const result = await driveRowOverStack({ row, runtimeVariant: "escaping" });
    expect(result.verdict).toBe("containment-violation");
    expect(result.terminal).toBe("FAILED");
    expect(result.isolation?.contained).toBe(false);
    expect(result.landings.canaried).toBeNull();
    expect(result.landings.promoted).toBeNull();
    expect(
      result.criteria.some(
        (criterion) =>
          criterion.criterionId === "isolation-no-escape" && criterion.status === "FAIL",
      ),
    ).toBe(true);
  });

  test("an OVER-SLICE serving path (the replacement served beyond the pinned slice) FAILs and never lands", async () => {
    const row = rowById("probe-over-slice");
    const result = await driveRowOverStack({ row, servingVariant: "over-slice" });
    expect(result.verdict).toBe("canary-invalid");
    expect(result.sliceIsolation?.isolated).toBe(false);
    expect(result.sliceIsolation?.overSliceCaseIds.length).toBeGreaterThan(0);
    expect(result.landings.canaried).toBeNull();
    expect(
      result.criteria.some(
        (criterion) =>
          criterion.criterionId === "slice-no-over-slice-serve" && criterion.status === "FAIL",
      ),
    ).toBe(true);
  });

  test("a PARTIAL-ROLLBACK serving path (a residual case still serving the replacement) FAILs", async () => {
    const row = rowById("probe-partial-rollback");
    const result = await driveRowOverStack({ row, servingVariant: "partial-rollback" });
    expect(result.verdict).toBe("canary-invalid");
    expect(result.rollbackCompleteness?.complete).toBe(false);
    expect(result.rollbackCompleteness?.residualReplacementCaseIds.length).toBe(1);
    const partial = result.criteria.find(
      (criterion) => criterion.criterionId === "rollback-complete-mechanical",
    );
    expect(partial?.status).toBe("FAIL");
    expect(partial?.evidence.join(" ")).toContain("PARTIAL-ROLLBACK");
    expect(result.landings.canaried).toBeNull();
  });

  test("a JUMP-TO-PROMOTED ledger (the append skips the canaried rung) FAILs the lifecycle completeness", async () => {
    const row = rowById("probe-skipped-lifecycle");
    const result = await driveRowOverStack({ row, ledgerVariant: "jump-to-promoted" });
    expect(result.verdict).toBe("canary-invalid");
    expect(result.lifecycleCompleteness?.jumpedRungOrdinals.length).toBeGreaterThan(0);
    expect(result.landings.promoted).not.toBeNull();
    expect(result.terminal).toBe("FAILED");
    expect(
      result.criteria.some(
        (criterion) =>
          criterion.criterionId === "lifecycle-one-rung-at-a-time" && criterion.status === "FAIL",
      ),
    ).toBe(true);
  });

  test("a BROKEN-WALK ledger (the shadow rung dropped) makes the honest run refuse where the row pinned a promotion", async () => {
    const row = rowById("probe-skipped-lifecycle");
    const result = await driveRowOverStack({ row, ledgerVariant: "broken-walk" });
    expect(result.verdict).toBe("honest-refusal");
    expect(result.refusal?.reason).toBe("candidate-not-shadow-executed");
    expect(result.refusalHonesty?.honest).toBe(true);
    // The pinned oracle expected a promotion — the verdict contract FAILs.
    expect(result.terminal).toBe("FAILED");
    expect(
      result.criteria.some(
        (criterion) =>
          criterion.criterionId === "canary-verdict-contract" && criterion.status === "FAIL",
      ),
    ).toBe(true);
  });

  test("a WRONG-STAGE ledger (a property-tested landing) FAILs the lifecycle completeness", async () => {
    const row = rowById("probe-skipped-lifecycle");
    const result = await driveRowOverStack({ row, ledgerVariant: "wrong-stage" });
    expect(result.verdict).toBe("canary-invalid");
    expect(result.lifecycleCompleteness?.wrongStageLandings).toEqual(["property-tested"]);
    expect(result.terminal).toBe("FAILED");
  });

  test("an EVIDENCE-LESS ledger (transitions without evidence) FAILs the lifecycle completeness", async () => {
    const row = rowById("probe-skipped-lifecycle");
    const result = await driveRowOverStack({ row, ledgerVariant: "evidence-less" });
    expect(result.verdict).toBe("canary-invalid");
    expect(result.lifecycleCompleteness?.unevidencedAppendedOrdinals.length).toBeGreaterThan(0);
    expect(result.terminal).toBe("FAILED");
  });

  test("a REWRITE-REGISTRY ledger (a candidate rewrite) FAILs the read-only discipline", async () => {
    const row = rowById("probe-skipped-lifecycle");
    const result = await driveRowOverStack({ row, ledgerVariant: "rewrite-registry" });
    expect(result.terminal).toBe("FAILED");
    expect(
      result.criteria.some(
        (criterion) =>
          criterion.criterionId === "canary-registry-read-only" && criterion.status === "FAIL",
      ),
    ).toBe(true);
  });

  test("a SMOOTHING-DECISIONS canary ledger (a beyond-budget decision rewritten to advance) FAILs the breach honesty", async () => {
    const row = rowById("probe-smoothed-breach");
    const result = await driveRowOverStack({ row, canaryLedgerVariant: "smoothing-decisions" });
    expect(result.verdict).toBe("canary-invalid");
    expect(result.breachHonesty?.smoothedBreachStepIndexes).toEqual([1]);
    expect(
      result.criteria.some(
        (criterion) =>
          criterion.criterionId === "breach-beyond-budget-rolls-back" &&
          criterion.status === "FAIL",
      ),
    ).toBe(true);
    expect(result.landings.canaried).toBeNull();
  });

  test("a DECISIONLESS canary ledger (a step without its decision) FAILs the policy explicitness", async () => {
    const row = rowById("probe-unchecked-policy");
    const result = await driveRowOverStack({ row, canaryLedgerVariant: "decisionless" });
    expect(result.verdict).toBe("canary-invalid");
    expect(result.policyExplicitness?.decisionlessStepIndexes).toEqual([1]);
    expect(
      result.criteria.some(
        (criterion) =>
          criterion.criterionId === "policy-every-executed-step-decided" &&
          criterion.status === "FAIL",
      ),
    ).toBe(true);
  });

  test("an UNMARKED-DOUBLE-BOOKING canary ledger (the customer billed for the canary) FAILs the cost separation", async () => {
    const row = rowById("rag-deterministic-function-clean-promotion");
    const result = await driveRowOverStack({ row, canaryLedgerVariant: "unmarked-double-booking" });
    expect(result.verdict).toBe("canary-invalid");
    expect(result.costSeparation?.billed).toBe(true);
    expect(result.costSeparation?.markerMissing).toBe(true);
    const billed = result.criteria.find(
      (criterion) => criterion.criterionId === "canary-cost-never-billed",
    );
    expect(billed?.status).toBe("FAIL");
    expect(billed?.evidence.join(" ")).toContain("BILLED-CANARY");
    expect(result.landings.canaried).toBeNull();
  });

  test("an UNMEASURED canary runtime (the canary cost never measured) FAILs the cost separation", async () => {
    const row = rowById("rag-deterministic-function-clean-promotion");
    const result = await driveRowOverStack({ row, runtimeVariant: "unmeasured" });
    expect(result.verdict).toBe("canary-invalid");
    expect(result.costSeparation?.unmeasured).toBe(true);
    expect(result.terminal).toBe("FAILED");
  });

  test("a BREACHING runtime over a within-budget row still advances honestly (the budget holds)", async () => {
    const row = rowById("rag-deterministic-function-clean-promotion");
    const result = await driveRowOverStack({ row, runtimeVariant: "breaching" });
    // The perturbation creates ONE divergence per step; the pinned
    // budget is one per step — every step still advances honestly.
    expect(result.verdict).toBe("clean-promotion");
    expect(result.terminal).toBe("COMPLETED");
    expect(result.breachHonesty?.breachingStepIndexes).toEqual([]);
    expect(result.divergencesAppended).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// The corpus oracle (the pinned ramp re-derivation)
// ---------------------------------------------------------------------------

describe("VAL-035 corpus oracle consistency", () => {
  test("the pinned ramp re-derivation agrees with every row's expected outcome", () => {
    for (const row of CANARY_PROMOTION_CORPUS) {
      const ramp = pinnedCanaryRampOf(row);
      expect(ramp.breachingStepIndex).toBe(row.expected.breachingStepIndex);
      if (row.expected.verdict === "clean-promotion") {
        expect(ramp.breachingStepIndex).toBeNull();
        expect(row.expected.finalStage).toBe("promoted");
      } else if (row.expected.verdict === "honest-rollback") {
        expect(ramp.breachingStepIndex).not.toBeNull();
        expect(row.expected.finalStage).toBe("canaried");
        expect(row.expected.terminal).toBe("FAILED");
      }
    }
  });

  test("the prior walk of every canaried row is the full evidenced chain", () => {
    for (const row of CANARY_PROMOTION_CORPUS) {
      if (row.expected.refusalReason === null) {
        expect(priorWalkOf(row).map((t) => t.toStage)).toEqual([...CANARY_REQUIRED_PRIOR_WALK]);
        expect(priorWalkOf(row).every((t) => t.evidenceDigest.length === 8)).toBe(true);
      }
    }
  });
});
