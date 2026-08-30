/**
 * Anthropic adapter — one DIRECT provider rail (CON-004).
 *
 * A direct provider coexisting with the aggregation rail behind the identical
 * neutral `ModelProvider` contract. No SDK: the Messages API speaks JSON over
 * HTTP through the neutral `HttpTransport` port; provider specifics live ONLY
 * in this file (architecture-lock invariant 2).
 *
 * Normalization differences this adapter owns (the coexistence proof that
 * one contract really is provider-neutral):
 *   * credentials travel as `x-api-key` (+ `anthropic-version`), not bearer;
 *   * structured output has no native json-schema response format on this
 *     rail — the adapter forces a single tool whose `input_schema` IS the
 *     requested schema and extracts the tool `input` as the structured JSON;
 *   * usage arrives split across `message_start` (input) and `message_delta`
 *     (output) during streaming, and never carries USD cost;
 *   * provider errors are typed by `error.type` rather than HTTP status.
 */

import type { ModelCallOutcome } from "../domain/outcome";
import type { ProviderErrorCategory, ProviderFailure } from "../domain/provider-failure";
import { isRetryableCategory, sanitizeProviderMessage } from "../domain/provider-failure";
import type { ModelRequest, StopReason } from "../domain/request";
import type {
  ModelResponse,
  NormalizedStructuredOutput,
  NormalizedUsage,
} from "../domain/response";
import type { StreamEvent } from "../domain/stream";
import type { HttpTransport } from "../ports/http-transport";
import { collectBodyText } from "../ports/http-transport";
import type { ModelProvider, ProviderDispatchContext } from "../ports/model-provider";
import { errorBodyOf, postJson } from "./http";
import { parseSseStream } from "./sse";

export const ANTHROPIC_DEFAULT_ENDPOINT = "https://api.anthropic.com/v1";
export const ANTHROPIC_API_VERSION = "2023-06-01";

const ERROR_TYPE_CATEGORIES: Readonly<Record<string, ProviderErrorCategory>> = {
  authentication_error: "authentication",
  permission_error: "authorization",
  not_found_error: "invalid-request",
  invalid_request_error: "invalid-request",
  request_too_large: "invalid-request",
  rate_limit_error: "rate-limit",
  api_error: "provider-unavailable",
  overloaded_error: "provider-unavailable",
  timeout_error: "timeout",
};

function categoryFor(errorType: string | null, status: number): ProviderErrorCategory {
  if (errorType !== null && errorType in ERROR_TYPE_CATEGORIES) {
    return ERROR_TYPE_CATEGORIES[errorType] ?? "unknown";
  }
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "provider-unavailable";
  if (status === 408) return "timeout";
  if (status >= 400) return "invalid-request";
  return "unknown";
}

function stopReasonOf(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content-filter";
    case "tool_use":
      return "tool-use";
    default:
      return "other";
  }
}

interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
}

function normalizeUsage(usage: AnthropicUsage | undefined): NormalizedUsage {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  // This rail reports no USD cost — null, never invented.
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, costUsd: null };
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
      : null;
  const errorType = typeof nested?.type === "string" ? nested.type : null;
  const category = categoryFor(errorType, status);
  return {
    category,
    retryable: isRetryableCategory(category),
    rail,
    providerCode: errorType,
    providerMessage: sanitizeProviderMessage(
      typeof nested?.message === "string" ? nested.message : null,
    ),
    httpStatus: status,
    durationMs,
  };
}

interface WireBody {
  readonly model: string;
  readonly messages: { role: "user" | "assistant"; content: string }[];
  readonly system?: string;
  readonly max_tokens: number;
  readonly temperature?: number;
  readonly tools?: { name: string; input_schema: Record<string, unknown> }[];
  readonly tool_choice?: { type: "tool"; name: string };
  readonly stream?: boolean;
}

function wireRequest(request: ModelRequest, stream: boolean): WireBody {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  return {
    model: request.model,
    messages: request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: message.content,
      })),
    max_tokens: request.maxTokens ?? 4096,
    ...(system.length > 0 ? { system } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.structuredOutput !== undefined
      ? {
          // Forced single tool: the provider is REQUIRED to produce a JSON
          // object conforming to the schema as the tool input — this rail's
          // native structured-output mechanism.
          tools: [
            {
              name: request.structuredOutput.name,
              input_schema: request.structuredOutput.schema,
            },
          ],
          tool_choice: { type: "tool" as const, name: request.structuredOutput.name },
        }
      : {}),
    ...(stream ? { stream: true } : {}),
  };
}

