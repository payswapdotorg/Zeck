/**
 * Unit — the provider-neutral workflow configuration loading
 * (WORK-045 / D-04): repository-declared defaults, environment
 * overrides, fail-closed on garbage (an unbounded orchestration loop
 * is unrepresentable).
 */

import { describe, expect, test } from "vitest";
import {
  DEFAULT_WORKFLOW_RETRY_POLICY,
  DEFAULT_WORKFLOW_STATE_BOUNDS,
  loadWorkflowRetryPolicy,
  loadWorkflowStateBounds,
} from "../../../src/platform/workflow/config";

describe("workflow configuration loading (WORK-045 D-04)", () => {
  test("the repository defaults are bounded and explicit", () => {
    expect(DEFAULT_WORKFLOW_RETRY_POLICY).toEqual({
      maxStartAttempts: 3,
      maxSignalAttempts: 3,
      maxEffectAttempts: 3,
      maxReplacements: 3,
      retryBackoffMs: 500,
    });
    expect(DEFAULT_WORKFLOW_STATE_BOUNDS).toEqual({
      maxPayloadBytes: 4096,
      maxRetainedNotifications: 32,
    });
  });

  test("absent variables load the defaults", () => {
    expect(loadWorkflowRetryPolicy({})).toEqual(DEFAULT_WORKFLOW_RETRY_POLICY);
    expect(loadWorkflowStateBounds({})).toEqual(DEFAULT_WORKFLOW_STATE_BOUNDS);
  });

  test("bounded overrides load", () => {
    expect(
      loadWorkflowRetryPolicy({
        ZECK_WORKFLOW_MAX_START_ATTEMPTS: "5",
        ZECK_WORKFLOW_MAX_SIGNAL_ATTEMPTS: "2",
        ZECK_WORKFLOW_MAX_EFFECT_ATTEMPTS: "4",
        ZECK_WORKFLOW_MAX_REPLACEMENTS: "1",
        ZECK_WORKFLOW_RETRY_BACKOFF_MS: "250",
      }),
    ).toEqual({
      maxStartAttempts: 5,
      maxSignalAttempts: 2,
      maxEffectAttempts: 4,
      maxReplacements: 1,
      retryBackoffMs: 250,
    });
    expect(
      loadWorkflowStateBounds({
        ZECK_WORKFLOW_MAX_PAYLOAD_BYTES: "1024",
        ZECK_WORKFLOW_MAX_RETAINED_NOTIFICATIONS: "8",
      }),
    ).toEqual({ maxPayloadBytes: 1024, maxRetainedNotifications: 8 });
  });

  test("garbage values fail closed with the exact variable names", () => {
    expect(() => loadWorkflowRetryPolicy({ ZECK_WORKFLOW_MAX_START_ATTEMPTS: "0" })).toThrow(
      /ZECK_WORKFLOW_MAX_START_ATTEMPTS/,
    );
    expect(() => loadWorkflowRetryPolicy({ ZECK_WORKFLOW_MAX_REPLACEMENTS: "abc" })).toThrow(
      /ZECK_WORKFLOW_MAX_REPLACEMENTS/,
    );
    expect(() => loadWorkflowRetryPolicy({ ZECK_WORKFLOW_RETRY_BACKOFF_MS: "-5" })).toThrow(
      /ZECK_WORKFLOW_RETRY_BACKOFF_MS/,
    );
    // Below-minimum payload bounds surface the bound name...
    expect(() => loadWorkflowStateBounds({ ZECK_WORKFLOW_MAX_PAYLOAD_BYTES: "10" })).toThrow(
      /maxPayloadBytes must be an integer/,
    );
    // ...while non-integer garbage surfaces the exact variable name.
    expect(() =>
      loadWorkflowStateBounds({ ZECK_WORKFLOW_MAX_RETAINED_NOTIFICATIONS: "0" }),
    ).toThrow(/ZECK_WORKFLOW_MAX_RETAINED_NOTIFICATIONS/);
  });
});
