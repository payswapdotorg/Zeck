/**
 * The learning-discovery corpus (VAL-032, AC1): the declared rows of the
 * discovery application — every row mines ONE of VAL-031's recorded
 * replay populations (the read-only replay-ledger input: the
 * trajectory digests and replay identities are REFERENCED from the
 * recorded ledger vocabulary, never rewritten) for one declared
 * candidate kind and pins the proposal the discovery derivation must
 * emit (or the honest refusal it must report). Per row:
 *
 *   * the mined evidence population — the recorded observations of
 *     the referenced VAL-031 replay populations (trajectory digests +
 *     replay identities + the payload-free structural digests the
 *     mining derives its four signals from — digests only, never
 *     payload bytes, never a rewritten recorded fact);
 *   * the candidate kind the discovery question targets
 *     (reuse/cache/competence/deterministicization);
 *   * the expected proposal (kind + full-population evidence citation
 *     + the mined-structure digest) or the honest refusal (with its
 *     mechanically-justified reason);
 *   * the discovery-probe rows (the vocabulary the later
 *     discrimination phases drive over the adversarial fixture
 *     variants — designed here, pinned now).
 *
 * Every offline row is deterministically reproducible (the mining is
 * pure over the recorded digests); the live row is env-gated on the
 * operator-authorized rail and demands ONE REAL model confirmation
 * round through the REAL platform model gateway.
 */

import type {
  CandidateKind,
  DiscoveryProbeKind,
  LearningDiscoveryCorpusRow,
  RecordedReplayObservation,
  RefusalReason,
} from "../../platform/learning-discovery";
import {
  canonicalCitationOf,
  deriveHonestDiscoveryOutcome,
  discoveryTrajectoryStepsOf,
  PROPOSAL_LIFECYCLE_STAGE,
  proposalIdentityIdOf,
  recordedPopulationDigestOf,
  stepPatternDigestOf,
  subTrajectoryShapeDigestOf,
  workloadInputDigestOf,
  workloadOutputDigestOf,
} from "../../platform/learning-discovery";
import { controlTrajectoryStepsOf, trajectoryDigestOf } from "../../platform/longitudinal-baseline";
import type { WorkloadReplayCorpusRow } from "../../platform/workload-replay";
import { replayIdentityIdOf, replayKeyOf } from "../../platform/workload-replay";
import { workloadReplayRowById } from "../workload-replay/corpus";

/** The task kind every discovery submission carries (the app's task vocabulary). */
export const LEARNING_DISCOVERY_TASK_KIND = "learning-discovery.proposal.v1";

// ---------------------------------------------------------------------------
// The recorded-observation builder (the read-only ledger vocabulary)
// ---------------------------------------------------------------------------

/**
 * The stable population-id convention for one referenced VAL-031
 * replay population (the ledger identity basis — the recorded
 * identities the discovery cites are the identities VAL-031's ledger
 * actually recorded under this population id).
 */
export function recordedPopulationIdOf(replayRowId: string): string {
  return `val-031-${replayRowId}`;
}

/**
 * The repeated sub-trajectory shape of one VAL-031 workload (the
 * reuse signal's basis): the workload's dispatch rounds plus its
 * first effect step, as step KINDS — the structural shape two
 * workloads can share (a reusable routine).
 */
function subTrajectoryShapeOf(row: WorkloadReplayCorpusRow): string[] {
  return [...Array.from({ length: row.workload.dispatchRounds }, () => "dispatch"), "effect"];
}

/**
 * The world's per-replay effect ordering for one referenced VAL-031
 * population (the varying rows' legitimate variance basis — the same
 * schedule VAL-031's world declared; the recorded trajectory digests
 * reproduce the pinned stability distribution exactly).
 */
function scheduledDigestOf(row: WorkloadReplayCorpusRow, replayOrdinal: number): string {
  const declarationOrder = row.workload.effects.map((_, index) => index);
  const order =
    row.replayOrderings === undefined || row.replayOrderings.length === 0
      ? (row.effectOrderings?.[0] ?? declarationOrder)
      : (row.replayOrderings[(replayOrdinal - 1) % row.replayOrderings.length] ?? declarationOrder);
  return trajectoryDigestOf(
    controlTrajectoryStepsOf({ workload: row.workload, effectOrder: order }),
  );
}

