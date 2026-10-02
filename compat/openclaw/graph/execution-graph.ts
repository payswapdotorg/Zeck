/**
 * The PPR-023 declared execution graph for pinned OpenClaw plus the
 * DISCOVERED edge inventory the static no-bypass reconciliation runs
 * against.
 *
 * UPSTREAM PIN PROVENANCE (recorded honestly):
 *
 *  - The work-order-named target "OpenClaw" is the multi-channel AI
 *    gateway / autonomous general agent by the OpenClaw Foundation:
 *    https://github.com/openclaw/openclaw ("Multi-channel AI gateway with
 *    extensible messaging integrations"). The target matrix's observed
 *    seam ("generic streaming/model abstraction") is the repository's
 *    `src/llm` stream facade over `@openclaw/ai`'s provider registry —
 *    but the matrix's own warning governs this proof: "the codebase has
 *    a broad tool/service plane with provider-specific search/media
 *    integrations... the main model path is not enough."
 *  - The pinned upstream revision is
 *    f6883b3771c0a40d7bd62fcb99815dcbbb2e24f3
 *    (origin/main HEAD at proof-time clone; package version 2026.9.7).
 *    It is run from the exact checkout (built in-sandbox); no upstream
 *    code is modified — every certified axis is the application's own
 *    documented configuration surface.
 *
 * DECLARED EDGES (the material AI-execution seams the declared corpus
 * exercises; every one is delegated through the ACR-007 adapter whose
 * ONLY backend is the Zeck public API — see ../adapter/edges.ts for
 * request→edge attribution):
 *
 *  - openclaw.agent-loop.main     the primary agent conversation turn
 *                                  (`openclaw agent exec` one-shot runs:
 *                                  src/llm stream/complete →
 *                                  getModelLlmRuntime(model) → the
 *                                  provider registry's OpenAI-completions
 *                                  api → POST {base}/chat/completions).
 *                                  Every tool decision (exec, read, write,
 *                                  browser, sessions) and the compaction
 *                                  safeguard's summarization ride this
 *                                  seam; subagent/delegation turns ride
 *                                  it too (the spawned session resolves
 *                                  the SAME configured provider).
 *  - openclaw.media-understanding.image
 *                                  inbound-image understanding
 *                                  (src/media-understanding image runtime
 *                                  → the image-capable provider's chat
 *                                  completions with image content parts —
 *                                  POST {base}/chat/completions).
 *  - openclaw.media-understanding.audio
 *                                  inbound-audio transcription
 *                                  (src/media-understanding
 *                                  openai-compatible-audio →
 *                                  POST {base}/audio/transcriptions —
 *                                  multipart file + model).
 *  - openclaw.tool.tts-openai      the `tts` agent tool + the TTS reply
 *                                  pipeline (src/tts
 *                                  openai-compatible-speech-provider →
 *                                  POST {base}/audio/speech).
 *  - openclaw.tool.image-generate-openai
 *                                  the `image_generate` agent tool
 *                                  (src/image-generation
 *                                  openai-compatible-image-provider →
 *                                  POST {base}/images/generations).
 *
 * DORMANT / NOT-RUN SEAMS (declared with their gates + owners — never
 * silently out of scope; see OPENCLAW_DORMANT_SEAMS below): web search,
 * web fetch (Firecrawl path), video generation, music generation,
 * memory embeddings, realtime voice sessions.
 */

import {
  type ApplicationExecutionGraph,
  type DiscoveredEdgeInventory,
} from "../../../src/integrations/compatibility/public";

/** The pinned upstream repository (cloned at proof time). */
export const OPENCLAW_UPSTREAM_REPOSITORY = "https://github.com/openclaw/openclaw.git";

/** The pinned upstream revision (origin/main HEAD at proof-time clone). */
export const OPENCLAW_UPSTREAM_REVISION = "f6883b3771c0a40d7bd62fcb99815dcbbb2e24f3";

