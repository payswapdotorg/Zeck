/**
 * The GLM supply rail adapter (PPR-018) — a `custom`-rail
 * `ModelProvider` over the sandbox's authorized GLM endpoint.
 *
 * This follows the platform's own adapter discipline exactly (see
 * `src/modules/models/adapters/openrouter.ts`): "No SDK: the rail speaks
 * OpenAI-compatible JSON over HTTP, driven through the neutral
 * `HttpTransport` port; provider specifics live ONLY in this file."
 *
 * The supply endpoint's protocol is the z-ai chat-completions surface
 * (OpenAI-compatible JSON with the sandbox's auth headers — see
 * `zai-config.ts`). The credential material is MATERIALIZED BY THE GATEWAY
 * into `ProviderDispatchContext.credential` immediately before this
 * adapter call (the platform's SECRETS-LAST rule) — this adapter holds no
 * credential of its own.
 *
 * Fault injection: the battery's failure-path validation composes this
 * adapter over a failing `HttpTransport` — an honest, disclosed
 * fault-injection at the transport boundary (never counted as a live
 * success).
 */

import type { ModelCallOutcome } from "../../../src/modules/models/domain/outcome";
import type { ProviderFailure } from "../../../src/modules/models/domain/provider-failure";
import type { ModelRequest, StopReason } from "../../../src/modules/models/domain/request";
import type { NormalizedUsage } from "../../../src/modules/models/domain/response";
import {
  collectBodyText,
  type HttpTransport,
} from "../../../src/modules/models/ports/http-transport";
import type {
  ModelProvider,
  ProviderDispatchContext,
} from "../../../src/modules/models/ports/model-provider";
import { RAIL_MODEL, RAIL_PROVIDER } from "./zai-config";

const STATUS_CATEGORIES: Readonly<Record<number, ProviderFailure["category"]>> = {
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

const RETRYABLE = new Set(["rate-limit", "provider-unavailable", "timeout", "network"]);

function categoryForStatus(status: number): ProviderFailure["category"] {
  if (status in STATUS_CATEGORIES) {
    return STATUS_CATEGORIES[status] ?? "unknown";
  }
  if (status >= 500) {
    return "provider-unavailable";
  }
  return "unknown";
}

function failureOf(
  category: ProviderFailure["category"],
  message: string,
  httpStatus: number | null,
  durationMs: number | null,
): ProviderFailure {
  return {
    category,
    retryable: RETRYABLE.has(category),
    rail: RAIL_PROVIDER,
    providerCode: httpStatus === null ? null : String(httpStatus),
    providerMessage: message.slice(0, 300),
    httpStatus,
    durationMs,
  };
}

function stopReasonOf(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content-filter";
    case "tool_calls":
      return "tool-use";
    default:
      return "other";
  }
}

/** The wire shape the supply endpoint returns (OpenAI-compatible). */
interface SupplyResponse {
  readonly choices?: readonly {
    readonly message?: { readonly content?: unknown };
    readonly finish_reason?: unknown;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly total_tokens?: unknown;
  };
}

function usageOf(response: SupplyResponse): NormalizedUsage {
  const usage = response.usage;
  const inputTokens = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0;
  const totalTokens = typeof usage?.total_tokens === "number" ? usage.total_tokens : null;
  // The supply endpoint does not report USD cost — null, never invented.
  return { inputTokens, outputTokens, totalTokens, costUsd: null };
}

export interface ZaiRailOptions {
  /** The supply endpoint base URL (from the platform-side supply config). */
  readonly baseUrl: string;
  /** The HTTP transport (injectable — the fault-injection seam of the battery). */
  readonly transport: HttpTransport;
}

/** Create the GLM supply rail adapter (rail slug `custom`). */
export function createZaiRailAdapter(options: ZaiRailOptions): ModelProvider {
  const { baseUrl, transport } = options;
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

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
        // A malformed credential is an authentication failure, never a guess.
        return {
          kind: "provider-failure",
          failure: failureOf("authentication", "malformed rail credential material", null, 0),
        };
      }
    }
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      thinking: { type: "disabled" },
    };
    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
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
      const category = /timeout|abort/i.test(message) ? "timeout" : "network";
      return {
        kind: "provider-failure",
        failure: failureOf(category, message, null, Date.now() - startedAt),
      };
    }
    const durationMs = Date.now() - startedAt;
    if (response.status < 200 || response.status >= 300) {
      return {
        kind: "provider-failure",
        failure: failureOf(
          categoryForStatus(response.status),
          `supply endpoint returned HTTP ${response.status}: ${response.text.slice(0, 200)}`,
          response.status,
          durationMs,
        ),
      };
    }
    let parsed: SupplyResponse;
    try {
      parsed = JSON.parse(response.text) as SupplyResponse;
    } catch {
      return {
        kind: "provider-failure",
        failure: failureOf("malformed-response", "non-JSON response body", response.status, durationMs),
      };
    }
    const first = parsed.choices?.[0];
    const content = first?.message?.content;
    if (first === undefined || typeof content !== "string") {
      return {
        kind: "provider-failure",
        failure: failureOf(
          "malformed-response",
          "response carried no message content",
          response.status,
          durationMs,
        ),
      };
    }
    return {
      kind: "provider-success",
      response: {
        content: [content],
        stopReason: stopReasonOf(typeof first.finish_reason === "string" ? first.finish_reason : null),
        structuredOutput: null,
        usage: usageOf(parsed),
        providerLatencyMs: durationMs,
      },
    };
  };

  return {
    rail: RAIL_PROVIDER,
    async complete(request, context) {
      return dispatch(request, context);
    },
    // The corpus runs Aider with --no-stream; the rail backend is
    // non-streaming, so stream() emits the complete response as one
    // terminal sequence (an honest single-shot stream, never a fake SSE).
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

/** The model identity the rail's planning decisions route through. */
export const RAIL_ROUTE = { provider: RAIL_PROVIDER, model: RAIL_MODEL } as const;
