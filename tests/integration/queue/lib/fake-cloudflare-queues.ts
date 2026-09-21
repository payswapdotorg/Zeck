/**
 * A minimal in-process Cloudflare-Queues-REST-compatible server for
 * the D-03 queue transport integration tests (WORK-044).
 *
 * This is NOT Cloudflare — it is a local, deterministic stand-in that
 * speaks the DOCUMENTED + LIVE-VERIFIED Queues REST surface the
 * adapter uses (publish / pull / ack), and VERIFIES the Bearer
 * authorization, so the adapter's wire behavior is proven end-to-end
 * over real HTTP without provider credentials. Real-Cloudflare
 * evidence is separately gated (queue-live.test.ts) and never claimed
 * from this server.
 *
 * The server hosts the EXECUTION queue (options.queueId) and,
 * optionally, a second DEDICATED PROBE QUEUE on the same account
 * (options.probeQueueId) — the PR #6 correction's probe isolation
 * tests lease the two queues apart and prove the probe never touches
 * the execution queue. Requests to any other queue id answer 404 (the
 * adapter cannot wander). Both queues can be pre-seeded with workload
 * (options.seeded / options.probeSeeded) so tests can prove what the
 * probe does to messages it does not own.
 *
 * WIRE PROTOCOL (the PPR-004 drift correction — mirrors the Lead's
 * live probe matrix of 2026-09-21 plus the current public API
 * reference at developers.cloudflare.com/api, fetched 2026-09-21):
 *
 *  - publish ("Push Message"):
 *    `POST /accounts/{account}/queues/{queue}/messages` — the request
 *    body is the ONE-OF union the current public schema documents:
 *    `{"body": <string>, "content_type": "text", "delay_seconds"?}`
 *    (MqQueueMessageText) or `{"body": <object|array|any json>,
 *    "content_type": "json"|"text"|absent, "delay_seconds"?}` — with
 *    the LIVE-VERIFIED refusals: a STRING body under the json
 *    (default) content type → HTTP 400 provider code 10207
 *    "Expected object, received string at \"body\""; a MISSING body
 *    field (any `{"messages": [...]}` wrapper) → HTTP 400
 *    "Required at \"body\""; a non-enum content_type → HTTP 400.
 *    Success answers the live-verified 200 envelope
 *    `{"success": true, "result": {"metadata": {"metrics":
 *    {"backlog_bytes", "backlog_count", "oldest_message_timestamp_ms"}}}}`.
 *  - http_pull consumer (LIVE-VERIFIED provisioning): `POST
 *    /accounts/{account}/queues/{queue}/consumers` with
 *    `{"type": "http_pull"}` → HTTP 200 (mirrors `wrangler queues
 *    consumer http add`). A queue without an http_pull consumer
 *    REFUSES pull exactly as the live plane does: HTTP 405
 *    "messages cannot be pulled unless http_pull mode is enabled".
 *  - pull ("Pull Queue Messages"): `POST .../messages/pull` with
 *    `{"visibility_timeout_ms", "batch_size"}` (both optional; batch
 *    max 100, visibility max 12h) → the documented envelope
 *    `{"success":true,"result":{"message_backlog_count":N,
 *    "messages":[...]}}`. Per the current public documentation the
 *    `json` (default) and `bytes` content types are delivered
 *    BASE64-ENCODED (RFC 4648) over the REST pull surface; `text`
 *    bodies arrive as plain UTF-8 strings. The stale `/messages/poll`
 *    path is NOT routed (404) — the current API documents `/pull`.
 *  - ack ("Acknowledge + Retry Queue Messages"): `POST
 *    .../messages/ack` with `{"acks":[{"lease_id"}],
 *    "retries":[{"lease_id"}]}` → `{"success":true}` (verified
 *    against the current public API reference).
 *
 * Errors answer the Cloudflare v4 envelope:
 * `{"success":false,"errors":[{"code","message"}]}`.
 */

import { createServer, type Server } from "node:http";

