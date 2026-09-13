/**
 * The canary-promotion corpus (VAL-035, AC1): the declared rows of the
 * canary application — every row canaries ONE of VAL-034's
 * SHADOW-EXECUTED candidates (the lifecycle identity whose recorded
 * walk already ends at `shadow-executed` — the read-only input; the
 * registry entries are the frozen VAL-032 records and the lifecycle's
 * recorded VAL-033 + VAL-034 walk is never rewritten), pins the
 * replacement shape carried over from the differential evaluation
 * (with its declared capabilities and granted isolation surface — the
 * containment carry-over), pins the TRAFFIC population (the workload
 * mix the canary ramps over: the cited recorded replay populations
 * plus the pinned injected traffic probes), states the EXPLICIT
 * admission policy (the pinned RAMP SCHEDULE of increasing traffic
 * fractions ending at full traffic, the FAILURE BUDGET of max
 * divergences per step, and the DIVERGENCE TOLERANCE — stated AND
 * checked), and pins the expected outcome (the clean promotion through
 * the full ramp, the honest budget-breach rollback mid-ramp, or the
 * honest refusal — or the probe rows whose adversarial variants FAIL
 * in the later discrimination phases, designed here, pinned now).
 *
 * Per row the expected outcome is the HONEST canary derivation over
 * the pinned traffic population and the pinned policy (the pure
 * oracle): the slice membership is the deterministic function of the
 * pinned fraction, the replacement outcomes are the reference
 * replacement's deterministic digests, the observed divergence count
 * is evaluated mechanically per case, and the decision is the honest
 * judgment of that count against the pinned budget — a verdict is
 * never asserted, it is derived.
 *
 * Every offline row is deterministically reproducible (the canary
 * comparison is pure over the recorded digests); the live row is
 * env-gated on the operator-authorized rail and demands ONE REAL
 * residual-AI model round through the REAL platform model gateway.
 */

import type {
  CanaryCorpusRow,
  CanaryProbeKind,
  CanaryRefusalReason,
  RampStep,
} from "../../platform/canary-promotion";
import {
  CANARY_COST_MARKER,
  CANARY_STAGE,
  canaryCostDigestOf,
  canarySliceDigestOf,
  canaryTrajectoryStepsOf,
  deriveHonestCanaryStep,
  PROMOTED_STAGE,
  referenceCanaryMeasurementOf,
  sliceCaseIdsOf,
} from "../../platform/canary-promotion";
import type { AcceptanceCriterion, ReplacementShape } from "../../platform/equivalence-testing";
import {
  differentialPopulationDigestOf,
  lifecycleEvidenceDigestOf,
} from "../../platform/equivalence-testing";
import type { CandidateKind, CandidateLifecycleStage } from "../../platform/learning-discovery";
import { longitudinalDigestOf, trajectoryDigestOf } from "../../platform/longitudinal-baseline";
import {
  adversarialCasesOf,
  historicalCasesOf,
  phantomProposalIdOf,
  registryProposalOf,
  type SourceProposalPin,
} from "../equivalence-testing/corpus";
import { recordedObservationsOf } from "../learning-discovery/corpus";
import {
  pinnedShadowRunOf,
  REGISTRY_SEED_PROPOSALS,
  SHADOW_EXECUTION_CORPUS,
} from "../shadow-execution/corpus";

/** The task kind every canary submission carries (the app's task vocabulary). */
export const CANARY_PROMOTION_TASK_KIND = "canary-promotion.governed-ramp.v1";

/** The canonical four-step governed ramp (5% → 25% → 50% → 100%). */
export const DEFAULT_RAMP_SCHEDULE: readonly RampStep[] = [
  { stepIndex: 1, trafficFraction: 0.05 },
  { stepIndex: 2, trafficFraction: 0.25 },
  { stepIndex: 3, trafficFraction: 0.5 },
  { stepIndex: 4, trafficFraction: 1 },
];

// ---------------------------------------------------------------------------
// The prior walk (VAL-033 + VAL-034's recorded landing — the read-only lifecycle input)
// ---------------------------------------------------------------------------

/** The recorded prior-walk transition shape (the read-only pre-seed). */
export interface PriorWalkTransition {
  readonly proposalId: string;
  readonly toStage: CandidateLifecycleStage;
  readonly evidenceDigest: string;
  readonly ordinal: number;
}

/**
 * The recorded prior walk for one canary row's candidate (the
 * read-only lifecycle input): the `offline-replayed` +
 * `differentially-evaluated` + `shadow-executed` transitions with
 * their CANONICAL evidence digests — re-derived exactly as VAL-033's
 * and VAL-034's drivers appended them (the covered replay identities
 * as the replay evidence members; the shadow row's regression verdict
 * digest as the evaluation and the shadow evidence member). The
 * canary run APPENDS its `canaried` (and on a clean full ramp,
 * `promoted`) transitions to this walk; it never rewrites it.
 */
