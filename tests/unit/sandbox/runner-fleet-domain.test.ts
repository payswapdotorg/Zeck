/**
 * Unit tests — the runner fleet domain (WORK-019, ENV-003; the sandbox
 * `domain.test.ts` discipline, restated for the fleet axis).
 *
 * Proves the pure domain: the capability vocabulary and validation, the
 * explicit authorization/assignment transition tables (no ambiguous
 * states), health freshness eligibility, the neutral validation surfaces
 * (registration tokens, leases, result reports, references) and the
 * idempotency fingerprints.
 */

import { describe, expect, test } from "vitest";
import {
  canTransitionRunnerAssignment,
  canTransitionRunnerAuthorization,
  isRunnerCapabilityId,
  isRunnerHealthyForAssignment,
  isTerminalRunnerAssignmentStatus,
  RUNNER_ASSIGNMENT_STATUSES,
  RUNNER_AUTHORIZATION_STATUSES,
  RUNNER_CAPABILITY_IDS,
  runnerAssignmentFingerprint,
  runnerRegistrationFingerprint,
  runnerSupportsRequirements,
  validateRunnerCapabilities,
  validateRunnerLease,
  validateRunnerReference,
  validateRunnerRegistration,
  validateRunnerResultReport,
} from "../../../src/modules/sandbox/public";

describe("runner capability vocabulary", () => {
  test("the neutral vocabulary is exactly the Work Order's substrate classes", () => {
    expect([...RUNNER_CAPABILITY_IDS]).toEqual([
      "cpu",
      "memory",
      "filesystem",
      "network",
      "gpu",
      "microvm",
      "vm",
      "customer-runner",
    ]);
  });

  test("membership check", () => {
    expect(isRunnerCapabilityId("gpu")).toBe(true);
    expect(isRunnerCapabilityId("firecracker")).toBe(false);
    expect(isRunnerCapabilityId("container-runtime")).toBe(false);
  });

  test("capability validation: vocabulary, dedup, bounds, non-empty", () => {
    expect(validateRunnerCapabilities(["cpu", "memory"]).valid).toBe(true);
    expect(validateRunnerCapabilities([]).valid).toBe(false);
    expect(validateRunnerCapabilities(["cpu", "cpu"]).valid).toBe(false);
    expect(validateRunnerCapabilities(["host-access"]).valid).toBe(false);
    expect(validateRunnerCapabilities(Array.from({ length: 17 }, () => "cpu")).valid).toBe(false);
  });

  test("requirement matching is subset semantics", () => {
    expect(runnerSupportsRequirements(["cpu", "memory", "network"], ["cpu", "memory"])).toBe(true);
    expect(runnerSupportsRequirements(["cpu"], ["cpu", "gpu"])).toBe(false);
    expect(runnerSupportsRequirements(["customer-runner", "cpu"], ["customer-runner"])).toBe(true);
  });
});

describe("runner authorization lifecycle", () => {
  test("registration is not trust: untrusted is the only start state", () => {
    expect([...RUNNER_AUTHORIZATION_STATUSES]).toEqual(["untrusted", "authorized", "revoked"]);
  });

  test("the transition table is explicit and revocation is terminal", () => {
    expect(canTransitionRunnerAuthorization("untrusted", "authorized")).toBe(true);
    expect(canTransitionRunnerAuthorization("untrusted", "revoked")).toBe(true);
    expect(canTransitionRunnerAuthorization("authorized", "revoked")).toBe(true);
    expect(canTransitionRunnerAuthorization("authorized", "untrusted")).toBe(false);
    expect(canTransitionRunnerAuthorization("revoked", "authorized")).toBe(false);
    expect(canTransitionRunnerAuthorization("revoked", "revoked")).toBe(false);
  });
});

