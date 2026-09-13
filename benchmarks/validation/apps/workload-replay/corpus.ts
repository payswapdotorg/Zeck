/**
 * The workload-replay corpus (VAL-031, AC1): the declared rows of the
 * repeated-replay application — every row replays ONE of VAL-030's
 * frozen baseline corpus rows N times with learning still INERT and
 * pins the population statistics the analysis derivation must
 * reproduce. Per row:
 *
 *   * the pinned baseline manifest entry — imported from VAL-030's
 *     corpus (the frozen-baseline registry's read-only input: the app
 *     digest over the frozen application-portfolio artifact + the
 *     golden workload revision digest — digests over the pinned
 *     artifacts, NEVER the artifacts copied, and NEVER rewritten);
 *   * the replay count N — the population size (exactly N replays, no
 *     duplicates, no gaps);
 *   * the expected trajectory-class membership (VAL-030's pinned
 *     equivalence class — every replay's digest must be a member) and
 *     the expected population statistics (the stability pin:
 *     deterministic rows reproduce ONE digest N times; the varying row
 *     reproduces its legitimately-varying distribution exactly);
 *   * the population-probe rows (the vocabulary the later
 *     discrimination phases drive over the adversarial fixture
 *     variants — designed here, pinned now).
 *
 * Every offline row is deterministically reproducible (the
 * replay-population semantics are ledger-level — the admission guard,
 * the inert dispatch rounds and the deterministic trajectory digests
 * are all repository-reproducible constants); the live row is
 * env-gated on the operator-authorized rail and demands REAL model
 * confirmation rounds.
 */

import type { LongitudinalCorpusRow } from "../../platform/longitudinal-baseline";
import { controlTrajectoryStepsOf, trajectoryDigestOf } from "../../platform/longitudinal-baseline";
import type { PopulationProbeKind, WorkloadReplayCorpusRow } from "../../platform/workload-replay";
import { deriveStabilityReportOf } from "../../platform/workload-replay";
import { longitudinalRowById } from "../longitudinal-baseline/corpus";

/** The task kind every replay submission carries (the app's task vocabulary). */
export const WORKLOAD_REPLAY_TASK_KIND = "workload-replay.population.v1";

// ---------------------------------------------------------------------------
// The row builder (the oracle's derivation)
// ---------------------------------------------------------------------------

/**
 * Build one replay-population row over a VAL-030 frozen baseline (the
 * read-only input): the pinned manifest + artifacts are REFERENCED
 * from the baseline row (never copied, never rewritten), the
 * trajectory class is the baseline's pinned equivalence class, and the
 * stability pin is derived from the world's per-replay schedule —
 * deterministic rows schedule the declaration order for every replay
 * (one digest × N); varying rows cycle the declared equivalent
 * orderings (the legitimately-varying distribution).
 */
function replayRow(input: {
  readonly rowId: string;
  readonly description: string;
  /** The VAL-030 baseline row this population replays (read-only input). */
  readonly baselineRowId: string;
  readonly replayCount: number;
  /**
   * The world's per-replay effect-ordering schedule (the varying rows'
   * variance basis; absent on deterministic rows).
   */
  readonly replayOrderings?: readonly (readonly number[])[];
  readonly probe?: { readonly kind: PopulationProbeKind };
}): WorkloadReplayCorpusRow {
  const baseline = longitudinalRowById(input.baselineRowId);
  if (baseline === null) {
    throw new Error(`the VAL-030 corpus holds no baseline row ${input.baselineRowId}`);
  }
  if (input.replayCount < 1) {
    throw new Error(`the replay population ${input.rowId} declares a non-positive replay count`);
  }
  // The world's per-replay schedule: the varying rows cycle the declared
  // equivalent orderings; the deterministic rows always schedule the
  // baseline's canonical first ordering.
  const scheduleFor = (replayOrdinal: number): readonly number[] => {
    if (input.replayOrderings === undefined || input.replayOrderings.length === 0) {
      return baseline.effectOrderings?.[0] ?? baseline.workload.effects.map((_, index) => index);
    }
    return (
      input.replayOrderings[(replayOrdinal - 1) % input.replayOrderings.length] ??
      baseline.workload.effects.map((_, index) => index)
    );
  };
  const observedDigests = Array.from({ length: input.replayCount }, (_, index) =>
    trajectoryDigestOf(
      controlTrajectoryStepsOf({
        workload: baseline.workload,
        effectOrder: scheduleFor(index + 1),
      }),
    ),
  );
  const expectedStability = deriveStabilityReportOf(observedDigests);
  return {
    rowId: input.rowId,
    description: input.description,
    baselineRowId: baseline.rowId,
    manifest: baseline.manifest,
    appArtifact: baseline.appArtifact,
    workload: baseline.workload,
    ...(baseline.effectOrderings === undefined
      ? {}
      : { effectOrderings: baseline.effectOrderings }),
    replayCount: input.replayCount,
    ...(input.replayOrderings === undefined ? {} : { replayOrderings: input.replayOrderings }),
    expectedTerminal: baseline.expectedTerminal,
    expectedTrajectoryClass: baseline.expectedTrajectoryClass,
    expectedStability,
    expectedModelCallsPerReplay: baseline.expectedModelCalls,
    ...(input.probe === undefined ? {} : { probe: input.probe }),
    needsDispatch: baseline.needsDispatch,
    ...(baseline.liveGate === undefined ? {} : { liveGate: baseline.liveGate }),
    expected: {
      terminal: baseline.expected.terminal,
      replays: input.replayCount,
      appCreated: input.replayCount,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
      ledgerIdentities: input.replayCount,
    },
  };
}

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

