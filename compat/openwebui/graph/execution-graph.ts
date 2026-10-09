/**
 * The PPR-025 declared execution graph for pinned Open WebUI plus the
 * DISCOVERED edge inventory the static no-bypass reconciliation runs
 * against.
 *
 * UPSTREAM PIN PROVENANCE (recorded honestly):
 *
 *  - The work-order-named target "Open WebUI" is the general AI UI by the
 *    Open WebUI team: https://github.com/open-webui/open-webui.git — a
 *    multi-surface AI gateway by design (the target matrix's own row:
 *    "chat, RAG/retrieval, embeddings, image generation, STT/TTS,
 *    local/remote inference — multiple modality/provider paths and local
 *    inference").
 *  - The pinned upstream revision is 8bd8b4fac5e059578ac0c74b3c18d11139f88b7d
 *    (origin/main HEAD at proof-time clone; package version 0.11.4). It
 *    runs from the exact checkout in this sandbox (PYTHONPATH pinned to
 *    the checkout's backend/, zero code changes); the pinned venv carries
 *    the app's requirements-slim.txt set plus the standard-profile pieces
 *    the certified configuration activates (chromadb for the app's
 *    default vector store, pydub, and the storage SDKs its non-slim
 *    storage provider imports eagerly — versions pinned to the app's own
 *    requirements.txt pins).
 *  - The certified runtime profile: the app's STANDARD distribution
 *    profile (USE_SLIM unset — the sandbox has no PostgreSQL/pgvector the
 *    slim profile hard-requires for vector storage), serving API-only
 *    (the app's own first-class mode when the frontend build directory is
 *    absent: "Serving API only"), every AI engine configured to external
 *    endpoints at the local Zeck adapter through the app's OWN documented
 *    env-configuration surface (OPENAI_API_BASE_URLS, OLLAMA_BASE_URLS,
 *    RAG_EMBEDDING_ENGINE=openai + RAG_OPENAI_API_BASE_URL,
 *    IMAGE_GENERATION_ENGINE=openai + IMAGES_OPENAI_API_BASE_URL,
 *    audio.stt.engine=openai + audio.stt.openai.api_base_url,
 *    audio.tts.engine=openai + audio.tts.openai.api_base_url).
 *
 * THE MULTI-SURFACE DECLARATION (the work order's contract — the proof
 * must NOT stop at the chat path; every material AI edge the declared
 * corpus exercises is its own declared edge):
 *
 *  1. openwebui.chat.openai-rail  (surface `text generation`) — the
 *     OpenAI-compatible chat seam: routers/openai.py
 *     generate_chat_completions → POST {OPENAI_API_BASE_URLS}/chat/completions.
 *     EVERY chat turn rides it: the main user-facing conversation turns,
 *     the auxiliary task turns (title/tags/autocomplete/follow-up/emoji —
 *     routers/tasks.py generate_chat_* all ride generate_chat_completion
 *     with a metadata.task label), and vision content parts when a
 *     multimodal message is sent (attribution signal).
 *  2. openwebui.chat.local-rail  (surface `text generation`) — the
 *     LOCAL-INFERENCE RAIL (the work order's binding law: customer/local
 *     inference is a Zeck EXECUTION RAIL when delegated, never an
 *     automatic bypass category): routers/ollama.py → the Ollama-native
 *     protocol (GET {OLLAMA_BASE_URLS}/api/tags catalog probe +
 *     POST {OLLAMA_BASE_URLS}/api/chat). In the certified configuration
 *     OLLAMA_BASE_URLS points at the Zeck adapter's Ollama-native
 *     surface: Open WebUI believes it is talking to a customer-local
 *     Ollama server while Zeck owns the execution — the local rail is
 *     delegated EXACTLY like a remote provider edge (same execution
 *     contract, same lifecycle, same evidence).
 *  3. openwebui.rag.embeddings  (surface `embeddings`) — the RAG/embedding
 *     seam: backend/open_webui/retrieval/utils.py
 *     agenerate_openai_batch_embeddings → POST
 *     {RAG_OPENAI_API_BASE_URL}/embeddings (RAG_EMBEDDING_ENGINE=openai),
 *     exercised by document indexing, query embedding and the memories
 *     feature's embedding calls. The Ollama-native embedding engine
 *     (POST {url}/api/embed, RAG_EMBEDDING_ENGINE=ollama) is the same
 *     declared edge — the adapter serves both wire shapes; the certified
 *     corpus exercises the OpenAI-shaped one on its RAG task and the
 *     Ollama-shaped one through the app's own /api/v1/ollama/embed proxy
 *     on the local-rail task.
 *
 *     THE EMBEDDINGS EXECUTION REPRESENTATION (recorded honestly, never
 *     weakened): the sandbox's authorized GLM supply endpoint exposes NO
 *     embeddings execution surface — probed live at proof time:
 *     POST {base}/embeddings → HTTP 404 (the identical boundary PPR-021
 *     recorded for Continue). The Zeck-side executor for this edge runs
 *     the DETERMINISTIC lexical-hash embedding strategy (a real,
 *     deterministic, reproducible computation over lowercased token
 *     n-grams, feature-hashed into a fixed 512-dimension L2-normalized
 *     vector — the same lexical-overlap retrieval family as the
 *     rank-bm25 hybrid search Open WebUI itself ships), honestly routed:
 *     the planning decision records strategyClass "deterministic-embeddings"
 *     with modelCalls 0, the execution verification is mechanical
 *     (well-formed fixed-dimension vectors, deterministic across
 *     replays), and the adapter serves whatever dimension the client
 *     requests. This is a disclosed Zeck execution-representation choice
 *     (ACR-007 §10: Zeck owns execution realization for the delegated
 *     edge), NOT a fixture: nothing is simulated — the deterministic
 *     computation genuinely executes with durable lifecycle evidence,
 *     and the corpus's RAG task genuinely retrieves the knowledge
 *     document through the app's own vector pipeline over these real
 *     vectors. A model-backed embeddings rail remains a named
 *     operator-provider boundary (owner: Lead — an authorized
 *     embeddings-capable supply would switch the edge's representation
 *     without touching the delegation boundary or the app).
 *  4. openwebui.images.openai-generate  (surface `image generation`) —
 *     routers/images.py image_generations with
 *     IMAGE_GENERATION_ENGINE=openai → POST
 *     {IMAGES_OPENAI_API_BASE_URL}/images/generations.
 *  5. openwebui.audio.stt-openai  (surface `speech recognition`) —
 *     routers/audio.py _transcribe_openai (audio.stt.engine=openai) →
 *     POST {audio.stt.openai.api_base_url}/audio/transcriptions
 *     (multipart or json body — both shapes served).
 *  6. openwebui.audio.tts-openai  (surface `speech generation`) —
 *     routers/audio.py _tts_openai (audio.tts.engine=openai) → POST
 *     {audio.tts.openai.api_base_url}/audio/speech (audio bytes back).
 *
 * NON-AI, APP-OWNED (preserved by design — the work order: "Preserve
 * Open WebUI's own workspace/document/domain state responsibilities"):
 * the RAG retrieval scoring itself (cosine + the app's own hybrid BM25),
 * the sqlite/chroma document+vector stores, uploads/files/knowledge
 * workspace state, user/auth/chat domain state, prompt templates and
 * pipeline filter code, the model-catalog merge logic, and the adapter's
 * own /v1/models + /api/tags catalog probes (deterministic inventory
 * reads, no model execution). See OPENWEBUI_NON_AI_OPERATIONS.
 *
 * DORMANT / NOT-RUN SEAMS (declared with gates + owners — never silently
 * out of scope): the local-model engines the standard profile makes
 * reachable but the certified configuration never selects (local
 * SentenceTransformers embeddings, faster-whisper local STT, the
 * alternative TTS/STT providers, the local cross-encoder reranker), the
 * Ollama direct-localhost default, web search providers, the external
 * RAG pipeline / Pipelines servers, the tools/functions system, image
 * edit, the PDF/web loaders, and the telemetry/version probes (non-AI).
 * See OPENWEBUI_DORMANT_SEAMS.
 */

