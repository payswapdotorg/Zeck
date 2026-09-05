/**
 * Provider-neutral workflow orchestration configuration (WORK-045 /
 * D-04).
 *
 * Repository-defined bounded budgets, exactly like the D-02/D-03
 * configuration modules: declared in `deploy/manifests/variables.json`,
 * read from the process environment (`ZECK_WORKFLOW_*`), defaulted to
 * the repository-declared defaults, and rejected fail-closed when the
 * materialized values are non-integer or out of bounds (an unbounded
 * orchestration loop is unrepresentable).
 *
 * This module is ordinary configuration ONLY — provider endpoint
 * configuration and credential materialization live in the owning
 * adapter module; this file carries no provider vocabulary and no
 * secrets, ever.
 */
import {
  validateRetryPolicy,
  validateStateBounds,
  type WorkflowRetryPolicy,
  type WorkflowStateBounds,
} from "./port";

/** Repository-declared bounded defaults (deploy/manifests/variables.json). */
export const DEFAULT_WORKFLOW_RETRY_POLICY: WorkflowRetryPolicy = Object.freeze({
  maxStartAttempts: 3,
  maxSignalAttempts: 3,
  maxEffectAttempts: 3,
  maxReplacements: 3,
  retryBackoffMs: 500,
});

/** Repository-declared bounded state defaults. */
export const DEFAULT_WORKFLOW_STATE_BOUNDS: WorkflowStateBounds = Object.freeze({
  maxPayloadBytes: 4096,
  maxRetainedNotifications: 32,
});

/**
 * Load the bounded retry/replacement policy from the environment
 * (defaults on absence, fail-closed on garbage).
 */
export function loadWorkflowRetryPolicy(
  env: Readonly<Record<string, string | undefined>>,
): WorkflowRetryPolicy {
  return validateRetryPolicy({
    maxStartAttempts: readBounded(
      env.ZECK_WORKFLOW_MAX_START_ATTEMPTS,
      DEFAULT_WORKFLOW_RETRY_POLICY.maxStartAttempts,
      "ZECK_WORKFLOW_MAX_START_ATTEMPTS",
    ),
    maxSignalAttempts: readBounded(
      env.ZECK_WORKFLOW_MAX_SIGNAL_ATTEMPTS,
      DEFAULT_WORKFLOW_RETRY_POLICY.maxSignalAttempts,
      "ZECK_WORKFLOW_MAX_SIGNAL_ATTEMPTS",
    ),
    maxEffectAttempts: readBounded(
      env.ZECK_WORKFLOW_MAX_EFFECT_ATTEMPTS,
      DEFAULT_WORKFLOW_RETRY_POLICY.maxEffectAttempts,
      "ZECK_WORKFLOW_MAX_EFFECT_ATTEMPTS",
    ),
    maxReplacements: readBounded(
      env.ZECK_WORKFLOW_MAX_REPLACEMENTS,
      DEFAULT_WORKFLOW_RETRY_POLICY.maxReplacements,
      "ZECK_WORKFLOW_MAX_REPLACEMENTS",
    ),
    retryBackoffMs: readBounded(
      env.ZECK_WORKFLOW_RETRY_BACKOFF_MS,
      DEFAULT_WORKFLOW_RETRY_POLICY.retryBackoffMs,
      "ZECK_WORKFLOW_RETRY_BACKOFF_MS",
    ),
  });
}

/**
 * Load the bounded state bounds from the environment (reference-only
 * payloads; bounded retained notifications).
 */
export function loadWorkflowStateBounds(
  env: Readonly<Record<string, string | undefined>>,
): WorkflowStateBounds {
  return validateStateBounds({
    maxPayloadBytes: readBounded(
      env.ZECK_WORKFLOW_MAX_PAYLOAD_BYTES,
      DEFAULT_WORKFLOW_STATE_BOUNDS.maxPayloadBytes,
      "ZECK_WORKFLOW_MAX_PAYLOAD_BYTES",
    ),
    maxRetainedNotifications: readBounded(
      env.ZECK_WORKFLOW_MAX_RETAINED_NOTIFICATIONS,
      DEFAULT_WORKFLOW_STATE_BOUNDS.maxRetainedNotifications,
      "ZECK_WORKFLOW_MAX_RETAINED_NOTIFICATIONS",
    ),
  });
}

function readInt(raw: string, name: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got: ${raw})`);
  }
  return value;
}

function readBounded(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  return readInt(raw, name);
}