export function priorWalkOf(row: CanaryCorpusRow): readonly PriorWalkTransition[] {
  const shadowRow = SHADOW_EXECUTION_CORPUS.find(
    (candidate) => candidate.sourceProposalId === row.sourceProposalId,
  );
  if (shadowRow === undefined) {
    throw new Error(
      `the canary row ${row.rowId} cites ${row.sourceProposalId} — no shadow-executed walk is recorded for it`,
    );
  }
  const coveredReplayIdentities = shadowRow.trafficPopulation
    .filter((tcase) => tcase.source === "historical-replay")
    .map((tcase) => tcase.sourceRef);
  const { regression } = pinnedShadowRunOf(shadowRow);
  return [
    {
      proposalId: row.sourceProposalId,
      toStage: "offline-replayed",
      evidenceDigest: lifecycleEvidenceDigestOf({
        proposalId: row.sourceProposalId,
        stage: "offline-replayed",
        members: coveredReplayIdentities,
      }),
      ordinal: 1,
    },
    {
      proposalId: row.sourceProposalId,
      toStage: "differentially-evaluated",
      evidenceDigest: lifecycleEvidenceDigestOf({
        proposalId: row.sourceProposalId,
        stage: "differentially-evaluated",
        members: [regression.digest],
      }),
      ordinal: 2,
    },
    {
      proposalId: row.sourceProposalId,
      toStage: "shadow-executed",
      evidenceDigest: lifecycleEvidenceDigestOf({
        proposalId: row.sourceProposalId,
        stage: "shadow-executed",
        members: [regression.digest],
      }),
      ordinal: 3,
    },
  ];
}

/**
 * The pre-shadow walk for the NOT-YET-SHADOW-EXECUTED refusal row's
 * candidate: the recorded VAL-033 landing WITHOUT VAL-034's append —
 * the walk ends at `differentially-evaluated`, so an honest canary
 * run refuses (the candidate has not yet earned the canary's source
 * rung).
 */
export function notYetShadowedWalkOf(proposalId: string): readonly PriorWalkTransition[] {
  return [
    {
      proposalId,
      toStage: "offline-replayed",
      evidenceDigest: lifecycleEvidenceDigestOf({
        proposalId,
        stage: "offline-replayed",
        members: [longitudinalDigestOf(["not-yet-replay-evidence", proposalId])],
      }),
      ordinal: 1,
    },
    {
      proposalId,
      toStage: "differentially-evaluated",
      evidenceDigest: lifecycleEvidenceDigestOf({
        proposalId,
        stage: "differentially-evaluated",
        members: [longitudinalDigestOf(["not-yet-differential-evidence", proposalId])],
      }),
      ordinal: 2,
    },
  ];
}

// ---------------------------------------------------------------------------
// The row builder (the oracle's derivation)
// ---------------------------------------------------------------------------

/**
 * Build one canary row over a pinned candidate (the VAL-034
 * shadow-executed lifecycle identity): the traffic population is the
 * cited recorded replay inputs plus the row's pinned injected traffic
 * probes; the pinned policy is the ramp schedule + the failure budget
 * + the divergence tolerance; and the expected outcome is the HONEST
 * canary derivation over the population and the policy (the pure
 * oracle — a clean promotion through the full ramp, an honest
 * budget-breach rollback mid-ramp, or an honest refusal), with the
 * pinned canary-trajectory class the canonical run trajectory's
 * single-member class.
 */
