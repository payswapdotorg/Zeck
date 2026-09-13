/**
 * The longitudinal-baseline corpus (VAL-030, AC1): the declared rows of
 * the baseline-freeze application — the frozen application-portfolio
 * baselines the learning wave will be measured AGAINST. Per row:
 *
 *   * the baseline manifest entry — the app digest (over the frozen
 *     application-portfolio artifact) + the golden workload-corpus
 *     revision (over the pinned workload content), content-addressed:
 *     digests over the pinned artifacts, NEVER the artifacts copied
 *     (each artifact is declared ONCE here; every other reference is a
 *     digest);
 *   * the expected terminal (the honest FAILED shape is a first-class
 *     baseline: the guard-rejected workload freezes a failed
 *     trajectory as the reference);
 *   * the trajectory-digest equivalence class the control run must
 *     reproduce (a single canonical class for the dependent workloads;
 *     a two-member class for the independent-effect workload whose
 *     orderings are equivalent — the comparator-harness equivalence
 *     discipline);
 *   * the learning-contamination probe rows (the vocabulary the later
 *     discrimination phases drive over the contaminated fixture
 *     variants — designed here, pinned now).
 *
 * Every offline row is deterministically reproducible (the control-run
 * semantics are ledger-level — the admission guard, the inert dispatch
 * rounds and the deterministic trajectory digests are all
 * repository-reproducible constants); the live row is env-gated on the
 * operator-authorized rail and demands a REAL model confirmation round.
 */

import {
  appDigestOf,
  type BaselineAppArtifact,
  type BaselineManifestEntry,
  type BaselineWorkloadEffect,
  type BaselineWorkloadRevision,
  deriveWorkloadAdmission,
  type LearningContaminationKind,
  type LongitudinalCorpusRow,
  manifestDigestOf,
  trajectoryClassOf,
  workloadDigestOf,
} from "../../platform/longitudinal-baseline";

/** The task kind every row's submission carries (the app's task vocabulary). */
export const LONGITUDINAL_TASK_KIND = "longitudinal-baseline.control.v1";

// ---------------------------------------------------------------------------
// The app builders (the frozen application-portfolio artifacts)
// ---------------------------------------------------------------------------

function portfolioApp(appId: string, taskKind: string): BaselineAppArtifact {
  return { appId, appVersion: "v1", taskKind, integrationSurface: "sdk" };
}

/** The frozen app artifacts (each declared ONCE — digests everywhere else). */
const TEXT_GENERATION_APP = portfolioApp("portfolio:text-generation", "text.summarize.v1");
const RAG_APP = portfolioApp("portfolio:rag", "rag.retrieve.v1");
const TOOL_AGENT_APP = portfolioApp("portfolio:tool-agent", "tool.agent-loop.v1");
const CODING_APP = portfolioApp("portfolio:coding", "coding.fix.v1");
const OPERATIONS_APP = portfolioApp("portfolio:operations", "ops.settlement.v1");
const RESEARCH_APP = portfolioApp("portfolio:research", "research.summarize.v1");

// ---------------------------------------------------------------------------
// The workload builders (the golden workload-corpus revisions)
// ---------------------------------------------------------------------------

function effect(effectId: string, key: string, amountMicro: number): BaselineWorkloadEffect {
  return { effect: effectId, key, amountMicro };
}

function goldenWorkload(input: {
  readonly workloadId: string;
  readonly revision: number;
  readonly dispatchRounds: number;
  readonly quotaMicro: number;
  readonly effects: readonly BaselineWorkloadEffect[];
}): BaselineWorkloadRevision {
  return { ...input };
}

// ---------------------------------------------------------------------------
// The manifest builder (content-addressed by construction)
// ---------------------------------------------------------------------------

/**
 * Build the content-addressed manifest for one (app, workload) pin:
 * the app digest over the frozen artifact, the workload digest over the
 * pinned revision content, and the manifest digest over the entry's own
 * content — digests over the pinned artifacts, never the artifacts copied.
 */
export function baselineManifestFor(
  app: BaselineAppArtifact,
  workload: BaselineWorkloadRevision,
): BaselineManifestEntry {
  const appDigest = appDigestOf(app);
  const workloadDigest = workloadDigestOf(workload);
  return {
    appId: app.appId,
    appDigest,
    workloadId: workload.workloadId,
    workloadRevision: workload.revision,
    workloadDigest,
    manifestDigest: manifestDigestOf({
      appId: app.appId,
      appDigest,
      workloadId: workload.workloadId,
      workloadRevision: workload.revision,
      workloadDigest,
    }),
  };
}

