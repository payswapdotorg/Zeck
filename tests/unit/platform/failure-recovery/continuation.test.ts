/**
 * Continuation package unit suite (WORK-055): content-addressed
 * identity, the construct → validate → fingerprint → drift-reject →
 * resume round-trip, idempotent application (the bounded no-op), and
 * tamper detection.
 */

import { describe, expect, test } from "vitest";
import { FailureRecoveryError } from "../../../../src/platform/failure-recovery/catalog";
import {
  applyContinuationPackage,
  buildContinuationPackage,
  validateContinuationPackage,
} from "../../../../src/platform/failure-recovery/continuation";
import { fingerprintOf } from "../../../../src/platform/failure-recovery/fingerprint";
import {
  APPLICATION_ID,
  digest,
  EXECUTION_ID,
  governedIr,
  infraAttribution,
  OBSERVED_AT,
  TENANT_ID,
} from "./world";

function expectReject(invariant: string, fn: () => unknown): FailureRecoveryError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FailureRecoveryError);
    const typed = error as FailureRecoveryError;
    expect(typed.invariant).toBe(invariant);
    return typed;
  }
  throw new Error("expected a typed rejection");
}

function environment() {
  return fingerprintOf(
    [
      { kind: "model-route", provider: "rail-a", model: "model-x" },
      { kind: "substrate", substrateId: "mid-container-b", version: "2.0.0" },
      { kind: "configuration", name: "sandbox-profile", digest: digest.sha256Hex("cfg:1") },
    ],
    digest,
  );
}

function packageInput() {
  const ir = governedIr();
  return {
    applicationId: APPLICATION_ID,
    tenantId: TENANT_ID,
    executionId: EXECUTION_ID,
    planId: ir.planId,
    irId: ir.irId,
    steps: [
      { stepId: "fetch", status: "completed" as const },
      { stepId: "generate", status: "skipped" as const },
    ],
    environment: environment(),
    attribution: infraAttribution(),
    createdAt: OBSERVED_AT,
    digest,
  };
}