function canaryRow(input: {
  readonly rowId: string;
  readonly description: string;
  /** The pinned source candidate (null ⇒ the row cites the phantom identity). */
  readonly sourceProposal: SourceProposalPin | null;
  /**
   * Whether the candidate's recorded walk has reached the
   * shadow-executed stage (false ⇒ the premature refusal row).
   */
  readonly candidateShadowExecuted: boolean;
  readonly replacementShape: ReplacementShape;
  readonly declaredCapabilities: readonly string[];
  readonly grantedIsolationSurface: readonly string[];
  readonly replayPopulationRefs: readonly string[];
  readonly injectedProbeCount: number;
  /** The comparison tolerance's kind (the EXPLICIT tolerance). */
  readonly criterionKind: AcceptanceCriterion["kind"];
  /** Whether the tolerance's tolerated set is the row's injected probes. */
  readonly tolerateInjectedProbes?: boolean;
  /** The pinned ramp schedule (the default four-step governed ramp). */
  readonly rampSchedule?: readonly RampStep[];
  /** The pinned failure budget (max divergences tolerated per step). */
  readonly maxDivergencesPerStep: number;
  readonly probe?: { readonly kind: CanaryProbeKind };
  readonly needsDispatch?: boolean;
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
}): CanaryCorpusRow {
  const sourceProposalId =
    input.sourceProposal === null ? phantomProposalIdOf() : input.sourceProposal.proposalId;
  const refusalReason: CanaryRefusalReason | undefined =
    input.sourceProposal === null
      ? "candidate-unregistered"
      : input.candidateShadowExecuted
        ? undefined
        : "candidate-not-shadow-executed";
  const injected = adversarialCasesOf({
    rowId: input.rowId,
    count: input.injectedProbeCount,
  });
  const population = [...historicalCasesOf(input.replayPopulationRefs), ...injected];
  const acceptanceCriterion: AcceptanceCriterion = {
    kind: input.criterionKind,
    ...(input.criterionKind === "per-case-tolerance"
      ? {
          toleratedCaseIds:
            input.tolerateInjectedProbes === false ? [] : injected.map((tcase) => tcase.caseId),
        }
      : {}),
  };
  const rampSchedule = input.rampSchedule ?? DEFAULT_RAMP_SCHEDULE;
  const failureBudget = { maxDivergencesPerStep: input.maxDivergencesPerStep };
  const needsDispatch = input.needsDispatch ?? false;
  // The run's own dispatch demand: ONE REAL residual-AI confirmation
  // round on the live rail; zero offline (the offline canary
  // comparison is digest-level).
  const modelCalls = needsDispatch ? 1 : 0;

  // The recorded workload mix basis: every cited population ref is a
  // workload class; the injected probes are their own class.
  const trafficWorkloadClasses: Record<string, string> = {};
  for (const ref of input.replayPopulationRefs) {
    for (const observation of recordedObservationsOf(ref)) {
      trafficWorkloadClasses[observation.replayIdentity] = ref;
    }
  }
  for (const tcase of injected) {
    trafficWorkloadClasses[tcase.caseId] = "injected-probe";
  }

  // The honest derivation over the pinned traffic population and the
  // pinned policy (the pure oracle): advance the ramp one step at a
  // time, judging each step's mechanically-derived divergence count
  // against the pinned budget.
  let expectedVerdict: CanaryCorpusRow["expected"]["verdict"];
  let expectedRefusalReason: CanaryRefusalReason | null = null;
  let breachingStepIndex: number | null = null;
  let expectedFinalStage: CandidateLifecycleStage | null = null;
  let expectedTerminal: "COMPLETED" | "FAILED";
  const trajectoryStepsInput: {
    readonly stepIndex: number;
    readonly sliceDigest: string;
    readonly decisionKind: "advance" | "breach-rollback" | "refuse";
    readonly divergenceCount: number;
    readonly rollbackExercised: boolean;
  }[] = [];
  let canaryCostMicroUsd = 0;
  let canaryCostLatencyMs = 0;
  if (refusalReason !== undefined) {
    expectedVerdict = "honest-refusal";
    expectedRefusalReason = refusalReason;
    expectedTerminal = "COMPLETED";
  } else {
    const populationCaseIds = population.map((tcase) => tcase.caseId);
    for (const step of rampSchedule) {
      const honest = deriveHonestCanaryStep({
        sourceProposalId,
        replacementShape: input.replacementShape,
        declaredCapabilities: input.declaredCapabilities,
        acceptanceCriterion,
        trafficPopulation: population,
        stepIndex: step.stepIndex,
        sliceFraction: step.trafficFraction,
        budgetLimit: failureBudget.maxDivergencesPerStep,
      });
      const divergenceCount = honest.outcomes.filter((outcome) => !outcome.claimedAgrees).length;
      const beyondBudget = divergenceCount > failureBudget.maxDivergencesPerStep;
      trajectoryStepsInput.push({
        stepIndex: step.stepIndex,
        sliceDigest: canarySliceDigestOf({
          proposalId: sourceProposalId,
          stepIndex: step.stepIndex,
          sliceCaseIds: sliceCaseIdsOf(populationCaseIds, step.trafficFraction),
        }),
        decisionKind: beyondBudget ? "breach-rollback" : "advance",
        divergenceCount,
        rollbackExercised: beyondBudget,
      });
      const measurement = referenceCanaryMeasurementOf(honest.sliceCaseIds);
      canaryCostMicroUsd += measurement.microUsd;
      canaryCostLatencyMs += measurement.latencyMs;
      if (beyondBudget) {
        breachingStepIndex = step.stepIndex;
        break;
      }
    }
    if (breachingStepIndex !== null) {
      expectedVerdict = "honest-rollback";
      expectedFinalStage = CANARY_STAGE;
      expectedTerminal = "FAILED";
    } else {
      expectedVerdict = "clean-promotion";
      expectedFinalStage = PROMOTED_STAGE;
      expectedTerminal = "COMPLETED";
    }
  }

  const trajectorySteps = canaryTrajectoryStepsOf({
    proposalId: sourceProposalId,
    populationDigest: differentialPopulationDigestOf(population),
    steps: trajectoryStepsInput,
    canaryCostDigest:
      refusalReason === undefined
        ? canaryCostDigestOf({
            proposalId: sourceProposalId,
            marker: CANARY_COST_MARKER,
            microUsd: canaryCostMicroUsd,
            latencyMs: canaryCostLatencyMs,
          })
        : null,
    landedStages:
      expectedFinalStage === PROMOTED_STAGE
        ? [CANARY_STAGE, PROMOTED_STAGE]
        : expectedFinalStage === CANARY_STAGE
          ? [CANARY_STAGE]
          : [],
    refusalReason: expectedRefusalReason,
    confirmationRounds: modelCalls,
  });

  return {
    rowId: input.rowId,
    description: input.description,
    sourceProposalId,
    replacementShape: input.replacementShape,
    declaredCapabilities: [...input.declaredCapabilities],
    grantedIsolationSurface: [...input.grantedIsolationSurface],
    trafficPopulation: population,
    trafficWorkloadClasses,
    acceptanceCriterion,
    rampSchedule,
    failureBudget,
    expected: {
      verdict: expectedVerdict,
      refusalReason: expectedRefusalReason,
      breachingStepIndex,
      finalStage: expectedFinalStage,
      modelCalls,
      terminal: expectedTerminal,
    },
    expectedTrajectoryClass: [trajectoryDigestOf(trajectorySteps)],
    ...(input.probe === undefined ? {} : { probe: input.probe }),
    needsDispatch,
    ...(input.liveGate === undefined ? {} : { liveGate: input.liveGate }),
  };
}

