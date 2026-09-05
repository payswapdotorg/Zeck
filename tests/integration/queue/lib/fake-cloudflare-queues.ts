/**
 * A minimal in-process Cloudflare-Queues-REST-compatible server for
 * the D-03 queue transport integration tests (WORK-044).
 *
 * This is NOT Cloudflare — it is a local, deterministic stand-in that
 * speaks the documented Queues REST surface the adapter uses
 * (publish / poll / ack) and VERIFIES the Bearer authorization, so the
 * adapter's wire behavior is proven end-to-end over real HTTP without
 * provider credentials. Real-Cloudflare evidence is separately gated
 * (queue-live.test.ts) and never claimed from this server.
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
 * Wire protocol (developers.cloudflare.com/queues):
 *  - POST /accounts/{account}/queues/{queue}/messages
 *    body {"body": <value>} → {"success": true}
 *  - POST .../messages/poll body {"visibility_timeout_ms","batch_size"}
 *    → {"success":true,"result":{"message_backlog_count":N,"messages":[...]}}
 *  - POST .../messages/ack body {"acks":[{"lease_id"}],"retries":[{"lease_id"}]}
 *    → {"success":true}
 * Errors answer the Cloudflare v4 envelope: {"success":false,"errors":[{"code","message"}]}.
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
  readonly contentType: string | undefined;
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
}

export async function startFakeCloudflareQueues(
  options: FakeQueueOptions,
): Promise<FakeQueueServer> {
  const executionStore: QueueStore = { messages: [] };
  const probeStore: QueueStore = { messages: [] };
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

  const seed = (store: QueueStore, bodies: readonly unknown[]): void => {
    for (const body of bodies) {
      store.messages.push({
        id: nextId(),
        body,
        contentType: undefined,
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
      const route = /^\/accounts\/([^/]+)\/queues\/([^/]+)\/messages(\/poll|\/ack)?$/.exec(path);

      if (request.method === "POST" && route !== null && route[1] === options.accountId) {
        const store = storeFor(route[2] ?? "");
        if (store === null) {
          fail(404, 7000, "no such queue");
          return;
        }
        const suffix = route[3] ?? "";

        if (suffix === "") {
          // publish
          if (rateLimitedLeft > 0) {
            rateLimitedLeft -= 1;
            fail(429, 13943, "ratelimited");
            return;
          }
          const record = (body ?? {}) as Record<string, unknown>;
          if (typeof record.body === "undefined") {
            fail(400, 7003, "body is required");
            return;
          }
          store.messages.push({
            id: nextId(),
            body: record.body,
            contentType: typeof record.content_type === "string" ? record.content_type : undefined,
            timestampMs: 1_689_615_013_000 + counter,
            lease: null,
            attempts: 0,
            settled: false,
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ success: true }));
          return;
        }

        if (suffix === "/poll") {
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
                  body: message.body,
                  timestamp_ms: message.timestampMs,
                  attempts: message.attempts,
                  metadata:
                    message.contentType === undefined
                      ? {}
                      : { "CF-Content-Type": message.contentType },
                })),
              },
            }),
          );
          return;
        }

        // suffix === "/ack"
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
