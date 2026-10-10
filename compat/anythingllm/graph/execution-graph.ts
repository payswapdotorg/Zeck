/**
 * The PPR-026 declared execution graph for pinned AnythingLLM plus the
 * DISCOVERED edge inventory the static no-bypass reconciliation runs
 * against.
 *
 * UPSTREAM PIN PROVENANCE (recorded honestly):
 *
 *  - The work-order-named target "AnythingLLM" is the RAG/knowledge
 *    application by Mintplex Labs: https://github.com/Mintplex-Labs/
 *    anything-llm.git — a provider-connector AI application by design
 *    (the target matrix's own row: "provider connectors plus embedding
 *    abstraction … generation, retrieval, embeddings, transcription and
 *    local/remote model paths — certify the whole material AI graph,
 *    not only chat").
 *  - The pinned upstream revision is fa7ec877f005a21ede94888b3b8618b700343857
 *    (release tag v1.17.0 — the latest stable release at proof-time
 *    clone). It runs from the exact checkout in this sandbox as its own
 *    real OS processes (server + collector, zero code changes, both
 *    booted exactly the way the app's own docker-entrypoint boots them:
 *    prisma migrate deploy → node collector/index.js + node
 *    server/index.js), with every AI axis configured to the local Zeck
 *    adapter through the app's OWN documented env-configuration surface
 *    (LLM_PROVIDER/GENERIC_OPEN_AI_*, EMBEDDING_ENGINE/EMBEDDING_*,
 *    STT_PROVIDER/STT_OPEN_AI_COMPATIBLE_*, TTS_PROVIDER/
 *    TTS_OPEN_AI_COMPATIBLE_*, OLLAMA_BASE_PATH).
 *
 * THE FIVE DECLARED EDGES (every material AI surface the pinned runtime
 * uses under the certified configuration — each rides the ACR-007
 * delegation boundary through the Zeck adapter):
 *
 *  1. anythingllm.chat.openai-rail (surface `text-generation`) — the
 *     REMOTE rail: server/utils/AiProviders/genericOpenAi (the openai
 *     npm SDK pointed at GENERIC_OPEN_AI_BASE_PATH) → POST
 *     {base}/chat/completions — the seam every conversational turn
 *     rides (chats/stream.js + chats/apiChatHandler.js +
 *     chats/openaiCompatible.js all resolve the provider connector and
 *     call the same provider class); vision input rides the same seam
 *     (utils/helpers/attachments.js attachmentToContentBlock emits
 *     image_url content parts for image attachments). At the pinned
 *     revision no server-side auxiliary model turn exists on the
 *     developer-API path (no title/tags generation server calls — the
 *     naming surfaces are browser-side), so the certified corpus
 *     exercises main turns; the task protocol keeps the auxiliary role
 *     for honest attribution if the app ever emits one.
 *  2. anythingllm.chat.local-rail (surface `text-generation`) — THE
 *     LOCAL-INFERENCE RAIL (the local-vs-remote inference law: local
 *     inference is a Zeck EXECUTION RAIL when delegated, never an
 *     automatic bypass category): server/utils/AiProviders/ollama (the
 *     ollama npm client pointed at OLLAMA_BASE_PATH) → GET /api/tags +
 *     POST /api/show catalog probes + POST /api/chat (NDJSON stream).
 *     In the certified configuration OLLAMA_BASE_PATH points at the
 *     Zeck adapter's Ollama-native surface: AnythingLLM believes it is
 *     talking to a customer-local Ollama server while Zeck owns the
 *     execution — the local rail is delegated EXACTLY like a remote
 *     provider edge (same execution contract, same lifecycle, same
 *     evidence).
 *  3. anythingllm.rag.embeddings (surface `embeddings`) — the RAG/
 *     embedding seam: server/utils/EmbeddingEngines/genericOpenAi (the
 *     openai SDK pointed at EMBEDDING_BASE_PATH) → POST
 *     {base}/embeddings {model, input:[chunks]} — exercised by document
 *     indexing (vectorDbProviders/lance addDocumentToNamespace →
 *     TextSplitter chunks → embedChunks) AND query embedding
 *     (performSimilaritySearch → LLMConnector.embedTextInput on the
 *     SAME configured engine), so the whole RAG journey rides this edge
 *     in both directions.
 *
 *     THE EMBEDDINGS EXECUTION REPRESENTATION (recorded honestly, never
 *     weakened): the sandbox's authorized GLM supply endpoint exposes NO
 *     embeddings execution surface — probed live at proof time:
 *     POST {base}/embeddings → HTTP 404 (the identical boundary PPR-021
 *     recorded for Continue and PPR-025 recorded for Open WebUI). The
 *     Zeck-side executor for this edge runs the DETERMINISTIC
 *     lexical-hash embedding strategy (a real, deterministic,
 *     reproducible computation over lowercased token n-grams,
 *     feature-hashed into a fixed 512-dimension L2-normalized vector —
 *     the same lexical-overlap retrieval family as the cosine similarity
 *     search AnythingLLM itself runs over embedded chunks), honestly
 *     routed: the planning decision records strategyClass
 *     "deterministic-embeddings" with modelCalls 0, the execution
 *     verification is mechanical (well-formed fixed-dimension vectors,
 *     deterministic across replays), and the adapter serves the
 *     model/dimension the app requests. This is a disclosed Zeck
 *     execution-representation choice (ACR-007 §10: Zeck owns execution
 *     realization for the delegated edge), NOT a fixture: nothing is
 *     simulated — the deterministic computation genuinely executes with
 *     durable lifecycle evidence, and the corpus's RAG task genuinely
 *     retrieves the knowledge document through AnythingLLM's own
 *     LanceDB pipeline over these real vectors. A model-backed
 *     embeddings rail remains a named operator-provider boundary (owner:
 *     Lead — an authorized embeddings-capable supply would switch the
 *     edge's representation without touching the delegation boundary or
 *     the app).
 *  4. anythingllm.audio.stt-generic (surface `speech recognition`) —
 *     server/utils/SpeechToText/openAiGeneric (the openai SDK pointed
 *     at STT_OPEN_AI_COMPATIBLE_ENDPOINT) → POST {base}/audio/
 *     transcriptions (multipart {audio file, model}) — reached through
 *     the app's own POST /api/system/transcribe-audio route (the
 *     browser-mic + file-upload transcription surface).
 *  5. anythingllm.audio.tts-generic (surface `speech generation`) —
 *     server/utils/TextToSpeech/openAiGeneric (the openai SDK pointed
 *     at TTS_OPEN_AI_COMPATIBLE_ENDPOINT) → POST {base}/audio/speech
 *     {model, voice, input} → audio bytes — reached through the app's
 *     own GET /api/workspace/:slug/tts/:chatId route (chat-response
 *     speech synthesis).
 *
 * NON-AI, APP-OWNED (preserved by design — the work order: "Preserve
 * AnythingLLM workspace/document/domain state outside Zeck"): the RAG
 * retrieval scoring itself (LanceDB cosine similarity over the delegated
 * embedding vectors), the sqlite document/workspace/user domain state +
 * the LanceDB vector store + storage/documents + vector-cache + the
 * collector's hotdir pipeline (the PRESERVED-STATE LAW: workspace/
 * document/domain state lives OUTSIDE Zeck), prompt templates + system
 * prompts, the TextSplitter chunking, the API-key/session auth domain,
 * and the adapter's own Ollama tags/show catalog probes (deterministic
 * inventory reads, no model execution). See ANYTHINGLLM_NON_AI_OPERATIONS.
 *
 * DORMANT / NOT-RUN SEAMS (declared with gates + owners — never silently
 * out of scope): the alternative provider connectors (every other
 * AiProviders/* engine), the native transformers embeddings engine, the
 * alternative embedding engines, the collector-side whisper + the
 * alternative server-side STT providers, the alternative TTS providers,
 * the agent-skill image generation surface, the native reranker, the
 * agent flows, the Ollama direct-localhost default, the collector
 * web-scrape/youtube/OCR surfaces, and the telemetry/model-pricing
 * probes (non-AI). See ANYTHINGLLM_DORMANT_SEAMS.
 */

