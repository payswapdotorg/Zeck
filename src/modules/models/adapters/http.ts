/**
 * JSON-over-HTTP exchange helpers for provider adapters (shared).
 *
 * The SHARED ADAPTER BOUNDARY for transport-failure normalization
 * (architect review, PR #6): a known network/timeout failure NEVER crosses
 * this boundary as an exception. Send failures, response-body read failures
 * and mid-stream body failures all normalize here into rail-stamped
 * `ProviderFailure` values, which the owning adapter maps onto the durable
 * outcome vocabulary (`provider-failure` outcomes / terminal `stream-error`
 * events) so the gateway can journal them (CON-005). No provider names or
 * wire formats live here — the adapter supplies its rail identity, this
 * boundary preserves it.
 */

import type { ProviderErrorCategory, ProviderFailure } from "../domain/provider-failure";
import { isRetryableCategory, sanitizeProviderMessage } from "../domain/provider-failure";
import type { HttpRequestBody, HttpResponse, HttpTransport } from "../ports/http-transport";

export interface JsonExchange {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly json: unknown | null;
  readonly bodyText: string;
}

/**
 * Result of a one-shot JSON exchange: either the parsed exchange or the
 * normalized transport failure (send rejection, timeout, mid-body network
 * failure). Never a thrown transport failure.
 */
export type JsonExchangeResult =
  | { readonly ok: true; readonly exchange: JsonExchange }
  | { readonly ok: false; readonly failure: ProviderFailure };

/**
 * Classify a transport-level rejection. Timeouts are categorized distinctly
 * when the runtime names them (`TimeoutError`, produced by
 * `AbortSignal.timeout` in the fetch transport); every other transport
 * rejection (connection refused, DNS, reset) is `network`.
 */
export function classifyTransportError(error: unknown): ProviderErrorCategory {
  const isTimeout =
    error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return isTimeout ? "timeout" : "network";
}

/** Build a normalized, RAIL-STAMPED provider failure for a transport rejection. */
export function transportFailure(rail: string, url: string, cause: unknown): ProviderFailure {
  const category = classifyTransportError(cause);
  void url;
  return {
    category,
    retryable: isRetryableCategory(category),
    rail,
    providerCode: cause instanceof Error ? cause.name : null,
    providerMessage: sanitizeProviderMessage(
      cause instanceof Error ? cause.message : String(cause),
    ),
    httpStatus: null,
    durationMs: null,
  };
}

export async function postJson(
  transport: HttpTransport,
  rail: string,
  request: HttpRequestBody,
): Promise<JsonExchangeResult> {
  let response: HttpResponse;
  try {
    response = await transport.send(request);
  } catch (error) {
    return { ok: false, failure: transportFailure(rail, request.url, error) };
  }
  let bodyText = "";
  const decoder = new TextDecoder();
  try {
    for await (const chunk of response.body) {
      bodyText += decoder.decode(chunk, { stream: true });
    }
    bodyText += decoder.decode();
  } catch (error) {
    // Mid-body transport failure (connection reset while reading): a KNOWN
    // provider-side failure, not an escape.
    return { ok: false, failure: transportFailure(rail, request.url, error) };
  }

  let json: unknown | null = null;
  const contentType = response.headers["content-type"] ?? "";
  if (contentType.includes("json") || bodyText.trimStart().startsWith("{")) {
    try {
      json = JSON.parse(bodyText) as unknown;
    } catch {
      json = null;
    }
  }
  return {
    ok: true,
    exchange: { status: response.status, headers: response.headers, json, bodyText },
  };
}

/**
 * Streaming handshake with the same normalization: either the response whose
 * body will be consumed as a stream, or the normalized transport failure for
 * the adapter to surface as a terminal `stream-error` event.
 */
export async function sendForStream(
  transport: HttpTransport,
  rail: string,
  request: HttpRequestBody,
): Promise<{ ok: true; response: HttpResponse } | { ok: false; failure: ProviderFailure }> {
  try {
    return { ok: true, response: await transport.send(request) };
  } catch (error) {
    return { ok: false, failure: transportFailure(rail, request.url, error) };
  }
}

/**
 * Guard a response body so a mid-stream transport rejection (connection reset
 * part-way through an SSE stream) surfaces as a rail-stamped
 * `ProviderFailure` rejection. The adapter converts that typed rejection
 * into a terminal `stream-error` event; unknown rejections pass through
 * untouched (honest unknown outcomes stay with the gateway's crash rule).
 */
export function guardedBody(
  rail: string,
  url: string,
  body: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of body) {
          yield chunk;
        }
      } catch (error) {
        throw transportFailure(rail, url, error);
      }
    },
  };
}

/** Read a provider error field out of a JSON body defensively. */
export function errorBodyOf(json: unknown): Record<string, unknown> | null {
  if (json !== null && typeof json === "object" && !Array.isArray(json)) {
    return json as Record<string, unknown>;
  }
  return null;
}
