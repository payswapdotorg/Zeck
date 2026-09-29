/**
 * The PPR-020 declared execution graph for pinned OpenHands plus the
 * DISCOVERED edge inventory the static no-bypass reconciliation runs
 * against.
 *
 * UPSTREAM PIN PROVENANCE (the structural finding this work order's
 * execution surfaced, recorded honestly):
 *
 *  - The work-order-named upstream repository
 *    https://github.com/payswapdotorg/../All-Hands-AI/OpenHands at its
 *    pinned revision v1.24.0 (7dc6805406ea3c76cb4a3ce407c3c72d481b0ac6)
 *    is **OpenHands Agent Canvas** — the self-hosted developer control
 *    center for coding agents. At that revision the repository no longer
 *    contains the Python agent: the OpenHands agent (the litellm-based
 *    completion layer, the agent loop, the condenser, the skills/knowledge
 *    system and the agent tools) lives in the agent repository
 *    https://github.com/OpenHands/software-agent-sdk, released as the
 *    `openhands-agent-server` / `openhands-sdk` / `openhands-tools`
 *    packages. Agent Canvas v1.24.0's own `config/defaults.json` pins
 *    agentServer **1.49.6** — the out-of-the-box OpenHands agent the
 *    canvas distribution runs.
 *  - The application under proof for the declared coding-agent corpus is
 *    therefore the OpenHands agent at the EXACT revision the distribution
 *    pins: software-agent-sdk **v1.49.6**
 *    (fcc102a697874d54a357e36004e02c95040dbdc0), installed verbatim
 *    (editable, from the tagged checkout) in a dedicated venv. The Agent
 *    Canvas pin is recorded here as provenance; the corpus runs the agent
 *    through its own public SDK surface (the same surface
 *    examples/01_standalone_sdk/*.py documents), not through the canvas
 *    UI. This is classified as a discovered structural fact about the
 *    upstream distribution, not an integration gap.
 *
 * DECLARED EDGES (the material AI-execution seams the declared corpus
 * exercises; every one is delegated through Zeck by the certified
 * adapter — see ../adapter/edges.ts for request→edge attribution):
 *
 *  - openhands.agent-loop.main     the primary agent-loop LLM call
 *                                  (openhands/sdk/agent/agent.py `_step`
 *                                  → llm.generate → litellm chat
 *                                  completions): every tool decision
 *                                  (terminal commands, file edits, task
 *                                  tracking, finish) is produced by this
 *                                  seam
 *  - openhands.agent-loop.vision   agent-loop turns carrying image
 *                                  content parts (SDK ImageContent
 *                                  attachments inlined to multimodal
 *                                  content parts)
 *  - openhands.condenser.llm-summarize  the LLMSummarizingCondenser
 *                                  summarization call (its own LLM object
 *                                  — an auxiliary model client)
 *  - openhands.subagent.task-loop  sub-agent conversation loops spawned
 *                                  by the task/delegation tool set
 *                                  (TaskToolSet → TaskManager →
 *                                  parent-LLM copy → a full sub-agent
 *                                  Agent loop)
 *  - openhands.tool.ask-oracle     the ask_oracle tool's stateless
 *                                  consult of the saved `oracle` LLM
 *                                  profile (a separate auxiliary model
 *                                  client resolved from the profile
 *                                  store)
 *
 * DORMANT SEAMS AT THE PINNED REVISION (inventoried from the pinned
 * source, disclosed in the evidence record's dormantEdgeDisclosures —
 * NOT reachable under the declared corpus configuration, never silently
 * ignored): the browser-use tool set (browser actuation; requires a
 * browser-use browser environment not present in this proof sandbox),
 * the tom_consult tool (the external `tom_swe` package's own LLM
 * client, configured solely through tool params), the API-based critic
 * (an external vLLM /classify HTTP service with its own credentials),
 * the ToolShield LLM security analyzer, the GraySwan analyzer, the
 * Laminar/OTEL observability exporter (env-gated), prompt/agent hooks,
 * the classify-and-switch / switch-LLM builtin tools, the vision-inspect
 * builtin (separate saved vision profile), the goal judge and ask-agent
 * SDK seams, and the agent-server's auto-title/profile-validation
 * conveniences (server-mode only; the corpus runs the in-process SDK).
 *
 * NON-AI OPERATIONS (disclosed, outside the completeness criterion per
 * PPR-020: "Preserve OpenHands domain/runtime ownership of workspace,
 * agent loop [orchestration], terminal, repository and sandbox
 * semantics"): terminal command execution (the subprocess backend),
 * file_editor/apply_patch file operations, task tracking, git
 * operations, skill/plugin keyword+path trigger matching (purely
 * deterministic at this revision — no LLM, no embeddings), the
 * marketplace/plugin git fetches (network, not AI), tree-sitter parsing
 * and local token counting, LiteLLM's local cost-table lookups.
 */

