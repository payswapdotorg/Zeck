/**
 * Unit — the Cloudflare Queues adapter WIRE CONTRACT (WORK-044 / D-03;
 * the PPR-004 drift corrections), pinned through an injected fetch
 * double: the exact request shapes the adapter puts on the wire and
 * the pull-body normalization, without any socket.
 *
 * Pins (the corrected contract — see the adapter's header for the
 * verification basis of each shape):
 *  - publish: the BARE object `{"body": <plain JSON object>}` — the
 *    port's string payload inside the versioned envelope; the stale
 *    `content_type` passthrough and the stale `delay_ms` field are
 *    GONE; a requested delay rides as `delay_seconds` (seconds);
 *  - pull: `POST .../messages/pull` with `{batch_size,
 *    visibility_timeout_ms}` (the stale endpoint was /messages/poll);
 *  - settle: `POST .../messages/ack` with `{"acks": [{"lease_id"}],
 *    "retries": [{"lease_id"}]}`;
 *  - pull-body normalization: a base64 json body decodes and the
 *    envelope unwraps to the exact published payload; a "text" body
 *    passes through; a foreign object body canonicalizes to JSON
 *    text; a non-base64 json body passes through verbatim.
 */

import { describe, expect, test } from "vitest";
import { createCloudflareQueuesTransport } from "../../../src/platform/queue/cloudflare-queues";

const ACCOUNT = "a".repeat(32);
const QUEUE = "b".repeat(32);
const TOKEN = "unit-wire-contract-token";

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** A fetch double that records every request and answers from a script. */
function scriptedFetch(script: readonly { readonly status: number; readonly json: unknown }[]): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  let index = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    });
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    return new Response(JSON.stringify(step?.json ?? { success: true }), {
      status: step?.status ?? 200,
    });
  };
  return { fetchImpl, requests };
}

const transportWith = (fetchImpl: typeof fetch) =>
  createCloudflareQueuesTransport({
    apiBaseUrl: "https://queues.example.test",
    accountId: ACCOUNT,
    queueId: QUEUE,
    apiToken: TOKEN,
    fetchImpl,
    requestTimeoutMs: 1000,
  });

