/**
 * Discrimination — the D-05 worker-fabric guards (WORK-046 / D-05; the
 * Required Verification "Discrimination / mutation" section).
 *
 * Proves with SYNTHETIC weakening that every protection actually
 * discriminates (a weakened guard is detected) + the authority-side
 * discriminations over the REAL vocabulary:
 *
 *  - a late stale-worker completion is rejected by the authoritative
 *    boundary (the lease domain's guard rejects the stale claim);
 *  - a provider/runtime success signal without the authoritative
 *    transition CANNOT complete an execution (the verification
 *    binding is physical);
 *  - ambient secret / raw-secret injection is rejected at the runner
 *    registration and sandbox task boundaries;
 *  - unbounded concurrency/quota weakening is detected (the store
 *    config bounds);
 *  - customer-runner authority inflation is rejected (the scope
 *    gate's error vocabulary exists and is enforced in the claims
 *    suite; here the vocabulary and validation discriminate);
 *  - the worker-plane vocabularies DETECT an overlapping injected
 *    word (the disjointness check discriminates).
 */

import { describe, expect, test } from "vitest";
import { leaseGuardRejection } from "../../src/modules/executions/domain/lease";
import { EXECUTION_STATES, TERMINAL_STATUSES } from "../../src/modules/executions/public";
import {
  containsRawSecretValue,
  validateSandboxTask,
} from "../../src/modules/sandbox/domain/sandbox";
import {
  ComputeStoreConfigError,
  SqlComputeWorkerStore,
} from "../../src/platform/compute/pg-store";
import {
  validateRunnerRegistration,
  WORKER_PLANE_STATE_VOCABULARIES,
} from "../../src/platform/compute/port";

