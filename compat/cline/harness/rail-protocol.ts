/**
 * The PPR-019 rail protocol — the documented, validated wire protocol
 * between the Zeck-side rail worker and the GLM supply-rail adapter.
 *
 * WHY IT EXISTS (disclosed design, not a hidden channel): the platform's
 * provider-neutral `ModelRequest` message shape (`role: system|user|
 * assistant`, string content) cannot express the OpenAI-format request
 * axes the pinned Cline runtime actually emits at this seam — multimodal
 * content parts (image data URLs), assistant `tool_calls` history, `tool`
 * role messages with `tool_call_id`, and the tools schema array. The
 * ACR-007 delegation contract carries those as the application-owned
 * bounded context of the edge (the task payload), and the rail protocol
 * is the execution-plane translation that lets the REAL model gateway
 * (identity → admission → capability → rail resolution → durable intent
 * → credential materialization → adapter call) govern the dispatch while
 * the supply rail speaks the provider's wire format.
 *
 * The protocol has two sides:
 *
 *  1. REQUEST ENVELOPE — the rail worker wraps the task's full wire
 *     payload (messages + tools + params) into ONE `ModelMessage`
 *     (role "user", content `cline-rail/1\n{json}`). The rail adapter
 *     validates and unwraps it before building the supply request. The
 *     gateway's request hash covers the envelope verbatim (durable
 *     dispatch intents dedupe on it).
 *
 *  2. RESPONSE TURN — the rail adapter normalizes the supply response
 *     (text, tool calls, finish reason, usage) into the platform's own
 *     `NormalizedStructuredOutput` concept (`name:
 *     "cline-agent-turn"`): the provider-specific OpenAI shape is
 *     translated into a neutral structured turn BEFORE it re-enters
 *     platform code, exactly ACR-007 §5 ("provider-specific behavior
 *     exposed to the application must be translated into neutral Zeck
 *     results"). The rail worker records the turn on the execution's
 *     PUBLIC event ledger; the adapter reads it back through the public
 *     API and renders the OpenAI-format response (SSE or JSON) Cline
 *     expects.
 *
 * Everything in this file is PURE (no I/O, no environment) so the tests
 * pin both sides of the translation.
 */

import type { ModelRequest } from "../../../src/modules/models/domain/request";
import type {
  ModelCallOutcome,
} from "../../../src/modules/models/domain/outcome";
import type { ProviderFailure } from "../../../src/modules/models/domain/provider-failure";
import type { NormalizedStructuredOutput } from "../../../src/modules/models/domain/response";

// ---------------------------------------------------------------------------
// The task payload (what the adapter puts in the Zeck execution task)
// ---------------------------------------------------------------------------

/** The task kind of every PPR-019 delegated execution. */
export const CLINE_TASK_KIND = "ide-agent.completion" as const;

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
export interface ClineAgentTurn {
  /** The turn's text (may be empty when only tool calls were produced). */
  readonly content: string;
  /** The turn's tool calls (empty when the model produced none). */
  readonly toolCalls: readonly OpenAiToolCall[];
  /** Normalized OpenAI finish reason ("stop" | "tool_calls" | "length" | …). */
  readonly finishReason: string;
}

/** The task payload the adapter creates and the rail worker parses. */
export interface ClineCompletionTask {
  readonly kind: typeof CLINE_TASK_KIND;
  readonly edge: string;
  readonly role: "main" | "auxiliary";
  /** The model id the Cline runtime requested (opaque neutral string). */
  readonly model: string;
  /** The full OpenAI-format messages (content parts, tool_calls, tool role). */
  readonly messages: readonly unknown[];
  /** The OpenAI tool schemas (absent when the request carried none). */
  readonly tools?: readonly OpenAiTool[];
  readonly params?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly reasoningEffort?: string;
    readonly stream?: boolean;
  };
}