import {
  type ApplicationExecutionGraph,
  type DiscoveredEdgeInventory,
} from "../../../src/integrations/compatibility/public";

/** The pinned upstream repository (cloned at proof time). */
export const ANYTHINGLLM_UPSTREAM_REPOSITORY = "https://github.com/Mintplex-Labs/anything-llm.git";

/** The pinned upstream revision (release tag v1.17.0 at proof-time clone). */
export const ANYTHINGLLM_UPSTREAM_REVISION = "fa7ec877f005a21ede94888b3b8618b700343857";

/**
 * The Zeck integration revision this binding pins (the proof-time
 * placeholder is the governed delivery base the PPR-026 branch was cut
 * from — a8ffc9e2c93b38e60c3fa5cec8591a22dfc5be86, the PPR-025
 * delivered-records commit and main head at branch time. The Lead
 * re-pins the binding to the actual merge base at delivery, the exact
 * class precedent the PPR-019/020/022/023/024/025 bindings established.
 * A different pin is a different object — never an update.)
 */
export const ANYTHINGLLM_INTEGRATION_REVISION = "a8ffc9e2c93b38e60c3fa5cec8591a22dfc5be86";

/** Every edge id the PPR-026 integration declares (the closed set). */
export const ANYTHINGLLM_EDGE_IDS = [
  "anythingllm.chat.openai-rail",
  "anythingllm.chat.local-rail",
  "anythingllm.rag.embeddings",
  "anythingllm.audio.stt-generic",
  "anythingllm.audio.tts-generic",
] as const;