interface AnthropicContentBlock {
  readonly type?: string;
  readonly text?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

interface AnthropicMessageBody {
  readonly content?: AnthropicContentBlock[];
  readonly stop_reason?: string;
  readonly usage?: AnthropicUsage;
}

function extractStructured(
  blocks: readonly AnthropicContentBlock[] | undefined,
  spec: ModelRequest["structuredOutput"],
): NormalizedStructuredOutput | null {
  if (spec === undefined || blocks === undefined) {
    return null;
  }
  const toolUse = blocks.find((block) => block.type === "tool_use");
  if (
    toolUse !== undefined &&
    toolUse.input !== null &&
    typeof toolUse.input === "object" &&
    !Array.isArray(toolUse.input)
  ) {
    return { name: spec.name, json: toolUse.input };
  }
  return null;
}

function missingCredentialFailure(rail: string): ProviderFailure {
  return {
    category: "authentication",
    retryable: false,
    rail,
    providerCode: "missing-credential",
    providerMessage: "no credential available for the anthropic rail",
    httpStatus: null,
    durationMs: null,
  };
}

export interface AnthropicAdapterOptions {
  readonly transport: HttpTransport;
  /** Platform credential for `platform`-kind connections (BYOK takes precedence). */
  readonly platformCredential?: (() => string | null) | null;
  readonly defaultEndpoint?: string;
}

export function createAnthropicAdapter(options: AnthropicAdapterOptions): ModelProvider {
  const rail = "anthropic";
  const defaultEndpoint = options.defaultEndpoint ?? ANTHROPIC_DEFAULT_ENDPOINT;

  const credentialOf = (context: ProviderDispatchContext): string | null =>
    context.credential ?? options.platformCredential?.() ?? null;

  const urlOf = (context: ProviderDispatchContext): string => {
    const base = (context.endpointUrl ?? defaultEndpoint).replace(/\/$/, "");
    return `${base}/messages`;
  };

  const headersOf = (credential: string): Record<string, string> => ({
    "x-api-key": credential,
    "anthropic-version": ANTHROPIC_API_VERSION,
    "content-type": "application/json",
  });

  return {
    rail,

    async complete(request, context): Promise<ModelCallOutcome> {
      const credential = credentialOf(context);
      if (credential === null || credential.length === 0) {
        return { kind: "provider-failure", failure: missingCredentialFailure(rail) };
      }
      const startedAt = Date.now();
      const exchange = await postJson(options.transport, {
        method: "POST",
        url: urlOf(context),
        headers: headersOf(credential),
        bodyJson: wireRequest(request, false),
        timeoutMs: context.timeoutMs,
      });
      const durationMs = Date.now() - startedAt;

      if (exchange.status < 200 || exchange.status >= 300) {
        return {
          kind: "provider-failure",
          failure: toFailure(rail, exchange.status, exchange.json, durationMs),
        };
      }

      const body = errorBodyOf(exchange.json) as
        | (Record<string, unknown> & AnthropicMessageBody)
        | null;
      if (
        body === undefined ||
        body === null ||
        !Array.isArray(body.content) ||
        body.usage === undefined
      ) {
        // 2xx without the required envelope is a PROVIDER failure on the
        // provider axis — never a quality failure (CON-005).
        return {
          kind: "provider-failure",
          failure: {
            category: "malformed-response",
            retryable: false,
            rail,
            providerCode: null,
            providerMessage: "response missing content/usage envelope",
            httpStatus: exchange.status,
            durationMs,
          },
        };
      }

      const textParts = body.content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string);
      const response: ModelResponse = {
        content: textParts,
        stopReason: stopReasonOf(body.stop_reason),
        structuredOutput: extractStructured(body.content, request.structuredOutput),
        usage: normalizeUsage(body.usage),
        providerLatencyMs: durationMs,
      };
      return { kind: "provider-success", response };
    },

    async *stream(request, context): AsyncIterable<StreamEvent> {
      const credential = credentialOf(context);
      if (credential === null || credential.length === 0) {
        yield { type: "stream-error", failure: missingCredentialFailure(rail) };
        return;
      }
      const startedAt = Date.now();
      const response = await options.transport.send({
        method: "POST",
        url: urlOf(context),
        headers: { ...headersOf(credential), accept: "text/event-stream" },
        bodyJson: wireRequest(request, true),
        timeoutMs: context.timeoutMs,
      });
      if (response.status < 200 || response.status >= 300) {
        const text = await collectBodyText(response.body);
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
      let inputTokens = 0;
      let outputTokens = 0;
      let usage: NormalizedUsage = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: null,
      };
      const recomputeUsage = (): NormalizedUsage => ({
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        costUsd: null,
      });
      for await (const event of parseSseStream(response.body)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data) as unknown;
        } catch {
          continue;
        }
        const body = errorBodyOf(parsed) as (Record<string, unknown> & AnthropicMessageBody) | null;
        if (body === null) {
          continue;
        }
        const type = typeof body.type === "string" ? body.type : event.event;
        if (type === "content_block_delta") {
          const delta =
            body.delta !== null && typeof body.delta === "object"
              ? (body.delta as Record<string, unknown>)
              : undefined;
          if (typeof delta?.text === "string" && delta.text.length > 0) {
            yield { type: "text-delta", text: delta.text };
          }
          if (typeof delta?.partial_json === "string" && delta.partial_json.length > 0) {
            yield { type: "structured-delta", jsonFragment: delta.partial_json };
          }
        } else if (type === "message_start") {
          const message =
            body.message !== null && typeof body.message === "object"
              ? (body.message as Record<string, unknown> & { usage?: AnthropicUsage })
              : undefined;
          if (message?.usage !== undefined) {
            inputTokens = message.usage.input_tokens ?? 0;
            usage = recomputeUsage();
          }
        } else if (type === "message_delta") {
          const delta =
            body.delta !== null && typeof body.delta === "object"
              ? (body.delta as Record<string, unknown>)
              : undefined;
          if (typeof delta?.stop_reason === "string") {
            stopReason = stopReasonOf(delta.stop_reason);
          }
          if (body.usage !== undefined) {
            outputTokens = body.usage.output_tokens ?? outputTokens;
            usage = recomputeUsage();
          }
        } else if (type === "error") {
          yield {
            type: "stream-error",
            failure: toFailure(rail, 200, parsed, Date.now() - startedAt),
          };
          return;
        }
      }
      yield { type: "usage", usage };
      yield { type: "stream-done", stopReason, usage };
    },
  };
}
