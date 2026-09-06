/**
 * Unit — the worker-fabric policy loader (WORK-046 / D-05).
 *
 * The queue/workflow config discipline: every variable is a BOUNDED
 * integer with a repository default, parsed fail-closed (garbage
 * refuses with the exact variable name; missing falls back).
 */

import { describe, expect, test } from "vitest";
import {
  DEFAULT_WORKER_POLICY,
  loadWorkerPolicy,
  validateWorkerPolicy,
  WorkerConfigError,
} from "../../../src/platform/compute/config";
import type { WorkerFabricPolicy } from "../../../src/platform/compute/port";

describe("worker policy config (WORK-046 D-05)", () => {
  test("defaults load with no environment", () => {
    const policy = loadWorkerPolicy({});
    expect(policy).toStrictEqual(DEFAULT_WORKER_POLICY);
    expect(policy.leaseTtlMs).toBe(60_000);
    expect(policy.maxClaimAttempts).toBe(3);
    expect(policy.claimRetentionMs).toBe(604_800_000);
  });

  test("every policy field is covered by a variable bound (an incomplete policy is unrepresentable)", () => {
    const keys = Object.keys(DEFAULT_WORKER_POLICY) as (keyof WorkerFabricPolicy)[];
    // 11 bounded fields, every one covered by a variable bound
    expect(keys).toHaveLength(11);
    const fromBounds = loadWorkerPolicy({
      ZECK_WORKER_LEASE_TTL_MS: "1000",
      ZECK_WORKER_HEARTBEAT_INTERVAL_MS: "100",
      ZECK_WORKER_DEFAULT_ENV_QUOTA: "1",
      ZECK_WORKER_MAX_CLAIM_ATTEMPTS: "1",
      ZECK_WORKER_MAX_IN_FLIGHT: "1",
      ZECK_WORKER_MAX_DRAIN_MS: "1000",
      ZECK_WORKER_CLAIM_VISIBILITY_MS: "1000",
      ZECK_WORKER_BATCH_SIZE: "1",
      ZECK_WORKER_STALE_AFTER_MS: "1000",
      ZECK_WORKER_MAX_OUTCOME_BYTES: "128",
      ZECK_WORKER_CLAIM_RETENTION_MS: "3600000",
    });
    expect(fromBounds.leaseTtlMs).toBe(1_000);
    expect(fromBounds.claimRetentionMs).toBe(3_600_000);
  });

  test("garbage refuses with the exact variable name", () => {
    expect(() => loadWorkerPolicy({ ZECK_WORKER_LEASE_TTL_MS: "abc" })).toThrow(
      /ZECK_WORKER_LEASE_TTL_MS must be an integer/,
    );
    expect(() => loadWorkerPolicy({ ZECK_WORKER_BATCH_SIZE: "garbage" })).toThrow(
      /ZECK_WORKER_BATCH_SIZE must be an integer/,
    );
  });

  test("out-of-bound values refuse with the exact range", () => {
    expect(() => loadWorkerPolicy({ ZECK_WORKER_LEASE_TTL_MS: "999" })).toThrow(
      /between 1000 and 3600000/,
    );
    expect(() => loadWorkerPolicy({ ZECK_WORKER_MAX_IN_FLIGHT: "0" })).toThrow(/between 1 and 128/);
    expect(() => loadWorkerPolicy({ ZECK_WORKER_MAX_CLAIM_ATTEMPTS: "11" })).toThrow(
      /between 1 and 10/,
    );
  });

  test("empty values fall back to the defaults", () => {
    const policy = loadWorkerPolicy({ ZECK_WORKER_LEASE_TTL_MS: "  " });
    expect(policy.leaseTtlMs).toBe(DEFAULT_WORKER_POLICY.leaseTtlMs);
  });

  test("validateWorkerPolicy: the object seam mirrors the loader", () => {
    expect(() => validateWorkerPolicy({ ...DEFAULT_WORKER_POLICY, maxDrainMs: 999 })).toThrow(
      WorkerConfigError,
    );
    expect(validateWorkerPolicy(DEFAULT_WORKER_POLICY)).toStrictEqual(DEFAULT_WORKER_POLICY);
    expect(() =>
      validateWorkerPolicy({ ...DEFAULT_WORKER_POLICY, heartbeatIntervalMs: 0 }),
    ).toThrow(/heartbeatIntervalMs/);
  });
});
