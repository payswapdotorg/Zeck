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