// ---------------------------------------------------------------------------
// The pinned candidate registry seed (the read-only input)
// ---------------------------------------------------------------------------

/** The RAG deterministicization candidate (the VAL-032 registry identity). */
const RAG_DETERMINISTICIZATION = registryProposalOf({
  candidateKind: "deterministicization",
  replayPopulationRefs: ["rag-retrieval-replay-population"],
});

/** The text-summarize deterministicization candidate. */
const TEXT_SUMMARIZE_DETERMINISTICIZATION = registryProposalOf({
  candidateKind: "deterministicization",
  replayPopulationRefs: ["text-summarize-replay-population"],
});

/** The order-settlement cache candidate. */
const ORDER_SETTLEMENT_CACHE = registryProposalOf({
  candidateKind: "cache",
  replayPopulationRefs: ["order-settlement-varying-replay-population"],
});

/** The tool-agent competence candidate. */
const TOOL_LOOP_COMPETENCE = registryProposalOf({
  candidateKind: "competence",
  replayPopulationRefs: ["tool-agent-loop-replay-population"],
});

/** The cross-workload reuse candidate (the honest-breach row's source). */
const CROSS_WORKLOAD_REUSE = registryProposalOf({
  candidateKind: "reuse",
  replayPopulationRefs: ["text-summarize-replay-population", "probe-duplicate-replay"],
});

/** The live-control deterministicization candidate (the live row's source). */
const LIVE_CONTROL_DETERMINISTICIZATION = registryProposalOf({
  candidateKind: "deterministicization",
  replayPopulationRefs: ["live-replay-dispatch-population"],
});

/**
 * The NOT-YET-SHADOW-EXECUTED candidate: a registered VAL-032
 * candidate whose recorded walk ends at `differentially-evaluated`
 * (VAL-033's landing) — VAL-034's shadow never appended for it, so an
 * honest canary run refuses (a premature canary). Distinct registry
 * identity (a different kind over the same recorded population).
 */
const NOT_YET_SHADOWED_CACHE = registryProposalOf({
  candidateKind: "cache",
  replayPopulationRefs: ["probe-duplicate-replay"],
});

/**
 * The registry seed (the READ-ONLY proposals the fake candidate
 * registry pre-seeds): VAL-034's registry membership (the six honest
 * shadow-executed identities + the single-replay degenerate entry)
 * plus the not-yet-shadow-executed entry the premature-refusal row
 * cites. The phantom identity of the unregistered-refusal row is
 * deliberately NOT a member.
 */