/**
 * The Zeck integration revision this binding pins (the PPR-023 Lead
 * binding re-pins the worker's proof-time placeholder to the governed
 * delivery base — the exact main head the PPR-023 branch was cut from
 * and merges onto, df6304521e74ea848f1a3691f34c381b42d45e2b. A different
 * pin is a different object — never an update; class precedent: the
 * PPR-019/PPR-020/PPR-022 bindings' re-pins).
 */
export const OPENCLAW_INTEGRATION_REVISION = "df6304521e74ea848f1a3691f34c381b42d45e2b";

/** Every edge id the PPR-023 integration declares (the closed set). */
export const OPENCLAW_EDGE_IDS = [
  "openclaw.agent-loop.main",
  "openclaw.media-understanding.image",
  "openclaw.media-understanding.audio",
  "openclaw.tool.tts-openai",
  "openclaw.tool.image-generate-openai",
] as const;

export type OpenClawEdgeId = (typeof OPENCLAW_EDGE_IDS)[number];

/** The declared application execution graph (ACR-006 §1). */
export const OPENCLAW_EXECUTION_GRAPH: ApplicationExecutionGraph = {
  edges: [
    {
      edgeId: "openclaw.agent-loop.main",
      component:
        "src/llm stream/complete facade (deferUntilTransportRuntimeHost → resolveRuntime(model) → @openclaw/ai provider registry) → models.providers.zeck {api: openai-completions, baseUrl: the certified adapter} → POST {base}/chat/completions — every `openclaw agent exec` turn, every tool decision (exec/read/write/browser/sessions), the compaction safeguard's summarization, and subagent delegation turns ride this seam",
      surface: "text-generation",
      transport:
        "OpenAI-compatible chat completions (native tool calls, streaming SSE, image content parts tolerated; the app's own models.providers.<id> custom-provider surface — zero code changes)",
      externalExecution:
        "the configured provider's chat-completions endpoint (undelegated: e.g. api.openai.com/v1/chat/completions, api.anthropic.com, openrouter.ai/api/v1 — the provider registry's 60+ bundled plugin providers)",
      materiality:
        "the primary agent-loop model call: every tool decision in the one-shot corpus runs is produced through this seam — routing only a 'chat model' and leaving this seam direct would leave the application's whole agentic surface provider-owned; the compaction safeguard and subagent turns ride it, so no separate auxiliary LLM client exists under the certified configuration",
    },
    {
      edgeId: "openclaw.media-understanding.image",
      component:
        "src/media-understanding image runtime (runner.ts → image-model-runtime → the image-capable provider entry from tools.media.models[] / models.providers resolution) → POST {base}/chat/completions with image content parts (the supply's vision model)",
      surface: "vision-image-understanding",
      transport:
        "OpenAI-compatible chat completions with multimodal content parts (tools.media.models[] provider entry with capabilities:[\"image\"]; provider auth resolves through the same models.providers.<providerId> surface as model calls — the docs' own rule)",
      externalExecution:
        "the configured image-capable provider's endpoint (undelegated: e.g. api.openai.com/v1/chat/completions with gpt-4o, generativelanguage.googleapis.com — the media-understanding provider-capability registry's catalog)",
      materiality:
        "inbound-image understanding is a SEPARATE capability-tagged model surface (its own provider/model resolution through tools.media.models[] — not necessarily the reply model): a text-only delegation would leave the vision edge a direct-provider bypass; the certified configuration routes it through the adapter's vision surface",
    },
    {
      edgeId: "openclaw.media-understanding.audio",
      component:
        "src/media-understanding audio transcription runner (transcribeAudioFile → openai-compatible-audio.ts → the audio-capable provider entry) → POST {base}/audio/transcriptions (multipart file + model)",
      surface: "speech-recognition",
      transport:
        "OpenAI-compatible transcription API (multipart; tools.media.models[] provider entry with capabilities:[\"audio\"] resolving through models.providers — the batch STT path the `infer audio transcribe` CLI and inbound voice notes both drive)",
      externalExecution:
        "the configured transcription provider's endpoint (undelegated: e.g. api.openai.com/v1/audio/transcriptions, api.groq.com/openai/v1/audio/transcriptions, api.deepgram.com — the audio provider registry)",
      materiality:
        "the speech-recognition surface (the exact function that transcribes inbound voice notes and the app's own `openclaw infer audio transcribe` capability) is a specialized MEDIA path with its own provider clients — a bypass until delegated (the work order's rule)",
    },
    {
      edgeId: "openclaw.tool.tts-openai",
      component:
        "src/tts tts tool + reply pipeline (tts-core → openai-compatible-speech-provider → tts.providers.openai {baseUrl, model, speakerVoice}) → POST {base}/audio/speech",
      surface: "speech-generation",
      transport:
        "OpenAI-compatible speech API (model/voice/input/speed/response_format; tts.providers.openai.{apiKey,baseUrl} — the app's own TTS provider configuration surface)",
      externalExecution:
        "the selected TTS provider's speech endpoint (undelegated: e.g. api.openai.com/v1/audio/speech; the unselected registry entries are Azure Speech, ElevenLabs, Fish Audio, MiniMax, volcengine, xAI, Xiaomi MiMo, Gradium, Inworld, Google Gemini, local CLI engines)",
      materiality:
        "the `tts` agent tool is a specialized MEDIA path that constructs its own provider clients — a bypass until delegated (the work order's rule); the OpenAI-compatible backend is the one the certified configuration routes through the adapter",
    },
    {
      edgeId: "openclaw.tool.image-generate-openai",
      component:
        "src/image-generation image_generate tool (runtime.ts → openai-compatible-image-provider → models.providers.<providerConfigKey>.baseUrl) → POST {base}/images/generations (json or multipart edit mode)",
      surface: "image-generation",
      transport:
        "OpenAI-compatible images API (model/prompt/size/n; agents.defaults.mediaModels.image.primary + the provider entry's models — the app's own image-generation picker surface)",
      externalExecution:
        "the configured image-gen provider's endpoint (undelegated: e.g. api.openai.com/v1/images/generations, fal.ai queue API, ComfyUI, Alibaba DashScope — the image provider registry)",
      materiality:
        "the image_generate tool is a specialized MEDIA path whose backends are direct external AI services — a bypass until delegated through the adapter",
    },
  ],
};

