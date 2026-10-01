/**
 * The PPR-021 declared execution graph for pinned Continue plus the
 * DISCOVERED edge inventory the static no-bypass reconciliation runs
 * against.
 *
 * UPSTREAM PIN: github.com/continuedev/continue at the exact revision
 * 5522c6f44ca0ac3528b37244818fbfa39b5af470 (main head at proof time —
 * an anonymous public clone, built with the repository's own toolchain).
 *
 * WHAT CONTINUE IS AT THIS REVISION: an IDE/model platform — the
 * monorepo ships the IDE extensions (VS Code / JetBrains), the shared
 * engine (`core/` — the role-based model platform every IDE client
 * drives through the core protocol), the packaged GUI, and the Continue
 * CLI (`extensions/cli`, binary `cn` — a real headless coding agent with
 * Bash/Edit/Read/Write/Search/Subagent tools). The declared corpus
 * drives BOTH of the application's own headless surfaces:
 *
 *  - the CONTINUE CLI headless mode (`cn -p "<instruction>" --config
 *    <config.yaml>`) for the agent-loop surfaces (chat + subagent), and
 *  - the CORE ROLE APIS (the exact functions the IDE clients drive
 *    through the core protocol handlers — `streamDiffLines`,
 *    `CompletionProvider.provideInlineCompletionItems`,
 *    `BaseLLM.embed`/`BaseLLM.rerank`) for the IDE-side roles.
 *
 * Both surfaces are configured ONLY through Continue's own public
 * configuration surface: a fully-local `config.yaml` (no `use:`/hub
 * refs, no MCP servers, no docs) whose models use the `openai` provider
 * (Continue's OpenAI-compatible seam) pointed at the local Zeck
 * adapter, one model entry per role with a role-identifying model id.
 *
 * DECLARED EDGES (every material AI-execution seam the declared corpus
 * exercises; each is attributed deterministically by its role model id
 * at the adapter — see ../adapter/edges.ts):
 *
 *  - continue.cli.agent-loop.chat    the CLI agent loop's chat-role
 *      model call (every tool decision: Bash, file edits, search,
 *      subagent spawns, finish) — the chat role
 *  - continue.cli.subagent.child-session   the CLI Subagent tool's
 *      child sessions over the subagent-role model (a separately
 *      configured model client)
 *  - continue.core.edit.inline-edit  the Cmd+K-style inline edit path
 *      (core streamDiffLines type "edit" — the edit role)
 *  - continue.core.apply.fast-apply  the fast-apply path (core
 *      streamDiffLines type "apply" — the apply role)
 *  - continue.core.autocomplete.tab  the tab-autocomplete engine (core
 *      CompletionProvider — the autocomplete role, served by the
 *      legacy /completions endpoint)
 *  - continue.core.indexing.embed    the embedding call the
 *      CodebaseIndexer makes per chunk (BaseLLM.embed — the embed role,
 *      served by the /embeddings endpoint)
 *  - continue.core.retrieval.rerank  the reranker the retrieval
 *      pipelines invoke (BaseLLM.rerank — the rerank role, served by
 *      the /rerank endpoint)
 *
 * DORMANT SEAMS AT THE PINNED REVISION (inventoried and disclosed with
 * their configuration gates — never silently ignored; see
 * CONTINUE_DORMANT_SEAMS below): the summarize role (schema-only —
 * "not implemented yet" in core/config/selectedModels.ts at the pinned
 * revision; the CLI's auto-compaction rides the CHAT model through the
 * chat edge), the nextEdit experimental surface, docs/site crawling,
 * MCP servers, hub/remote model + assistant-slug fetching, the
 * transformers.js local-embeddings provider (auto-added only for
 * vscode-type IDEs — the headless corpus's IDE info is non-vscode),
 * the chat edge's vision axis (multimodal content parts — the CLI's
 * headless mode attaches no images at this revision; the adapter and
 * rail support vision routing if exercised), the review/serve CLI
 * subcommands, and the OTEL/telemetry exporters (env-gated; the
 * scrubbed certified environment carries none).
 *
 * NON-AI OPERATIONS (disclosed, outside the completeness criterion per
 * the work order — "Preserve Continue's editor/UI/domain
 * responsibilities"): the Bash tool (local terminal execution), the
 * Read/Write/Edit/MultiEdit file tools (deterministic find-and-replace
 * — no model call), List/Search, git operations, tree-sitter parsing,
 * local token counting, session persistence and the local index stores
 * (FTS5 sqlite / LanceDB files — local computation around the
 * delegated embed edge).
 */