export interface FakeQueueOptions {
  readonly accountId: string;
  /** The EXECUTION queue id (the transport's configured queue). */
  readonly queueId: string;
  readonly apiToken: string;
  /**
   * An additional queue hosted on the same account: the DEDICATED
   * probe queue. Requests routed here belong to probe traffic only.
   */
  readonly probeQueueId?: string;
  /** Wire bodies seeded on the execution queue before any request. */
  readonly seeded?: readonly unknown[];
  /** Wire bodies seeded on the probe queue before any request. */
  readonly probeSeeded?: readonly unknown[];
  /**
   * Queues that carry an operator-provisioned http_pull consumer from
   * construction (out-of-band provisioning, e.g. the Cloudflare
   * dashboard or `wrangler queues consumer http add` run by the
   * operator before the test). Queues NOT listed here refuse pull
   * with the live 405 exactly as an unprovisioned live queue does,
   * until a consumer is created through the real REST call
   * (`POST .../consumers {"type": "http_pull"}`).
   */
  readonly httpPull?: {
    readonly execution?: boolean;
    readonly probe?: boolean;
  };
  /** Fail every request with 401 (credential-rejection path). */
  readonly rejectAuth?: boolean;
  /** Answer every request with 503 (transient outage path). */
  readonly outage?: boolean;
  /** Answer the next N publish calls with 429 (rate-limit path). */
  readonly rateLimitPublish?: number;
}

interface StoredMessage {
  readonly id: string;
  readonly body: unknown;
  /** The provider content type this message carries ("text" | "json"). */
  readonly contentType: "text" | "json";
  readonly timestampMs: number;
  lease: { leaseId: string; expiresAtMs: number } | null;
  attempts: number;
  settled: boolean;
}

/** Which of the hosted queues a request or accessor addresses. */
export type FakeQueueRole = "execution" | "probe";

export interface FakeQueueServer {
  readonly port: number;
  readonly baseUrl: string;
  close(): Promise<void>;
  readonly requests: readonly {
    readonly method: string;
    readonly path: string;
    readonly authorization: string;
    readonly body: unknown;
  }[];
  /** Unsettled (pending) message count on the execution queue. */
  readonly pendingCount: number;
  /**
   * True iff the addressed queue currently carries an http_pull
   * consumer (the REST pull precondition).
   */
  httpPullEnabled(role: FakeQueueRole): boolean;
  /**
   * Snapshot of the unsettled (never-acknowledged, still-deliverable)
   * message bodies on the addressed queue — what a probe must NOT
   * change for messages it does not own.
   */
  pendingBodies(role: FakeQueueRole): readonly unknown[];
  /**
   * Snapshot of the acknowledged message bodies on the addressed
   * queue — what a probe was allowed to settle (its own message).
   */
  settledBodies(role: FakeQueueRole): readonly unknown[];
}

interface QueueStore {
  readonly messages: StoredMessage[];
  httpPull: boolean;
}

