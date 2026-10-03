/**
 * Request→edge attribution for the PPR-024 adapter: every inbound
 * request the pinned Browser Use runtime sends is attributed to exactly
 * one declared execution-graph edge.
 *
 * The attribution is CONTENT-DERIVED and deterministic, from the signals
 * Browser Use itself puts on the wire at the pinned revision:
 *
 *  CHAT COMPLETIONS (POST {base}/v1/chat/completions):
 *   - every chat-completions request rides the ONE model client
 *     construction seam — the agent step loop's structured AgentOutput
 *     turns, the judge turn, the page-extraction turns (including the
 *     ones issued from the substrate process) and the pure-model task's
 *     direct invocation all arrive identically here → attributed to
 *     browseruse.agent-loop.main (vision content parts recorded as an
 *     attribution signal — the vision MODALITY rides the same seam,
 *     exactly like PPR-023 attributed native-vision input to the main
 *     edge).
 *
 *  SUBSTRATE ENDPOINTS (attributed by operation — each is its own
 *  declared tool/substrate edge):
 *   - POST {base}/substrate/session {op: "open"|"close"}
 *       → browseruse.substrate.session
 *   - POST {base}/substrate/state
 *       → browseruse.substrate.state-extraction
 *   - POST {base}/substrate/action
 *       → browseruse.substrate.action
 */

import { BROWSER_USE_EDGE_IDS, type BrowserUseEdgeId } from "../graph/execution-graph";

export interface EdgeAttribution {
  readonly edgeId: BrowserUseEdgeId;
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
    signals.push("vision-content-parts-main-seam");
  }
  signals.push("agent-loop-default");
  return { edgeId: "browseruse.agent-loop.main", role: "main", signals };
}

/** The substrate endpoints' operation-derived attributions (one per edge). */
export const SUBSTRATE_EDGE_BY_OP: Readonly<Record<string, BrowserUseEdgeId>> = {
  "substrate/session": "browseruse.substrate.session",
  "substrate/state": "browseruse.substrate.state-extraction",
  "substrate/action": "browseruse.substrate.action",
};

/** The individual substrate-edge constants (index-signature-safe consumers). */
export const SESSION_EDGE_ID: BrowserUseEdgeId = "browseruse.substrate.session";
export const STATE_EDGE_ID: BrowserUseEdgeId = "browseruse.substrate.state-extraction";
export const ACTION_EDGE_ID: BrowserUseEdgeId = "browseruse.substrate.action";
export const MAIN_EDGE_ID: BrowserUseEdgeId = "browseruse.agent-loop.main";

/** Every edge id the adapter may attribute (the closed declared set). */
export const ADAPTER_EDGE_IDS: readonly BrowserUseEdgeId[] = BROWSER_USE_EDGE_IDS;
