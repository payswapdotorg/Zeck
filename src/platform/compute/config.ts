/**
 * Worker-fabric policy configuration (platform compute plane;
 * WORK-046, D-05).
 *
 * The bounded policy loader — the queue/workflow config discipline:
 * every variable is a BOUNDED integer with a repository default,
 * parsed fail-closed (garbage refuses with the exact variable name;
 * missing falls back to the default). No credential-shaped value is
 * ever read here: the runner token is an environment-materialized
 * secret resolved immediately before the authorized adapter call.
 *
 * Variables (all optional; all bounded):
 *
 *   ZECK_WORKER_LEASE_TTL_MS             default  60_000   [1s, 1h]
 *   ZECK_WORKER_HEARTBEAT_INTERVAL_MS    default   5_000   [100ms, 60s]
 *   ZECK_WORKER_DEFAULT_ENV_QUOTA        default       8   [1, 512]
 *   ZECK_WORKER_MAX_CLAIM_ATTEMPTS       default       3   [1, 10]
 *   ZECK_WORKER_MAX_IN_FLIGHT            default       4   [1, 128]
 *   ZECK_WORKER_MAX_DRAIN_MS             default 120_000   [1s, 10min]
 *   ZECK_WORKER_CLAIM_VISIBILITY_MS      default  30_000   [1s, 10min]
 *   ZECK_WORKER_BATCH_SIZE               default       8   [1, 32]
 *   ZECK_WORKER_STALE_AFTER_MS           default  90_000   [1s, 1h]
 *   ZECK_WORKER_MAX_OUTCOME_BYTES        default   2_048   [128, 8192]
 *   ZECK_WORKER_CLAIM_RETENTION_MS       default 604_800_000 (7d)  [1h, 90d]
 */

import { WORKER_POLICY_BOUNDS, type WorkerFabricPolicy } from "./port";

export const DEFAULT_WORKER_POLICY: Readonly<WorkerFabricPolicy> = Object.freeze({
  leaseTtlMs: 60_000,
  heartbeatIntervalMs: 5_000,
  defaultEnvironmentQuota: 8,
  maxClaimAttempts: 3,
  maxInFlightPerWorker: 4,
  maxDrainMs: 120_000,
  claimVisibilityMs: 30_000,
  batchSize: 8,
  workerStaleAfterMs: 90_000,
  maxOutcomeDetailBytes: 2_048,
  claimRetentionMs: 604_800_000,
});

export class WorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerConfigError";
  }
}

interface Bound {
  readonly key: keyof WorkerFabricPolicy;
  readonly variable: string;
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
}