import type {
  ApplicationExecutionGraph,
  DiscoveredEdgeInventory,
  ExecutionGraphEdge,
} from "../../../src/integrations/compatibility/public";

/** The pinned upstream revisions this graph was inventoried against. */
export const OPENHANDS_UPSTREAM_REVISION = "fcc102a697874d54a357e36004e02c95040dbdc0";
export const OPENHANDS_UPSTREAM_REPOSITORY = "https://github.com/OpenHands/software-agent-sdk";
/** The distribution pin (Agent Canvas v1.24.0 — provenance, disclosed). */
export const OPENHANDS_DISTRIBUTION_REVISION = "7dc6805406ea3c76cb4a3ce407c3c72d481b0ac6";
export const OPENHANDS_DISTRIBUTION_REPOSITORY = "https://github.com/All-Hands-AI/OpenHands";
export const OPENHANDS_DISTRIBUTION_NOTE =
  "Agent Canvas v1.24.0 (the work-order-named upstream repository at the pinned revision) " +
  "distributes the OpenHands agent as agent-server 1.49.6 via its config/defaults.json; the " +
  "agent repository tag v1.49.6 is the pinned application under proof";

/** Every edge id the PPR-020 integration declares (the closed set). */
export const OPENHANDS_EDGE_IDS = [
  "openhands.agent-loop.main",
  "openhands.agent-loop.vision",
  "openhands.condenser.llm-summarize",
  "openhands.subagent.task-loop",
  "openhands.tool.ask-oracle",
] as const;

export type OpenHandsEdgeId = (typeof OPENHANDS_EDGE_IDS)[number];

/** The declared application execution graph (ACR-006 §1). */
export const OPENHANDS_EXECUTION_GRAPH: ApplicationExecutionGraph = {
  edges: [
    {
      edgeId: "openhands.agent-loop.main",
      component:
        "openhands.sdk.agent.Agent._step (agent/agent.py:728 llm.generate) → openhands.sdk.llm.LLM.completion (llm/llm.py:1648) → litellm completion (llm/llm.py:2427)",
      surface: "text-generation",
      transport: "litellm OpenAI-compatible chat completions (native tool calls, non-streaming)",
      externalExecution:
        "the configured LLM provider chat-completions endpoint (undelegated: e.g. api.openai.com/v1/chat/completions)",
      materiality:
        "the primary agent-loop model call: every tool decision (terminal execution, file edits, task tracking, finish) and every spawned sub-agent loop completion is produced through this seam — routing only a 'chat model' and leaving this seam direct would leave the application's whole agentic surface provider-owned",
    },
    {
      edgeId: "openhands.agent-loop.vision",
      component:
        "openhands.sdk.agent.Agent._step with ImageContent attachments (SDK image inlining, llm/utils/image_inline.py) → the same LLM.completion seam",
      surface: "vision-image-understanding",
      transport: "litellm OpenAI-compatible chat completions with multimodal content parts",
      externalExecution:
        "the configured provider's vision-capable chat-completions endpoint (undelegated)",
      materiality:
        "agent-loop turns carrying image content parts (browser screenshots, user image attachments) invoke the provider's vision surface — a text-only delegation would leave the vision edge a direct-provider bypass",
    },
    {
      edgeId: "openhands.condenser.llm-summarize",
      component:
        "openhands.sdk.context.condenser.llm_summarizing_condenser.LLMSummarizingCondenser._generate_condensation (:229, its own llm field) → LLM.generate → litellm completion",
      surface: "text-generation",
      transport: "litellm OpenAI-compatible chat completions (the condenser's own LLM object, stream force-disabled)",
      externalExecution:
        "the configured LLM provider chat-completions endpoint (the condenser summarizer's own model call, undelegated)",
      materiality:
        "the LLMSummarizingCondenser summarizes conversation history through its OWN LLM object (a distinct auxiliary edge) — leaving an auxiliary/summarizer call direct is exactly the 'main model only' incompleteness ACR-006 forbids",
    },
    {
      edgeId: "openhands.subagent.task-loop",
      component:
        "openhands.tools.task TaskToolSet → TaskManager._get_sub_agent_from_factory (task/manager.py:361 parent_llm.model_copy) → a full sub-agent Agent loop → agent.py:728 llm.generate",
      surface: "text-generation",
      transport: "litellm OpenAI-compatible chat completions (the sub-agent's system prompt is the agent-definition markdown)",
      externalExecution:
        "the configured LLM provider chat-completions endpoint (the sub-agent loop's own model calls, undelegated)",
      materiality:
        "the task/delegation tool set spawns sub-agent conversations that make their own agent-loop model calls (inheriting the parent LLM by default) — a sub-agent loop that stayed direct would leave delegated execution provider-owned",
    },
    {
      edgeId: "openhands.tool.ask-oracle",
      component:
        "openhands.tools.ask_oracle.impl.AskOracleExecutor (:98 oracle_llm.generate, the saved `oracle` profile resolved from the LLMProfileStore) → LLM.generate → litellm completion",
      surface: "text-generation",
      transport: "litellm OpenAI-compatible chat completions (a separate stateless auxiliary model client)",
      externalExecution:
        "the oracle profile's configured provider endpoint (undelegated)",
      materiality:
        "the ask-oracle tool consults a SEPARATE saved LLM profile (its own model/api_key/base_url in the profile store) — an auxiliary model client outside the main loop that would silently bypass a main-model-only delegation",
    },
  ],
};