export type AnythingLlmEdgeId = (typeof ANYTHINGLLM_EDGE_IDS)[number];

/** The declared application execution graph (ACR-006 §1). */
export const ANYTHINGLLM_EXECUTION_GRAPH: ApplicationExecutionGraph = {
  edges: [
    {
      edgeId: "anythingllm.chat.openai-rail",
      component:
        "server/utils/AiProviders/genericOpenAi — the generic-OpenAI provider connector (the openai npm SDK with baseURL=GENERIC_OPEN_AI_BASE_PATH) every conversational turn rides: utils/chats/stream.js streamChatWithWorkspace + utils/chats/apiChatHandler.js (the developer API) + utils/chats/openaiCompatible.js (the app's OpenAI-compatible facade) all resolve the provider connector through workspace.chatProvider || LLM_PROVIDER and call the same provider class (streamGetChatCompletion by default — SSE streaming — or getChatCompletion when GENERIC_OPEN_AI_STREAMING_DISABLED) → POST {base}/chat/completions; vision input rides the same seam (utils/helpers/attachments.js attachmentToContentBlock emits image_url content parts)",
      surface: "text-generation",
      transport:
        "OpenAI-compatible chat completions (JSON {model, messages, temperature, max_tokens, stream}; the app's own documented LLM_PROVIDER=generic-openai + GENERIC_OPEN_AI_BASE_PATH/MODEL_PREF connection configuration — zero code changes, the api key the non-empty placeholder the SDK requires)",
      externalExecution:
        "the configured provider's chat-completions endpoint (undelegated default: https://api.openai.com/v1/chat/completions; any OpenAI-compatible remote the customer configures)",
      materiality:
        "the primary conversation surface: every user-facing chat turn and vision input flows through this ONE provider seam — routing only a 'chat model' and leaving this seam direct would leave the application's whole conversational intelligence provider-owned; at the pinned revision the developer-API path emits no separate auxiliary model turn (the naming surfaces are browser-side), so no second AI client exists on the certified path",
    },
    {
      edgeId: "anythingllm.chat.local-rail",
      component:
        "server/utils/AiProviders/ollama — the LOCAL-INFERENCE RAIL: the Ollama-native provider connector (the ollama npm client with host=OLLAMA_BASE_PATH: GET /api/tags + POST /api/show catalog/context-window probes at boot, POST /api/chat NDJSON-stream chat), the exact 'local/remote model path' the work order names — selected per-workspace through AnythingLLM's own chatProvider/chatModel override (models/workspace.js), the certified corpus's local-rail workspace",
      surface: "text-generation",
      transport:
        "Ollama-native JSON (GET /api/tags → {models}; POST /api/show {model} → {model_info, capabilities}; POST /api/chat {model, stream:true, messages, keep_alive, options} → NDJSON {message:{content}, done}) pointed at the certified Zeck adapter's Ollama-native surface through the app's own documented OLLAMA_BASE_PATH configuration — the local rail is delegated through the SAME ACR-007 execution contract as the remote rail (identical Zeck task kind, lifecycle, evidence), never a bypass category",
      externalExecution:
        "a customer-local Ollama server (undelegated default: http://localhost:11434 — the local model daemon; any Ollama-compatible endpoint the customer configures)",
      materiality:
        "THE local-vs-remote inference law (binding, from the work order): customer/local inference is a Zeck EXECUTION RAIL when delegated — it is NOT an automatic bypass category. The corpus exercises this rail end-to-end (a workspace with the ollama chatProvider override chating with the adapter-served zeck-local model), and the delegation boundary covers it exactly like a remote provider edge: the adapter's Ollama-native surface translates to the same Zeck execution contract with the same lifecycle, evidence and egress controls as the generic-openai chat seam",
    },
    {
      edgeId: "anythingllm.rag.embeddings",
      component:
        "server/utils/EmbeddingEngines/genericOpenAi — the generic-OpenAI embedding engine (the openai npm SDK with baseURL=EMBEDDING_BASE_PATH): POST {base}/embeddings {model, input:[texts]} — document-chunk indexing (utils/vectorDbProviders/lance addDocumentToNamespace → TextSplitter → embedChunks, batched) and query embedding (performSimilaritySearch → LLMConnector.embedTextInput over the SAME configured engine)",
      surface: "embeddings",
      transport:
        "OpenAI-compatible embeddings JSON ({model, input:[texts]} → {data:[{embedding}], usage}) at the certified Zeck adapter — the app's own documented EMBEDDING_ENGINE=generic-openai + EMBEDDING_BASE_PATH/MODEL_PREF configuration",
      externalExecution:
        "the configured provider's embeddings endpoint (undelegated default: https://api.openai.com/v1/embeddings; or the app's DEFAULT native transformers engine when EMBEDDING_ENGINE is unset — the local-model dormant seam)",
      materiality:
        "every RAG journey depends on this seam in BOTH directions (document indexing AND query embedding) — a delegation that left embeddings direct would leave the application's whole knowledge surface provider-owned (the completeness rule: an application is not complete because its chat uses Zeck while its embedding path bypasses Zeck). THE EXECUTION REPRESENTATION at the pinned supply: the authorized GLM supply exposes no embeddings surface (probed live: POST /embeddings → 404, the identical boundary PPR-021/025 recorded), so the Zeck-side executor runs the DETERMINISTIC lexical-hash embedding strategy (real, deterministic, reproducible; strategyClass 'deterministic-embeddings', modelCalls 0, mechanically verified) — a disclosed representation choice, never a fixture; a model-backed embeddings rail remains the named operator-provider boundary (owner: Lead)",
    },
    {
      edgeId: "anythingllm.audio.stt-generic",
      component:
        "server/utils/SpeechToText/openAiGeneric (STT_PROVIDER=generic-openai) → the openai npm SDK audio.transcriptions.create → POST {STT_OPEN_AI_COMPATIBLE_ENDPOINT}/audio/transcriptions (multipart {file, model}) → {text}, reached through the app's own POST /api/system/transcribe-audio route (multer audio upload; .wav input keeps the collector's ffmpeg conversion wrapper out of the path)",
      surface: "speech-recognition",
      transport:
        "OpenAI-compatible audio transcriptions (multipart) at the certified Zeck adapter — the app's own documented STT_PROVIDER=generic-openai + STT_OPEN_AI_COMPATIBLE_ENDPOINT/MODEL configuration",
      externalExecution:
        "the configured STT provider's transcriptions endpoint (undelegated default: https://api.openai.com/v1/audio/transcriptions; the openai/lemonade/deepgram/groq engines and the collector-side WHISPER_PROVIDER local whisper are dormant seams)",
      materiality:
        "the transcription surface the work order names explicitly ('transcription … must be delegated through the ACR-007 boundary or remain a NAMED INCOMPLETENESS') — the corpus transcribes the committed known-phrase .wav asset through the app's own transcription route and the mechanical check verifies the known phrase in the transcript",
    },
    {
      edgeId: "anythingllm.audio.tts-generic",
      component:
        "server/utils/TextToSpeech/openAiGeneric (TTS_PROVIDER=generic-openai) → the openai npm SDK audio.speech.create → POST {TTS_OPEN_AI_COMPATIBLE_ENDPOINT}/audio/speech {model, voice, input} → audio bytes, reached through the app's own GET /api/workspace/:slug/tts/:chatId route (chat-response speech synthesis with the app's in-memory response cache)",
      surface: "speech-generation",
      transport:
        "OpenAI-compatible speech synthesis JSON → audio bytes at the certified Zeck adapter — the app's own documented TTS_PROVIDER=generic-openai + TTS_OPEN_AI_COMPATIBLE_ENDPOINT/MODEL/VOICE_MODEL configuration",
      externalExecution:
        "the configured TTS provider's speech endpoint (undelegated default: https://api.openai.com/v1/audio/speech; the openai/elevenlabs/kokoro engines and the browser-native speech synthesis are dormant seams)",
      materiality:
        "the speech-generation surface of the provider-connector graph is a material AI edge (multi-modal parity with the program's speech surfaces) — the corpus synthesizes a stored chat response through the app's own TTS route and the mechanical check verifies non-empty audio bytes with an audio content-type",
    },
  ],
};

