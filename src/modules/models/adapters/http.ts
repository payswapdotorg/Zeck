/**
 * JSON-over-HTTP exchange helpers for provider adapters (shared).
 *
 * Thin, neutral plumbing: one POST helper that returns either a parsed JSON
 * body or signals a non-JSON response, plus the transport-failure mapping
 * every adapter shares (network errors, timeouts). No provider names or
 * wire formats live here — adapters own their mappings.
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

export async function postJson(
  transport: HttpTransport,
  request: HttpRequestBody,
): Promise<JsonExchange> {
  let response: HttpResponse;
  try {
    response = await transport.send(request);
  } catch (error) {
    // Transport-level failure (connection refused, DNS, abort). Timeouts are
    // categorized distinctly when the runtime names them.
    const isAbort = error instanceof Error && error.name === "TimeoutError";
    const category: ProviderErrorCategory = isAbort ? "timeout" : "network";
    throw transportFailure(category, request.url, error);
  }
  let bodyText = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    bodyText += decoder.decode(chunk, { stream: true });
  }
  bodyText += decoder.decode();

  let json: unknown | null = null;
  const contentType = response.headers["content-type"] ?? "";
  if (contentType.includes("json") || bodyText.trimStart().startsWith("{")) {
    try {
      json = JSON.parse(bodyText) as unknown;
    } catch {
      json = null;
    }
  }
  return { status: response.status, headers: response.headers, json, bodyText };
}

export function transportFailure(
  category: ProviderErrorCategory,
  url: string,
  cause: unknown,
): ProviderFailure {
  void url;
  return {
    category,
    retryable: isRetryableCategory(category),
    rail: "", // filled by the adapter
    providerCode: cause instanceof Error ? cause.name : null,
    providerMessage: sanitizeProviderMessage(
      cause instanceof Error ? cause.message : String(cause),
    ),
    httpStatus: null,
    durationMs: null,
  };
}

/** Read a provider error field out of a JSON body defensively. */
export function errorBodyOf(json: unknown): Record<string, unknown> | null {
  if (json !== null && typeof json === "object" && !Array.isArray(json)) {
    return json as Record<string, unknown>;
  }
  return null;
}