/**
 * The DISCOVERED edge inventory: the static seam scan of the pinned
 * revision, restricted to the declared corpus configuration (headless
 * `openclaw agent exec` one-shot runs with the `coding` tool profile over
 * a fresh --cwd workspace; the pinned --config openclaw.json5 carrying
 * models.providers.zeck as the ONLY provider, tools.media.models[] pinned
 * to the same provider's vision/audio entries, tts.providers.openai
 * pointed at the adapter, mediaModels.image pinned to the provider's
 * image model; no gateway process, no channels, no MCP servers, no
 * search credentials, no video/music providers, no realtime sessions).
 *
 * The scan enumerated every AI-client construction seam reachable under
 * that configuration (the provider-http/REST call sites of
 * packages/ai/src/providers/*, src/web-search/runtime-execution.ts,
 * src/web-fetch/runtime.ts, src/image-generation/*, src/tts/*,
 * src/media-understanding/{openai-compatible-audio,image-runtime}*,
 * src/video-generation/*, src/music-generation/*, src/memory embedding
 * adapters, src/realtime-transcription/websocket-session.ts); each
 * discovered edge is claimed by exactly one declared edge or disclosed
 * as a dormant seam below (reconciled by component+surface+external
 * chain).
 */
export const OPENCLAW_DISCOVERED_INVENTORY: DiscoveredEdgeInventory = {
  source:
    "static seam scan of pinned OpenClaw f6883b3771c0a40d7bd62fcb99815dcbbb2e24f3 (provider-HTTP call-site + provider-registry grep across packages/ai/src/providers/, src/llm/, src/web-search/, src/web-fetch/, src/image-generation/, src/tts/, src/media-understanding/, src/video-generation/, src/music-generation/, src/memory/, src/realtime-transcription/; headless `agent exec` reachability restricted to the declared corpus configuration)",
  edges: [
    {
      edgeId: "openclaw.agent-loop.main",
      component:
        "src/llm/stream.ts stream/complete/streamSimple/completeSimple → resolveRuntime(model) → defaultLlmRuntime / getModelLlmRuntime binding → packages/ai provider registry (openai-completions api for the certified custom provider) — the ONE model client construction seam every agent turn, tool decision, compaction summarization and subagent turn rides",
      surface: "text-generation",
      transport:
        "OpenAI-compatible chat completions (streaming SSE preferred; native tool calls; response_format/reasoning_effort axes tolerated)",
      externalExecution:
        "the configured provider's chat-completions endpoint (undelegated: the 60+ bundled provider plugins — OpenAI, Anthropic, Google, OpenRouter, zai, ... each with its own credential env)",
      materiality:
        "declared edge (the primary agent-loop seam — the target matrix's 'generic streaming/model abstraction' itself)",
    },
    {
      edgeId: "openclaw.media-understanding.image",
      component:
        "src/media-understanding/runner.ts mediaUnderstandingRunner → image.ts/image-model-runtime.ts → packages/ai provider call with image content parts (the tools.media.models[] image-capable entry; ALSO the native-vision path when the reply model declares input:[text,image])",
      surface: "vision-image-understanding",
      transport:
        "OpenAI-compatible chat completions with image content parts (multimodal message content)",
      externalExecution:
        "the configured image-capable provider's endpoint (undelegated: gpt-4o-class vision endpoints, Google/Gemini vision, MiniMax-VL plugin, ...)",
      materiality:
        "declared edge (inbound-image understanding is its own capability-tagged surface — separate model resolution from the reply model)",
    },
    {
      edgeId: "openclaw.media-understanding.audio",
      component:
        "src/media-understanding/audio-transcription-runner.ts + openai-compatible-audio.ts → POST {base}/audio/transcriptions (multipart) — the batch STT path (`infer audio transcribe`, inbound voice notes, preflight gating)",
      surface: "speech-recognition",
      transport: "OpenAI-compatible transcription API (multipart file + model + language hint)",
      externalExecution:
        "the configured transcription provider's endpoint (undelegated: OpenAI/Groq/xAI/Deepgram/ElevenLabs/Mistral/SenseAudio registries)",
      materiality:
        "declared edge (the specialized speech-recognition client — its own provider registry)",
    },
    {
      edgeId: "openclaw.tool.tts-openai",
      component:
        "src/tts/tts-core.ts + tts-synthesis.ts → openai-compatible-speech-provider.ts → POST {base}/audio/speech (the tts.providers.openai entry; the `tts` agent tool and `infer tts convert` both land here)",
      surface: "speech-generation",
      transport: "OpenAI-compatible speech API (model/voice/input/speed/response_format)",
      externalExecution:
        "the selected TTS provider's speech endpoint (undelegated: OpenAI speech, Azure Speech, ElevenLabs, Fish Audio, volcengine, xAI, MiniMax, Xiaomi, Gradium, Inworld, Gemini, local engines)",
      materiality:
        "declared edge (the specialized speech-generation client — its own provider registry)",
    },
    {
      edgeId: "openclaw.tool.image-generate-openai",
      component:
        "src/image-generation/runtime.ts + openai-compatible-image-provider.ts → POST {base}/images/generations (the mediaModels.image.primary resolution over models.providers)",
      surface: "image-generation",
      transport: "OpenAI-compatible images API (generate/edit modes; json/multipart)",
      externalExecution:
        "the configured image-gen provider's endpoint (undelegated: OpenAI images, fal.ai, ComfyUI, Alibaba, BytePlus, ...)",
      materiality:
        "declared edge (the specialized image-generation client — its own provider registry)",
    },
  ],
};

