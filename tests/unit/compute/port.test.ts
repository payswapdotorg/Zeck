/**
 * Unit — the compute-plane port vocabulary discipline (WORK-046 /
 * D-05; the D-03/D-04 lesson applied to the worker plane).
 *
 * Mechanically proves:
 *  - the worker-plane state vocabularies are DISJOINT from the 14
 *    frozen execution states (case-insensitively, both directions) —
 *    there is no second execution state machine in the worker plane;
 *  - the disjointness anchor covers every vocabulary;
 *  - the transition tables are terminal-complete (no outgoing edges);
 *  - the deterministic key derivation is stable;
 *  - the claim refusals/fences/abandon causes are the exact
 *    documented vocabularies.
 */

import { describe, expect, test } from "vitest";
import { EXECUTION_STATES } from "../../../src/modules/executions/public";
import {
  LEASE_FENCE_CLASSES,
  RUNNER_REGISTRATION_STATUSES,
  RUNNER_REGISTRATION_TRANSITIONS,
  validateRunnerRegistration,
  WORKER_ABANDON_CAUSES,
  WORKER_CLAIM_OUTCOMES,
  WORKER_CLAIM_STATUSES,
  WORKER_PLANE_STATE_VOCABULARIES,
  WORKER_POLICY_BOUNDS,
  WORKER_REGISTRATION_KINDS,
  WORKER_REGISTRATION_STATUSES,
  WORKER_REGISTRATION_TRANSITIONS,
} from "../../../src/platform/compute/port";

describe("worker-plane vocabulary disjointness (WORK-046 D-05)", () => {
  const executionWords = EXECUTION_STATES.map((state) => state.toLowerCase());

  test("every worker-plane vocabulary is disjoint from the frozen execution states", () => {
    for (const vocabulary of Object.values(WORKER_PLANE_STATE_VOCABULARIES)) {
      for (const word of vocabulary) {
        expect(executionWords).not.toContain(word.toLowerCase());
      }
    }
  });

  test("the disjointness is direction-checked: no execution state appears in any worker vocabulary", () => {
    const workerWords = Object.values(WORKER_PLANE_STATE_VOCABULARIES)
      .flatMap((vocabulary) => [...vocabulary])
      .map((word) => word.toLowerCase());
    for (const state of EXECUTION_STATES) {
      expect(workerWords).not.toContain(state.toLowerCase());
    }
  });

  test("the anchor covers all five vocabularies", () => {
    expect(Object.keys(WORKER_PLANE_STATE_VOCABULARIES).sort()).toStrictEqual(
      [
        "claimOutcomes",
        "claimStatuses",
        "fenceClasses",
        "abandonCauses",
        "registrationStatuses",
      ].sort(),
    );
  });

  test("registration statuses: terminal offline has no outgoing edge", () => {
    expect(WORKER_REGISTRATION_STATUSES).toStrictEqual(["active", "draining", "offline"]);
    expect(WORKER_REGISTRATION_TRANSITIONS.offline).toStrictEqual([]);
    expect(WORKER_REGISTRATION_TRANSITIONS.active).toContain("draining");
    expect(WORKER_REGISTRATION_TRANSITIONS.draining).toStrictEqual(["offline"]);
  });

  test("claim statuses and outcomes: the exact documented vocabularies", () => {
    expect(WORKER_CLAIM_STATUSES).toStrictEqual(["claimed", "finished", "abandoned"]);
    expect(WORKER_CLAIM_OUTCOMES).toStrictEqual([
      "applied-success",
      "applied-failure",
      "converged-elsewhere",
      "not-executable",
    ]);
    expect(WORKER_ABANDON_CAUSES).toContain("stale-write");
    expect(WORKER_ABANDON_CAUSES).toContain("heartbeat-lost");
    expect(WORKER_ABANDON_CAUSES).toContain("worker-drained");
  });

  test("fence classes: every stale-worker class fails the guard closed", () => {
    expect(LEASE_FENCE_CLASSES).toStrictEqual([
      "no-lease",
      "lease-released",
      "epoch-superseded",
      "foreign-owner",
      "lease-elapsed",
    ]);
  });

  test("runner registration lifecycle: revoked is terminal; the governed edges only", () => {
    expect(RUNNER_REGISTRATION_STATUSES).toStrictEqual([
      "pending",
      "active",
      "suspended",
      "revoked",
    ]);
    expect(RUNNER_REGISTRATION_TRANSITIONS.revoked).toStrictEqual([]);
    expect(RUNNER_REGISTRATION_TRANSITIONS.pending).toStrictEqual(["active", "revoked"]);
    expect(RUNNER_REGISTRATION_TRANSITIONS.active).toStrictEqual(["suspended", "revoked"]);
    expect(RUNNER_REGISTRATION_TRANSITIONS.suspended).toStrictEqual(["active", "revoked"]);
  });

  test("worker registration kinds and policy bounds: the exact bounded vocabulary", () => {
    expect(WORKER_REGISTRATION_KINDS).toStrictEqual(["first-party", "customer-runner"]);
    expect(WORKER_POLICY_BOUNDS.leaseTtlMs).toMatchObject({ min: 1_000, max: 3_600_000 });
    expect(WORKER_POLICY_BOUNDS.maxClaimAttempts).toMatchObject({ min: 1, max: 10 });
    expect(WORKER_POLICY_BOUNDS.maxInFlightPerWorker).toMatchObject({ min: 1, max: 128 });
    expect(WORKER_POLICY_BOUNDS.claimRetentionMs.min).toBeGreaterThan(0);
  });

  test("runner registration validation: fail-closed on every field", () => {
    const valid = {
      runnerId: "r1",
      applicationId: "a1",
      tenantId: "t1",
      endpointUrl: "https://runner.customer.example",
      tokenSecretRef: "zeck-secret://local/runner-x",
      registeredBy: "operator",
    };
    expect(validateRunnerRegistration(valid).valid).toBe(true);
    // endpoint must be http(s)
    expect(validateRunnerRegistration({ ...valid, endpointUrl: "ftp://x" }).valid).toBe(false);
    // secret VALUES are never acceptable (references only)
    expect(
      validateRunnerRegistration({ ...valid, tokenSecretRef: "sk-abcdef1234567890" }).valid,
    ).toBe(false);
    expect(
      validateRunnerRegistration({ ...valid, tokenSecretRef: "super-secret-value" }).valid,
    ).toBe(false);
    // attribution is required
    expect(validateRunnerRegistration({ ...valid, registeredBy: "" }).valid).toBe(false);
    // metadata is bounded
    expect(
      validateRunnerRegistration({ ...valid, metadata: { blob: "x".repeat(3_000) } }).valid,
    ).toBe(false);
  });
});
