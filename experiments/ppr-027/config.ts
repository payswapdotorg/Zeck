/**
 * PPR-027 — the longitudinal study configuration (the experiment's
 * declared constants: subjects, workloads, sweep dimensions, synthetic
 * price schedule and fault profiles).
 *
 * PROVENANCE LAW (binding, the honest-measurement law of this work
 * order): the per-subject workloads below are DERIVED from the nine
 * DELIVERED certified evidence records (deploy/evidence/ppr-018.json
 * .. ppr-026.json) — request counts, per-task token volumes and edge
 * mixes reproduce each record's certified corpus shape (the totals are
 * asserted against the records by tests/workload.test.ts, locating each
 * fact wherever its record carries it: the delegated dispositions'
 * execution ids, the battery corpus railUsage sums, the measurements
 * usage-cost entries, or the recorded narrative). The per-request token
 * volumes sum EXACTLY to each subject's certifiedTotals; each subject's
 * modeling residue is absorbed into its first request (disclosed here).
 * They are a workload MODEL derived from certified observations, NOT a
 * re-run of the pinned application runtimes (which are absent from this
 * sandbox — every such re-run is recorded as an honest NOT RUN with its
 * owner).
 *
 * The price schedule and fault/latency profiles are EXPERIMENT
 * CONFIGURATION (declared, synthetic, identical across all three arms of
 * every cell). Cost figures derived from them are labeled synthetic
 * micro-USD everywhere they appear — they are never provider invoices.
 */

/** The modality class of one declared edge (the modality-count axis). */
export type ModalityClass =
  | "text"
  | "local-text"
  | "vision"
  | "speech-recognition"
  | "speech-generation"
  | "image-generation"
  | "embeddings"
  | "rerank"
  | "substrate";

/** The execution-surface vocabulary label carried on workload requests. */
export type WorkloadSurface =
  | "text-generation"
  | "vision-image-understanding"
  | "speech-recognition"
  | "speech-generation"
  | "image-generation"
  | "embeddings"
  | "rerank"
  | "sandbox-program-execution";

export interface SubjectEdge {
  readonly edgeId: string;
  readonly surface: WorkloadSurface;
  readonly modalityClass: ModalityClass;
}