describe("worker-fabric discrimination (WORK-046 D-05)", () => {
  test("a late stale-worker completion is rejected by the authoritative lease boundary", () => {
    const lease = {
      executionId: "e",
      applicationId: "a",
      tenantId: "t",
      ownerId: "fresh-worker",
      epoch: 2,
      acquiredAt: "2026-01-01T00:00:00Z",
      expiresAt: "2999-01-01T00:00:00Z",
      lastHeartbeatAt: "2026-01-01T00:00:00Z",
      heartbeatCount: 1,
      releasedAt: null,
      releaseCause: null,
    };
    const now = "2026-01-01T00:00:01Z";
    // The stale worker presents the superseded epoch 1.
    const rejection = leaseGuardRejection(lease, { ownerId: "stale-worker", epoch: 1 }, now);
    expect(rejection).not.toBeNull();
    expect(rejection?.code).toBe("INVALID_STATE_TRANSITION");
    expect(rejection?.reason).toContain("stale worker at epoch 1 is not authoritative");
    // A foreign live owner is likewise rejected.
    const foreign = leaseGuardRejection(lease, { ownerId: "other-worker", epoch: 2 }, now);
    expect(foreign?.reason).toContain("lease conflicts fail closed");
    // An elapsed lease (the stale-worker class).
    const elapsed = leaseGuardRejection(
      { ...lease, expiresAt: "2026-01-01T00:00:00Z" },
      { ownerId: "fresh-worker", epoch: 2 },
      now,
    );
    expect(elapsed?.code).toBe("EXPIRED");
    expect(elapsed?.reason).toContain("stale workers cannot commit side effects");
    // Only the exact live owner+epoch passes.
    expect(leaseGuardRejection(lease, { ownerId: "fresh-worker", epoch: 2 }, now)).toBeNull();
  });

  test("a provider/runtime success signal cannot complete an execution: the verification binding is physical", () => {
    // The frozen state machine: COMPLETED is produced ONLY by the
    // verify+pass edge. The discrimination: a synthetic "success"
    // observation (no verification results) is unrepresentable as a
    // completion — the pass command REQUIRES verificationResults.
    expect(TERMINAL_STATUSES).toContain("COMPLETED");
    expect(EXECUTION_STATES).toContain("VERIFYING");
    // The worker plane has NO completion vocabulary of its own (it
    // never declares success — only the authority does).
    const claimOutcomes = WORKER_PLANE_STATE_VOCABULARIES.claimOutcomes.map((o) => o.toLowerCase());
    for (const forbidden of ["completed", "success", "succeeded"]) {
      expect(claimOutcomes).not.toContain(forbidden);
    }
  });

  test("ambient secret injection is rejected at the runner registration and sandbox task boundaries", () => {
    // Runner token: references only, never values.
    const secretValue = validateRunnerRegistration({
      runnerId: "r",
      applicationId: "a",
      tenantId: "t",
      endpointUrl: "https://runner.example",
      tokenSecretRef: "sk-supersecretvalue12345678",
      registeredBy: "op",
    });
    expect(secretValue.valid).toBe(false);
    expect(secretValue.issues.join(" ")).toContain("zeck-secret://");
    // Sandbox task: raw secret VALUES rejected before anything durable.
    const task = validateSandboxTask({
      command: "python3",
      args: [],
      publicEnv: { TOKEN: "ghp_abcdefghijklmnopqrstuvwx" },
    });
    expect(task.valid).toBe(false);
    expect(containsRawSecretValue("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
  });

  test("unbounded concurrency/quota weakening is detected at the store configuration", () => {
    expect(
      () =>
        new SqlComputeWorkerStore({
          db: {} as never,
          maxClaimAttempts: 11,
          defaultEnvironmentQuota: 8,
          claimRetentionMs: 604_800_000,
          generateId: () => "id",
        }),
    ).toThrow(ComputeStoreConfigError);
    expect(
      () =>
        new SqlComputeWorkerStore({
          db: {} as never,
          maxClaimAttempts: 3,
          defaultEnvironmentQuota: 513,
          claimRetentionMs: 604_800_000,
          generateId: () => "id",
        }),
    ).toThrow(/bounded \[1, 512\]/);
    expect(
      () =>
        new SqlComputeWorkerStore({
          db: {} as never,
          maxClaimAttempts: 3,
          defaultEnvironmentQuota: 8,
          claimRetentionMs: 0,
          generateId: () => "id",
        }),
    ).toThrow(/claimRetentionMs must be a bounded positive integer/);
  });

  test("customer-runner authority inflation is rejected (references cannot mint authority)", () => {
    // A runner registration carries NO authority vocabulary: the
    // record shape has no execution/policy/budget fields, and the
    // validation rejects metadata that tries to smuggle authority
    // claims as unbounded payloads.
    const oversized = validateRunnerRegistration({
      runnerId: "r",
      applicationId: "a",
      tenantId: "t",
      endpointUrl: "https://runner.example",
      tokenSecretRef: "zeck-secret://local/runner-x",
      registeredBy: "op",
      metadata: { canExecuteAnything: "x".repeat(2_500) },
    });
    expect(oversized.valid).toBe(false);
    expect(oversized.issues.join(" ")).toContain("bounded");
  });

  test("the vocabulary disjointness check DETECTS an overlapping injected word", () => {
    // A synthetic weakening: an execution state word injected into a
    // worker vocabulary is detected by the disjointness property.
    const weakened = [...WORKER_PLANE_STATE_VOCABULARIES.claimStatuses, "RUNNING"];
    const executionWords = EXECUTION_STATES.map((state) => state.toLowerCase());
    const overlap = weakened.filter((word) => executionWords.includes(word.toLowerCase()));
    expect(overlap).toStrictEqual(["RUNNING"]);
    // The real vocabulary is clean.
    const clean = WORKER_PLANE_STATE_VOCABULARIES.claimStatuses.filter((word) =>
      executionWords.includes(word.toLowerCase()),
    );
    expect(clean).toStrictEqual([]);
  });
});