import type {
  ApplicationExecutionGraph,
  DiscoveredEdgeInventory,
  ExecutionGraphEdge,
} from "../../../src/integrations/compatibility/public";

/** The pinned upstream revision this graph was inventoried against. */
export const CONTINUE_UPSTREAM_REVISION = "5522c6f44ca0ac3528b37244818fbfa39b5af470";
export const CONTINUE_UPSTREAM_REPOSITORY = "https://github.com/continuedev/continue";

/** Every edge id the PPR-021 integration declares (the closed set). */
export const CONTINUE_EDGE_IDS = [
  "continue.cli.agent-loop.chat",
  "continue.cli.subagent.child-session",
  "continue.core.edit.inline-edit",
  "continue.core.apply.fast-apply",
  "continue.core.autocomplete.tab",
  "continue.core.indexing.embed",
  "continue.core.retrieval.rerank",
] as const;

export type ContinueEdgeId = (typeof CONTINUE_EDGE_IDS)[number];

/** The declared application execution graph (ACR-006 §1). */
export const CONTINUE_EXECUTION_GRAPH: ApplicationExecutionGraph = {
  edges: [
    {
      edgeId: "continue.cli.agent-loop.chat",
      component:
        "extensions/cli/src/commands/chat.ts runHeadlessMode → src/stream/streamChatResponse.ts:265 chatCompletionStreamWithBackoff → the openai adapter's chatCompletionStream (packages/openai-adapters/src/apis/OpenAI.ts:155) → POST {apiBase}/chat/completions",
      surface: "text-generation",
      transport:
        "openai (openai-compatible) provider chat-completions SSE streaming with native tool calls — the config.yaml chat-role model pointed at the Zeck adapter",
      externalExecution:
        "the configured chat-model provider endpoint (undelegated: e.g. api.openai.com/v1/chat/completions)",
      materiality:
        "the primary agent-loop model call: every tool decision of the Continue CLI (Bash execution, file edits, search, subagent spawns, finish) is produced through this seam — routing only an IDE chat model and leaving the CLI agent loop direct would leave the application's whole agentic surface provider-owned",
    },
    {
      edgeId: "continue.cli.subagent.child-session",
      component:
        "extensions/cli/src/tools/subagent.ts (the Subagent tool) → src/subagent/executor.ts executeSubAgent (a full child chat session) → src/subagent/get-agents.ts (models filtered by role subagent + chatOptions.baseSystemMessage) → the same chat-completions transport over the subagent-role model",
      surface: "text-generation",
      transport:
        "openai (openai-compatible) provider chat-completions streaming — the config.yaml subagent-role model (a separately configured model client) at the Zeck adapter",
      externalExecution:
        "the configured subagent-role provider endpoint (undelegated)",
      materiality:
        "the Subagent tool spawns child conversations over a SEPARATELY-configured subagent-role model — an auxiliary model client outside the main loop that would silently bypass a chat-model-only delegation",
    },
    {
      edgeId: "continue.core.edit.inline-edit",
      component:
        'core/edit/streamDiffLines.ts:77 (payload type "edit" → constructEditPrompt:31 with the gptEditPrompt template) → recursiveStream → BaseLLM.streamChat → the openai provider chat-completions transport (the same path the IDE edit/sendPrompt handler drives through the core protocol)',
      surface: "text-generation",
      transport:
        "the config.yaml edit-role model (openai provider) at the Zeck adapter — the inline-edit prompt template rendered by Continue itself",
      externalExecution:
        "the configured edit-role provider endpoint (undelegated)",
      materiality:
        "the Cmd+K-style inline edit is a distinct editor role with its own model assignment and prompt template (edit ≠ chat in Continue's role vocabulary) — an edit-role model left direct would be an auxiliary-edge bypass exactly as ACR-006 forbids",
    },
    {
      edgeId: "continue.core.apply.fast-apply",
      component:
        'core/edit/streamDiffLines.ts:77 (payload type "apply" → constructApplyPrompt:43 with the defaultApplyPrompt template) → recursiveStream → BaseLLM.streamChat — the fast-apply path (the chat code-block apply path core/edit/lazy/applyCodeBlock.ts → streamLazyApply rides the same apply-role model)',
      surface: "text-generation",
      transport:
        "the config.yaml apply-role model (openai provider) at the Zeck adapter — the fast-apply prompt template rendered by Continue itself",
      externalExecution:
        "the configured apply-role provider endpoint (undelegated)",
      materiality:
        "the apply role is Continue's dedicated code-apply surface (a distinct model assignment for rewriting/merging model-produced code) — collapsing it into the chat edge would misrepresent the application's role structure",
    },
    {
      edgeId: "continue.core.autocomplete.tab",
      component:
        "core/autocomplete/CompletionProvider.ts:150 provideInlineCompletionItems → generation/CompletionStreamer → BaseLLM.streamComplete → OpenAI._legacystreamComplete (core/llm/llms/OpenAI.ts:423; CompletionProvider._prepareLlm:97 forces useLegacyCompletionsEndpoint=true for the openai provider) → POST {apiBase}/completions",
      surface: "text-generation",
      transport:
        "the config.yaml autocomplete-role model (openai provider) at the Zeck adapter over the legacy text-completions endpoint (FIM-templated prompt built by Continue's autocomplete engine)",
      externalExecution:
        "the configured autocomplete-role provider endpoint (undelegated: e.g. api.openai.com/v1/completions)",
      materiality:
        "tab-autocomplete is a distinct, latency-critical Continue role with its own model assignment, prompt pipeline (context retrieval → templating → filtering → postprocessing) and its own wire endpoint — an autocomplete model left direct would be an auxiliary-edge bypass",
    },
    {
      edgeId: "continue.core.indexing.embed",
      component:
        "core/llm/index.ts BaseLLM.embed → the openai adapter's embed (packages/openai-adapters/src/apis/OpenAI.ts:230 openai.embeddings.create) → POST {apiBase}/embeddings — the call core/indexing/CodebaseIndexer.ts makes per chunk (the LanceDB vector index)",
      surface: "embeddings",
      transport:
        "the config.yaml embed-role model (openai provider) at the Zeck adapter over the OpenAI-format embeddings endpoint (batched by Continue's own maxEmbeddingBatchSize)",
      externalExecution:
        "the configured embed-role provider endpoint (undelegated: e.g. api.openai.com/v1/embeddings)",
      materiality:
        "codebase indexing is Continue's core retrieval feature and consumes a dedicated embedding model role — an embeddings edge left direct is exactly the 'auxiliary retrieval model bypasses Zeck' incompleteness ACR-006 forbids",
    },
    {
      edgeId: "continue.core.retrieval.rerank",
      component:
        "core/context/retrieval/pipelines/RerankerRetrievalPipeline.ts:98 → BaseLLM.rerank (core/llm/index.ts:1378) → the openai adapter's rerank (packages/openai-adapters/src/apis/OpenAI.ts:239) → POST {apiBase}/rerank",
      surface: "reranking",
      transport:
        "the config.yaml rerank-role model (openai provider) at the Zeck adapter over the OpenAI-format rerank endpoint ({model, query, documents} → {data: [{index, relevance_score}]})",
      externalExecution:
        "the configured rerank-role provider endpoint (undelegated: e.g. a cohere/voyage-style rerank endpoint)",
      materiality:
        "retrieval reranking is a distinct Continue model role with its own wire surface — a reranker left direct would leave the retrieval quality surface provider-owned",
    },
  ],
};

