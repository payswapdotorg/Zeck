/**
 * The shadow-execution corpus (VAL-034, AC1): the declared rows of the
 * shadow application — every row shadows ONE of VAL-033's
 * DIFFERENTIALLY-EVALUATED candidates (the lifecycle identity whose
 * recorded walk already ends at `differentially-evaluated` — the
 * read-only input; the registry entries are the frozen VAL-032
 * records and the lifecycle's recorded VAL-033 walk is never
 * rewritten), pins the replacement shape carried over from the
 * differential evaluation (with its declared capabilities and granted
 * isolation surface — the containment carry-over), pins the TRAFFIC
 * population (the workload mix the shadow replays: the cited recorded
 * replay populations — VAL-031's recorded ledger identities with
 * their recorded incumbent outcome digests — plus the pinned injected
 * traffic probes), states the EXPLICIT comparison criterion (the
 * regression agreement basis — VAL-033's acceptance-criterion
 * vocabulary carried into the shadow), and pins the expected shadow
 * comparison (the shadow agreement, the honest divergence with its
 * divergent cases pinned case-by-case, or the honest refusal — or the
 * probe rows whose adversarial variants FAIL in the later
 * discrimination phases, designed here, pinned now).
 *
 * Per row the expected outcome is the HONEST shadow derivation over
 * the pinned traffic population (the pure oracle): the incumbent
 * outcomes are the recorded/pinned digests (the served leg), the
 * shadow outcomes are the reference replacement's deterministic
 * digests (the observation leg — recorded, never served), and the
 * regression comparison is re-derived mechanically per case — a
 * verdict is never asserted, it is derived.
 *
 * Every offline row is deterministically reproducible (the shadow
 * comparison is pure over the recorded digests); the live row is
 * env-gated on the operator-authorized rail and demands ONE REAL
 * residual-AI model round through the REAL platform model gateway.
 */

import type { AcceptanceCriterion, ReplacementShape } from "../../platform/equivalence-testing";
import type { CandidateKind } from "../../platform/learning-discovery";
import { longitudinalDigestOf, trajectoryDigestOf } from "../../platform/longitudinal-baseline";
import type {
  ShadowCorpusRow,
  ShadowProbeKind,
  ShadowRefusalReason,
} from "../../platform/shadow-execution";
import {
  deriveHonestShadowRun,
  deriveRegressionHonesty,
  referenceShadowMeasurementOf,
  shadowCostDigestOf,
  shadowPopulationDigestOf,
  shadowTrajectoryStepsOf,
} from "../../platform/shadow-execution";
import {
  adversarialCasesOf,
  historicalCasesOf,
  phantomProposalIdOf,
  registryProposalOf,
  type SourceProposalPin,
  singleReplayProposalPin,
} from "../equivalence-testing/corpus";
import { recordedObservationsOf } from "../learning-discovery/corpus";

/** The task kind every shadow submission carries (the app's task vocabulary). */
export const SHADOW_EXECUTION_TASK_KIND = "shadow-execution.regression.v1";

// ---------------------------------------------------------------------------
// The prior walk (VAL-033's recorded landing — the read-only lifecycle input)
// ---------------------------------------------------------------------------

/**
 * The recorded VAL-033 walk for one shadow row's candidate (the
 * read-only lifecycle input): the `offline-replayed` +
 * `differentially-evaluated` transitions with their CANONICAL evidence
 * digests — re-derived exactly as VAL-033's driver appended them (the
 * covered replay identities as the replay evidence members; the
 * differential verdict digest as the evaluation evidence member). The
 * shadow run APPENDS its `shadow-executed` transition to this walk;
 * it never rewrites it.
 */