// ---------------------------------------------------------------------------
// The row builder (the oracle's derivation)
// ---------------------------------------------------------------------------

function baselineRow(input: {
  readonly rowId: string;
  readonly description: string;
  readonly app: BaselineAppArtifact;
  readonly workload: BaselineWorkloadRevision;
  /** The declared equivalent effect orderings (the class's basis). */
  readonly effectOrderings?: readonly (readonly number[])[];
  readonly rerun?: { readonly probe: "after-completion" };
  readonly contamination?: { readonly kind: LearningContaminationKind };
  readonly needsDispatch?: boolean;
  readonly liveGate?: { readonly envVars: readonly string[]; readonly requirement: string };
}): LongitudinalCorpusRow {
  const manifest = baselineManifestFor(input.app, input.workload);
  const expectedTrajectoryClass = trajectoryClassOf({
    workload: input.workload,
    ...(input.effectOrderings === undefined ? {} : { equivalentOrderings: input.effectOrderings }),
  });
  const admission = deriveWorkloadAdmission(input.workload);
  const expectedTerminal = admission.allowed ? "COMPLETED" : "FAILED";
  const needsDispatch = input.needsDispatch ?? false;
  return {
    rowId: input.rowId,
    description: input.description,
    manifest,
    appArtifact: input.app,
    workload: input.workload,
    ...(input.effectOrderings === undefined ? {} : { effectOrderings: input.effectOrderings }),
    expectedTerminal,
    expectedTrajectoryClass,
    expectedModelCalls: admission.allowed ? input.workload.dispatchRounds : 0,
    ...(input.rerun === undefined ? {} : { rerun: input.rerun }),
    ...(input.contamination === undefined ? {} : { contamination: input.contamination }),
    needsDispatch,
    ...(input.liveGate === undefined ? {} : { liveGate: input.liveGate }),
    expected: {
      terminal: expectedTerminal,
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: input.rerun === undefined ? 0 : 1,
      rejectedSubmissions: 0,
      ledgerIdentities: 1,
    },
  };
}

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