export const REGISTRY_SEED_PROPOSALS_FOR_CANARY: readonly SourceProposalPin[] = [
  ...REGISTRY_SEED_PROPOSALS,
  NOT_YET_SHADOWED_CACHE,
];

/**
 * The registry entries the canary corpus pins (every row's source
 * candidate, deduplicated) — exported for the consistency tests (the
 * fake registry pre-seeds exactly this membership).
 */
export const PINNED_REGISTRY_ENTRIES: readonly SourceProposalPin[] = [
  ...new Map(REGISTRY_SEED_PROPOSALS_FOR_CANARY.map((pin) => [pin.proposalId, pin])).values(),
];

/** The candidate kinds the canary corpus canaries (the VAL-032 vocabulary). */
export const CANARIED_CANDIDATE_KINDS: readonly CandidateKind[] = [
  "deterministicization",
  "cache",
  "competence",
  "reuse",
];

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

/** The offline rows (deterministic — always drivable, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly CanaryCorpusRow[] = [
  canaryRow({
    rowId: "rag-deterministic-function-clean-promotion",
    description:
      "The clean-promotion row: the RAG deterministic-function candidate (VAL-034's shadow agreement — its recorded walk already ends at shadow-executed) canaries under the DEFAULT governed ramp (5% → 25% → 50% → 100%) with a pinned failure budget of ONE divergence per step under the EXACT-DIGEST-EQUALITY tolerance. The reference replacement's digests reproduce the incumbent's on every case, so every step's observed divergence count is zero — every decision advances honestly, the canary lands its `canaried` rung, the full-traffic step passes, and the run lands `promoted` (the FINAL stage) one evidenced rung at a time. The rollback plan is recorded (the reversibility contract) and never demanded.",
    sourceProposal: RAG_DETERMINISTICIZATION,
    candidateShadowExecuted: true,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
    maxDivergencesPerStep: 1,
  }),
  canaryRow({
    rowId: "text-summarize-split-preprocessing-clean-promotion",
    description:
      "The split-preprocessing clean promotion: the text-summarize candidate canaries over the five recorded replay inputs plus two injected probes under the DIGEST-CLASS-EQUALITY tolerance (equality is NOT required for semantic outputs — the criterion is explicit and mechanically evaluated per case). Every step's observed divergence count stays within the pinned budget of one; the customer is served the incumbent's outcome outside the slice and the replacement's outcome inside it; the run lands `promoted` after the full-traffic step.",
    sourceProposal: TEXT_SUMMARIZE_DETERMINISTICIZATION,
    candidateShadowExecuted: true,
    replacementShape: "split-preprocessing-residual",
    declaredCapabilities: ["pure-computation", "granted-fixture-read"],
    grantedIsolationSurface: ["pure-computation", "granted-fixture-read"],
    replayPopulationRefs: ["text-summarize-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "digest-class-equality",
    maxDivergencesPerStep: 1,
  }),
  canaryRow({
    rowId: "order-settlement-retrieval-clean-promotion",
    description:
      "The equality-not-required clean promotion: the order-settlement CACHE candidate canaries as a RETRIEVAL-PIPELINE over the four recorded replay inputs plus two injected probes under DIGEST-CLASS-EQUALITY with a pinned budget of ZERO divergences per step. The retrieval's deterministic answer is a member of each case's pinned class, so every step observes zero divergences and advances — a semantic-output promotion that exact-digest-equality would honestly report as breaches. The canary cost is measured apart under its canary marker throughout.",
    sourceProposal: ORDER_SETTLEMENT_CACHE,
    candidateShadowExecuted: true,
    replacementShape: "retrieval-pipeline",
    declaredCapabilities: ["pure-computation", "granted-fixture-read"],
    grantedIsolationSurface: ["pure-computation", "granted-fixture-read"],
    replayPopulationRefs: ["order-settlement-varying-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "digest-class-equality",
    maxDivergencesPerStep: 0,
  }),
  canaryRow({
    rowId: "tool-loop-reusable-tool-clean-promotion-tolerance",
    description:
      "The per-case-tolerance clean promotion: the tool-agent COMPETENCE candidate canaries as a REUSABLE-TOOL over the three recorded replay inputs plus two injected probes (the first carrying a TWO-member pinned class) under PER-CASE-TOLERANCE: the historical cases demand digest identity, the injected probes are the explicitly tolerated divergence set. The tolerance is stated AND mechanically checked on every case of every step — a tolerated id outside the population would be a malformed criterion; every step advances and the run lands `promoted`.",
    sourceProposal: TOOL_LOOP_COMPETENCE,
    candidateShadowExecuted: true,
    replacementShape: "reusable-tool",
    declaredCapabilities: ["pure-computation", "granted-fixture-read"],
    grantedIsolationSurface: ["pure-computation", "granted-fixture-read"],
    replayPopulationRefs: ["tool-agent-loop-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "per-case-tolerance",
    maxDivergencesPerStep: 1,
  }),
  canaryRow({
    rowId: "reuse-removed-call-budget-breach-rollback",
    description:
      "The honest budget-breach rollback row (the FAILED shape): the cross-workload REUSE candidate canaries as a REMOVED-CALL replacement under the EXACT-DIGEST-EQUALITY tolerance with a pinned budget of ZERO divergences per step — and the removal diverges on EVERY case BY CONSTRUCTION (the incumbent's redundant call disappears; the shadow recorded the same divergences case-by-case). At the FIRST ramp step (5% — one case) the observed divergence count exceeds the budget: the step FAILs honestly, the decision is breach-rollback, the served traffic reverts to the incumbent across the whole slice (the complete, mechanical, EXERCISED rollback), and the run lands its `canaried` rung only — never `promoted`. This is the oracle's honesty reference: a smoothed breach that advanced, or a partial rollback that left a residual, would FAIL mechanically.",
    sourceProposal: CROSS_WORKLOAD_REUSE,
    candidateShadowExecuted: true,
    replacementShape: "removed-call",
    declaredCapabilities: [],
    grantedIsolationSurface: [],
    replayPopulationRefs: ["text-summarize-replay-population", "probe-duplicate-replay"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
    maxDivergencesPerStep: 0,
  }),
  canaryRow({
    rowId: "unregistered-candidate-canary-refusal",
    description:
      "The unregistered-refusal row (the honest refusal): the row cites a candidate identity the candidate registry NEVER recorded (a phantom identity). The candidate's own state does not support a canary run — there is no candidate — so the run refuses honestly (reason `candidate-unregistered`): no traffic executes, no slice serves, nothing is appended to the candidate lifecycle. A run that canaried anyway (or fabricated a promotion for the phantom) would FAIL the refusal honesty mechanically.",
    sourceProposal: null,
    candidateShadowExecuted: false,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
    maxDivergencesPerStep: 1,
  }),
  canaryRow({
    rowId: "not-yet-shadow-executed-canary-refusal",
    description:
      "The premature-refusal row (the honest refusal): the row cites a REGISTERED candidate whose recorded lifecycle walk ends at `differentially-evaluated` (VAL-033's landing) — VAL-034's shadow never appended for it. A canary run for a candidate not yet shadow-executed refuses honestly (reason `candidate-not-shadow-executed`): nothing executes, nothing lands — and an appended canaried/promoted transition for it would FAIL the lifecycle completeness mechanically (a skipped lifecycle never promotes).",
    sourceProposal: NOT_YET_SHADOWED_CACHE,
    candidateShadowExecuted: false,
    replacementShape: "retrieval-pipeline",
    declaredCapabilities: ["pure-computation", "granted-fixture-read"],
    grantedIsolationSurface: ["pure-computation", "granted-fixture-read"],
    replayPopulationRefs: ["probe-duplicate-replay"],
    injectedProbeCount: 2,
    criterionKind: "digest-class-equality",
    maxDivergencesPerStep: 1,
  }),
  canaryRow({
    rowId: "probe-skipped-lifecycle",
    description:
      "The skipped-lifecycle probe (the phase-2 discrimination hook, pinned now): the honest row is the RAG clean promotion over the full evidenced chain; over the BROKEN-LIFECYCLE ledger variant the candidate's pre-seeded walk drops the shadow-executed transition (the canary refuses honestly instead — a candidate that skipped its shadow rung), and over the JUMP-TO-PROMOTED ledger variant the append lands `promoted` directly without the `canaried` rung — each FAILs the lifecycle completeness mechanically (the walk must be the full evidenced chain, advanced one rung at a time; a skipped stage, a broken walk or an unevidenced transition FAILs).",
    sourceProposal: RAG_DETERMINISTICIZATION,
    candidateShadowExecuted: true,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
    maxDivergencesPerStep: 1,
    probe: { kind: "skipped-lifecycle" },
  }),
  canaryRow({
    rowId: "probe-unchecked-policy",
    description:
      "The unchecked-policy probe (the phase-2 discrimination hook, pinned now): the honest row is the RAG clean promotion whose every decision cites its stated-and-checked ramp/budget/tolerance; over the POLICY-BLIND runtime variant the decisions cite no tolerance (or state a budget they never check) — and the policy explicitness FAILs mechanically with the unchecked item named (an unstated policy, or a stated-but-unchecked budget/tolerance, FAILs; the decisionless-step variant skips a step's decision entirely).",
    sourceProposal: RAG_DETERMINISTICIZATION,
    candidateShadowExecuted: true,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
    maxDivergencesPerStep: 1,
    probe: { kind: "unchecked-policy" },
  }),
  canaryRow({
    rowId: "probe-smoothed-breach",
    description:
      "The smoothed-breach probe (the phase-2 discrimination hook, pinned now): the honest row is the reuse candidate's honest rollback (the beyond-budget count FAILs the step and triggers the complete rollback); over the SMOOTHING runtime variant a beyond-budget divergence count is claimed within and the step ADVANCES anyway — and the breach honesty FAILs mechanically (a smoothed breach that advances FAILs; a breach decision without the rollback trigger FAILs just the same).",
    sourceProposal: CROSS_WORKLOAD_REUSE,
    candidateShadowExecuted: true,
    replacementShape: "removed-call",
    declaredCapabilities: [],
    grantedIsolationSurface: [],
    replayPopulationRefs: ["text-summarize-replay-population", "probe-duplicate-replay"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
    maxDivergencesPerStep: 0,
    probe: { kind: "smoothed-breach" },
  }),
  canaryRow({
    rowId: "probe-over-slice",
    description:
      "The over-slice probe (the phase-2 discrimination hook, pinned now): the honest row is the RAG clean promotion serving exactly the pinned slice at every step; over the OVER-SLICE serving-path variant the replacement is served BEYOND the step's pinned fraction (an unpromoted candidate serving beyond its canary slice), and over the OUT-OF-SLICE-TENANT variant a tenant whose cases lie outside the granted slice is served the replacement — each FAILs the slice isolation mechanically (an unpromoted candidate serves ONLY its canary slice; after promotion the full traffic may serve the replacement).",
    sourceProposal: RAG_DETERMINISTICIZATION,
    candidateShadowExecuted: true,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
    maxDivergencesPerStep: 1,
    probe: { kind: "over-slice" },
  }),
  canaryRow({
    rowId: "probe-partial-rollback",
    description:
      "The partial-rollback probe (the phase-2 discrimination hook, pinned now): the honest row is the reuse candidate's COMPLETE mechanical rollback (the served traffic reverts to the incumbent across the whole slice, the plan exercised); over the PARTIAL-ROLLBACK serving-path variant the revert leaves a residual case still serving the replacement — and the rollback completeness FAILs mechanically with the residual named (never partial); over the UNEXERCISED ledger variant the breach's rollback plan is never exercised — an unevidenced rollback plan — and FAILs just the same.",
    sourceProposal: CROSS_WORKLOAD_REUSE,
    candidateShadowExecuted: true,
    replacementShape: "removed-call",
    declaredCapabilities: [],
    grantedIsolationSurface: [],
    replayPopulationRefs: ["text-summarize-replay-population", "probe-duplicate-replay"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
    maxDivergencesPerStep: 0,
    probe: { kind: "partial-rollback" },
  }),
  canaryRow({
    rowId: "probe-mid-canary-escape",
    description:
      "The mid-canary-escape probe (the phase-2 discrimination hook, pinned now): the honest row is the RAG clean promotion with the replacement contained in its granted surface DURING the canary (the containment carry-over); over the ESCAPING runtime variant the untrusted code exercises NETWORK ACCESS mid-canary (an undeclared, ungranted capability) — a containment violation — and the isolation derivation FAILs mechanically (the escape is recorded, never silently forgiven; the violating canary never lands).",
    sourceProposal: RAG_DETERMINISTICIZATION,
    candidateShadowExecuted: true,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
    maxDivergencesPerStep: 1,
    probe: { kind: "mid-canary-escape" },
  }),
];

// ---------------------------------------------------------------------------
// The live rows (env-gated on the authorized rail; REAL residual-AI round)
// ---------------------------------------------------------------------------

/** The live rows (env-gated on the authorized rail; REAL residual-AI round). */
export const LIVE_CORPUS_ROWS: readonly CanaryCorpusRow[] = [
  canaryRow({
    rowId: "live-split-preprocessing-canary-confirmation",
    description:
      "A REAL governed canary (env-gated): the live-control deterministicization candidate (the VAL-032 registry identity mined from the live replay population's two REAL recorded replays — its recorded walk ends at shadow-executed) canaries as a SPLIT-PREPROCESSING-RESIDUAL replacement over the two cited live replay inputs plus two injected probes under DIGEST-CLASS-EQUALITY with the DEFAULT governed ramp and a pinned budget of one divergence per step — the incumbent serves the remainder at every step, the canary cost is measured apart under its canary marker — and the run itself demands ONE REAL residual-AI model round through the REAL platform model gateway (measured usage, never estimated, never fabricated) before the promoted rung appends to the candidate lifecycle.",
    sourceProposal: LIVE_CONTROL_DETERMINISTICIZATION,
    candidateShadowExecuted: true,
    replacementShape: "split-preprocessing-residual",
    declaredCapabilities: ["pure-computation", "granted-fixture-read"],
    grantedIsolationSurface: ["pure-computation", "granted-fixture-read"],
    replayPopulationRefs: ["live-replay-dispatch-population"],
    injectedProbeCount: 2,
    criterionKind: "digest-class-equality",
    maxDivergencesPerStep: 1,
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "the live row's REAL residual-AI confirmation round through the REAL platform model gateway",
    },
  }),
];

