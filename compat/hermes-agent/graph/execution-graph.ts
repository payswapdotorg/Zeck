/**
 * The PPR-022 declared execution graph for pinned Hermes-Agent plus the
 * DISCOVERED edge inventory the static no-bypass reconciliation runs
 * against.
 *
 * UPSTREAM PIN PROVENANCE (recorded honestly):
 *
 *  - The work-order-named target "Hermes-Agent" is the autonomous/general
 *    agent by Nous Research: https://github.com/NousResearch/hermes-agent
 *    ("The agent that grows with you"). The target matrix's observed seam
 *    ("provider registry/shared runtime plus auxiliary call paths") is the
 *    repository's `providers/` profile registry + `agent/auxiliary_client.py`
 *    shared auxiliary router (the text auto chain: main provider →
 *    OpenRouter → Nous Portal → custom endpoint → native Anthropic → direct
 *    API-key providers → None — the fragmented auxiliary surface this Wave 2
 *    proof must not leave bypassing).
 *  - The pinned upstream revision is 77e2992020efded09e0c344e687ae53e52e6eab
 *    (origin/main at proof-time clone; tag rc.30-v0.21.5 + 23 commits; the
 *    runtime's own `hermes --version` reports "vgit.77e2992"). It is
 *    installed EDITABLE from the exact checkout into a dedicated Python
 *    3.14.7 venv (the version its exact-pinned dependency closure targets).
 *
 * DECLARED EDGES (the material AI-execution seams the declared corpus
 * exercises; every one is delegated through Zeck by the certified adapter —
 * see ../adapter/edges.ts for request→edge attribution):
 *
 *  - hermes.agent-loop.main          the primary agent conversation turn
 *                                    (run_agent.AIAgent → providers
 *                                    chat_completions → openai SDK →
 *                                    POST {base}/chat/completions): every
 *                                    tool decision (terminal, file ops,
 *                                    todo, finish) and every one-shot `-z`
 *                                    turn is produced through this seam
 *  - hermes.auxiliary.title-generation  the automatic session-title model
 *                                    call (hermes_state_titles → aux
 *                                    task `title_generation`, its own
 *                                    fixed "You name chat sessions."
 *                                    prompt + session_title json_schema)
 *  - hermes.auxiliary.compression   the context-compression summarizer
 *                                    (agent/context_compressor.py → aux
 *                                    task `compression`, its own
 *                                    "You are a summarization agent
 *                                    creating a context checkpoint."
 *                                    prompt — a distinct auxiliary client)
 *  - hermes.auxiliary.vision-analyze the vision_analyze tool's auxiliary
 *                                    vision model call (tools/vision_tools
 *                                    legacy path: "Fully describe and
 *                                    explain everything about this image"
 *                                    + image content parts → aux task
 *                                    `vision`), taken when the main
 *                                    provider profile does not declare
 *                                    native vision (the custom endpoint's
 *                                    case at the pinned revision)
 *  - hermes.tool.tts-openai         the text_to_speech tool's
 *                                    OpenAI-compatible speech backend
 *                                    (tools/tts_tool_openai.py → openai
 *                                    SDK audio.speech.create → POST
 *                                    {base}/audio/speech; the shared
 *                                    tts.openai.{api_key,base_url}
 *                                    resolution also serves STT)
 *  - hermes.tool.stt-openai         the voice-memo transcription surface's
 *                                    OpenAI-compatible backend
 *                                    (tools/transcription_cloud.py
 *                                    `_transcribe_openai` → openai SDK
 *                                    audio.transcriptions.create → POST
 *                                    {base}/audio/transcriptions — the
 *                                    same surface the gateway's inbound
 *                                    voice-memo path dispatches through)
 *  - hermes.tool.image-generate-openai  the image_generate tool's
 *                                    OpenAI-compatible image backend
 *                                    (plugins/image_gen/openai → openai
 *                                    SDK images.generate → POST
 *                                    {base}/images/generations; selected
 *                                    through the app's own
 *                                    image_gen.provider picker key)
 *
 * DORMANT SEAMS AT THE PINNED REVISION (inventoried and disclosed, never
 * silently ignored — each with the configuration gate that keeps it
 * unreachable under the declared corpus): see HERMES_DORMANT_SEAMS below.
 *
 * NON-AI OPERATIONS (disclosed, outside the completeness criterion per the
 * work order: "Preserve Hermes's own agent/runtime/tool domain
 * responsibilities. A specialized tool is not automatically an AI edge"):
 * see HERMES_NON_AI_OPERATIONS below.
 */

