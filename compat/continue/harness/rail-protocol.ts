/**
 * The PPR-021 rail protocol — the documented, validated wire protocol
 * between the Zeck-side rail worker and the GLM supply-rail adapter
 * (the identical discipline the PPR-018/PPR-019/PPR-020 precedents
 * established, adapted to the four Continue model-role request shapes
 * the pinned Continue runtime emits).
 *
 * WHY IT EXISTS (disclosed design, not a hidden channel): the platform's
 * provider-neutral `ModelRequest` message shape (`role: system|user|
 * assistant`, string content) cannot express the OpenAI-format request
 * axes the pinned Continue runtime emits at its seams — multimodal
 * content parts, assistant `tool_calls` history, `tool` role messages,
 * the tools schema array (chat-completions), the FIM prompt/suffix
 * shape (the legacy completions endpoint), the embeddings input array,
 * and the rerank {query, documents} shape. The ACR-007 delegation
 * contract carries those as the application-owned bounded context of
 * the edge (the task payload), and the rail protocol is the
 * execution-plane translation that lets the REAL model gateway
 * (identity → admission → capability → rail → durable intent →
 * credential materialization → adapter call) govern the dispatch while
 * the supply rail speaks the provider's wire format.
 *
 * TASK KINDS (one per Continue wire surface — the adapter stamps each
 * created execution's task with exactly one):
 *
 *  - continue-rail/1 chat-completions  (the chat, subagent, edit and
 *    apply roles — the OpenAI chat-completions wire shape)
 *  - continue-rail/1 completions       (the autocomplete role — the
 *    legacy text-completions wire shape)
 *  - continue-rail/1 embeddings        (the embed role — the OpenAI
 *    embeddings wire shape)
 *  - continue-rail/1 rerank            (the rerank role — the OpenAI
 *    rerank wire shape)
 *
 * The protocol has two sides:
 *
 *  1. REQUEST ENVELOPE — the rail worker wraps the task's full wire
 *     payload into ONE `ModelMessage` (role "user", content
 *     `continue-rail/1\n{json}`). The rail adapter validates and
 *     unwraps it before building the supply request. The gateway's
 *     request hash covers the envelope verbatim (durable dispatch
 *     intents dedupe on it).
 *
 *  2. RESPONSE — each surface normalizes its supply response into the
 *     platform's own shapes BEFORE re-entering platform code (ACR-007
 *     §5): chat/completions turns become the platform's
 *     `NormalizedStructuredOutput` concept (`name:
 *     "continue-agent-turn"`); completions become a plain content
 *     response; embeddings and rerank results ride the structured
 *     output concept too (`continue-embeddings` / `continue-rerank`).
 *     The rail worker records the normalized result on the execution's
 *     PUBLIC event ledger; the adapter reads it back through the public
 *     API and renders the OpenAI-format response the pinned Continue
 *     runtime expects.
 *
 * Everything in this file is PURE (no I/O, no environment) so the tests
 * pin both sides of the translation.
 */

import type { ModelRequest } from "../../../src/modules/models/domain/request";
import type { ModelCallOutcome } from "../../../src/modules/models/domain/outcome";
import type { ProviderFailure } from "../../../src/modules/models/domain/provider-failure";
import type { NormalizedStructuredOutput } from "../../../src/modules/models/domain/response";

// ---------------------------------------------------------------------------
// The task payload (what the adapter puts in the Zeck execution task)
// ---------------------------------------------------------------------------

/** Every task kind the PPR-021 rail handles (one per Continue wire surface). */
export const CONTINUE_TASK_KINDS = [
  "continue-role.chat-completions",
  "continue-role.completions",
  "continue-role.embeddings",
  "continue-role.rerank",
] as const;

export type ContinueTaskKind = (typeof CONTINUE_TASK_KINDS)[number];

/** OpenAI-format tool schema (the application-owned tool declarations). */
export interface OpenAiTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: Readonly<Record<string, unknown>>;
  };
}

/** One normalized OpenAI-format tool call. */
export interface OpenAiToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

/** One model turn, normalized (the neutral structured turn). */
export interface ContinueAgentTurn {
  /** The turn's text (may be empty when only tool calls were produced). */
  readonly content: string;
  /** The turn's tool calls (empty when the model produced none). */
  readonly toolCalls: readonly OpenAiToolCall[];
  /** Normalized OpenAI finish reason ("stop" | "tool_calls" | "length" | …). */
  readonly finishReason: string;
}