/** The full pinned corpus (offline rows first, live rows last). */
export const CANARY_PROMOTION_CORPUS: readonly CanaryCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: CanaryCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

// ---------------------------------------------------------------------------
// The submission keys + task bodies (the app's fingerprint discipline)
// ---------------------------------------------------------------------------

/**
 * The app's idempotency key for one canary submission: each row's run
 * lands its OWN durable execution (one submission per row — never a
 * re-issue of another row's key).
 */
export function canarySubmissionKey(options: {
  readonly runSuffix: string;
  readonly taskIndex: number;
}): string {
  return `val-035-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one canary submission: the task kind, the
 * pinned row, the canaried candidate and the CANARY-phase declaration
 * (the governed ramp under its explicit policy — task semantics,
 * never provider selection; the platform keeps the route authority).
 */
export function canaryTaskBodyFor(options: {
  readonly rowId: string;
  readonly sourceProposalId: string;
  readonly replacementShape: ReplacementShape;
}): Record<string, unknown> {
  return {
    kind: CANARY_PROMOTION_TASK_KIND,
    rowId: options.rowId,
    sourceProposalId: options.sourceProposalId,
    replacementShape: options.replacementShape,
    canary: { phase: "canary", mode: "governed-ramp" },
  };
}

/** The row ids in corpus order (config.json mirrors this slice). */
export const CANARY_PROMOTION_ROW_IDS: readonly string[] = CANARY_PROMOTION_CORPUS.map(
  (row) => row.rowId,
);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function canaryRowById(rowId: string): CanaryCorpusRow | null {
  return CANARY_PROMOTION_CORPUS.find((row) => row.rowId === rowId) ?? null;
}

/**
 * The VAL-031 replay populations this corpus references (the
 * read-only input rows, deduplicated in first-reference order —
 * exported for the fixture world's consistency tests).
 */
export const REFERENCED_REPLAY_POPULATION_REFS: readonly string[] = [
  ...new Set(
    CANARY_PROMOTION_CORPUS.flatMap((row) =>
      [...new Set(Object.values(row.trafficWorkloadClasses))].filter(
        (workloadClass) => workloadClass !== "injected-probe",
      ),
    ),
  ),
];

/**
 * Re-derive the pinned expected ramp of one corpus row (the oracle
 * proper — exported for the consistency tests and the fake world):
 * the honest canary steps over the row's declared traffic population
 * and pinned policy, the per-step mechanically-derived divergences,
 * the breaching step (null when every step advanced), and the
 * aggregate canary cost.
 */
export function pinnedCanaryRampOf(row: CanaryCorpusRow) {
  const steps = row.rampSchedule.map((step) =>
    deriveHonestCanaryStep({
      sourceProposalId: row.sourceProposalId,
      replacementShape: row.replacementShape,
      declaredCapabilities: row.declaredCapabilities,
      acceptanceCriterion: row.acceptanceCriterion,
      trafficPopulation: row.trafficPopulation,
      stepIndex: step.stepIndex,
      sliceFraction: step.trafficFraction,
      budgetLimit: row.failureBudget.maxDivergencesPerStep,
    }),
  );
  const divergencesByStep = steps.map((step) => ({
    stepIndex: step.stepIndex,
    divergenceCaseIds: step.outcomes
      .filter((outcome) => !outcome.claimedAgrees)
      .map((outcome) => outcome.caseId),
  }));
  const breachingStepIndex =
    divergencesByStep.find(
      (step) => step.divergenceCaseIds.length > row.failureBudget.maxDivergencesPerStep,
    )?.stepIndex ?? null;
  const canaryCost = steps.reduce(
    (total, step) => {
      const measurement = referenceCanaryMeasurementOf(step.sliceCaseIds);
      return {
        microUsd: total.microUsd + measurement.microUsd,
        latencyMs: total.latencyMs + measurement.latencyMs,
      };
    },
    { microUsd: 0, latencyMs: 0 },
  );
  return { steps, divergencesByStep, breachingStepIndex, canaryCost };
}