describe("runner assignment lifecycle", () => {
  test("the assignment vocabulary is disjoint from every execution status", () => {
    expect([...RUNNER_ASSIGNMENT_STATUSES]).toEqual([
      "assigned",
      "dispatched",
      "completed",
      "failed",
      "released",
      "expired",
    ]);
    for (const status of RUNNER_ASSIGNMENT_STATUSES) {
      expect(["CREATED", "AUTHORIZED", "PLANNING", "QUEUED", "RUNNING", "VERIFYING"]).not.toContain(
        status.toUpperCase(),
      );
    }
  });

  test("the transition table is explicit; terminal states have no exits", () => {
    expect(canTransitionRunnerAssignment("assigned", "dispatched")).toBe(true);
    expect(canTransitionRunnerAssignment("assigned", "released")).toBe(true);
    expect(canTransitionRunnerAssignment("assigned", "expired")).toBe(true);
    expect(canTransitionRunnerAssignment("assigned", "completed")).toBe(false);
    expect(canTransitionRunnerAssignment("dispatched", "completed")).toBe(true);
    expect(canTransitionRunnerAssignment("dispatched", "failed")).toBe(true);
    expect(canTransitionRunnerAssignment("dispatched", "released")).toBe(true);
    expect(canTransitionRunnerAssignment("dispatched", "expired")).toBe(true);
    for (const terminal of ["completed", "failed", "released", "expired"] as const) {
      expect(isTerminalRunnerAssignmentStatus(terminal)).toBe(true);
      for (const next of RUNNER_ASSIGNMENT_STATUSES) {
        expect(canTransitionRunnerAssignment(terminal, next)).toBe(false);
      }
    }
  });
});

describe("health eligibility", () => {
  const nowMs = Date.parse("2026-09-01T12:00:00.000Z");

  test("healthy + fresh heartbeat is eligible", () => {
    expect(
      isRunnerHealthyForAssignment(
        { healthStatus: "healthy", lastHeartbeatAt: "2026-09-01T11:59:40.000Z" },
        nowMs,
        30_000,
      ),
    ).toBe(true);
  });

  test("stale heartbeat is ineligible (dead runners are never assigned)", () => {
    expect(
      isRunnerHealthyForAssignment(
        { healthStatus: "healthy", lastHeartbeatAt: "2026-09-01T11:59:00.000Z" },
        nowMs,
        30_000,
      ),
    ).toBe(false);
  });

  test("missing heartbeat or non-healthy states are ineligible", () => {
    expect(
      isRunnerHealthyForAssignment(
        { healthStatus: "healthy", lastHeartbeatAt: null },
        nowMs,
        30_000,
      ),
    ).toBe(false);
    for (const healthStatus of ["unknown", "degraded", "unhealthy"] as const) {
      expect(
        isRunnerHealthyForAssignment(
          { healthStatus, lastHeartbeatAt: "2026-09-01T12:00:00.000Z" },
          nowMs,
          30_000,
        ),
      ).toBe(false);
    }
  });
});