/**
 * The DISCOVERED edge inventory: the static seam scan of the pinned
 * revision, restricted to the declared corpus configuration (single-user
 * open mode, LLM_PROVIDER=generic-openai + EMBEDDING_ENGINE=generic-openai
 * + STT/TTS generic-openai all at the adapter, OLLAMA_BASE_PATH at the
 * adapter's Ollama-native surface, VECTOR_DB=lancedb, chatMode pinned to
 * 'chat', telemetry disabled, no agent flows, no MCP, no browser
 * extension, no community hub imports).
 *
 * The scan enumerated every AI-client construction seam reachable under
 * that configuration (the provider connector call sites across
 * server/utils/AiProviders (genericOpenAi chat + ollama native), the
 * embedding engine call sites across server/utils/EmbeddingEngines +
 * vectorDbProviders/lance + chats/* query embedding, the STT provider
 * (utils/SpeechToText + endpoints/system transcribe-audio), the TTS
 * provider (utils/TextToSpeech + endpoints/workspaces tts route), and
 * the agent-runtime providers (utils/agents/aibitat/providers — the
 * same env abstraction, agent flows gated off); each discovered edge is
 * claimed by exactly one declared edge or disclosed as a dormant seam
 * below (reconciled by edge id and by component+surface+external
 * chain).
 */
