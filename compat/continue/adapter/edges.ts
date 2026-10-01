/**
 * Request→edge attribution for the PPR-021 adapter: every inbound
 * request the pinned Continue runtime sends is attributed to exactly
 * one declared execution-graph edge.
 *
 * The attribution is DETERMINISTIC and STRUCTURAL, from the two axes
 * Continue itself puts on every wire request:
 *
 *  1. The ENDPOINT names the Continue model-role surface (the wire
 *     surface the pinned runtime calls): POST {apiBase}/chat/completions
 *     (the chat-completions family — chat and subagent), POST
 *     {apiBase}/completions (the legacy text-completions endpoint the
 *     openai provider's streamComplete drives — the autocomplete FIM
 *     engine AND the edit/apply roles' streamDiffLines prompt path both
 *     call it; observed live at proof time: the edit/apply requests
 *     arrive on /v1/completions with the role model id), POST
 *     {apiBase}/embeddings (the embed role), POST {apiBase}/rerank (the
 *     rerank role).
 *  2. The MODEL ID names the configured role model: the corpus's
 *     config.yaml declares ONE model entry per role, each with its own
 *     role-identifying model id (Continue's own role-based model
 *     configuration surface) — the model id IS the role selector.
 *
 * The mapping is therefore closed and total over the declared corpus
 * configuration: (endpoint, model id) → edge. An unknown combination is
 * a named 400 (the adapter reports honestly; it never guesses an edge).
 */

import { CONTINUE_EDGE_IDS, type ContinueEdgeId } from "../graph/execution-graph";

/** The role-identifying model ids the corpus's config.yaml declares (the role selectors). */
export const CONTINUE_ROLE_MODELS = {
  chat: "zeck-chat",
  subagent: "zeck-subagent",
  edit: "zeck-edit",
  apply: "zeck-apply",
  autocomplete: "zeck-autocomplete",
  embed: "zeck-embed",
  rerank: "zeck-rerank",
} as const;

/** The minimal request shape the attribution inspects. */
export interface AttributionInput {
  /** The wire surface: "chat/completions" | "completions" | "embeddings" | "rerank". */
  readonly surface: "chat/completions" | "completions" | "embeddings" | "rerank";
  /** The model id the Continue runtime requested (the role selector). */
  readonly model: string;
}

export interface EdgeAttribution {
  readonly edgeId: ContinueEdgeId;
  readonly role: "main" | "auxiliary";
  /** The signals that produced the attribution (recorded as evidence facts). */
  readonly signals: readonly string[];
}

/** Every (surface, model) pair the adapter attributes (the closed mapping). */
const ATTRIBUTION_TABLE: Readonly<
  Record<`${AttributionInput["surface"]}:${string}`, EdgeAttribution>
> = {
  "chat/completions:zeck-chat": {
    edgeId: "continue.cli.agent-loop.chat",
    role: "main",
    signals: ["surface:chat-completions", "role-model:chat"],
  },
  "chat/completions:zeck-subagent": {
    edgeId: "continue.cli.subagent.child-session",
    role: "auxiliary",
    signals: ["surface:chat-completions", "role-model:subagent"],
  },
  "completions:zeck-edit": {
    edgeId: "continue.core.edit.inline-edit",
    role: "auxiliary",
    signals: ["surface:legacy-completions", "role-model:edit"],
  },
  "completions:zeck-apply": {
    edgeId: "continue.core.apply.fast-apply",
    role: "auxiliary",
    signals: ["surface:legacy-completions", "role-model:apply"],
  },
  "completions:zeck-autocomplete": {
    edgeId: "continue.core.autocomplete.tab",
    role: "main",
    signals: ["surface:legacy-completions", "role-model:autocomplete"],
  },
  "embeddings:zeck-embed": {
    edgeId: "continue.core.indexing.embed",
    role: "auxiliary",
    signals: ["surface:embeddings", "role-model:embed"],
  },
  "rerank:zeck-rerank": {
    edgeId: "continue.core.retrieval.rerank",
    role: "auxiliary",
    signals: ["surface:rerank", "role-model:rerank"],
  },
};

/** The task kind each surface maps to (the rail protocol's vocabulary). */
export const SURFACE_TASK_KINDS: Readonly<
  Record<AttributionInput["surface"], "continue-role.chat-completions" | "continue-role.completions" | "continue-role.embeddings" | "continue-role.rerank">
> = {
  "chat/completions": "continue-role.chat-completions",
  completions: "continue-role.completions",
  embeddings: "continue-role.embeddings",
  rerank: "continue-role.rerank",
};

/**
 * Attribute one inbound request to its declared edge. Returns null when
 * the (surface, model) pair is not in the closed mapping — the adapter
 * reports a named 400 (never a guessed attribution).
 */
export function attributeEdge(input: AttributionInput): EdgeAttribution | null {
  return ATTRIBUTION_TABLE[`${input.surface}:${input.model}`] ?? null;
}

/** Every edge id the adapter may attribute (the closed declared set). */
export const ADAPTER_EDGE_IDS: readonly ContinueEdgeId[] = CONTINUE_EDGE_IDS;
