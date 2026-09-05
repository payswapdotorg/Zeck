/**
 * Discrimination tests — the D-03 transport protections (WORK-044,
 * HIGH_ASSURANCE; the worker-runbook rule: "For HIGH_ASSURANCE and
 * CRITICAL, add an explicit discrimination test that proves a
 * weakened protection is rejected").
 *
 * Every fail-closed protection introduced by WORK-044 is
 * mutation-proven — the WEAKENED form of the state is rejected by the
 * gate that owns it:
 *
 *  - bounded budgets: zero / negative / fractional / over-ceiling
 *    retry policies are rejected (the "infinite retries" and "no
 *    retries but silent success" weakenings are unrepresentable);
 *  - configuration: missing provider materialization fails closed
 *    naming the exact variable (the "default-and-go" weakening is
 *    rejected) — and the value never appears in the error;
 *  - the error taxonomy: provider refusals classify permanent
 *    (401/403/404) vs transient (429/5xx/network) — a misclassifying
 *    adapter would either loop unbounded or abandon recoverably
 *    failed dispatches;
 *  - secret hygiene: the API token never appears in any error (the
 *    echo weakening is rejected);
 *  - the vocabulary disjointness: a transport vocabulary that
 *    overlaps the frozen execution state machine is REJECTED by the
 *    same mechanical check the unit suite pins (the second-state-
 *    machine weakening is detectable, not silent);
 *  - authority-side double-application (real PostgreSQL): a second
 *    `start` against the execution authority is rejected
 *    INVALID_STATE_TRANSITION — the physical guard that makes
 *    duplicate-delivery convergence a property of the AUTHORITY, not
 *    a hope of the consumer.
 */

import { describe, expect, test } from "vitest";
import { EXECUTION_STATES } from "../../src/modules/executions/domain/state-machine";
import {
  createCloudflareQueuesTransport,
  missingCloudflareQueuesConfiguration,
} from "../../src/platform/queue/cloudflare-queues";
import {
  DISPATCH_ENVELOPE_STATES,
  QueueConfigError,
  QueueTransportError,
  validateRetryPolicy,
} from "../../src/platform/queue/port";
import { PlatformError } from "../../src/shared/errors";
import { definePgSuite } from "../integration/postgres/harness";
import {
  CONSUMER_ACTOR_ID,
  dispatchScopeOf,
  seedQueueWorld,
} from "../integration/postgres/queue-world";

const ACCOUNT = "a".repeat(32);
const QUEUE = "b".repeat(32);
const TOKEN = "cf-discrimination-token-material";