export const ANYTHINGLLM_DISCOVERED_INVENTORY: DiscoveredEdgeInventory = {
  source:
    "static seam scan of pinned AnythingLLM fa7ec877f005a21ede94888b3b8618b700343857 (AI-client call-site read across server/: utils/AiProviders/genericOpenAi chat completions (chats/stream.js + chats/apiChatHandler.js + chats/openaiCompatible.js + agents/aibitat/providers/genericOpenAi.js — agent flows gated off), utils/AiProviders/ollama native client (tags/show probes + /api/chat), utils/EmbeddingEngines/genericOpenAi embeddings (vectorDbProviders/lance addDocumentToNamespace + performSimilaritySearch query embed), utils/SpeechToText/openAiGeneric transcriptions (endpoints/system.js transcribe-audio), utils/TextToSpeech/openAiGeneric speech (endpoints/workspaces.js tts route); reachability restricted to the declared corpus configuration: all five provider axes at the adapter, single-user mode, chatMode 'chat', telemetry disabled, no agent flows, no MCP servers, no browser extension, no community-hub imports, no alternative provider credentials)",
  edges: [
    {
      edgeId: "anythingllm.chat.openai-rail",
      component:
        "the generic-OpenAI chat seam — utils/AiProviders/genericOpenAi (openai SDK chat.completions.create → POST {GENERIC_OPEN_AI_BASE_PATH}/chat/completions, SSE streaming by default) reached by chats/stream.js, chats/apiChatHandler.js and chats/openaiCompatible.js for every main conversational turn and vision attachment",
      surface: "text-generation",
      transport: "OpenAI-compatible chat completions JSON (+ SSE streaming default)",
      externalExecution:
        "the configured provider's chat-completions endpoint (undelegated: api.openai.com or any customer-configured OpenAI-compatible base)",
      materiality: "declared edge (the primary conversational seam — the target matrix's 'provider connectors' itself)",
    },
    {
      edgeId: "anythingllm.chat.local-rail",
      component:
        "the Ollama-native seam — utils/AiProviders/ollama (the ollama npm client: GET {OLLAMA_BASE_PATH}/api/tags + POST /api/show boot probes, POST /api/chat NDJSON-stream chat), selected per-workspace through the chatProvider/chatModel override",
      surface: "text-generation",
      transport:
        "Ollama-native JSON (tags/show/chat); delegated: the adapter's Ollama-native surface → the same Zeck execution contract as the remote rail",
      externalExecution:
        "a customer-local Ollama server (undelegated: http://localhost:11434 — the local model daemon)",
      materiality:
        "declared edge (THE local-inference rail — the work order's binding law that local inference is a Zeck execution rail when delegated, never an automatic bypass category)",
    },
    {
      edgeId: "anythingllm.rag.embeddings",
      component:
        "the generic-OpenAI embeddings seam — utils/EmbeddingEngines/genericOpenAi (openai SDK embeddings.create → POST {EMBEDDING_BASE_PATH}/embeddings), exercised by document indexing (vectorDbProviders/lance addDocumentToNamespace → TextSplitter → embedChunks) and query embedding (performSimilaritySearch → LLMConnector.embedTextInput)",
      surface: "embeddings",
      transport:
        "OpenAI-compatible embeddings JSON; delegated to the adapter, executed by the Zeck-side deterministic lexical-hash embeddings strategy (the supply's 404 boundary, disclosed)",
      externalExecution:
        "the configured provider's embeddings endpoint (undelegated: api.openai.com/v1/embeddings or the app's default native transformers engine — the last a dormant seam)",
      materiality: "declared edge (every RAG journey depends on it, in both directions)",
    },
    {
      edgeId: "anythingllm.audio.stt-generic",
      component:
        "the generic-OpenAI STT seam — utils/SpeechToText/openAiGeneric (openai SDK audio.transcriptions.create → POST {STT_OPEN_AI_COMPATIBLE_ENDPOINT}/audio/transcriptions, multipart), reached through POST /api/system/transcribe-audio",
      surface: "speech-recognition",
      transport: "OpenAI-compatible audio transcriptions (multipart)",
      externalExecution:
        "the configured STT provider's endpoint (undelegated: api.openai.com/v1/audio/transcriptions; openai/lemonade/deepgram/groq + collector-side whisper dormant)",
      materiality: "declared edge (the speech-recognition surface the work order names)",
    },
    {
      edgeId: "anythingllm.audio.tts-generic",
      component:
        "the generic-OpenAI TTS seam — utils/TextToSpeech/openAiGeneric (openai SDK audio.speech.create → POST {TTS_OPEN_AI_COMPATIBLE_ENDPOINT}/audio/speech → audio bytes), reached through GET /api/workspace/:slug/tts/:chatId",
      surface: "speech-generation",
      transport: "OpenAI-compatible speech synthesis JSON → audio bytes",
      externalExecution:
        "the configured TTS provider's endpoint (undelegated: api.openai.com/v1/audio/speech; openai/elevenlabs/kokoro engines dormant)",
      materiality: "declared edge (the speech-generation surface — multi-modal parity)",
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

export const ANYTHINGLLM_DORMANT_SEAMS: readonly DormantSeamDisclosure[] = [
  {
    edgeId: "anythingllm.embeddings.native-transformers",
    component:
      "utils/EmbeddingEngines/native — the app's DEFAULT local embedding engine (@xenova/transformers, Xenova/all-MiniLM-L6-v2; model weights download from the HuggingFace hub on first embed, cache at {STORAGE_DIR}/models)",
    surface: "embeddings",
    gate:
      "the certified configuration sets EMBEDDING_ENGINE=generic-openai pointed at the Zeck adapter (the app's own documented engine axis); the native engine is never selected, and its HuggingFace weight download would be egress-denied by the proof environment's default-deny proxy regardless. Disclosed as a deliberately-unselected local-model engine, never a second AI path",
    owner:
      "classification: configuration-gated dormant seam (owner: worker, disclosed); future delegation owner: worker (the delegated embeddings edge already covers the surface class)",
  },
  {
    edgeId: "anythingllm.chat.alternative-providers",
    component:
      "utils/AiProviders/* — every provider connector besides generic-openai and ollama (anthropic, openai, azure, bedrock, gemini, groq, lmstudio, localai, litellm, mistral, openrouter, togetherai, vertex, xai, zai, and the rest of the ~45-connector roster), plus the modelRouter meta-provider",
    surface: "text-generation",
    gate:
      "the certified configuration sets LLM_PROVIDER=generic-openai (the app's own documented provider axis) and the local rail's OLLAMA_BASE_PATH at the adapter; no credentials exist for any other provider in the scrubbed credential-free environment (ACR-007 §5 erasure), and every alternative connector is unreachable under the declared corpus",
    owner:
      "operator-provider boundary (no provider credentials by erasure design; the certified configuration never selects an alternative connector)",
  },
  {
    edgeId: "anythingllm.embeddings.alternative-engines",
    component:
      "utils/EmbeddingEngines/* — the embedding engines besides generic-openai (openai, azure, localai, ollama, lmstudio, cohere, voyageai, litellm, mistral, gemini, openrouter, lemonade)",
    surface: "embeddings",
    gate:
      "the certified configuration sets EMBEDDING_ENGINE=generic-openai at the adapter; no alternative embedding credentials exist in the scrubbed environment; every alternative engine is unreachable under the declared corpus",
    owner:
      "operator-provider boundary (no embedding-provider credentials by erasure design; the delegated embeddings edge already covers the surface class)",
  },
  {
    edgeId: "anythingllm.stt.local-and-alternative",
    component:
      "the alternative server-side STT providers (utils/SpeechToText: openai, lemonade, deepgram, groq — each with its own credentials) and the collector-side WHISPER_PROVIDER whisper engines (local model download / generic-openai) used when AUDIO FILES are ingested as documents",
    surface: "speech-recognition",
    gate:
      "the certified configuration sets STT_PROVIDER=generic-openai pointed at the Zeck adapter for the server-side transcription route, and never ingests audio documents (the corpus transcribes a .wav through the app's own /api/system/transcribe-audio route, keeping the collector's ffmpeg conversion wrapper and the WHISPER_* document-ingest axis out of the path)",
    owner:
      "operator-provider boundary (no alternative STT credentials by erasure design; the collector whisper axis is document-ingest-gated and never exercised — disclosed, owner: worker)",
  },
  {
    edgeId: "anythingllm.tts.alternative-engines",
    component:
      "utils/TextToSpeech providers besides generic-openai (openai, elevenlabs, kokoro local) and the browser-native speech synthesis ('native' — client-side Web Speech, no server AI call)",
    surface: "speech-generation",
    gate:
      "the certified configuration sets TTS_PROVIDER=generic-openai at the adapter; no elevenlabs/openai credentials exist in the scrubbed environment; kokoro is a local-model engine never selected; the browser-native synthesis never runs in the headless corpus",
    owner:
      "operator-provider boundary (no TTS-provider credentials by erasure design; the certified configuration selects the delegated generic-openai engine)",
  },
  {
    edgeId: "anythingllm.images.agent-skill",
    component:
      "utils/ImageGenerators (openAi + openAiGeneric engines) — image generation at the pinned revision is reachable ONLY through the agent runtime's image-generation skill (chatMode 'automatic' agent flows / agent-flows builder), never through a plain chat or developer-API route",
    surface: "image-generation",
    gate:
      "the certified configuration pins chatMode='chat' (the app's own per-workspace axis, set at workspace creation through the developer API) and PROVIDER_DISABLE_NATIVE_TOOL_CALLING=generic-openai, so no agent flow — and therefore no image-generation skill call — is constructed under the declared corpus; no image-provider credentials exist in the scrubbed environment regardless. The PPR-026 work order's mandated surfaces are chat/generation, retrieval, embedding, transcription and local/remote paths; image generation is disclosed here as a NOT-EXERCISED agent-gated surface rather than silently dropped",
    owner:
      "classification: configuration-gated dormant seam, NOT EXERCISED by the declared corpus (owner: worker, disclosed; future delegation owner: worker — an agent-flow corpus would ride the same delegated provider seams the agent runtime resolves through the identical env abstraction)",
  },
  {
    edgeId: "anythingllm.rag.rerank-native",
    component:
      "utils/EmbeddingRerankers/native — the local cross-encoder reranker (@xenova/transformers ms-marco-MiniLM; model weights download from the HuggingFace hub), reachable through the agent tool-rerank skill and the workspace vectorSearchMode='rerank' axis",
    surface: "reranking",
    gate:
      "the certified configuration sets AGENT_SKILL_RERANKER_ENABLED=false and never sets vectorSearchMode='rerank' (the app's default is 'default' — LanceDB cosine similarity over the delegated embeddings); the reranker is never constructed and its HuggingFace weight download would be egress-denied regardless",
    owner: "classification: configuration-gated dormant seam (owner: worker, disclosed)",
  },
  {
    edgeId: "anythingllm.agent-flows",
    component:
      "the agent runtime — utils/agents (the vendored AIbitat agent handler, the agent-skill toolset: web-browsing, file IO, rerank, image generation, chart generation, MCP tools) + utils/agentFlows (the flow builder) — agent model calls resolve through aibitat/providers/*, the SAME env provider abstraction as the chat seam",
    surface: "agent delegation",
    gate:
      "the certified configuration pins chatMode='chat' (per-workspace axis at creation) and PROVIDER_DISABLE_NATIVE_TOOL_CALLING=generic-openai, so no agent invocation is constructed under the declared corpus; if a future configuration enabled agents, their model calls would resolve the SAME delegated provider connectors (aibitat/providers/genericOpenAi reads the identical GENERIC_OPEN_AI_* env axes), and the agent skills' non-AI tools (file IO, shell) are app-owned actuation",
    owner: "classification: configuration-gated dormant seam (owner: worker, disclosed)",
  },
  {
    edgeId: "anythingllm.ollama.direct-localhost",
    component:
      "the Ollama connection default — OLLAMA_BASE_PATH unset defaults the ollama client to http://localhost:11434 (a customer-local model server outside the delegation boundary)",
    surface: "text-generation",
    gate:
      "the certified configuration sets OLLAMA_BASE_PATH to the Zeck adapter's Ollama-native surface (the app's own documented connection axis) — no direct local daemon exists in the proof environment, and any non-loopback Ollama host would be egress-denied by the default-deny proxy; the local rail is DELEGATED (see the declared anythingllm.chat.local-rail edge), never bypassed",
    owner:
      "classification: delegated-by-configuration (the local-inference rail rides the adapter — the work order's local-vs-remote law, satisfied)",
  },
  {
    edgeId: "anythingllm.collector.web-ingest",
    component:
      "the collector's network ingest surfaces — puppeteer web-scrape link ingestion, youtube-transcript extraction, and the OCR/tesseract document path (collector/utils/*; the collector is the app's own second process)",
    surface: "web ingestion / OCR",
    gate:
      "the declared corpus ingests a plain .txt document only (deterministic text extraction); the web-scrape/youtube/OCR paths are never exercised, the proof environment's default-deny proxy blocks every non-loopback fetch they would make, and puppeteer's Chromium download was skipped at install time (the surface is unreachable by construction)",
    owner:
      "classification: egress-denied dormant seam (owner: worker, disclosed — no credentials, no exercised path)",
  },
  {
    edgeId: "anythingllm.telemetry-pricing",
    component:
      "the app's own non-AI outbound endpoints — the posthog telemetry client (boot/chat/workspace events) and the models.dev model-pricing cache refresh (fired once at boot when no disk cache exists)",
    surface: "deterministic-computation",
    gate:
      "telemetry is disabled by the certified configuration (DISABLE_TELEMETRY=true — the app's own documented axis); the models.dev pricing fetch carries no disable env but is a plain non-AI HTTP probe whose failure is caught and logged by the app itself ('Error syncing remote pricing data') and which the proof environment's default-deny proxy blocks — classified non-AI at the pinned revision",
    owner:
      "classification: non-AI telemetry/pricing endpoints, disabled or egress-denied (owner: worker, disclosed)",
  },
];

/**
 * The non-AI operations AnythingLLM retains as application/domain
 * capabilities (the work order: "Preserve AnythingLLM workspace/
 * document/domain state outside Zeck" — the PRESERVED-STATE LAW) —
 * each verified to make NO model call and NO direct AI-provider request
 * of its own on the certified path (every AI turn rides the declared
 * edges).
 */
export const ANYTHINGLLM_NON_AI_OPERATIONS: readonly {
  readonly name: string;
  readonly note: string;
}[] = [
  {
    name: "RAG retrieval scoring (LanceDB cosine similarity)",
    note:
      "the app's own deterministic cosine-distance search over the delegated embedding vectors (vectorDbProviders/lance performSimilaritySearch — domain logic); both the document vectors and the query embedding come from the delegated embeddings edge",
  },
  {
    name: "workspace/document/domain state (sqlite + LanceDB + storage/)",
    note:
      "workspaces, documents, chunks, the vector store, vector-cache, chat history, users/API keys and the collector hotdir are AnythingLLM's own domain state — outside Zeck by design (the PRESERVED-STATE LAW; ACR-006 completeness rule)",
  },
  {
    name: "TextSplitter chunking + document text extraction",
    note:
      "deterministic text processing (chunk size/overlap from system settings; the collector's .txt extraction is a deterministic parse)",
  },
  {
    name: "prompt templates + system prompts + chat history packing",
    note:
      "deterministic string construction from the app's own templates (chatPrompt + compressMessages) — the model turn itself rides the delegated chat edge",
  },
  {
    name: "auth/session/API-key domain + the onboarding flow",
    note:
      "single-user open mode, the api_keys table, JWT sessions, onboarding flags — application domain state, no AI calls",
  },
  {
    name: "model catalog + context-window caches (Ollama tags/show probes)",
    note:
      "the ollama client's boot-time GET /api/tags + POST /api/show reads — deterministic inventory reads (the adapter serves both catalog probes without model execution)",
  },
  {
    name: "telemetry / logging / model-pricing cache (disabled or egress-denied)",
    note:
      "local logging, the disabled posthog client, and the egress-denied models.dev pricing refresh — non-AI, configuration-disabled or proxy-blocked",
  },
];