/** The shared params axis every chat-shaped request may carry. */
export interface ContinueRequestParams {
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly reasoningEffort?: string;
  readonly stream?: boolean;
}

/**
 * The task payload the adapter creates and the rail worker parses. The
 * `kind` names the Continue wire surface; the rest of the payload is
 * the VERBATIM application-owned wire context of the request.
 */
export interface ContinueRailTask {
  readonly kind: ContinueTaskKind;
  /** The declared execution-graph edge the request attributed to. */
  readonly edge: string;
  /** The role the request serves ("main" agent-loop roles / "auxiliary" role models). */
  readonly role: "main" | "auxiliary";
  /** The model id the Continue runtime requested (the role selector, opaque neutral string). */
  readonly model: string;
  /** The chat-completions messages (absent on non-chat surfaces). */
  readonly messages?: readonly unknown[];
  /** The completions prompt (the legacy endpoint's `prompt` [+ suffix]). */
  readonly prompt?: string;
  readonly suffix?: string;
  /** The embeddings input array. */
  readonly input?: readonly string[];
  /** The rerank query + documents. */
  readonly query?: string;
  readonly documents?: readonly string[];
  /** The OpenAI tool schemas (chat-completions only, when present). */
  readonly tools?: readonly OpenAiTool[];
  readonly params?: ContinueRequestParams;
}

/** Parse and validate a task payload (fail closed on shape). */
export function parseContinueRailTask(
  task: Readonly<Record<string, unknown>>,
): ContinueRailTask | null {
  if (typeof task.kind !== "string" || !CONTINUE_TASK_KINDS.includes(task.kind as ContinueTaskKind)) {
    return null;
  }
  if (typeof task.edge !== "string" || task.edge.length === 0) {
    return null;
  }
  if (typeof task.model !== "string" || task.model.length === 0) {
    return null;
  }
  const role: ContinueRailTask["role"] = task.role === "auxiliary" ? "auxiliary" : "main";
  const base = {
    kind: task.kind as ContinueTaskKind,
    edge: task.edge,
    role,
    model: task.model,
  };
  if (task.kind === "continue-role.chat-completions") {
    if (!Array.isArray(task.messages) || task.messages.length === 0) {
      return null;
    }
    const tools = Array.isArray(task.tools)
      ? task.tools.filter(
          (tool): tool is OpenAiTool =>
            typeof tool === "object" &&
            tool !== null &&
            (tool as { readonly type?: unknown }).type === "function" &&
            typeof (tool as { readonly function?: { readonly name?: unknown } }).function?.name ===
              "string",
        )
      : undefined;
    return {
      ...base,
      messages: task.messages,
      ...(tools === undefined ? {} : { tools }),
      ...(isParams(task.params) ? { params: task.params } : {}),
    };
  }
  if (task.kind === "continue-role.completions") {
    if (typeof task.prompt !== "string" || task.prompt.length === 0) {
      return null;
    }
    return {
      ...base,
      prompt: task.prompt,
      ...(typeof task.suffix === "string" ? { suffix: task.suffix } : {}),
      ...(isParams(task.params) ? { params: task.params } : {}),
    };
  }
  if (task.kind === "continue-role.embeddings") {
    if (!Array.isArray(task.input) || task.input.length === 0) {
      return null;
    }
    if (!task.input.every((item): item is string => typeof item === "string")) {
      return null;
    }
    return { ...base, input: task.input, ...(isParams(task.params) ? { params: task.params } : {}) };
  }
  // rerank
  if (
    typeof task.query !== "string" ||
    task.query.length === 0 ||
    !Array.isArray(task.documents) ||
    task.documents.length === 0
  ) {
    return null;
  }
  if (!task.documents.every((item): item is string => typeof item === "string")) {
    return null;
  }
  return {
    ...base,
    query: task.query,
    documents: task.documents,
    ...(isParams(task.params) ? { params: task.params } : {}),
  };
}

function isParams(value: unknown): value is ContinueRequestParams {
  return typeof value === "object" && value !== null;
}

// ---------------------------------------------------------------------------
// REQUEST ENVELOPE (rail worker → ModelRequest → rail adapter)
// ---------------------------------------------------------------------------