import {
  type ApplicationExecutionGraph,
  type DiscoveredEdgeInventory,
} from "../../../src/integrations/compatibility/public";

/** The pinned upstream repository (cloned at proof time). */
export const OPENWEBUI_UPSTREAM_REPOSITORY = "https://github.com/open-webui/open-webui.git";

/** The pinned upstream revision (origin/main HEAD at proof-time clone; v0.11.4). */
export const OPENWEBUI_UPSTREAM_REVISION = "8bd8b4fac5e059578ac0c74b3c18d11139f88b7d";

/**
 * The Zeck integration revision this binding pins (the proof-time
 * placeholder is the governed delivery base the PPR-025 branch was cut
 * from — 1485ddd92202153f44c21f3eeb8b65f55322ac67, the PPR-024
 * delivered-records commit and main head at branch time. The Lead
 * re-pins the binding to the actual merge base at delivery, the exact
 * class precedent the PPR-019/020/022/023/024 bindings established. A
 * different pin is a different object — never an update.)
 */
export const OPENWEBUI_INTEGRATION_REVISION = "1485ddd92202153f44c21f3eeb8b65f55322ac67";

/** Every edge id the PPR-025 integration declares (the closed set). */
export const OPENWEBUI_EDGE_IDS = [
  "openwebui.chat.openai-rail",
  "openwebui.chat.local-rail",
  "openwebui.rag.embeddings",
  "openwebui.images.openai-generate",
  "openwebui.audio.stt-openai",
  "openwebui.audio.tts-openai",
] as const;