export function priorWalkOf(row: ShadowCorpusRow): readonly {
  readonly proposalId: string;
  readonly toStage: "offline-replayed" | "differentially-evaluated";
  readonly evidenceDigest: string;
  readonly ordinal: number;
}[] {
  const { regression } = pinnedShadowRunOf(row);
  const coveredReplayIdentities = row.trafficPopulation
    .filter((tcase) => tcase.source === "historical-replay")
    .map((tcase) => tcase.sourceRef);
  return [
    {
      proposalId: row.sourceProposalId,
      toStage: "offline-replayed",
      evidenceDigest: longitudinalDigestOf([
        "lifecycle-evidence",
        row.sourceProposalId,
        "offline-replayed",
        coveredReplayIdentities,
      ]),
      ordinal: 1,
    },
    {
      proposalId: row.sourceProposalId,
      toStage: "differentially-evaluated",
      evidenceDigest: longitudinalDigestOf([
        "lifecycle-evidence",
        row.sourceProposalId,
        "differentially-evaluated",
        [regression.digest],
      ]),
      ordinal: 2,
    },
  ];
}

// ---------------------------------------------------------------------------
// The row builder (the oracle's derivation)
// ---------------------------------------------------------------------------

/**
 * Build one shadow row over a pinned candidate (the VAL-033
 * differentially-evaluated lifecycle identity): the traffic population
 * is the cited recorded replay inputs (re-declared from the ledger
 * vocabulary — every cited replay identity is a traffic case) plus the
 * row's pinned injected traffic probes; the shadow outcomes are the
 * reference replacement's deterministic digests (the observation
 * leg); the expected verdict is the HONEST regression derivation over
 * the population (the pure oracle — a shadow agreement, an honest
 * divergence with its divergent cases named, or an honest refusal),
 * and the pinned shadow-trajectory class is the canonical run
 * trajectory's single-member class.
 */
