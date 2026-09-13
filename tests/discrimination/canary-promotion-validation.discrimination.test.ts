/**
 * VAL-035 acceptance criterion 6 — the discrimination suite: the canary
 * promotion proven against controlled fakes by driving the PURE
 * derivations adversarially per the spec's named probe families:
 *
 *   * the SKIPPED LIFECYCLE — a candidate whose recorded walk skipped
 *     or broke the required `offline-replayed → differentially-
 *     evaluated → shadow-executed` chain, an unevidenced prior
 *     transition, a JUMPED rung (a promoted append without the canaried
 *     rung), a WRONG-STAGE landing, an EVIDENCE-LESS append or a
 *     LANDING-SHAPE mismatch each FAILs the promotion lifecycle
 *     completeness — while the full evidenced walk one rung at a time
 *     PASSES;
 *   * the UNCHECKED POLICY — a decision citing an UNSTATED
 *     ramp/budget/tolerance, a stated-but-NEVER-CHECKED item, a
 *     MALFORMED ramp schedule (not strictly increasing, out of (0, 1],
 *     not ending at the full-traffic step) or a DECISIONLESS executed
 *     step each FAILs the policy explicitness with the item named —
 *     while the stated-and-checked policy PASSES;
 *   * the SMOOTHED BREACH — a divergence count beyond the pinned
 *     budget that ADVANCES anyway, a breach-rollback decision without
 *     the rollback trigger, an asserted count that contradicts the
 *     per-case record, an unjustified rollback or a missing decision
 *     each FAILs the breach honesty — while the honest breach-rollback
 *     FAILs its step honestly and the within-budget advance PASSES;
 *   * the OVER-SLICE SERVE — an unpromoted candidate serving beyond
 *     its canary slice, an out-of-slice tenant, an under-serve or a
 *     foreign post-promotion serve each FAILs the slice isolation —
 *     while the exact pinned membership PASSES and the post-promotion
 *     full serve is legal;
 *   * the PARTIAL ROLLBACK — a demanded rollback leaving ANY residual
 *     fraction serving the replacement (named), an unexercised plan,
 *     an unrecorded plan or an unjustified event each FAILs the
 *     rollback completeness — while the complete exercised revert
 *     PASSES;
 *   * the MID-CANARY CONTAINMENT ESCAPE — the replacement exercising
 *     ANY pinned escape direction DURING the canary is a containment
 *     VIOLATION that FAILs, is named, and never lands — while the
 *     within-surface exercise is contained.
 *
 * Plus the honest controls: the verdict-kind derivation orders its
 * failure modes honestly, the refusal honesty (justified refusals vs
 * unjustified vs malformed outcomes), the ramp-schedule grammar and
 * the digest/identity determinism, `verifyCanaryPromotionAppContract`
 * catches every fake-world knob at the boundary, the canary ledger is
 * append-only exactly-once, and the honest control over the fixture
 * stack behaves per its pin.
 */

import { describe, expect, test } from "vitest";
import { runCanaryPromotionApp } from "../../benchmarks/validation/apps/canary-promotion/application";
import {
  CANARY_PROMOTION_CORPUS,
  canaryRowById,
  OFFLINE_CORPUS_ROWS,
  PINNED_REGISTRY_ENTRIES,
  pinnedCanaryRampOf,
} from "../../benchmarks/validation/apps/canary-promotion/corpus";
import {
  createCanaryFakeApiWorld,
  createCanaryLedger,
  createCanaryRuntime,
  createCanaryServingPath,
  createCandidateRegistry,
  createHonestCanaryStack,
  createIncumbentExecutor,
  createLifecycleLedger,
  createTickClock,
  createTrafficSource,
} from "../../benchmarks/validation/apps/canary-promotion/fixtures";
import type { TransportImplementation } from "../../benchmarks/validation/harness/harness";
import type {
  CanaryBreachLeg,
  CanaryCorpusRow,
  CanaryDecisionPolicyLeg,
  CanaryRunResult,
  CanarySliceServeStep,
  RampStep,
} from "../../benchmarks/validation/platform/canary-promotion";
import {
  CANARY_REQUIRED_PRIOR_WALK,
  CANARY_STAGE,
  canaryCostDigestOf,
  canaryDecisionDigestOf,
  canaryDivergenceDigestOf,
  canarySliceDigestOf,
  canaryTenantIdOf,
  deriveBreachHonesty,
  deriveCanaryCostSeparation,
  deriveCanaryPolicyExplicitness,
  deriveCanaryRefusalHonesty,
  deriveCanaryVerdictKind,
  deriveHonestCanaryStep,
  derivePromotionLifecycleCompleteness,
  deriveRollbackCompleteness,
  deriveSliceIsolation,
  driveCanaryRun,
  failureBudgetDigestOf,
  isBeyondPromotionScope,
  isRampScheduleWellFormed,
  PROMOTED_STAGE,
  rampScheduleDigestOf,
  referenceCanaryMeasurementOf,
  rollbackEventDigestOf,
  rollbackPlanDigestOf,
  sliceCaseIdsOf,
} from "../../benchmarks/validation/platform/canary-promotion";
import type { ReplacementIsolationVerdict } from "../../benchmarks/validation/platform/equivalence-testing";
import {
  deriveReplacementIsolation,
  ISOLATION_ESCAPE_DIRECTIONS,
} from "../../benchmarks/validation/platform/equivalence-testing";
import { CANDIDATE_LIFECYCLE_STAGES } from "../../benchmarks/validation/platform/learning-discovery";
import { longitudinalDigestOf } from "../../benchmarks/validation/platform/longitudinal-baseline";

const REVISION = "bfc5a8d4c11d1c9a5b6f00112233445566778899aa";