/** Parse and validate a task payload (fail closed on shape). */
export function parseClineCompletionTask(
  task: Readonly<Record<string, unknown>>,
): ClineCompletionTask | null {
  if (task.kind !== CLINE_TASK_KIND) {
    return null;
  }
  if (typeof task.edge !== "string" || task.edge.length === 0) {
    return null;
  }
  if (typeof task.model !== "string" || task.model.length === 0) {
    return null;
  }
  if (!Array.isArray(task.messages) || task.messages.length === 0) {
    return null;
  }
  const role = task.role === "auxiliary" ? "auxiliary" : "main";
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
  const params = task.params;
  return {
    kind: CLINE_TASK_KIND,
    edge: task.edge,
    role,
    model: task.model,
    messages: task.messages,
    ...(tools === undefined ? {} : { tools }),
    ...(typeof params === "object" && params !== null
      ? { params: params as ClineCompletionTask["params"] }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// REQUEST ENVELOPE (rail worker → ModelRequest → rail adapter)
// ---------------------------------------------------------------------------

/** The envelope prefix (version-pinned; never parsed as a bare message). */
export const RAIL_ENVELOPE_PREFIX = "cline-rail/1\n";

/** The structured-output contract name of the normalized turn. */
export const CLINE_TURN_NAME = "cline-agent-turn" as const;

/** The JSON schema of the normalized turn (the structuredOutput spec). */
export const CLINE_TURN_SCHEMA: Readonly<Record<string, unknown>> = {
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

/** The envelope body the rail worker wraps and the rail adapter unwraps. */
export interface RailEnvelope {
  readonly messages: readonly unknown[];
  readonly tools?: readonly OpenAiTool[];
  readonly params?: ClineCompletionTask["params"];
  /** True when any message carries image content parts (vision routing). */
  readonly vision: boolean;
}

/** Wrap a task's wire payload into the envelope body. */
export function buildRailEnvelope(task: ClineCompletionTask): RailEnvelope {
  return {
    messages: task.messages,
    ...(task.tools === undefined ? {} : { tools: task.tools }),
    ...(task.params === undefined ? {} : { params: task.params }),
    vision: task.messages.some((message) => hasImagePart(message)),
  };
}

/** Encode the envelope into a ModelRequest for the gateway. */
export function encodeModelRequest(
  envelope: RailEnvelope,
  routeModel: string,
): ModelRequest {
  const payload = JSON.stringify({
    messages: envelope.messages,
    ...(envelope.tools === undefined ? {} : { tools: envelope.tools }),
    ...(envelope.params === undefined ? {} : { params: envelope.params }),
    vision: envelope.vision,
  });
  return {
    model: routeModel,
    messages: [{ role: "user", content: `${RAIL_ENVELOPE_PREFIX}${payload}` }],
    structuredOutput: { name: CLINE_TURN_NAME, schema: CLINE_TURN_SCHEMA },
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
  const parsed = JSON.parse(first.content.slice(RAIL_ENVELOPE_PREFIX.length)) as {
    messages?: unknown;
    tools?: unknown;
    params?: unknown;
    vision?: unknown;
  };
  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    throw new Error("rail protocol violation: envelope carries no messages");
  }
  return {
    messages: parsed.messages,
    ...(Array.isArray(parsed.tools) ? { tools: parsed.tools as OpenAiTool[] } : {}),
    ...(typeof parsed.params === "object" && parsed.params !== null
      ? { params: parsed.params as ClineCompletionTask["params"] }
      : {}),
    vision: parsed.vision === true || parsed.messages.some((message) => hasImagePart(message)),
  };
}

// ---------------------------------------------------------------------------
// RESPONSE TURN (rail adapter → ModelCallOutcome → rail worker)
// ---------------------------------------------------------------------------

/** The normalized turn as a structured output (the platform's own concept). */
export function turnOfStructuredOutput(
  structured: NormalizedStructuredOutput | null,
): ClineAgentTurn | null {
  if (structured === null || structured.name !== CLINE_TURN_NAME) {
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

/** Build the provider-success outcome carrying the normalized turn. */
export function successOutcomeOfTurn(input: {
  turn: ClineAgentTurn;
  stopReason: ModelRequest extends never ? never : string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number | null };
  providerLatencyMs: number;
}): ModelCallOutcome {
  return {
    kind: "provider-success",
    response: {
      content: [input.turn.content],
      stopReason: normalizeStopReason(input.stopReason),
      structuredOutput: {
        name: CLINE_TURN_NAME,
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
): { kind: "provider-failure"; failure: ProviderFailure } {
  return {
    kind: "provider-failure",
    failure: {
      category,
      retryable: category === "rate-limit" || category === "timeout" || category === "network",
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

/** Extract the reasoning effort carried in envelope params (or null). */
export function reasoningEffortOf(envelope: RailEnvelope): string | null {
  const effort = envelope.params?.reasoningEffort;
  return typeof effort === "string" && effort.length > 0 ? effort : null;
}
