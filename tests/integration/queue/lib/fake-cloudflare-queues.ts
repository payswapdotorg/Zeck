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
  readonly queueId: string;
  readonly apiToken: string;
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
  readonly pendingCount: number;
}

export async function startFakeCloudflareQueues(
  options: FakeQueueOptions,
): Promise<FakeQueueServer> {
  const messages: StoredMessage[] = [];
  const requests: {
    method: string;
    path: string;
    authorization: string;
    body: unknown;
  }[] = [];
  let counter = 0;
  let rateLimitedLeft = options.rateLimitPublish ?? 0;

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
      const prefix = `/accounts/${options.accountId}/queues/${options.queueId}/messages`;

      if (request.method === "POST" && path === prefix) {
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
        counter += 1;
        messages.push({
          id: `cf-message-${counter.toString(16).padStart(32, "0")}`,
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

      if (request.method === "POST" && path === `${prefix}/poll`) {
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
        for (const message of messages) {
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
        const backlog = messages.filter((m) => !m.settled).length;
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

      if (request.method === "POST" && path === `${prefix}/ack`) {
        const record = (body ?? {}) as Record<string, unknown>;
        const acks = Array.isArray(record.acks) ? record.acks : [];
        const retries = Array.isArray(record.retries) ? record.retries : [];
        for (const message of messages) {
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
      return messages.filter((m) => !m.settled).length;
    },
  };
}
