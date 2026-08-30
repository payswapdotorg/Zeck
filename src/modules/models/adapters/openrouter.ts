/**
 * OpenRouter adapter — the aggregation rail (CON-003).
 *
 * One upstream supply rail behind the neutral `ModelProvider` contract
 * (`spec/architecture.md` §12: "OpenRouter is supported as a
 * provider-federation rail, not as a system authority or architectural
 * dependency"). No SDK: the rail speaks OpenAI-compatible JSON over HTTP,
 * driven through the neutral `HttpTransport` port; provider specifics live
 * ONLY in this file (architecture-lock invariant 2).
 *
 * Normalization owned here: request/response translation, structured output
 * via native `response_format: json_schema`, streaming via SSE with terminal
 * usage, usage incl. rail-reported USD cost, and provider-error categories.
 */

import type { ModelCallOutcome } from "../domain/outcome";
import type { ProviderErrorCategory, ProviderFailure } from "../domain/provider-failure";
import {
  isProviderFailure,
  isRetryableCategory,
  sanitizeProviderMessage,
} from "../domain/provider-failure";
import type { ModelRequest, StopReason } from "../domain/request";
import type { ModelResponse, NormalizedUsage } from "../domain/response";
import type { HttpTransport } from "../ports/http-transport";
import { collectBodyText } from "../ports/http-transport";
import type { ModelProvider, ProviderDispatchContext } from "../ports/model-provider";
import { errorBodyOf, guardedBody, postJson, sendForStream } from "./http";
import { parseSseStream } from "./sse";

export const OPENROUTER_DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1";

const STATUS_CATEGORIES: Readonly<Record<number, ProviderErrorCategory>> = {
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

function categoryForStatus(status: number): ProviderErrorCategory {
  if (status in STATUS_CATEGORIES) {
    return STATUS_CATEGORIES[status] ?? "unknown";
  }
  if (status >= 500) {
    return "provider-unavailable";
  }
  return "unknown";
}

function finishReasonOf(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content-filter";
    case "tool_calls":
    case "function_call":
    case "tools":
      return "tool-use";
    default:
      return "other";
  }
}

interface OpenRouterUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
  readonly cost?: number;
}

function normalizeUsage(usage: OpenRouterUsage | undefined): NormalizedUsage {
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.total_tokens ?? inputTokens + outputTokens,
    costUsd: typeof usage?.cost === "number" ? usage.cost : null,
  };
}

function toFailure(
  rail: string,
  status: number,
  json: unknown,
  durationMs: number | null,
): ProviderFailure {
  const body = errorBodyOf(json);
  const nested =
    body !== null && body.error !== null && typeof body.error === "object"
      ? (body.error as Record<string, unknown>)
      : body;
  const category = categoryForStatus(status);
  return {
    category,
    retryable: isRetryableCategory(category),
    rail,
    providerCode: typeof nested?.code === "string" ? nested.code : null,
    providerMessage: sanitizeProviderMessage(
      typeof nested?.message === "string" ? nested.message : null,
    ),
    httpStatus: status,
    durationMs,
  };
}

function wireRequest(request: ModelRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  };
  if (request.maxTokens !== undefined) {
    body.max_tokens = request.maxTokens;
  }
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.structuredOutput !== undefined) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: request.structuredOutput.name,
        schema: request.structuredOutput.schema,
        strict: true,
      },
    };
  }
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return body;
}

export interface OpenRouterAdapterOptions {
  readonly transport: HttpTransport;
  /** Platform credential for `platform`-kind connections (BYOK takes precedence). */
  readonly platformCredential?: (() => string | null) | null;
  readonly defaultEndpoint?: string;
}