import type {
  ApplicationExecutionGraph,
  DiscoveredEdgeInventory,
  ExecutionGraphEdge,
} from "../../../src/integrations/compatibility/public";

/** The pinned upstream revisions this graph was inventoried against. */
export const HERMES_UPSTREAM_REPOSITORY = "https://github.com/NousResearch/hermes-agent";
export const HERMES_UPSTREAM_REVISION = "77e2992020afded09e0c344e687ae53e52e6eab";
/** The pinned runtime's own version report (recorded at install time). */
export const HERMES_UPSTREAM_VERSION = "Hermes Agent vgit.77e2992 (2026.9.24) · upstream 77e29920";
/** Where the pinned venv lives (the demo entry's reproducibility instructions rebuild it). */
export const HERMES_VENV = "/home/z/my-project/.venv-hermes" as const;

/** Every edge id the PPR-022 integration declares (the closed set). */
export const HERMES_EDGE_IDS = [
  "hermes.agent-loop.main",
  "hermes.auxiliary.title-generation",
  "hermes.auxiliary.compression",
  "hermes.auxiliary.vision-analyze",
  "hermes.tool.tts-openai",
  "hermes.tool.stt-openai",
  "hermes.tool.image-generate-openai",
] as const;

export type HermesEdgeId = (typeof HERMES_EDGE_IDS)[number];