/**
 * The dormant seams at the pinned revision — inventoried and disclosed
 * (never silently out of scope), each with the configuration gate that
 * keeps it unreachable under the declared corpus and its owner.
 */
export interface DormantSeamDisclosure {
  readonly edgeId: string;
  readonly component: string;
  readonly surface: string;
  readonly gate: string;
  readonly owner: string;
}

export const OPENCLAW_DORMANT_SEAMS: readonly DormantSeamDisclosure[] = [
  {
    edgeId: "openclaw.tool.web-search",
    component:
      "src/web-search/runtime.ts runWebSearch → runtime-execution.ts executeWebSearchCandidates → the plugin web-search providers (Brave, Exa, Firecrawl, Gemini Google Search, Grok xAI, Kimi Moonshot, MiniMax, Parallel, Perplexity, Tavily, Ollama, SearXNG, DuckDuckGo — each with its own credential-gated direct HTTP client)",
    surface: "search-ai-search",
    gate:
      "the declared corpus configures NO web-search credentials (scrubbed allowlist environment; plugins.entries.*.config.webSearch.apiKey unset, no provider env keys) and the proof environment's default-deny egress blocks every non-loopback host. Classification from the pinned runtime: DuckDuckGo (key-free HTML scrape) and SearXNG (self-hosted aggregation) are NON-AI retrieval; Brave/Exa/Tavily are keyed retrieval APIs; Perplexity/Grok/Kimi/Gemini/MiniMax/Ollama-search are model-grounded AI search. The authorized sandbox supply rail exposes NO search execution surface, so a search-backed corpus task cannot be delegated LIVE — recorded as an honest NOT-RUN (the work order's conditional: only 'where the pinned runtime exercises them'), never a fabricated result and never a completeness weakening",
    owner: "operator-provider boundary (the authorized supply rail has no search execution surface; search provider credentials are absent by erasure design)",
  },
  {
    edgeId: "openclaw.tool.web-fetch",
    component:
      "src/web-fetch/runtime.ts resolveWebFetchDefinition → the Firecrawl provider (keyed) or the default direct-fetch path + the bundled web-readability local extraction plugin",
    surface: "extraction-document-intelligence",
    gate:
      "the certified configuration leaves Firecrawl unconfigured (no FIRECRAWL_API_KEY in the scrubbed runtime) so the ACTIVE path is direct HTTP fetch + local Readability extraction — verified at the pinned revision to make NO model call (the extractor is local DOM parsing; the summary the agent produces rides the delegated main seam). The Firecrawl path is a keyed external extraction API — credential-gated and egress-denied under the proof environment; disclosed as the unselected path",
    owner: "classification: the actually-active web-fetch path is non-AI at the pinned revision (owner: worker, disclosed); the unselected Firecrawl path is credential-gated (owner: operator-provider boundary)",
  },
  {
    edgeId: "openclaw.tool.video-generate",
    component:
      "src/video-generation/runtime.ts video_generate → dashscope-compatible + provider registry (Alibaba, BytePlus, fal, Runway, PixVerse, Kie — each with its own provider clients)",
    surface: "video-generation",
    gate:
      "the declared corpus pins no video model (agents.defaults.mediaModels.video unset — auto-detection finds no configured video provider under the scrubbed runtime) and the sandbox's authorized supply rail exposes no video execution surface; the async create/poll/download protocol translation was not built for this proof — an honest NOT-RUN recorded WITHOUT weakening completeness (video is not exercised by the declared corpus)",
    owner: "operator-provider boundary (supply has no video execution surface); future delegation owner: worker",
  },
  {
    edgeId: "openclaw.tool.music-generate",
    component:
      "src/music-generation/runtime.ts music_generate → the music provider registry (ComfyUI-class providers)",
    surface: "three-d-generation",
    gate:
      "no music model configured and no music execution surface on the authorized supply rail — honest NOT-RUN, not exercised by the declared corpus",
    owner: "operator-provider boundary (supply has no music execution surface)",
  },
  {
    edgeId: "openclaw.memory.embeddings",
    component:
      "src/memory semantic search → the memory.search.provider remote embedding adapters (openai, gemini, voyage, mistral, deepinfra, github-copilot, amazon-bedrock) or the local/on-device engine",
    surface: "embeddings",
    gate:
      "the certified corpus runs carry no semantic-memory instruction and memory.search is unset under the pinned --config (the default embed path stays local/off); every REMOTE embedding adapter is credential-gated (no keys in the scrubbed runtime) and the authorized supply rail exposes no embeddings endpoint. The sandbox has no live embeddings surface to delegate onto — disclosed as configuration-gated with the classification recorded",
    owner: "operator-provider boundary (supply has no embeddings surface); the active default path is local non-AI storage",
  },
  {
    edgeId: "openclaw.realtime-voice",
    component:
      "src/realtime-transcription/websocket-session.ts + talk realtime sessions (LiveKit-class streaming STT/TTS transports)",
    surface: "realtime-multimodal-session",
    gate:
      "realtime streaming sessions require an operator realtime rail (LiveKit-class credentials/infrastructure) this sandbox does not provide; the declared corpus is one-shot text/audio runs and never opens a realtime session",
    owner: "operator-provider boundary (no realtime rail provisioned — the same class of boundary PPR-022 recorded)",
  },
];