/**
 * Build the recorded observations of ONE referenced VAL-031 replay
 * population (the read-only mining basis): per replay — the immutable
 * ledger identity (the recorded VAL-031 `exp-workload-replay-<digest>`
 * form), the observed trajectory digest (the pinned-class member under
 * the world's schedule), the payload-free structural digests (the
 * sub-trajectory shape, the workload input, the observed output, the
 * competence step pattern) and the replay's dispatched model rounds.
 * Nothing is rewritten: the recorded facts are re-declared exactly as
 * VAL-031 recorded them.
 */
export function recordedObservationsOf(replayRowId: string): readonly RecordedReplayObservation[] {
  const row = workloadReplayRowById(replayRowId);
  if (row === null) {
    throw new Error(`the VAL-031 corpus holds no replay population ${replayRowId}`);
  }
  const populationId = recordedPopulationIdOf(replayRowId);
  const shapeDigest = subTrajectoryShapeDigestOf(subTrajectoryShapeOf(row));
  const inputDigest = workloadInputDigestOf({
    appId: row.manifest.appId,
    workloadId: row.manifest.workloadId,
    workloadRevision: row.manifest.workloadRevision,
  });
  const outputDigest = workloadOutputDigestOf(row.workload.effects);
  return Array.from({ length: row.replayCount }, (_, index) => {
    const replayOrdinal = index + 1;
    const steps = controlTrajectoryStepsOf({
      workload: row.workload,
      effectOrder:
        row.replayOrderings === undefined || row.replayOrderings.length === 0
          ? (row.effectOrderings?.[0] ?? row.workload.effects.map((_, effectIndex) => effectIndex))
          : (row.replayOrderings[(replayOrdinal - 1) % row.replayOrderings.length] ??
            row.workload.effects.map((_, effectIndex) => effectIndex)),
    });
    return {
      workloadId: row.manifest.workloadId,
      replayOrdinal,
      replayIdentity: replayIdentityIdOf(
        replayKeyOf({ populationId, manifest: row.manifest, replayOrdinal }),
      ),
      trajectoryDigest: scheduledDigestOf(row, replayOrdinal),
      subTrajectoryShapeDigest: shapeDigest,
      inputDigest,
      outputDigest,
      stepPatternDigest: stepPatternDigestOf(steps.map((step) => `${step.kind}:${step.detail}`)),
      dispatchedRounds: row.expectedModelCallsPerReplay,
    };
  });
}

// ---------------------------------------------------------------------------
// The row builder (the oracle's derivation)
// ---------------------------------------------------------------------------

/**
 * Build one discovery row over the referenced VAL-031 replay
 * populations (the read-only input): the recorded observations are
 * re-declared from the ledger vocabulary (never rewritten), the
 * expected outcome is the HONEST discovery derivation over the
 * recorded population (the pure oracle — a proposal citing the FULL
 * population with the mined-structure digest, or the honest refusal),
 * and the pinned discovery-trajectory class is the canonical
 * discovery trajectory's single-member class.
 */