describe("continuation packages (WORK-055)", () => {
  test("construction is content-addressed, deterministic and round-trippable", () => {
    const first = buildContinuationPackage(packageInput());
    const second = buildContinuationPackage(packageInput());
    expect(first.packageId).toBe(second.packageId);
    expect(first.packageId).toMatch(/^[0-9a-f]{64}$/);
    const roundTripped = validateContinuationPackage(JSON.parse(JSON.stringify(first)), digest);
    expect(roundTripped.packageId).toBe(first.packageId);
    expect(roundTripped.packageDigest).toBe(first.packageDigest);
  });

  test("drifted content produces a different identity (content addressing)", () => {
    const base = buildContinuationPackage(packageInput());
    const drifted = buildContinuationPackage({
      ...packageInput(),
      steps: [
        { stepId: "fetch", status: "completed" },
        { stepId: "generate", status: "completed" },
      ],
    });
    expect(drifted.packageId).not.toBe(base.packageId);
  });

  test("the resume round-trip: construct → apply under the matching environment → resume directive", () => {
    const pkg = buildContinuationPackage(packageInput());
    const directive = applyContinuationPackage(pkg, environment(), digest);
    expect(directive.packageId).toBe(pkg.packageId);
    expect(directive.planId).toBe(pkg.planId);
    expect(directive.irId).toBe(pkg.irId);
    expect(directive.completedStepIds).toEqual(["fetch"]);
    expect(directive.skippedStepIds).toEqual(["generate"]);
    expect(directive.environmentFingerprintId).toBe(environment().fingerprintId);
    // A serialized round-trip resumes identically (durable-resume shape).
    const durablePkg = JSON.parse(JSON.stringify(pkg));
    const durableDirective = applyContinuationPackage(
      validateContinuationPackage(durablePkg, digest),
      environment(),
      digest,
    );
    expect(JSON.stringify(durableDirective)).toBe(JSON.stringify(directive));
  });

  test("environment drift is FAIL-CLOSED: a changed environment never resumes", () => {
    const pkg = buildContinuationPackage(packageInput());
    const driftedEnvironment = fingerprintOf(
      [
        { kind: "model-route", provider: "rail-a", model: "model-y" },
        { kind: "substrate", substrateId: "mid-container-b", version: "2.0.0" },
        { kind: "configuration", name: "sandbox-profile", digest: digest.sha256Hex("cfg:1") },
      ],
      digest,
    );
    const error = expectReject("continuation-drift", () =>
      applyContinuationPackage(pkg, driftedEnvironment, digest),
    );
    expect(error.details.firstDrift).toContain("model-route:rail-a/model-x");
  });

  test("an added environment entry is drift too (fail-closed, never silent)", () => {
    const pkg = buildContinuationPackage(packageInput());
    const added = fingerprintOf(
      [
        { kind: "model-route", provider: "rail-a", model: "model-x" },
        { kind: "substrate", substrateId: "mid-container-b", version: "2.0.0" },
        { kind: "configuration", name: "sandbox-profile", digest: digest.sha256Hex("cfg:1") },
        { kind: "tool", toolId: "document-retrieval", version: "1.4.0" },
      ],
      digest,
    );
    expectReject("continuation-drift", () => applyContinuationPackage(pkg, added, digest));
  });

  test("applying twice is a bounded no-op: identical directives, no state", () => {
    const pkg = buildContinuationPackage(packageInput());
    const first = applyContinuationPackage(pkg, environment(), digest);
    const second = applyContinuationPackage(pkg, environment(), digest);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // The package itself is untouched (pure application — data, never
    // an engine: no mutation, no ledger, no lifecycle).
    expect(pkg.packageId).toBe(buildContinuationPackage(packageInput()).packageId);
  });

  test("tampered packages are rejected at read time (both digests)", () => {
    const pkg = buildContinuationPackage(packageInput());
    const tampered = JSON.parse(JSON.stringify(pkg));
    tampered.steps.push({ stepId: "verify", status: "completed" });
    expectReject("continuation-shape", () => validateContinuationPackage(tampered, digest));
    const forgedId = JSON.parse(JSON.stringify(pkg));
    forgedId.packageId = digest.sha256Hex("forged");
    expectReject("continuation-shape", () => validateContinuationPackage(forgedId, digest));
  });

  test("malformed inputs fail closed (identities, bounds, step discipline)", () => {
    expectReject("continuation-shape", () =>
      buildContinuationPackage({ ...packageInput(), applicationId: "not-a-uuid" }),
    );
    expectReject("continuation-shape", () =>
      buildContinuationPackage({ ...packageInput(), planId: "deadbeef" }),
    );
    expectReject("continuation-shape", () =>
      buildContinuationPackage({ ...packageInput(), steps: [] }),
    );
    expectReject("continuation-shape", () =>
      buildContinuationPackage({
        ...packageInput(),
        steps: [
          { stepId: "fetch", status: "completed" },
          { stepId: "fetch", status: "skipped" },
        ],
      }),
    );
    expectReject("continuation-shape", () =>
      buildContinuationPackage({
        ...packageInput(),
        steps: [{ stepId: "fetch", status: "RUNNING" as never }],
      }),
    );
  });

  test("the package carries the attribution that triggered it (provenance)", () => {
    const pkg = buildContinuationPackage(packageInput());
    expect(pkg.attribution?.attributionId).toBe(infraAttribution().attributionId);
    // Attribution-free continuation is representable (checkpoint
    // continuation, not failure-triggered).
    const withoutAttribution = buildContinuationPackage({
      ...packageInput(),
      attribution: undefined,
    });
    expect(withoutAttribution.attribution).toBeUndefined();
    expect(withoutAttribution.packageId).not.toBe(pkg.packageId);
  });
});
