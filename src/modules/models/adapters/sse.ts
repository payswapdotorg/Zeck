/**
 * Server-Sent Events parser (models adapters, shared).
 *
 * Both supported upstream rails stream SSE (`text/event-stream`); this
 * parser turns raw body chunks into `data:` payload strings according to the
 * SSE specification subset providers use (event dispatching by blank-line
 * boundaries; `data:` lines joined with `\n`; comments ignored). Multi-line
 * data and CRLF endings are handled; named events are surfaced for adapters
 * that need them.
 */

export interface SseEvent {
  readonly event: string | null;
  readonly data: string;
}

const DATA_PREFIX = "data:";
const EVENT_PREFIX = "event:";

export async function* parseSseStream(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<SseEvent, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  let pendingEvent: string | null = null;
  let dataLines: string[] = [];

  const dispatch = function* (): Generator<SseEvent> {
    if (dataLines.length > 0) {
      const event: SseEvent = { event: pendingEvent, data: dataLines.join("\n") };
      yield event;
    }
    pendingEvent = null;
    dataLines = [];
  };

  const feed = function* (chunk: string): Generator<SseEvent> {
    buffer += chunk;
    let boundary = buffer.indexOf("\n");
    while (boundary !== -1) {
      const rawLine = buffer.slice(0, boundary).replace(/\r$/, "");
      buffer = buffer.slice(boundary + 1);
      if (rawLine === "") {
        yield* dispatch();
      } else if (rawLine.startsWith(DATA_PREFIX)) {
        dataLines.push(rawLine.slice(DATA_PREFIX.length).replace(/^ /, ""));
      } else if (rawLine.startsWith(EVENT_PREFIX)) {
        pendingEvent = rawLine.slice(EVENT_PREFIX.length).replace(/^ /, "").trim();
      }
      // Comments (`:...`) and other fields are ignored.
      boundary = buffer.indexOf("\n");
    }
  };

  for await (const chunk of body) {
    yield* feed(decoder.decode(chunk, { stream: true }));
  }
  yield* feed(decoder.decode());
  // Flush a trailing event not terminated by a blank line.
  yield* dispatch();
}