/** The declared application execution graph (ACR-006 §1). */
export const HERMES_EXECUTION_GRAPH: ApplicationExecutionGraph = {
  edges: [
    {
      edgeId: "hermes.agent-loop.main",
      component:
        "run_agent.AIAgent conversation loop (run_agent.py) → providers chat_completions api_mode → openai SDK client → POST {base_url}/chat/completions (model.provider=custom resolves the certified runtime's one endpoint)",
      surface: "text-generation",
      transport:
        "OpenAI-compatible chat completions (native tool calls, streaming SSE preferred by the runtime, response_format/reasoning_effort axes tolerated)",
      externalExecution:
        "the configured provider's chat-completions endpoint (undelegated: e.g. api.openai.com/v1/chat/completions, openrouter.ai/api/v1/chat/completions)",
      materiality:
        "the primary agent-loop model call: every tool decision (terminal execution, file operations, todo tracking, finish) in the one-shot corpus runs is produced through this seam — routing only a 'chat model' and leaving this seam direct would leave the application's whole agentic surface provider-owned",
    },
    {
      edgeId: "hermes.auxiliary.title-generation",
      component:
        "hermes_state_titles auto-title upgrade (aux task title_generation) → agent/auxiliary_client.call_llm → the resolved auxiliary chain's OpenAI-compatible client → POST {base}/chat/completions",
      surface: "text-generation",
      transport:
        "OpenAI-compatible chat completions (fixed system prompt 'You name chat sessions.' + session_title json_schema response_format; a separately-configurable auxiliary provider/model pair)",
      externalExecution:
        "the auxiliary chain's configured provider endpoint (undelegated: by default Gemini Flash via OpenRouter or Nous Portal — exactly the fragmented auxiliary path the target matrix flags)",
      materiality:
        "the automatic session-title model call is an AUXILIARY client outside the main loop (its own provider/model resolution through the auto chain) — leaving any auxiliary chain rung direct is exactly the 'main model only' incompleteness ACR-006 forbids",
    },
    {
      edgeId: "hermes.auxiliary.compression",
      component:
        "agent/context_compressor.py _attempt_summary → _call_summary_llm → aux task compression (agent/auxiliary_client.call_llm) → POST {base}/chat/completions",
      surface: "text-generation",
      transport:
        "OpenAI-compatible chat completions (the fixed 'You are a summarization agent creating a context checkpoint.' prompt; aux task compression's own provider/model/timeout config)",
      externalExecution:
        "the auxiliary chain's configured provider endpoint (undelegated)",
      materiality:
        "context compression summarizes conversation history through the auxiliary client (a distinct, separately-fallback-capable model path) — an auxiliary summarizer left direct would silently bypass a main-model-only delegation",
    },
    {
      edgeId: "hermes.auxiliary.vision-analyze",
      component:
        "tools/vision_tools.py vision_analyze_tool (legacy path — the custom provider profile declares no native vision) → _media_messages(prompt, image_url, data URL) → aux task vision (agent/auxiliary_client) → POST {base}/chat/completions with image content parts",
      surface: "vision-image-understanding",
      transport:
        "OpenAI-compatible chat completions with multimodal content parts (the aux vision model's own provider/model resolution)",
      externalExecution:
        "the auxiliary vision chain's configured vision-capable provider endpoint (undelegated)",
      materiality:
        "the vision_analyze tool's image understanding rides a SEPARATE auxiliary vision model client (not the main loop) whenever the main provider does not declare native vision — a text-only delegation would leave the vision edge a direct-provider bypass",
    },
    {
      edgeId: "hermes.tool.tts-openai",
      component:
        "tools/tts_tool.py text_to_speech → tts provider selection 'openai' → tools/tts_tool_openai.py _generate_openai_tts → openai SDK audio.speech.create → POST {base}/audio/speech",
      surface: "speech-generation",
      transport:
        "OpenAI-compatible speech API (model/voice/input/speed/response_format; tts.openai.{api_key,base_url} — the shared audio-client resolution that also serves STT)",
      externalExecution:
        "the selected TTS provider's speech endpoint (undelegated: e.g. api.openai.com/v1/audio/speech; the unselected defaults are Edge TTS's Microsoft endpoint, ElevenLabs, xAI, MiniMax, Mistral, Gemini — each a direct external AI service)",
      materiality:
        "the text_to_speech tool is a specialized MEDIA path that constructs its own provider clients — a bypass until delegated (the work order's rule); the OpenAI-compatible backend is the one the certified configuration routes through the adapter",
    },
    {
      edgeId: "hermes.tool.stt-openai",
      component:
        "tools/transcription_tools.py transcribe_audio → stt provider selection 'openai' → tools/transcription_cloud.py _transcribe_openai → openai SDK audio.transcriptions.create (multipart) → POST {base}/audio/transcriptions",
      surface: "speech-recognition",
      transport:
        "OpenAI-compatible transcription API (multipart file + model; the same shared tts.openai.{api_key,base_url} audio-client resolution)",
      externalExecution:
        "the selected STT provider's transcription endpoint (undelegated: e.g. api.openai.com/v1/audio/transcriptions; unselected defaults are local faster-whisper, Groq, xAI, ElevenLabs, Mistral)",
      materiality:
        "the voice-memo transcription surface (the exact function the gateway dispatches inbound voice notes through) is a specialized MEDIA path with its own provider clients — a bypass until delegated",
    },
    {
      edgeId: "hermes.tool.image-generate-openai",
      component:
        "tools/image_generation_tool.py image_generate → image_gen provider selection 'openai' → plugins/image_gen/openai generate → openai SDK images.generate → POST {base}/images/generations",
      surface: "image-generation",
      transport:
        "OpenAI-compatible images API (model/prompt/size/n; image_gen.openai.{base_url,key_env} — the app's own image-generation picker surface)",
      externalExecution:
        "the selected image-gen provider's endpoint (undelegated: FAL.ai's queue API via fal-client with FAL_KEY, the Nous managed gateways, Krea, Meta AI, xAI; the OpenAI-compatible plugin is the custom-endpoint surface)",
      materiality:
        "the image_generate tool is a specialized MEDIA path whose default backends are direct external AI services (fal.ai et al.) — a bypass until delegated through the adapter",
    },
  ],
};