/** The offline rows (deterministic — always drivable, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly WorkloadReplayCorpusRow[] = [
  replayRow({
    rowId: "text-summarize-replay-population",
    description:
      "The text-generation replay population: VAL-030's frozen text-summarize baseline replayed FIVE times with learning still INERT — a deterministic workload whose every replay reproduces the IDENTICAL trajectory digest (one dispatch round, one summary effect, one verification step per replay). The population statistics pin the single digest at count 5: the pre-learning step-count stability every later learning claim must account for.",
    baselineRowId: "text-summarize-baseline",
    replayCount: 5,
  }),
  replayRow({
    rowId: "rag-retrieval-replay-population",
    description:
      "The RAG replay population: VAL-030's corrected golden RAG baseline (revision 2 — the append-only correction's committed pin) replayed FOUR times. The deterministic population reproduces the two-round retrieval trajectory identically across replays; the pinned class is the corrected revision's recorded class, and the registry history still holds BOTH revisions (the replays never rewrite the manifests).",
    baselineRowId: "rag-retrieval-corrected-baseline",
    replayCount: 4,
  }),
  replayRow({
    rowId: "tool-agent-loop-replay-population",
    description:
      "The tool-agent replay population: VAL-030's tool-agent loop baseline replayed THREE times — each replay drives its OWN three fresh dispatch rounds (nine own dispatches across the population: the inert-learning floor at population scale). The deterministic population pins the three-round loop trajectory at count 3.",
    baselineRowId: "tool-agent-loop-baseline",
    replayCount: 3,
  }),
  replayRow({
    rowId: "order-settlement-varying-replay-population",
    description:
      "The LEGITIMATELY-VARYING replay population: VAL-030's order-settlement baseline declares two INDEPENDENT notification effects, and the replay world's scheduler legitimately picks either equivalent ordering per replay (replays 1 and 3 schedule the customer notice first; replays 2 and 4 the warehouse notice first). Every replay's digest is a member of the pinned two-member class, and the population is REPORTED varying with its observed distribution — exactly two replays per class member. This is the variance-honesty reference: a smoothed variance or a fabricated determinism claim over this population FAILS mechanically.",
    baselineRowId: "order-settlement-equivalence-class",
    replayCount: 4,
    replayOrderings: [
      [0, 1],
      [1, 0],
    ],
  }),
  replayRow({
    rowId: "oversized-batch-guard-replay-population",
    description:
      "The guard-row replay population (the honest FAILED shape at population scale): VAL-030's oversized-batch baseline replayed THREE times — every replay is rejected by the budget guard BEFORE any dispatch round (the demand 6_500 micro-USD exceeds the 3_000 micro-USD quota), every replay records EXACTLY the guard-rejection trajectory, and the population terminal is FAILED with zero model calls. A failed baseline replays honestly: identical guard-rejection digests, no dispatches, no fabricated completions.",
    baselineRowId: "oversized-batch-guard-rejected",
    replayCount: 3,
  }),
  replayRow({
    rowId: "probe-duplicate-replay",
    description:
      "The duplicate-replay population probe (the phase-2 discrimination hook, pinned now): the probe population is the research-digest baseline replayed three times — over the honest ledger the row passes like any population (three immutable identities); over the LEAKY ledger the second replay shoulders INTO the first replay's trajectory identity (a duplicate ledger identity for one workload's replay population) and the population completeness FAILs mechanically.",
    baselineRowId: "research-digest-rerun-equivalence",
    replayCount: 3,
    probe: { kind: "duplicate-replay" },
  }),
  replayRow({
    rowId: "probe-dropped-replay",
    description:
      "The dropped-replay population probe (the phase-2 discrimination hook, pinned now): the probe population is the text-generation baseline replayed three times — over the honest ledger every replay's immutable identity lands; over the DROPPED ledger the third replay's observation is LOST (the population has a gap) and the population completeness FAILs mechanically.",
    baselineRowId: "text-summarize-baseline",
    replayCount: 3,
    probe: { kind: "dropped-replay" },
  }),
  replayRow({
    rowId: "probe-drifted-trajectory",
    description:
      "The drifted-trajectory population probe (the phase-2 discrimination hook, pinned now): the probe population is the coding-fix baseline replayed three times — over the honest recorder every replay's captured trajectory stays in the pinned class; over the DRIFT recorder the second replay's captured steps mutate post-capture (the observed digest lands OUT of the recorded class) and the trajectory-class membership FAILs mechanically, with the drifted ordinal named.",
    baselineRowId: "coding-fix-baseline",
    replayCount: 3,
    probe: { kind: "drifted-trajectory" },
  }),
  replayRow({
    rowId: "probe-partial-population",
    description:
      "The partial-population probe (the phase-2 discrimination hook, pinned now): the probe population is the RAG baseline replayed four times — the honest analysis rests on ALL FOUR replays' evidence; an analysis that asserts the stability distribution from a partial replay set (three of four observations) FAILs mechanically: a stability claim without the full population's evidence is unrepresentable.",
    baselineRowId: "rag-retrieval-corrected-baseline",
    replayCount: 4,
    probe: { kind: "partial-population" },
  }),
  replayRow({
    rowId: "probe-fabricated-determinism",
    description:
      "The fabricated-determinism population probe (the phase-2 discrimination hook, pinned now): the probe population is the varying order-settlement schedule replayed four times — the honest analysis REPORTS the population varying with its observed distribution (two replays per class member); an analysis that claims determinism over this observed variance (a smoothed variance / fake determinism) FAILs mechanically, and so does a world that smooths the variance away (the observed distribution would mismatch the pin).",
    baselineRowId: "order-settlement-equivalence-class",
    replayCount: 4,
    replayOrderings: [
      [0, 1],
      [1, 0],
    ],
    probe: { kind: "fabricated-determinism" },
  }),
];

// ---------------------------------------------------------------------------
// The live rows (env-gated on the authorized rail; REAL model dispatch)
// ---------------------------------------------------------------------------

/** The live rows (env-gated on the authorized rail; REAL model dispatch). */
export const LIVE_CORPUS_ROWS: readonly WorkloadReplayCorpusRow[] = [
  replayRow({
    rowId: "live-replay-dispatch-population",
    description:
      "A REAL replay population (env-gated): VAL-030's live control baseline replayed TWO times on the live rail — every replay makes its OWN REAL model confirmation round through the REAL platform model gateway (measured usage per replay, never estimated, never fabricated), and the deterministic population pins the live control trajectory at count 2. The pre-learning reference population, measured on the live rail.",
    baselineRowId: "live-control-dispatch",
    replayCount: 2,
  }),
];