/**
 * The non-AI operations OpenClaw retains as application/domain
 * capabilities (the work order: "Preserve OpenClaw's own
 * agent/runtime/tool domain responsibilities") — each verified to make
 * NO model call of its own at the pinned revision.
 */
export const OPENCLAW_NON_AI_OPERATIONS: readonly {
  readonly name: string;
  readonly note: string;
}[] = [
  {
    name: "exec / terminal (command execution)",
    note: "local shell command execution; no AI provider call (the decision to run a command comes from the delegated agent-loop edge)",
  },
  {
    name: "read / write / edit (filesystem tools)",
    note: "local file operations; document/PDF text extraction is local parsing at the pinned revision (pdf-native-providers are extraction engines, no model call)",
  },
  {
    name: "browser actuation (browser_* tools over CDP)",
    note: "Chromium window/page control, screenshots, input dispatch — application-owned actuation; the INTELLIGENCE choosing actions rides the delegated main seam (browser screenshots return as vision input through the same chat-completions surface); no separate browser LLM client exists at the pinned revision",
  },
  {
    name: "computer-use actuation (screen/computer tools)",
    note: "OS-level window/control actuation is app-owned; action decisions ride the delegated main seam",
  },
  {
    name: "web_fetch direct path + web-readability",
    note: "plain HTTP fetch + local Readability DOM extraction — no model call (the agent's reading of the extracted text rides the main seam)",
  },
  {
    name: "sessions / transcripts / state storage (SQLite)",
    note: "local durable state; session search is local query (no embeddings at the certified config)",
  },
  {
    name: "media transcode (ffmpeg) + media store",
    note: "local audio/video transcoding and artifact storage — deterministic computation, no AI call",
  },
  {
    name: "cron / automations scheduling",
    note: "local scheduling; a cron-fired turn would ride the same delegated main seam",
  },
  {
    name: "channels / gateway transport adapters",
    note: "Telegram/Discord/Slack/WhatsApp/Signal adapters are non-AI transport; every AI surface they dispatch rides the SAME declared seams",
  },
];
