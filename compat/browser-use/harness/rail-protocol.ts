/**
 * The PPR-024 rail protocol — the documented, validated wire protocol
 * between the Zeck-side execution driver and the two dispatch planes of
 * this proof (the identical discipline PPR-018/019/020/022/023
 * established, extended to the two-plane shape the work order demands):
 *
 *  1. MODEL PLANE — "completion" envelopes: the pinned Browser Use
 *     runtime's ChatOpenAI wire payload (messages with content parts,
 *     response_format json_schema, temperature/frequency_penalty/
 *     max_completion_tokens axes) dispatched through the REAL model
 *     gateway to the GLM supply rail.
 *
 *  2. SUBSTRATE PLANE — "substrate" tasks: the neutral tool/substrate
 *     execution contract's payloads (session open/close, state
 *     extraction, action execution) dispatched to the Zeck-side Python
 *     substrate driver that hosts the pinned runtime's own
 *     BrowserSession/Tools over the real Chromium.
 *
 * WHY IT EXISTS (disclosed design, not a hidden channel): the platform's
 * provider-neutral `ModelRequest` message shape cannot express the
 * request axes the pinned runtime emits at its seams (multimodal content
 * parts, response_format, per-surface sampling params) nor the substrate
 * operations the neutral tool/substrate contract carries. The ACR-007
 * delegation contract carries those as the application-owned bounded
 * context of the edge (the task payload); the execution driver is the
 * execution-plane translation that lets the REAL authorities govern
 * every dispatch while each plane speaks its own wire format.
 *
 * Everything in this file is PURE (no I/O, no environment) so the tests
 * pin both sides of the translation.
 */

import type { ModelRequest } from "../../../src/modules/models/domain/request";
import type { ModelCallOutcome } from "../../../src/modules/models/domain/outcome";
import type { ProviderFailure } from "../../../src/modules/models/domain/provider-failure";
import type { NormalizedStructuredOutput } from "../../../src/modules/models/domain/response";

// ---------------------------------------------------------------------------
// The task payloads (what the adapter puts in the Zeck execution tasks)
// ---------------------------------------------------------------------------

/** The MODEL-plane task kind (the agent-loop LLM seam). */
export const COMPLETION_TASK_KIND = "browseruse.agent-loop.completion" as const;

/** The SUBSTRATE-plane task kinds (the neutral tool/substrate contract). */
export const SESSION_TASK_KIND = "browseruse.substrate.session" as const;
export const STATE_TASK_KIND = "browseruse.substrate.state-extraction" as const;
export const ACTION_TASK_KIND = "browseruse.substrate.action" as const;

export type BrowserUseTaskKind =
  | typeof COMPLETION_TASK_KIND
  | typeof SESSION_TASK_KIND
  | typeof STATE_TASK_KIND
  | typeof ACTION_TASK_KIND;

/** The task-kind set the SUBSTRATE plane owns (the execution driver's dispatch axis). */
export const SUBSTRATE_TASK_KINDS: readonly string[] = [
  SESSION_TASK_KIND,
  STATE_TASK_KIND,
  ACTION_TASK_KIND,
];

/** One normalized OpenAI-format tool call (tolerated on the wire; Browser Use is tool-call-free). */
export interface OpenAiToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

/** One model turn, normalized (the neutral structured turn). */
export interface BrowserUseTurn {
  /** The turn's text (the structured AgentOutput JSON the runtime parses). */
  readonly content: string;
  /** The turn's tool calls (empty when the model produced none). */
  readonly toolCalls: readonly OpenAiToolCall[];
  /** Normalized OpenAI finish reason ("stop" | "length" | …). */
  readonly finishReason: string;
}

/** The chat-completion task payload (the model plane). */
export interface BrowserUseCompletionTask {
  readonly kind: typeof COMPLETION_TASK_KIND;
  readonly edge: string;
  readonly role: "main" | "auxiliary";
  /** The model id the Browser Use runtime requested (opaque neutral string). */
  readonly model: string;
  /** The full OpenAI-format messages (content parts incl. image_url, response_format history). */
  readonly messages: readonly unknown[];
  readonly params?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly frequencyPenalty?: number;
    readonly topP?: number;
    readonly seed?: number;
    readonly responseFormat?: unknown;
    readonly stream?: boolean;
  };
}