describe("validation surfaces (fail-closed, neutral)", () => {
  const baseRegistration = {
    applicationId: "app-1",
    tenantId: "tenant-1",
    environmentId: "env-1",
    slug: "runner-1",
    name: "Runner 1",
    runnerVersion: "1.2.3",
    declaredCapabilities: ["customer-runner", "cpu", "memory"],
    registrationToken: "opaque-runner-token-0001",
    provenance: {
      actorId: "actor-1",
      cause: "runner-registration",
      channel: "runner-fleet",
      registeredAt: "2026-09-01T12:00:00Z",
    },
  };

  test("a well-formed registration validates", () => {
    expect(validateRunnerRegistration(baseRegistration).valid).toBe(true);
  });

  test("raw-secret-shaped registration tokens are rejected before anything durable", () => {
    const verdict = validateRunnerRegistration({
      ...baseRegistration,
      registrationToken: "sk-abcdefghijklmnopqrstuvwx",
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain("raw platform/provider secret");
  });

  test("short tokens, bad versions and unknown capabilities are rejected", () => {
    expect(
      validateRunnerRegistration({ ...baseRegistration, registrationToken: "short" }).valid,
    ).toBe(false);
    expect(validateRunnerRegistration({ ...baseRegistration, runnerVersion: "1.2" }).valid).toBe(
      false,
    );
    expect(
      validateRunnerRegistration({ ...baseRegistration, declaredCapabilities: ["host"] }).valid,
    ).toBe(false);
  });

  test("lease shape: duration bounds and expiry = leasedAt + duration", () => {
    const leasedAt = "2026-09-01T12:00:00.000Z";
    expect(
      validateRunnerLease({
        leasedAt,
        leaseExpiresAt: "2026-09-01T12:01:00.000Z",
        leaseDurationMs: 60_000,
      }).valid,
    ).toBe(true);
    expect(
      validateRunnerLease({
        leasedAt,
        leaseExpiresAt: "2026-09-01T12:02:00.000Z",
        leaseDurationMs: 60_000,
      }).valid,
    ).toBe(false);
    expect(
      validateRunnerLease({ leasedAt, leaseExpiresAt: "x", leaseDurationMs: 60_000 }).valid,
    ).toBe(false);
    expect(
      validateRunnerLease({
        leasedAt,
        leaseExpiresAt: "2026-09-02T12:00:00.000Z",
        leaseDurationMs: 86_400_000,
      }).valid,
    ).toBe(true);
    expect(
      validateRunnerLease({
        leasedAt,
        leaseExpiresAt: "2026-09-02T12:00:00.001Z",
        leaseDurationMs: 86_400_000,
      }).valid,
    ).toBe(false);
    expect(
      validateRunnerLease({
        leasedAt,
        leaseExpiresAt: "2026-09-01T12:00:01.001Z",
        leaseDurationMs: 86_400_001,
      }).valid,
    ).toBe(false);
  });

  test("result reports: sandbox-axis only, success/failure disjoint", () => {
    expect(
      validateRunnerResultReport({
        outcomeClass: "sandbox-success",
        outputDigest: "d",
        output: {},
        usageMicroUsd: "0",
        failure: null,
      }).valid,
    ).toBe(true);
    expect(
      validateRunnerResultReport({
        outcomeClass: "sandbox-success",
        outputDigest: null,
        output: null,
        usageMicroUsd: null,
        failure: { failureClass: "timeout", message: "x", retryable: true },
      }).valid,
    ).toBe(false);
    expect(
      validateRunnerResultReport({
        outcomeClass: "sandbox-failure",
        outputDigest: null,
        output: null,
        usageMicroUsd: null,
        failure: null,
      }).valid,
    ).toBe(false);
    // The type system refuses a non-sandbox outcome class; a value smuggled
    // past it (a hostile runner report) is still rejected at validation.
    expect(
      validateRunnerResultReport({
        outcomeClass: "PASS" as "sandbox-success",
        outputDigest: null,
        output: null,
        usageMicroUsd: null,
        failure: null,
      }).valid,
    ).toBe(false);
  });

  test("references are opaque: host-shaped paths are refused", () => {
    expect(validateRunnerReference("runner-endpoint-alpha").valid).toBe(true);
    expect(validateRunnerReference("/var/run/runner.sock").valid).toBe(false);
    expect(validateRunnerReference("~/.runner/config").valid).toBe(false);
    expect(validateRunnerReference("etc/passwd").valid).toBe(false);
  });
});

describe("idempotency fingerprints", () => {
  test("the assignment fingerprint is deterministic and request-shaped", () => {
    const request = {
      executionId: "exec-1",
      sandboxId: "sbx-1",
      environmentId: "env-1",
      requiredCapabilities: ["customer-runner", "cpu"],
    };
    const first = runnerAssignmentFingerprint("app-1", request);
    expect(runnerAssignmentFingerprint("app-1", request)).toBe(first);
    // capability order does not matter (canonical sort)
    expect(
      runnerAssignmentFingerprint("app-1", {
        ...request,
        requiredCapabilities: ["cpu", "customer-runner"],
      }),
    ).toBe(first);
    expect(runnerAssignmentFingerprint("app-2", request)).not.toBe(first);
    expect(runnerAssignmentFingerprint("app-1", { ...request, sandboxId: "sbx-2" })).not.toBe(
      first,
    );
  });

  test("the registration fingerprint is content-addressed over the identity core", () => {
    const input = {
      applicationId: "app-1",
      tenantId: "tenant-1",
      environmentId: "env-1",
      slug: "runner-1",
      name: "Runner",
      runnerVersion: "1.2.3",
      declaredCapabilities: ["cpu", "customer-runner"],
      provenance: {
        actorId: "actor",
        cause: "runner-registration",
        channel: "runner-fleet",
        registeredAt: "2026-09-01T12:00:00Z",
      },
    };
    const first = runnerRegistrationFingerprint(input, "fingerprint-1");
    expect(runnerRegistrationFingerprint(input, "fingerprint-1")).toBe(first);
    expect(runnerRegistrationFingerprint(input, "fingerprint-2")).not.toBe(first);
    expect(
      runnerRegistrationFingerprint({ ...input, runnerVersion: "1.2.4" }, "fingerprint-1"),
    ).not.toBe(first);
  });
});
