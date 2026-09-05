/**
 * Unit — queue transport configuration loading (WORK-044 / D-03).
 *
 * Pins the repository-defined configuration contract:
 *
 *  - missing provider configuration fails closed with the exact
 *    variable NAMES (never values) in the reason (the provider
 *    endpoint loader lives in the owning adapter module);
 *  - the DEDICATED probe queue variable is optional for the transport
 *    and validated fail-closed when present (the PR #6 correction:
 *    probe() refuses without it — it never targets the execution
 *    queue);
 *  - the bounded retry/replay budgets default to the
 *    repository-declared defaults and reject garbage fail-closed;
 *  - the materialized secret is never echoed in configuration errors.
 */

import { describe, expect, test } from "vitest";
import {
  loadCloudflareQueuesRuntimeConfig,
  missingCloudflareQueuesConfiguration,
} from "../../../src/platform/queue/cloudflare-queues";
import {
  DEFAULT_QUEUE_RETRY_POLICY,
  loadQueueRetryPolicy,
} from "../../../src/platform/queue/config";
import { QueueConfigError } from "../../../src/platform/queue/port";

const ACCOUNT = "a".repeat(32);
const QUEUE = "b".repeat(32);

const COMPLETE_ENV: Readonly<Record<string, string>> = {
  ZECK_CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  ZECK_QUEUE_ID: QUEUE,
  ZECK_QUEUE_API_TOKEN: "materialized-token-value",
};

describe("queue adapter runtime configuration (WORK-044 D-03)", () => {
  test("complete configuration loads", () => {
    const config = loadCloudflareQueuesRuntimeConfig(COMPLETE_ENV);
    expect(config.accountId).toBe(ACCOUNT);
    expect(config.queueId).toBe(QUEUE);
    expect(config.apiBaseUrl).toBeUndefined();
    // The dedicated probe queue is optional for the TRANSPORT (only
    // probe() requires it — and refuses fail-closed without it).
    expect(config.probeQueueId).toBeUndefined();
  });

  test("each missing variable is named exactly (fail closed, value-free)", () => {
    for (const missing of ["ZECK_CLOUDFLARE_ACCOUNT_ID", "ZECK_QUEUE_ID", "ZECK_QUEUE_API_TOKEN"]) {
      const env: Record<string, string> = { ...COMPLETE_ENV };
      delete env[missing];
      const problems = missingCloudflareQueuesConfiguration(env);
      expect(problems.some((line) => line.includes(missing))).toBe(true);
      try {
        loadCloudflareQueuesRuntimeConfig(env);
        expect.unreachable("configuration must fail closed");
      } catch (error) {
        const message = (error as Error).message;
        expect(error).toBeInstanceOf(QueueConfigError);
        expect(message).toContain(missing);
        // Values never appear — the token is not echoed.
        expect(message).not.toContain("materialized-token-value");
      }
    }
  });

  test("an empty environment reports every missing variable", () => {
    const missing = missingCloudflareQueuesConfiguration({});
    expect(missing).toHaveLength(3);
  });

  test("the dedicated probe queue variable loads when present and fails closed when malformed", () => {
    const PROBE_QUEUE = "c".repeat(32);
    expect(
      loadCloudflareQueuesRuntimeConfig({ ...COMPLETE_ENV, ZECK_PROBE_QUEUE_ID: PROBE_QUEUE })
        .probeQueueId,
    ).toBe(PROBE_QUEUE);
    // Whitespace-only is absent (the transport needs no probe queue).
    expect(
      loadCloudflareQueuesRuntimeConfig({ ...COMPLETE_ENV, ZECK_PROBE_QUEUE_ID: "   " })
        .probeQueueId,
    ).toBeUndefined();
    // Malformed: fail closed with the exact variable NAME, value-free.
    try {
      loadCloudflareQueuesRuntimeConfig({ ...COMPLETE_ENV, ZECK_PROBE_QUEUE_ID: "not-hex" });
      expect.unreachable("a malformed probe queue id must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(QueueConfigError);
      expect((error as Error).message).toContain("ZECK_PROBE_QUEUE_ID");
    }
  });

  test("the timeout override is validated (positive integer only)", () => {
    expect(() =>
      loadCloudflareQueuesRuntimeConfig({
        ...COMPLETE_ENV,
        ZECK_QUEUE_REQUEST_TIMEOUT_MS: "abc",
      }),
    ).toThrow(QueueConfigError);
    expect(
      loadCloudflareQueuesRuntimeConfig({
        ...COMPLETE_ENV,
        ZECK_QUEUE_REQUEST_TIMEOUT_MS: "5000",
      }).requestTimeoutMs,
    ).toBe(5000);
  });
});

describe("bounded retry policy configuration (WORK-044 D-03)", () => {
  test("the repository defaults are the documented bounded values", () => {
    expect(DEFAULT_QUEUE_RETRY_POLICY).toEqual({
      maxPublishAttempts: 3,
      maxDeliveryAttempts: 3,
      maxReplays: 3,
      retryBackoffMs: 500,
    });
  });

  test("absent variables keep the defaults; overrides apply", () => {
    expect(loadQueueRetryPolicy({})).toEqual(DEFAULT_QUEUE_RETRY_POLICY);
    const policy = loadQueueRetryPolicy({
      ZECK_QUEUE_MAX_PUBLISH_ATTEMPTS: "5",
      ZECK_QUEUE_MAX_DELIVERY_ATTEMPTS: "7",
      ZECK_QUEUE_MAX_REPLAYS: "2",
      ZECK_QUEUE_RETRY_BACKOFF_MS: "250",
    });
    expect(policy).toEqual({
      maxPublishAttempts: 5,
      maxDeliveryAttempts: 7,
      maxReplays: 2,
      retryBackoffMs: 250,
    });
  });

  test("garbage budgets fail closed (unbounded retries are unrepresentable)", () => {
    for (const [name, value] of [
      ["ZECK_QUEUE_MAX_PUBLISH_ATTEMPTS", "0"],
      ["ZECK_QUEUE_MAX_PUBLISH_ATTEMPTS", "-3"],
      ["ZECK_QUEUE_MAX_PUBLISH_ATTEMPTS", "abc"],
      ["ZECK_QUEUE_MAX_DELIVERY_ATTEMPTS", "1000"],
      ["ZECK_QUEUE_MAX_REPLAYS", "999999"],
    ] as const) {
      expect(() => loadQueueRetryPolicy({ [name]: value })).toThrow(QueueConfigError);
    }
  });
});