function shadowRow(input: {
  readonly rowId: string;
  readonly description: string;
  /** The pinned source candidate (null ⇒ the row cites the phantom identity). */
  readonly sourceProposal: SourceProposalPin | null;
  /**
   * Whether the candidate's recorded walk has reached the
   * differentially-evaluated stage (false ⇒ the premature refusal row).
   */
  readonly candidateDifferentiallyEvaluated: boolean;
  readonly replacementShape: ReplacementShape;
  readonly declaredCapabilities: readonly string[];
  readonly grantedIsolationSurface: readonly string[];
  readonly replayPopulationRefs: readonly string[];
  readonly injectedProbeCount: number;
  /** The 1-based injected-probe ordinal whose pinned class is two-member. */
  readonly twoMemberProbeOn?: number;
  /** The comparison criterion's kind (the EXPLICIT criterion). */
  readonly criterionKind: AcceptanceCriterion["kind"];
  /** Whether the criterion's tolerated set is the row's injected probes. */
  readonly tolerateInjectedProbes?: boolean;
  readonly probe?: { readonly kind: ShadowProbeKind };
  readonly needsDispatch?: boolean;
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
}): ShadowCorpusRow {
  const sourceProposalId =
    input.sourceProposal === null ? phantomProposalIdOf() : input.sourceProposal.proposalId;
  const refusalReason: ShadowRefusalReason | undefined =
    input.sourceProposal === null
      ? "candidate-unregistered"
      : input.candidateDifferentiallyEvaluated
        ? undefined
        : "candidate-not-differentially-evaluated";
  const injected = adversarialCasesOf({
    rowId: input.rowId,
    count: input.injectedProbeCount,
    ...(input.twoMemberProbeOn === undefined ? {} : { twoMemberOn: input.twoMemberProbeOn }),
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
  const needsDispatch = input.needsDispatch ?? false;
  // The run's own dispatch demand: ONE REAL residual-AI confirmation
  // round on the live rail; zero offline (the offline shadow
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

  // The honest derivation over the pinned traffic population (the pure oracle).
  const honestRun = deriveHonestShadowRun({
    sourceProposalId,
    replacementShape: input.replacementShape,
    declaredCapabilities: input.declaredCapabilities,
    acceptanceCriterion,
    trafficPopulation: population,
  });
  const regression = deriveRegressionHonesty({
    population,
    criterion: acceptanceCriterion,
    incumbentOutcomes: population.map((tcase) => ({
      caseId: tcase.caseId,
      digest: tcase.incumbentDigest,
    })),
    shadowOutcomes: honestRun.outcomes,
    comparedCaseIds: honestRun.comparedCaseIds,
    aggregateClaim: honestRun.aggregateClaim,
  });

  let expectedVerdict: ShadowCorpusRow["expected"]["verdict"];
  let expectedRefusalReason: ShadowRefusalReason | null = null;
  let expectedDivergenceCaseIds: readonly string[] = [];
  let expectedTerminal: "COMPLETED" | "FAILED";
  if (refusalReason !== undefined) {
    expectedVerdict = "honest-refusal";
    expectedRefusalReason = refusalReason;
    expectedTerminal = "COMPLETED";
  } else if (regression.honest && regression.mechanicalDivergenceCaseIds.length > 0) {
    expectedVerdict = "honest-divergence";
    expectedDivergenceCaseIds = [...regression.mechanicalDivergenceCaseIds];
    expectedTerminal = "FAILED";
  } else {
    expectedVerdict = "shadow-agreement";
    expectedTerminal = "COMPLETED";
  }

  const populationDigest = shadowPopulationDigestOf(population);
  const shadowMeasurement = referenceShadowMeasurementOf(population);
  const trajectorySteps = shadowTrajectoryStepsOf({
    proposalId: sourceProposalId,
    populationDigest,
    servedExecutionDigest: longitudinalDigestOf([
      "incumbent-served",
      ...population.map((tcase) => tcase.incumbentDigest),
    ]),
    shadowExecutionDigest: longitudinalDigestOf([
      "shadow-executed",
      ...honestRun.outcomes.map((outcome) => outcome.digest),
    ]),
    isolationContainment: refusalReason === undefined ? "contained" : null,
    regressionVerdictDigest: refusalReason === undefined ? regression.digest : null,
    divergenceCount: expectedDivergenceCaseIds.length,
    shadowCostDigest:
      refusalReason === undefined
        ? shadowCostDigestOf({
            proposalId: sourceProposalId,
            microUsd: shadowMeasurement.microUsd,
            latencyMs: shadowMeasurement.latencyMs,
          })
        : null,
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
    expected: {
      verdict: expectedVerdict,
      refusalReason: expectedRefusalReason,
      divergenceCaseIds: expectedDivergenceCaseIds,
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

/** The cross-workload reuse candidate. */
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
 * The registry seed (the READ-ONLY proposals the fake candidate
 * registry pre-seeds): the six honest VAL-032 registry identities the
 * shadow rows cite (each with its recorded VAL-033 walk in the
 * lifecycle ledger — the differentially-evaluated landing) plus the
 * single-replay degenerate entry whose walk NEVER started (VAL-033
 * refused it honestly — the premature-shadow refusal row's source).
 * The phantom identity of the unregistered-refusal row is
 * deliberately NOT a member.
 */
export const REGISTRY_SEED_PROPOSALS: readonly SourceProposalPin[] = [
  RAG_DETERMINISTICIZATION,
  TEXT_SUMMARIZE_DETERMINISTICIZATION,
  ORDER_SETTLEMENT_CACHE,
  TOOL_LOOP_COMPETENCE,
  CROSS_WORKLOAD_REUSE,
  LIVE_CONTROL_DETERMINISTICIZATION,
  singleReplayProposalPin(),
];

/**
 * The registry entries the corpus pins (every row's source candidate,
 * deduplicated) — exported for the consistency tests (the fake
 * registry pre-seeds exactly this membership).
 */
export const PINNED_REGISTRY_ENTRIES: readonly SourceProposalPin[] = [
  ...new Map(REGISTRY_SEED_PROPOSALS.map((pin) => [pin.proposalId, pin])).values(),
];

/** The candidate kinds the shadow corpus shadows (the VAL-032 vocabulary). */
export const SHADOWED_CANDIDATE_KINDS: readonly CandidateKind[] = [
  "deterministicization",
  "cache",
  "competence",
  "reuse",
];

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

/** The offline rows (deterministic — always drivable, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly ShadowCorpusRow[] = [
  shadowRow({
    rowId: "rag-deterministic-function-shadow-agreement",
    description:
      "The shadow-agreement row: the RAG deterministic-function candidate (VAL-033's exact-equivalence pass — its recorded walk already ends at differentially-evaluated) runs IN THE SHADOW beside the incumbent over the SAME traffic mix (the four recorded RAG replay inputs plus two injected traffic probes) under the EXACT-DIGEST-EQUALITY comparison criterion. The served leg is ALWAYS the incumbent's (the served-source pin); the shadow leg's deterministic digests reproduce the incumbent's on every case: a clean regression comparison — a shadow agreement. A divergent case would be recorded case-by-case with both digests (never smoothed); a served shadow outcome would FAIL the serving isolation mechanically.",
    sourceProposal: RAG_DETERMINISTICIZATION,
    candidateDifferentiallyEvaluated: true,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
  }),
  shadowRow({
    rowId: "text-summarize-split-preprocessing-shadow-agreement",
    description:
      "The split-preprocessing shadow row: the text-summarize candidate runs in the shadow over the five recorded replay inputs plus two injected probes under the DIGEST-CLASS-EQUALITY comparison criterion (equality is NOT required for semantic outputs; the criterion is explicit and mechanically evaluated per case — the shadow digest must be a member of the case's pinned digest class). The customer is served the incumbent's outcome on every case; the shadow's outcome is observation-only and its cost is booked to the shadow ledger, never the served accounting.",
    sourceProposal: TEXT_SUMMARIZE_DETERMINISTICIZATION,
    candidateDifferentiallyEvaluated: true,
    replacementShape: "split-preprocessing-residual",
    declaredCapabilities: ["pure-computation", "granted-fixture-read"],
    grantedIsolationSurface: ["pure-computation", "granted-fixture-read"],
    replayPopulationRefs: ["text-summarize-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "digest-class-equality",
  }),
  shadowRow({
    rowId: "order-settlement-retrieval-shadow-agreement",
    description:
      "The equality-not-required shadow row: the order-settlement CACHE candidate (the stable input→output transformation mined from the legitimately-VARYING population) runs in the shadow as a RETRIEVAL-PIPELINE over the four recorded replay inputs plus two injected probes under DIGEST-CLASS-EQUALITY. The retrieval's deterministic answer is a member of each case's pinned class even where it is not the incumbent's own member: a semantic-output agreement that exact-digest-equality would honestly report as divergences — recorded case-by-case, never smoothed.",
    sourceProposal: ORDER_SETTLEMENT_CACHE,
    candidateDifferentiallyEvaluated: true,
    replacementShape: "retrieval-pipeline",
    declaredCapabilities: ["pure-computation", "granted-fixture-read"],
    grantedIsolationSurface: ["pure-computation", "granted-fixture-read"],
    replayPopulationRefs: ["order-settlement-varying-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "digest-class-equality",
  }),
  shadowRow({
    rowId: "tool-loop-reusable-tool-shadow-tolerance",
    description:
      "The per-case-tolerance shadow row: the tool-agent COMPETENCE candidate runs in the shadow as a REUSABLE-TOOL over the three recorded replay inputs plus two injected probes (the first carrying a TWO-member pinned class — the input the incumbent semantics admits two equivalent answers for) under PER-CASE-TOLERANCE: the historical cases demand digest identity, the injected probes are the explicitly tolerated divergence set. The criterion is stated AND mechanically checked on every case — a tolerated id outside the population would be a malformed criterion.",
    sourceProposal: TOOL_LOOP_COMPETENCE,
    candidateDifferentiallyEvaluated: true,
    replacementShape: "reusable-tool",
    declaredCapabilities: ["pure-computation", "granted-fixture-read"],
    grantedIsolationSurface: ["pure-computation", "granted-fixture-read"],
    replayPopulationRefs: ["tool-agent-loop-replay-population"],
    injectedProbeCount: 2,
    twoMemberProbeOn: 1,
    criterionKind: "per-case-tolerance",
  }),
  shadowRow({
    rowId: "reuse-removed-call-shadow-honest-divergence",
    description:
      "The honest-divergence shadow row (the FAILED shape): the cross-workload REUSE candidate runs in the shadow as a REMOVED-CALL replacement — the incumbent's redundant call disappears, so the shadow's outcome digest diverges from the incumbent's on EVERY case by construction. The regression comparison records every divergence case-by-case with both sides' digests — never smoothed, never aggregated away — and the row FAILs honestly while the shadow still lands its `shadow-executed` transition (the comparison IS the record). This is the oracle's honesty reference: an aggregate claim without these per-case records would FAIL mechanically.",
    sourceProposal: CROSS_WORKLOAD_REUSE,
    candidateDifferentiallyEvaluated: true,
    replacementShape: "removed-call",
    declaredCapabilities: [],
    grantedIsolationSurface: [],
    replayPopulationRefs: ["text-summarize-replay-population", "probe-duplicate-replay"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
  }),
  shadowRow({
    rowId: "unregistered-candidate-shadow-refusal",
    description:
      "The unregistered-refusal row (the honest refusal): the row cites a candidate identity the candidate registry NEVER recorded (a phantom identity). The candidate's own state does not support a shadow run — there is no candidate — so the run refuses honestly (reason `candidate-unregistered`): no traffic executes, no comparison lands, nothing is appended to the candidate lifecycle. A run that compared anyway (or fabricated a shadow comparison for the phantom) would FAIL the refusal honesty mechanically.",
    sourceProposal: null,
    candidateDifferentiallyEvaluated: false,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
  }),
  shadowRow({
    rowId: "premature-candidate-shadow-refusal",
    description:
      "The premature-refusal row (the honest refusal): the row cites a REGISTERED candidate whose recorded lifecycle walk NEVER started (VAL-033 refused it honestly — a single replay is an anecdote, not a population — so it never reached the differentially-evaluated stage). A shadow run for a candidate not yet differentially-evaluated refuses honestly (reason `candidate-not-differentially-evaluated`): nothing executes, nothing lands — and an appended shadow transition for it would FAIL the stage discipline mechanically.",
    sourceProposal: singleReplayProposalPin(),
    candidateDifferentiallyEvaluated: false,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["text-summarize-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
  }),
  shadowRow({
    rowId: "probe-leaked-outcome",
    description:
      "The leaked-outcome probe (the phase-2 discrimination hook, pinned now): the honest row is the RAG shadow agreement; over the LEAKY serving-path variant the customer is served the REPLACEMENT's outcome on a traffic case (the shadow leaking into the serving path) — and the serving isolation FAILs mechanically with the leak named (the served outcome is ALWAYS the incumbent's; a disguised variant that claims the incumbent source while serving the shadow's digest FAILs just the same).",
    sourceProposal: RAG_DETERMINISTICIZATION,
    candidateDifferentiallyEvaluated: true,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
    probe: { kind: "leaked-outcome" },
  }),
  shadowRow({
    rowId: "probe-dropped-case",
    description:
      "The dropped-case probe (the phase-2 discrimination hook, pinned now): the honest row is the RAG shadow agreement over the full recorded mix; over the DROPPED traffic-source variant a recorded traffic case never reaches the shadow comparison (and the DUPLICATED / MIXED-UP variants inflate or swap the mix) — and the shadow population completeness FAILs mechanically (the comparison must cover the FULL recorded workload mix, dropped, duplicated and foreign cases each named).",
    sourceProposal: RAG_DETERMINISTICIZATION,
    candidateDifferentiallyEvaluated: true,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
    probe: { kind: "dropped-case" },
  }),
  shadowRow({
    rowId: "probe-smoothed-aggregate",
    description:
      "The smoothed-aggregate probe (the phase-2 discrimination hook, pinned now): the honest row is the RAG shadow agreement with every case's comparison recorded; over the AGGREGATE-ONLY runtime variant the run asserts an aggregate agreement WITHOUT the per-case records, over the SUBSET-compared variant it asserts an agreement drawn from a subset of the population, and over the SMOOTHING variant a divergent case is claimed agreeing — each FAILs the regression honesty mechanically (per-case evidence, never smoothed aggregates).",
    sourceProposal: RAG_DETERMINISTICIZATION,
    candidateDifferentiallyEvaluated: true,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
    probe: { kind: "smoothed-aggregate" },
  }),
  shadowRow({
    rowId: "probe-billed-shadow",
    description:
      "The billed-shadow probe (the phase-2 discrimination hook, pinned now): the honest row is the RAG shadow agreement whose shadow cost is booked to the SHADOW ledger (the served accounting bills the incumbent only); over the DOUBLE-BOOKING cost-ledger variant the shadow's measured cost ALSO lands in the served totals — the customer is billed for the shadow — and the cost separation FAILs mechanically with the billed delta named (an unmeasured or unbooked shadow cost FAILs just the same).",
    sourceProposal: RAG_DETERMINISTICIZATION,
    candidateDifferentiallyEvaluated: true,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
    probe: { kind: "billed-shadow" },
  }),
  shadowRow({
    rowId: "probe-skipped-stage",
    description:
      "The skipped-stage probe (the phase-2 discrimination hook, pinned now): the honest row is the RAG shadow agreement whose verified shadow appends the SINGLE `shadow-executed` transition to the recorded walk; over the SKIP-STAGE ledger variant the append jumps PAST shadow-executed (canaried/promoted — VAL-035's scope), lands at a WRONG stage, or lands evidence-less — each FAILs the stage discipline mechanically (the LEAKY rewrite variant rewrites the registry's own candidate entry and FAILs the read-only discipline).",
    sourceProposal: RAG_DETERMINISTICIZATION,
    candidateDifferentiallyEvaluated: true,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
    probe: { kind: "skipped-stage" },
  }),
  shadowRow({
    rowId: "probe-mid-shadow-escape",
    description:
      "The mid-shadow-escape probe (the phase-2 discrimination hook, pinned now): the honest row is the RAG shadow agreement with the replacement contained in its granted surface DURING the shadow (the containment carry-over); over the ESCAPING runtime variant the untrusted code exercises NETWORK ACCESS mid-shadow (an undeclared, ungranted capability) — a containment violation — and the isolation derivation FAILs mechanically (the escape is recorded, never silently forgiven; the violating shadow never lands).",
    sourceProposal: RAG_DETERMINISTICIZATION,
    candidateDifferentiallyEvaluated: true,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    injectedProbeCount: 2,
    criterionKind: "exact-digest-equality",
    probe: { kind: "mid-shadow-escape" },
  }),
];

// ---------------------------------------------------------------------------
// The live rows (env-gated on the authorized rail; REAL residual-AI round)
// ---------------------------------------------------------------------------

/** The live rows (env-gated on the authorized rail; REAL residual-AI round). */
export const LIVE_CORPUS_ROWS: readonly ShadowCorpusRow[] = [
  shadowRow({
    rowId: "live-split-preprocessing-shadow-confirmation",
    description:
      "A REAL shadow run (env-gated): the live-control deterministicization candidate (the VAL-032 registry identity mined from the live replay population's two REAL recorded replays — its recorded VAL-033 walk ends at differentially-evaluated) runs in the shadow as a SPLIT-PREPROCESSING-RESIDUAL replacement over the two cited live replay inputs plus two injected probes under DIGEST-CLASS-EQUALITY — the served leg is ALWAYS the incumbent's, the shadow leg's outcome is observation-only with its cost booked to the shadow ledger — and the run itself demands ONE REAL residual-AI model round through the REAL platform model gateway (measured usage, never estimated, never fabricated) before the shadow transition appends to the candidate lifecycle.",
    sourceProposal: LIVE_CONTROL_DETERMINISTICIZATION,
    candidateDifferentiallyEvaluated: true,
    replacementShape: "split-preprocessing-residual",
    declaredCapabilities: ["pure-computation", "granted-fixture-read"],
    grantedIsolationSurface: ["pure-computation", "granted-fixture-read"],
    replayPopulationRefs: ["live-replay-dispatch-population"],
    injectedProbeCount: 2,
    criterionKind: "digest-class-equality",
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "the live row's REAL residual-AI confirmation round through the REAL platform model gateway",
    },
  }),
];

/** The full pinned corpus (offline rows first, live rows last). */
export const SHADOW_EXECUTION_CORPUS: readonly ShadowCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: ShadowCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

// ---------------------------------------------------------------------------
// The submission keys + task bodies (the app's fingerprint discipline)
// ---------------------------------------------------------------------------

/**
 * The app's idempotency key for one shadow submission: each row's run
 * lands its OWN durable execution (one submission per row — never a
 * re-issue of another row's key).
 */
export function shadowSubmissionKey(options: {
  readonly runSuffix: string;
  readonly taskIndex: number;
}): string {
  return `val-034-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one shadow submission: the task kind, the
 * pinned row, the shadowed candidate and the SHADOW-phase declaration
 * (shadow-execute only — never a canary/promotion; task semantics,
 * never provider selection; the platform keeps the route authority).
 */
export function shadowTaskBodyFor(options: {
  readonly rowId: string;
  readonly sourceProposalId: string;
  readonly replacementShape: ReplacementShape;
}): Record<string, unknown> {
  return {
    kind: SHADOW_EXECUTION_TASK_KIND,
    rowId: options.rowId,
    sourceProposalId: options.sourceProposalId,
    replacementShape: options.replacementShape,
    shadow: { phase: "shadow-execute", mode: "observation-only" },
  };
}

/** The row ids in corpus order (config.json mirrors this slice). */
export const SHADOW_EXECUTION_ROW_IDS: readonly string[] = SHADOW_EXECUTION_CORPUS.map(
  (row) => row.rowId,
);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function shadowRowById(rowId: string): ShadowCorpusRow | null {
  return SHADOW_EXECUTION_CORPUS.find((row) => row.rowId === rowId) ?? null;
}

/**
 * The VAL-031 replay populations this corpus references (the
 * read-only input rows, deduplicated in first-reference order —
 * exported for the fixture world's consistency tests).
 */
export const REFERENCED_REPLAY_POPULATION_REFS: readonly string[] = [
  ...new Set(
    SHADOW_EXECUTION_CORPUS.flatMap((row) =>
      [...new Set(Object.values(row.trafficWorkloadClasses))].filter(
        (workloadClass) => workloadClass !== "injected-probe",
      ),
    ),
  ),
];

/**
 * Re-derive the pinned expected run of one corpus row (the oracle
 * proper — exported for the consistency tests and the fake world):
 * the honest shadow run (the observation leg) + the honest regression
 * derivation over the row's declared traffic population.
 */
export function pinnedShadowRunOf(row: ShadowCorpusRow) {
  const honestRun = deriveHonestShadowRun({
    sourceProposalId: row.sourceProposalId,
    replacementShape: row.replacementShape,
    declaredCapabilities: row.declaredCapabilities,
    acceptanceCriterion: row.acceptanceCriterion,
    trafficPopulation: row.trafficPopulation,
  });
  const regression = deriveRegressionHonesty({
    population: row.trafficPopulation,
    criterion: row.acceptanceCriterion,
    incumbentOutcomes: row.trafficPopulation.map((tcase) => ({
      caseId: tcase.caseId,
      digest: tcase.incumbentDigest,
    })),
    shadowOutcomes: honestRun.outcomes,
    comparedCaseIds: honestRun.comparedCaseIds,
    aggregateClaim: honestRun.aggregateClaim,
  });
  return { honestRun, regression };
}