/** The envelope prefix (version-pinned; never parsed as a bare message). */
export const RAIL_ENVELOPE_PREFIX = "continue-rail/1\n";

/** The structured-output contract names of the normalized results. */
export const CONTINUE_TURN_NAME = "continue-agent-turn" as const;
export const CONTINUE_EMBEDDINGS_NAME = "continue-embeddings" as const;
export const CONTINUE_RERANK_NAME = "continue-rerank" as const;

/** The JSON schema of the normalized turn (the structuredOutput spec). */
export const CONTINUE_TURN_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["content", "toolCalls", "finishReason"],
  properties: {
    content: { type: "string" },
    toolCalls: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "type", "function"],
        properties: {
          id: { type: "string" },
          type: { const: "function" },
          function: {
            type: "object",
            required: ["name", "arguments"],
            properties: {
              name: { type: "string" },
              arguments: { type: "string" },
            },
          },
        },
      },
    },
    finishReason: { type: "string" },
  },
} as const;

/** The JSON schema of the normalized embeddings result. */
export const CONTINUE_EMBEDDINGS_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["vectors"],
  properties: {
    vectors: { type: "array", items: { type: "array", items: { type: "number" } } },
  },
} as const;

/** The JSON schema of the normalized rerank result. */
export const CONTINUE_RERANK_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["scores"],
  properties: {
    scores: { type: "array", items: { type: "number" } },
  },
} as const;

/** The envelope body the rail worker wraps and the rail adapter unwraps. */
export interface RailEnvelope {
  /** The verbatim task payload (the application-owned wire context). */
  readonly task: ContinueRailTask;
  /** True when any chat message carries image content parts (vision routing). */
  readonly vision: boolean;
}

/** Wrap a task's wire payload into the envelope body. */
export function buildRailEnvelope(task: ContinueRailTask): RailEnvelope {
  return {
    task,
    vision:
      task.kind === "continue-role.chat-completions" &&
      (task.messages ?? []).some((message) => hasImagePart(message)),
  };
}

/** Encode the envelope into a ModelRequest for the gateway. */
export function encodeModelRequest(
  envelope: RailEnvelope,
  routeModel: string,
): ModelRequest {
  const payload = JSON.stringify({ task: envelope.task, vision: envelope.vision });
  return {
    model: routeModel,
    messages: [{ role: "user", content: `${RAIL_ENVELOPE_PREFIX}${payload}` }],
    structuredOutput: { name: CONTINUE_TURN_NAME, schema: CONTINUE_TURN_SCHEMA },
  };
}

/** Decode a ModelRequest envelope (fail closed with a named error). */
export function decodeModelRequest(request: ModelRequest): RailEnvelope {
  const first = request.messages[0];
  if (
    request.messages.length !== 1 ||
    first === undefined ||
    first.role !== "user" ||
    typeof first.content !== "string" ||
    !first.content.startsWith(RAIL_ENVELOPE_PREFIX)
  ) {
    throw new Error("rail protocol violation: expected a single enveloped user message");
  }
  let parsed: { task?: unknown; vision?: unknown };
  try {
    parsed = JSON.parse(first.content.slice(RAIL_ENVELOPE_PREFIX.length)) as {
      task?: unknown;
      vision?: unknown;
    };
  } catch (error) {
    throw new Error(`rail protocol violation: envelope is not valid JSON (${String(error)})`);
  }
  if (typeof parsed.task !== "object" || parsed.task === null) {
    throw new Error("rail protocol violation: envelope carries no task");
  }
  const task = parseContinueRailTask(parsed.task as Record<string, unknown>);
  if (task === null) {
    throw new Error("rail protocol violation: envelope task failed validation");
  }
  return {
    task,
    vision: parsed.vision === true,
  };
}

// ---------------------------------------------------------------------------
// RESPONSES (rail adapter → ModelCallOutcome → rail worker)
// ---------------------------------------------------------------------------