const BOUNDS: readonly Bound[] = [
  {
    key: "leaseTtlMs",
    variable: "ZECK_WORKER_LEASE_TTL_MS",
    min: WORKER_POLICY_BOUNDS.leaseTtlMs.min,
    max: WORKER_POLICY_BOUNDS.leaseTtlMs.max,
    fallback: DEFAULT_WORKER_POLICY.leaseTtlMs,
  },
  {
    key: "heartbeatIntervalMs",
    variable: "ZECK_WORKER_HEARTBEAT_INTERVAL_MS",
    min: WORKER_POLICY_BOUNDS.heartbeatIntervalMs.min,
    max: WORKER_POLICY_BOUNDS.heartbeatIntervalMs.max,
    fallback: DEFAULT_WORKER_POLICY.heartbeatIntervalMs,
  },
  {
    key: "defaultEnvironmentQuota",
    variable: "ZECK_WORKER_DEFAULT_ENV_QUOTA",
    min: WORKER_POLICY_BOUNDS.defaultEnvironmentQuota.min,
    max: WORKER_POLICY_BOUNDS.defaultEnvironmentQuota.max,
    fallback: DEFAULT_WORKER_POLICY.defaultEnvironmentQuota,
  },
  {
    key: "maxClaimAttempts",
    variable: "ZECK_WORKER_MAX_CLAIM_ATTEMPTS",
    min: WORKER_POLICY_BOUNDS.maxClaimAttempts.min,
    max: WORKER_POLICY_BOUNDS.maxClaimAttempts.max,
    fallback: DEFAULT_WORKER_POLICY.maxClaimAttempts,
  },
  {
    key: "maxInFlightPerWorker",
    variable: "ZECK_WORKER_MAX_IN_FLIGHT",
    min: WORKER_POLICY_BOUNDS.maxInFlightPerWorker.min,
    max: WORKER_POLICY_BOUNDS.maxInFlightPerWorker.max,
    fallback: DEFAULT_WORKER_POLICY.maxInFlightPerWorker,
  },
  {
    key: "maxDrainMs",
    variable: "ZECK_WORKER_MAX_DRAIN_MS",
    min: WORKER_POLICY_BOUNDS.maxDrainMs.min,
    max: WORKER_POLICY_BOUNDS.maxDrainMs.max,
    fallback: DEFAULT_WORKER_POLICY.maxDrainMs,
  },
  {
    key: "claimVisibilityMs",
    variable: "ZECK_WORKER_CLAIM_VISIBILITY_MS",
    min: WORKER_POLICY_BOUNDS.claimVisibilityMs.min,
    max: WORKER_POLICY_BOUNDS.claimVisibilityMs.max,
    fallback: DEFAULT_WORKER_POLICY.claimVisibilityMs,
  },
  {
    key: "batchSize",
    variable: "ZECK_WORKER_BATCH_SIZE",
    min: WORKER_POLICY_BOUNDS.batchSize.min,
    max: WORKER_POLICY_BOUNDS.batchSize.max,
    fallback: DEFAULT_WORKER_POLICY.batchSize,
  },
  {
    key: "workerStaleAfterMs",
    variable: "ZECK_WORKER_STALE_AFTER_MS",
    min: WORKER_POLICY_BOUNDS.workerStaleAfterMs.min,
    max: WORKER_POLICY_BOUNDS.workerStaleAfterMs.max,
    fallback: DEFAULT_WORKER_POLICY.workerStaleAfterMs,
  },
  {
    key: "maxOutcomeDetailBytes",
    variable: "ZECK_WORKER_MAX_OUTCOME_BYTES",
    min: WORKER_POLICY_BOUNDS.maxOutcomeDetailBytes.min,
    max: WORKER_POLICY_BOUNDS.maxOutcomeDetailBytes.max,
    fallback: DEFAULT_WORKER_POLICY.maxOutcomeDetailBytes,
  },
  {
    key: "claimRetentionMs",
    variable: "ZECK_WORKER_CLAIM_RETENTION_MS",
    min: WORKER_POLICY_BOUNDS.claimRetentionMs.min,
    max: WORKER_POLICY_BOUNDS.claimRetentionMs.max,
    fallback: DEFAULT_WORKER_POLICY.claimRetentionMs,
  },
];

/** Parse one bounded integer (fail-closed on garbage; default when unset). */
function parseBound(env: Record<string, string | undefined>, bound: Bound): number {
  const raw = env[bound.variable];
  if (raw === undefined || raw.trim() === "") {
    return bound.fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) {
    throw new WorkerConfigError(`${bound.variable} must be an integer (got "${raw}")`);
  }
  if (value < bound.min || value > bound.max) {
    throw new WorkerConfigError(
      `${bound.variable} must be between ${bound.min} and ${bound.max} (got ${value})`,
    );
  }
  return value;
}

/**
 * Load the worker-fabric policy from the environment. Pure with
 * respect to the environment snapshot passed in; fail-closed on
 * every malformed value. Every policy field is covered by a bound —
 * an incomplete policy is unrepresentable.
 */
export function loadWorkerPolicy(env: Record<string, string | undefined>): WorkerFabricPolicy {
  const policy = {} as Record<keyof WorkerFabricPolicy, number>;
  for (const bound of BOUNDS) {
    policy[bound.key] = parseBound(env, bound);
  }
  return policy as WorkerFabricPolicy;
}

/** Validate a fully-formed policy object (composition/test seam). */
export function validateWorkerPolicy(policy: WorkerFabricPolicy): WorkerFabricPolicy {
  for (const bound of BOUNDS) {
    const value = policy[bound.key];
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new WorkerConfigError(`policy.${bound.key} must be an integer`);
    }
    if (value < bound.min || value > bound.max) {
      throw new WorkerConfigError(
        `policy.${bound.key} must be between ${bound.min} and ${bound.max} (got ${value})`,
      );
    }
  }
  return policy;
}
