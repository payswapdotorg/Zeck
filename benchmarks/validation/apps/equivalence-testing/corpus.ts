/**
 * The equivalence-testing corpus (VAL-033, AC1): the declared rows of
 * the equivalence application — every row tests ONE of VAL-032's
 * candidate-registry PROPOSALS (the read-only source proposal: the
 * registry identity re-derived exactly as VAL-032 recorded it, plus
 * the fixture-only degenerate entry the evidence-insufficient
 * refusal row refuses honestly), pins the replacement shape (the
 * synthesized deterministic program with its declared capabilities
 * and granted isolation surface), pins the differential population
 * (the proposal's cited historical replay inputs — VAL-031's recorded
 * ledger identities with their recorded incumbent outcome digests —
 * plus the pinned adversarial cases), states the EXPLICIT acceptance
 * criterion, and pins the expected verdict (the equivalence pass, the
 * honest divergence, the honest refusal — or the probe rows whose
 * adversarial variants FAIL in the later discrimination phases,
 * designed here, pinned now).
 *
 * Per row the expected outcome is the HONEST equivalence derivation
 * over the pinned population (the pure oracle): the incumbent
 * outcomes are the recorded/pinned digests, the replacement outcomes
 * are the reference replacement runtime's deterministic digests, and
 * the differential evaluation is re-derived mechanically — a verdict
 * is never asserted, it is derived.
 *
 * Every offline row is deterministically reproducible (the
 * differential evaluation is pure over the recorded digests); the
 * live row is env-gated on the operator-authorized rail and demands
 * ONE REAL residual-AI model round through the REAL platform model
 * gateway.
 */

import type {
  AcceptanceCriterion,
  DifferentialCase,
  EquivalenceCorpusRow,
  EquivalenceProbeKind,
  EquivalenceRefusalReason,
  ReplacementShape,
} from "../../platform/equivalence-testing";
import {
  deriveDifferentialEquivalence,
  deriveHonestReplacementRun,
  differentialPopulationDigestOf,
  equivalenceTrajectoryStepsOf,
} from "../../platform/equivalence-testing";
import type { CandidateKind, CandidateLifecycleStage } from "../../platform/learning-discovery";
import {
  deriveHonestDiscoveryOutcome,
  PROPOSAL_LIFECYCLE_STAGE,
} from "../../platform/learning-discovery";
import { longitudinalDigestOf, trajectoryDigestOf } from "../../platform/longitudinal-baseline";
import { recordedObservationsOf } from "../learning-discovery/corpus";

/** The task kind every equivalence submission carries (the app's task vocabulary). */
export const EQUIVALENCE_TESTING_TASK_KIND = "equivalence-testing.verdict.v1";

// ---------------------------------------------------------------------------
// The historical differential cases (VAL-031's recorded replay inputs)
// ---------------------------------------------------------------------------

/**
 * Build the HISTORICAL differential cases of the referenced VAL-031
 * replay populations (the read-only input): per cited replay — the
 * immutable ledger identity as the case id, the workload's input
 * digest as the case input, the replay's RECORDED trajectory digest
 * as the pinned incumbent outcome, and the workload's observed digest
 * distribution (the distinct recorded trajectory digests of its
 * population) as the case's pinned digest class. Nothing is
 * rewritten: the recorded facts are re-declared exactly as VAL-031
 * recorded them (through VAL-032's recorded-observation vocabulary).
 */
export function historicalCasesOf(
  replayPopulationRefs: readonly string[],
): readonly DifferentialCase[] {
  return replayPopulationRefs.flatMap((ref) => {
    const observations = recordedObservationsOf(ref);
    const classByWorkload = new Map<string, string[]>();
    for (const observation of observations) {
      const members = classByWorkload.get(observation.workloadId) ?? [];
      if (!members.includes(observation.trajectoryDigest)) {
        members.push(observation.trajectoryDigest);
      }
      classByWorkload.set(observation.workloadId, members);
    }
    return observations.map((observation) => ({
      caseId: observation.replayIdentity,
      source: "historical-replay" as const,
      sourceRef: observation.replayIdentity,
      inputDigest: observation.inputDigest,
      incumbentDigest: observation.trajectoryDigest,
      classDigests: [...(classByWorkload.get(observation.workloadId) ?? [])].sort(),
    }));
  });
}

