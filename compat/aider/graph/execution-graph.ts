/**
 * The declared Application Execution Graph for pinned Aider
 * (PPR-018; ACR-006 §1) plus the discovered edge inventory of the
 * pinned revision, and the honest disclosure of the dormant AI edges
 * that exist at the revision but are unreachable under the declared
 * corpus configuration.
 *
 * PINNED UPSTREAM REVISION: 5dc9490bb35f9729ef2c95d00a19ccd30c26339c
 * (https://github.com/Aider-AI/aider — the exact commit the venv in
 * this proof installs; verified by `aider --version` reporting
 * `0.86.3.dev92+g5dc9490bb`).
 *
 * THE SEAM (PPR-018's integration strategy: "prefer Aider's existing
 * model abstraction/LiteLLM seam"): every AI call in Aider funnels
 * through `litellm.completion` — `aider/models.py:1036`
 * (`Model.send_completion`, the single completion seam used by BOTH the
 * streaming main loop and `simple_send_with_retries`). The integration
 * points Aider's own `openai/` LiteLLM provider at the local Zeck
 * adapter (`--openai-api-base`), so the seam is exercised by Aider's
 * real, unmodified code for every edge below.
 *
 * THE THREE ACTIVE EDGES were verified against the pinned revision's
 * source (call-site + reachability analysis under the declared corpus
 * configuration — batch coding runs with auto-commits enabled,
 * `--no-analytics --no-check-update --no-stream`, no voice/image/editor
 * or web commands, no `--cache-keepalive`).
 */

import type {
  ApplicationExecutionGraph,
  DiscoveredEdgeInventory,
} from "../../../src/integrations/compatibility/public";

/** The pinned Aider upstream revision this graph was inventoried against. */
export const AIDER_PINNED_REVISION = "5dc9490bb35f9729ef2c95d00a19ccd30c26339c";

/** The Zeck-side application identity the integration's executions carry. */
export const AIDER_ZECK_APPLICATION_ID = "00000000-0000-7000-8000-00000000a1de";

/** The upstream repository the pin refers to. */
export const AIDER_REPOSITORY = "https://github.com/Aider-AI/aider";

/**
 * The declared execution graph: every material AI edge ACTIVE under the
 * declared corpus configuration of the pinned revision.
 */
export const AIDER_EXECUTION_GRAPH: ApplicationExecutionGraph = {
  edges: [
    {
      edgeId: "aider.main-completion",
      component: "aider/coders/base_coder.py:send (main coding loop)",
      surface: "text-generation",
      transport: "litellm.completion via Model.send_completion (aider/models.py:1036) over the openai/ LiteLLM provider pointed at the Zeck adapter",
      externalExecution: "Zeck execution (coding-assistant completion) through the adapter's public API client",
      materiality:
        "The primary coding edge: every user turn produces a chat completion that decides the code edits Aider applies. Undelegated, Aider would invoke a direct external AI provider here.",
    },
    {
      edgeId: "aider.commit-message",
      component: "aider/repo.py:get_commit_message (weak model)",
      surface: "text-generation",
      transport: "Model.simple_send_with_retries → Model.send_completion (aider/models.py:1036) over the same openai/ LiteLLM provider",
      externalExecution: "Zeck execution (coding-assistant completion, weak role) through the adapter's public API client",
      materiality:
        "Auxiliary weak-model edge: with auto-commits enabled (the declared corpus configuration) Aider generates every automatic commit message with this model call. An auxiliary model path bypassing Zeck would break edge coverage exactly as ACR-006's completeness rule describes.",
    },
    {
      edgeId: "aider.summarizer",
      component: "aider/history.py:summarize_all (chat-history summarization)",
      surface: "text-generation",
      transport: "Model.simple_send_with_retries → Model.send_completion (aider/models.py:1036) over the same openai/ LiteLLM provider",
      externalExecution: "Zeck execution (coding-assistant completion, summarizer role) through the adapter's public API client",
      materiality:
        "Auxiliary summarization edge: when accumulated chat history exceeds max_chat_history_tokens (1024 for the declared models — aider/models.py:339), Aider compresses history with this model call. The multi-turn corpus task drives it; it is an actually-active AI path under the declared corpus.",
    },
  ],
};

