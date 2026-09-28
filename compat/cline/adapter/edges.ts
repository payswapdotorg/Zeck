/**
 * Request→edge attribution for the PPR-019 adapter: every inbound
 * OpenAI-compatible chat-completions request the pinned Cline runtime
 * sends is attributed to exactly one declared execution-graph edge.
 *
 * The attribution is CONTENT-DERIVED and deterministic, from the signals
 * Cline itself puts on the wire at the pinned revision:
 *
 *  1. the agentic-compaction summarizer's fixed system prompt
 *     (@cline/core agentic-compaction.ts: "Summarize the provided
 *     coding session into a concise continuation note…") →
 *     cline.compaction.agentic;
 *  2. multimodal content parts (image_url) in any message →
 *     cline.agent-loop.vision;
 *  3. a reasoning-effort control (the wire field the AI SDK
 *     openai-compatible client emits for CLI --thinking) →
 *     cline.agent-loop.reasoning;
 *  4. the plan-mode contract marker in the system prompt
 *     (@cline/shared prompt/system: "# Plan Mode") →
 *     cline.agent-loop.plan;
 *  5. otherwise → cline.agent-loop.act (the act-mode default — also the
 *     attribution for delegated subagent/teammate loops, which ride the
 *     same handler-factory seam; their model calls are delegated through
 *     the same adapter edge regardless of which agent runtime made
 *     them).
 *
 * The precedence is fixed and disclosed (compaction > vision >
 * reasoning > plan > act); the declared corpus tasks are designed to
 * exercise each edge through requests whose primary class is unambiguous.
 */

import { CLINE_EDGE_IDS, type ClineEdgeId } from "../graph/execution-graph";

/** The pinned Cline compaction summarizer's fixed system prompt prefix. */
const COMPACTION_SYSTEM_MARKER =
  "Summarize the provided coding session into a concise continuation note";

/** The pinned plan-mode contract marker (@cline/shared system prompt). */
const PLAN_MODE_MARKER = "# Plan Mode";

/** The minimal OpenAI-format message shape the attribution inspects. */
export interface WireMessage {
  readonly role: string;
  readonly content: unknown;
}

/** The minimal request shape the attribution inspects. */
export interface AttributionInput {
  readonly messages: readonly WireMessage[];
  readonly reasoningEffort?: unknown;
}

export interface EdgeAttribution {
  readonly edgeId: ClineEdgeId;
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
 * Attribute one inbound request to its declared edge (the deterministic
 * precedence above). Total: every request maps to exactly one edge.
 */
export function attributeEdge(input: AttributionInput): EdgeAttribution {
  const signals: string[] = [];
  const systemText = textOf(
    input.messages.find((message) => message.role === "system")?.content,
  );
  const anyImage = input.messages.some((message) => hasImagePart(message.content));
  const reasoningEffort =
    typeof input.reasoningEffort === "string" && input.reasoningEffort.length > 0
      ? input.reasoningEffort
      : null;

  if (systemText.includes(COMPACTION_SYSTEM_MARKER)) {
    signals.push("compaction-system-prompt");
    return { edgeId: "cline.compaction.agentic", role: "auxiliary", signals };
  }
  if (anyImage) {
    signals.push("image-content-parts");
    return { edgeId: "cline.agent-loop.vision", role: "main", signals };
  }
  if (reasoningEffort !== null) {
    signals.push(`reasoning-effort:${reasoningEffort}`);
    return { edgeId: "cline.agent-loop.reasoning", role: "main", signals };
  }
  if (systemText.includes(PLAN_MODE_MARKER)) {
    signals.push("plan-mode-system-prompt");
    return { edgeId: "cline.agent-loop.plan", role: "main", signals };
  }
  signals.push("act-mode-default");
  return { edgeId: "cline.agent-loop.act", role: "main", signals };
}

/** Every edge id the adapter may attribute (the closed declared set). */
export const ADAPTER_EDGE_IDS: readonly ClineEdgeId[] = CLINE_EDGE_IDS;
