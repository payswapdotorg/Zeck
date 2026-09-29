/**
 * The PPR-019 declared execution graph for pinned Cline (upstream
 * revision 252082b9e93b4f91253876391e35b4c13326f5e6, cloned from
 * https://github.com/cline/cline) plus the DISCOVERED edge inventory
 * the static no-bypass reconciliation runs against.
 *
 * DECLARED EDGES (the material AI-execution seams the declared corpus
 * exercises; every one is delegated through Zeck by the certified
 * adapter — see ../adapter/edges.ts for request→edge attribution):
 *
 *  - cline.agent-loop.act       act-mode agent-turn completions (the
 *                               primary tool-deciding model call: every
 *                               read_files / run_commands / editor /
 *                               apply_patch / skills decision, and every
 *                               delegated subagent/teammate loop, is
 *                               produced by this seam)
 *  - cline.agent-loop.plan      plan-mode agent-turn completions (the
 *                               CLI `--plan` mode contract in the system
 *                               prompt)
 *  - cline.agent-loop.vision    agent turns carrying image content parts
 *                               (CLI `@path.png` image attachments)
 *  - cline.agent-loop.reasoning agent turns carrying reasoning-effort
 *                               control (CLI `--thinking <level>`)
 *  - cline.compaction.agentic   the agentic context-compaction
 *                               summarization call (@cline/core
 *                               extensions/context/agentic-compaction.ts —
 *                               the default CLI compaction strategy)
 *
 * DORMANT SEAMS AT THE PINNED REVISION (inventoried, disclosed in the
 * evidence record's dormantEdgeDisclosures — NOT reachable under the
 * declared corpus configuration, never silently ignored): the VS Code
 * host commit-message generator, the VS Code LM handler surfaces, voice
 * transcription + streaming transcription (voiceInput mode), the
 * OpenRouter image-generation transport, and the web_search model tool.
 *
 * NON-AI OPERATIONS (disclosed, outside the completeness criterion per
 * PPR-019: "Cline may retain terminal, filesystem, editor and
 * IDE-specific operations"): run_commands terminal execution,
 * read_files/search_codebase filesystem tools, editor/apply_patch patch
 * application, fetch_web_content (native fetch, no model call),
 * checkpoints, git operations, MCP stdio servers (none configured).
 */

import type {
  ApplicationExecutionGraph,
  DiscoveredEdgeInventory,
  ExecutionGraphEdge,
} from "../../../src/integrations/compatibility/public";

/** The pinned upstream revision this graph was inventoried against. */
export const CLINE_UPSTREAM_REVISION = "252082b9e93b4f91253876391e35b4c13326f5e6";
export const CLINE_UPSTREAM_REPOSITORY = "https://github.com/cline/cline";

/** Every edge id the PPR-019 integration declares (the closed set). */
export const CLINE_EDGE_IDS = [
  "cline.agent-loop.act",
  "cline.agent-loop.plan",
  "cline.agent-loop.vision",
  "cline.agent-loop.reasoning",
  "cline.compaction.agentic",
] as const;

export type ClineEdgeId = (typeof CLINE_EDGE_IDS)[number];