/**
 * The discovered edge inventory: the static call-site scan of the pinned
 * revision restricted to the declared corpus configuration (the same
 * standard PPR-018 sets: "auxiliary/summarization/weak-model paths that
 * are actually active"). Every litellm/AI call site at the revision was
 * classified; the three reachable, active edges below are exactly the
 * declared graph's three edges (matched by component+surface+external
 * chain, so reconciliation finds no undeclared edge).
 */
export const AIDER_DISCOVERED_INVENTORY: DiscoveredEdgeInventory = {
  source: `static call-site scan of Aider ${AIDER_PINNED_REVISION} (every litellm import and completion/transcription call site: aider/models.py:1036, aider/coders/base_coder.py:1373+2037, aider/repo.py:361, aider/history.py:116, aider/commands.py:206, aider/voice.py, aider/main.py:32), reachability-restricted to the declared corpus configuration (batch coding runs; auto-commits on; --no-analytics --no-check-update --no-stream; no voice/image/editor/web commands; no --cache-keepalive)`,
  edges: AIDER_EXECUTION_GRAPH.edges,
};

/** One dormant AI edge disclosed (never silently ignored). */
export interface DormantEdge {
  readonly edgeId: string;
  readonly component: string;
  readonly surface: string;
  /** The exact gate that keeps this edge unreachable under the declared corpus. */
  readonly gate: string;
}

/**
 * AI edges present at the pinned revision but NOT reachable under the
 * declared corpus configuration. These are disclosed in the evidence
 * record's limitations and NOT declared in the graph (an unreachable
 * code path is not an AI call "Aider makes for the declared tasks");
 * none of them is counted as covered by the proof.
 */
export const AIDER_DORMANT_EDGES: readonly DormantEdge[] = [
  {
    edgeId: "aider.cache-warming",
    component: "aider/coders/base_coder.py:1373 (warm_cache worker)",
    surface: "text-generation",
    gate:
      "requires --cache-keepalive (num_cache_warming_pings > 0) and cache-header models; the declared corpus configuration does not enable it",
  },
  {
    edgeId: "aider.voice-transcription",
    component: "aider/voice.py (litellm.transcription)",
    surface: "speech-recognition",
    gate:
      "the interactive /voice command; the declared corpus is non-interactive batch coding runs",
  },
  {
    edgeId: "aider.image-chat",
    component: "aider/coders/base_coder.py send with image parts",
    surface: "vision-image-understanding",
    gate:
      "requires images added to chat (/add of image files); the declared corpus is text-only coding tasks",
  },
  {
    edgeId: "aider.editor-model",
    component: "aider/models.py editor_model via the /editor command",
    surface: "text-generation",
    gate: "the interactive /editor command; not issued by the declared corpus",
  },
  {
    edgeId: "aider.web-scrape",
    component: "aider/scrape.py via the /web command",
    surface: "extraction-document-intelligence",
    gate: "the interactive /web command; not issued by the declared corpus",
  },
];

/**
 * Non-AI edges at the pinned revision, explicitly outside the
 * Zeck-completeness criterion (PPR-018: Aider retains repository,
 * filesystem and Git domain operations; local deterministic computation
 * is not AI execution). Recorded verbatim in the evidence record.
 */
export const AIDER_NON_AI_OPERATIONS: readonly string[] = [
  "repo map construction (aider/repomap.py — local tree-sitter parsing, no AI service)",
  "token counting (aider/models.py token_count — local tokenizer computation)",
  "cost table lookups (litellm.completion_cost / litellm.model_cost — local cost maps, no network)",
  "git operations, file edits, lint/test subprocesses (application domain operations)",
  "analytics and version-check telemetry (disabled in the declared corpus; any residual attempt is blocked by the proof egress environment and recorded)",
];