/**
 * The DISCOVERED edge inventory: the static seam scan of the pinned
 * revision, restricted to the declared corpus configuration (headless
 * `hermes -z` one-shot runs with the file/terminal/vision/tts/image_gen
 * toolsets; the transcribe_audio surface driven through its own module
 * entry; provider=custom for the main model; every auxiliary task pinned
 * provider=main; tts/stt/image_gen selections pinned to the openai backend
 * pointed at the adapter; no gateway process, no browser, no MCP servers,
 * no web search credentials, no video plugin, no computer-use driver).
 *
 * The scan enumerated every AI-client construction seam reachable under
 * that configuration (the openai-SDK client constructions in
 * agent/auxiliary_client.py, tools/tts_tool_openai.py,
 * tools/transcription_cloud.py, plugins/image_gen/*, and the main-loop
 * provider resolution in hermes_cli/runtime_provider.py); each discovered
 * edge is claimed by exactly one declared edge (reconciled by the
 * component+surface+external chain).
 */
export const HERMES_DISCOVERED_INVENTORY: DiscoveredEdgeInventory = {
  source:
    "static seam scan of pinned Hermes-Agent 77e2992020afded09e0c344e687ae53e52e6eab (openai-SDK client-construction + aux-task grep across agent/, tools/, plugins/, hermes_cli/; one-shot CLI reachability restricted to the declared corpus configuration)",
  edges: [
    {
      edgeId: "hermes.agent-loop.main",
      component:
        "hermes_cli/runtime_provider.py resolve_runtime_provider (rung 4 local-endpoint bypass for the loopback custom base_url) → run_agent.AIAgent turn loop → openai SDK chat.completions (streaming preferred)",
      surface: "text-generation",
      transport: "OpenAI-compatible chat completions (native tool calls)",
      externalExecution:
        "the configured provider's chat-completions endpoint (undelegated: e.g. api.openai.com/v1/chat/completions)",
      materiality:
        "discovered primary seam: every one-shot turn, every tool decision, every finish",
    },
    {
      edgeId: "hermes.auxiliary.title-generation",
      component:
        "hermes_state_titles.py title upgrade → agent/auxiliary_client.py call_llm(task='title_generation') → the aux chain (auto: main → OpenRouter → Nous Portal → custom) → openai SDK chat.completions",
      surface: "text-generation",
      transport: "OpenAI-compatible chat completions (session_title json_schema)",
      externalExecution:
        "the aux chain's provider endpoint (undelegated; default Gemini Flash via OpenRouter/Nous)",
      materiality:
        "discovered auxiliary seam: automatic after the first exchange of every session",
    },
    {
      edgeId: "hermes.auxiliary.compression",
      component:
        "agent/context_compressor.py _attempt_summary → _call_summary_llm → call_llm(task='compression') → the aux chain → openai SDK chat.completions",
      surface: "text-generation",
      transport: "OpenAI-compatible chat completions (the fixed checkpoint-summary prompt)",
      externalExecution: "the aux chain's provider endpoint (undelegated)",
      materiality:
        "discovered auxiliary seam: fires when prompt_tokens cross the compression threshold % of context_length",
    },
    {
      edgeId: "hermes.auxiliary.vision-analyze",
      component:
        "tools/vision_tools.py _handle_vision_analyze (legacy path; _should_use_native_vision_fast_path() is False for the custom provider profile) → vision_analyze_tool → async_call_llm(task='vision') with _media_messages image parts → openai SDK chat.completions",
      surface: "vision-image-understanding",
      transport: "OpenAI-compatible chat completions with multimodal content parts",
      externalExecution:
        "the aux vision chain's vision-capable provider endpoint (undelegated)",
      materiality:
        "discovered auxiliary vision seam: the vision_analyze tool's own model client outside the main loop",
    },
    {
      edgeId: "hermes.tool.tts-openai",
      component:
        "tools/tts_tool_openai.py _resolve_openai_audio_client_config (tts.openai.{api_key,base_url}) → _generate_openai_tts → openai SDK audio.speech.create → POST {base}/audio/speech",
      surface: "speech-generation",
      transport: "OpenAI-compatible speech API",
      externalExecution:
        "the selected TTS provider's speech endpoint (undelegated)",
      materiality:
        "discovered specialized media seam: the text_to_speech tool's own provider client",
    },
    {
      edgeId: "hermes.tool.stt-openai",
      component:
        "tools/transcription_cloud.py _transcribe_openai (api_key=None → _resolve_openai_audio_client_config — the SAME tts.openai resolution) → openai SDK audio.transcriptions.create → POST {base}/audio/transcriptions",
      surface: "speech-recognition",
      transport: "OpenAI-compatible transcription API (multipart)",
      externalExecution:
        "the selected STT provider's transcription endpoint (undelegated)",
      materiality:
        "discovered specialized media seam: the gateway voice-memo transcription surface's own provider client",
    },
    {
      edgeId: "hermes.tool.image-generate-openai",
      component:
        "plugins/image_gen/openai/__init__.py _resolve_endpoint (image_gen.openai.{base_url,key_env}) → _build_client → client.images.generate(model, prompt, size, n) → POST {base}/images/generations",
      surface: "image-generation",
      transport: "OpenAI-compatible images API",
      externalExecution:
        "the selected image-gen provider's endpoint (undelegated)",
      materiality:
        "discovered specialized media seam: the image_generate tool's own provider client (the in-tree default is FAL.ai direct with FAL_KEY)",
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

export const HERMES_DORMANT_SEAMS: readonly DormantSeamDisclosure[] = [
  {
    edgeId: "hermes.tool.web-search",
    component:
      "tools/web_tools.py web_search/web_extract + search_policy.py (provider backends: Exa, Firecrawl, Parallel, DuckDuckGo ddgs — each with its own API-key-gated direct HTTP clients)",
    surface: "search-ai-search",
    gate:
      "the declared corpus configures NO web-search credentials (scrubbed allowlist environment) and the proof environment's default-deny egress blocks every search endpoint; the corpus tasks never instruct web use. If it were exercised with credentials, this would be a DIRECT external AI-service path (a bypass) — it is therefore declared dormant under the corpus configuration, never silently ignored",
  },
  {
    edgeId: "hermes.auxiliary.web-extract",
    component:
      "tools/web_tools_extract.py web page summarization → aux task web_extract (agent/auxiliary_client) → the aux chain",
    surface: "text-generation",
    gate:
      "the aux web_extract task rides the SAME delegated auxiliary chain (pinned provider=main) when it fires; under the declared corpus no page extraction occurs (egress-denied, no web instructions) — the chain itself is delegated by configuration",
  },
  {
    edgeId: "hermes.tool.browser-suite",
    component:
      "tools/browser_*.py (Camofox/CDP/Lightpanda/cloud backends; browser_vision rides the aux vision chain, page-text extraction rides aux web_extract)",
    surface: "browser-use-intelligence",
    gate:
      "the browser toolset requires a browser environment this proof sandbox does not provide; the declared corpus enables no browser toolset. The suite's intelligence rides the delegated main/aux seams when used (no separate LLM client of its own beyond those seams) — actuation is application-owned",
  },
  {
    edgeId: "hermes.tool.computer-use",
    component: "tools/computer_use_tool.py (cua-driver desktop control)",
    surface: "computer-use-intelligence",
    gate:
      "requires a cua-driver desktop environment; not enabled in the declared corpus (headless one-shot runs). Its action decisions ride the delegated main agent loop — no separate model client",
  },
  {
    edgeId: "hermes.tool.mcp",
    component:
      "tools/mcp_tool*.py + mcp_serve.py (external MCP servers; server-initiated sampling handled by tools/mcp_tool_sampling.py which translates sampling/createMessage into the agent's own OpenAI-format turn — the delegated main seam)",
    surface: "text-generation",
    gate:
      "the declared corpus configures no MCP servers; the MCP sampling handler routes through the SAME delegated chat-completions seam when a server requests sampling (no separate provider client) — disclosed as configuration-gated, with the classification recorded",
  },
  {
    edgeId: "hermes.tool.video-generation",
    component:
      "tools/video_generation_tool.py video_generate → plugins/video_gen/{fal,openrouter,xai,deepinfra} (each with its own provider clients; the in-tree tool ships NO provider until a plugin is selected)",
    surface: "video-generation",
    gate:
      "the declared corpus selects no video-gen plugin (the picker surface `hermes tools` → Video Generation is unset). The sandbox's supply rail does expose a video surface, but the pinned runtime's OpenAI-compatible video plugin (deepinfra) speaks an async create/poll/download protocol whose translation through the delegation boundary was not built for this proof — an honest implementation gap recorded WITHOUT weakening completeness (video is not exercised by the declared corpus); owner: worker (a future work order may delegate it)",
  },
  {
    edgeId: "hermes.tool.video-analyze",
    component: "tools/vision_tools.py video_analyze (aux task video/vision chain)",
    surface: "vision-image-understanding",
    gate:
      "the declared corpus carries no video fixture and enables no video toolset; the aux chain it would ride is delegated by configuration",
  },
  {
    edgeId: "hermes.auxiliary.background-review",
    component:
      "agent/background_review.py post-turn memory/skill self-improvement fork → aux task background_review (its own provider/model pair)",
    surface: "text-generation",
    gate:
      "explicitly DISABLED in the certified corpus configuration (auxiliary.background_review.enabled: false) to keep one-shot runs deterministic — an application configuration axis, disclosed; when enabled it rides the same pinned aux chain (provider=main)",
  },
  {
    edgeId: "hermes.auxiliary.session-search",
    component:
      "tools/session_search_tool.py session_search (FTS5 discovery + anchored scroll over the state DB)",
    surface: "deterministic-computation",
    gate:
      "at the pinned revision the session_search tool is FTS5-only discovery/scroll with NO separate LLM summarization call (the auxiliary.session_search config key exists for the chain, but the tool's handler issues no model call — the agent reasons over returned rows through the main loop); classified NON-AI at this revision",
  },
  {
    edgeId: "hermes.gateway-platforms",
    component:
      "gateway/ inbound processing (Telegram/Discord/Slack/WhatsApp/Signal adapters, voice-memo transcription dispatch, auto-title per platform channel)",
    surface: "text-generation",
    gate:
      "the gateway process is not part of the declared corpus runtime (headless one-shot CLI runs); every AI surface it would dispatch (transcription, titles, agent turns) is the SAME seam set already declared and delegated — the platform adapters themselves are non-AI transport",
  },
  {
    edgeId: "hermes.tts-alternate-providers",
    component:
      "tools/tts_tool_providers.py (Edge TTS's Microsoft endpoint, ElevenLabs, xAI, MiniMax, Mistral, Gemini) + local NeuTTS/Piper/KittenTTS engines",
    surface: "speech-generation",
    gate:
      "the certified configuration selects tts.provider=openai (the delegated OpenAI-compatible backend); every alternate cloud provider is credential-gated (none present in the scrubbed runtime) and the local engines are offline synthesis (non-provider). Disclosed as the unselected direct-service paths of the specialized tool",
  },
  {
    edgeId: "hermes.stt-alternate-providers",
    component:
      "tools/transcription_cloud.py (Groq, xAI, ElevenLabs, Mistral REST backends) + local faster-whisper",
    surface: "speech-recognition",
    gate:
      "the certified configuration selects stt.provider=openai (the delegated backend); alternates are credential-gated or local-offline (classified non-AI-service: faster-whisper runs in-process)",
  },
  {
    edgeId: "hermes.image-gen-alternate-providers",
    component:
      "tools/image_generation_tool.py in-tree FAL.ai path (fal-client + FAL_KEY) + plugins/image_gen/{fal,krea,meta-ai,openai-codex,xai,deepinfra} + the Nous managed gateways",
    surface: "image-generation",
    gate:
      "the certified configuration selects image_gen.provider=openai pointed at the adapter; the FAL default is credential-gated (no FAL_KEY in the scrubbed runtime) and the managed Nous gateway is unreachable (egress-denied). Disclosed as the unselected direct paths of the specialized tool",
  },
  {
    edgeId: "hermes.delegate-task",
    component:
      "tools/delegate_tool.py delegate_task (isolated subagent spawn → a full child hermes run with the same provider configuration)",
    surface: "text-generation",
    gate:
      "the declared corpus does not instruct delegation; when used, the child run resolves the SAME delegated custom endpoint (the subagent's model calls ride the declared main seam — no separate client). Disclosed with its classification",
  },
  {
    edgeId: "hermes.skills-hub",
    component:
      "tools/skills_hub_*.py (ClawhHub/GitHub skill installation — git/HTTP fetches, keyword search)",
    surface: "deterministic-computation",
    gate:
      "skill-hub operations are network/git fetches with keyword matching (no model calls at the pinned revision); egress-denied under the proof environment regardless",
  },
  {
    edgeId: "hermes.cron-scheduler",
    component: "cron/ scheduled automations (natural-language schedules dispatched as agent turns)",
    surface: "text-generation",
    gate:
      "the cron daemon is not part of the one-shot corpus runtime; a cron-fired turn would ride the same delegated main seam",
  },
];

/**
 * The non-AI operations Hermes retains as application/domain capabilities
 * (the work order: "Preserve Hermes's own agent/runtime/tool domain
 * responsibilities") — each verified to make NO model call of its own at
 * the pinned revision.
 */
export const HERMES_NON_AI_OPERATIONS: readonly {
  readonly name: string;
  readonly note: string;
}[] = [
  {
    name: "terminal / process_manage (command execution)",
    note: "local shell command execution and process management; no AI provider call (the decision to run a command comes from the delegated agent-loop edge)",
  },
  {
    name: "read_file / write_file / patch / search_files (filesystem)",
    note: "local file operations, ripgrep-backed search, patch application; document-to-text extraction is local parsing (no model call)",
  },
  {
    name: "todo_list / memory / kanban (state tools)",
    note: "local task-state and memory bookkeeping over the state DB; the memory PROVIDER is pluggable but the built-in is local storage — no AI provider call",
  },
  {
    name: "session_search (FTS5 discovery + anchored scroll)",
    note: "SQLite FTS5/trigram/LIKE search over past sessions — purely deterministic at the pinned revision (no embeddings, no reranker, no LLM summarization call in the tool handler)",
  },
  {
    name: "skills system (trigger matching, skill_view/skill_manage)",
    note: "deterministic skill triggering and markdown skill documents; the skill hub's installation is git/HTTP fetching (network, not AI)",
  },
  {
    name: "execute_code (code execution RPC)",
    note: "local/remote Python kernel execution; the code CONTENT is produced by the delegated main seam, the execution itself is deterministic",
  },
  {
    name: "state DB / session lifecycle / WAL / portability",
    note: "hermes_state*.py persistence machinery — local SQLite state, no AI provider calls",
  },
  {
    name: "local TTS engines (NeuTTS/Piper/KittenTTS) and local STT (faster-whisper)",
    note: "offline in-process synthesis/recognition when selected — no external AI service; the certified corpus selects the delegated OpenAI-compatible backends instead (disclosed)",
  },
];