/** The declared application execution graph (ACR-006 §1). */
export const CLINE_EXECUTION_GRAPH: ApplicationExecutionGraph = {
  edges: [
    {
      edgeId: "cline.agent-loop.act",
      component:
        "@cline/core agent runtime (act mode) → services/llms/handler-factory → @cline/llms openai-compatible client",
      surface: "text-generation",
      transport: "OpenAI-compatible chat completions (streaming, native tool calls)",
      externalExecution:
        "the configured LLM provider chat-completions endpoint (undelegated: e.g. api.openai.com/v1/chat/completions)",
      materiality:
        "the primary agent-turn model call: every tool decision (read_files, run_commands, editor/apply_patch edits, skills, team spawn) and every delegated subagent/teammate loop completion is produced through this seam — routing only a 'chat model' and leaving this seam direct would leave the application's whole agentic surface provider-owned",
    },
    {
      edgeId: "cline.agent-loop.plan",
      component:
        "@cline/core agent runtime (plan mode) → services/llms/handler-factory → @cline/llms openai-compatible client",
      surface: "text-generation",
      transport: "OpenAI-compatible chat completions (streaming, native tool calls)",
      externalExecution:
        "the configured LLM provider chat-completions endpoint (undelegated: e.g. api.openai.com/v1/chat/completions)",
      materiality:
        "plan-mode agent turns (CLI --plan; the # Plan Mode system-prompt contract) make their own model calls through the same seam — a plan-mode call that stayed direct would leave planning-time intelligence provider-owned",
    },
    {
      edgeId: "cline.agent-loop.vision",
      component:
        "@cline/core agent runtime (image attachments) → services/llms/handler-factory → @cline/llms openai-compatible client",
      surface: "vision-image-understanding",
      transport: "OpenAI-compatible chat completions with multimodal content parts",
      externalExecution:
        "the configured provider's vision-capable chat-completions endpoint (undelegated: e.g. a vision model endpoint)",
      materiality:
        "agent turns carrying image content parts (CLI @path.png mentions loaded as image data URLs) invoke the provider's vision surface — a text-only delegation would leave the vision edge a direct-provider bypass",
    },
    {
      edgeId: "cline.agent-loop.reasoning",
      component:
        "@cline/core agent runtime (reasoning control) → services/llms/handler-factory → @cline/llms openai-compatible client",
      surface: "text-generation",
      transport: "OpenAI-compatible chat completions with reasoning-effort control",
      externalExecution:
        "the configured provider's reasoning chat-completions endpoint (undelegated: e.g. an o-series/gpt-5 reasoning endpoint)",
      materiality:
        "agent turns carrying reasoning-effort control (CLI --thinking <level>; wire field reasoning_effort) invoke the provider's reasoning surface — reasoning-parameterized intelligence must flow through the delegated boundary like every other edge",
    },
    {
      edgeId: "cline.compaction.agentic",
      component:
        "@cline/core extensions/context/agentic-compaction.ts (agentic context summarization)",
      surface: "text-generation",
      transport: "@cline/llms createHandlerAsync → OpenAI-compatible chat completions",
      externalExecution:
        "the configured LLM provider chat-completions endpoint (the compaction summarizer's own model call, undelegated)",
      materiality:
        "the default CLI compaction strategy summarizes the session through its OWN model call (a distinct auxiliary edge at agentic-compaction.ts:79) — leaving an auxiliary/summarizer call direct is exactly the 'main model only' incompleteness ACR-006 forbids",
    },
  ],
};

/**
 * The DISCOVERED edge inventory: the static seam scan of the pinned
 * revision, restricted to the CLI runtime and the declared corpus
 * configuration (one-shot headless CLI runs with the openai-compatible
 * provider; no VS Code extension host, no voice input, no openrouter
 * image transport, no web_search model tool).
 *
 * The scan enumerated every model-call seam (createMessage /
 * createHandler(Async) / transcription call sites) reachable under that
 * configuration; each discovered edge is claimed by exactly one declared
 * edge (reconciled by the component+surface+external chain).
 */
export const CLINE_DISCOVERED_INVENTORY: DiscoveredEdgeInventory = {
  source: `static seam scan of pinned Cline ${CLINE_UPSTREAM_REVISION} (createMessage/createHandlerAsync/transcription call-site grep, CLI-runtime reachability restricted to the declared corpus configuration)`,
  edges: [
    {
      edgeId: "cline.agent-loop.act",
      component:
        "sdk/packages/core/src/services/llms/apihandler-agent-model-adapter.ts:151 (handler.createMessage — the agent-loop model stream) via handler-factory.ts:226",
      surface: "text-generation",
      transport: "OpenAI-compatible chat completions (streaming, native tool calls)",
      externalExecution:
        "the configured LLM provider chat-completions endpoint (undelegated: e.g. api.openai.com/v1/chat/completions)",
      materiality:
        "discovered agent-loop seam: every act-mode tool decision and delegated subagent/teammate loop completion",
    },
    {
      edgeId: "cline.agent-loop.plan",
      component:
        "sdk/packages/core/src/services/llms/apihandler-agent-model-adapter.ts:151 (handler.createMessage) under the plan-mode system prompt (@cline/shared prompt/system PLAN_MODE_INSTRUCTIONS)",
      surface: "text-generation",
      transport: "OpenAI-compatible chat completions (streaming, native tool calls)",
      externalExecution:
        "the configured LLM provider chat-completions endpoint (undelegated: e.g. api.openai.com/v1/chat/completions)",
      materiality:
        "discovered plan-mode seam: the same call site producing plan-mode turns (CLI --plan)",
    },
    {
      edgeId: "cline.agent-loop.vision",
      component:
        "sdk/packages/core/src/services/llms/apihandler-agent-model-adapter.ts:151 (handler.createMessage) with multimodal content parts from apps/cli/src/runtime/prompt.ts image attachments",
      surface: "vision-image-understanding",
      transport: "OpenAI-compatible chat completions with multimodal content parts",
      externalExecution:
        "the configured provider's vision-capable chat-completions endpoint (undelegated)",
      materiality:
        "discovered vision seam: image data URLs ride the same agent-loop call site into the provider's vision surface",
    },
    {
      edgeId: "cline.agent-loop.reasoning",
      component:
        "sdk/packages/core/src/services/llms/apihandler-agent-model-adapter.ts:151 (handler.createMessage) with reasoning effort from apps/cli/src/utils/reasoning.ts (CLI --thinking)",
      surface: "text-generation",
      transport: "OpenAI-compatible chat completions with reasoning_effort control",
      externalExecution:
        "the configured provider's reasoning chat-completions endpoint (undelegated)",
      materiality:
        "discovered reasoning seam: reasoning-effort-controlled agent turns (CLI --thinking <level>)",
    },
    {
      edgeId: "cline.compaction.agentic",
      component:
        "sdk/packages/core/src/extensions/context/agentic-compaction.ts:75,79 (createHandlerAsync + handler.createMessage — the agentic compaction summarizer)",
      surface: "text-generation",
      transport: "@cline/llms createHandlerAsync → OpenAI-compatible chat completions",
      externalExecution:
        "the configured LLM provider chat-completions endpoint (the compaction summarizer's own model call, undelegated)",
      materiality:
        "discovered auxiliary seam: the default agentic compaction strategy's own model call",
    },
  ] satisfies readonly ExecutionGraphEdge[],
};

