/**
 * Request→edge attribution for the PPR-023 adapter: every inbound
 * request the pinned OpenClaw runtime sends is attributed to exactly
 * one declared execution-graph edge.
 *
 * The attribution is CONTENT-DERIVED and deterministic, from the signals
 * OpenClaw itself puts on the wire at the pinned revision:
 *
 *  CHAT COMPLETIONS (POST {base}/chat/completions):
 *   1. any message carrying image content parts AND the request's
 *      tools/model context indicating a media-understanding entry →
 *      openclaw.media-understanding.image (the tools.media.models[]
 *      image-capable entry routes its describe calls through chat
 *      completions with image parts and a fixed describe prompt);
 *   2. any message carrying image content parts without the
 *      media-understanding marker (browser screenshots / native vision
 *      input riding the main agent loop) → the SAME vision-capable
 *      surface is still the correct edge: the native-vision path feeds
 *      image parts to the reply model through the main seam — attributed
 *      to openclaw.agent-loop.main (the intelligence of the agent turn
 *      itself);
 *   3. otherwise → openclaw.agent-loop.main (the primary agent loop —
 *      also the attribution for compaction-summarization turns,
 *      subagent/delegation turns and any other conversation riding the
 *      same seam: OpenClaw's ONE model client construction seam).
 *
 *  MEDIA ENDPOINTS (attributed by path — each is its own tool surface):
 *   - POST {base}/audio/speech         → openclaw.tool.tts-openai
 *   - POST {base}/audio/transcriptions → openclaw.media-understanding.audio
 *   - POST {base}/images/generations   → openclaw.tool.image-generate-openai
 *
 * The precedence is fixed and disclosed (media-understanding-image >
 * main); the declared corpus tasks are designed to exercise each edge
 * through requests whose primary class is unambiguous.
 */

import { OPENCLAW_EDGE_IDS, type OpenClawEdgeId } from "../graph/execution-graph";

/**
 * The pinned media-understanding describe prompt's marker (the
 * capability default the image entries carry at the pinned revision —
 * `tools.media.image.prompt`'s documented default shape).
 */
const MEDIA_DESCRIBE_MARKER = "Describe the image";

/** The minimal OpenAI-format message shape the attribution inspects. */
export interface WireMessage {
  readonly role: string;
  readonly content: unknown;
}

/** The minimal request shape the attribution inspects. */
export interface AttributionInput {
  readonly messages: readonly WireMessage[];
  /** The model id the runtime requested (the media-understanding entry's model). */
  readonly model?: string;
}

export interface EdgeAttribution {
  readonly edgeId: OpenClawEdgeId;
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
  const allText = input.messages
    .map((message) => textOf(message.content))
    .join("\n")
    .slice(0, 4000);
  const anyImage = input.messages.some((message) => hasImagePart(message.content));

  if (anyImage) {
    if (allText.includes(MEDIA_DESCRIBE_MARKER)) {
      signals.push("media-understanding-describe-prompt+image-parts");
      return { edgeId: "openclaw.media-understanding.image", role: "auxiliary", signals };
    }
    // Native-vision input riding the main agent loop (browser
    // screenshots, attached images passed natively to the reply model).
    signals.push("image-content-parts-main-loop");
    return { edgeId: "openclaw.agent-loop.main", role: "main", signals };
  }
  signals.push("agent-loop-default");
  return { edgeId: "openclaw.agent-loop.main", role: "main", signals };
}

/** The media endpoints' path-derived attributions (one per tool surface). */
export const MEDIA_EDGE_BY_PATH: Readonly<Record<string, OpenClawEdgeId>> = {
  "audio/speech": "openclaw.tool.tts-openai",
  "audio/transcriptions": "openclaw.media-understanding.audio",
  "images/generations": "openclaw.tool.image-generate-openai",
};

/** The individual media-edge constants (index-signature-safe consumers). */
export const TTS_EDGE_ID: OpenClawEdgeId = "openclaw.tool.tts-openai";
export const STT_EDGE_ID: OpenClawEdgeId = "openclaw.media-understanding.audio";
export const IMAGE_EDGE_ID: OpenClawEdgeId = "openclaw.tool.image-generate-openai";

/** Every edge id the adapter may attribute (the closed declared set). */
export const ADAPTER_EDGE_IDS: readonly OpenClawEdgeId[] = OPENCLAW_EDGE_IDS;