export function createOpenRouterAdapter(options: OpenRouterAdapterOptions): ModelProvider {
  const rail = "openrouter";
  const defaultEndpoint = options.defaultEndpoint ?? OPENROUTER_DEFAULT_ENDPOINT;

  const credentialOf = (context: ProviderDispatchContext): string | null =>
    context.credential ?? options.platformCredential?.() ?? null;

  const urlOf = (context: ProviderDispatchContext): string => {
    const base = (context.endpointUrl ?? defaultEndpoint).replace(/\/$/, "");
    return `${base}/chat/completions`;
  };

  const completeWith = async (
    request: ModelRequest,
    context: ProviderDispatchContext,
    stream: boolean,
  ): Promise<ModelCallOutcome> => {
    const credential = credentialOf(context);
    if (credential === null || credential.length === 0) {
      return {
        kind: "provider-failure",
        failure: {
          category: "authentication",
          retryable: false,
          rail,
          providerCode: "missing-credential",
          providerMessage: "no credential available for the openrouter rail",
          httpStatus: null,
          durationMs: null,
        },
      };
    }
    const startedAt = Date.now();
    // Shared adapter boundary: a send/timeout/mid-body failure returns as a
    // normalized rail-stamped failure — it never escapes as an exception.
    const sent = await postJson(options.transport, rail, {
      method: "POST",
      url: urlOf(context),
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
        accept: stream ? "text/event-stream" : "application/json",
      },
      bodyJson: wireRequest(request, stream),
      timeoutMs: context.timeoutMs,
    });
    if (!sent.ok) {
      return { kind: "provider-failure", failure: sent.failure };
    }
    const exchange = sent.exchange;
    const durationMs = Date.now() - startedAt;

    if (exchange.status < 200 || exchange.status >= 300) {
      return {
        kind: "provider-failure",
        failure: toFailure(rail, exchange.status, exchange.json, durationMs),
      };
    }

    if (stream) {
      // Streaming callers use `stream()`; reaching here with a stream body is
      // a contract violation — surface it as a malformed response.
      return {
        kind: "provider-failure",
        failure: {
          category: "malformed-response",
          retryable: false,
          rail,
          providerCode: null,
          providerMessage: "stream response returned to a non-stream dispatch",
          httpStatus: exchange.status,
          durationMs,
        },
      };
    }

    const body = errorBodyOf(exchange.json);
    const choices = body?.choices;
    const firstChoice =
      Array.isArray(choices) && choices.length > 0
        ? (choices[0] as Record<string, unknown> | undefined)
        : undefined;
    const message =
      firstChoice !== undefined &&
      firstChoice.message !== null &&
      typeof firstChoice.message === "object"
        ? (firstChoice.message as Record<string, unknown>)
        : undefined;
    if (message === undefined || body?.usage === undefined) {
      // 2xx without the required envelope is a PROVIDER failure (never a
      // quality failure) — the durable axis distinction applies (CON-005).
      return {
        kind: "provider-failure",
        failure: {
          category: "malformed-response",
          retryable: false,
          rail,
          providerCode: null,
          providerMessage: "response missing choices/usage envelope",
          httpStatus: exchange.status,
          durationMs,
        },
      };
    }

    const contentText = typeof message.content === "string" ? message.content : "";
    let structured: ModelResponse["structuredOutput"] = null;
    if (request.structuredOutput !== undefined && contentText.trim().length > 0) {
      try {
        const parsed = JSON.parse(contentText) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          structured = {
            name: request.structuredOutput.name,
            json: parsed as Record<string, unknown>,
          };
        }
      } catch {
        structured = null; // schema-conformance validation is a verification concern
      }
    }

    const response: ModelResponse = {
      content: contentText.length > 0 ? [contentText] : [],
      stopReason: finishReasonOf(
        typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : undefined,
      ),
      structuredOutput: structured,
      usage: normalizeUsage(body.usage as OpenRouterUsage),
      providerLatencyMs: durationMs,
    };
    return { kind: "provider-success", response };
  };

  return {
    rail,

    async complete(request, context) {
      return completeWith(request, context, false);
    },

    async *stream(request, context) {
      const credential = credentialOf(context);
      if (credential === null || credential.length === 0) {
        yield {
          type: "stream-error",
          failure: {
            category: "authentication",
            retryable: false,
            rail,
            providerCode: "missing-credential",
            providerMessage: "no credential available for the openrouter rail",
            httpStatus: null,
            durationMs: null,
          },
        };
        return;
      }
      const startedAt = Date.now();
      const url = urlOf(context);
      // Shared adapter boundary: a handshake rejection normalizes into a
      // terminal stream-error — it never escapes the generator.
      const sent = await sendForStream(options.transport, rail, {
        method: "POST",
        url,
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        bodyJson: wireRequest(request, true),
        timeoutMs: context.timeoutMs,
      });
      if (!sent.ok) {
        yield { type: "stream-error", failure: sent.failure };
        return;
      }
      const response = sent.response;
      if (response.status < 200 || response.status >= 300) {
        const text = await collectBodyText(guardedBody(rail, url, response.body));
        let json: unknown = null;
        try {
          json = JSON.parse(text) as unknown;
        } catch {
          json = null;
        }
        yield {
          type: "stream-error",
          failure: toFailure(rail, response.status, json, Date.now() - startedAt),
        };
        return;
      }

      let stopReason: StopReason = "other";
      let usage: NormalizedUsage = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: null,
      };
      try {
        for await (const event of parseSseStream(guardedBody(rail, url, response.body))) {
          if (event.data === "[DONE]") {
            break;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data) as unknown;
          } catch {
            continue; // provider keep-alives/comments surface as unparseable data
          }
          const chunk = errorBodyOf(parsed);
          if (chunk === null) {
            continue;
          }
          const choices = chunk.choices;
          const deltaChoice =
            Array.isArray(choices) && choices.length > 0
              ? (choices[0] as Record<string, unknown> | undefined)
              : undefined;
          if (deltaChoice !== undefined) {
            const delta =
              deltaChoice.delta !== null && typeof deltaChoice.delta === "object"
                ? (deltaChoice.delta as Record<string, unknown>)
                : undefined;
            if (typeof delta?.content === "string" && delta.content.length > 0) {
              yield { type: "text-delta", text: delta.content };
            }
            if (typeof deltaChoice.finish_reason === "string") {
              stopReason = finishReasonOf(deltaChoice.finish_reason);
            }
          }
          if (chunk.usage !== null && typeof chunk.usage === "object") {
            usage = normalizeUsage(chunk.usage as OpenRouterUsage);
          }
        }
        yield { type: "usage", usage };
        yield { type: "stream-done", stopReason, usage };
      } catch (error) {
        // A typed (rail-stamped) transport failure mid-stream becomes a
        // terminal stream-error; unknown rejections propagate unchanged —
        // honest unknown outcomes stay with the gateway's crash rule.
        if (!isProviderFailure(error)) {
          throw error;
        }
        yield { type: "stream-error", failure: error };
        return;
      }
    },
  };
}