/**
 * Build the PINNED ADVERSARIAL differential cases for one row (the
 * adversarial half of the differential population): deterministic
 * payload-free digests pinned per (row, ordinal); the designated
 * ordinal carries a TWO-member pinned class (the adversarial input
 * the incumbent semantics admits two equivalent answers for — the
 * honest per-case-tolerance / digest-class-equality basis).
 */
export function adversarialCasesOf(input: {
  readonly rowId: string;
  readonly count: number;
  /** The 1-based ordinal whose pinned class is two-member (0 = none). */
  readonly twoMemberOn?: number;
}): readonly DifferentialCase[] {
  return Array.from({ length: input.count }, (_, index) => {
    const ordinal = index + 1;
    const primary = longitudinalDigestOf(["adversarial-class", input.rowId, ordinal, "a"]);
    const secondary = longitudinalDigestOf(["adversarial-class", input.rowId, ordinal, "b"]);
    const twoMember = input.twoMemberOn === ordinal;
    return {
      caseId: `adversarial-${input.rowId}-${ordinal}`,
      source: "adversarial" as const,
      sourceRef: `adversarial-${input.rowId}-${ordinal}`,
      inputDigest: longitudinalDigestOf(["adversarial-input", input.rowId, ordinal]),
      incumbentDigest: primary,
      classDigests: twoMember ? [primary, secondary] : [primary],
    };
  });
}

// ---------------------------------------------------------------------------
// The source-proposal vocabulary (the VAL-032 registry identities)
// ---------------------------------------------------------------------------

/** The pinned source proposal (the read-only registry entry the row tests). */
export interface SourceProposalPin {
  readonly proposalId: string;
  readonly kind: CandidateKind;
  readonly citation: {
    readonly trajectoryDigests: readonly string[];
    readonly replayIdentities: readonly string[];
  };
  readonly minedStructureDigest: string;
  readonly lifecycleStage: CandidateLifecycleStage;
}

/**
 * Re-derive the VAL-032 registry proposal for one referenced replay
 * population (the same honest discovery derivation VAL-032's corpus
 * pinned — the derived `cand-learning-discovery-<digest>` identity the
 * REAL registry recorded; read-only here, never rewritten).
 */
export function registryProposalOf(input: {
  readonly candidateKind: CandidateKind;
  readonly replayPopulationRefs: readonly string[];
}): SourceProposalPin {
  const population = input.replayPopulationRefs.flatMap((ref) => recordedObservationsOf(ref));
  const honest = deriveHonestDiscoveryOutcome({
    candidateKind: input.candidateKind,
    population,
  });
  if (honest.proposal === null) {
    throw new Error(
      `the referenced populations hold no ${input.candidateKind} proposal (the registry pin is broken)`,
    );
  }
  return honest.proposal;
}

/**
 * The single-replay degenerate registry entry (the fixture-only pin
 * the `proposal-evidence-insufficient` refusal row refuses honestly):
 * a VAL-032-style proposal whose own evidence citation holds ONE
 * replay — an anecdote, not a population; its evidence does not
 * support a replacement test).
 */
export function singleReplayProposalPin(): SourceProposalPin {
  const population = recordedObservationsOf("text-summarize-replay-population").slice(0, 1);
  const honest = deriveHonestDiscoveryOutcome({
    candidateKind: "cache",
    population,
  });
  const observation = population[0];
  if (observation === undefined) {
    throw new Error("the text-summarize population is empty (the fixture pin is broken)");
  }
  const basis = {
    kind: "cache" as const,
    citation: {
      trajectoryDigests: [observation.trajectoryDigest],
      replayIdentities: [observation.replayIdentity],
    },
    minedStructureDigest: honest.structure.digest,
    lifecycleStage: PROPOSAL_LIFECYCLE_STAGE,
  };
  const proposalId = `cand-learning-discovery-${longitudinalDigestOf([
    basis.kind,
    basis.citation.trajectoryDigests,
    basis.citation.replayIdentities,
    basis.minedStructureDigest,
    basis.lifecycleStage,
  ])}`;
  return { ...basis, proposalId };
}