/**
 * The DISCOVERED edge inventory: the static seam scan of the pinned
 * revision, restricted to the in-process standalone-SDK runtime and the
 * declared corpus configuration (headless Agent runs with the terminal
 * (subprocess backend), file_editor, task_tracker, ask_oracle and
 * task_tool_set tools; no agent-server process, no browser environment,
 * no external ACP agents, no critic, no security analyzer, no hooks, no
 * observability env vars).
 *
 * The scan enumerated every LLM-call seam (litellm completion/acompletion/
 * responses/aresponses call sites + every construction of an LLM object
 * with its own configuration) reachable under that configuration; each
 * discovered edge is claimed by exactly one declared edge (reconciled by
 * the component+surface+external chain).
 */
export const OPENHANDS_DISCOVERED_INVENTORY: DiscoveredEdgeInventory = {
  source:
    "static seam scan of pinned OpenHands software-agent-sdk v1.49.6 (fcc102a697874d54a357e36004e02c95040dbdc0; litellm call-site + LLM-object-construction grep, in-process SDK reachability restricted to the declared corpus configuration)",
  edges: [
    {
      edgeId: "openhands.agent-loop.main",
      component:
        "openhands-sdk/openhands/sdk/agent/agent.py:728 (llm.generate in _step) via llm/llm.py:1648 completion → llm/llm.py:2427 litellm_completion",
      surface: "text-generation",
      transport: "litellm OpenAI-compatible chat completions (native tool calls)",
      externalExecution:
        "the configured LLM provider chat-completions endpoint (undelegated: e.g. api.openai.com/v1/chat/completions)",
      materiality:
        "discovered agent-loop seam: every tool decision, every sub-agent loop completion, every follow-up turn",
    },
    {
      edgeId: "openhands.agent-loop.vision",
      component:
        "openhands-sdk/openhands/sdk/agent/agent.py:728 with ImageContent attachments inlined by llm/utils/image_inline.py into multimodal content parts",
      surface: "vision-image-understanding",
      transport: "litellm OpenAI-compatible chat completions with multimodal content parts",
      externalExecution:
        "the configured provider's vision-capable chat-completions endpoint (undelegated)",
      materiality:
        "discovered vision seam: image content parts ride the same agent-loop call site into the provider's vision surface",
    },
    {
      edgeId: "openhands.condenser.llm-summarize",
      component:
        "openhands-sdk/openhands/sdk/context/condenser/llm_summarizing_condenser.py:229 (self.llm.generate in _generate_condensation; the condenser's own llm field, usage_id 'condenser')",
      surface: "text-generation",
      transport: "litellm OpenAI-compatible chat completions (the summarization prompt template prompts/summarizing_prompt.j2)",
      externalExecution:
        "the configured LLM provider chat-completions endpoint (the condenser summarizer's own model call, undelegated)",
      materiality:
        "discovered auxiliary seam: the LLMSummarizingCondenser's own model call (a separately-configurable LLM object)",
    },
    {
      edgeId: "openhands.subagent.task-loop",
      component:
        "openhands-tools/openhands/tools/task/manager.py:361-378 (parent_llm.model_copy → agent factory → sub-agent conversation.run → agent.py:728), the same path WorkflowTool scripts drive (workflow/impl.py:88-115)",
      surface: "text-generation",
      transport: "litellm OpenAI-compatible chat completions (sub-agent system prompt = the agent-definition markdown)",
      externalExecution:
        "the configured LLM provider chat-completions endpoint (the sub-agent loop's model calls, undelegated)",
      materiality:
        "discovered sub-agent seam: the task/delegation tool set's full sub-agent loops (LLM inherited from the parent by default; agent definitions with model: != inherit would load a separate profile — disclosed)",
    },
    {
      edgeId: "openhands.tool.ask-oracle",
      component:
        "openhands-tools/openhands/tools/ask_oracle/impl.py:98 (oracle_llm.generate — the saved 'oracle' profile from the LLMProfileStore, resolved via conversation.get_or_create_profile_llm)",
      surface: "text-generation",
      transport: "litellm OpenAI-compatible chat completions (stateless: fixed Oracle system prompt + the question, no history, no tools)",
      externalExecution:
        "the oracle profile's configured provider endpoint (undelegated)",
      materiality:
        "discovered auxiliary model client: a separate profile-backed LLM outside the main loop",
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

export const OPENHANDS_DORMANT_SEAMS: readonly DormantSeamDisclosure[] = [
  {
    edgeId: "openhands.tool.browser-use",
    component:
      "openhands-tools/openhands/tools/browser_use (BrowserToolSet → CustomBrowserUseServer primitives; observations returned to the main agent loop as TextContent/ImageContent)",
    surface: "browser-use-intelligence",
    gate:
      "the browser tool set requires a browser-use browser environment (CDP-driven chromium + the browser-use extension); the declared corpus does not enable browser tools and the proof sandbox provides no browser — the tool constructs NO separate LLM client at this revision (all intelligence rides the main agent-loop seam, disclosed as an inventory finding)",
  },
  {
    edgeId: "openhands.tool.tom-consult",
    component:
      "openhands-tools/openhands/tools/tom_consult/executor.py:74-82 (create_tom_agent from the external tom_swe package — its own LLM client, configured solely through tool params llm_model/api_key/api_base)",
    surface: "text-generation",
    gate:
      "the tom_consult / sleeptime_compute tools are not in the declared corpus tool set; the external ToM agent's LLM is a second AI client path that does not honor the SDK LLM(base_url=...) seam (inventoried as a disclosed second-client seam of the pinned revision)",
  },
  {
    edgeId: "openhands.critic.api",
    component:
      "openhands-sdk/openhands/sdk/critic/impl/api/client.py:262-299 (httpx POST {server_url}/classify with its own Bearer api_key — an external vLLM classification service, not litellm)",
    surface: "text-generation",
    gate:
      "Agent(critic=APIBasedCritic(...)) is not configured for the declared corpus (the default Agent critic is None); the critic's default endpoint is an OpenHands-hosted service",
  },
  {
    edgeId: "openhands.security.toolshield-guardrail",
    component:
      "openhands-sdk/openhands/sdk/security/toolshield_llm_analyzer.py:479 (a dedicated guardrail LLM object per action)",
    surface: "text-generation",
    gate:
      "a security analyzer is attached only via conversation.set_security_analyzer(...); the declared corpus attaches none",
  },
  {
    edgeId: "openhands.security.grayswan",
    component:
      "openhands-sdk/openhands/sdk/security/grayswan/analyzer.py (external Cygnal HTTP API, GRAYSWAN_API_KEY)",
    surface: "text-generation",
    gate: "external security-analyzer service; not configured for the declared corpus",
  },
  {
    edgeId: "openhands.observability.laminar",
    component:
      "openhands-sdk/openhands/sdk/observability/laminar.py (LMNR/OTEL trace export initialized at import of openhands.sdk.agent)",
    surface: "text-generation",
    gate:
      "activates only when LMNR_PROJECT_API_KEY / OTEL_* env vars are present; the certified runtime's scrubbed allowlist environment carries none (scrubbed by construction)",
  },
  {
    edgeId: "openhands.hooks.prompt-agent",
    component:
      "openhands-sdk/openhands/sdk/hooks/executor.py:260-361 (prompt-type hook LLM calls and full agent-type hook sub-conversations)",
    surface: "text-generation",
    gate: "Conversation(hook_config=...) is not configured for the declared corpus",
  },
  {
    edgeId: "openhands.builtin.classify-and-switch-llm",
    component:
      "openhands-sdk/openhands/sdk/tool/builtins/classify_and_switch_llm.py:346 (classifier_llm.completion — a saved classifier profile) + switch_llm.py (profile switching)",
    surface: "text-generation",
    gate:
      "the classify-and-switch builtin is disabled by default (enable_classify_and_switch_llm_tool=False); the declared corpus does not enable it",
  },
  {
    edgeId: "openhands.builtin.vision-inspect",
    component:
      "openhands-sdk/openhands/sdk/tool/builtins/vision_inspect.py:249 (vision_llm.generate — a saved vision profile, auto-attached only when the main model is non-vision)",
    surface: "vision-image-understanding",
    gate:
      "the declared corpus declares a vision-capable main model (capability_overrides), so the vision-inspect builtin is never auto-attached; image content rides the main agent-loop vision edge instead",
  },
  {
    edgeId: "openhands.goal.judge + openhands.conversation.ask-agent",
    component:
      "openhands-sdk/openhands/sdk/conversation/goal/judge.py:65 (judge_llm.completion) and local_conversation.py:2910 (question_llm.generate)",
    surface: "text-generation",
    gate:
      "the goal-controller driver and the ask-agent API are explicit-call SDK seams; the declared corpus issues neither",
  },
  {
    edgeId: "openhands.agent-server.autotitle",
    component:
      "openhands-agent-server/openhands/agent_server/conversation_service.py:2659-2714 (AutoTitleSubscriber → title_utils.py:145 llm.generate; default ON in server mode) + profiles_router.py:327-330 (profile pre-flight validation)",
    surface: "text-generation",
    gate:
      "the agent-server process is not part of the declared corpus runtime (the corpus runs the in-process standalone SDK, where LocalConversation has no auto-title); disclosed as the server-mode-only convenience seam",
  },
  {
    edgeId: "openhands.agent.acp",
    component:
      "openhands-sdk/openhands/sdk/agent/acp_agent.py (external ACP agent CLI subprocess owning its own LLM; the SDK holds a sentinel dummy LLM)",
    surface: "text-generation",
    gate:
      "ACPAgent runs external agent CLIs (Codex/Claude Code); the declared corpus constructs the in-process Agent, never ACPAgent",
  },
  {
    edgeId: "openhands.llm.fallback-profiles",
    component:
      "openhands-sdk/openhands/sdk/llm/fallback_strategy.py:63-118 (fallback profiles loaded from the LLMProfileStore on transient primary failure)",
    surface: "text-generation",
    gate:
      "LLM(fallback_strategy=...) is opt-in; the declared corpus configures no fallback profiles (the Zeck side owns policy-permitted retry for the delegated edge — the rail worker's bounded retry)",
  },
];

/**
 * The non-AI operations OpenHands retains as application/domain
 * capabilities (PPR-020: "Preserve OpenHands domain/runtime ownership of
 * workspace, agent loop, terminal, repository and sandbox semantics") —
 * each verified to make NO model call of its own at the pinned revision.
 */
export const OPENHANDS_NON_AI_OPERATIONS: readonly {
  readonly name: string;
  readonly note: string;
}[] = [
  {
    name: "terminal (subprocess backend command execution)",
    note: "local shell command execution (the terminal tool's own subprocess backend); no AI provider call (the decision to run a command comes from the delegated agent-loop edge)",
  },
  {
    name: "file_editor / apply_patch / glob / grep (filesystem)",
    note: "local file operations and code search; no AI provider call",
  },
  {
    name: "task_tracker (task state)",
    note: "local task-state bookkeeping; no AI provider call",
  },
  {
    name: "skills / plugins / marketplace trigger system",
    note: "purely deterministic at the pinned revision: keyword (whole-token, case-insensitive) and gitignore-style path triggers — repo-wide scan found no embeddings, reranking or semantic-search call; marketplace/plugin fetching is git clone (network, not AI)",
  },
  {
    name: "git operations / workspace management",
    note: "workspace and repository domain operations; no AI provider call",
  },
  {
    name: "tree-sitter parsing / local token counting / LiteLLM local cost table",
    note: "local computation (LITELLM_LOCAL_MODEL_COST_MAP=True keeps cost lookups local); no AI provider call",
  },
];