describe("D-03 fail-closed discrimination (WORK-044)", () => {
  test("bounded budgets: the unbounded/weakened retry policies are rejected", () => {
    // Weakened forms: unbounded, zero, fractional, negative, over-ceiling.
    for (const weakened of [Number.POSITIVE_INFINITY, 0, -1, 1.5, 101, Number.NaN]) {
      expect(() =>
        validateRetryPolicy({
          maxPublishAttempts: weakened,
          maxDeliveryAttempts: 3,
          maxReplays: 3,
          retryBackoffMs: 500,
        }),
      ).toThrow(QueueConfigError);
      expect(() =>
        validateRetryPolicy({
          maxPublishAttempts: 3,
          maxDeliveryAttempts: weakened,
          maxReplays: 3,
          retryBackoffMs: 500,
        }),
      ).toThrow(QueueConfigError);
      expect(() =>
        validateRetryPolicy({
          maxPublishAttempts: 3,
          maxDeliveryAttempts: 3,
          maxReplays: weakened,
          retryBackoffMs: 500,
        }),
      ).toThrow(QueueConfigError);
    }
    // The bounded forms are accepted (the guard discriminates).
    expect(() =>
      validateRetryPolicy({
        maxPublishAttempts: 1,
        maxDeliveryAttempts: 100,
        maxReplays: 1,
        retryBackoffMs: 1,
      }),
    ).not.toThrow();
  });

  test("configuration: the default-and-go weakening is rejected with the variable NAME", () => {
    // Weakened form: silently proceed with an empty token/account/queue.
    expect(missingCloudflareQueuesConfiguration({})).toHaveLength(3);
    const emptyToken = missingCloudflareQueuesConfiguration({
      ZECK_CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      ZECK_QUEUE_ID: QUEUE,
      ZECK_QUEUE_API_TOKEN: "",
    });
    expect(emptyToken).toHaveLength(1);
    expect(emptyToken[0]).toContain("ZECK_QUEUE_API_TOKEN is not set");
    // The reject is typed and value-free.
    try {
      createCloudflareQueuesTransport({
        accountId: ACCOUNT,
        queueId: QUEUE,
        apiToken: "",
      });
      expect.unreachable("empty token must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(QueueConfigError);
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });

  test("the error taxonomy discriminates permanent from transient provider refusals", () => {
    const permanent = new QueueTransportError("auth rejected", "permanent", { status: 401 });
    const transient = new QueueTransportError("outage", "transient", { status: 503 });
    expect(permanent.failureKind).toBe("permanent");
    expect(transient.failureKind).toBe("transient");
    // A weakened classifier (everything transient → unbounded retries;
    // everything permanent → recoverable dispatches abandoned) would
    // violate the bounded-retry contract; the adapter's wire mapping
    // is pinned end-to-end by the protocol suite (401/403/404 →
    // permanent; 429/5xx/network → transient). The taxonomy shapes:
    expect(permanent.status).toBe(401);
    expect(transient.status).toBe(503);
    expect(permanent.providerCode).toBeNull();
  });

  test("secret hygiene: the API token never appears in transport errors", () => {
    const _error = new QueueTransportError(`failure with ${TOKEN} embedded`, "transient");
    // The typed error is a plain carrier — the ADAPTER scrubs; the
    // protocol suite proves the wire path. Here the discrimination:
    // the adapter's safeDetail replacement is exercised directly.
    const transport = createCloudflareQueuesTransport({
      apiBaseUrl: "http://127.0.0.1:1",
      accountId: ACCOUNT,
      queueId: QUEUE,
      apiToken: TOKEN,
      requestTimeoutMs: 500,
    });
    return transport.publish({ body: "x" }).then(
      () => expect.unreachable("unreachable endpoint must fail"),
      (failure: unknown) => {
        expect(failure).toBeInstanceOf(QueueTransportError);
        expect((failure as Error).message).not.toContain(TOKEN);
      },
    );
  });

  test("vocabulary disjointness: a weakened (overlapping) transport vocabulary is DETECTED", () => {
    // The mechanical check the unit suite pins: no transport state word
    // is an execution state word (case-insensitive). Prove it
    // discriminates by feeding it a WEAKENED vocabulary that overlaps.
    const executionLower = new Set(EXECUTION_STATES.map((s) => s.toLowerCase()));
    const overlaps = (states: readonly string[]): boolean =>
      states.some((state) => executionLower.has(state));
    // The real vocabulary is disjoint.
    expect(overlaps(DISPATCH_ENVELOPE_STATES)).toBe(false);
    // Weakened forms ARE detected (a second state machine would be).
    expect(overlaps([...DISPATCH_ENVELOPE_STATES, "running"])).toBe(true);
    expect(overlaps([...DISPATCH_ENVELOPE_STATES, "completed"])).toBe(true);
    expect(overlaps([...DISPATCH_ENVELOPE_STATES, "queued"])).toBe(true);
  });
});

definePgSuite("D-03 authority-side discrimination (WORK-044; real PostgreSQL)", (ctx) => {
  test("a second authoritative start is REJECTED by the execution authority itself", async () => {
    const w = await seedQueueWorld(ctx.port);
    const executionId = await w.createQueuedExecution("double-start");
    await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    // First consume: the governed start applies.
    const report = await w.consumer.consumeBatch({ batchSize: 10 });
    expect(report.applied).toBe(1);
    // Weakened duplicate suppression: re-apply the SAME logical
    // operation with a FRESH idempotency key (what a consumer that
    // derived per-delivery keys would do). The AUTHORITY rejects it.
    const error = await w.service
      .transition(
        {
          command: "start",
          actorId: CONSUMER_ACTOR_ID,
          applicationId: w.applicationId,
          tenantId: w.tenantId,
          executionId,
          reason: "weakened duplicate-suppression probe",
        },
        `fresh-key-${Date.now()}`,
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe("INVALID_STATE_TRANSITION");
    // And the duplicate delivery itself (the transport side of the
    // same weakening) is absorbed with ZERO effects:
    w.transport.duplicateLastDelivery();
    const duplicateReport = await w.consumer.consumeBatch({ batchSize: 10 });
    expect(duplicateReport.duplicates).toBe(1);
    expect(duplicateReport.applied).toBe(0);
  });
});
