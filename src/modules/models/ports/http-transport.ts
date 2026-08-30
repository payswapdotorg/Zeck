/**
 * HTTP transport port (models module outbound).
 *
 * The neutral wire surface provider adapters may use. Tests substitute fake
 * transports with recorded wire fixtures; the production adapter
 * (`adapters/fetch-transport.ts`) wraps the runtime's global `fetch`. The
 * port keeps provider adapters free of runtime HTTP imports while remaining
 * the only egress point for provider traffic.
 */

export interface HttpRequestBody {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyJson?: unknown;
  readonly timeoutMs?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Byte stream of the response body (works for SSE streaming and full bodies). */
  readonly body: AsyncIterable<Uint8Array>;
}

export interface HttpTransport {
  send(request: HttpRequestBody): Promise<HttpResponse>;
}

/** Collect a response body into a string (non-streaming calls). */
export async function collectBodyText(body: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return text;
}

async function* singleChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

/** Build a single-chunk response (test helper shape). */
export function textResponse(
  status: number,
  text: string,
  headers: Record<string, string> = {},
): HttpResponse {
  return {
    status,
    headers,
    body: singleChunk(new TextEncoder().encode(text)),
  };
}
