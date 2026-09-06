/**
 * Unit — the provider-neutral workflow port contracts (WORK-045 /
 * D-04).
 *
 * Pins the port's invariants mechanically:
 *
 *  - the wait identity is DETERMINISTIC (same execution + kind +
 *    lineage ordinal → same wait key);
 *  - the governed-effect idempotency key derives from the wait key
 *    (exactly one authoritative effect per wait);
 *  - the canonical payload JSON is key-order-independent (digest
 *    stability);
 *  - the orchestration wait vocabulary is DISJOINT from the frozen
 *    execution state vocabulary — case-INSENSITIVELY (no second
 *    state machine, pinned at the constant level);
 *  - the wait progress transitions are exactly the legal table;
 *  - the retry policy and state bounds validate fail-closed (no
 *    unbounded orchestration, no large payloads);
 *  - the backoff schedule is deterministic and bounded.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { EXECUTION_STATES } from "../../../src/modules/executions/domain/state-machine";
import { payloadDigestOf } from "../../../src/platform/workflow/correlation";
import {
  backoffDelayMs,
  canonicalPayloadJson,
  canTransitionWait,
  OBSERVED_INSTANCE_STATUSES,
  ORCHESTRATION_WAIT_KINDS,
  ORCHESTRATION_WAIT_STATES,
  orchestrationWaitKey,
  TERMINAL_WAIT_STATES,
  validateRetryPolicy,
  validateStateBounds,
  WorkflowConfigError,
  waitEffectIdempotencyKey,
} from "../../../src/platform/workflow/port";

const EXECUTION_ID = "01978d3e-5f2a-7000-8000-00000000c0de";

describe("workflow port correlation identities (WORK-045 D-04)", () => {
  test("the orchestration wait key is deterministic and lineage-scoped", () => {
    expect(orchestrationWaitKey(EXECUTION_ID, "callback", 0)).toBe(
      `wait:${EXECUTION_ID}:callback:0`,
    );
    expect(orchestrationWaitKey(EXECUTION_ID, "callback", 0)).toBe(
      orchestrationWaitKey(EXECUTION_ID, "callback", 0),
    );
    expect(orchestrationWaitKey(EXECUTION_ID, "approval", 2)).toBe(
      `wait:${EXECUTION_ID}:approval:2`,
    );
    expect(orchestrationWaitKey(EXECUTION_ID, "callback", 0)).not.toBe(
      orchestrationWaitKey(EXECUTION_ID, "approval", 0),
    );
    expect(orchestrationWaitKey(EXECUTION_ID, "callback", 0)).not.toBe(
      orchestrationWaitKey(EXECUTION_ID, "callback", 1),
    );
  });

  test("the governed-effect idempotency key derives from the wait key", () => {
    const key = waitEffectIdempotencyKey(orchestrationWaitKey(EXECUTION_ID, "callback", 0));
    expect(key).toBe(`workflow-effect:wait:${EXECUTION_ID}:callback:0`);
    expect(waitEffectIdempotencyKey("x")).toBe("workflow-effect:x");
  });
});

describe("canonical payload stability (digest contract)", () => {
  test("canonical JSON is key-order independent", () => {
    const a = { v: 1, b: "two", a: { y: 2, x: 1 } };
    const b = { a: { x: 1, y: 2 }, b: "two", v: 1 };
    expect(canonicalPayloadJson(a)).toBe(canonicalPayloadJson(b));
    expect(payloadDigestOf(a)).toBe(payloadDigestOf(b));
  });

  test("the digest is the sha256 of the canonical form", () => {
    const payload = { waitKey: "wait:x:callback:0", v: 1 };
    const expected = createHash("sha256")
      .update(canonicalPayloadJson(payload), "utf8")
      .digest("hex");
    expect(payloadDigestOf(payload)).toBe(expected);
    expect(payloadDigestOf({})).not.toBe(expected);
  });
});

describe("the wait vocabulary is disjoint from the execution state vocabulary", () => {
  test("no wait state is an execution state (case-insensitive, both directions)", () => {
    for (const state of ORCHESTRATION_WAIT_STATES) {
      for (const executionState of EXECUTION_STATES) {
        expect(
          executionState.toLowerCase().includes(state.toLowerCase()),
          `${state} must not appear inside ${executionState}`,
        ).toBe(false);
        expect(
          state.toLowerCase().includes(executionState.toLowerCase()),
          `${executionState} must not appear inside ${state}`,
        ).toBe(false);
      }
    }
  });

  test("no wait KIND is an execution state word (case-insensitive)", () => {
    for (const kind of ORCHESTRATION_WAIT_KINDS) {
      for (const executionState of EXECUTION_STATES) {
        expect(kind.toLowerCase()).not.toBe(executionState.toLowerCase());
      }
    }
  });

  test("the terminal wait states are immutable by the transition table", () => {
    expect(TERMINAL_WAIT_STATES).toEqual(["settled", "elapsed", "superseded", "abandoned"]);
    for (const terminal of TERMINAL_WAIT_STATES) {
      expect(canTransitionWait(terminal, "settled")).toBe(false);
      expect(canTransitionWait(terminal, "armed")).toBe(false);
    }
    expect(canTransitionWait("recorded", "armed")).toBe(true);
    expect(canTransitionWait("recorded", "deferred")).toBe(true);
    expect(canTransitionWait("deferred", "armed")).toBe(true);
    expect(canTransitionWait("armed", "signaled")).toBe(true);
    expect(canTransitionWait("armed", "elapsed")).toBe(true);
    expect(canTransitionWait("signaled", "settled")).toBe(true);
    expect(canTransitionWait("recorded", "settled")).toBe(false);
    expect(canTransitionWait("armed", "deferred")).toBe(false);
    expect(canTransitionWait("signaled", "elapsed")).toBe(false);
  });

  test("the observed instance statuses are the neutral observation vocabulary", () => {
    expect(OBSERVED_INSTANCE_STATUSES).toEqual([
      "active",
      "paused",
      "errored",
      "terminated",
      "complete",
      "unknown",
    ]);
  });
});

describe("bounded policy validation (fail closed)", () => {
  const validPolicy = {
    maxStartAttempts: 3,
    maxSignalAttempts: 3,
    maxEffectAttempts: 3,
    maxReplacements: 3,
    retryBackoffMs: 500,
  };

  test("a bounded positive policy validates", () => {
    expect(validateRetryPolicy(validPolicy)).toEqual(validPolicy);
  });

  test("unbounded / non-positive / non-integer budgets are rejected with the exact names", () => {
    for (const override of [
      { maxStartAttempts: 0 },
      { maxStartAttempts: -1 },
      { maxStartAttempts: 101 },
      { maxStartAttempts: 1.5 },
      { maxSignalAttempts: 0 },
      { maxEffectAttempts: 101 },
      { maxReplacements: -3 },
      { retryBackoffMs: 0 },
      { retryBackoffMs: 61_000 },
    ]) {
      expect(() => validateRetryPolicy({ ...validPolicy, ...override })).toThrow(
        WorkflowConfigError,
      );
    }
    expect(() => validateRetryPolicy({ ...validPolicy, maxStartAttempts: 0 })).toThrow(
      /maxStartAttempts must be an integer/,
    );
  });

  test("the state bounds are bounded (reference-only payloads, bounded retention)", () => {
    expect(validateStateBounds({ maxPayloadBytes: 4096, maxRetainedNotifications: 32 })).toEqual({
      maxPayloadBytes: 4096,
      maxRetainedNotifications: 32,
    });
    for (const override of [
      { maxPayloadBytes: 128 },
      { maxPayloadBytes: 65_537 },
      { maxRetainedNotifications: 0 },
      { maxRetainedNotifications: 10_001 },
    ]) {
      expect(() =>
        validateStateBounds({ maxPayloadBytes: 4096, maxRetainedNotifications: 32, ...override }),
      ).toThrow(WorkflowConfigError);
    }
    expect(() =>
      validateStateBounds({ maxPayloadBytes: 128, maxRetainedNotifications: 32 }),
    ).toThrow(/reference-only pointer payloads/);
  });

  test("the backoff schedule is deterministic, linear and capped", () => {
    expect(backoffDelayMs(validPolicy, 1)).toBe(500);
    expect(backoffDelayMs(validPolicy, 2)).toBe(1000);
    expect(backoffDelayMs(validPolicy, 3)).toBe(1500);
    expect(backoffDelayMs(validPolicy, 1000)).toBe(60_000);
    expect(backoffDelayMs({ ...validPolicy, retryBackoffMs: 0 }, 5)).toBe(0);
  });
});
