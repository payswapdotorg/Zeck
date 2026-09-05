/**
 * Provider-neutral queue retry policy configuration (WORK-044 / D-03).
 *
 * Repository-defined bounded budgets, exactly like the D-02 database
 * and object-store configuration: declared in
 * `deploy/manifests/variables.json`, read from the process
 * environment (`ZECK_QUEUE_*`), defaulted to the repository-declared
 * defaults, and rejected fail-closed when the materialized values are
 * non-integer or out of bounds (an unbounded retry loop is
 * unrepresentable).
 *
 * This module is ordinary configuration ONLY — provider endpoint
 * configuration and credential materialization live in the owning
 * adapter module; this file carries no provider vocabulary and no
 * secrets, ever.
 */
import { QueueConfigError, type QueueRetryPolicy, validateRetryPolicy } from "./port";

/** Repository-declared bounded defaults (deploy/manifests/variables.json). */
export const DEFAULT_QUEUE_RETRY_POLICY: QueueRetryPolicy = Object.freeze({
  maxPublishAttempts: 3,
  maxDeliveryAttempts: 3,
  maxReplays: 3,
  retryBackoffMs: 500,
});

/**
 * Load the bounded retry/replay policy from the environment (defaults
 * on absence, fail-closed on garbage).
 */
export function loadQueueRetryPolicy(
  env: Readonly<Record<string, string | undefined>>,
): QueueRetryPolicy {
  return validateRetryPolicy({
    maxPublishAttempts: readBounded(
      env.ZECK_QUEUE_MAX_PUBLISH_ATTEMPTS,
      DEFAULT_QUEUE_RETRY_POLICY.maxPublishAttempts,
      "ZECK_QUEUE_MAX_PUBLISH_ATTEMPTS",
    ),
    maxDeliveryAttempts: readBounded(
      env.ZECK_QUEUE_MAX_DELIVERY_ATTEMPTS,
      DEFAULT_QUEUE_RETRY_POLICY.maxDeliveryAttempts,
      "ZECK_QUEUE_MAX_DELIVERY_ATTEMPTS",
    ),
    maxReplays: readBounded(
      env.ZECK_QUEUE_MAX_REPLAYS,
      DEFAULT_QUEUE_RETRY_POLICY.maxReplays,
      "ZECK_QUEUE_MAX_REPLAYS",
    ),
    retryBackoffMs: readBounded(
      env.ZECK_QUEUE_RETRY_BACKOFF_MS,
      DEFAULT_QUEUE_RETRY_POLICY.retryBackoffMs,
      "ZECK_QUEUE_RETRY_BACKOFF_MS",
    ),
  });
}

function readInt(raw: string, name: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new QueueConfigError(`${name} must be a positive integer (got: ${raw})`);
  }
  return value;
}

function readBounded(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  return readInt(raw, name);
}
