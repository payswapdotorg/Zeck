/**
 * Request→edge attribution for the PPR-022 adapter: every inbound
 * request the pinned Hermes-Agent runtime sends is attributed to exactly
 * one declared execution-graph edge.
 *
 * The attribution is CONTENT-DERIVED and deterministic, from the signals
 * Hermes itself puts on the wire at the pinned revision:
 *
 *  CHAT COMPLETIONS (POST {base}/chat/completions):
 *   1. the automatic session-title call's fixed system prompt
 *      (hermes_state_titles: "You name chat sessions. Given the user's
 *      opening message, write a title…") + its session_title
 *      json_schema response_format → hermes.auxiliary.title-generation;
 *   2. the context-compression summarizer's fixed prompt prefix
 *      (agent/context_compressor.py: "You are a summarization agent
 *      creating a context checkpoint.") → hermes.auxiliary.compression;
 *   3. any message carrying image content parts →
 *      hermes.auxiliary.vision-analyze (the aux vision call is the only
 *      image-carrying chat path under the certified configuration: the
 *      custom provider profile declares no native vision, so the
 *      vision_analyze tool takes the legacy aux-LLM path whose prompt
 *      begins "Fully describe and explain everything about this image");
 *   4. otherwise → hermes.agent-loop.main (the primary agent loop —
 *      also the attribution for subagent/delegation turns, cron-fired
 *      turns and any other conversation riding the same seam).
 *
 *  MEDIA ENDPOINTS (attributed by path — each is its own tool surface):
 *   - POST {base}/audio/speech       → hermes.tool.tts-openai
 *   - POST {base}/audio/transcriptions → hermes.tool.stt-openai
 *   - POST {base}/images/generations → hermes.tool.image-generate-openai
 *
 * The precedence is fixed and disclosed (title > compression > vision >
 * main); the declared corpus tasks are designed to exercise each edge
 * through requests whose primary class is unambiguous.
 */

import { HERMES_EDGE_IDS, type HermesEdgeId } from "../graph/execution-graph";

/** The pinned title-generation task's fixed system-prompt marker. */
const TITLE_SYSTEM_MARKER = "You name chat sessions.";

/** The pinned compression summarizer's fixed prompt prefix. */
const COMPRESSION_MARKER = "You are a summarization agent creating a context checkpoint.";

/** The pinned vision_analyze legacy path's fixed prompt prefix. */
const VISION_MARKER = "Fully describe and explain everything about this image";

/** The minimal OpenAI-format message shape the attribution inspects. */
export interface WireMessage {
  readonly role: string;
  readonly content: unknown;
}

/** The minimal request shape the attribution inspects. */
export interface AttributionInput {
  readonly messages: readonly WireMessage[];
}

export interface EdgeAttribution {
  readonly edgeId: HermesEdgeId;
  readonly role: "main" | "auxiliary";
  /** The signals that produced the attribution (recorded as evidence facts). */
  readonly signals: readonly string[];
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    let text = "";
    for (const part of content) {
      if (
        typeof part === "object" &&
        part !== null &&
        (part as { readonly type?: unknown }).type === "text" &&
        typeof (part as { readonly text?: unknown }).text === "string"
      ) {
        text += (part as { readonly text: string }).text;
      }
    }
    return text;
  }
  return "";
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
  const systemText = textOf(
    input.messages.find((message) => message.role === "system")?.content,
  );
  const anyImage = input.messages.some((message) => hasImagePart(message.content));
  const allText = input.messages
    .map((message) => textOf(message.content))
    .join("\n")
    .slice(0, 4000);

  if (systemText.includes(TITLE_SYSTEM_MARKER)) {
    signals.push("title-system-prompt");
    return { edgeId: "hermes.auxiliary.title-generation", role: "auxiliary", signals };
  }
  if (allText.startsWith(COMPRESSION_MARKER) || allText.includes(COMPRESSION_MARKER)) {
    signals.push("compression-prompt-prefix");
    return { edgeId: "hermes.auxiliary.compression", role: "auxiliary", signals };
  }
  if (anyImage) {
    signals.push(
      allText.includes(VISION_MARKER)
        ? "vision-analyze-prompt+image-parts"
        : "image-content-parts",
    );
    return { edgeId: "hermes.auxiliary.vision-analyze", role: "auxiliary", signals };
  }
  signals.push("agent-loop-default");
  return { edgeId: "hermes.agent-loop.main", role: "main", signals };
}

/** The media endpoints' path-derived attributions (one per tool surface). */
export const MEDIA_EDGE_BY_PATH: Readonly<Record<string, HermesEdgeId>> = {
  "audio/speech": "hermes.tool.tts-openai",
  "audio/transcriptions": "hermes.tool.stt-openai",
  "images/generations": "hermes.tool.image-generate-openai",
};

/** The individual media-edge constants (index-signature-safe consumers). */
export const TTS_EDGE_ID: HermesEdgeId = "hermes.tool.tts-openai";
export const STT_EDGE_ID: HermesEdgeId = "hermes.tool.stt-openai";
export const IMAGE_EDGE_ID: HermesEdgeId = "hermes.tool.image-generate-openai";

/** Every edge id the adapter may attribute (the closed declared set). */
export const ADAPTER_EDGE_IDS: readonly HermesEdgeId[] = HERMES_EDGE_IDS;