/** The substrate session task payload (launch / teardown of the real browser). */
export interface BrowserUseSessionTask {
  readonly kind: typeof SESSION_TASK_KIND;
  readonly edge: string;
  readonly op: "open" | "close";
  /** The substrate session id (close only). */
  readonly sessionId?: string;
  /** The session-open profile axes (the app's own BrowserProfile surface). */
  readonly profile?: {
    readonly chromeExecutablePath?: string;
    readonly headless?: boolean;
    readonly userDataDir?: string;
    readonly proxyServer?: string;
    readonly proxyBypass?: string;
    readonly allowedDomains?: readonly string[];
    readonly minWaitPageLoadMs?: number;
    readonly waitBetweenActionsMs?: number;
  };
}

/** The state-extraction task payload (the actuation plane's read path). */
export interface BrowserUseStateTask {
  readonly kind: typeof STATE_TASK_KIND;
  readonly edge: string;
  readonly sessionId: string;
  readonly includeScreenshot: boolean;
  readonly cached: boolean;
  readonly includeRecentEvents: boolean;
}

/** The action-execution task payload (THE actuation plane). */
export interface BrowserUseActionTask {
  readonly kind: typeof ACTION_TASK_KIND;
  readonly edge: string;
  readonly sessionId: string;
  /** The agent-chosen action: {actionName: params} (the runtime's own ActionModel dump). */
  readonly action: Readonly<Record<string, unknown>>;
}

export type BrowserUseRailTask =
  | BrowserUseCompletionTask
  | BrowserUseSessionTask
  | BrowserUseStateTask
  | BrowserUseActionTask;

