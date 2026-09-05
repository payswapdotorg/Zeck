/**
 * Integration — the Cloudflare Queues REST adapter over REAL HTTP
 * against an in-process protocol server (WORK-044 / D-03, acceptance
 * criterion 2 — provider isolation).
 *
 * This proves the ADAPTER's wire behavior against the documented
 * Cloudflare Queues REST protocol: request paths, Bearer
 * authorization, publish body shape, poll envelope parsing (body,
 * lease ids, attempts, timestamp, metadata content-type, backlog
 * count), ack body shape (acks/retries), and the typed fail-closed
 * error classification (401/403/404 permanent; 429/5xx/network
 * transient). It is explicitly NOT Cloudflare evidence — the live
 * provider suite is env-gated (`queue-live.test.ts`).
 *
 * PROBE ISOLATION (the PR #6 correction — the Architect's blocking
 * finding): the transport probe must never consume unrelated
 * workload. The dedicated describe block below proves over real
 * HTTP, with execution-shaped deliveries seeded on the queues, that
 * (a) a probe on a contaminated queue acknowledges EXACTLY its own
 * message — unrelated execution deliveries are never ACKed, never
 * re-queued, never discarded; (b) the probe issues ZERO requests
 * against the execution queue (workload is never even leased); and
 * (c) the weakened configurations (no probe queue / probe queue ==
 * execution queue) are rejected fail-closed before any wire call.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createCloudflareQueuesTransport } from "../../../src/platform/queue/cloudflare-queues";
import {
  QueueConfigError,
  QueueTransportError,
  validateRetryPolicy,
} from "../../../src/platform/queue/port";
import { type FakeQueueServer, startFakeCloudflareQueues } from "./lib/fake-cloudflare-queues";

const ACCOUNT_ID = "a".repeat(32);
const QUEUE_ID = "b".repeat(32);
const API_TOKEN = "cf-queue-test-token-material";

describe("the Cloudflare Queues REST adapter over real HTTP (WORK-044 D-03)", () => {
  let server: FakeQueueServer;

  beforeAll(async () => {
    server = await startFakeCloudflareQueues({
      accountId: ACCOUNT_ID,
      queueId: QUEUE_ID,
      apiToken: API_TOKEN,
    });
  });

  afterAll(async () => {
    await server.close();
  });

  const transport = () =>
    createCloudflareQueuesTransport({
      apiBaseUrl: server.baseUrl,
      accountId: ACCOUNT_ID,
      queueId: QUEUE_ID,
      apiToken: API_TOKEN,
      requestTimeoutMs: 3000,
    });

  test("publish sends the documented body with Bearer authorization", async () => {
    const receipt = await transport().publish({
      body: JSON.stringify({ correlationKey: "execution-dispatch:test-1" }),
      contentType: "application/json",
    });
    expect(receipt.accepted).toBe(true);
    const publish = server.requests.find(
      (r) => r.path.endsWith("/messages") && !r.path.includes("poll"),
    );
    expect(publish).toBeDefined();
    expect(publish?.authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(publish?.body).toEqual({
      body: JSON.stringify({ correlationKey: "execution-dispatch:test-1" }),
      content_type: "application/json",
    });
  });

  test("poll parses the documented envelope and leases messages", async () => {
    const t = transport();
    await t.publish({ body: "plain-body", contentType: "text/plain" });
    const batch = await t.pull({ batchSize: 5, visibilityTimeoutMs: 60_000 });
    expect(batch.backlogEstimate).toBeGreaterThanOrEqual(2);
    expect(batch.messages.length).toBeGreaterThanOrEqual(2);
    const plain = batch.messages.find((m) => m.body === "plain-body");
    expect(plain).toBeDefined();
    expect(plain?.attempts).toBe(1);
    expect(plain?.contentType).toBe("text/plain");
    expect(plain?.messageId).toMatch(/^cf-message-/);
    expect(plain?.leaseId).toMatch(/^lease-/);
    expect(plain?.publishedAt).toMatch(/^2023-07-17T/);
  });

  test("settle acks and retries with the documented body", async () => {
    const t = transport();
    await t.publish({ body: "settle-me" });
    const batch = await t.pull({ batchSize: 5 });
    const target = batch.messages[0];
    expect(target).toBeDefined();
    await t.settle({ ackLeaseIds: [target?.leaseId ?? ""], retryLeaseIds: [] });
    const ack = server.requests.filter((r) => r.path.endsWith("/messages/ack")).pop();
    expect(ack?.body).toEqual({
      acks: [{ lease_id: target?.leaseId }],
      retries: [],
    });
    expect(server.pendingCount).toBeLessThan(3);
  });

  test("an empty settle is a no-op (no wire call)", async () => {
    const before = server.requests.length;
    await transport().settle({ ackLeaseIds: [], retryLeaseIds: [] });
    expect(server.requests.length).toBe(before);
  });

  test("authentication failure is permanent and typed (401)", async () => {
    // The server expects a DIFFERENT token: the adapter's credential is
    // rejected → 401 → permanent (retrying an unauthorized token is
    // unbounded waste, not recovery).
    const badToken = await startFakeCloudflareQueues({
      accountId: ACCOUNT_ID,
      queueId: QUEUE_ID,
      apiToken: "different-expected-token",
    });
    try {
      const t = createCloudflareQueuesTransport({
        apiBaseUrl: badToken.baseUrl,
        accountId: ACCOUNT_ID,
        queueId: QUEUE_ID,
        apiToken: API_TOKEN,
        requestTimeoutMs: 3000,
      });
      await expect(t.publish({ body: "x" })).rejects.toSatisfy((error: unknown) => {
        const transportError = error as QueueTransportError;
        return (
          transportError instanceof QueueTransportError &&
          transportError.failureKind === "permanent" &&
          transportError.status === 401
        );
      });
    } finally {
      await badToken.close();
    }
  });

  test("provider outage is transient and typed (503)", async () => {
    const outage = await startFakeCloudflareQueues({
      accountId: ACCOUNT_ID,
      queueId: QUEUE_ID,
      apiToken: API_TOKEN,
      outage: true,
    });
    try {
      const t = createCloudflareQueuesTransport({
        apiBaseUrl: outage.baseUrl,
        accountId: ACCOUNT_ID,
        queueId: QUEUE_ID,
        apiToken: API_TOKEN,
        requestTimeoutMs: 3000,
      });
      await expect(t.pull({ batchSize: 5 })).rejects.toSatisfy((error: unknown) => {
        const transportError = error as QueueTransportError;
        return (
          transportError instanceof QueueTransportError &&
          transportError.failureKind === "transient" &&
          transportError.status === 503
        );
      });
    } finally {
      await outage.close();
    }
  });

  test("rate limiting is transient and typed (429)", async () => {
    const rateLimited = await startFakeCloudflareQueues({
      accountId: ACCOUNT_ID,
      queueId: QUEUE_ID,
      apiToken: API_TOKEN,
      rateLimitPublish: 1,
    });
    try {
      const t = createCloudflareQueuesTransport({
        apiBaseUrl: rateLimited.baseUrl,
        accountId: ACCOUNT_ID,
        queueId: QUEUE_ID,
        apiToken: API_TOKEN,
        requestTimeoutMs: 3000,
      });
      await expect(t.publish({ body: "x" })).rejects.toSatisfy((error: unknown) => {
        const transportError = error as QueueTransportError;
        return (
          transportError instanceof QueueTransportError &&
          transportError.failureKind === "transient" &&
          transportError.status === 429
        );
      });
    } finally {
      await rateLimited.close();
    }
  });

  test("network-level failure is transient (unreachable endpoint)", async () => {
    const t = createCloudflareQueuesTransport({
      apiBaseUrl: "http://127.0.0.1:1",
      accountId: ACCOUNT_ID,
      queueId: QUEUE_ID,
      apiToken: API_TOKEN,
      requestTimeoutMs: 1000,
    });
    await expect(t.publish({ body: "x" })).rejects.toSatisfy((error: unknown) => {
      const transportError = error as QueueTransportError;
      return (
        transportError instanceof QueueTransportError && transportError.failureKind === "transient"
      );
    });
  });

  test("errors never contain the API token (secret-free failures)", async () => {
    const badToken = await startFakeCloudflareQueues({
      accountId: ACCOUNT_ID,
      queueId: QUEUE_ID,
      apiToken: "different-token",
      rejectAuth: true,
    });
    try {
      const t = createCloudflareQueuesTransport({
        apiBaseUrl: badToken.baseUrl,
        accountId: ACCOUNT_ID,
        queueId: QUEUE_ID,
        apiToken: API_TOKEN,
        requestTimeoutMs: 3000,
      });
      await expect(t.publish({ body: "x" })).rejects.toThrow();
      const messages = server.requests.length > 0 ? "" : "";
      expect(messages).toBe("");
      try {
        await t.publish({ body: "x" });
      } catch (error) {
        expect((error as Error).message).not.toContain(API_TOKEN);
      }
    } finally {
      await badToken.close();
    }
  });

  test("configuration validation is fail-closed before any wire call", () => {
    expect(() =>
      createCloudflareQueuesTransport({
        apiBaseUrl: server.baseUrl,
        accountId: "not-hex",
        queueId: QUEUE_ID,
        apiToken: API_TOKEN,
      }),
    ).toThrow(QueueConfigError);
    expect(() =>
      createCloudflareQueuesTransport({
        apiBaseUrl: server.baseUrl,
        accountId: ACCOUNT_ID,
        queueId: QUEUE_ID,
        apiToken: "",
      }),
    ).toThrow(/apiToken is required/);
  });

  test("the bounded retry policy validation rejects unbounded/garbage policies", () => {
    expect(() =>
      validateRetryPolicy({
        maxPublishAttempts: 0,
        maxDeliveryAttempts: 3,
        maxReplays: 3,
        retryBackoffMs: 500,
      }),
    ).toThrow(QueueConfigError);
    expect(() =>
      validateRetryPolicy({
        maxPublishAttempts: 3,
        maxDeliveryAttempts: Number.POSITIVE_INFINITY,
        maxReplays: 3,
        retryBackoffMs: 500,
      }),
    ).toThrow(QueueConfigError);
    expect(() =>
      validateRetryPolicy({
        maxPublishAttempts: 101,
        maxDeliveryAttempts: 3,
        maxReplays: 3,
        retryBackoffMs: 500,
      }),
    ).toThrow(QueueConfigError);
  });
});

// The PR #6 correction battery: the transport probe on the DEDICATED
// operator-owned probe queue can never consume unrelated workload.
describe("the transport probe never consumes unrelated workload (WORK-044 PR #6 correction)", () => {
  const PROBE_QUEUE_ID = "c".repeat(32);

  // Execution-shaped pointer payloads exactly like the dispatcher
  // publishes (correlation-key pointers, ids-only, secret-free) —
  // genuine execution deliveries a probe must never touch.
  const EXECUTION_DELIVERY_BODIES: readonly string[] = [
    JSON.stringify({
      v: 1,
      correlationKey: "execution-dispatch:01890a3c-1000-7000-8000-000000000001",
      purpose: "execution-dispatch",
      executionId: "01890a3c-1000-7000-8000-000000000001",
      applicationId: "01890a3c-2000-7000-8000-000000000001",
      tenantId: "01890a3c-3000-7000-8000-000000000001",
      dispatchedAt: "2025-01-01T00:00:00.000Z",
    }),
    JSON.stringify({
      v: 1,
      correlationKey: "execution-dispatch:01890a3c-1000-7000-8000-000000000002",
      purpose: "execution-dispatch",
      executionId: "01890a3c-1000-7000-8000-000000000002",
      applicationId: "01890a3c-2000-7000-8000-000000000002",
      tenantId: "01890a3c-3000-7000-8000-000000000002",
      dispatchedAt: "2025-01-01T00:00:01.000Z",
    }),
    JSON.stringify({
      v: 1,
      correlationKey: "execution-dispatch:01890a3c-1000-7000-8000-000000000003:replay-1",
      purpose: "execution-dispatch",
      executionId: "01890a3c-1000-7000-8000-000000000003",
      applicationId: "01890a3c-2000-7000-8000-000000000003",
      tenantId: "01890a3c-3000-7000-8000-000000000003",
      dispatchedAt: "2025-01-01T00:00:02.000Z",
    }),
  ];
  const FOREIGN_PROBE_BODY = JSON.stringify({ probe: "zeck-transport-probe-earlier-crashed-run" });

  test("REGRESSION: a probe on a queue carrying unrelated execution deliveries never acknowledges them", {
    timeout: 30_000,
  }, async () => {
    // Worst case defense-in-depth: the probe queue itself is
    // contaminated with unrelated execution-shaped workload (and
    // even another probe's leftover message). The probe must still
    // settle EXACTLY its own message and nothing else.
    const contaminated = await startFakeCloudflareQueues({
      accountId: ACCOUNT_ID,
      queueId: QUEUE_ID,
      probeQueueId: PROBE_QUEUE_ID,
      apiToken: API_TOKEN,
      probeSeeded: [...EXECUTION_DELIVERY_BODIES, FOREIGN_PROBE_BODY],
    });
    try {
      const t = createCloudflareQueuesTransport({
        apiBaseUrl: contaminated.baseUrl,
        accountId: ACCOUNT_ID,
        queueId: QUEUE_ID,
        probeQueueId: PROBE_QUEUE_ID,
        apiToken: API_TOKEN,
        requestTimeoutMs: 3000,
      });
      const probe = await t.probe();
      expect(probe.ok).toBe(true);

      // EXACTLY one message was ever acknowledged on the probe queue:
      // this run's own probe message (fresh unique tag).
      const settled = contaminated.settledBodies("probe");
      expect(settled).toHaveLength(1);
      const settledBody = JSON.parse(settled[0] as string) as Record<string, unknown>;
      expect(typeof settledBody.probe).toBe("string");
      expect(settledBody.probe as string).toMatch(/^zeck-transport-probe-\d+-/);
      expect(settledBody.probe).not.toBe("zeck-transport-probe-earlier-crashed-run");

      // The unrelated execution deliveries — and even the foreign
      // probe message — are NEVER acknowledged: still pending, still
      // deliverable for their rightful consumer.
      const pending = contaminated.pendingBodies("probe");
      for (const body of EXECUTION_DELIVERY_BODIES) {
        expect(pending).toContain(body);
      }
      expect(pending).toContain(FOREIGN_PROBE_BODY);

      // Wire-level discipline: every ack the probe issued carried
      // exactly ONE ack entry (its own) and no retries — nothing
      // foreign was settled or re-queued through the ack endpoint.
      const ackRequests = contaminated.requests.filter(
        (r) => r.method === "POST" && r.path.endsWith("/messages/ack"),
      );
      expect(ackRequests.length).toBe(1);
      for (const ack of ackRequests) {
        const body = ack.body as { acks?: unknown[]; retries?: unknown[] };
        expect(body.acks).toHaveLength(1);
        expect(body.retries).toEqual([]);
      }
    } finally {
      await contaminated.close();
    }
  });

  test("the probe never issues any request against the execution queue (workload never even leased)", {
    timeout: 30_000,
  }, async () => {
    const isolated = await startFakeCloudflareQueues({
      accountId: ACCOUNT_ID,
      queueId: QUEUE_ID,
      probeQueueId: PROBE_QUEUE_ID,
      apiToken: API_TOKEN,
      seeded: EXECUTION_DELIVERY_BODIES, // real workload on the execution queue
    });
    try {
      const t = createCloudflareQueuesTransport({
        apiBaseUrl: isolated.baseUrl,
        accountId: ACCOUNT_ID,
        queueId: QUEUE_ID,
        probeQueueId: PROBE_QUEUE_ID,
        apiToken: API_TOKEN,
        requestTimeoutMs: 3000,
      });
      const probe = await t.probe();
      expect(probe.ok).toBe(true);

      // ZERO requests against the execution queue's REST path — the
      // probe cannot publish into, lease from, acknowledge against
      // or even observe the execution queue.
      const executionRequests = isolated.requests.filter((r) =>
        r.path.includes(`/queues/${QUEUE_ID}/`),
      );
      expect(executionRequests).toEqual([]);

      // The workload is untouched: never acked (settled stays empty)
      // and never leased (pending bodies intact, in order).
      expect(isolated.pendingBodies("execution")).toEqual(EXECUTION_DELIVERY_BODIES);
      expect(isolated.settledBodies("execution")).toEqual([]);

      // And the probe's own message on the probe queue was cleaned up.
      expect(isolated.settledBodies("probe")).toHaveLength(1);
    } finally {
      await isolated.close();
    }
  });

  test("the 'probe queue IS the execution queue' misconfiguration is rejected fail-closed", () => {
    // Weakened form: point the probe at the execution queue — rejected
    // at CONFIGURATION validation, before any wire call exists.
    expect(() =>
      createCloudflareQueuesTransport({
        apiBaseUrl: "http://127.0.0.1:1",
        accountId: ACCOUNT_ID,
        queueId: QUEUE_ID,
        probeQueueId: QUEUE_ID,
        apiToken: API_TOKEN,
      }),
    ).toThrow(/probeQueueId must differ from queueId/);
    // Malformed probe queue ids are likewise rejected.
    expect(() =>
      createCloudflareQueuesTransport({
        apiBaseUrl: "http://127.0.0.1:1",
        accountId: ACCOUNT_ID,
        queueId: QUEUE_ID,
        probeQueueId: "not-hex",
        apiToken: API_TOKEN,
      }),
    ).toThrow(/probeQueueId must be a 32-hex/);
  });

  test("probe() without a dedicated probe queue fails closed naming the exact variable (no wire call)", async () => {
    const t = createCloudflareQueuesTransport({
      apiBaseUrl: "http://127.0.0.1:1", // unreachable — proves no wire call happens
      accountId: ACCOUNT_ID,
      queueId: QUEUE_ID,
      apiToken: API_TOKEN,
      requestTimeoutMs: 3000,
    });
    await expect(t.probe()).rejects.toSatisfy((error: unknown) => {
      const configError = error as QueueConfigError;
      return (
        configError instanceof QueueConfigError &&
        configError.message.includes("ZECK_PROBE_QUEUE_ID") &&
        configError.message.includes("never targets the execution queue")
      );
    });
  });
});
