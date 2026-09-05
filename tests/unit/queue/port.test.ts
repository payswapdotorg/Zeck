/**
 * Unit — the provider-neutral queue port contracts (WORK-044 / D-03).
 *
 * Pins the port's invariants mechanically:
 *
 *  - the correlation identity is DETERMINISTIC (same execution → same
 *    key; the replay ordinal is part of the identity);
 *  - the consume idempotency key derives from the correlation key;
 *  - the canonical payload JSON is key-order-independent (digest
 *    stability);
 *  - the transport progress vocabulary is DISJOINT from the frozen
 *    execution state vocabulary (no second state machine — pinned at
 *    the type/constant level, mechanically);
 *  - the retry policy bounds and backoff schedule are deterministic.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { EXECUTION_STATES } from "../../../src/modules/executions/domain/state-machine";
import { payloadDigestOf } from "../../../src/platform/queue/correlation";
import {
  backoffDelayMs,
  canonicalPayloadJson,
  consumeIdempotencyKey,
  DISPATCH_ENVELOPE_STATES,
  executionDispatchCorrelationKey,
  QueueConfigError,
  validateRetryPolicy,
} from "../../../src/platform/queue/port";

const EXECUTION_ID = "01978d3e-5f2a-7000-8000-00000000c0de";

describe("queue port correlation identities (WORK-044 D-03)", () => {
  test("the execution dispatch correlation key is deterministic", () => {
    expect(executionDispatchCorrelationKey(EXECUTION_ID)).toBe(
      `execution-dispatch:${EXECUTION_ID}`,
    );
    expect(executionDispatchCorrelationKey(EXECUTION_ID)).toBe(
      executionDispatchCorrelationKey(EXECUTION_ID),
    );
    expect(executionDispatchCorrelationKey(EXECUTION_ID, { replayOrdinal: 2 })).toBe(
      `execution-dispatch:${EXECUTION_ID}:replay-2`,
    );
    expect(executionDispatchCorrelationKey(EXECUTION_ID)).not.toBe(
      executionDispatchCorrelationKey(EXECUTION_ID, { replayOrdinal: 1 }),
    );
  });

  test("the consume idempotency key derives from the correlation key", () => {
    const key = consumeIdempotencyKey(executionDispatchCorrelationKey(EXECUTION_ID));
    expect(key).toBe(`queue-consume:execution-dispatch:${EXECUTION_ID}`);
    expect(consumeIdempotencyKey("x")).toBe("queue-consume:x");
  });
});

describe("canonical payload stability (digest contract)", () => {
  test("canonical JSON is key-order independent", () => {
    const a = { v: 1, b: "two", a: { y: 2, x: 1 } };
    const b = { a: { x: 1, y: 2 }, b: "two", v: 1 };
    expect(canonicalPayloadJson(a)).toBe(canonicalPayloadJson(b));
  });

  test("the digest is the sha256 of the canonical form (stable, provenance-grade)", () => {
    const payload = { correlationKey: "k", executionId: EXECUTION_ID, v: 1 };
    const digest = payloadDigestOf(payload);
    expect(digest).toBe(
      createHash("sha256").update(canonicalPayloadJson(payload), "utf8").digest("hex"),
    );
    expect(digest).toHaveLength(64);
    // Key order does not change the digest.
    expect(payloadDigestOf({ v: 1, executionId: EXECUTION_ID, correlationKey: "k" })).toBe(digest);
  });
});

describe("the transport vocabulary is disjoint from the execution state machine", () => {
  test("no transport state word is an execution state word (no second state machine)", () => {
    const executionVocabulary = new Set<string>(EXECUTION_STATES);
    for (const state of DISPATCH_ENVELOPE_STATES) {
      expect(executionVocabulary.has(state)).toBe(false);
    }
    // And the casing discipline: execution states are uppercase words,
    // transport progress states are lowercase/kebab words — no shared
    // token even case-insensitively.
    const lower = new Set(EXECUTION_STATES.map((s) => s.toLowerCase()));
    for (const state of DISPATCH_ENVELOPE_STATES) {
      expect(lower.has(state)).toBe(false);
    }
  });

  test("the transport vocabulary is exactly the five documented states", () => {
    expect(DISPATCH_ENVELOPE_STATES).toEqual([
      "recorded",
      "published",
      "backlogged",
      "consumed",
      "dead-lettered",
    ]);
  });
});

describe("bounded retry policy math (deterministic, bounded)", () => {
  const policy = validateRetryPolicy({
    maxPublishAttempts: 3,
    maxDeliveryAttempts: 5,
    maxReplays: 2,
    retryBackoffMs: 100,
  });

  test("the backoff schedule is linear, deterministic and capped", () => {
    expect(backoffDelayMs(policy, 1)).toBe(100);
    expect(backoffDelayMs(policy, 2)).toBe(200);
    expect(backoffDelayMs(policy, 3)).toBe(300);
    expect(backoffDelayMs(policy, 0)).toBe(100); // clamped to attempt >= 1
    expect(backoffDelayMs(policy, 10_000)).toBe(60_000); // hard cap
  });

  test("non-integer, unbounded or negative budgets fail closed", () => {
    for (const bad of [
      { maxPublishAttempts: 0, maxDeliveryAttempts: 1, maxReplays: 1, retryBackoffMs: 1 },
      { maxPublishAttempts: 1, maxDeliveryAttempts: -1, maxReplays: 1, retryBackoffMs: 1 },
      { maxPublishAttempts: 1, maxDeliveryAttempts: 1, maxReplays: 1.5, retryBackoffMs: 1 },
      { maxPublishAttempts: 1, maxDeliveryAttempts: 1, maxReplays: 1, retryBackoffMs: 0 },
    ]) {
      expect(() => validateRetryPolicy(bad)).toThrow(QueueConfigError);
    }
  });
});
