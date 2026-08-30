/**
 * Production HTTP transport over the runtime's global `fetch`
 * (models adapters).
 *
 * The only egress point for provider traffic in production. Uses NO runtime
 * HTTP imports — the platform `fetch` global is the sanctioned transport —
 * and converts the response body into the neutral async-byte-stream shape
 * the ports define. Timeouts are enforced with `AbortSignal.timeout`.
 */

import type { HttpRequestBody, HttpResponse, HttpTransport } from "../ports/http-transport";

async function* emptyBytes(): AsyncIterable<Uint8Array> {}

function emptyStream(): AsyncIterable<Uint8Array> {
  return emptyBytes();
}

export function createFetchTransport(): HttpTransport {
  return {
    async send(request: HttpRequestBody): Promise<HttpResponse> {
      const response = await fetch(request.url, {
        method: request.method,
        headers: { ...request.headers },
        body: request.bodyJson === undefined ? undefined : JSON.stringify(request.bodyJson),
        signal:
          request.timeoutMs === undefined ? undefined : AbortSignal.timeout(request.timeoutMs),
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      if (response.body === null) {
        return { status: response.status, headers, body: emptyStream() };
      }
      const stream = response.body as AsyncIterable<Uint8Array>;
      return { status: response.status, headers, body: stream };
    },
  };
}
