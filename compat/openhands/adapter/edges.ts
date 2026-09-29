/**
 * Request→edge attribution for the PPR-020 adapter: every inbound
 * OpenAI-compatible chat-completions request the pinned OpenHands runtime
 * sends is attributed to exactly one declared execution-graph edge.
 *
 * The attribution is CONTENT-DERIVED and deterministic, from the signals
 * OpenHands itself puts on the wire at the pinned revision:
 *
 *  1. the ask-oracle tool's fixed Oracle system prompt
 *     (openhands.tools.ask_oracle.impl._ORACLE_SYSTEM_PROMPT:
 *     "You are the Oracle: a highly capable reviewer giving a second
 *     opinion to an OpenHands agent…") → openhands.tool.ask-oracle;
 *  2. the LLMSummarizingCondenser's fixed summarization prompt
 *     (context/condenser/prompts/summarizing_prompt.j2:
 *     "You are maintaining a context-aware state summary for an
 *     interactive agent…") → openhands.condenser.llm-summarize;
 *  3. a built-in sub-agent definition's fixed system prompt (the task
 *     tool set spawns sub-agents whose system prompt IS the agent
 *     definition markdown: "You are a codebase exploration
 *     specialist…" / "You are a command-line execution specialist…")
 *     → openhands.subagent.task-loop;
 *  4. multimodal content parts (image_url) in any message →
 *     openhands.agent-loop.vision;
 *  5. otherwise → openhands.agent-loop.main (the primary agent loop —
 *     also the attribution for any follow-up turn, the finish/think
 *     builtin tool decisions and workflow-driven loops riding the same
 *     seam; their model calls are delegated through the same adapter
 *     edge regardless of which agent runtime made them).
 *
 * The precedence is fixed and disclosed (oracle > condenser > subagent >
 * vision > main); the declared corpus tasks are designed to exercise each
 * edge through requests whose primary class is unambiguous.
 */

import { OPENHANDS_EDGE_IDS, type OpenHandsEdgeId } from "../graph/execution-graph";

/** The pinned ask-oracle tool's fixed system prompt prefix. */
const ORACLE_SYSTEM_MARKER = "You are the Oracle: a highly capable reviewer";

/** The pinned condenser's fixed summarization prompt prefix. */
const CONDENSER_SYSTEM_MARKER =
  "You are maintaining a context-aware state summary for an interactive agent";

/** The built-in + seeded sub-agent definitions' fixed system-prompt prefixes. */
const SUBAGENT_SYSTEM_MARKERS = [
  "You are a codebase exploration specialist",
  "You are a command-line execution specialist",
  "You are a workspace exploration specialist",
] as const;

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
  readonly edgeId: OpenHandsEdgeId;
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
 *
 * ROLE NOTE (disclosed): the pinned ask-oracle consult sends its fixed
 * Oracle prompt as a SYSTEM message; the pinned condenser sends its
 * summarization prompt as a SINGLE USER message (llm_summarizing_
 * condenser.py: `Message(role="user", content=[TextContent(prompt)])`)
 * — the attribution therefore checks the oracle marker in the system
 * message and the condenser marker as a user-message prefix.
 */
export function attributeEdge(input: AttributionInput): EdgeAttribution {
  const signals: string[] = [];
  const systemText = textOf(
    input.messages.find((message) => message.role === "system")?.content,
  );
  const anyImage = input.messages.some((message) => hasImagePart(message.content));
  const firstUserText = textOf(
    input.messages.find((message) => message.role === "user")?.content,
  );

  if (systemText.includes(ORACLE_SYSTEM_MARKER)) {
    signals.push("oracle-system-prompt");
    return { edgeId: "openhands.tool.ask-oracle", role: "auxiliary", signals };
  }
  if (firstUserText.startsWith(CONDENSER_SYSTEM_MARKER)) {
    signals.push("condenser-user-prompt");
    return { edgeId: "openhands.condenser.llm-summarize", role: "auxiliary", signals };
  }
  const subagentMarker = SUBAGENT_SYSTEM_MARKERS.find((marker) =>
    systemText.includes(marker),
  );
  if (subagentMarker !== undefined) {
    signals.push(`subagent-system-prompt:${subagentMarker.slice(0, 40)}`);
    return { edgeId: "openhands.subagent.task-loop", role: "main", signals };
  }
  if (anyImage) {
    signals.push("image-content-parts");
    return { edgeId: "openhands.agent-loop.vision", role: "main", signals };
  }
  signals.push("agent-loop-default");
  return { edgeId: "openhands.agent-loop.main", role: "main", signals };
}

/** Every edge id the adapter may attribute (the closed declared set). */
export const ADAPTER_EDGE_IDS: readonly OpenHandsEdgeId[] = OPENHANDS_EDGE_IDS;