/** The phantom proposal identity the unregistered-refusal row cites (never a registry member). */
export function phantomProposalIdOf(): string {
  return `cand-learning-discovery-${longitudinalDigestOf(["phantom-proposal", "unregistered"])}`;
}

// ---------------------------------------------------------------------------
// The row builder (the oracle's derivation)
// ---------------------------------------------------------------------------

/**
 * Build one equivalence row over a pinned source proposal (the
 * read-only registry entry): the differential population is the
 * proposal's CITED historical replay inputs (re-declared from the
 * ledger vocabulary — every cited replay identity is a case) plus the
 * row's pinned adversarial cases; the replacement outcomes are the
 * reference replacement runtime's deterministic digests; the expected
 * verdict is the HONEST differential derivation over the population
 * (the pure oracle — an equivalence pass, an honest divergence with
 * its divergent cases named, or an honest refusal), and the pinned
 * equivalence-trajectory class is the canonical run trajectory's
 * single-member class.
 */
function equivalenceRow(input: {
  readonly rowId: string;
  readonly description: string;
  /** The pinned source proposal (null ⇒ the row cites the phantom identity). */
  readonly sourceProposal: SourceProposalPin | null;
  readonly replacementShape: ReplacementShape;
  readonly declaredCapabilities: readonly string[];
  readonly grantedIsolationSurface: readonly string[];
  readonly replayPopulationRefs: readonly string[];
  readonly adversarialCaseCount: number;
  /** The 1-based adversarial ordinal whose pinned class is two-member. */
  readonly twoMemberAdversarialOn?: number;
  /** The acceptance criterion's kind (the EXPLICIT criterion). */
  readonly criterionKind: AcceptanceCriterion["kind"];
  /**
   * Whether the criterion's tolerated set is the row's pinned
   * adversarial cases (the per-case-tolerance declaration: the
   * historical cases demand digest identity, the adversarial cases
   * are the explicitly tolerated divergences).
   */
  readonly tolerateAdversarial?: boolean;
  /** The pinned refusal reason (the honest-refusal rows). */
  readonly refusalReason?: EquivalenceRefusalReason;
  readonly probe?: { readonly kind: EquivalenceProbeKind };
  readonly needsDispatch?: boolean;
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
}): EquivalenceCorpusRow {
  const sourceProposalId = input.sourceProposal?.proposalId ?? phantomProposalIdOf();
  const adversarial = adversarialCasesOf({
    rowId: input.rowId,
    count: input.adversarialCaseCount,
    ...(input.twoMemberAdversarialOn === undefined
      ? {}
      : { twoMemberOn: input.twoMemberAdversarialOn }),
  });
  const population = [...historicalCasesOf(input.replayPopulationRefs), ...adversarial];
  const acceptanceCriterion: AcceptanceCriterion = {
    kind: input.criterionKind,
    ...(input.criterionKind === "per-case-tolerance"
      ? {
          toleratedCaseIds:
            input.tolerateAdversarial === false ? [] : adversarial.map((dcase) => dcase.caseId),
        }
      : {}),
  };
  const needsDispatch = input.needsDispatch ?? false;
  // The run's own dispatch demand: ONE REAL residual-AI confirmation
  // round on the live rail; zero offline (the offline differential is
  // digest-level).
  const modelCalls = needsDispatch ? 1 : 0;

  // The honest derivation over the pinned population (the pure oracle).
  const honestRun = deriveHonestReplacementRun({
    sourceProposalId,
    replacementShape: input.replacementShape,
    declaredCapabilities: input.declaredCapabilities,
    acceptanceCriterion,
    population,
  });
  const differential = deriveDifferentialEquivalence({
    population,
    criterion: acceptanceCriterion,
    incumbentOutcomes: population.map((dcase) => ({
      caseId: dcase.caseId,
      digest: dcase.incumbentDigest,
    })),
    replacementOutcomes: honestRun.outcomes,
    evaluatedCaseIds: honestRun.evaluatedCaseIds,
  });

  let expectedVerdict: EquivalenceCorpusRow["expected"]["verdict"];
  let expectedRefusalReason: EquivalenceRefusalReason | null = null;
  let expectedDivergenceCaseIds: readonly string[] = [];
  let expectedTerminal: "COMPLETED" | "FAILED";
  if (input.refusalReason !== undefined) {
    expectedVerdict = "honest-refusal";
    expectedRefusalReason = input.refusalReason;
    expectedTerminal = "COMPLETED";
  } else if (differential.equivalent) {
    expectedVerdict = "equivalence-pass";
    expectedTerminal = "COMPLETED";
  } else {
    expectedVerdict = "honest-divergence";
    expectedDivergenceCaseIds = differential.divergences.map((divergence) => divergence.caseId);
    expectedTerminal = "FAILED";
  }

  const populationDigest = differentialPopulationDigestOf(population);
  const trajectorySteps = equivalenceTrajectoryStepsOf({
    proposalId: sourceProposalId,
    populationDigest,
    incumbentExecutionDigest: longitudinalDigestOf([
      "incumbent-executed",
      ...population.map((dcase) => dcase.incumbentDigest),
    ]),
    replacementExecutionDigest: longitudinalDigestOf([
      "replacement-executed",
      ...honestRun.outcomes.map((outcome) => outcome.digest),
    ]),
    isolationContainment: input.refusalReason === undefined ? "contained" : null,
    differentialVerdictDigest: input.refusalReason === undefined ? differential.digest : null,
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
    differentialPopulation: population,
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
// The pinned registry seed (the read-only proposals the fixtures serve)
// ---------------------------------------------------------------------------

/** The RAG deterministicization proposal (the VAL-032 registry identity). */
const RAG_DETERMINISTICIZATION = registryProposalOf({
  candidateKind: "deterministicization",
  replayPopulationRefs: ["rag-retrieval-replay-population"],
});

/** The text-summarize deterministicization proposal. */
const TEXT_SUMMARIZE_DETERMINISTICIZATION = registryProposalOf({
  candidateKind: "deterministicization",
  replayPopulationRefs: ["text-summarize-replay-population"],
});

/** The order-settlement cache proposal. */
const ORDER_SETTLEMENT_CACHE = registryProposalOf({
  candidateKind: "cache",
  replayPopulationRefs: ["order-settlement-varying-replay-population"],
});

/** The tool-agent competence proposal. */
const TOOL_LOOP_COMPETENCE = registryProposalOf({
  candidateKind: "competence",
  replayPopulationRefs: ["tool-agent-loop-replay-population"],
});

/** The cross-workload reuse proposal. */
const CROSS_WORKLOAD_REUSE = registryProposalOf({
  candidateKind: "reuse",
  replayPopulationRefs: ["text-summarize-replay-population", "probe-duplicate-replay"],
});

/** The live-control deterministicization proposal (the live row's source). */
const LIVE_CONTROL_DETERMINISTICIZATION = registryProposalOf({
  candidateKind: "deterministicization",
  replayPopulationRefs: ["live-replay-dispatch-population"],
});

/**
 * The registry seed (the READ-ONLY proposals the fake candidate
 * registry pre-seeds): the six honest VAL-032 registry identities the
 * corpus rows test plus the single-replay degenerate entry the
 * evidence-insufficient refusal row refuses honestly. The phantom
 * identity of the unregistered-refusal row is deliberately NOT a
 * member.
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

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

/** The offline rows (deterministic — always drivable, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly EquivalenceCorpusRow[] = [
  equivalenceRow({
    rowId: "rag-deterministic-function-exact",
    description:
      "The exact-equivalence row: the RAG deterministicization proposal (the VAL-032 registry identity mined from the corrected RAG population's four replays) is generated as a DETERMINISTIC-FUNCTION replacement — a pure function of its inputs, granted pure computation only — and differentially evaluated against the incumbent over the cited four historical replay inputs PLUS two pinned adversarial cases under the EXACT-DIGEST-EQUALITY acceptance criterion. The deterministic function reproduces the incumbent's recorded trajectory digest on every case: an equivalence pass. A divergent case would be recorded as an honest divergence (never smoothed), and a criterion stated but never checked would FAIL mechanically.",
    sourceProposal: RAG_DETERMINISTICIZATION,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    adversarialCaseCount: 2,
    criterionKind: "exact-digest-equality",
  }),
  equivalenceRow({
    rowId: "text-summarize-split-preprocessing-class",
    description:
      "The split-preprocessing row: the text-summarize deterministicization proposal (five recorded replays) is generated as a SPLIT-PREPROCESSING-RESIDUAL replacement — the deterministic preprocessing split off, granted pure computation plus the granted fixture reads — and differentially evaluated over the five cited historical replay inputs plus two pinned adversarial cases under the DIGEST-CLASS-EQUALITY acceptance criterion (equality is NOT required for semantic outputs; the criterion is explicit and mechanically evaluated per case: the replacement digest must be a member of the case's pinned digest class).",
    sourceProposal: TEXT_SUMMARIZE_DETERMINISTICIZATION,
    replacementShape: "split-preprocessing-residual",
    declaredCapabilities: ["pure-computation", "granted-fixture-read"],
    grantedIsolationSurface: ["pure-computation", "granted-fixture-read"],
    replayPopulationRefs: ["text-summarize-replay-population"],
    adversarialCaseCount: 2,
    criterionKind: "digest-class-equality",
  }),
  equivalenceRow({
    rowId: "order-settlement-retrieval-class",
    description:
      "The equality-not-required row: the order-settlement CACHE proposal (the stable input→output transformation VAL-032 mined from the legitimately-VARYING population — the trajectories honestly reproduce TWO distinct digests while the transformation stays stable) is generated as a RETRIEVAL-PIPELINE replacement — the lookup served from the granted fixture store — and differentially evaluated over the four cited historical replay inputs plus two pinned adversarial cases under DIGEST-CLASS-EQUALITY. The retrieval's deterministic answer is a member of each case's pinned class even where it is not the incumbent's own member: a semantic-output equivalence that exact-digest-equality would honestly refuse.",
    sourceProposal: ORDER_SETTLEMENT_CACHE,
    replacementShape: "retrieval-pipeline",
    declaredCapabilities: ["pure-computation", "granted-fixture-read"],
    grantedIsolationSurface: ["pure-computation", "granted-fixture-read"],
    replayPopulationRefs: ["order-settlement-varying-replay-population"],
    adversarialCaseCount: 2,
    criterionKind: "digest-class-equality",
  }),
  equivalenceRow({
    rowId: "tool-loop-reusable-tool-tolerance",
    description:
      "The per-case-tolerance row: the tool-agent COMPETENCE proposal (the three-round loop pattern recurring across the population's three replays) is generated as a REUSABLE-TOOL replacement, and differentially evaluated over the three cited historical replay inputs plus two pinned adversarial cases (the first carrying a TWO-member pinned class — the adversarial input the incumbent semantics admits two equivalent answers for) under PER-CASE-TOLERANCE: the historical cases demand digest identity, the adversarial cases are the explicitly tolerated divergence set (the tool may answer with either equivalent member). The criterion is stated AND mechanically checked on every case — a tolerated case outside the population would be a malformed criterion.",
    sourceProposal: TOOL_LOOP_COMPETENCE,
    replacementShape: "reusable-tool",
    declaredCapabilities: ["pure-computation", "granted-fixture-read"],
    grantedIsolationSurface: ["pure-computation", "granted-fixture-read"],
    replayPopulationRefs: ["tool-agent-loop-replay-population"],
    adversarialCaseCount: 2,
    twoMemberAdversarialOn: 1,
    criterionKind: "per-case-tolerance",
  }),
  equivalenceRow({
    rowId: "reuse-removed-call-honest-divergence",
    description:
      "The honest-divergence row (the FAILED shape): the cross-workload REUSE proposal is generated as a REMOVED-CALL replacement — the incumbent's redundant call disappears, so the outcome digest CHANGES by construction (a novel digest, never the incumbent's own). Under the row's EXACT-DIGEST-EQUALITY acceptance criterion every differential case diverges: the divergence is RECORDED honestly, case by case, with both digests — never smoothed — and the row FAILs honestly. This is the oracle's honesty reference: a semantic-output criterion (class equality or per-case tolerance) is what would pass this replacement; smoothing the divergence into a pass would FAIL mechanically.",
    sourceProposal: CROSS_WORKLOAD_REUSE,
    replacementShape: "removed-call",
    declaredCapabilities: [],
    grantedIsolationSurface: [],
    replayPopulationRefs: ["text-summarize-replay-population", "probe-duplicate-replay"],
    adversarialCaseCount: 2,
    criterionKind: "exact-digest-equality",
  }),
  equivalenceRow({
    rowId: "unregistered-proposal-refusal",
    description:
      "The unregistered-refusal row (the honest refusal): the row cites a proposal identity the candidate registry NEVER recorded (a phantom identity). The proposal's evidence does not support replacement — there is no proposal — so the equivalence run refuses honestly (reason `proposal-unregistered`): no population executes, no verdict lands, nothing is appended to the candidate lifecycle. A run that evaluated a replacement anyway (or fabricated a verdict for the phantom) would FAIL the refusal honesty mechanically.",
    sourceProposal: null,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    adversarialCaseCount: 2,
    criterionKind: "exact-digest-equality",
    refusalReason: "proposal-unregistered",
  }),
  equivalenceRow({
    rowId: "single-replay-evidence-refusal",
    description:
      "The evidence-insufficient refusal row (the honest refusal): the row cites a registry entry whose own evidence citation holds ONE replay — a single replay is an anecdote, not a population; the proposal's evidence does not support a replacement test. The run refuses honestly (reason `proposal-evidence-insufficient`): nothing executes, nothing lands.",
    sourceProposal: singleReplayProposalPin(),
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["text-summarize-replay-population"],
    adversarialCaseCount: 2,
    criterionKind: "exact-digest-equality",
    refusalReason: "proposal-evidence-insufficient",
  }),
  equivalenceRow({
    rowId: "probe-broken-provenance",
    description:
      "The broken-provenance probe (the phase-2 discrimination hook, pinned now): the honest row is the RAG exact-equivalence pass; over the UNCITED replacement-runtime variant the recorded verdict carries NO proposal citation — a verdict with no provenance to its VAL-032 registry identity — and the provenance completeness FAILs mechanically (an uncited verdict never passes).",
    sourceProposal: RAG_DETERMINISTICIZATION,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    adversarialCaseCount: 2,
    criterionKind: "exact-digest-equality",
    probe: { kind: "broken-provenance" },
  }),
  equivalenceRow({
    rowId: "probe-partial-population",
    description:
      "The partial-population probe (the phase-2 discrimination hook, pinned now): the honest row is the RAG exact-equivalence pass over four historical replays plus two pinned adversarial cases; over the PARTIAL replacement-runtime variant the evaluation drops the pinned adversarial cases — a differential population covering only the historical half — and the provenance completeness FAILs mechanically (a verdict drawn from a PARTIAL population never passes).",
    sourceProposal: RAG_DETERMINISTICIZATION,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    adversarialCaseCount: 2,
    criterionKind: "exact-digest-equality",
    probe: { kind: "partial-population" },
  }),
  equivalenceRow({
    rowId: "probe-unchecked-criterion",
    description:
      "The unchecked-criterion probe (the phase-2 discrimination hook, pinned now): the honest row is the RAG exact-equivalence pass with the criterion mechanically evaluated over every case; over the UNCHECKED replacement-runtime variant the criterion is STATED but the evaluation checks nothing (an empty checked surface) — and the differential equivalence FAILs mechanically (a criterion stated but never checked never passes).",
    sourceProposal: RAG_DETERMINISTICIZATION,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    adversarialCaseCount: 2,
    criterionKind: "exact-digest-equality",
    probe: { kind: "unchecked-criterion" },
  }),
  equivalenceRow({
    rowId: "probe-divergence-smoothing",
    description:
      "The divergence-smoothing probe (the phase-2 discrimination hook, pinned now): the honest row is the RAG exact-equivalence pass; over the SMOOTHING replacement-runtime variant one case's replacement digest is perturbed to diverge from the criterion while the runtime CLAIMS equivalence for it — a smoothed divergence — and the differential honesty leg FAILs mechanically (a divergence is recorded, never smoothed).",
    sourceProposal: RAG_DETERMINISTICIZATION,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    adversarialCaseCount: 2,
    criterionKind: "exact-digest-equality",
    probe: { kind: "divergence-smoothing" },
  }),
  equivalenceRow({
    rowId: "probe-skipped-stage",
    description:
      "The skipped-stage probe (the phase-2 discrimination hook, pinned now): the honest row is the RAG exact-equivalence pass whose verdict appends the equivalence walk (offline-replayed → differentially-evaluated, each evidenced); over the SKIP-STAGE ledger variant the append jumps PAST the equivalence stage (or skips the offline replay, or lands evidence-less) — a skipped-stage promotion — and the stage discipline FAILs mechanically (shadow, canary and promotion are VAL-034/035's scope; the LEAKY rewrite variant rewrites the registry's own proposal entry and FAILs the read-only discipline).",
    sourceProposal: RAG_DETERMINISTICIZATION,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    adversarialCaseCount: 2,
    criterionKind: "exact-digest-equality",
    probe: { kind: "skipped-stage" },
  }),
  equivalenceRow({
    rowId: "probe-containment-escape",
    description:
      "The containment-escape probe (the phase-2 discrimination hook, pinned now): the honest row is the RAG exact-equivalence pass with the replacement contained in its granted surface (pure computation); over the ESCAPING replacement-runtime variant the untrusted code exercises NETWORK ACCESS (an undeclared, ungranted capability) — a containment violation — and the isolation derivation FAILs mechanically (the escape is recorded, never silently forgiven; the violating verdict never lands).",
    sourceProposal: RAG_DETERMINISTICIZATION,
    replacementShape: "deterministic-function",
    declaredCapabilities: ["pure-computation"],
    grantedIsolationSurface: ["pure-computation"],
    adversarialCaseCount: 2,
    criterionKind: "exact-digest-equality",
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    probe: { kind: "containment-escape" },
  }),
];

// ---------------------------------------------------------------------------
// The live rows (env-gated on the authorized rail; REAL residual-AI round)
// ---------------------------------------------------------------------------

/** The live rows (env-gated on the authorized rail; REAL residual-AI round). */
export const LIVE_CORPUS_ROWS: readonly EquivalenceCorpusRow[] = [
  equivalenceRow({
    rowId: "live-split-preprocessing-confirmation",
    description:
      "A REAL equivalence run (env-gated): the live-control deterministicization proposal (the VAL-032 registry identity mined from the live replay population's two REAL recorded replays) is generated as a SPLIT-PREPROCESSING-RESIDUAL replacement and differentially evaluated over the two cited historical live replay inputs plus two pinned adversarial cases under DIGEST-CLASS-EQUALITY — and the run itself demands ONE REAL residual-AI model round through the REAL platform model gateway (measured usage, never estimated, never fabricated) before the verdict appends to the candidate lifecycle.",
    sourceProposal: LIVE_CONTROL_DETERMINISTICIZATION,
    replacementShape: "split-preprocessing-residual",
    declaredCapabilities: ["pure-computation", "granted-fixture-read"],
    grantedIsolationSurface: ["pure-computation", "granted-fixture-read"],
    replayPopulationRefs: ["live-replay-dispatch-population"],
    adversarialCaseCount: 2,
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
export const EQUIVALENCE_TESTING_CORPUS: readonly EquivalenceCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: EquivalenceCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

// ---------------------------------------------------------------------------
// The submission keys + task bodies (the app's fingerprint discipline)
// ---------------------------------------------------------------------------

/**
 * The app's idempotency key for one equivalence submission: each row's
 * run lands its OWN durable execution (one submission per row — never
 * a re-issue of another row's key).
 */
export function equivalenceSubmissionKey(options: {
  readonly runSuffix: string;
  readonly taskIndex: number;
}): string {
  return `val-033-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one equivalence submission: the task kind,
 * the pinned row, the source proposal and the EQUIVALENCE-phase
 * declaration (differentially-evaluated only — never a shadow/canary/
 * promotion; task semantics, never provider selection; the platform
 * keeps the route authority).
 */
export function equivalenceTaskBodyFor(options: {
  readonly rowId: string;
  readonly sourceProposalId: string;
  readonly replacementShape: ReplacementShape;
}): Record<string, unknown> {
  return {
    kind: EQUIVALENCE_TESTING_TASK_KIND,
    rowId: options.rowId,
    sourceProposalId: options.sourceProposalId,
    replacementShape: options.replacementShape,
    equivalence: { phase: "differentially-evaluate" },
  };
}

/** The row ids in corpus order (config.json mirrors this slice). */
export const EQUIVALENCE_TESTING_ROW_IDS: readonly string[] = EQUIVALENCE_TESTING_CORPUS.map(
  (row) => row.rowId,
);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function equivalenceRowById(rowId: string): EquivalenceCorpusRow | null {
  return EQUIVALENCE_TESTING_CORPUS.find((row) => row.rowId === rowId) ?? null;
}

/**
 * The VAL-031 replay populations this corpus references (the
 * read-only input rows, deduplicated in first-reference order —
 * exported for the fixture world's consistency tests).
 */
export const REFERENCED_REPLAY_POPULATION_REFS: readonly string[] = [
  ...new Set(
    EQUIVALENCE_TESTING_CORPUS.flatMap((row) => {
      const matchedRefs: string[] = [];
      for (const ref of [
        "text-summarize-replay-population",
        "rag-retrieval-replay-population",
        "tool-agent-loop-replay-population",
        "order-settlement-varying-replay-population",
        "probe-duplicate-replay",
        "live-replay-dispatch-population",
      ]) {
        const identities = recordedObservationsOf(ref).map(
          (observation) => observation.replayIdentity,
        );
        if (
          row.differentialPopulation.some(
            (dcase) => dcase.source === "historical-replay" && identities.includes(dcase.sourceRef),
          )
        ) {
          matchedRefs.push(ref);
        }
      }
      return matchedRefs;
    }),
  ),
];

/**
 * The registry entries the corpus pins (every row's source proposal,
 * deduplicated) — exported for the consistency tests (the fake
 * registry pre-seeds exactly this membership).
 */
export const PINNED_REGISTRY_ENTRIES: readonly SourceProposalPin[] = [
  ...new Map(REGISTRY_SEED_PROPOSALS.map((pin) => [pin.proposalId, pin])).values(),
];

/**
 * Re-derive the pinned expected run of one corpus row (the oracle
 * proper — exported for the consistency tests and the fake world):
 * the honest replacement run + the honest differential evaluation
 * over the row's declared population.
 */
export function pinnedRunOf(row: EquivalenceCorpusRow) {
  const honestRun = deriveHonestReplacementRun({
    sourceProposalId: row.sourceProposalId,
    replacementShape: row.replacementShape,
    declaredCapabilities: row.declaredCapabilities,
    acceptanceCriterion: row.acceptanceCriterion,
    population: row.differentialPopulation,
  });
  const differential = deriveDifferentialEquivalence({
    population: row.differentialPopulation,
    criterion: row.acceptanceCriterion,
    incumbentOutcomes: row.differentialPopulation.map((dcase) => ({
      caseId: dcase.caseId,
      digest: dcase.incumbentDigest,
    })),
    replacementOutcomes: honestRun.outcomes,
    evaluatedCaseIds: honestRun.evaluatedCaseIds,
  });
  return { honestRun, differential };
}