/** One model-plane/media-plane request of one corpus task (derived). */
export interface WorkloadRequest {
  readonly edgeId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface SubjectTask {
  readonly taskId: string;
  readonly title: string;
  readonly instruction: string;
  readonly requests: readonly WorkloadRequest[];
}

export interface SubjectDefinition {
  readonly subjectId: string;
  readonly name: string;
  readonly repository: string;
  /** The certified record's exact upstream + integration revision pins. */
  readonly upstreamRevision: string;
  readonly integrationRevision: string;
  /** The delivered evidence record this subject's derivation comes from. */
  readonly evidenceRecord: string;
  /** Where that record carries its certified request count (the provenance
   * anchor the workload test reads — declared per subject because the nine
   * records were delivered across the program's schema evolution). */
  readonly requestCountBasis:
    | "disposition-execution-ids"
    | "battery-corpus-edge-executions"
    | "resolved-corpus-narrative";
  /** Where that record carries its certified token totals (same discipline). */
  readonly tokenTotalsBasis:
    | "measurements-usage-cost"
    | "battery-rail-usage-sums"
    | "resolved-corpus-narrative"
    | "rail-reported-units-sum";
  readonly edges: readonly SubjectEdge[];
  readonly tasks: readonly SubjectTask[];
  /** The certified totals the derivation is asserted against (tests). */
  readonly certifiedTotals: {
    readonly requests: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

/** The workload-volume axis (corpus repetitions per cell). */
export const VOLUMES = [
  { volume: "S", repetitions: 1, label: "small (1x corpus)" },
  { volume: "M", repetitions: 2, label: "medium (2x corpus)" },
  { volume: "L", repetitions: 4, label: "large (4x corpus)" },
] as const;
export type VolumeKind = (typeof VOLUMES)[number]["volume"];

/** The active-provider-count axis (via injected transport profiles). */
export const PROVIDER_CONFIGS = [
  { providerConfig: "single", providers: ["supply-a"], label: "single-provider configuration" },
  {
    providerConfig: "multi",
    providers: ["supply-a", "supply-b", "supply-c"],
    label: "multi-provider configuration (3 registered supplies)",
  },
] as const;
export type ProviderConfigKind = (typeof PROVIDER_CONFIGS)[number]["providerConfig"];

/** The modality-count axis (the text-only operational slice vs the full graph). */
export const MODALITIES = [
  { modality: "mono", label: "mono-modal (text-class requests only)" },
  { modality: "full", label: "full declared multi-modal graph" },
] as const;
export type ModalityKind = (typeof MODALITIES)[number]["modality"];

/** The maturity axis: three named in-sandbox operational points (an analysis
 * view over the factorial — early/growing/mature are CELLS, not new runs). */
export const MATURITY_POINTS = [
  {
    maturity: "early",
    cell: { volume: "S", providerConfig: "single", modality: "mono" },
    label: "early: feature subset (text edges), 1 provider, 1x corpus",
  },
  {
    maturity: "growing",
    cell: { volume: "M", providerConfig: "multi", modality: "full" },
    label: "growing: full graph, 3 providers, 2x corpus",
  },
  {
    maturity: "mature",
    cell: { volume: "L", providerConfig: "multi", modality: "full" },
    label: "mature: full graph, 3 providers, 4x corpus",
  },
] as const;
export type MaturityKind = (typeof MATURITY_POINTS)[number]["maturity"];

/**
 * The synthetic price schedule (EXPERIMENT CONFIGURATION — declared, not a
 * provider invoice; identical for every arm of every cell). Nano-USD per
 * token (1 micro-USD = 1000 nano-USD); media surfaces priced per call.
 */
export const PRICE_SCHEDULE = {
  perTokenNanoUsd: {
    text: { input: 2, output: 6 },
    "local-text": { input: 0, output: 0 },
    vision: { input: 3, output: 8 },
    embeddings: { input: 0.5, output: 0 },
    rerank: { input: 1, output: 0 },
  },
  perCallNanoUsd: {
    "speech-generation": 40_000,
    "speech-recognition": 25_000,
    "image-generation": 250_000,
    substrate: 2_000,
  },
} as const;

/** The cost of one request under the schedule (nano-USD, integer). */
export function requestCostNanoUsd(request: WorkloadRequest, edge: SubjectEdge): number {
  const perToken =
    PRICE_SCHEDULE.perTokenNanoUsd[
      edge.modalityClass as keyof typeof PRICE_SCHEDULE.perTokenNanoUsd
    ];
  if (perToken !== undefined) {
    return Math.round(
      request.inputTokens * perToken.input + request.outputTokens * perToken.output,
    );
  }
  const perCall =
    PRICE_SCHEDULE.perCallNanoUsd[edge.modalityClass as keyof typeof PRICE_SCHEDULE.perCallNanoUsd];
  return perCall ?? 0;
}

/** One supply endpoint's injected behavior profile (declared, deterministic). */
export interface SupplyProfile {
  readonly providerId: string;
  readonly baseLatencyMs: number;
  readonly latencyJitterMs: number;
  /** Per-10000 draw rates (deterministic hash draws, identical across arms). */
  readonly rateLimitFaultPermyriad: number;
  readonly timeoutFaultPermyriad: number;
  readonly unavailableFaultPermyriad: number;
  /** Per-surface latency multipliers (media surfaces are slower). */
  readonly surfaceLatencyMultiplier: Partial<Record<ModalityClass, number>>;
}

export const SUPPLY_PROFILES: readonly SupplyProfile[] = [
  {
    providerId: "supply-a",
    baseLatencyMs: 12,
    latencyJitterMs: 8,
    rateLimitFaultPermyriad: 800,
    timeoutFaultPermyriad: 200,
    unavailableFaultPermyriad: 50,
    surfaceLatencyMultiplier: {},
  },
  {
    providerId: "supply-b",
    baseLatencyMs: 25,
    latencyJitterMs: 15,
    rateLimitFaultPermyriad: 2500,
    timeoutFaultPermyriad: 300,
    unavailableFaultPermyriad: 100,
    surfaceLatencyMultiplier: {},
  },
  {
    providerId: "supply-c",
    baseLatencyMs: 18,
    latencyJitterMs: 10,
    rateLimitFaultPermyriad: 1200,
    timeoutFaultPermyriad: 800,
    unavailableFaultPermyriad: 50,
    surfaceLatencyMultiplier: {
      "image-generation": 3,
      "speech-generation": 2,
      "speech-recognition": 2,
    },
  },
];

/** The default supply every direct/mediated arm addresses first. */
export const PRIMARY_SUPPLY_ID = "supply-a";

// ---------------------------------------------------------------------------
// The nine certified subjects (workloads derived from the delivered records)
// ---------------------------------------------------------------------------

export const SUBJECTS: readonly SubjectDefinition[] = [
  {
    subjectId: "aider",
    name: "Aider",
    repository: "https://github.com/Aider-AI/aider",
    upstreamRevision: "5dc9490bb35f9729ef2c95d00a19ccd30c26339c",
    integrationRevision: "ac2002b129e85476363ba23ee253b76ec880a016",
    evidenceRecord: "deploy/evidence/ppr-018.json",
    requestCountBasis: "disposition-execution-ids",
    tokenTotalsBasis: "rail-reported-units-sum",
    edges: [
      { edgeId: "aider.main-completion", surface: "text-generation", modalityClass: "text" },
      { edgeId: "aider.commit-message", surface: "text-generation", modalityClass: "text" },
      { edgeId: "aider.summarizer", surface: "text-generation", modalityClass: "text" },
    ],
    tasks: [
      {
        taskId: "implement-function",
        title: "Implement word_score per spec",
        instruction: "Implement the word_score function per the spec fixture (1 turn).",
        requests: [
          { edgeId: "aider.main-completion", inputTokens: 1965, outputTokens: 219 },
          { edgeId: "aider.main-completion", inputTokens: 1850, outputTokens: 218 },
          { edgeId: "aider.commit-message", inputTokens: 500, outputTokens: 50 },
        ],
      },
      {
        taskId: "fix-bug",
        title: "Fix the discount rounding bug in cart.py",
        instruction: "Fix the discount rounding bug (1 turn).",
        requests: [
          { edgeId: "aider.main-completion", inputTokens: 1850, outputTokens: 218 },
          { edgeId: "aider.main-completion", inputTokens: 1850, outputTokens: 218 },
          { edgeId: "aider.commit-message", inputTokens: 500, outputTokens: 50 },
        ],
      },
      {
        taskId: "add-feature",
        title: "Add slugify to strutil.py",
        instruction: "Add the slugify helper (1 turn).",
        requests: [
          { edgeId: "aider.main-completion", inputTokens: 1850, outputTokens: 218 },
          { edgeId: "aider.main-completion", inputTokens: 1850, outputTokens: 218 },
          { edgeId: "aider.commit-message", inputTokens: 500, outputTokens: 50 },
        ],
      },
      {
        taskId: "refactor-extract",
        title: "Extract the duplicated line formatting in report.py",
        instruction: "Extract the duplicated formatting (1 turn).",
        requests: [
          { edgeId: "aider.main-completion", inputTokens: 1850, outputTokens: 218 },
          { edgeId: "aider.main-completion", inputTokens: 1850, outputTokens: 218 },
          { edgeId: "aider.commit-message", inputTokens: 500, outputTokens: 50 },
        ],
      },
      {
        taskId: "multi-turn",
        title: "Build up pipeline.py across four turns",
        instruction: "Four-turn build with history summarization under the token cap.",
        requests: [
          { edgeId: "aider.main-completion", inputTokens: 1850, outputTokens: 218 },
          { edgeId: "aider.summarizer", inputTokens: 3800, outputTokens: 200 },
          { edgeId: "aider.summarizer", inputTokens: 3800, outputTokens: 200 },
          { edgeId: "aider.summarizer", inputTokens: 3800, outputTokens: 200 },
          { edgeId: "aider.commit-message", inputTokens: 500, outputTokens: 50 },
          { edgeId: "aider.commit-message", inputTokens: 500, outputTokens: 50 },
          { edgeId: "aider.commit-message", inputTokens: 500, outputTokens: 50 },
          { edgeId: "aider.commit-message", inputTokens: 500, outputTokens: 50 },
        ],
      },
    ],
    certifiedTotals: { requests: 20, inputTokens: 32165, outputTokens: 2963 },
  },
  {
    subjectId: "cline",
    name: "Cline",
    repository: "https://github.com/cline/cline",
    upstreamRevision: "252082b9e93b4f91253876391e35b4c13326f5e6",
    integrationRevision: "51fdd3d56fb2091bead0e3ba094ae9008d221422",
    evidenceRecord: "deploy/evidence/ppr-019.json",
    requestCountBasis: "disposition-execution-ids",
    tokenTotalsBasis: "battery-rail-usage-sums",
    edges: [
      { edgeId: "cline.act", surface: "text-generation", modalityClass: "text" },
      { edgeId: "cline.plan", surface: "text-generation", modalityClass: "text" },
      { edgeId: "cline.vision", surface: "vision-image-understanding", modalityClass: "vision" },
      { edgeId: "cline.reasoning", surface: "text-generation", modalityClass: "text" },
      { edgeId: "cline.compaction.agentic", surface: "text-generation", modalityClass: "text" },
    ],
    tasks: [
      {
        taskId: "act-mode-edit",
        title: "Act-mode edit: implement a scoring function and verify it",
        instruction: "Act-mode edit through the agent loop.",
        requests: [
          { edgeId: "cline.act", inputTokens: 8163, outputTokens: 397 },
          { edgeId: "cline.act", inputTokens: 6200, outputTokens: 177 },
          { edgeId: "cline.act", inputTokens: 6200, outputTokens: 177 },
          { edgeId: "cline.act", inputTokens: 6200, outputTokens: 177 },
          { edgeId: "cline.act", inputTokens: 6200, outputTokens: 177 },
        ],
      },
      {
        taskId: "plan-mode",
        title: "Plan mode: produce a numbered implementation plan",
        instruction: "Plan-mode turn producing a numbered plan.",
        requests: [
          { edgeId: "cline.plan", inputTokens: 5300, outputTokens: 91 },
          { edgeId: "cline.plan", inputTokens: 5300, outputTokens: 91 },
          { edgeId: "cline.plan", inputTokens: 5300, outputTokens: 91 },
        ],
      },
      {
        taskId: "vision-qa",
        title: "Vision QA: identify the dominant color of the swatch",
        instruction: "Vision question over the orange-swatch fixture.",
        requests: [{ edgeId: "cline.vision", inputTokens: 910, outputTokens: 21 }],
      },
      {
        taskId: "reasoning-math",
        title: "Reasoning: double the primes under 20",
        instruction: "High-thinking-effort arithmetic turn.",
        requests: [{ edgeId: "cline.reasoning", inputTokens: 5236, outputTokens: 115 }],
      },
      {
        taskId: "context-compaction",
        title: "Context compaction: multi-file read+append under a 9000-token window",
        instruction: "Agentic compaction under a small context window.",
        requests: [
          ...Array.from({ length: 32 }, () => ({
            edgeId: "cline.act",
            inputTokens: 2100,
            outputTokens: 45,
          })),
          ...Array.from({ length: 6 }, () => ({
            edgeId: "cline.compaction.agentic",
            inputTokens: 2500,
            outputTokens: 50,
          })),
        ],
      },
    ],
    certifiedTotals: { requests: 48, inputTokens: 137209, outputTokens: 3254 },
  },
  {
    subjectId: "openhands",
    name: "OpenHands",
    repository: "https://github.com/OpenHands/software-agent-sdk",
    upstreamRevision: "fcc102a697874d54a357e36004e02c95040dbdc0",
    integrationRevision: "cf4bb49daf38d6aa9884283a55885c96af24efda",
    evidenceRecord: "deploy/evidence/ppr-020.json",
    requestCountBasis: "disposition-execution-ids",
    tokenTotalsBasis: "battery-rail-usage-sums",
    edges: [
      { edgeId: "openhands.agent-loop.main", surface: "text-generation", modalityClass: "text" },
      {
        edgeId: "openhands.agent-loop.vision",
        surface: "vision-image-understanding",
        modalityClass: "vision",
      },
      {
        edgeId: "openhands.condenser.llm-summarize",
        surface: "text-generation",
        modalityClass: "text",
      },
      { edgeId: "openhands.subagent.task-loop", surface: "text-generation", modalityClass: "text" },
      { edgeId: "openhands.tool.ask-oracle", surface: "text-generation", modalityClass: "text" },
    ],
    tasks: [
      {
        taskId: "implement-edit",
        title: "Agent loop: implement a scoring function and verify it",
        instruction: "Agent-loop implementation with terminal/file tools.",
        requests: [
          { edgeId: "openhands.agent-loop.main", inputTokens: 9194, outputTokens: 125 },
          ...Array.from({ length: 5 }, () => ({
            edgeId: "openhands.agent-loop.main",
            inputTokens: 3000,
            outputTokens: 40,
          })),
        ],
      },
      {
        taskId: "vision-qa",
        title: "Agent loop (vision): identify the dominant color",
        instruction: "Vision turn over the orange-swatch fixture.",
        requests: [{ edgeId: "openhands.agent-loop.vision", inputTokens: 900, outputTokens: 25 }],
      },
      {
        taskId: "context-compaction",
        title: "Condenser: multi-file read+append under a small max_size",
        instruction: "LLM-condenser summarization passes.",
        requests: [
          ...Array.from({ length: 16 }, () => ({
            edgeId: "openhands.agent-loop.main",
            inputTokens: 4500,
            outputTokens: 60,
          })),
          ...Array.from({ length: 16 }, () => ({
            edgeId: "openhands.condenser.llm-summarize",
            inputTokens: 4500,
            outputTokens: 60,
          })),
        ],
      },
      {
        taskId: "delegate-explore",
        title: "Sub-agent loop: delegate workspace inspection",
        instruction: "Explorer sub-agent delegation.",
        requests: [
          ...Array.from({ length: 3 }, () => ({
            edgeId: "openhands.agent-loop.main",
            inputTokens: 4000,
            outputTokens: 50,
          })),
          ...Array.from({ length: 3 }, () => ({
            edgeId: "openhands.subagent.task-loop",
            inputTokens: 4000,
            outputTokens: 50,
          })),
        ],
      },
      {
        taskId: "oracle-consult",
        title: "Auxiliary model client: consult the oracle profile",
        instruction: "Oracle auxiliary-model consultation.",
        requests: [
          ...Array.from({ length: 3 }, () => ({
            edgeId: "openhands.agent-loop.main",
            inputTokens: 4000,
            outputTokens: 50,
          })),
          { edgeId: "openhands.tool.ask-oracle", inputTokens: 3000, outputTokens: 47 },
        ],
      },
    ],
    certifiedTotals: { requests: 49, inputTokens: 208094, outputTokens: 2767 },
  },
  {
    subjectId: "continue",
    name: "Continue",
    repository: "https://github.com/continuedev/continue",
    upstreamRevision: "5522c6f44ca0ac3528b37244818fbfa39b5af470",
    integrationRevision: "241f162b24bcdd0e4a1b1c724425f7ccc39ccc4d",
    evidenceRecord: "deploy/evidence/ppr-021.json",
    requestCountBasis: "resolved-corpus-narrative",
    tokenTotalsBasis: "resolved-corpus-narrative",
    edges: [
      { edgeId: "continue.cli.agent-loop.chat", surface: "text-generation", modalityClass: "text" },
      {
        edgeId: "continue.cli.subagent.child-session",
        surface: "text-generation",
        modalityClass: "text",
      },
      { edgeId: "continue.cli.role.edit", surface: "text-generation", modalityClass: "text" },
      { edgeId: "continue.cli.role.apply", surface: "text-generation", modalityClass: "text" },
      {
        edgeId: "continue.cli.role.autocomplete",
        surface: "text-generation",
        modalityClass: "text",
      },
      { edgeId: "continue.cli.role.embed", surface: "embeddings", modalityClass: "embeddings" },
      { edgeId: "continue.cli.role.rerank", surface: "rerank", modalityClass: "rerank" },
    ],
    tasks: [
      {
        taskId: "agent-edit-task",
        title: "CLI agent loop: implement a scoring function and verify it",
        instruction: "CLI print-mode agent loop.",
        requests: [
          { edgeId: "continue.cli.agent-loop.chat", inputTokens: 4484, outputTokens: 122 },
          ...Array.from({ length: 4 }, () => ({
            edgeId: "continue.cli.agent-loop.chat",
            inputTokens: 3200,
            outputTokens: 50,
          })),
        ],
      },
      {
        taskId: "agent-subagent-delegate",
        title: "CLI sub-agent delegation (serve mode)",
        instruction: "Serve-mode sub-agent delegation.",
        requests: Array.from({ length: 8 }, () => ({
          edgeId: "continue.cli.agent-loop.chat",
          inputTokens: 1800,
          outputTokens: 30,
        })),
      },
      {
        taskId: "edit-inline",
        title: "Edit role: rewrite a highlighted function",
        instruction: "Inline-edit role turn.",
        requests: [{ edgeId: "continue.cli.role.edit", inputTokens: 800, outputTokens: 60 }],
      },
      {
        taskId: "apply-fast",
        title: "Apply role: merge a lazy code block",
        instruction: "Fast-apply role turn.",
        requests: [{ edgeId: "continue.cli.role.apply", inputTokens: 700, outputTokens: 50 }],
      },
      {
        taskId: "autocomplete-tab",
        title: "Autocomplete role: FIM completion",
        instruction: "Fill-in-the-middle completion.",
        requests: [{ edgeId: "continue.cli.role.autocomplete", inputTokens: 60, outputTokens: 20 }],
      },
      {
        taskId: "index-embed",
        title: "Embed role: index a document",
        instruction: "Embeddings indexing turn.",
        requests: Array.from({ length: 3 }, () => ({
          edgeId: "continue.cli.role.embed",
          inputTokens: 400,
          outputTokens: 0,
        })),
      },
      {
        taskId: "rerank-retrieval",
        title: "Rerank role: order retrieved documents",
        instruction: "Rerank turn over 4 documents.",
        requests: [{ edgeId: "continue.cli.role.rerank", inputTokens: 300, outputTokens: 0 }],
      },
    ],
    certifiedTotals: { requests: 20, inputTokens: 34744, outputTokens: 692 },
  },
  {
    subjectId: "hermes-agent",
    name: "Hermes-Agent",
    repository: "https://github.com/NousResearch/hermes-agent",
    upstreamRevision: "77e2992020eafded09e0c344e687ae53e52e6eab",
    integrationRevision: "241f162b24bcdd0e4a1b1c724425f7ccc39ccc4d",
    evidenceRecord: "deploy/evidence/ppr-022.json",
    requestCountBasis: "battery-corpus-edge-executions",
    tokenTotalsBasis: "battery-rail-usage-sums",
    edges: [
      { edgeId: "hermes.agent-loop.main", surface: "text-generation", modalityClass: "text" },
      {
        edgeId: "hermes.auxiliary.title-generation",
        surface: "text-generation",
        modalityClass: "text",
      },
      { edgeId: "hermes.auxiliary.compression", surface: "text-generation", modalityClass: "text" },
      {
        edgeId: "hermes.auxiliary.vision-analyze",
        surface: "vision-image-understanding",
        modalityClass: "vision",
      },
      {
        edgeId: "hermes.tool.tts-openai",
        surface: "speech-generation",
        modalityClass: "speech-generation",
      },
      {
        edgeId: "hermes.tool.stt-openai",
        surface: "speech-recognition",
        modalityClass: "speech-recognition",
      },
      {
        edgeId: "hermes.tool.image-generate-openai",
        surface: "image-generation",
        modalityClass: "image-generation",
      },
    ],
    tasks: [
      {
        taskId: "implement-edit",
        title: "Agent loop: implement a scoring function and verify it",
        instruction: "Agent-loop implementation with file/terminal tools.",
        requests: [
          { edgeId: "hermes.agent-loop.main", inputTokens: 3918, outputTokens: 59 },
          ...Array.from({ length: 4 }, () => ({
            edgeId: "hermes.agent-loop.main",
            inputTokens: 3900,
            outputTokens: 60,
          })),
          ...Array.from({ length: 3 }, () => ({
            edgeId: "hermes.auxiliary.title-generation",
            inputTokens: 1500,
            outputTokens: 25,
          })),
        ],
      },
      {
        taskId: "vision-qa",
        title: "Auxiliary vision: identify the dominant color of a local image",
        instruction: "Vision analysis of the orange-swatch fixture.",
        requests: [
          ...Array.from({ length: 6 }, () => ({
            edgeId: "hermes.agent-loop.main",
            inputTokens: 750,
            outputTokens: 15,
          })),
          { edgeId: "hermes.auxiliary.vision-analyze", inputTokens: 1000, outputTokens: 36 },
        ],
      },
      {
        taskId: "context-compaction",
        title: "Compression: multi-file read+append under a small context window",
        instruction: "Context compression passes under the token cap.",
        requests: [
          ...Array.from({ length: 17 }, () => ({
            edgeId: "hermes.agent-loop.main",
            inputTokens: 6600,
            outputTokens: 130,
          })),
          ...Array.from({ length: 2 }, () => ({
            edgeId: "hermes.auxiliary.compression",
            inputTokens: 5700,
            outputTokens: 168,
          })),
        ],
      },
      {
        taskId: "speak-text",
        title: "TTS: synthesize a spoken confirmation",
        instruction: "Text-to-speech tool turn.",
        requests: [
          ...Array.from({ length: 6 }, () => ({
            edgeId: "hermes.agent-loop.main",
            inputTokens: 950,
            outputTokens: 12,
          })),
          { edgeId: "hermes.tool.tts-openai", inputTokens: 315, outputTokens: 15 },
        ],
      },
      {
        taskId: "transcribe-memo",
        title: "STT: transcribe the known-phrase memo",
        instruction: "Speech-to-text tool turn.",
        requests: [{ edgeId: "hermes.tool.stt-openai", inputTokens: 94, outputTokens: 11 }],
      },
      {
        taskId: "generate-image",
        title: "Image generation: draw a simple icon",
        instruction: "Image-generation tool turn.",
        requests: [
          ...Array.from({ length: 6 }, () => ({
            edgeId: "hermes.agent-loop.main",
            inputTokens: 1000,
            outputTokens: 17,
          })),
          { edgeId: "hermes.tool.image-generate-openai", inputTokens: 625, outputTokens: 35 },
        ],
      },
    ],
    certifiedTotals: { requests: 49, inputTokens: 165852, outputTokens: 3281 },
  },
  {
    subjectId: "openclaw",
    name: "OpenClaw",
    repository: "https://github.com/openclaw/openclaw",
    upstreamRevision: "f6883b3771c0a40d7bd62fcb99815dcbbb2e24f3",
    integrationRevision: "df6304521e74ea848f1a3691f34c381b42d45e2b",
    evidenceRecord: "deploy/evidence/ppr-023.json",
    requestCountBasis: "disposition-execution-ids",
    tokenTotalsBasis: "battery-rail-usage-sums",
    edges: [
      { edgeId: "openclaw.agent-loop.main", surface: "text-generation", modalityClass: "text" },
      {
        edgeId: "openclaw.media-understanding.image",
        surface: "vision-image-understanding",
        modalityClass: "vision",
      },
      {
        edgeId: "openclaw.media-understanding.audio",
        surface: "speech-recognition",
        modalityClass: "speech-recognition",
      },
      {
        edgeId: "openclaw.tool.tts-openai",
        surface: "speech-generation",
        modalityClass: "speech-generation",
      },
      {
        edgeId: "openclaw.tool.image-generate-openai",
        surface: "image-generation",
        modalityClass: "image-generation",
      },
    ],
    tasks: [
      {
        taskId: "implement-edit",
        title: "Agent exec: implement a scoring function and verify it",
        instruction: "Agent-exec coding turn.",
        requests: [
          { edgeId: "openclaw.agent-loop.main", inputTokens: 7974, outputTokens: 110 },
          ...Array.from({ length: 4 }, () => ({
            edgeId: "openclaw.agent-loop.main",
            inputTokens: 8800,
            outputTokens: 114,
          })),
        ],
      },
      {
        taskId: "describe-image",
        title: "Infer image describe: the dominant color",
        instruction: "Media-understanding describe turn.",
        requests: [
          { edgeId: "openclaw.media-understanding.image", inputTokens: 28, outputTokens: 36 },
        ],
      },
      {
        taskId: "transcribe-memo",
        title: "Infer audio transcribe: the known phrase",
        instruction: "Media-understanding transcription turn.",
        requests: [
          { edgeId: "openclaw.media-understanding.audio", inputTokens: 105, outputTokens: 12 },
        ],
      },
      {
        taskId: "speak-text",
        title: "Infer tts convert: spoken confirmation",
        instruction: "TTS conversion turn.",
        requests: [{ edgeId: "openclaw.tool.tts-openai", inputTokens: 0, outputTokens: 0 }],
      },
      {
        taskId: "generate-image",
        title: "Infer image generate: a flat orange square icon",
        instruction: "Image-generation turn.",
        requests: [
          { edgeId: "openclaw.tool.image-generate-openai", inputTokens: 0, outputTokens: 0 },
        ],
      },
      {
        taskId: "browser-answer",
        title: "Agent exec: read the token from the loopback fixture page",
        instruction: "Browser-actuation task (intelligence rides the main seam).",
        requests: Array.from({ length: 9 }, () => ({
          edgeId: "openclaw.agent-loop.main",
          inputTokens: 14000,
          outputTokens: 72,
        })),
      },
    ],
    certifiedTotals: { requests: 18, inputTokens: 169307, outputTokens: 1262 },
  },
  {
    subjectId: "browser-use",
    name: "Browser Use",
    repository: "https://github.com/browser-use/browser-use",
    upstreamRevision: "7be96ed8bafa8dfe1eef228b59cf5c884b8b2431",
    integrationRevision: "d51b5a59d53ef7824074acc4fce6726f065fcec5",
    evidenceRecord: "deploy/evidence/ppr-024.json",
    requestCountBasis: "disposition-execution-ids",
    tokenTotalsBasis: "measurements-usage-cost",
    edges: [
      { edgeId: "browseruse.agent-loop.main", surface: "text-generation", modalityClass: "text" },
      {
        edgeId: "browseruse.substrate.session",
        surface: "sandbox-program-execution",
        modalityClass: "substrate",
      },
      {
        edgeId: "browseruse.substrate.state-extraction",
        surface: "sandbox-program-execution",
        modalityClass: "substrate",
      },
      {
        edgeId: "browseruse.substrate.action",
        surface: "sandbox-program-execution",
        modalityClass: "substrate",
      },
    ],
    tasks: [
      {
        taskId: "browseruse-model-structured",
        title: "Pure-model structured extraction (no browser)",
        instruction: "Structured output through the model plane alone.",
        requests: [{ edgeId: "browseruse.agent-loop.main", inputTokens: 3764, outputTokens: 189 }],
      },
      {
        taskId: "browseruse-actuation-reveal",
        title: "Actuation-only reveal (delegated substrate, no LLM turn)",
        instruction: "Substrate-plane operations only.",
        requests: [
          { edgeId: "browseruse.substrate.session", inputTokens: 0, outputTokens: 0 },
          { edgeId: "browseruse.substrate.state-extraction", inputTokens: 0, outputTokens: 0 },
          { edgeId: "browseruse.substrate.action", inputTokens: 0, outputTokens: 0 },
          { edgeId: "browseruse.substrate.action", inputTokens: 0, outputTokens: 0 },
          { edgeId: "browseruse.substrate.state-extraction", inputTokens: 0, outputTokens: 0 },
          { edgeId: "browseruse.substrate.session", inputTokens: 0, outputTokens: 0 },
        ],
      },
      {
        taskId: "browseruse-agent-combined",
        title: "Combined agent loop over the loopback fixture page",
        instruction: "Both planes: model intelligence + delegated actuation.",
        requests: [
          { edgeId: "browseruse.agent-loop.main", inputTokens: 3760, outputTokens: 190 },
          { edgeId: "browseruse.agent-loop.main", inputTokens: 3760, outputTokens: 190 },
          { edgeId: "browseruse.substrate.session", inputTokens: 0, outputTokens: 0 },
          { edgeId: "browseruse.substrate.state-extraction", inputTokens: 0, outputTokens: 0 },
          { edgeId: "browseruse.substrate.state-extraction", inputTokens: 0, outputTokens: 0 },
          { edgeId: "browseruse.substrate.action", inputTokens: 0, outputTokens: 0 },
          { edgeId: "browseruse.substrate.action", inputTokens: 0, outputTokens: 0 },
          { edgeId: "browseruse.substrate.action", inputTokens: 0, outputTokens: 0 },
        ],
      },
    ],
    certifiedTotals: { requests: 15, inputTokens: 11284, outputTokens: 569 },
  },
  {
    subjectId: "openwebui",
    name: "Open WebUI",
    repository: "https://github.com/open-webui/open-webui",
    upstreamRevision: "8bd8b4fac5e059578ac0c74b3c18d11139f88b7d",
    integrationRevision: "1485ddd92202153f44c21f3eeb8b65f55322ac67",
    evidenceRecord: "deploy/evidence/ppr-025.json",
    requestCountBasis: "disposition-execution-ids",
    tokenTotalsBasis: "measurements-usage-cost",
    edges: [
      { edgeId: "openwebui.chat.openai-rail", surface: "text-generation", modalityClass: "text" },
      {
        edgeId: "openwebui.chat.local-rail",
        surface: "text-generation",
        modalityClass: "local-text",
      },
      { edgeId: "openwebui.rag.embeddings", surface: "embeddings", modalityClass: "embeddings" },
      {
        edgeId: "openwebui.images.openai-generate",
        surface: "image-generation",
        modalityClass: "image-generation",
      },
      {
        edgeId: "openwebui.audio.stt-openai",
        surface: "speech-recognition",
        modalityClass: "speech-recognition",
      },
      {
        edgeId: "openwebui.audio.tts-openai",
        surface: "speech-generation",
        modalityClass: "speech-generation",
      },
    ],
    tasks: [
      {
        taskId: "openwebui-chat-basic",
        title: "Basic chat: the NORTHWIND answer",
        instruction: "Plain chat turn.",
        requests: [{ edgeId: "openwebui.chat.openai-rail", inputTokens: 79, outputTokens: 19 }],
      },
      {
        taskId: "openwebui-chat-auxiliary",
        title: "Auxiliary title task",
        instruction: "The app's own title-generation task.",
        requests: [{ edgeId: "openwebui.chat.openai-rail", inputTokens: 50, outputTokens: 8 }],
      },
      {
        taskId: "openwebui-rag-grounded-qa",
        title: "RAG-grounded QA: the AURORA-7741 answer",
        instruction: "Upload, embed, retrieve, answer.",
        requests: [
          { edgeId: "openwebui.chat.openai-rail", inputTokens: 180, outputTokens: 20 },
          { edgeId: "openwebui.chat.openai-rail", inputTokens: 180, outputTokens: 20 },
          ...Array.from({ length: 6 }, () => ({
            edgeId: "openwebui.rag.embeddings",
            inputTokens: 90,
            outputTokens: 0,
          })),
        ],
      },
      {
        taskId: "openwebui-memories-embeddings",
        title: "Memories: the MOONRISE-4413 ranking",
        instruction: "Pure embeddings turn.",
        requests: [{ edgeId: "openwebui.rag.embeddings", inputTokens: 80, outputTokens: 0 }],
      },
      {
        taskId: "openwebui-image-generation",
        title: "Image generation",
        instruction: "Image-generation turn.",
        requests: [
          { edgeId: "openwebui.images.openai-generate", inputTokens: 30, outputTokens: 8 },
        ],
      },
      {
        taskId: "openwebui-audio-transcription",
        title: "Audio transcription: golden harbor",
        instruction: "STT turn over the known-phrase wav.",
        requests: [{ edgeId: "openwebui.audio.stt-openai", inputTokens: 25, outputTokens: 7 }],
      },
      {
        taskId: "openwebui-audio-speech",
        title: "Audio speech synthesis",
        instruction: "TTS turn.",
        requests: [{ edgeId: "openwebui.audio.tts-openai", inputTokens: 20, outputTokens: 5 }],
      },
      {
        taskId: "openwebui-local-rail-chat",
        title: "Local-rail chat: SIGNAL-LANTERN via zeck-local:8b",
        instruction: "Ollama-native local-rail chat turn.",
        requests: [{ edgeId: "openwebui.chat.local-rail", inputTokens: 70, outputTokens: 12 }],
      },
    ],
    certifiedTotals: { requests: 15, inputTokens: 1254, outputTokens: 99 },
  },
  {
    subjectId: "anythingllm",
    name: "AnythingLLM",
    repository: "https://github.com/Mintplex-Labs/anything-llm",
    upstreamRevision: "fa7ec877f005a21ede94888b3b8618b700343857",
    integrationRevision: "a8ffc9e2c93b38e60c3fa5cec8591a22dfc5be86",
    evidenceRecord: "deploy/evidence/ppr-026.json",
    requestCountBasis: "disposition-execution-ids",
    tokenTotalsBasis: "measurements-usage-cost",
    edges: [
      { edgeId: "anythingllm.chat.openai-rail", surface: "text-generation", modalityClass: "text" },
      {
        edgeId: "anythingllm.chat.local-rail",
        surface: "text-generation",
        modalityClass: "local-text",
      },
      { edgeId: "anythingllm.rag.embeddings", surface: "embeddings", modalityClass: "embeddings" },
      {
        edgeId: "anythingllm.audio.stt-generic",
        surface: "speech-recognition",
        modalityClass: "speech-recognition",
      },
      {
        edgeId: "anythingllm.audio.tts-generic",
        surface: "speech-generation",
        modalityClass: "speech-generation",
      },
    ],
    tasks: [
      {
        taskId: "anythingllm-chat-basic",
        title: "Basic chat: the EASTGALE answer",
        instruction: "Plain chat turn.",
        requests: [{ edgeId: "anythingllm.chat.openai-rail", inputTokens: 143, outputTokens: 13 }],
      },
      {
        taskId: "anythingllm-embed-document",
        title: "Embed a document into the workspace",
        instruction: "Pure embeddings turn.",
        requests: [{ edgeId: "anythingllm.rag.embeddings", inputTokens: 70, outputTokens: 0 }],
      },
      {
        taskId: "anythingllm-rag-grounded-qa",
        title: "RAG-grounded QA: the MERIDIAN-3391 answer",
        instruction: "LanceDB RAG pipeline turn.",
        requests: [
          { edgeId: "anythingllm.chat.openai-rail", inputTokens: 180, outputTokens: 11 },
          { edgeId: "anythingllm.rag.embeddings", inputTokens: 55, outputTokens: 0 },
          { edgeId: "anythingllm.rag.embeddings", inputTokens: 55, outputTokens: 0 },
        ],
      },
      {
        taskId: "anythingllm-audio-transcription",
        title: "Audio transcription: golden harbor",
        instruction: "STT turn over the known-phrase wav.",
        requests: [{ edgeId: "anythingllm.audio.stt-generic", inputTokens: 28, outputTokens: 6 }],
      },
      {
        taskId: "anythingllm-audio-speech",
        title: "Audio speech synthesis",
        instruction: "TTS turn (with the app's internal chat turn).",
        requests: [
          { edgeId: "anythingllm.audio.tts-generic", inputTokens: 22, outputTokens: 5 },
          { edgeId: "anythingllm.chat.openai-rail", inputTokens: 55, outputTokens: 5 },
        ],
      },
      {
        taskId: "anythingllm-local-rail-chat",
        title: "Local-rail chat: MOONGLASS via the Ollama provider",
        instruction: "Per-workspace local-rail chat turn.",
        requests: [{ edgeId: "anythingllm.chat.local-rail", inputTokens: 50, outputTokens: 0 }],
      },
    ],
    certifiedTotals: { requests: 9, inputTokens: 658, outputTokens: 40 },
  },
];

/** Look up a subject's edge definition (fail-closed on unknown edges). */
export function edgeOf(subject: SubjectDefinition, edgeId: string): SubjectEdge {
  const edge = subject.edges.find((candidate) => candidate.edgeId === edgeId);
  if (edge === undefined) {
    throw new Error(`unknown edge ${edgeId} for subject ${subject.subjectId}`);
  }
  return edge;
}

/** True when the subject's declared graph is text-only (the modality axis
 * collapses — the mono and full slices are identical). */
export function modalityAxisDegenerate(subject: SubjectDefinition): boolean {
  return subject.edges.every(
    (edge) => edge.modalityClass === "text" || edge.modalityClass === "local-text",
  );
}

/** The requests of one task under a modality slice (mono = text-class only). */
export function requestsOfTask(
  subject: SubjectDefinition,
  task: SubjectTask,
  modality: ModalityKind,
): readonly WorkloadRequest[] {
  if (modality === "full") {
    return task.requests;
  }
  return task.requests.filter((request) => {
    const edge = edgeOf(subject, request.edgeId);
    return edge.modalityClass === "text" || edge.modalityClass === "local-text";
  });
}