/** The full pinned corpus (offline rows first, live rows last). */
export const WORKLOAD_REPLAY_CORPUS: readonly WorkloadReplayCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: WorkloadReplayCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

// ---------------------------------------------------------------------------
// The submission keys + task bodies (the app's fingerprint discipline)
// ---------------------------------------------------------------------------

/**
 * The app's idempotency key for one replay's submission: each replay
 * lands its OWN durable execution (one immutable identity per replay —
 * never a re-issue of another replay's key).
 */
export function replaySubmissionKey(options: {
  readonly runSuffix: string;
  readonly taskIndex: number;
  readonly replayOrdinal: number;
}): string {
  return `val-031-app-${options.runSuffix}-${options.taskIndex}-replay-${options.replayOrdinal}`;
}

/**
 * The app's task body for one replay's submission: the task kind, the
 * pinned row, the replay ordinal and the CONTROL ARM declaration
 * (learning explicitly INERT — task semantics, never provider
 * selection; the platform keeps the route authority).
 */
export function replayTaskBodyFor(options: {
  readonly rowId: string;
  readonly replayOrdinal: number;
}): Record<string, unknown> {
  return {
    kind: WORKLOAD_REPLAY_TASK_KIND,
    rowId: options.rowId,
    replay: options.replayOrdinal,
    control: { learning: "inert" },
  };
}

/** The row ids in corpus order (config.json mirrors this slice). */
export const WORKLOAD_REPLAY_ROW_IDS: readonly string[] = WORKLOAD_REPLAY_CORPUS.map(
  (row) => row.rowId,
);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function workloadReplayRowById(rowId: string): WorkloadReplayCorpusRow | null {
  return WORKLOAD_REPLAY_CORPUS.find((row) => row.rowId === rowId) ?? null;
}

/**
 * The VAL-030 baselines this corpus references (the read-only input
 * rows, deduplicated in first-reference order — exported for the
 * fixture world's registry commits and the consistency tests).
 */
export const REFERENCED_BASELINE_ROWS: readonly LongitudinalCorpusRow[] = [
  ...new Map(
    WORKLOAD_REPLAY_CORPUS.map((row) => {
      const baseline = longitudinalRowById(row.baselineRowId);
      if (baseline === null) {
        throw new Error(`the VAL-030 corpus holds no baseline row ${row.baselineRowId}`);
      }
      return [baseline.rowId, baseline];
    }),
  ).values(),
];