function discoveryRow(input: {
  readonly rowId: string;
  readonly description: string;
  /** The VAL-031 replay populations this row mines (read-only references). */
  readonly replayPopulationRefs: readonly string[];
  /** The candidate kind the discovery question targets. */
  readonly candidateKind: CandidateKind;
  readonly probe?: { readonly kind: DiscoveryProbeKind };
}): LearningDiscoveryCorpusRow {
  const referenced = input.replayPopulationRefs.map((ref) => {
    const row = workloadReplayRowById(ref);
    if (row === null) {
      throw new Error(`the VAL-031 corpus holds no replay population ${ref}`);
    }
    return row;
  });
  const population = input.replayPopulationRefs.flatMap((ref) => recordedObservationsOf(ref));
  if (population.length === 0) {
    throw new Error(`the discovery row ${input.rowId} declares an empty recorded population`);
  }
  const needsDispatch = referenced.some((row) => row.needsDispatch);
  const liveGate = referenced.find((row) => row.liveGate !== undefined)?.liveGate;
  // The discovery run's own dispatch demand: ONE REAL confirmation
  // round on the live rail; zero offline (the mining is ledger-level).
  const modelCalls = needsDispatch ? 1 : 0;

  const honest = deriveHonestDiscoveryOutcome({
    candidateKind: input.candidateKind,
    population,
  });
  const expected =
    honest.proposal !== null
      ? {
          emitsProposal: true,
          kind: honest.proposal.kind,
          refusalReason: null,
          minedStructureDigest: honest.proposal.minedStructureDigest,
          modelCalls,
          terminal: "COMPLETED" as const,
        }
      : {
          emitsProposal: false,
          kind: null,
          refusalReason: (honest.refusal?.reason ?? "no-learnable-structure") as RefusalReason,
          minedStructureDigest: null,
          modelCalls,
          terminal: "COMPLETED" as const,
        };

  const trajectorySteps = discoveryTrajectoryStepsOf({
    populationDigest: recordedPopulationDigestOf(population),
    minedStructureDigest: honest.structure.digest,
    proposal: honest.proposal,
    refusalReason: honest.refusal?.reason ?? null,
    confirmationRounds: modelCalls,
  });

  return {
    rowId: input.rowId,
    description: input.description,
    replayPopulationRefs: [...input.replayPopulationRefs],
    population,
    candidateKind: input.candidateKind,
    expected,
    expectedTrajectoryClass: [trajectoryDigestOf(trajectorySteps)],
    ...(input.probe === undefined ? {} : { probe: input.probe }),
    needsDispatch,
    ...(liveGate === undefined ? {} : { liveGate }),
  };
}

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

