/**
 * Request→edge attribution for the PPR-025 adapter: every inbound request
 * the pinned Open WebUI runtime sends is attributed to exactly one
 * declared execution-graph edge.
 *
 * The attribution is SURFACE-DERIVED and deterministic, from the wire
 * surfaces Open WebUI itself calls at the pinned revision:
 *
 *  OPENAI-COMPATIBLE SURFACE (POST {base}/v1/*):
 *   - /chat/completions (+ bare /chat/completions)
 *       → openwebui.chat.openai-rail (the ONE OpenAI chat seam — the
 *         main conversation turns, the auxiliary task turns, and vision
 *         content parts (recorded as an attribution signal — the vision
 *         MODALITY rides the same seam, exactly like PPR-023/024
 *         attributed native-vision input to the main edge).
 *         AUXILIARY-TURN ATTRIBUTION (disclosed): the app's task router
 *         pops `metadata` before the relay (routers/openai.py
 *         `payload.pop('metadata', None)`), so the task label never
 *         crosses the provider wire — the auxiliary role is attributed
 *         by the app's OWN task-template prompt signatures at the pinned
 *         revision (config.py's DEFAULT_*_GENERATION_PROMPT_TEMPLATE
 *         heads, matched deterministically on the first user message).
 *   - /embeddings
 *       → openwebui.rag.embeddings (the RAG/embedding seam)
 *   - /images/generations
 *       → openwebui.images.openai-generate
 *   - /audio/transcriptions
 *       → openwebui.audio.stt-openai
 *   - /audio/speech
 *       → openwebui.audio.tts-openai
 *
 *  OLLAMA-NATIVE SURFACE (the LOCAL-INFERENCE RAIL):
 *   - GET  /api/tags        → the local-rail catalog probe (non-AI)
 *   - POST /api/chat        → openwebui.chat.local-rail (THE local rail)
 *   - POST /api/embed       → openwebui.rag.embeddings (the Ollama-shaped
 *                             sibling of the embedding seam — the SAME
 *                             declared edge, per the execution graph)
 *
 *  CATALOG PROBES (GET {base}/models + {base}/api/tags — non-AI
 *  inventory reads, no execution).
 */

import { OPENWEBUI_EDGE_IDS, type OpenWebUiEdgeId } from "../graph/execution-graph";

export interface EdgeAttribution {
  readonly edgeId: OpenWebUiEdgeId;
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

/** The app's OWN task-template signatures at the pinned revision (the heads of config.py's DEFAULT_*_GENERATION_PROMPT_TEMPLATE bodies). */
const AUXILIARY_TASK_SIGNATURES: readonly { readonly label: string; readonly signature: string }[] = [
  {
    label: "title_generation",
    signature: "Generate a concise title summarizing the chat history.",
  },
  {
    label: "tags_generation",
    signature: "Generate 1-3 broad tags categorizing the main themes of the chat history",
  },
  {
    label: "follow_up_generation",
    signature: "Suggest 3-5 relevant follow-up questions or prompts",
  },
] as const;

/** The text of a message's content (string or text parts). */
function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && typeof (part as { readonly text?: unknown }).text === "string"
          ? (part as { readonly text: string }).text
          : "",
      )
      .join(" ");
  }
  return "";
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
  // The auxiliary task templates ride the first user message (the app's
  // task router constructs single-turn payloads from its own templates).
  const firstUser = input.messages.find((message) => message.role === "user");
  const firstUserText = firstUser === undefined ? "" : textOf(firstUser.content);
  for (const task of AUXILIARY_TASK_SIGNATURES) {
    if (firstUserText.includes(task.signature)) {
      signals.push(`auxiliary-task:${task.label}`);
      return {
        edgeId: "openwebui.chat.openai-rail",
        role: "auxiliary",
        signals,
      };
    }
  }
  signals.push("chat-turn-default");
  return { edgeId: "openwebui.chat.openai-rail", role: "main", signals };
}

/** The chat-completion edge ids per rail (the closed declared set). */
export const CHAT_EDGE_BY_RAIL: Readonly<Record<"openai" | "ollama", OpenWebUiEdgeId>> = {
  openai: "openwebui.chat.openai-rail",
  ollama: "openwebui.chat.local-rail",
};

/** The individual edge constants (index-signature-safe consumers). */
export const OPENAI_CHAT_EDGE_ID: OpenWebUiEdgeId = "openwebui.chat.openai-rail";
export const LOCAL_RAIL_EDGE_ID: OpenWebUiEdgeId = "openwebui.chat.local-rail";
export const EMBEDDINGS_EDGE_ID: OpenWebUiEdgeId = "openwebui.rag.embeddings";
export const IMAGE_EDGE_ID: OpenWebUiEdgeId = "openwebui.images.openai-generate";
export const STT_EDGE_ID: OpenWebUiEdgeId = "openwebui.audio.stt-openai";
export const TTS_EDGE_ID: OpenWebUiEdgeId = "openwebui.audio.tts-openai";
export const MAIN_EDGE_ID: OpenWebUiEdgeId = "openwebui.chat.openai-rail";

/** Every edge id the adapter may attribute (the closed declared set). */
export const ADAPTER_EDGE_IDS: readonly OpenWebUiEdgeId[] = OPENWEBUI_EDGE_IDS;
