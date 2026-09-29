/**
 * The GLM supply-rail adapter for PPR-019 (Cline) — a `custom`-rail
 * `ModelProvider` over the sandbox's authorized GLM endpoint, following
 * the platform's own adapter discipline (see
 * src/modules/models/adapters/openrouter.ts and the PPR-018 precedent):
 * "No SDK: the rail speaks OpenAI-compatible JSON over HTTP, driven
 * through the neutral `HttpTransport` port; provider specifics live ONLY
 * in this file."
 *
 * WHAT THIS RAIL TRANSLATES (the Cline-specific axes PPR-018's plain
 * text rail did not need):
 *  - the rail protocol envelope (rail-protocol.ts): full OpenAI-format
 *    messages (multimodal parts, tool_calls history, tool role) + the
 *    tools schema array;
 *  - VISION ROUTING: an envelope carrying image parts dispatches to the
 *    supply endpoint's vision surface ({base}/chat/completions/vision —
 *    the same surface the sandbox's z-ai-web-dev-sdk createVision uses);
 *    text-only envelopes dispatch to {base}/chat/completions;
 *  - NATIVE TOOL CALLS: the tools array rides the request when present;
 *    the response's tool_calls are normalized into the structured turn;
 *  - REASONING CONTROL: the envelope's reasoning effort maps onto the
 *    supply endpoint's thinking control (enabled unless "none") — the
 *    request-level reasoning control of the delegated edge, executed by
 *    the rail (the supply model's reasoning output surface is disclosed
 *    in the evidence record's limitations);
 *  - RESPONSE NORMALIZATION: the OpenAI-format response becomes the
 *    neutral structured turn (content + toolCalls + finishReason) BEFORE
 *    re-entering platform code (ACR-007 §5).
 *
 * SECRETS-LAST: the credential material is materialized by the gateway
 * into `ProviderDispatchContext.credential` immediately before this
 * adapter call — this adapter holds no credential of its own.
 *
 * Fault injection: the battery's failure-path validation composes this
 * adapter over a failing `HttpTransport` — an honest, disclosed
 * fault-injection at the transport boundary (never counted as a live
 * success).
 */

import type { ModelCallOutcome } from "../../../src/modules/models/domain/outcome";
import type { ModelProvider, ProviderDispatchContext } from "../../../src/modules/models/ports/model-provider";
import type { ModelRequest } from "../../../src/modules/models/domain/request";
import { collectBodyText, type HttpTransport } from "../../../src/modules/models/ports/http-transport";
import {
  decodeModelRequest,
  RAIL_ENVELOPE_PREFIX,
  railFailure,
  reasoningEffortOf,
  successOutcomeOfTurn,
  type OpenAiTool,
  type OpenAiToolCall,
} from "./rail-protocol";
import { RAIL_MODEL, RAIL_PROVIDER, RAIL_VISION_MODEL } from "./zai-config";

const STATUS_CATEGORIES: Readonly<Record<number, "invalid-request" | "authentication" | "quota" | "authorization" | "timeout" | "rate-limit">> = {
  400: "invalid-request",
  401: "authentication",
  402: "quota",
  403: "authorization",
  404: "invalid-request",
  408: "timeout",
  413: "invalid-request",
  422: "invalid-request",
  429: "rate-limit",
};

function categoryForStatus(
  status: number,
): "invalid-request" | "authentication" | "quota" | "authorization" | "timeout" | "rate-limit" | "provider-unavailable" | "unknown" {
  if (status in STATUS_CATEGORIES) {
    return STATUS_CATEGORIES[status] ?? "unknown";
  }
  if (status >= 500) {
    return "provider-unavailable";
  }
  return "unknown";
}

/** The supply endpoint's OpenAI-compatible response shape. */
interface SupplyResponse {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: unknown;
      readonly tool_calls?: readonly {
        readonly id?: unknown;
        readonly type?: unknown;
        readonly function?: { readonly name?: unknown; readonly arguments?: unknown };
      }[];
    };
    readonly finish_reason?: unknown;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly total_tokens?: unknown;
  };
}

/** One supply response choice's message shape. */
type SupplyMessage = NonNullable<NonNullable<SupplyResponse["choices"]>[number]["message"]>;

export interface ZaiRailOptions {
  /** The supply endpoint base URL (from the platform-side supply config). */
  readonly baseUrl: string;
  /** The HTTP transport (injectable — the fault-injection seam of the battery). */
  readonly transport: HttpTransport;
}

/** Normalize the supply response's tool calls (absent → empty). */
function toolCallsOf(message: SupplyMessage | undefined): readonly OpenAiToolCall[] {
  const raw = message?.tool_calls;
  if (!Array.isArray(raw)) {
    return [];
  }
  const calls: OpenAiToolCall[] = [];
  for (const call of raw) {
    if (
      typeof call === "object" &&
      call !== null &&
      typeof call.id === "string" &&
      typeof call.function?.name === "string"
    ) {
      calls.push({
        id: call.id,
        type: "function",
        function: {
          name: call.function.name,
          arguments: typeof call.function.arguments === "string" ? call.function.arguments : "{}",
        },
      });
    }
  }
  return calls;
}