/** The offline rows (deterministic — always drivable, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly LearningDiscoveryCorpusRow[] = [
  discoveryRow({
    rowId: "cross-workload-reuse-candidate",
    description:
      "The reuse-candidate row: the discovery mines TWO recorded VAL-031 populations — the text-generation text-summarize population (five replays) and the research-digest population (three replays) — and the SAME sub-trajectory shape (one dispatch round feeding one effect step) recurs across both DISTINCT workloads: a reusable routine. The discovery proposes a REUSE candidate citing the FULL eight-replay population (every trajectory digest and every replay identity VAL-031 recorded) with the mined structure digest; a proposal citing only one workload's replays, or citing a digest the ledger never recorded, FAILs mechanically.",
    replayPopulationRefs: ["text-summarize-replay-population", "probe-duplicate-replay"],
    candidateKind: "reuse",
  }),
  discoveryRow({
    rowId: "order-settlement-cache-candidate",
    description:
      "The cache-candidate row: the discovery mines the LEGITIMATELY-VARYING order-settlement population (four replays, the world's scheduler alternating the two equivalent notification orderings). The trajectory digests honestly VARY across the replays — but the input→output transformation is STABLE (the same workload-input digest maps to the same observed output digest on every replay): a cacheable transformation that holds even under trajectory variance. The discovery proposes a CACHE candidate citing the full four-replay population; a deterministicization proposal over this same population would be a variance-smoothing fabrication and FAILs (see the varying-refusal row).",
    replayPopulationRefs: ["order-settlement-varying-replay-population"],
    candidateKind: "cache",
  }),
  discoveryRow({
    rowId: "tool-loop-competence-candidate",
    description:
      "The competence-candidate row: the discovery mines the tool-agent loop population (three replays, each an OWN three-round dispatch loop). The competence step-pattern — three dispatch rounds feeding the logged call effect and the verification step — recurs across every replay of the population: a competence the executions already share. The discovery proposes a COMPETENCE candidate citing the full three-replay population with the mined structure digest.",
    replayPopulationRefs: ["tool-agent-loop-replay-population"],
    candidateKind: "competence",
  }),
  discoveryRow({
    rowId: "rag-retrieval-deterministicization-candidate",
    description:
      "The deterministicization-candidate row: the discovery mines the corrected RAG population (four replays over golden revision 2). Every replay of the population reproduces the IDENTICAL two-round retrieval trajectory digest — a segment stable across identical replays, therefore determinizable. The discovery proposes a DETERMINISTICIZATION candidate citing the full four-replay population; a partial-population citation (a stability claim from three of the four recorded replays) FAILs mechanically.",
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    candidateKind: "deterministicization",
  }),
  discoveryRow({
    rowId: "order-settlement-varying-refusal",
    description:
      "The VARYING row (the honest refusal): the discovery asks the deterministicization question over the legitimately-varying order-settlement population — and the population's replays honestly reproduce TWO distinct trajectory digests (VAL-031's reported variance). The conservative discovery NEVER proposes a varying segment as a deterministicization candidate: it refuses honestly (reason `varying-population`), reporting the variance rather than smoothing it. A variance-smoothing proposal over this population FAILs mechanically (see the probe row).",
    replayPopulationRefs: ["order-settlement-varying-replay-population"],
    candidateKind: "deterministicization",
  }),
  discoveryRow({
    rowId: "oversized-batch-guard-refusal",
    description:
      "The guard/refusal row: the discovery mines the guard-rejected oversized-batch population (three replays, every one rejected by the budget guard BEFORE any dispatch round — zero dispatched model work). There is no AI execution subgraph to learn from: the discovery refuses honestly (reason `no-dispatched-work`). A proposal mined from a guard rejection would fabricate learnable structure out of a precondition failure and FAILs.",
    replayPopulationRefs: ["oversized-batch-guard-replay-population"],
    candidateKind: "deterministicization",
  }),
  discoveryRow({
    rowId: "probe-uncited-proposal",
    description:
      "The uncited-proposal population probe (the phase-2 discrimination hook, pinned now): the probe population is the corrected RAG population and the honest discovery proposes the deterministicization candidate like any row; over the UNCITED miner variant the proposal carries an EMPTY evidence citation — a generalization with no cited population — and the evidence-citation completeness FAILs mechanically.",
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    candidateKind: "deterministicization",
    probe: { kind: "uncited-proposal" },
  }),
  discoveryRow({
    rowId: "probe-partial-population",
    description:
      "The partial-population probe (the phase-2 discrimination hook, pinned now): the probe population is the corrected RAG population (four recorded replays); over the PARTIAL miner variant the proposal cites only three of the four recorded replay identities — a stability claim from a partial replay set — and the evidence-citation completeness FAILs mechanically.",
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    candidateKind: "deterministicization",
    probe: { kind: "partial-population" },
  }),
  discoveryRow({
    rowId: "probe-fabricated-citation",
    description:
      "The fabricated-citation population probe (the phase-2 discrimination hook, pinned now): the probe population is the corrected RAG population; over the FABRICATED miner variant the proposal cites a phantom trajectory digest and a phantom replay identity that the recorded ledger never held — a fabricated evidence citation — and the evidence-citation completeness FAILs mechanically, with the fabricated members named.",
    replayPopulationRefs: ["rag-retrieval-replay-population"],
    candidateKind: "deterministicization",
    probe: { kind: "fabricated-citation" },
  }),
  discoveryRow({
    rowId: "probe-variance-smoothing",
    description:
      "The variance-smoothing population probe (the phase-2 discrimination hook, pinned now): the probe population is the legitimately-varying order-settlement population; the honest discovery refuses the deterministicization question (`varying-population`); over the SMOOTHING miner variant a deterministicization proposal rides the varying population anyway — a variance-smoothing fabrication — and the conservatism derivation FAILs mechanically.",
    replayPopulationRefs: ["order-settlement-varying-replay-population"],
    candidateKind: "deterministicization",
    probe: { kind: "variance-smoothing" },
  }),
  discoveryRow({
    rowId: "probe-state-mutation",
    description:
      "The state-mutation population probe (the phase-2 discrimination hook, pinned now): the probe population is the cross-workload reuse population (text-summarize + research-digest); over the honest registry the reuse proposal lands as a lifecycle candidate and nothing else changes; over the MUTATING registry variant the proposal's recording REWRITES the recorded replay population (frozen state) — or promotes the candidate past the proposed stage — and the no-application derivation FAILs mechanically. Discovery proposes, never applies.",
    replayPopulationRefs: ["text-summarize-replay-population", "probe-duplicate-replay"],
    candidateKind: "reuse",
    probe: { kind: "state-mutation" },
  }),
];

// ---------------------------------------------------------------------------
// The live rows (env-gated on the authorized rail; REAL confirmation dispatch)
// ---------------------------------------------------------------------------

/** The live rows (env-gated on the authorized rail; REAL confirmation dispatch). */
export const LIVE_CORPUS_ROWS: readonly LearningDiscoveryCorpusRow[] = [
  discoveryRow({
    rowId: "live-discovery-confirmation",
    description:
      "A REAL discovery run (env-gated): the discovery mines VAL-031's live replay population (two replays of the live control workload, each having made its OWN REAL model confirmation round) over the REAL platform path — the deterministic population yields a deterministicization candidate citing both recorded replays — and the discovery run itself demands ONE REAL model confirmation round through the REAL platform model gateway (measured usage, never estimated, never fabricated) before the proposal lands in the REAL candidate registry.",
    replayPopulationRefs: ["live-replay-dispatch-population"],
    candidateKind: "deterministicization",
  }),
];