describe("the corrected Cloudflare Queues wire contract (PPR-004)", () => {
  test('publish puts the BARE object {"body": <envelope>} on the wire — never content_type, never delay_ms', async () => {
    const { fetchImpl, requests } = scriptedFetch([{ status: 200, json: { success: true } }]);
    const t = transportWith(fetchImpl);
    const payload = JSON.stringify({ correlationKey: "execution-dispatch:unit-1" });
    await t.publish({ body: payload, contentType: "application/json" });
    expect(requests).toHaveLength(1);
    const request = requests[0] as RecordedRequest;
    expect(request.url).toBe(
      `https://queues.example.test/accounts/${ACCOUNT}/queues/${QUEUE}/messages`,
    );
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // The live-verified shape: the bare body object with the payload
    // inside the versioned envelope. The stale shapes — a string body
    // value, a content_type passthrough — must NEVER reappear (the
    // live API refuses them: 400 code 10207 / enum validation).
    expect(request.body).toEqual({ body: { zeckTransport: 1, payload } });
  });

  test("a requested delivery delay rides as delay_seconds (the current schema field)", async () => {
    const { fetchImpl, requests } = scriptedFetch([{ status: 200, json: { success: true } }]);
    await transportWith(fetchImpl).publish({ body: "x", delaySeconds: 120 });
    expect(requests[0]?.body).toEqual({
      body: { zeckTransport: 1, payload: "x" },
      delay_seconds: 120,
    });
  });

  test("an out-of-bounds delay fails closed before any wire call", async () => {
    const { fetchImpl, requests } = scriptedFetch([{ status: 200, json: { success: true } }]);
    await expect(
      transportWith(fetchImpl).publish({ body: "x", delaySeconds: 86_401 }),
    ).rejects.toThrow(/delaySeconds/);
    expect(requests).toHaveLength(0);
  });

  test("pull posts to /messages/pull with batch_size and visibility_timeout_ms", async () => {
    const { fetchImpl, requests } = scriptedFetch([
      { status: 200, json: { success: true, result: { message_backlog_count: 0, messages: [] } } },
    ]);
    await transportWith(fetchImpl).pull({ batchSize: 7, visibilityTimeoutMs: 5_000 });
    const request = requests[0] as RecordedRequest;
    expect(request.url).toBe(
      `https://queues.example.test/accounts/${ACCOUNT}/queues/${QUEUE}/messages/pull`,
    );
    expect(request.body).toEqual({ visibility_timeout_ms: 5_000, batch_size: 7 });
  });

  test("settle posts to /messages/ack with the acks/retries lease shape", async () => {
    const { fetchImpl, requests } = scriptedFetch([{ status: 200, json: { success: true } }]);
    await transportWith(fetchImpl).settle({
      ackLeaseIds: ["lease-a", "lease-b"],
      retryLeaseIds: ["lease-c"],
    });
    const request = requests[0] as RecordedRequest;
    expect(request.url).toBe(
      `https://queues.example.test/accounts/${ACCOUNT}/queues/${QUEUE}/messages/ack`,
    );
    expect(request.body).toEqual({
      acks: [{ lease_id: "lease-a" }, { lease_id: "lease-b" }],
      retries: [{ lease_id: "lease-c" }],
    });
  });

  test("an empty settle issues no wire call", async () => {
    const { fetchImpl, requests } = scriptedFetch([{ status: 200, json: { success: true } }]);
    await transportWith(fetchImpl).settle({ ackLeaseIds: [], retryLeaseIds: [] });
    expect(requests).toHaveLength(0);
  });

  test("pull-body normalization: a base64 json body decodes and the envelope unwraps to the exact payload", async () => {
    const payload = JSON.stringify({ v: 1, correlationKey: "execution-dispatch:unit-2" });
    const wireBody = Buffer.from(JSON.stringify({ zeckTransport: 1, payload }), "utf8").toString(
      "base64",
    );
    const { fetchImpl } = scriptedFetch([
      {
        status: 200,
        json: {
          success: true,
          result: {
            message_backlog_count: 1,
            messages: [
              {
                id: "cf-message-1",
                lease_id: "lease-1",
                body: wireBody,
                attempts: 1,
                timestamp_ms: 1_689_615_013_000,
                metadata: { "CF-Content-Type": "json" },
              },
            ],
          },
        },
      },
    ]);
    const batch = await transportWith(fetchImpl).pull({ batchSize: 5 });
    expect(batch.messages).toHaveLength(1);
    // The lossless round trip: the EXACT string the port published.
    expect(batch.messages[0]?.body).toBe(payload);
    expect(batch.messages[0]?.contentType).toBe("json");
    expect(batch.backlogEstimate).toBe(1);
  });

  test("pull-body normalization: a text body passes through as the plain UTF-8 string", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        status: 200,
        json: {
          success: true,
          result: {
            message_backlog_count: 0,
            messages: [
              {
                id: "cf-message-2",
                lease_id: "lease-2",
                body: "a plain text body",
                attempts: 2,
                timestamp_ms: 1_689_615_013_000,
                metadata: { "CF-Content-Type": "text" },
              },
            ],
          },
        },
      },
    ]);
    const batch = await transportWith(fetchImpl).pull({ batchSize: 5 });
    expect(batch.messages[0]?.body).toBe("a plain text body");
    expect(batch.messages[0]?.contentType).toBe("text");
    expect(batch.messages[0]?.attempts).toBe(2);
  });

  test("pull-body normalization: a foreign object body canonicalizes to its JSON text; a non-base64 json body passes through verbatim", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        status: 200,
        json: {
          success: true,
          result: {
            message_backlog_count: 0,
            messages: [
              {
                id: "cf-message-3",
                lease_id: "lease-3",
                body: { foreign: true, note: "not ours" },
                attempts: 1,
                timestamp_ms: 1_689_615_013_000,
                metadata: { "CF-Content-Type": "json" },
              },
              {
                id: "cf-message-4",
                lease_id: "lease-4",
                // Contains '-', which is not in the RFC 4648 alphabet:
                // not strict base64 → verbatim (never silently dropped).
                body: "legacy-not-base64!!",
                attempts: 1,
                timestamp_ms: 1_689_615_013_000,
                metadata: { "CF-Content-Type": "json" },
              },
            ],
          },
        },
      },
    ]);
    const batch = await transportWith(fetchImpl).pull({ batchSize: 5 });
    expect(batch.messages[0]?.body).toBe('{"foreign":true,"note":"not ours"}');
    expect(batch.messages[1]?.body).toBe("legacy-not-base64!!");
  });
});