/** Parse and validate a task payload (fail closed on shape). */
export function parseBrowserUseTask(task: Readonly<Record<string, unknown>>): BrowserUseRailTask | null {
  if (task.kind === COMPLETION_TASK_KIND) {
    if (
      typeof task.edge !== "string" ||
      task.edge.length === 0 ||
      typeof task.model !== "string" ||
      task.model.length === 0 ||
      !Array.isArray(task.messages) ||
      task.messages.length === 0
    ) {
      return null;
    }
    const role = task.role === "auxiliary" ? "auxiliary" : "main";
    const params = task.params;
    return {
      kind: COMPLETION_TASK_KIND,
      edge: task.edge,
      role,
      model: task.model,
      messages: task.messages,
      ...(typeof params === "object" && params !== null
        ? { params: params as BrowserUseCompletionTask["params"] }
        : {}),
    };
  }
  if (task.kind === SESSION_TASK_KIND) {
    if (typeof task.edge !== "string" || task.edge.length === 0) {
      return null;
    }
    if (task.op !== "open" && task.op !== "close") {
      return null;
    }
    const profile = task.profile;
    return {
      kind: SESSION_TASK_KIND,
      edge: task.edge,
      op: task.op,
      ...(typeof task.sessionId === "string" && task.sessionId.length > 0
        ? { sessionId: task.sessionId }
        : {}),
      ...(typeof profile === "object" && profile !== null
        ? { profile: profile as BrowserUseSessionTask["profile"] }
        : {}),
    };
  }
  if (task.kind === STATE_TASK_KIND) {
    if (
      typeof task.edge !== "string" ||
      task.edge.length === 0 ||
      typeof task.sessionId !== "string" ||
      task.sessionId.length === 0
    ) {
      return null;
    }
    return {
      kind: STATE_TASK_KIND,
      edge: task.edge,
      sessionId: task.sessionId,
      includeScreenshot: task.includeScreenshot === true,
      cached: task.cached === true,
      includeRecentEvents: task.includeRecentEvents === true,
    };
  }
  if (task.kind === ACTION_TASK_KIND) {
    if (
      typeof task.edge !== "string" ||
      task.edge.length === 0 ||
      typeof task.sessionId !== "string" ||
      task.sessionId.length === 0 ||
      typeof task.action !== "object" ||
      task.action === null
    ) {
      return null;
    }
    return {
      kind: ACTION_TASK_KIND,
      edge: task.edge,
      sessionId: task.sessionId,
      action: task.action as Readonly<Record<string, unknown>>,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// REQUEST ENVELOPE (execution driver → ModelRequest → rail adapter; the
// substrate tasks never reach the model gateway — they dispatch to the
// Python substrate driver directly)
// ---------------------------------------------------------------------------

/** The envelope prefix (version-pinned; never parsed as a bare message). */
export const RAIL_ENVELOPE_PREFIX = "browseruse-rail/1\n";

/** The structured-output contract name of the normalized chat turn. */
export const BROWSER_USE_TURN_NAME = "browseruse-agent-turn" as const;

/** The JSON schema of the normalized chat turn (the structuredOutput spec). */
export const BROWSER_USE_TURN_SCHEMA: Readonly<Record<string, unknown>> = {
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

/** The envelope body the execution driver wraps and the rail adapter unwraps. */
export type RailEnvelope = {
  readonly kind: "completion";
  readonly messages: readonly unknown[];
  readonly params?: BrowserUseCompletionTask["params"];
  /** True when any message carries image content parts (vision routing). */
  readonly vision: boolean;
};

/** Wrap a completion task's wire payload into the envelope body. */
export function buildRailEnvelope(task: BrowserUseCompletionTask): RailEnvelope {
  return {
    kind: "completion",
    messages: task.messages,
    ...(task.params === undefined ? {} : { params: task.params }),
    vision: task.messages.some((message) => hasImagePart(message)),
  };
}

/** Encode the envelope into a ModelRequest for the gateway. */
export function encodeModelRequest(envelope: RailEnvelope, routeModel: string): ModelRequest {
  const payload = JSON.stringify(envelope);
  return {
    model: routeModel,
    messages: [{ role: "user", content: `${RAIL_ENVELOPE_PREFIX}${payload}` }],
    structuredOutput: { name: BROWSER_USE_TURN_NAME, schema: BROWSER_USE_TURN_SCHEMA },
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
    readonly kind?: unknown;
    readonly messages?: unknown;
    readonly params?: unknown;
  };
  if (parsed.kind !== "completion" || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    throw new Error("rail protocol violation: completion envelope carries no messages");
  }
  return {
    kind: "completion",
    messages: parsed.messages,
    ...(typeof parsed.params === "object" && parsed.params !== null
      ? { params: parsed.params as BrowserUseCompletionTask["params"] }
      : {}),
    vision: parsed.messages.some((message) => hasImagePart(message)),
  };
}

// ---------------------------------------------------------------------------
// RESPONSE FACTS (rail adapter → ModelCallOutcome → execution driver)
// ---------------------------------------------------------------------------

/** The normalized chat turn as a structured output (the platform's own concept). */
export function turnOfStructuredOutput(
  structured: NormalizedStructuredOutput | null,
): BrowserUseTurn | null {
  if (structured === null || structured.name !== BROWSER_USE_TURN_NAME) {
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

/** The provider-success outcome class (the success builders' honest return). */
export type SuccessfulModelCallOutcome = Extract<ModelCallOutcome, { kind: "provider-success" }>;

/** Build the provider-success outcome carrying the normalized chat turn. */
export function successOutcomeOfTurn(input: {
  readonly turn: BrowserUseTurn;
  readonly stopReason: string;
  readonly usage: { inputTokens: number; outputTokens: number; totalTokens: number | null };
  readonly providerLatencyMs: number;
}): SuccessfulModelCallOutcome {
  return {
    kind: "provider-success",
    response: {
      content: [input.turn.content],
      stopReason: normalizeStopReason(input.stopReason),
      structuredOutput: {
        name: BROWSER_USE_TURN_NAME,
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

/**
 * Deterministic provider-shape normalization: the GLM supply wraps JSON
 * bodies in markdown fences (```json … ```) even under
 * response_format=json_schema (live-observed at proof time). When the
 * content is a fenced JSON block, strip to the JSON body — a pure,
 * total, disclosed normalization of the supply's response shape before
 * it re-enters platform code (ACR-007 §5), never a repair of invalid
 * model output (non-fenced, non-JSON content passes through verbatim).
 */
export function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  if (fenced !== null) {
    const body = fenced[1] ?? "";
    // Only strip when the body itself parses as JSON (never a destructive rewrite).
    try {
      JSON.parse(body);
      return body;
    } catch {
      return content;
    }
  }
  return content;
}