/** The normalized turn as a structured output (the platform's own concept). */
export function turnOfStructuredOutput(
  structured: NormalizedStructuredOutput | null,
): ContinueAgentTurn | null {
  if (structured === null || structured.name !== CONTINUE_TURN_NAME) {
    return null;
  }
  const json = structured.json as {
    readonly content?: unknown;
    readonly toolCalls?: unknown;
    readonly finishReason?: unknown;
  };
  if (typeof json.content !== "string" || typeof json.finishReason !== "string") {
    return null;
  }
  const toolCalls = Array.isArray(json.toolCalls)
    ? json.toolCalls.filter(
        (call): call is OpenAiToolCall =>
          typeof call === "object" &&
          call !== null &&
          typeof (call as OpenAiToolCall).id === "string" &&
          typeof (call as OpenAiToolCall).function?.name === "string" &&
          typeof (call as OpenAiToolCall).function?.arguments === "string",
      )
    : [];
  return { content: json.content, toolCalls, finishReason: json.finishReason };
}

/** The normalized embeddings result as a structured output. */
export function embeddingsOfStructuredOutput(
  structured: NormalizedStructuredOutput | null,
): readonly number[][] | null {
  if (structured === null || structured.name !== CONTINUE_EMBEDDINGS_NAME) {
    return null;
  }
  const json = structured.json as { readonly vectors?: unknown };
  if (
    !Array.isArray(json.vectors) ||
    !json.vectors.every(
      (vector): vector is number[] =>
        Array.isArray(vector) && vector.every((n) => typeof n === "number"),
    )
  ) {
    return null;
  }
  return json.vectors;
}

/** The normalized rerank result as a structured output. */
export function rerankScoresOfStructuredOutput(
  structured: NormalizedStructuredOutput | null,
): readonly number[] | null {
  if (structured === null || structured.name !== CONTINUE_RERANK_NAME) {
    return null;
  }
  const json = structured.json as { readonly scores?: unknown };
  if (!Array.isArray(json.scores) || !json.scores.every((s) => typeof s === "number")) {
    return null;
  }
  return json.scores;
}

/** Build the provider-success outcome carrying the normalized turn. */
export function successOutcomeOfTurn(input: {
  readonly turn: ContinueAgentTurn;
  readonly stopReason: string;
  readonly usage: { inputTokens: number; outputTokens: number; totalTokens: number | null };
  readonly providerLatencyMs: number | null;
}): ModelCallOutcome {
  return {
    kind: "provider-success",
    response: {
      content: [input.turn.content],
      stopReason: normalizeStopReason(input.stopReason),
      structuredOutput: {
        name: CONTINUE_TURN_NAME,
        json: {
          content: input.turn.content,
          toolCalls: [...input.turn.toolCalls],
          finishReason: input.turn.finishReason,
        },
      },
      usage: { ...input.usage, costUsd: null },
      providerLatencyMs: input.providerLatencyMs,
    },
  };
}

/** Build the provider-success outcome carrying a plain completion text. */
export function successOutcomeOfText(input: {
  readonly text: string;
  readonly usage: { inputTokens: number; outputTokens: number; totalTokens: number | null };
  readonly providerLatencyMs: number | null;
}): ModelCallOutcome {
  return {
    kind: "provider-success",
    response: {
      content: [input.text],
      stopReason: "stop",
      structuredOutput: null,
      usage: { ...input.usage, costUsd: null },
      providerLatencyMs: input.providerLatencyMs,
    },
  };
}

/** Map the OpenAI finish reason onto the platform's stop-reason vocabulary. */
export function normalizeStopReason(reason: string): "stop" | "length" | "tool-use" | "other" {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool-use";
    default:
      return "other";
  }
}

/** The rail's named provider failure (for malformed envelope / supply). */
export function railFailure(
  category: ProviderFailure["category"],
  message: string,
  httpStatus: number | null,
  durationMs: number,
  rail: string,
  retryable = false,
): { kind: "provider-failure"; failure: ProviderFailure } {
  return {
    kind: "provider-failure",
    failure: {
      category,
      retryable: retryable || category === "rate-limit" || category === "timeout" || category === "network",
      rail,
      providerCode: httpStatus === null ? null : String(httpStatus),
      providerMessage: message.slice(0, 300),
      httpStatus,
      durationMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Shared wire helpers
// ---------------------------------------------------------------------------

/** Does one OpenAI-format message carry image content parts? */
export function hasImagePart(message: unknown): boolean {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const content = (message as { readonly content?: unknown }).content;
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

/** The plain text of an OpenAI-format message's content (concatenated text parts). */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
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