export type OpenWebUiEdgeId = (typeof OPENWEBUI_EDGE_IDS)[number];

/** The declared application execution graph (ACR-006 §1). */
export const OPENWEBUI_EXECUTION_GRAPH: ApplicationExecutionGraph = {
  edges: [
    {
      edgeId: "openwebui.chat.openai-rail",
      component:
        "backend/open_webui/routers/openai.py generate_chat_completions — the OpenAI-compatible chat seam every conversational turn rides (main.py chat_completion → the OpenAI router relay for openai/* model ids; routers/tasks.py generate_chat_title/tags/autocomplete/follow_ups/emoji all construct payloads and call the same generate_chat_completion with a metadata.task label; vision content parts ride the same seam) → POST {OPENAI_API_BASE_URLS}/chat/completions at the certified Zeck adapter",
      surface: "text-generation",
      transport:
        "OpenAI-compatible chat completions (JSON {model, messages, stream, temperature, …}; the app's own documented OPENAI_API_BASE_URLS/OPENAI_API_KEYS connection configuration — zero code changes, api_key the non-empty placeholder the client requires)",
      externalExecution:
        "the configured provider's chat-completions endpoint (undelegated default: https://api.openai.com/v1/chat/completions; any OpenAI-compatible remote the customer configures)",
      materiality:
        "the primary conversation surface: every user-facing chat turn, every auxiliary model turn (title, tags, autocomplete, follow-ups) and vision input flows through this ONE provider seam — routing only a 'chat model' and leaving this seam direct would leave the application's whole conversational intelligence provider-owned; the auxiliary task turns have no separate provider resolution under the certified configuration (the task model defaults to the chat model), so no second AI client exists on the certified path",
    },
    {
      edgeId: "openwebui.chat.local-rail",
      component:
        "backend/open_webui/routers/ollama.py — the LOCAL-INFERENCE RAIL: the Ollama-native protocol seam (GET {OLLAMA_BASE_URLS}/api/tags model-catalog probe + POST {OLLAMA_BASE_URLS}/api/chat for ollama/<model> chat ids + the app's own /api/v1/ollama/embed proxy over POST {url}/api/embed), the exact 'customer/local inference' path the work order names (Ollama-style local model endpoints)",
      surface: "text-generation",
      transport:
        "Ollama-native JSON (GET /api/tags; POST /api/chat {model, messages, stream:false} → {message:{content}}; POST /api/embed {model, input:[…]} → {embeddings:[[…]]}) pointed at the certified Zeck adapter's Ollama-native surface through the app's own documented OLLAMA_BASE_URLS configuration — the local rail is delegated through the SAME ACR-007 execution contract as the remote rail (identical Zeck task kind, lifecycle, evidence), never a bypass category",
      externalExecution:
        "a customer-local Ollama server (undelegated default: http://localhost:11434 — the bundled local model daemon; any remote OpenAI-compatible endpoint the customer configures as an 'Ollama' connection)",
      materiality:
        "THE local-vs-remote inference law (binding, from the work order): customer/local inference is a Zeck EXECUTION RAIL when delegated — it is NOT an automatic bypass category. The corpus exercises this rail end-to-end (chat with an ollama/* model id + an /api/embed call through the app's own Ollama proxy), and the delegation boundary covers it exactly like a remote provider edge: the adapter's Ollama-native surface translates to the same Zeck execution contract with the same lifecycle, evidence and egress controls as the OpenAI-shaped chat seam",
    },
    {
      edgeId: "openwebui.rag.embeddings",
      component:
        "backend/open_webui/retrieval/utils.py get_embedding_function(RAG_EMBEDDING_ENGINE=openai) → agenerate_openai_batch_embeddings → POST {RAG_OPENAI_API_BASE_URL}/embeddings {input:[texts], model} (document-chunk indexing, query embedding, and the memories feature's embedding calls); the Ollama-shaped sibling agenerate_ollama_batch_embeddings → POST {url}/api/embed {model, input, truncate} (same declared edge, the other wire shape)",
      surface: "embeddings",
      transport:
        "OpenAI-compatible embeddings JSON ({input, model} → {data:[{embedding}]}) and Ollama-native embed JSON ({model, input} → {embeddings}) at the certified Zeck adapter — the app's own documented RAG_EMBEDDING_ENGINE/RAG_OPENAI_API_BASE_URL configuration",
      externalExecution:
        "the configured provider's embeddings endpoint (undelegated default: https://api.openai.com/v1/embeddings; or a local Ollama /api/embed; or the local SentenceTransformers engine when RAG_EMBEDDING_ENGINE is unset — see the dormant seams)",
      materiality:
        "every RAG journey and every memory search depends on this seam — a delegation that left embeddings direct would leave the application's whole knowledge surface provider-owned (the completeness rule: an application is not complete because its chat uses Zeck while its embedding path bypasses Zeck). THE EXECUTION REPRESENTATION at the pinned supply: the authorized GLM supply exposes no embeddings surface (probed live: POST /embeddings → 404, the identical boundary PPR-021 recorded), so the Zeck-side executor runs the DETERMINISTIC lexical-hash embedding strategy (real, deterministic, reproducible; strategyClass 'deterministic-embeddings', modelCalls 0, mechanically verified) — a disclosed representation choice, never a fixture; a model-backed embeddings rail remains the named operator-provider boundary (owner: Lead)",
    },
    {
      edgeId: "openwebui.images.openai-generate",
      component:
        "backend/open_webui/routers/images.py image_generations with IMAGE_GENERATION_ENGINE=openai → POST {IMAGES_OPENAI_API_BASE_URL}/images/generations {model, prompt, size, …} → {data:[{url|b64_json}]} rendered back through the app's own image API (file storage + response)",
      surface: "image-generation",
      transport:
        "OpenAI-compatible image generations JSON at the certified Zeck adapter — the app's own documented IMAGE_GENERATION_ENGINE/IMAGES_OPENAI_API_BASE_URL configuration",
      externalExecution:
        "the configured image provider's generations endpoint (undelegated default: https://api.openai.com/v1/images/generations; the Gemini/ComfyUI/Automatic1111 engines are separate dormant seams)",
      materiality:
        "the image-generation surface of a multi-surface AI gateway is a material AI edge the work order names explicitly ('image generation … must be delegated through the ACR-007 boundary or remain a NAMED INCOMPLETENESS') — a proof that certified chat while image generation stayed direct would be exactly the chat-only certification the work order forbids",
    },
    {
      edgeId: "openwebui.audio.stt-openai",
      component:
        "backend/open_webui/routers/audio.py _transcribe_openai (audio.stt.engine=openai) → POST {audio.stt.openai.api_base_url}/audio/transcriptions (multipart {file, model} or json {model, input_audio:{data,format}} per the app's audio.stt.openai.api_request_format) → {text}",
      surface: "speech-recognition",
      transport:
        "OpenAI-compatible audio transcriptions (multipart or JSON) at the certified Zeck adapter — the app's own documented audio.stt configuration",
      externalExecution:
        "the configured STT provider's transcriptions endpoint (undelegated default: https://api.openai.com/v1/audio/transcriptions; the local faster-whisper and Deepgram/Azure/Mistral engines are dormant seams)",
      materiality:
        "the speech-recognition surface of a multi-surface AI gateway is a material AI edge the work order names explicitly (STT/TTS must be delegated or remain a NAMED INCOMPLETENESS) — the corpus transcribes the committed known-phrase asset through the app's own audio API",
    },
    {
      edgeId: "openwebui.audio.tts-openai",
      component:
        "backend/open_webui/routers/audio.py _tts_openai (audio.tts.engine=openai) → POST {audio.tts.openai.api_base_url}/audio/speech {model, input, voice, speed, response_format} → audio bytes cached + returned by the app's own speech API",
      surface: "speech-generation",
      transport:
        "OpenAI-compatible speech synthesis JSON → audio bytes at the certified Zeck adapter — the app's own documented audio.tts configuration",
      externalExecution:
        "the configured TTS provider's speech endpoint (undelegated default: https://api.openai.com/v1/audio/speech; the ElevenLabs/azure/local engines are dormant seams)",
      materiality:
        "the speech-generation surface of a multi-surface AI gateway is a material AI edge the work order names explicitly — the corpus synthesizes a known sentence through the app's own speech API and the mechanical check verifies non-empty audio bytes",
    },
  ],
};