/** The full pinned corpus (offline rows first, live rows last). */
export const LEARNING_DISCOVERY_CORPUS: readonly LearningDiscoveryCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: LearningDiscoveryCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

// ---------------------------------------------------------------------------
// The submission keys + task bodies (the app's fingerprint discipline)
// ---------------------------------------------------------------------------

/**
 * The app's idempotency key for one discovery submission: each row's
 * discovery run lands its OWN durable execution (one submission per
 * row — never a re-issue of another row's key).
 */
export function discoverySubmissionKey(options: {
  readonly runSuffix: string;
  readonly taskIndex: number;
}): string {
  return `val-032-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one discovery submission: the task kind, the
 * pinned row, the declared candidate kind and the DISCOVERY-phase
 * declaration (propose-only — discovery proposes, never applies; task
 * semantics, never provider selection; the platform keeps the route
 * authority).
 */
export function discoveryTaskBodyFor(options: {
  readonly rowId: string;
  readonly candidateKind: CandidateKind;
}): Record<string, unknown> {
  return {
    kind: LEARNING_DISCOVERY_TASK_KIND,
    rowId: options.rowId,
    candidateKind: options.candidateKind,
    discovery: { phase: "propose" },
  };
}

/** The row ids in corpus order (config.json mirrors this slice). */
export const LEARNING_DISCOVERY_ROW_IDS: readonly string[] = LEARNING_DISCOVERY_CORPUS.map(
  (row) => row.rowId,
);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function learningDiscoveryRowById(rowId: string): LearningDiscoveryCorpusRow | null {
  return LEARNING_DISCOVERY_CORPUS.find((row) => row.rowId === rowId) ?? null;
}

/**
 * The VAL-031 replay populations this corpus references (the
 * read-only input rows, deduplicated in first-reference order —
 * exported for the fixture world's ledger input and the consistency
 * tests).
 */
export const REFERENCED_REPLAY_ROWS: readonly WorkloadReplayCorpusRow[] = [
  ...new Map(
    LEARNING_DISCOVERY_CORPUS.flatMap((row) => row.replayPopulationRefs).map((ref) => {
      const replayRow = workloadReplayRowById(ref);
      if (replayRow === null) {
        throw new Error(`the VAL-031 corpus holds no replay population ${ref}`);
      }
      return [replayRow.rowId, replayRow];
    }),
  ).values(),
];

/**
 * The canonical full-population citation of one corpus row's recorded
 * population (exported for the consistency tests: the pinned proposal
 * must cite exactly this).
 */
export function pinnedCitationOf(row: LearningDiscoveryCorpusRow) {
  return canonicalCitationOf(row.population);
}

/**
 * Re-derive the pinned proposal record of one corpus row (the oracle
 * proper — exported for the consistency tests and the fake world).
 */
export function pinnedProposalOf(row: LearningDiscoveryCorpusRow) {
  if (!row.expected.emitsProposal || row.expected.kind === null) {
    return null;
  }
  const basis = {
    kind: row.expected.kind,
    citation: canonicalCitationOf(row.population),
    minedStructureDigest: row.expected.minedStructureDigest ?? "",
    lifecycleStage: PROPOSAL_LIFECYCLE_STAGE,
  };
  return { ...basis, proposalId: proposalIdentityIdOf(basis) };
}