/** The offline rows (deterministic — always drivable, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly LongitudinalCorpusRow[] = [
  baselineRow({
    rowId: "text-summarize-baseline",
    description:
      "The text-generation baseline: the frozen portfolio app (text.summarize.v1 over the public SDK) pinned against the golden text-summarize workload revision 1 — one dispatch round, one summary effect, the guard admits. The control run records the canonical trajectory (one dispatch, one effect, one verification step) and its single-member equivalence class is the recorded baseline the learning wave must beat.",
    app: TEXT_GENERATION_APP,
    workload: goldenWorkload({
      workloadId: "golden:text-summarize-digests",
      revision: 1,
      dispatchRounds: 1,
      quotaMicro: 5_000,
      effects: [effect("text:summary-written", "WS-101/summary.md", 1_500)],
    }),
  }),
  baselineRow({
    rowId: "rag-retrieval-corrected-baseline",
    description:
      "The RAG baseline on the CORRECTED golden workload revision: revision 1 was committed first (citation weight 2_000) and superseded by the correction — a NEW revision 2 (citation weight 2_200, index cost 800) committed as a NEW registry entry, never an edit. The row pins revision 2: two dispatch rounds, two effects, the guard admits, and the registry history holds BOTH revisions (the append-only correction discipline frozen as a first-class corpus fact).",
    app: RAG_APP,
    workload: goldenWorkload({
      workloadId: "golden:rag-retrieval",
      revision: 2,
      dispatchRounds: 2,
      quotaMicro: 6_000,
      effects: [
        effect("rag:citations-attached", "CIT-201", 2_200),
        effect("rag:index-updated", "IDX-201", 800),
      ],
    }),
  }),
  baselineRow({
    rowId: "tool-agent-loop-baseline",
    description:
      "The tool-agent baseline: the frozen portfolio app (tool.agent-loop.v1) pinned against the golden tool-agent-loop workload revision 1 — THREE dispatch rounds (the loop's own model confirmations), one logged effect, the guard admits. The control run's own three fresh dispatches are the inert-learning floor any learning claim must be compared against.",
    app: TOOL_AGENT_APP,
    workload: goldenWorkload({
      workloadId: "golden:tool-agent-loop",
      revision: 1,
      dispatchRounds: 3,
      quotaMicro: 4_000,
      effects: [effect("tool:call-logged", "LOG-301", 900)],
    }),
  }),
  baselineRow({
    rowId: "coding-fix-baseline",
    description:
      "The coding baseline: the frozen portfolio app (coding.fix.v1) pinned against the golden coding-fix workload revision 1 — two dispatch rounds (diagnose then patch), one patch effect, the guard admits, and the trajectory class is the canonical control trajectory for the frozen pair.",
    app: CODING_APP,
    workload: goldenWorkload({
      workloadId: "golden:coding-fix",
      revision: 1,
      dispatchRounds: 2,
      quotaMicro: 8_000,
      effects: [effect("coding:patch-applied", "PATCH-401", 3_000)],
    }),
  }),
  baselineRow({
    rowId: "order-settlement-equivalence-class",
    description:
      "The equivalence-class baseline: the golden order-settlement workload declares two INDEPENDENT notification effects (the customer and the warehouse notices — either order applies exactly the same set exactly once), so the recorded baseline accepts TWO equivalent trajectories. The control run reproduces the class under either equivalent ordering — the comparator-harness equivalence discipline: the class, not one byte-sequence, is the frozen oracle.",
    app: OPERATIONS_APP,
    workload: goldenWorkload({
      workloadId: "golden:order-settlement",
      revision: 1,
      dispatchRounds: 1,
      quotaMicro: 3_000,
      effects: [
        effect("order:notify-customer", "ORD-501", 0),
        effect("order:notify-warehouse", "ORD-501", 0),
      ],
    }),
    effectOrderings: [
      [0, 1],
      [1, 0],
    ],
  }),
  baselineRow({
    rowId: "oversized-batch-guard-rejected",
    description:
      "The FAILED baseline (the honest precondition shape): the golden oversized-batch workload declares effects demanding 6_500 micro-USD against a 3_000 micro-USD quota — the budget guard rejects the work BEFORE any dispatch round or effect, and the control run records EXACTLY the guard-rejection trajectory (one verification step). A failed baseline is a first-class frozen reference: the expected terminal is FAILED, the model-call count is ZERO and the trajectory class is the failed trajectory's digest.",
    app: OPERATIONS_APP,
    workload: goldenWorkload({
      workloadId: "golden:oversized-batch",
      revision: 1,
      dispatchRounds: 2,
      quotaMicro: 3_000,
      effects: [
        effect("ops:batch-a", "BATCH-601", 4_000),
        effect("ops:batch-b", "BATCH-601", 2_500),
      ],
    }),
  }),
  baselineRow({
    rowId: "research-digest-rerun-equivalence",
    description:
      "The re-run baseline (the control re-run probe): the research baseline completes and records its trajectory, then the SAME frozen workload is re-driven — the re-run must reproduce the recorded trajectory-digest equivalence class over the deterministic fixtures, and the longitudinal ledger must hold exactly ONE immutable experiment identity for the control run (the re-run re-observes the SAME identity — never a second one).",
    app: RESEARCH_APP,
    workload: goldenWorkload({
      workloadId: "golden:research-digest",
      revision: 1,
      dispatchRounds: 1,
      quotaMicro: 4_000,
      effects: [effect("research:sources-cited", "REP-701", 1_200)],
    }),
    rerun: { probe: "after-completion" },
  }),
  baselineRow({
    rowId: "probe-reuse-contamination",
    description:
      "The trajectory-reuse contamination probe (the phase-2 discrimination hook, pinned now): the probe workload is the RAG retrieval shape driven by a run that REUSES a previously recorded trajectory instead of dispatching its own rounds — over the honest inert world the row passes like any baseline; over the reuse-contaminated fixture the control contract FAILs (no fresh model work, the trajectory drifts out of class, the identity content diverges).",
    app: RAG_APP,
    workload: goldenWorkload({
      workloadId: "golden:rag-retrieval-probe",
      revision: 1,
      dispatchRounds: 2,
      quotaMicro: 6_000,
      effects: [
        effect("rag:citations-attached", "CIT-221", 2_200),
        effect("rag:index-updated", "IDX-221", 800),
      ],
    }),
    contamination: { kind: "trajectory-reuse" },
  }),
  baselineRow({
    rowId: "probe-caching-hint-contamination",
    description:
      "The caching-hint contamination probe (the phase-2 discrimination hook, pinned now): the probe workload is the tool-agent loop shape driven by a run that injects caching hints into its dispatch rounds — the rounds still dispatch (the trajectory shape is unchanged), so ONLY the inert-learning compliance catches the hint: the control contract demands learning explicitly INERT (no reuse, no caching hints, no competence shortcuts).",
    app: TOOL_AGENT_APP,
    workload: goldenWorkload({
      workloadId: "golden:tool-loop-probe",
      revision: 1,
      dispatchRounds: 3,
      quotaMicro: 4_000,
      effects: [effect("tool:call-logged", "LOG-321", 900)],
    }),
    contamination: { kind: "caching-hint" },
  }),
  baselineRow({
    rowId: "probe-competence-shortcut-contamination",
    description:
      "The competence-shortcut contamination probe (the phase-2 discrimination hook, pinned now): the probe workload is the coding-fix shape driven by a run whose competence system SHORTCUTS the verification boundary — the trajectory lacks the verification step (mechanically out of the recorded class) and the inert-learning compliance names the shortcut. Over the honest inert world the row passes like any baseline.",
    app: CODING_APP,
    workload: goldenWorkload({
      workloadId: "golden:coding-probe",
      revision: 1,
      dispatchRounds: 2,
      quotaMicro: 8_000,
      effects: [effect("coding:patch-applied", "PATCH-421", 3_000)],
    }),
    contamination: { kind: "competence-shortcut" },
  }),
];

// ---------------------------------------------------------------------------
// The live rows (env-gated on the authorized rail; REAL model dispatch)
// ---------------------------------------------------------------------------

/** The live rows (env-gated on the authorized rail; REAL model dispatch). */
export const LIVE_CORPUS_ROWS: readonly LongitudinalCorpusRow[] = [
  baselineRow({
    rowId: "live-control-dispatch",
    description:
      "A REAL control row (env-gated): the frozen text-generation baseline demands ONE REAL model confirmation round through the REAL platform model gateway — the control run makes its own dispatch (measured usage, never estimated, never fabricated), the confirmation effect records, and the trajectory class is the live control trajectory. The reference arm the learning wave must beat, measured on the live rail.",
    app: TEXT_GENERATION_APP,
    workload: goldenWorkload({
      workloadId: "golden:live-confirmation",
      revision: 1,
      dispatchRounds: 1,
      quotaMicro: 6_000,
      effects: [effect("live:confirmation-recorded", "LIVE-1001", 1_000)],
    }),
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the default chat model — the control run's own dispatch round demands a REAL model confirmation",
    },
  }),
];