/**
 * The DISCOVERED edge inventory: the static seam scan of the pinned
 * revision, restricted to the declared corpus configuration (a fully
 * local config.yaml whose models use the openai provider at the Zeck
 * adapter; the Continue CLI headless mode + the core role APIs; no MCP
 * servers, no docs crawling, no hub/remote model refs, no nextEdit, no
 * review/serve subcommands, no OTEL env vars).
 *
 * The scan enumerated every model-role seam (the config-yaml
 * modelRolesSchema vocabulary + every construction of an LLM/API client
 * with its own configuration) reachable under that configuration; each
 * discovered edge is claimed by exactly one declared edge (reconciled
 * by the component+surface+external chain).
 */
export const CONTINUE_DISCOVERED_INVENTORY: DiscoveredEdgeInventory = {
  source:
    "static seam scan of pinned Continue 5522c6f44ca0ac3528b37244818fbfa39b5af470 (modelRolesSchema vocabulary + LLM-client-construction/API-call-site enumeration across extensions/cli/src/{stream,subagent,tools} and core/{llm,autocomplete,edit,indexing,context}, reachability restricted to the declared corpus configuration)",
  edges: [
    {
      edgeId: "continue.cli.agent-loop.chat",
      component:
        "extensions/cli/src/stream/streamChatResponse.ts:265 chatCompletionStreamWithBackoff (the CLI agent loop's model turn) over packages/openai-adapters/src/apis/OpenAI.ts:155 chatCompletionStream → POST {apiBase}/chat/completions",
      surface: "text-generation",
      transport:
        "openai (openai-compatible) provider chat-completions SSE streaming with native tool calls",
      externalExecution:
        "the configured chat-model provider endpoint (undelegated: e.g. api.openai.com/v1/chat/completions)",
      materiality:
        "discovered agent-loop seam: every CLI tool decision and finish turn; the CLI's auto-compaction summarize call rides the same chat-role client (disclosed)",
    },
    {
      edgeId: "continue.cli.subagent.child-session",
      component:
        "extensions/cli/src/tools/subagent.ts → src/subagent/executor.ts executeSubAgent (child chat session) → src/subagent/get-agents.ts:309 (role-subagent models with chatOptions.baseSystemMessage)",
      surface: "text-generation",
      transport:
        "openai (openai-compatible) provider chat-completions streaming (the subagent-role model's own client)",
      externalExecution:
        "the configured subagent-role provider endpoint (undelegated)",
      materiality:
        "discovered auxiliary seam: the Subagent tool's child sessions over a separately configured model client",
    },
    {
      edgeId: "continue.core.edit.inline-edit",
      component:
        'core/edit/streamDiffLines.ts:77 with payload type "edit" (constructEditPrompt:31, gptEditPrompt) → recursiveStream → BaseLLM.streamChat',
      surface: "text-generation",
      transport: "the edit-role model over the openai provider chat-completions transport",
      externalExecution: "the configured edit-role provider endpoint (undelegated)",
      materiality: "discovered editor-role seam: the Cmd+K-style inline edit path",
    },
    {
      edgeId: "continue.core.apply.fast-apply",
      component:
        'core/edit/streamDiffLines.ts:77 with payload type "apply" (constructApplyPrompt:43, defaultApplyPrompt) — and core/edit/lazy/{applyCodeBlock,streamLazyApply}.ts riding the same apply-role model',
      surface: "text-generation",
      transport: "the apply-role model over the openai provider chat-completions transport",
      externalExecution: "the configured apply-role provider endpoint (undelegated)",
      materiality: "discovered apply-role seam: the fast-apply code-rewrite surface",
    },
    {
      edgeId: "continue.core.autocomplete.tab",
      component:
        "core/autocomplete/CompletionProvider.ts:150 provideInlineCompletionItems → CompletionStreamer → BaseLLM.streamComplete → core/llm/llms/OpenAI.ts:423 _legacystreamComplete → POST {apiBase}/completions",
      surface: "text-generation",
      transport: "the autocomplete-role model over the legacy text-completions endpoint",
      externalExecution: "the configured autocomplete-role provider endpoint (undelegated)",
      materiality: "discovered autocomplete seam: the tab-completion engine's model call",
    },
    {
      edgeId: "continue.core.indexing.embed",
      component:
        "core/llm/index.ts BaseLLM.embed → packages/openai-adapters/src/apis/OpenAI.ts:230 (openai.embeddings.create) → POST {apiBase}/embeddings; consumed by core/indexing/CodebaseIndexer.ts per chunk",
      surface: "embeddings",
      transport: "the embed-role model over the OpenAI-format embeddings endpoint",
      externalExecution: "the configured embed-role provider endpoint (undelegated)",
      materiality: "discovered embedding seam: the codebase-indexer's vector call",
    },
    {
      edgeId: "continue.core.retrieval.rerank",
      component:
        "core/context/retrieval/pipelines/RerankerRetrievalPipeline.ts:98 → core/llm/index.ts:1378 BaseLLM.rerank → packages/openai-adapters/src/apis/OpenAI.ts:239 → POST {apiBase}/rerank",
      surface: "reranking",
      transport: "the rerank-role model over the OpenAI-format rerank endpoint",
      externalExecution: "the configured rerank-role provider endpoint (undelegated)",
      materiality: "discovered reranker seam: the retrieval pipelines' relevance scoring",
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

export const CONTINUE_DORMANT_SEAMS: readonly DormantSeamDisclosure[] = [
  {
    edgeId: "continue.role.summarize",
    component:
      'packages/config-yaml/src/schemas/models.ts modelRolesSchema includes "summarize"; core/config/yaml/loadYaml.ts:296 populates modelsByRole.summarize',
    surface: "text-generation",
    gate:
      "the summarize role is schema-only at the pinned revision — core/config/selectedModels.ts:26 records \"// summarize not implemented yet\" and no consumer reads modelsByRole/selectedModelByRole.summarize; the CLI's auto-compaction (extensions/cli/src/compaction.ts) rides the CHAT-role client through the declared chat edge. Disclosed as an upstream implementation state, never a hidden edge.",
  },
  {
    edgeId: "continue.core.next-edit",
    component:
      "core/nextEdit/* (the Next Edit predictor: core.ts nextEdit/predict handler → EditAggregator → prediction model)",
    surface: "text-generation",
    gate:
      "the nextEdit surface is an experimental IDE feature the declared corpus does not enable (no nextEdit model role configured; the core role corpus drives the autocomplete engine, not the nextEdit chain)",
  },
  {
    edgeId: "continue.core.docs-crawl",
    component:
      "core/indexing/docs/* (DocsService + docs crawlers; site indexing summarization over the chat-model client)",
    surface: "text-generation",
    gate:
      "no docs entries in the declared corpus config (config.yaml docs: []); docs crawling additionally requires network fetches the certified environment denies",
  },
  {
    edgeId: "continue.core.mcp-servers",
    component:
      "core/context/mcp/* (MCP server connections — external tool/data servers, each potentially its own AI-backed service)",
    surface: "agent-delegation",
    gate:
      "no mcpServers in the declared corpus config; the MCP manager holds zero connections (disclosed as the config gate — an MCP server would be an application-side tool integration to inventory separately)",
  },
  {
    edgeId: "continue.hub.remote-models",
    component:
      "packages/config-yaml/src/registryClient.ts + core/config ConfigHandler (hub `use:` references, assistant slugs, remote model fetching from hub.continue.dev / api.continue.dev)",
    surface: "text-generation",
    gate:
      "the declared corpus config is fully local (no use:/slug references — every model is an explicit local entry); the certified environment's egress control denies the hub endpoints anyway (the version-check call the CLI does make is denied and swallowed by its own catch)",
  },
  {
    edgeId: "continue.embed.transformers-js",
    component:
      "core/llm/llms/TransformersJsEmbeddingsProvider.ts (the bundled local ONNX embeddings provider)",
    surface: "embeddings",
    gate:
      "auto-added to the embed role only when the IDE info reports ideType \"vscode\" (core/config/yaml/loadYaml.ts:345); the headless corpus's IDE info is non-vscode, so the embed role resolves solely to the declared embed model — disclosed so the local-provider path is never silently confused with the delegated edge",
  },
  {
    edgeId: "continue.chat.vision-axis",
    component:
      "the chat-role client's multimodal content parts (image attachments in chat turns)",
    surface: "vision-image-understanding",
    gate:
      "the Continue CLI's headless mode attaches no images at this revision (no image-input flag on the pinned revision's headless path); the vision axis of the chat edge is therefore unexercised by the declared corpus (the adapter and rail carry vision routing if a future corpus exercises it) — disclosed, never silently narrowed",
  },
  {
    edgeId: "continue.cli.review-serve",
    component:
      "extensions/cli/src/commands/{review,serve}.ts (the review agents and the HTTP serve mode — separate model clients over the same config seam)",
    surface: "text-generation",
    gate:
      "the declared corpus invokes the chat command only (cn -p); review/serve are separate subcommands not exercised",
  },
  {
    edgeId: "continue.telemetry.otel",
    component:
      "extensions/cli/src/telemetry/* + core/data/log.ts (OTEL/PostHog/Amplitude analytics exporters)",
    surface: "text-generation",
    gate:
      "env-gated exporters (OTEL_EXPORTER_OTLP_* etc.) — the certified runtime's scrubbed allowlist environment carries none, and the egress control denies the telemetry endpoints (the default OTLP target is loopback and unreachable)",
  },
];

/**
 * The non-AI operations Continue retains as application/domain
 * capabilities (per PPR-021: "Preserve Continue's editor/UI/domain
 * responsibilities") — each verified to make NO model call of its own
 * at the pinned revision.
 */
export const CONTINUE_NON_AI_OPERATIONS: readonly {
  readonly name: string;
  readonly note: string;
}[] = [
  {
    name: "the Bash tool (extensions/cli/src/tools/runTerminalCommand.ts)",
    note: "local terminal command execution; no AI provider call (the decision to run a command comes from the delegated chat-role edge)",
  },
  {
    name: "the Read/Write/Edit/MultiEdit file tools",
    note: "local file reads and deterministic find-and-replace edits (core/edit/searchAndReplace) — no AI provider call inside the tool itself",
  },
  {
    name: "the List/Search tools + tree-sitter parsing",
    note: "local directory listing, code search and syntax parsing; no AI provider call",
  },
  {
    name: "git operations + diff generation",
    note: "workspace/repository domain operations (myers diff, git commit-signature tooling); no AI provider call",
  },
  {
    name: "session persistence + local token counting + the local index stores",
    note: "local sqlite/JSON state, tiktoken-style counting and the FTS5/LanceDB index files — local computation around the delegated embed edge",
  },
];
