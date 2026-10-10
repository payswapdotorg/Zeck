/**
 * Request→edge attribution for the PPR-026 adapter: every inbound request
 * the pinned AnythingLLM runtime sends is attributed to exactly one
 * declared execution-graph edge.
 *
 * The attribution is SURFACE-DERIVED and deterministic, from the wire
 * surfaces AnythingLLM itself calls at the pinned revision
 * (v1.17.0, fa7ec877f005a21ede94888b3b8618b700343857):
 *
 *  OPENAI-COMPATIBLE SURFACE (POST {base}/v1/* — the generic-openai
 *  provider connectors' openai-SDK baseURLs):
 *   - /chat/completions (+ bare /chat/completions)
 *       → anythingllm.chat.openai-rail (the ONE generic-OpenAI chat seam
 *         — every main conversation turn and vision content parts
 *         (recorded as an attribution signal — the vision MODALITY
 *         rides the same seam, exactly like PPR-023/024/025 attributed
 *         native-vision input to the main edge). At the pinned revision
 *         the server emits no auxiliary model turn on the developer-API
 *         path (no title/tags generation server calls — the naming
 *         surfaces are browser-side), so the auxiliary role is a
 *         protocol-level attribution capability the default never
 *         selects — kept for honest attribution if the app ever emits
 *         one.)
 *   - /embeddings
 *       → anythingllm.rag.embeddings (the RAG/embedding seam — document
 *         indexing AND query embedding)
 *   - /audio/transcriptions
 *       → anythingllm.audio.stt-generic (the STT connector's seam)
 *   - /audio/speech
 *       → anythingllm.audio.tts-generic (the TTS connector's seam)
 *
 *  OLLAMA-NATIVE SURFACE (the LOCAL-INFERENCE RAIL):
 *   - GET  /api/tags        → the local-rail catalog probe (non-AI)
 *   - POST /api/show        → the local-rail context-window probe (non-AI)
 *   - POST /api/chat        → anythingllm.chat.local-rail (THE local rail)
 *
 *  CATALOG PROBES (GET /api/tags + POST /api/show — non-AI inventory
 *  reads, no execution).
 */

import { ANYTHINGLLM_EDGE_IDS, type AnythingLlmEdgeId } from "../graph/execution-graph";

export interface EdgeAttribution {
  readonly edgeId: AnythingLlmEdgeId;
  readonly role: "main" | "auxiliary";
  /** The signals that produced the attribution (recorded as evidence facts). */
  readonly signals: readonly string[];
}

/** The minimal OpenAI-format message shape the attribution inspects. */
export interface WireMessage {
  readonly role: string;
  readonly content: unknown;
}

/** The minimal request shape the attribution inspects. */
export interface AttributionInput {
  readonly messages: readonly WireMessage[];
  /** The model id the runtime requested (attribution signal only). */
  readonly model?: string;
}

function hasImagePart(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (part) =>
      typeof part === "object" &&
      part !== null &&
      (part as { readonly type?: unknown }).type === "image_url",
  );
}

/**
 * Attribute one inbound chat-completions request to its declared edge
 * (the deterministic precedence above). Total: every request maps to
 * exactly one edge.
 */
export function attributeEdge(input: AttributionInput): EdgeAttribution {
  const signals: string[] = [];
  const anyImage = input.messages.some((message) => hasImagePart(message.content));
  if (anyImage) {
    signals.push("vision-content-parts-openai-rail");
  }
  // At the pinned revision the server-side developer-API path emits
  // single-role main turns (no auxiliary task templates exist server-side
  // — the naming surfaces are browser-side, disclosed in the execution
  // graph), so the auxiliary role is never selected on the certified path.
  signals.push("chat-turn-default");
  return { edgeId: "anythingllm.chat.openai-rail", role: "main", signals };
}

/** The chat-completion edge ids per rail (the closed declared set). */
export const CHAT_EDGE_BY_RAIL: Readonly<Record<"openai" | "ollama", AnythingLlmEdgeId>> = {
  openai: "anythingllm.chat.openai-rail",
  ollama: "anythingllm.chat.local-rail",
};

/** The individual edge constants (index-signature-safe consumers). */
export const OPENAI_CHAT_EDGE_ID: AnythingLlmEdgeId = "anythingllm.chat.openai-rail";
export const LOCAL_RAIL_EDGE_ID: AnythingLlmEdgeId = "anythingllm.chat.local-rail";
export const EMBEDDINGS_EDGE_ID: AnythingLlmEdgeId = "anythingllm.rag.embeddings";
export const STT_EDGE_ID: AnythingLlmEdgeId = "anythingllm.audio.stt-generic";
export const TTS_EDGE_ID: AnythingLlmEdgeId = "anythingllm.audio.tts-generic";
export const MAIN_EDGE_ID: AnythingLlmEdgeId = "anythingllm.chat.openai-rail";

/** Every edge id the adapter may attribute (the closed declared set). */
export const ADAPTER_EDGE_IDS: readonly AnythingLlmEdgeId[] = ANYTHINGLLM_EDGE_IDS;