const rowById = (rowId: string): CanaryCorpusRow => {
  const row = canaryRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const taskIndexOf = (rowId: string): number => {
  const index = CANARY_PROMOTION_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
};

const criterionOf = (criteria: readonly { criterionId: string; status: string }[], id: string) =>
  criteria.find((criterion) => criterion.criterionId === id);

/** The honest policy legs for one row (the stated-and-checked basis). */
function honestPolicyLegsOf(row: CanaryCorpusRow): readonly CanaryDecisionPolicyLeg[] {
  const scheduleDigest = rampScheduleDigestOf(row.rampSchedule);
  return row.rampSchedule.map((step) => ({
    stepIndex: step.stepIndex,
    citations: {
      rampScheduleDigest: scheduleDigest,
      failureBudgetStated: true,
      toleranceStated: true,
    },
    checks: { rampChecked: true, budgetChecked: true, toleranceChecked: true },
  }));
}

/** The policy-explicitness derivation over one row's own pinned policy. */
function policyOf(
  row: CanaryCorpusRow,
  decisions: readonly CanaryDecisionPolicyLeg[],
  executedStepIndexes?: readonly number[],
) {
  return deriveCanaryPolicyExplicitness({
    rampSchedule: row.rampSchedule,
    failureBudget: row.failureBudget,
    tolerance: row.acceptanceCriterion,
    decisions,
    executedStepIndexes: executedStepIndexes ?? decisions.map((decision) => decision.stepIndex),
  });
}

// ---------------------------------------------------------------------------
// Family 1: the skipped lifecycle (the promotion-lifecycle catch)
// ---------------------------------------------------------------------------

describe("VAL-035 discrimination: the skipped lifecycle", () => {
  const row = rowById("rag-deterministic-function-clean-promotion");
  const evidence = (ordinal: number) => longitudinalDigestOf(["evidence", ordinal]);

  /** The recorded VAL-033 + VAL-034 walk (the read-only prefix). */
  const recordedWalk = [...CANARY_REQUIRED_PRIOR_WALK];

  test("the full evidenced chain + the canaried → promoted append (one rung at a time) is COMPLETE (the control)", () => {
    const verdict = derivePromotionLifecycleCompleteness({
      priorTransitions: CANARY_REQUIRED_PRIOR_WALK.map((stage, index) => ({
        proposalId: row.sourceProposalId,
        toStage: stage,
        evidenceDigest: evidence(index + 1),
        ordinal: index + 1,
      })),
      appendedTransitions: [
        {
          proposalId: row.sourceProposalId,
          toStage: CANARY_STAGE,
          evidenceDigest: evidence(4),
          ordinal: 4,
        },
        {
          proposalId: row.sourceProposalId,
          toStage: PROMOTED_STAGE,
          evidenceDigest: evidence(5),
          ordinal: 5,
        },
      ],
      expectedLanding: "promoted",
    });
    expect(verdict.complete).toBe(true);
    expect(verdict.priorWalk).toEqual(recordedWalk);
    expect(verdict.appendedWalk).toEqual([CANARY_STAGE, PROMOTED_STAGE]);
    for (const criterion of verdict.criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
  });

  test("each SKIPPED prior stage FAILs (a skipped lifecycle never promotes)", () => {
    for (const skipped of CANARY_REQUIRED_PRIOR_WALK) {
      const walk = CANARY_REQUIRED_PRIOR_WALK.filter((stage) => stage !== skipped);
      const verdict = derivePromotionLifecycleCompleteness({
        priorTransitions: walk.map((stage, index) => ({
          proposalId: row.sourceProposalId,
          toStage: stage,
          evidenceDigest: evidence(index + 1),
          ordinal: index + 1,
        })),
        appendedTransitions: [
          {
            proposalId: row.sourceProposalId,
            toStage: CANARY_STAGE,
            evidenceDigest: evidence(4),
            ordinal: 4,
          },
        ],
        expectedLanding: "canaried",
      });
      expect(verdict.complete, skipped).toBe(false);
      expect(verdict.missingPriorStages, skipped).toEqual([skipped]);
      const prior = criterionOf(verdict.criteria, "lifecycle-prior-walk-complete");
      expect(prior?.status, skipped).toBe("FAIL");
      expect(prior?.evidence.join(" "), skipped).toContain("SKIPPED-LIFECYCLE");
    }
  });

  test("a BROKEN walk (out-of-order stages) FAILs even with every stage present", () => {
    const verdict = derivePromotionLifecycleCompleteness({
      priorTransitions: [
        {
          proposalId: row.sourceProposalId,
          toStage: "offline-replayed",
          evidenceDigest: evidence(1),
          ordinal: 1,
        },
        {
          proposalId: row.sourceProposalId,
          toStage: "shadow-executed",
          evidenceDigest: evidence(2),
          ordinal: 2,
        },
        {
          proposalId: row.sourceProposalId,
          toStage: "differentially-evaluated",
          evidenceDigest: evidence(3),
          ordinal: 3,
        },
      ],
      appendedTransitions: [
        {
          proposalId: row.sourceProposalId,
          toStage: CANARY_STAGE,
          evidenceDigest: evidence(4),
          ordinal: 4,
        },
      ],
      expectedLanding: "canaried",
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.brokenWalk).toBe(true);
    expect(verdict.missingPriorStages).toEqual([]);
    expect(criterionOf(verdict.criteria, "lifecycle-prior-walk-complete")?.status).toBe("FAIL");
  });

  test("an UNEVIDENCED prior transition FAILs", () => {
    const verdict = derivePromotionLifecycleCompleteness({
      priorTransitions: CANARY_REQUIRED_PRIOR_WALK.map((stage, index) => ({
        proposalId: row.sourceProposalId,
        toStage: stage,
        evidenceDigest: index === 1 ? "" : evidence(index + 1),
        ordinal: index + 1,
      })),
      appendedTransitions: [],
      expectedLanding: "none",
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.unevidencedPriorOrdinals).toEqual([2]);
    const prior = criterionOf(verdict.criteria, "lifecycle-prior-transitions-evidenced");
    expect(prior?.status).toBe("FAIL");
    expect(prior?.evidence.join(" ")).toContain("UNEVIDENCED-PRIOR-TRANSITION");
  });

  test("a JUMPED rung (promoted appended without canaried) FAILs", () => {
    const verdict = derivePromotionLifecycleCompleteness({
      priorTransitions: CANARY_REQUIRED_PRIOR_WALK.map((stage, index) => ({
        proposalId: row.sourceProposalId,
        toStage: stage,
        evidenceDigest: evidence(index + 1),
        ordinal: index + 1,
      })),
      appendedTransitions: [
        {
          proposalId: row.sourceProposalId,
          toStage: PROMOTED_STAGE,
          evidenceDigest: evidence(4),
          ordinal: 4,
        },
      ],
      expectedLanding: "promoted",
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.jumpedRungOrdinals).toEqual([4]);
    const rung = criterionOf(verdict.criteria, "lifecycle-one-rung-at-a-time");
    expect(rung?.status).toBe("FAIL");
    expect(rung?.evidence.join(" ")).toContain("JUMPED-RUNG");
  });

  test("a WRONG-STAGE landing, an EVIDENCE-LESS append and a LANDING-SHAPE mismatch each FAIL", () => {
    const priorTransitions = CANARY_REQUIRED_PRIOR_WALK.map((stage, index) => ({
      proposalId: row.sourceProposalId,
      toStage: stage,
      evidenceDigest: evidence(index + 1),
      ordinal: index + 1,
    }));
    const wrongStage = derivePromotionLifecycleCompleteness({
      priorTransitions,
      appendedTransitions: [
        {
          proposalId: row.sourceProposalId,
          toStage: "property-tested",
          evidenceDigest: evidence(4),
          ordinal: 4,
        },
      ],
      expectedLanding: "canaried",
    });
    expect(wrongStage.complete).toBe(false);
    expect(wrongStage.wrongStageLandings).toEqual(["property-tested"]);
    const landing = criterionOf(wrongStage.criteria, "lifecycle-landing-stages-legal");
    expect(landing?.status).toBe("FAIL");
    expect(landing?.evidence.join(" ")).toContain("ILLEGAL-LANDING");

    const evidenceLess = derivePromotionLifecycleCompleteness({
      priorTransitions,
      appendedTransitions: [
        { proposalId: row.sourceProposalId, toStage: CANARY_STAGE, evidenceDigest: "", ordinal: 4 },
      ],
      expectedLanding: "canaried",
    });
    expect(evidenceLess.complete).toBe(false);
    expect(evidenceLess.unevidencedAppendedOrdinals).toEqual([4]);
    const appended = criterionOf(evidenceLess.criteria, "lifecycle-appended-transitions-evidenced");
    expect(appended?.status).toBe("FAIL");
    expect(appended?.evidence.join(" ")).toContain("UNEVIDENCED-APPEND");

    const shapeMismatch = derivePromotionLifecycleCompleteness({
      priorTransitions,
      appendedTransitions: [],
      expectedLanding: "promoted",
    });
    expect(shapeMismatch.complete).toBe(false);
    const shape = criterionOf(shapeMismatch.criteria, "lifecycle-landing-shape");
    expect(shape?.status).toBe("FAIL");
    expect(shape?.evidence.join(" ")).toContain("LANDING-MISMATCH");
  });

  test("nothing lies BEYOND the promoted stage (the FINAL rung — a future ladder extension must re-earn the pin)", () => {
    const ladder = [...CANDIDATE_LIFECYCLE_STAGES];
    expect(ladder[ladder.length - 1]).toBe(PROMOTED_STAGE);
    for (const stage of ladder) {
      expect(isBeyondPromotionScope(stage), stage).toBe(false);
    }
    // The honest fixture landing: canaried → promoted one rung at a
    // time over the honest stack.
    expect(CANARY_STAGE).toBe("canaried");
  });

  test("a REWRITE-REGISTRY ledger (mutating a candidate's own entry) FAILs the read-only discipline", async () => {
    const clock = createTickClock();
    const registry = createCandidateRegistry();
    const digestBefore = registry.digest();
    const servingPath = createCanaryServingPath();
    const result = await driveCanaryRun({
      row: rowById("probe-skipped-lifecycle"),
      registry,
      lifecycle: createLifecycleLedger({ variant: "rewrite-registry", registry }),
      canaryLedger: createCanaryLedger(),
      incumbentExecutor: createIncumbentExecutor(),
      trafficSource: createTrafficSource(),
      servingPath,
      canaryRuntime: createCanaryRuntime(),
      now: clock.now,
    });
    expect(result.terminal).toBe("FAILED");
    // The verdict legs were honest — the rewrite happened at the
    // append: the registry's frozen digest CHANGED.
    expect(result.policyExplicitness?.explicit).toBe(true);
    expect(registry.digest()).not.toBe(digestBefore);
    const readonly = criterionOf(result.criteria, "canary-registry-read-only");
    expect(readonly?.status).toBe("FAIL");
    expect(readonly?.evidence.join(" ")).toContain("REGISTRY-MUTATION");
  });
});

// ---------------------------------------------------------------------------
// Family 2: the unchecked policy (the governed ramp's explicit-policy catch)
// ---------------------------------------------------------------------------

describe("VAL-035 discrimination: the unchecked policy", () => {
  const row = rowById("rag-deterministic-function-clean-promotion");

  test("the stated-and-checked policy over the well-formed ramp is EXPLICIT (the control)", () => {
    const verdict = policyOf(row, honestPolicyLegsOf(row));
    expect(verdict.explicit).toBe(true);
    expect(verdict.rampScheduleWellFormed).toBe(true);
    expect(verdict.scheduleDigest).toBe(rampScheduleDigestOf(row.rampSchedule));
    expect(verdict.unstatedItems).toEqual([]);
    expect(verdict.uncheckedItems).toEqual([]);
    expect(verdict.decisionlessStepIndexes).toEqual([]);
    for (const criterion of verdict.criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
  });

  test("a run-level UNSTATED policy (null schedule / budget / tolerance) FAILs with all three named", () => {
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
    const stated = criterionOf(verdict.criteria, "policy-every-item-stated");
    expect(stated?.status).toBe("FAIL");
    expect(stated?.evidence.join(" ")).toContain("UNSTATED-POLICY");
  });

  test("a decision citing an UNSTATED or MISMATCHED ramp digest FAILs with the item named", () => {
    const unstated = policyOf(row, [
      {
        stepIndex: 1,
        citations: { rampScheduleDigest: "", failureBudgetStated: true, toleranceStated: true },
        checks: { rampChecked: true, budgetChecked: true, toleranceChecked: true },
      },
      ...honestPolicyLegsOf(row).slice(1),
    ]);
    expect(unstated.explicit).toBe(false);
    expect(unstated.unstatedItems).toContain("step-1:ramp-schedule");
    expect(criterionOf(unstated.criteria, "policy-every-item-stated")?.status).toBe("FAIL");

    const mismatched = policyOf(row, [
      {
        stepIndex: 1,
        citations: {
          rampScheduleDigest: longitudinalDigestOf(["impostor-schedule"]),
          failureBudgetStated: true,
          toleranceStated: true,
        },
        checks: { rampChecked: true, budgetChecked: true, toleranceChecked: true },
      },
      ...honestPolicyLegsOf(row).slice(1),
    ]);
    expect(mismatched.explicit).toBe(false);
    expect(mismatched.unstatedItems).toContain("step-1:ramp-schedule-digest-mismatch");
  });

  test("a stated-but-UNCHECKED budget/tolerance/ramp FAILs with the unchecked item named", () => {
    const verdict = policyOf(row, [
      {
        stepIndex: 2,
        citations: {
          rampScheduleDigest: rampScheduleDigestOf(row.rampSchedule),
          failureBudgetStated: true,
          toleranceStated: true,
        },
        checks: { rampChecked: true, budgetChecked: false, toleranceChecked: false },
      },
      ...honestPolicyLegsOf(row).filter((leg) => leg.stepIndex !== 2),
    ]);
    expect(verdict.explicit).toBe(false);
    expect(verdict.uncheckedItems).toContain("step-2:failure-budget");
    expect(verdict.uncheckedItems).toContain("step-2:divergence-tolerance");
    const checked = criterionOf(verdict.criteria, "policy-every-item-checked");
    expect(checked?.status).toBe("FAIL");
    expect(checked?.evidence.join(" ")).toContain("UNCHECKED-POLICY");
    expect(checked?.evidence.join(" ")).toContain("step-2:failure-budget");
  });

  test("a MALFORMED ramp schedule (not increasing / out of range / not ending at full traffic) FAILs", () => {
    const malformed: readonly RampStep[][] = [
      [
        { stepIndex: 1, trafficFraction: 0.5 },
        { stepIndex: 2, trafficFraction: 0.25 },
        { stepIndex: 3, trafficFraction: 1 },
      ],
      [
        { stepIndex: 1, trafficFraction: 0.05 },
        { stepIndex: 2, trafficFraction: 1.5 },
      ],
      [
        { stepIndex: 1, trafficFraction: 0.05 },
        { stepIndex: 2, trafficFraction: 0.25 },
      ],
      [{ stepIndex: 1, trafficFraction: 0 }],
      [],
      [{ stepIndex: 2, trafficFraction: 1 }],
    ];
    for (const schedule of malformed) {
      expect(isRampScheduleWellFormed(schedule), JSON.stringify(schedule)).toBe(false);
      const verdict = deriveCanaryPolicyExplicitness({
        rampSchedule: schedule,
        failureBudget: row.failureBudget,
        tolerance: row.acceptanceCriterion,
        decisions: schedule.map((step) => ({
          stepIndex: step.stepIndex,
          citations: {
            rampScheduleDigest: rampScheduleDigestOf(schedule),
            failureBudgetStated: true,
            toleranceStated: true,
          },
          checks: { rampChecked: true, budgetChecked: true, toleranceChecked: true },
        })),
        executedStepIndexes: schedule.map((step) => step.stepIndex),
      });
      expect(verdict.explicit, JSON.stringify(schedule)).toBe(false);
      expect(verdict.rampScheduleWellFormed).toBe(false);
      const wellFormed = criterionOf(verdict.criteria, "policy-ramp-schedule-well-formed");
      expect(wellFormed?.status, JSON.stringify(schedule)).toBe("FAIL");
      expect(wellFormed?.evidence.join(" ")).toContain("MALFORMED-RAMP");
    }
    // The pinned default ramp is well-formed.
    expect(isRampScheduleWellFormed(row.rampSchedule)).toBe(true);
  });

  test("a DECISIONLESS executed step FAILs (its policy was never stated)", () => {
    const verdict = policyOf(
      row,
      honestPolicyLegsOf(row).slice(1),
      row.rampSchedule.map((step) => step.stepIndex),
    );
    expect(verdict.explicit).toBe(false);
    expect(verdict.decisionlessStepIndexes).toEqual([1]);
    const decisionless = criterionOf(verdict.criteria, "policy-every-executed-step-decided");
    expect(decisionless?.status).toBe("FAIL");
    expect(decisionless?.evidence.join(" ")).toContain("DECISIONLESS-STEP");
  });
});

// ---------------------------------------------------------------------------
// Family 3: the smoothed breach (the governed ramp's evidence catch)
// ---------------------------------------------------------------------------

describe("VAL-035 discrimination: the smoothed breach", () => {
  const row = rowById("reuse-removed-call-budget-breach-rollback");

  /** The honest breach legs over the row's pinned ramp (the basis). */
  function honestBreachLegsOf(corpusRow: CanaryCorpusRow): readonly CanaryBreachLeg[] {
    const ramp = pinnedCanaryRampOf(corpusRow);
    const executedSteps =
      corpusRow.expected.breachingStepIndex === null
        ? corpusRow.rampSchedule
        : corpusRow.rampSchedule.filter(
            (step) => step.stepIndex <= (corpusRow.expected.breachingStepIndex ?? 0),
          );
    return executedSteps.map((step) => {
      const divergences =
        ramp.divergencesByStep.find((entry) => entry.stepIndex === step.stepIndex)
          ?.divergenceCaseIds ?? [];
      const breaching = divergences.length > corpusRow.failureBudget.maxDivergencesPerStep;
      return {
        stepIndex: step.stepIndex,
        budgetLimit: corpusRow.failureBudget.maxDivergencesPerStep,
        mechanicalDivergenceCaseIds: divergences,
        recordedDivergenceCaseIds: divergences,
        decisionKind: (breaching
          ? "breach-rollback"
          : "advance") as CanaryBreachLeg["decisionKind"],
        assertedDivergenceCount: divergences.length,
        rollbackTriggered: breaching,
      };
    });
  }

  test("a SMOOTHED BREACH (a beyond-budget step that advances anyway) FAILs", () => {
    const verdict = deriveBreachHonesty({
      steps: honestBreachLegsOf(row).map((leg) =>
        leg.stepIndex === row.expected.breachingStepIndex
          ? { ...leg, decisionKind: "advance" as const, rollbackTriggered: false }
          : leg,
      ),
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.smoothedBreachStepIndexes).toEqual([row.expected.breachingStepIndex]);
    const beyond = criterionOf(verdict.criteria, "breach-beyond-budget-rolls-back");
    expect(beyond?.status).toBe("FAIL");
    expect(beyond?.evidence.join(" ")).toContain("SMOOTHED-BREACH");
  });

  test("a BREACH-ROLLBACK decision WITHOUT the rollback trigger FAILs (uncontrolled)", () => {
    const verdict = deriveBreachHonesty({
      steps: honestBreachLegsOf(row).map((leg) => ({ ...leg, rollbackTriggered: false })),
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.uncontrolledRollbackStepIndexes).toEqual([row.expected.breachingStepIndex]);
    const beyond = criterionOf(verdict.criteria, "breach-beyond-budget-rolls-back");
    expect(beyond?.status).toBe("FAIL");
    expect(beyond?.evidence.join(" ")).toContain("SMOOTHED-BREACH");
  });

  test("an ASSERTED count that contradicts the per-case record FAILs (never smoothed, never aggregated away)", () => {
    const verdict = deriveBreachHonesty({
      steps: honestBreachLegsOf(row).map((leg) => ({ ...leg, assertedDivergenceCount: 0 })),
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.countSmoothedStepIndexes).toEqual([row.expected.breachingStepIndex]);
    const smoothed = criterionOf(verdict.criteria, "breach-count-never-smoothed");
    expect(smoothed?.status).toBe("FAIL");
    expect(smoothed?.evidence.join(" ")).toContain("SMOOTHED-COUNT");

    const recordMismatch = deriveBreachHonesty({
      steps: honestBreachLegsOf(row).map((leg) => ({
        ...leg,
        recordedDivergenceCaseIds: [],
      })),
    });
    expect(recordMismatch.honest).toBe(false);
    expect(recordMismatch.recordMismatchStepIndexes).toEqual([row.expected.breachingStepIndex]);
    expect(criterionOf(recordMismatch.criteria, "breach-count-never-smoothed")?.status).toBe(
      "FAIL",
    );
  });

  test("an UNJUSTIFIED rollback (a within-budget step that rolls back, or refuses) FAILs", () => {
    const cleanRow = rowById("rag-deterministic-function-clean-promotion");
    const legs = honestBreachLegsOf(cleanRow);
    for (const decisionKind of ["breach-rollback", "refuse"] as const) {
      const verdict = deriveBreachHonesty({
        steps: legs.map((leg) => ({ ...leg, decisionKind, rollbackTriggered: true })),
      });
      expect(verdict.honest, decisionKind).toBe(false);
      expect(verdict.unjustifiedRollbackStepIndexes).toEqual([1, 2, 3, 4]);
      const within = criterionOf(verdict.criteria, "breach-within-budget-advances");
      expect(within?.status, decisionKind).toBe("FAIL");
      expect(within?.evidence.join(" "), decisionKind).toContain("UNJUSTIFIED-ROLLBACK");
    }
  });

  test("a step WITHOUT its decision FAILs (missing decision)", () => {
    const verdict = deriveBreachHonesty({
      steps: honestBreachLegsOf(row).map((leg) => ({ ...leg, decisionKind: null })),
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.missingDecisionStepIndexes).toEqual([1]);
    const missing = criterionOf(verdict.criteria, "breach-every-step-decided");
    expect(missing?.status).toBe("FAIL");
    expect(missing?.evidence.join(" ")).toContain("MISSING-DECISION");
  });

  test("the HONEST breach-rollback FAILs its step honestly (the control: every other leg passes)", () => {
    const verdict = deriveBreachHonesty({ steps: honestBreachLegsOf(row) });
    expect(verdict.honest).toBe(true);
    expect(verdict.breachingStepIndexes).toEqual([row.expected.breachingStepIndex]);
    for (const criterion of verdict.criteria) {
      if (criterion.criterionId === "breach-observed-beyond-budget") {
        // The honest breach leg: the step FAILs honestly and the run
        // rolls back — recorded, never smoothed.
        expect(criterion.status).toBe("FAIL");
        expect(criterion.evidence.join(" ")).toContain("HONEST-BREACH");
      } else {
        expect(criterion.status, criterion.criterionId).toBe("PASS");
      }
    }
    // The within-budget advance control over the clean row.
    const clean = deriveBreachHonesty({
      steps: honestBreachLegsOf(rowById("rag-deterministic-function-clean-promotion")),
    });
    expect(clean.honest).toBe(true);
    expect(clean.breachingStepIndexes).toEqual([]);
    for (const criterion of clean.criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
  });
});

// ---------------------------------------------------------------------------
// Family 4: the over-slice serve (the slice-isolation catch)
// ---------------------------------------------------------------------------

describe("VAL-035 discrimination: the over-slice serve", () => {
  const row = rowById("rag-deterministic-function-clean-promotion");
  const populationCaseIds = row.trafficPopulation.map((tcase) => tcase.caseId);

  /** The honest slice-serve steps over the row's pinned ramp. */
  const honestSteps = (): readonly CanarySliceServeStep[] =>
    row.rampSchedule.map((step) => {
      const slice = sliceCaseIdsOf(populationCaseIds, step.trafficFraction);
      return {
        stepIndex: step.stepIndex,
        pinnedFraction: step.trafficFraction,
        populationCaseIds,
        servedReplacementCaseIds: slice,
        servedReplacementTenantIds: [...new Set(slice.map((caseId) => canaryTenantIdOf(caseId)))],
      };
    });

  test("an OVER-SLICE serve (a case beyond the pinned slice) FAILs with the case named", () => {
    const steps = honestSteps().map((step, index) =>
      index === 0
        ? {
            ...step,
            servedReplacementCaseIds: [
              ...step.servedReplacementCaseIds,
              populationCaseIds[3] ?? "",
            ],
          }
        : step,
    );
    const verdict = deriveSliceIsolation({
      steps,
      promoted: false,
      postPromotionServedReplacementCaseIds: null,
      populationCaseIds,
    });
    expect(verdict.isolated).toBe(false);
    expect(verdict.overSliceCaseIds).toEqual([`step-1:${populationCaseIds[3]}`]);
    const overSlice = criterionOf(verdict.criteria, "slice-no-over-slice-serve");
    expect(overSlice?.status).toBe("FAIL");
    expect(overSlice?.evidence.join(" ")).toContain("OVER-SLICE");
    expect(overSlice?.evidence.join(" ")).toContain(populationCaseIds[3]);
  });

  test("an OUT-OF-SLICE TENANT served the replacement FAILs with the tenant named", () => {
    const steps = honestSteps().map((step, index) =>
      index === 0
        ? {
            ...step,
            servedReplacementTenantIds: [...step.servedReplacementTenantIds, "tenant-999"],
          }
        : step,
    );
    const verdict = deriveSliceIsolation({
      steps,
      promoted: false,
      postPromotionServedReplacementCaseIds: null,
      populationCaseIds,
    });
    expect(verdict.isolated).toBe(false);
    expect(verdict.outOfSliceTenantIds).toEqual(["step-1:tenant-999"]);
    const tenant = criterionOf(verdict.criteria, "slice-no-out-of-slice-tenant");
    expect(tenant?.status).toBe("FAIL");
    expect(tenant?.evidence.join(" ")).toContain("OUT-OF-SLICE-TENANT");
    expect(tenant?.evidence.join(" ")).toContain("tenant-999");
  });

  test("an UNDER-SERVE breaks the ramp's pinned adherence and FAILs", () => {
    const steps = honestSteps().map((step, index) =>
      index === 1
        ? { ...step, servedReplacementCaseIds: step.servedReplacementCaseIds.slice(0, -1) }
        : step,
    );
    const verdict = deriveSliceIsolation({
      steps,
      promoted: false,
      postPromotionServedReplacementCaseIds: null,
      populationCaseIds,
    });
    expect(verdict.isolated).toBe(false);
    expect(verdict.underServedStepIndexes).toEqual([2]);
    const adherence = criterionOf(verdict.criteria, "slice-ramp-adherence");
    expect(adherence?.status).toBe("FAIL");
    expect(adherence?.evidence.join(" ")).toContain("RAMP-ADHERENCE");
  });

  test("the WITHIN-SLICE control PASSES; the POST-PROMOTION full serve is legal — never before", () => {
    const withinSlice = deriveSliceIsolation({
      steps: honestSteps(),
      promoted: false,
      postPromotionServedReplacementCaseIds: null,
      populationCaseIds,
    });
    expect(withinSlice.isolated).toBe(true);
    for (const criterion of withinSlice.criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
    // After the promoted rung lands, the full traffic may serve the
    // replacement — the post-promotion serve is legal.
    const postPromotion = deriveSliceIsolation({
      steps: honestSteps(),
      promoted: true,
      postPromotionServedReplacementCaseIds: populationCaseIds,
      populationCaseIds,
    });
    expect(postPromotion.isolated).toBe(true);
    expect(postPromotion.postPromotionServeLegal).toBe(true);
    // A FOREIGN post-promotion serve (outside the population) FAILs.
    const foreign = deriveSliceIsolation({
      steps: honestSteps(),
      promoted: true,
      postPromotionServedReplacementCaseIds: [...populationCaseIds, "foreign-case-x"],
      populationCaseIds,
    });
    expect(foreign.isolated).toBe(false);
    expect(foreign.postPromotionServeLegal).toBe(false);
    const post = criterionOf(foreign.criteria, "slice-post-promotion-serve-legal");
    expect(post?.status).toBe("FAIL");
    expect(post?.evidence.join(" ")).toContain("FOREIGN-POST-PROMOTION-SERVE");
  });
});

// ---------------------------------------------------------------------------
// Family 5: the partial rollback (the reversibility catch)
// ---------------------------------------------------------------------------

describe("VAL-035 discrimination: the partial rollback", () => {
  const row = rowById("reuse-removed-call-budget-breach-rollback");
  const populationCaseIds = row.trafficPopulation.map((tcase) => tcase.caseId);
  const sliceAtBreach = sliceCaseIdsOf(
    populationCaseIds,
    row.rampSchedule[0]?.trafficFraction ?? 1,
  );
  const residual = sliceAtBreach[sliceAtBreach.length - 1] ?? "";

  test("a PARTIAL rollback (a residual case still serving the replacement) FAILs naming the residual", () => {
    const verdict = deriveRollbackCompleteness({
      rollbackDemanded: true,
      planRecorded: true,
      rollbackEvents: [{ ordinal: 1, stepIndex: 1, residualReplacementCaseIds: [residual] }],
      sliceCaseIdsAtBreach: sliceAtBreach,
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.residualReplacementCaseIds).toEqual([residual]);
    const mechanical = criterionOf(verdict.criteria, "rollback-complete-mechanical");
    expect(mechanical?.status).toBe("FAIL");
    expect(mechanical?.evidence.join(" ")).toContain("PARTIAL-ROLLBACK");
    expect(mechanical?.evidence.join(" ")).toContain(residual);
  });

  test("an UNEXERCISED plan (a demanded rollback with no event) FAILs", () => {
    const verdict = deriveRollbackCompleteness({
      rollbackDemanded: true,
      planRecorded: true,
      rollbackEvents: [],
      sliceCaseIdsAtBreach: sliceAtBreach,
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.rollbackExercised).toBe(false);
    const exercised = criterionOf(verdict.criteria, "rollback-plan-exercised");
    expect(exercised?.status).toBe("FAIL");
    expect(exercised?.evidence.join(" ")).toContain("UNEVIDENCED-ROLLBACK-PLAN");
  });

  test("an UNRECORDED plan FAILs (production promotion must be reversible)", () => {
    const verdict = deriveRollbackCompleteness({
      rollbackDemanded: true,
      planRecorded: false,
      rollbackEvents: [{ ordinal: 1, stepIndex: 1, residualReplacementCaseIds: [] }],
      sliceCaseIdsAtBreach: sliceAtBreach,
    });
    expect(verdict.complete).toBe(false);
    const recorded = criterionOf(verdict.criteria, "rollback-plan-recorded");
    expect(recorded?.status).toBe("FAIL");
    expect(recorded?.evidence.join(" ")).toContain("UNRECORDED-PLAN");
  });

  test("an UNJUSTIFIED rollback event (no demanded breach) FAILs; the honest states PASS", () => {
    const unjustified = deriveRollbackCompleteness({
      rollbackDemanded: false,
      planRecorded: true,
      rollbackEvents: [{ ordinal: 1, stepIndex: 1, residualReplacementCaseIds: [] }],
      sliceCaseIdsAtBreach: [],
    });
    expect(unjustified.complete).toBe(false);
    expect(unjustified.unjustifiedEventOrdinals).toEqual([1]);
    const events = criterionOf(unjustified.criteria, "rollback-events-justified");
    expect(events?.status).toBe("FAIL");
    expect(events?.evidence.join(" ")).toContain("UNJUSTIFIED-ROLLBACK-EVENT");

    // The complete exercised revert on the demanded breach PASSES.
    const complete = deriveRollbackCompleteness({
      rollbackDemanded: true,
      planRecorded: true,
      rollbackEvents: [{ ordinal: 1, stepIndex: 1, residualReplacementCaseIds: [] }],
      sliceCaseIdsAtBreach: sliceAtBreach,
    });
    expect(complete.complete).toBe(true);
    for (const criterion of complete.criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
    // A clean promotion (no demand, the recorded plan alone, no
    // events) is the reversibility contract's honest state.
    const clean = deriveRollbackCompleteness({
      rollbackDemanded: false,
      planRecorded: true,
      rollbackEvents: [],
      sliceCaseIdsAtBreach: [],
    });
    expect(clean.complete).toBe(true);
    expect(clean.planRecorded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Family 6: the mid-canary containment escape (the carry-over catch)
// ---------------------------------------------------------------------------

describe("VAL-035 discrimination: the mid-canary containment escape", () => {
  const declared = ["pure-computation", "granted-fixture-read"];
  const granted = ["pure-computation", "granted-fixture-read"];

  test("EACH escape direction is a containment VIOLATION that FAILs and names the direction", () => {
    for (const direction of ISOLATION_ESCAPE_DIRECTIONS) {
      const verdict: ReplacementIsolationVerdict = deriveReplacementIsolation({
        declaredCapabilities: declared,
        grantedSurface: granted,
        exercisedCapabilities: [...declared, direction],
      });
      expect(verdict.contained, direction).toBe(false);
      expect(verdict.containment, direction).toBe("violation");
      expect(verdict.escapeDirections, direction).toEqual([direction]);
      const escapeLeg = criterionOf(verdict.criteria, "isolation-no-escape");
      expect(escapeLeg?.status, direction).toBe("FAIL");
      expect(escapeLeg?.evidence.join(" "), direction).toContain("CONTAINMENT-VIOLATION");
      expect(escapeLeg?.evidence.join(" "), direction).toContain(direction);
      // The canary verdict kind ranks the mid-canary escape as a
      // containment violation (never a passable outcome).
      expect(
        deriveCanaryVerdictKind({
          refusal: null,
          isolation: verdict,
          policyExplicitness: null,
          lifecycleCompleteness: null,
          breachHonesty: null,
          rollbackCompleteness: null,
          sliceIsolation: null,
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

  test("an ESCAPING canary runtime (network access mid-canary) never lands its transition", async () => {
    const clock = createTickClock();
    const registry = createCandidateRegistry();
    const lifecycle = createLifecycleLedger();
    const result = await driveCanaryRun({
      row: rowById("probe-mid-canary-escape"),
      registry,
      lifecycle,
      canaryLedger: createCanaryLedger(),
      incumbentExecutor: createIncumbentExecutor(),
      trafficSource: createTrafficSource(),
      servingPath: createCanaryServingPath(),
      canaryRuntime: createCanaryRuntime({ variant: "escaping" }),
      now: clock.now,
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("containment-violation");
    expect(result.isolation?.escapeDirections).toEqual(["network-access"]);
    expect(result.landings.canaried).toBeNull();
    expect(lifecycle.landedProposalIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The honest controls: verdict kinds, refusal honesty, the ramp grammar,
// digest determinism, the boundary contract, the exactly-once ledgers
// ---------------------------------------------------------------------------

describe("VAL-035 discrimination: the honest controls", () => {
  test("the verdict-kind derivation orders its failure modes honestly", () => {
    const cleanRow = rowById("rag-deterministic-function-clean-promotion");
    const rollbackRow = rowById("reuse-removed-call-budget-breach-rollback");
    const explicit = policyOf(cleanRow, honestPolicyLegsOf(cleanRow));
    const isolated = deriveSliceIsolation({
      steps: cleanRow.rampSchedule.map((step) => {
        const slice = sliceCaseIdsOf(
          cleanRow.trafficPopulation.map((tcase) => tcase.caseId),
          step.trafficFraction,
        );
        return {
          stepIndex: step.stepIndex,
          pinnedFraction: step.trafficFraction,
          populationCaseIds: cleanRow.trafficPopulation.map((tcase) => tcase.caseId),
          servedReplacementCaseIds: slice,
          servedReplacementTenantIds: [...new Set(slice.map((caseId) => canaryTenantIdOf(caseId)))],
        };
      }),
      promoted: false,
      postPromotionServedReplacementCaseIds: null,
      populationCaseIds: cleanRow.trafficPopulation.map((tcase) => tcase.caseId),
    });
    const rolledBack = deriveRollbackCompleteness({
      rollbackDemanded: true,
      planRecorded: true,
      rollbackEvents: [{ ordinal: 1, stepIndex: 1, residualReplacementCaseIds: [] }],
      sliceCaseIdsAtBreach: sliceCaseIdsOf(
        rollbackRow.trafficPopulation.map((tcase) => tcase.caseId),
        rollbackRow.rampSchedule[0]?.trafficFraction ?? 1,
      ),
    });
    const separated = deriveCanaryCostSeparation({
      incumbentCostMicroUsd: 10,
      canaryCostMicroUsd: 5,
      servedTotalMicroUsd: 10,
      canaryLedgerBookedMicroUsd: 5,
      canaryMarkerPresent: true,
    });
    const cleanLifecycle = derivePromotionLifecycleCompleteness({
      priorTransitions: CANARY_REQUIRED_PRIOR_WALK.map((stage, index) => ({
        proposalId: cleanRow.sourceProposalId,
        toStage: stage,
        evidenceDigest: longitudinalDigestOf(["evidence", index + 1]),
        ordinal: index + 1,
      })),
      appendedTransitions: [
        {
          proposalId: cleanRow.sourceProposalId,
          toStage: CANARY_STAGE,
          evidenceDigest: "aaaaaaaa",
          ordinal: 4,
        },
        {
          proposalId: cleanRow.sourceProposalId,
          toStage: PROMOTED_STAGE,
          evidenceDigest: "bbbbbbbb",
          ordinal: 5,
        },
      ],
      expectedLanding: "promoted",
    });
    const cleanBreach = deriveBreachHonesty({
      steps: cleanRow.rampSchedule.map((step) => ({
        stepIndex: step.stepIndex,
        budgetLimit: cleanRow.failureBudget.maxDivergencesPerStep,
        mechanicalDivergenceCaseIds: [],
        recordedDivergenceCaseIds: [],
        decisionKind: "advance" as const,
        assertedDivergenceCount: 0,
        rollbackTriggered: false,
      })),
    });
    const breaching = deriveBreachHonesty({
      steps: [
        {
          stepIndex: 1,
          budgetLimit: 0,
          mechanicalDivergenceCaseIds: ["case-x"],
          recordedDivergenceCaseIds: ["case-x"],
          decisionKind: "breach-rollback" as const,
          assertedDivergenceCount: 1,
          rollbackTriggered: true,
        },
      ],
    });
    // A refusal always wins (the honest refusal).
    expect(
      deriveCanaryVerdictKind({
        refusal: { reason: "candidate-unregistered" },
        isolation: null,
        policyExplicitness: explicit,
        lifecycleCompleteness: cleanLifecycle,
        breachHonesty: cleanBreach,
        rollbackCompleteness: rolledBack,
        sliceIsolation: isolated,
        costSeparation: separated,
      }),
    ).toBe("honest-refusal");
    // A containment violation beats the mechanical legs.
    expect(
      deriveCanaryVerdictKind({
        refusal: null,
        isolation: {
          contained: false,
          containment: "violation",
          declaredNotGranted: [],
          undeclaredExercises: ["network-access"],
          escapeDirections: ["network-access"],
          criteria: [],
        },
        policyExplicitness: explicit,
        lifecycleCompleteness: cleanLifecycle,
        breachHonesty: cleanBreach,
        rollbackCompleteness: rolledBack,
        sliceIsolation: isolated,
        costSeparation: separated,
      }),
    ).toBe("containment-violation");
    // A missing leg or an untrustworthy shape is canary-invalid.
    expect(
      deriveCanaryVerdictKind({
        refusal: null,
        isolation: null,
        policyExplicitness: null,
        lifecycleCompleteness: null,
        breachHonesty: null,
        rollbackCompleteness: null,
        sliceIsolation: null,
        costSeparation: null,
      }),
    ).toBe("canary-invalid");
    expect(
      deriveCanaryVerdictKind({
        refusal: null,
        isolation: null,
        policyExplicitness: { ...explicit, explicit: false },
        lifecycleCompleteness: cleanLifecycle,
        breachHonesty: cleanBreach,
        rollbackCompleteness: rolledBack,
        sliceIsolation: isolated,
        costSeparation: separated,
      }),
    ).toBe("canary-invalid");
    expect(
      deriveCanaryVerdictKind({
        refusal: null,
        isolation: null,
        policyExplicitness: explicit,
        lifecycleCompleteness: { ...cleanLifecycle, complete: false },
        breachHonesty: cleanBreach,
        rollbackCompleteness: rolledBack,
        sliceIsolation: isolated,
        costSeparation: separated,
      }),
    ).toBe("canary-invalid");
    expect(
      deriveCanaryVerdictKind({
        refusal: null,
        isolation: null,
        policyExplicitness: explicit,
        lifecycleCompleteness: cleanLifecycle,
        breachHonesty: { ...cleanBreach, honest: false },
        rollbackCompleteness: rolledBack,
        sliceIsolation: isolated,
        costSeparation: separated,
      }),
    ).toBe("canary-invalid");
    expect(
      deriveCanaryVerdictKind({
        refusal: null,
        isolation: null,
        policyExplicitness: explicit,
        lifecycleCompleteness: cleanLifecycle,
        breachHonesty: cleanBreach,
        rollbackCompleteness: { ...rolledBack, complete: false },
        sliceIsolation: isolated,
        costSeparation: separated,
      }),
    ).toBe("canary-invalid");
    expect(
      deriveCanaryVerdictKind({
        refusal: null,
        isolation: null,
        policyExplicitness: explicit,
        lifecycleCompleteness: cleanLifecycle,
        breachHonesty: cleanBreach,
        rollbackCompleteness: rolledBack,
        sliceIsolation: { ...isolated, isolated: false },
        costSeparation: separated,
      }),
    ).toBe("canary-invalid");
    expect(
      deriveCanaryVerdictKind({
        refusal: null,
        isolation: null,
        policyExplicitness: explicit,
        lifecycleCompleteness: cleanLifecycle,
        breachHonesty: cleanBreach,
        rollbackCompleteness: rolledBack,
        sliceIsolation: isolated,
        costSeparation: { ...separated, separated: false },
      }),
    ).toBe("canary-invalid");
    // The honest terminal kinds: an honest rollback, a clean promotion.
    expect(
      deriveCanaryVerdictKind({
        refusal: null,
        isolation: null,
        policyExplicitness: explicit,
        lifecycleCompleteness: cleanLifecycle,
        breachHonesty: breaching,
        rollbackCompleteness: rolledBack,
        sliceIsolation: isolated,
        costSeparation: separated,
      }),
    ).toBe("honest-rollback");
    expect(
      deriveCanaryVerdictKind({
        refusal: null,
        isolation: null,
        policyExplicitness: explicit,
        lifecycleCompleteness: cleanLifecycle,
        breachHonesty: cleanBreach,
        rollbackCompleteness: rolledBack,
        sliceIsolation: isolated,
        costSeparation: separated,
      }),
    ).toBe("clean-promotion");
  });

  test("the refusal honesty (justified, unjustified, malformed)", () => {
    // An unregistered candidate justifies the unregistered refusal.
    expect(
      deriveCanaryRefusalHonesty({
        refusal: { reason: "candidate-unregistered" },
        canaryExecuted: false,
        registryEntry: null,
      }).honest,
    ).toBe(true);
    // A registered, shadow-executed candidate hides behind NO honest
    // refusal — both refusal reasons are UNJUSTIFIED.
    const canaryable = {
      lifecycleStage: "shadow-executed" as const,
      walkEndsAtShadowExecuted: true,
    };
    for (const reason of ["candidate-unregistered", "candidate-not-shadow-executed"] as const) {
      const verdict = deriveCanaryRefusalHonesty({
        refusal: { reason },
        canaryExecuted: false,
        registryEntry: canaryable,
      });
      expect(verdict.honest).toBe(false);
      expect(verdict.justified).toBe(false);
      const justified = criterionOf(verdict.criteria, "canary-refusal-justified");
      expect(justified?.status).toBe("FAIL");
      expect(justified?.evidence.join(" ")).toContain("UNJUSTIFIED-REFUSAL");
    }
    // A registered-but-premature candidate justifies the premature refusal.
    expect(
      deriveCanaryRefusalHonesty({
        refusal: { reason: "candidate-not-shadow-executed" },
        canaryExecuted: false,
        registryEntry: {
          lifecycleStage: "differentially-evaluated",
          walkEndsAtShadowExecuted: false,
        },
      }).honest,
    ).toBe(true);
    // A refusal accompanied by a canary execution is a malformed outcome.
    const malformed = deriveCanaryRefusalHonesty({
      refusal: { reason: "candidate-unregistered" },
      canaryExecuted: true,
      registryEntry: null,
    });
    expect(malformed.honest).toBe(false);
    const wellFormed = criterionOf(malformed.criteria, "canary-refusal-well-formed");
    expect(wellFormed?.status).toBe("FAIL");
    expect(wellFormed?.evidence.join(" ")).toContain("MALFORMED-OUTCOME");
    // A canary with NO refusal under test has no refusal to judge —
    // the derivation is the refusal oracle, never a pass/fail leg of
    // an executed canary (the driver invokes it on the refusal path
    // only).
    expect(
      deriveCanaryRefusalHonesty({
        refusal: null,
        canaryExecuted: true,
        registryEntry: canaryable,
      }).reason,
    ).toBeNull();
  });

  test("the ramp grammar + the digest/identity derivations are deterministic and discriminating", () => {
    const row = rowById("rag-deterministic-function-clean-promotion");
    const first = row.trafficPopulation[0];
    if (first === undefined) {
      throw new Error("the RAG traffic population is empty");
    }
    // Ramp schedule digests: deterministic and discriminating (a
    // changed fraction or step count changes the digest).
    expect(rampScheduleDigestOf(row.rampSchedule)).toBe(rampScheduleDigestOf(row.rampSchedule));
    expect(rampScheduleDigestOf([...row.rampSchedule].reverse())).not.toBe(
      rampScheduleDigestOf(row.rampSchedule),
    );
    expect(rampScheduleDigestOf(row.rampSchedule.slice(0, -1))).not.toBe(
      rampScheduleDigestOf(row.rampSchedule),
    );
    expect(failureBudgetDigestOf({ maxDivergencesPerStep: 1 })).toBe(
      failureBudgetDigestOf({ maxDivergencesPerStep: 1 }),
    );
    expect(failureBudgetDigestOf({ maxDivergencesPerStep: 2 })).not.toBe(
      failureBudgetDigestOf({ maxDivergencesPerStep: 1 }),
    );
    // Decision / divergence / rollback / cost digests: deterministic
    // and discriminating.
    const decision = {
      proposalId: row.sourceProposalId,
      stepIndex: 1,
      kind: "advance" as const,
      sliceFraction: 0.05,
      observedDivergenceCount: 0,
      budgetLimit: 1,
      policyCitations: {
        rampScheduleDigest: rampScheduleDigestOf(row.rampSchedule),
        failureBudgetStated: true,
        toleranceStated: true,
      },
      policyChecks: { rampChecked: true, budgetChecked: true, toleranceChecked: true },
    };
    expect(canaryDecisionDigestOf(decision)).toBe(canaryDecisionDigestOf(decision));
    expect(canaryDecisionDigestOf({ ...decision, kind: "breach-rollback" as const })).not.toBe(
      canaryDecisionDigestOf(decision),
    );
    const divergence = {
      proposalId: row.sourceProposalId,
      stepIndex: 1,
      caseId: first.caseId,
      incumbentDigest: first.incumbentDigest,
      replacementDigest: first.inputDigest,
    };
    expect(canaryDivergenceDigestOf(divergence)).toBe(canaryDivergenceDigestOf(divergence));
    expect(canaryDivergenceDigestOf({ ...divergence, replacementDigest: "00000000" })).not.toBe(
      canaryDivergenceDigestOf(divergence),
    );
    const plan = {
      proposalId: row.sourceProposalId,
      revertsServingTo: "incumbent" as const,
      scopeFraction: 1,
    };
    expect(rollbackPlanDigestOf(plan)).toBe(rollbackPlanDigestOf(plan));
    expect(rollbackPlanDigestOf({ ...plan, scopeFraction: 0.5 })).not.toBe(
      rollbackPlanDigestOf(plan),
    );
    const rollbackEvent = {
      proposalId: row.sourceProposalId,
      stepIndex: 1,
      planDigest: rollbackPlanDigestOf(plan),
      residualReplacementCaseIds: [],
    };
    expect(rollbackEventDigestOf(rollbackEvent)).toBe(rollbackEventDigestOf(rollbackEvent));
    expect(
      rollbackEventDigestOf({ ...rollbackEvent, residualReplacementCaseIds: [first.caseId] }),
    ).not.toBe(rollbackEventDigestOf(rollbackEvent));
    const cost = {
      proposalId: row.sourceProposalId,
      marker: "canary" as const,
      microUsd: 21,
      latencyMs: 42,
    };
    expect(canaryCostDigestOf(cost)).toBe(canaryCostDigestOf(cost));
    expect(canaryCostDigestOf({ ...cost, microUsd: 22 })).not.toBe(canaryCostDigestOf(cost));
    // The slice digest is deterministic and discriminating.
    const sliceDigest = canarySliceDigestOf({
      proposalId: row.sourceProposalId,
      stepIndex: 1,
      sliceCaseIds: sliceCaseIdsOf(
        row.trafficPopulation.map((tcase) => tcase.caseId),
        0.05,
      ),
    });
    expect(sliceDigest).toBe(
      canarySliceDigestOf({
        proposalId: row.sourceProposalId,
        stepIndex: 1,
        sliceCaseIds: sliceCaseIdsOf(
          row.trafficPopulation.map((tcase) => tcase.caseId),
          0.05,
        ),
      }),
    );
    expect(sliceDigest).not.toBe(
      canarySliceDigestOf({
        proposalId: row.sourceProposalId,
        stepIndex: 2,
        sliceCaseIds: sliceCaseIdsOf(
          row.trafficPopulation.map((tcase) => tcase.caseId),
          0.05,
        ),
      }),
    );
    // The slice membership + the tenant identity are deterministic pure
    // functions (order-independent over the population, monotone in
    // the fraction, ending at the whole population).
    const caseIds = row.trafficPopulation.map((tcase) => tcase.caseId);
    expect(sliceCaseIdsOf(caseIds, 0.05)).toEqual(sliceCaseIdsOf([...caseIds].reverse(), 0.05));
    for (const [index, step] of row.rampSchedule.entries()) {
      const slice = sliceCaseIdsOf(caseIds, step.trafficFraction);
      if (index > 0) {
        const previous = sliceCaseIdsOf(caseIds, row.rampSchedule[index - 1]?.trafficFraction ?? 1);
        expect(slice.length).toBeGreaterThan(previous.length - 1);
        expect(slice.length).toBeGreaterThanOrEqual(previous.length);
      }
    }
    expect(sliceCaseIdsOf(caseIds, 1)).toEqual([...caseIds].sort((a, b) => a.localeCompare(b)));
    for (const caseId of caseIds) {
      expect(canaryTenantIdOf(caseId)).toBe(canaryTenantIdOf(caseId));
      expect(canaryTenantIdOf(caseId)).toMatch(/^tenant-[0-3]$/);
    }
    // The reference canary measurement is a pure function of the slice.
    expect(referenceCanaryMeasurementOf([first.caseId])).toEqual({ microUsd: 3, latencyMs: 6 });
    expect(referenceCanaryMeasurementOf([first.caseId, first.caseId])).toEqual({
      microUsd: 5,
      latencyMs: 10,
    });
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
  });

  test("the honest canary step is deterministic and mechanical (never smoothed claims)", () => {
    const row = rowById("rag-deterministic-function-clean-promotion");
    const input = {
      sourceProposalId: row.sourceProposalId,
      replacementShape: row.replacementShape,
      declaredCapabilities: row.declaredCapabilities,
      acceptanceCriterion: row.acceptanceCriterion,
      trafficPopulation: row.trafficPopulation,
      stepIndex: 3,
      sliceFraction: 0.5,
      budgetLimit: row.failureBudget.maxDivergencesPerStep,
    };
    const step = deriveHonestCanaryStep(input);
    const again = deriveHonestCanaryStep(input);
    expect(JSON.stringify(again)).toBe(JSON.stringify(step));
    // The slice membership is the deterministic function of the pinned
    // fraction; the citation is the source proposal; the exercised
    // capabilities are the declaration.
    expect(step.sliceCaseIds).toEqual(
      sliceCaseIdsOf(
        row.trafficPopulation.map((tcase) => tcase.caseId),
        0.5,
      ),
    );
    expect(step.citedProposalId).toBe(row.sourceProposalId);
    expect(step.exercisedCapabilities).toEqual([...row.declaredCapabilities]);
    // Every claim is the MECHANICAL criterion evaluation and the
    // asserted aggregate is the mechanical count.
    expect(step.aggregateClaim).toEqual({
      assertedDivergenceCount: step.outcomes.filter((outcome) => !outcome.claimedAgrees).length,
      assertedWithinBudget: true,
    });
    // The canary cost is the reference measurement (booked apart).
    expect(step.canaryCost).toEqual(referenceCanaryMeasurementOf(step.sliceCaseIds));
    // The removed-call shape over the reuse row diverges on EVERY case
    // of its slice — the honest breach basis.
    const reuseRow = rowById("reuse-removed-call-budget-breach-rollback");
    const reuseStep = deriveHonestCanaryStep({
      sourceProposalId: reuseRow.sourceProposalId,
      replacementShape: reuseRow.replacementShape,
      declaredCapabilities: reuseRow.declaredCapabilities,
      acceptanceCriterion: reuseRow.acceptanceCriterion,
      trafficPopulation: reuseRow.trafficPopulation,
      stepIndex: 1,
      sliceFraction: reuseRow.rampSchedule[0]?.trafficFraction ?? 0.05,
      budgetLimit: reuseRow.failureBudget.maxDivergencesPerStep,
    });
    expect(reuseStep.outcomes.every((outcome) => !outcome.claimedAgrees)).toBe(true);
    expect(reuseStep.aggregateClaim).toEqual({
      assertedDivergenceCount: reuseStep.sliceCaseIds.length,
      assertedWithinBudget: false,
    });
  });

  test("the canary ledger is append-only exactly-once (decisions, divergences, rollback events, costs)", async () => {
    const ledger = createCanaryLedger();
    const decision = {
      proposalId: "cand-learning-discovery-aaaaaaaa",
      stepIndex: 1,
      kind: "advance" as const,
      sliceFraction: 0.05,
      observedDivergenceCount: 0,
      budgetLimit: 1,
      policyCitations: {
        rampScheduleDigest: rampScheduleDigestOf(
          rowById("rag-deterministic-function-clean-promotion").rampSchedule,
        ),
        failureBudgetStated: true,
        toleranceStated: true,
      },
      policyChecks: { rampChecked: true, budgetChecked: true, toleranceChecked: true },
    };
    const first = await ledger.appendDecision(decision);
    expect(first).toEqual({ accepted: true, replayed: false, refused: false });
    // The IDENTICAL re-append REPLAYS (idempotent — exactly-once).
    const second = await ledger.appendDecision(decision);
    expect(second).toEqual({ accepted: true, replayed: true, refused: false });
    expect(ledger.decisionsFor(decision.proposalId)).toHaveLength(1);
    // A DIFFERENT decision under the recorded (proposalId, stepIndex)
    // key is REFUSED (the decision record is immutable).
    const decisionImpostor = await ledger.appendDecision({
      ...decision,
      kind: "breach-rollback" as const,
    });
    expect(decisionImpostor).toEqual({ accepted: false, replayed: false, refused: true });
    expect(ledger.decisionsFor(decision.proposalId)).toHaveLength(1);

    // The divergence ledger rides the same exactly-once discipline.
    const divergence = {
      proposalId: decision.proposalId,
      stepIndex: 1,
      caseId: "exp-workload-replay-11111111",
      incumbentDigest: "11111111",
      replacementDigest: "22222222",
    };
    expect(await ledger.appendDivergence(divergence)).toEqual({
      accepted: true,
      replayed: false,
      refused: false,
    });
    expect(await ledger.appendDivergence(divergence)).toEqual({
      accepted: true,
      replayed: true,
      refused: false,
    });
    expect(await ledger.appendDivergence({ ...divergence, replacementDigest: "33333333" })).toEqual(
      { accepted: false, replayed: false, refused: true },
    );
    expect(ledger.divergencesFor(divergence.proposalId)).toHaveLength(1);

    // The rollback-event ledger rides the same discipline.
    const rollbackEvent = {
      proposalId: decision.proposalId,
      stepIndex: 1,
      planDigest: rollbackPlanDigestOf({
        proposalId: decision.proposalId,
        revertsServingTo: "incumbent",
        scopeFraction: 1,
      }),
      residualReplacementCaseIds: [],
    };
    expect(await ledger.appendRollbackEvent(rollbackEvent)).toEqual({
      accepted: true,
      replayed: false,
      refused: false,
    });
    expect(await ledger.appendRollbackEvent(rollbackEvent)).toEqual({
      accepted: true,
      replayed: true,
      refused: false,
    });
    expect(await ledger.appendRollbackEvent({ ...rollbackEvent, planDigest: "ffffffff" })).toEqual({
      accepted: false,
      replayed: false,
      refused: true,
    });
    expect(ledger.rollbackEventsFor(rollbackEvent.proposalId)).toHaveLength(1);

    // The cost booking rides the same discipline.
    const cost = {
      proposalId: decision.proposalId,
      marker: "canary" as const,
      microUsd: 21,
      latencyMs: 42,
    };
    expect(await ledger.bookCanaryCost(cost)).toEqual({
      accepted: true,
      replayed: false,
      refused: false,
    });
    expect(await ledger.bookCanaryCost(cost)).toEqual({
      accepted: true,
      replayed: true,
      refused: false,
    });
    expect(ledger.canaryCostsFor(cost.proposalId)).toHaveLength(1);
    expect(ledger.decisionProposalIds).toEqual([decision.proposalId]);
  });

  test("the honest control: every offline row's canary run behaves per its pin over the fixture stack", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const stack = createHonestCanaryStack();
      const result: CanaryRunResult = await driveCanaryRun({
        row,
        registry: stack.registry,
        lifecycle: stack.lifecycle,
        canaryLedger: stack.canaryLedger,
        incumbentExecutor: stack.incumbentExecutor,
        trafficSource: stack.trafficSource,
        servingPath: stack.servingPath,
        canaryRuntime: stack.canaryRuntime,
        now: stack.clock.now,
      });
      expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
      if (row.expected.verdict === "honest-rollback") {
        // The honest rollback FAILs its observed-breach leg honestly
        // (the divergence count beyond the budget, recorded
        // case-by-case, never smoothed) while every OTHER leg passes.
        expect(
          criterionOf(result.criteria, "breach-observed-beyond-budget")?.status,
          `${row.rowId} honest breach`,
        ).toBe("FAIL");
        expect(
          criterionOf(result.criteria, "breach-beyond-budget-rolls-back")?.status,
          `${row.rowId} rolls back`,
        ).toBe("PASS");
        const failedOther = result.criteria.filter(
          (criterion) =>
            criterion.status === "FAIL" &&
            criterion.criterionId !== "breach-observed-beyond-budget",
        );
        expect(failedOther, `${row.rowId}: ${JSON.stringify(failedOther)}`).toEqual([]);
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
    // input the canary run appends FROM); zero applied candidates.
    for (const proposal of facts.proposals) {
      expect(proposal.lifecycleStage).toBe("proposed");
    }
    expect(facts.appliedCandidateCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The app contract over the fake-world knobs (the boundary catch)
// ---------------------------------------------------------------------------

describe("VAL-035 discrimination: the app contract over the fake-world knobs", () => {
  type Knobs = {
    readonly terminal?: "COMPLETED" | "FAILED";
    readonly skipped?: boolean;
    readonly unchecked?: boolean;
    readonly smoothed?: boolean;
    readonly overslice?: boolean;
    readonly foreigntenant?: boolean;
    readonly partialrollback?: boolean;
    readonly planmissing?: boolean;
    readonly escaping?: boolean;
    readonly unmeasured?: boolean;
    readonly unmarked?: boolean;
    readonly billed?: boolean;
  };

  async function runAppWithKnobs(
    options: Knobs,
  ): Promise<Awaited<ReturnType<typeof runCanaryPromotionApp>>> {
    const clock = createTickClock();
    const world = createCanaryFakeApiWorld({
      clock,
      ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
      ...(options.skipped === true ? { skipped: true } : {}),
      ...(options.unchecked === true ? { unchecked: true } : {}),
      ...(options.smoothed === true ? { smoothed: true } : {}),
      ...(options.overslice === true ? { overslice: true } : {}),
      ...(options.foreigntenant === true ? { foreigntenant: true } : {}),
      ...(options.partialrollback === true ? { partialrollback: true } : {}),
      ...(options.planmissing === true ? { planmissing: true } : {}),
      ...(options.escaping === true ? { escaping: true } : {}),
      ...(options.unmeasured === true ? { unmeasured: true } : {}),
      ...(options.unmarked === true ? { unmarked: true } : {}),
      ...(options.billed === true ? { billed: true } : {}),
    });
    return runCanaryPromotionApp({
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
        configuration: { suite: "val-035-discrimination" },
      },
      runSuffix: "discrimination",
      // The honest-rollback row: its breaching step, its exercised
      // rollback and its served outcomes make every knob visible at
      // the boundary read-back.
      taskIndex: taskIndexOf("reuse-removed-call-budget-breach-rollback"),
    });
  }

  test("the honest world passes the boundary contract (the control: only the honest-breach leg FAILs)", async () => {
    const outcome = await runAppWithKnobs({});
    // The boundary re-derivation honestly FAILs the observed-breach leg
    // (the recorded divergence count beyond the pinned budget) — never
    // a silent pass — while every other boundary leg passes.
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(outcome.appCriteria.filter((criterion) => criterion.status === "FAIL")).toEqual([
      outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-breach-observed-beyond-budget",
      ),
    ]);
    expect(outcome.verdict?.kind).toBe("honest-rollback");
    expect(outcome.lifecycleLanding?.finalStage).toBe(CANARY_STAGE);
  });

  test("EVERY fake-world knob FAILs a specific boundary criterion (never a silent pass)", async () => {
    const knobToCriterion: readonly { readonly knob: Knobs; readonly criterionId: string }[] = [
      { knob: { terminal: "COMPLETED" }, criterionId: "app-expected-terminal" },
      { knob: { skipped: true }, criterionId: "app-final-stage-pinned" },
      { knob: { unchecked: true }, criterionId: "app-policy-every-item-checked" },
      { knob: { smoothed: true }, criterionId: "app-breach-beyond-budget-rolls-back" },
      { knob: { overslice: true }, criterionId: "app-slice-no-over-slice-serve" },
      { knob: { foreigntenant: true }, criterionId: "app-slice-no-over-slice-serve" },
      { knob: { partialrollback: true }, criterionId: "app-rollback-complete-mechanical" },
      { knob: { planmissing: true }, criterionId: "app-rollback-plan-recorded" },
      { knob: { escaping: true }, criterionId: "app-verdict-kind-pinned" },
      { knob: { unmeasured: true }, criterionId: "app-canary-cost-measured" },
      { knob: { unmarked: true }, criterionId: "app-canary-cost-marker-present" },
      { knob: { billed: true }, criterionId: "app-canary-cost-never-billed" },
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