/**
 * The dormant seams at the pinned revision — inventoried and disclosed
 * (never silently out of scope), each with the configuration gate that
 * keeps it unreachable under the declared corpus.
 */
export interface DormantSeamDisclosure {
  readonly edgeId: string;
  readonly component: string;
  readonly surface: string;
  readonly gate: string;
}

export const CLINE_DORMANT_SEAMS: readonly DormantSeamDisclosure[] = [
  {
    edgeId: "cline.vscode.commit-message",
    component: "apps/vscode/src/hosts/vscode/commit-message-generator.ts:227 (apiHandler.createMessage)",
    surface: "text-generation",
    gate:
      "the VS Code extension host's auto-commit message generator; the declared corpus runs the pinned CLI runtime (apps/cli), which does not contain or invoke this host surface",
  },
  {
    edgeId: "cline.vscode.lm-handler",
    component: "apps/vscode/src/sdk/sdk-api-handler.ts:115 + vscode-lm/register-vscode-lm.ts:6",
    surface: "text-generation",
    gate:
      "the VS Code LM API host handler; registered only by the VS Code extension host, unreachable from the CLI runtime the declared corpus runs",
  },
  {
    edgeId: "cline.voice.transcription",
    component: "sdk/packages/llms/src/transcription.ts (transcribeAudio / createStreamingAudioTranscriptionSession)",
    surface: "speech-recognition",
    gate:
      "voice input requires the voiceInput provider mode (StoredProviderSettings.modes.voiceInput) and audio input; the declared corpus configures no voice mode and provides no audio",
  },
  {
    edgeId: "cline.openrouter.image-generation",
    component: "sdk/packages/llms/src/providers/vendors/openai-compatible.ts (openRouterImageProvider image transport)",
    surface: "image-generation",
    gate:
      "the image-generation transport activates only for openrouter-family providers with image-producing models (metadata.imageTransport === 'openrouter'); the declared corpus configures the openai-compatible provider against the Zeck adapter, never openrouter",
  },
  {
    edgeId: "cline.web-search-model-tool",
    component: "sdk/packages/core/src/extensions/tools (web_search model tool; runtime.ts model-tool routing)",
    surface: "search-ai-search",
    gate:
      "the web_search model tool requires a provider/model declaring model-tool support (supportsModelTool) and is not in the rail model's declared tool set; the declared corpus does not enable model-tool routing for the delegated provider",
  },
];

/**
 * The non-AI operations Cline retains as application/domain capabilities
 * (PPR-019: "Cline may retain terminal, filesystem, editor and
 * IDE-specific operations") — each verified to make NO model call of its
 * own at the pinned revision.
 */
export const CLINE_NON_AI_OPERATIONS: readonly { readonly name: string; readonly note: string }[] = [
  {
    name: "run_commands (terminal execution)",
    note: "local shell execution with a command guard; no AI provider call (the decision to run a command comes from the delegated agent-loop edge)",
  },
  {
    name: "read_files / search_codebase (filesystem)",
    note: "local file reads and code search; no AI provider call",
  },
  {
    name: "editor / apply_patch (edit application)",
    note: "local patch parsing and application (executors/apply-patch.ts, editor.ts); no AI provider call",
  },
  {
    name: "fetch_web_content",
    note: "native fetch of web content (executors/web-fetch.ts) with no model in the path; blocked by the proof egress control and unused by the declared corpus",
  },
  {
    name: "checkpoints / git operations / MCP stdio servers",
    note: "workspace snapshots, git domain operations and (unconfigured) MCP servers; no AI provider call",
  },
];