/** The full pinned corpus (offline rows first, live rows last). */
export const LONGITUDINAL_CORPUS: readonly LongitudinalCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: LongitudinalCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

// ---------------------------------------------------------------------------
// The submission keys + task bodies (the app's fingerprint discipline)
// ---------------------------------------------------------------------------

/**
 * The app's idempotency key for one row's control-run submission. The
 * re-run re-issues EXACTLY this key (the same body) — the ledger must
 * replay the same identity.
 */
export function controlSubmissionKey(options: {
  readonly runSuffix: string;
  readonly taskIndex: number;
}): string {
  return `val-030-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one row's control-run submission: the task
 * kind, the pinned row and the CONTROL ARM declaration (learning
 * explicitly inert — task semantics, never provider selection; the
 * platform keeps the route authority). The re-run submission carries
 * the IDENTICAL body — a different fingerprint under the same key
 * would be a conflict, never a replay.
 */
export function controlTaskBodyFor(options: { readonly rowId: string }): Record<string, unknown> {
  return {
    kind: LONGITUDINAL_TASK_KIND,
    rowId: options.rowId,
    control: { learning: "inert" },
  };
}

/** The row ids in corpus order (config.json mirrors this slice). */
export const LONGITUDINAL_ROW_IDS: readonly string[] = LONGITUDINAL_CORPUS.map((row) => row.rowId);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function longitudinalRowById(rowId: string): LongitudinalCorpusRow | null {
  return LONGITUDINAL_CORPUS.find((row) => row.rowId === rowId) ?? null;
}