/** Create the GLM supply rail adapter for Cline (rail slug `custom`). */
export function createZaiRailAdapter(options: ZaiRailOptions): ModelProvider {
  const { baseUrl, transport } = options;
  const textEndpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const visionEndpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions/vision`;

  const dispatch = async (
    request: ModelRequest,
    context: ProviderDispatchContext,
  ): Promise<ModelCallOutcome> => {
    const startedAt = Date.now();
    // SECRETS-LAST: the credential was materialized by the gateway into
    // the dispatch context; it exists only inside this invocation scope.
    let authHeaders: Record<string, string> = {};
    if (context.credential !== null && context.credential.length > 0) {
      try {
        const parsed = JSON.parse(context.credential) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") {
            authHeaders[key.toLowerCase()] = value;
          }
        }
      } catch {
        return railFailure("authentication", "malformed rail credential material", null, 0, RAIL_PROVIDER);
      }
    }

    // Rail protocol: unwrap the enveloped wire payload (fail closed).
    let envelope;
    try {
      envelope = decodeModelRequest(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return railFailure("invalid-request", `rail protocol: ${message}`, null, Date.now() - startedAt, RAIL_PROVIDER);
    }

    const effort = reasoningEffortOf(envelope);
    const body: Record<string, unknown> = {
      model: envelope.vision ? RAIL_VISION_MODEL : RAIL_MODEL,
      messages: envelope.messages,
      thinking: { type: effort !== null && effort !== "none" ? "enabled" : "disabled" },
    };
    // The tools schema rides text-endpoint requests (the vision surface
    // ignores the tools axis — a disclosed supply limitation).
    if (envelope.tools !== undefined && envelope.tools.length > 0 && !envelope.vision) {
      body.tools = envelope.tools;
      body.tool_choice = "auto";
    }
    if (envelope.params?.maxTokens !== undefined) {
      body.max_tokens = envelope.params.maxTokens;
    }
    if (envelope.params?.temperature !== undefined) {
      body.temperature = envelope.params.temperature;
    }

    const endpoint = envelope.vision ? visionEndpoint : textEndpoint;
    let response: { readonly status: number; readonly text: string };
    try {
      const raw = await transport.send({
        method: "POST",
        url: context.endpointUrl ?? endpoint,
        headers: { ...authHeaders },
        bodyJson: body,
        timeoutMs: context.timeoutMs,
      });
      response = { status: raw.status, text: await collectBodyText(raw.body) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const category = /timeout|timed[ -]?out|abort/i.test(message) ? "timeout" : "network";
      return railFailure(category, message, null, Date.now() - startedAt, RAIL_PROVIDER);
    }
    const durationMs = Date.now() - startedAt;
    if (response.status < 200 || response.status >= 300) {
      return railFailure(
        categoryForStatus(response.status),
        `supply endpoint returned HTTP ${response.status}: ${response.text.slice(0, 200)}`,
        response.status,
        durationMs,
        RAIL_PROVIDER,
      );
    }
    let parsed: SupplyResponse;
    try {
      parsed = JSON.parse(response.text) as SupplyResponse;
    } catch {
      return railFailure("malformed-response", "non-JSON response body", response.status, durationMs, RAIL_PROVIDER);
    }
    const first = parsed.choices?.[0];
    if (first === undefined || first.message === undefined) {
      return railFailure(
        "malformed-response",
        "response carried no message choice",
        response.status,
        durationMs,
        RAIL_PROVIDER,
      );
    }
    const content = typeof first.message.content === "string" ? first.message.content : "";
    const toolCalls = toolCallsOf(first.message);
    const finishReason = typeof first.finish_reason === "string" ? first.finish_reason : "stop";
    const usage = parsed.usage;
    const inputTokens = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0;
    const outputTokens = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0;
    const totalTokens = typeof usage?.total_tokens === "number" ? usage.total_tokens : null;
    if (content.length === 0 && toolCalls.length === 0) {
      return railFailure(
        "malformed-response",
        "response carried neither content nor tool calls",
        response.status,
        durationMs,
        RAIL_PROVIDER,
      );
    }
    return successOutcomeOfTurn({
      turn: { content, toolCalls, finishReason },
      stopReason: finishReason,
      usage: { inputTokens, outputTokens, totalTokens },
      providerLatencyMs: durationMs,
    });
  };

  return {
    rail: RAIL_PROVIDER,
    async complete(request, context) {
      return dispatch(request, context);
    },
    // The Cline runtime consumes SSE at its own edge; the rail backend is
    // non-streaming, so stream() emits the complete normalized response
    // as one terminal sequence (an honest single-shot stream, never a
    // fake SSE — the same disclosed discipline as PPR-018's rail).
    async *stream(request, context) {
      const outcome = await dispatch(request, context);
      if (outcome.kind === "provider-failure") {
        yield { type: "stream-error", failure: outcome.failure };
        return;
      }
      for (const text of outcome.response.content) {
        yield { type: "text-delta", text };
      }
      yield {
        type: "stream-done",
        stopReason: outcome.response.stopReason,
        usage: outcome.response.usage,
      };
    },
  };
}

/** The route identities the rail's planning decisions record (neutral strings). */
export const RAIL_ROUTES = {
  text: { provider: RAIL_PROVIDER, model: RAIL_MODEL },
  vision: { provider: RAIL_PROVIDER, model: RAIL_VISION_MODEL },
} as const;

/** Exposed for the tests' envelope-fixture building. */
export const RAIL_PROTOCOL_PREFIX = RAIL_ENVELOPE_PREFIX;