/**
 * The DISCOVERED edge inventory: the static seam scan of the pinned
 * revision, restricted to the declared corpus configuration (the standard
 * profile with every AI engine configured to the adapter: OpenAI
 * connections at the adapter, Ollama connections at the adapter's
 * Ollama-native surface, RAG_EMBEDDING_ENGINE=openai, no web-search
 * providers, no pipelines, no external tools/functions, no reranking
 * model, no local-model engine selected).
 *
 * The scan enumerated every AI-client construction seam reachable under
 * that configuration (the OpenAI-compatible client call sites across
 * routers/openai.py, routers/tasks.py, utils/middleware.py,
 * retrieval/utils.py, routers/images.py, routers/audio.py; the
 * Ollama-native call sites across routers/ollama.py and
 * retrieval/utils.py; the local-model engine modules the standard profile
 * makes importable); each discovered edge is claimed by exactly one
 * declared edge or disclosed as a dormant seam below (reconciled by edge
 * id and by component+surface+external chain).
 */
export const OPENWEBUI_DISCOVERED_INVENTORY: DiscoveredEdgeInventory = {
  source:
    "static seam scan of pinned Open WebUI 8bd8b4fac5e059578ac0c74b3c18d11139f88b7d (AI-client call-site grep across backend/open_webui: routers/openai.py chat-completions relay + generate_chat_completions, routers/tasks.py generate_chat_* → generate_chat_completion, utils/middleware.py chat event stream, main.py chat_completion pipeline, retrieval/utils.py agenerate_openai_batch_embeddings + agenerate_ollama_batch_embeddings + get_embedding_function engines, routers/ollama.py /api/tags + /api/chat + /api/embed relays, routers/images.py image_generations engines, routers/audio.py _tts_openai + _transcribe_openai + the local/alternative engines, routers/memories.py embedding calls, storage/provider.py; reachability restricted to the declared corpus configuration: all engines at the adapter, no search providers, no pipelines, no external functions/tools, no reranking model, no local-model engine selected)",
  edges: [
    {
      edgeId: "openwebui.chat.openai-rail",
      component:
        "the OpenAI-compatible chat seam — routers/openai.py generate_chat_completions (POST {url}/chat/completions over aiohttp trust_env) reached by main.py chat_completion for openai/* model ids, by every routers/tasks.py auxiliary turn (title/tags/autocomplete/follow-up/emoji) and by vision content parts (multimodal messages)",
      surface: "text-generation",
      transport: "OpenAI-compatible chat completions JSON (+ SSE streaming tolerated)",
      externalExecution:
        "the configured provider's chat-completions endpoint (undelegated: api.openai.com or any customer-configured OpenAI-compatible base)",
      materiality: "declared edge (the primary conversational seam — the target matrix's 'configurable provider/base-URL paths' itself)",
    },
    {
      edgeId: "openwebui.chat.local-rail",
      component:
        "the Ollama-native seam — routers/ollama.py (GET {url}/api/tags, POST {url}/api/chat, POST {url}/api/embed) reached by main.py chat_completion for ollama/* model ids and by the app's own /api/v1/ollama/* proxy routes",
      surface: "text-generation",
      transport:
        "Ollama-native JSON (tags/chat/embed); delegated: the adapter's Ollama-native surface → the same Zeck execution contract as the remote rail",
      externalExecution:
        "a customer-local Ollama server (undelegated: http://localhost:11434 — the local model daemon)",
      materiality:
        "declared edge (THE local-inference rail — the work order's binding law that local inference is a Zeck execution rail when delegated, never an automatic bypass category)",
    },
    {
      edgeId: "openwebui.rag.embeddings",
      component:
        "the embeddings seam — retrieval/utils.py get_embedding_function + agenerate_openai_batch_embeddings (POST {url}/embeddings) / agenerate_ollama_batch_embeddings (POST {url}/api/embed), exercised by document indexing (routers/retrieval.py + knowledge/files), query embedding (query_embeddings in retrieval/utils.py) and routers/memories.py memory embedding/search",
      surface: "embeddings",
      transport:
        "OpenAI-compatible embeddings JSON + Ollama-native embed JSON; delegated to the adapter, executed by the Zeck-side deterministic lexical-hash embeddings strategy (the supply's 404 boundary, disclosed)",
      externalExecution:
        "the configured provider's embeddings endpoint (undelegated: api.openai.com/v1/embeddings, a local Ollama /api/embed, or the local SentenceTransformers engine — the last a dormant seam)",
      materiality: "declared edge (every RAG and memory journey depends on it)",
    },
    {
      edgeId: "openwebui.images.openai-generate",
      component:
        "the image-generation seam — routers/images.py image_generations with IMAGE_GENERATION_ENGINE=openai (POST {IMAGES_OPENAI_API_BASE_URL}/images/generations)",
      surface: "image-generation",
      transport: "OpenAI-compatible image generations JSON",
      externalExecution:
        "the configured image provider's endpoint (undelegated: api.openai.com/v1/images/generations; Gemini/ComfyUI/Automatic1111 engines dormant)",
      materiality: "declared edge (the image-generation surface the work order names)",
    },
    {
      edgeId: "openwebui.audio.stt-openai",
      component:
        "the STT seam — routers/audio.py _transcribe_openai (POST {audio.stt.openai.api_base_url}/audio/transcriptions, multipart or JSON body)",
      surface: "speech-recognition",
      transport: "OpenAI-compatible audio transcriptions (multipart/JSON)",
      externalExecution:
        "the configured STT provider's endpoint (undelegated: api.openai.com/v1/audio/transcriptions; whisper-local/Deepgram/Azure/Mistral dormant)",
      materiality: "declared edge (the speech-recognition surface the work order names)",
    },
    {
      edgeId: "openwebui.audio.tts-openai",
      component:
        "the TTS seam — routers/audio.py _tts_openai (POST {audio.tts.openai.api_base_url}/audio/speech → audio bytes)",
      surface: "speech-generation",
      transport: "OpenAI-compatible speech synthesis JSON → audio bytes",
      externalExecution:
        "the configured TTS provider's endpoint (undelegated: api.openai.com/v1/audio/speech; ElevenLabs/azure/local engines dormant)",
      materiality: "declared edge (the speech-generation surface the work order names)",
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

export const OPENWEBUI_DORMANT_SEAMS: readonly DormantSeamDisclosure[] = [
  {
    edgeId: "openwebui.rag.local-embedding-engine",
    component:
      "retrieval/utils.py get_embedding_function with RAG_EMBEDDING_ENGINE unset — the LOCAL SentenceTransformers embedding engine (model download from the HuggingFace hub + in-process inference)",
    surface: "embeddings",
    gate:
      "the certified configuration sets RAG_EMBEDDING_ENGINE=openai pointed at the Zeck adapter (the app's own documented engine axis); the local engine is never selected, and its HuggingFace model download would be egress-denied by the proof environment's default-deny proxy regardless. Disclosed as a deliberately-unselected local-model engine, never a second AI path",
    owner:
      "classification: configuration-gated dormant seam (owner: worker, disclosed); future delegation owner: worker (the delegated embeddings edge already covers the surface class)",
  },
  {
    edgeId: "openwebui.audio.stt-local-whisper",
    component:
      "routers/audio.py _transcribe_whisper — the LOCAL faster-whisper transcription engine (faster-whisper model download + in-process inference)",
    surface: "speech-recognition",
    gate:
      "the certified configuration sets audio.stt.engine=openai pointed at the Zeck adapter; the whisper-local engine is never selected (and its model download would be egress-denied regardless)",
    owner: "classification: configuration-gated dormant seam (owner: worker, disclosed)",
  },
  {
    edgeId: "openwebui.audio.alternative-engines",
    component:
      "routers/audio.py alternative STT/TTS engines — Deepgram, Azure, Mistral STT; ElevenLabs, Azure, local/piper TTS (each a distinct provider client with its own credentials/base URLs)",
    surface: "speech-recognition",
    gate:
      "no credentials exist for any of these providers in the scrubbed credential-free environment (ACR-007 §5 erasure) and the certified configuration selects the openai engine at the adapter for both directions; every alternative engine is unreachable under the declared corpus",
    owner:
      "operator-provider boundary (no provider credentials by erasure design; the certified configuration never selects an alternative engine)",
  },
  {
    edgeId: "openwebui.images.alternative-engines",
    component:
      "routers/images.py alternative image engines — Gemini image, ComfyUI, Automatic1111 (and the openai image-EDIT endpoint class images.edit.*)",
    surface: "image-generation",
    gate:
      "the certified configuration sets IMAGE_GENERATION_ENGINE=openai at the adapter; no ComfyUI/Automatic1111/Gemini endpoints or credentials exist in the scrubbed environment; image EDIT is not exercised by the declared corpus (its engine configuration class routes through the same adapter seam if ever enabled)",
    owner:
      "operator-provider boundary (no alternative-engine credentials/endpoints by erasure design; image-edit not exercised — disclosed, owner: worker)",
  },
  {
    edgeId: "openwebui.rag.rerank-local",
    component:
      "retrieval/utils.py get_reranking_function — the local cross-encoder reranker (SentenceTransformers) and the 'external' reranking engine",
    surface: "reranking",
    gate:
      "the certified configuration sets no reranking model (RAG_RERANKING_MODEL empty) — the app's own documented axis — so retrieval scores by cosine similarity over the delegated embeddings (plus the app's own hybrid BM25 when enabled); the reranker is never constructed",
    owner: "classification: configuration-gated dormant seam (owner: worker, disclosed)",
  },
  {
    edgeId: "openwebui.websearch",
    component:
      "retrieval/web/search providers — SearxNG, Google PSE, Brave, Serper, SerpAPI, DuckDuckGo, Perplexity, Jina, Bing, Exa, Firecrawl, Kagi, SearchAPI, Tavily, Wikimedia and the web loaders (the app's web-search RAG feature)",
    surface: "search / AI search",
    gate:
      "the certified configuration sets no search provider (RAG_WEB_SEARCH_ENGINE empty) and carries no search credentials; the web-search RAG feature is never exercised by the declared corpus (a plain deterministic HTTP fetch — the web_loader — is classified non-AI and is also egress-denied)",
    owner:
      "operator-provider boundary (no search-provider credentials by erasure design; web search is out of the declared corpus and disclosed)",
  },
  {
    edgeId: "openwebui.pipelines-external-rag",
    component:
      "routers/pipelines.py + retrieval/models/external.py — the Open WebUI Pipelines framework and the external RAG pipeline (remote tool/pipeline servers that can be AI-backed)",
    surface: "agent delegation",
    gate:
      "the certified configuration registers no pipelines URL and no external RAG pipeline (the app's own configuration axes are unset); no pipeline client is constructed under the declared corpus",
    owner: "classification: configuration-gated dormant seam (owner: worker, disclosed)",
  },
  {
    edgeId: "openwebui.functions-tools",
    component:
      "the tools/functions system (routers/functions.py, routers/tools.py) — app-owned Python code the user can install; a function/tool MAY call model APIs internally (the chat-completions template ships one)",
    surface: "agent delegation",
    gate:
      "the certified runtime installs no external functions or tools (the app's own frontmatter-requirements install surface runs empty at boot); any model call a future tool made would ride the already-delegated chat seams — the certified corpus exercises the stock app only",
    owner: "classification: configuration-gated dormant seam (owner: worker, disclosed)",
  },
  {
    edgeId: "openwebui.ollama.direct-localhost",
    component:
      "the Ollama connection default — OLLAMA_BASE_URL=http://localhost:11434 / the bundled 'ollama serve' daemon (a customer-local model server outside the delegation boundary)",
    surface: "text-generation",
    gate:
      "the certified configuration sets OLLAMA_BASE_URLS to the Zeck adapter's Ollama-native surface (the app's own documented connection axis) — no direct local daemon exists in the proof environment, and any non-loopback Ollama host would be egress-denied by the default-deny proxy; the local rail is DELEGATED (see the declared openwebui.chat.local-rail edge), never bypassed",
    owner:
      "classification: delegated-by-configuration (the local-inference rail rides the adapter — the work order's local-vs-remote law, satisfied)",
  },
  {
    edgeId: "openwebui.telemetry-version",
    component:
      "the app's own non-AI outbound endpoints — the posthog telemetry client, the GitHub release version check, the update probes",
    surface: "deterministic-computation",
    gate:
      "telemetry/update checks are disabled by the certified configuration (the app's own ENABLE_VERSION_UPDATE_CHECK / posthog axes) and are plain HTTP probes with NO model call — classified non-AI at the pinned revision, egress-denied by the proof environment regardless",
    owner:
      "classification: non-AI telemetry/update endpoints, disabled by configuration and egress-denied (owner: worker, disclosed)",
  },
];

/**
 * The non-AI operations Open WebUI retains as application/domain
 * capabilities (the work order: "Preserve Open WebUI's own
 * workspace/document/domain state responsibilities") — each verified to
 * make NO model call and NO direct AI-provider request of its own on the
 * certified path (every AI turn rides the declared edges).
 */
export const OPENWEBUI_NON_AI_OPERATIONS: readonly {
  readonly name: string;
  readonly note: string;
}[] = [
  {
    name: "RAG retrieval scoring (cosine + hybrid BM25)",
    note:
      "the app's own deterministic scoring over the delegated embedding vectors — domain logic (rank-bm25 is the app's own dependency); both the vectors and the query embedding come from the delegated embeddings edge",
  },
  {
    name: "document/knowledge workspace state (sqlite + chroma vector store + uploads)",
    note:
      "files, knowledge bases, chunk stores and the vector DB are Open WebUI's own domain state — outside Zeck by design (ACR-006 completeness rule)",
  },
  {
    name: "user/auth/chat domain state + the admin signup journey",
    note:
      "accounts, JWT auth, chat history, folders, channels — application domain state, no AI calls",
  },
  {
    name: "prompt templates, pipeline filters, task templates",
    note:
      "deterministic string construction from the app's own templates — the model turn itself rides the delegated chat edge",
  },
  {
    name: "model catalog merge + the /api/models projection",
    note:
      "merging the OpenAI /v1/models and Ollama /api/tags catalogs into the app's model list — deterministic inventory reads (the adapter serves both catalog probes without model execution)",
  },
  {
    name: "audio file caching + format passthrough",
    note:
      "the TTS response cache and the transcription upload flow — file plumbing around the delegated audio edges",
  },
  {
    name: "telemetry / logging (disabled)",
    note:
      "local logging and the disabled telemetry probes — non-AI, configuration-disabled, egress-denied",
  },
];