export async function startFakeCloudflareQueues(
  options: FakeQueueOptions,
): Promise<FakeQueueServer> {
  const executionStore: QueueStore = {
    messages: [],
    httpPull: options.httpPull?.execution === true,
  };
  const probeStore: QueueStore = {
    messages: [],
    httpPull: options.httpPull?.probe === true,
  };
  const requests: {
    method: string;
    path: string;
    authorization: string;
    body: unknown;
  }[] = [];
  let counter = 0;
  let rateLimitedLeft = options.rateLimitPublish ?? 0;

  const nextId = (): string => {
    counter += 1;
    return `cf-message-${counter.toString(16).padStart(32, "0")}`;
  };

  /**
   * Seeded bodies: a plain string lands as a "text" message (plain
   * UTF-8 on pull); an object/array lands as a "json" message
   * (base64-encoded on pull) — the documented delivery forms.
   */
  const seed = (store: QueueStore, bodies: readonly unknown[]): void => {
    for (const body of bodies) {
      store.messages.push({
        id: nextId(),
        body,
        contentType: typeof body === "string" ? "text" : "json",
        timestampMs: 1_689_615_013_000 + counter,
        lease: null,
        attempts: 0,
        settled: false,
      });
    }
  };
  seed(executionStore, options.seeded ?? []);
  seed(probeStore, options.probeSeeded ?? []);

  const storeFor = (queueId: string): QueueStore | null =>
    queueId === options.queueId
      ? executionStore
      : options.probeQueueId !== undefined && queueId === options.probeQueueId
        ? probeStore
        : null;

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
      }
      const authorization = request.headers.authorization ?? "";
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization,
        body,
      });

      const fail = (status: number, code: number, message: string): void => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ success: false, errors: [{ code, message }] }));
      };

      if (options.outage === true) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ success: false, errors: [] }));
        return;
      }
      if (authorization !== `Bearer ${options.apiToken}`) {
        fail(401, 10000, "authentication error");
        return;
      }

      const path = request.url ?? "";
      const route = /^\/accounts\/([^/]+)\/queues\/([^/]+)\/messages(\/pull|\/ack)?$/.exec(path);
      const consumerRoute = /^\/accounts\/([^/]+)\/queues\/([^/]+)\/consumers$/.exec(path);

      if (request.method === "POST" && route !== null && route[1] === options.accountId) {
        const store = storeFor(route[2] ?? "");
        if (store === null) {
          fail(404, 7000, "no such queue");
          return;
        }
        const suffix = route[3] ?? "";

        if (suffix === "") {
          // publish — the live-verified one-of union + refusals.
          if (rateLimitedLeft > 0) {
            rateLimitedLeft -= 1;
            fail(429, 13943, "ratelimited");
            return;
          }
          const record = (body ?? {}) as Record<string, unknown>;
          if (typeof record.body === "undefined") {
            // LIVE-VERIFIED: any {"messages": [...]} wrapper (or any
            // request without the body field) → 400 "Required at body".
            fail(400, 7003, 'Validation error: Required at "body"');
            return;
          }
          const contentType = record.content_type === undefined ? "json" : record.content_type;
          if (contentType !== "text" && contentType !== "json") {
            // The current public schema types content_type as the enum
            // "text" | "json" — a free-form MIME string is refused.
            fail(
              400,
              10207,
              `Validation error: Expected 'text' or 'json' at "content_type" (received: ${JSON.stringify(contentType)})`,
            );
            return;
          }
          if (
            contentType === "json" &&
            (typeof record.body === "string" ||
              record.body === null ||
              typeof record.body === "number" ||
              typeof record.body === "boolean")
          ) {
            // LIVE-VERIFIED: a string body under the json (default)
            // content type → 400 provider code 10207.
            fail(400, 10207, 'Validation error: Expected object, received string at "body"');
            return;
          }
          if (contentType === "text" && typeof record.body !== "string") {
            fail(400, 10207, 'Validation error: Expected string, received object at "body"');
            return;
          }
          store.messages.push({
            id: nextId(),
            body: record.body,
            contentType,
            timestampMs: 1_689_615_013_000 + counter,
            lease: null,
            attempts: 0,
            settled: false,
          });
          // The live-verified 200 envelope: result.metadata.metrics.
          const pending = store.messages.filter((m) => !m.settled);
          const oldest = pending.reduce(
            (min, m) => Math.min(min, m.timestampMs),
            Number.POSITIVE_INFINITY,
          );
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              success: true,
              errors: [],
              messages: [],
              result: {
                metadata: {
                  metrics: {
                    backlog_bytes: pending.reduce(
                      (sum, m) => sum + JSON.stringify(m.body).length,
                      0,
                    ),
                    backlog_count: pending.length,
                    oldest_message_timestamp_ms: Number.isFinite(oldest) ? oldest : 0,
                  },
                },
              },
            }),
          );
          return;
        }

        if (suffix === "/pull") {
          if (!store.httpPull) {
            // LIVE-VERIFIED: pull without an http_pull consumer → 405.
            fail(405, 10001, "messages cannot be pulled unless http_pull mode is enabled");
            return;
          }
          const record = (body ?? {}) as Record<string, unknown>;
          const batchSize =
            typeof record.batch_size === "number" && Number.isFinite(record.batch_size)
              ? Math.max(1, Math.min(100, Math.floor(record.batch_size)))
              : 5;
          const visibilityTimeoutMs =
            typeof record.visibility_timeout_ms === "number" &&
            Number.isFinite(record.visibility_timeout_ms)
              ? Math.max(1, record.visibility_timeout_ms)
              : 30_000;
          const now = Date.now();
          const leased: StoredMessage[] = [];
          for (const message of store.messages) {
            if (leased.length >= batchSize) {
              break;
            }
            if (message.settled) {
              continue;
            }
            const leaseAlive = message.lease !== null && message.lease.expiresAtMs > now;
            if (message.lease !== null && leaseAlive) {
              continue;
            }
            message.attempts += 1;
            message.lease = {
              leaseId: `lease-${++counter}`,
              expiresAtMs: now + visibilityTimeoutMs,
            };
            leased.push(message);
          }
          const backlog = store.messages.filter((m) => !m.settled).length;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              success: true,
              errors: [],
              messages: [],
              result: {
                message_backlog_count: backlog,
                messages: leased.map((message) => ({
                  id: message.id,
                  lease_id: message.lease?.leaseId,
                  // The documented pull-body encoding: json/bytes
                  // content types arrive base64-encoded (RFC 4648);
                  // text arrives as a plain UTF-8 string.
                  body:
                    message.contentType === "text"
                      ? message.body
                      : Buffer.from(JSON.stringify(message.body), "utf8").toString("base64"),
                  timestamp_ms: message.timestampMs,
                  attempts: message.attempts,
                  metadata: { "CF-Content-Type": message.contentType },
                })),
              },
            }),
          );
          return;
        }

        // suffix === "/ack" (verified against the current public API
        // reference — acks/retries arrays of {lease_id}).
        const record = (body ?? {}) as Record<string, unknown>;
        const acks = Array.isArray(record.acks) ? record.acks : [];
        const retries = Array.isArray(record.retries) ? record.retries : [];
        for (const message of store.messages) {
          const leaseId = message.lease?.leaseId;
          if (leaseId === undefined) {
            continue;
          }
          if (acks.some((entry) => (entry as Record<string, unknown>)?.lease_id === leaseId)) {
            message.settled = true;
            message.lease = null;
          } else if (
            retries.some((entry) => (entry as Record<string, unknown>)?.lease_id === leaseId)
          ) {
            message.lease = null; // immediately revisible
          }
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ success: true }));
        return;
      }

      if (
        request.method === "POST" &&
        consumerRoute !== null &&
        consumerRoute[1] === options.accountId
      ) {
        // LIVE-VERIFIED http_pull consumer creation (the probe
        // matrix's provisioning call, or `wrangler queues consumer
        // http add`): POST .../queues/{queue_id}/consumers
        // {"type": "http_pull"} → 200.
        const store = storeFor(consumerRoute[2] ?? "");
        if (store === null) {
          fail(404, 7000, "no such queue");
          return;
        }
        const record = (body ?? {}) as Record<string, unknown>;
        if (record.type !== "http_pull") {
          fail(400, 10001, 'unsupported consumer type (expected "http_pull")');
          return;
        }
        store.httpPull = true;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ success: true, errors: [], messages: [] }));
        return;
      }

      fail(404, 7000, "no such queue endpoint");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  const roleStore = (role: FakeQueueRole): QueueStore =>
    role === "execution" ? executionStore : probeStore;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
    get requests() {
      return requests;
    },
    get pendingCount() {
      return executionStore.messages.filter((m) => !m.settled).length;
    },
    httpPullEnabled(role: FakeQueueRole): boolean {
      return roleStore(role).httpPull;
    },
    pendingBodies(role: FakeQueueRole): readonly unknown[] {
      return roleStore(role)
        .messages.filter((m) => !m.settled)
        .map((m) => m.body);
    },
    settledBodies(role: FakeQueueRole): readonly unknown[] {
      return roleStore(role)
        .messages.filter((m) => m.settled)
        .map((m) => m.body);
    },
  };
}
