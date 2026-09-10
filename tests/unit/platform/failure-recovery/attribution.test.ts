/**
 * Failure attribution unit suite (WORK-055): the closed five-class
 * taxonomy, the signal→class admissibility discipline, evidence-class
 * coherence, content-addressed identity determinism, and total
 * round-trip validation.
 */

import { describe, expect, test } from "vitest";
import {
  attributeFailure,
  validateFailureAttribution,
  validateFailureObservation,
} from "../../../../src/platform/failure-recovery/attribution";
import { FailureRecoveryError } from "../../../../src/platform/failure-recovery/catalog";
import {
  digest,
  infraAttribution,
  infraObservation,
  intelligenceAttribution,
  providerAttribution,
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

describe("failure attribution (WORK-055)", () => {
  test("the five failure classes are closed and typed", async () => {
    const { FAILURE_CLASSES, FAILURE_SIGNALS, SIGNAL_CLASS_ADMISSIBILITY } = await import(
      "../../../../src/platform/failure-recovery/catalog"
    );
    expect([...FAILURE_CLASSES]).toEqual([
      "infrastructure",
      "provider",
      "tool",
      "resource",
      "intelligence",
    ]);
    // Every signal maps to a non-empty admissible-class subset of the
    // closed five (the table is total over the closed vocabulary).
    expect(
      FAILURE_SIGNALS.every((signal) => {
        const admissible = SIGNAL_CLASS_ADMISSIBILITY[signal];
        return admissible.length > 0 && admissible.every((c) => FAILURE_CLASSES.includes(c));
      }),
    ).toBe(true);
  });

  test("a coherent infrastructure attribution is content-addressed and deterministic", () => {
    const first = infraAttribution();
    const second = infraAttribution();
    expect(first.attributionId).toBe(second.attributionId);
    expect(first.failureClass).toBe("infrastructure");
    expect(first.evidence.kind).toBe("infrastructure");
    expect(first.attributionId).toMatch(/^[0-9a-f]{64}$/);
    // Different evidence → different identity (content addressing).
    const other = attributeFailure(
      { ...infraObservation(), observationDigest: digest.sha256Hex("other") },
      "infrastructure",
      { kind: "infrastructure", transient: true },
      digest,
    );
    expect(other.attributionId).not.toBe(first.attributionId);
  });

  test("every class's coherent evidence constructs and round-trips", () => {
    for (const attribution of [
      infraAttribution(),
      intelligenceAttribution(),
      providerAttribution(),
      attributeFailure(
        {
          signal: "tool-invocation-error",
          component: "tool-executor",
          stepId: "fetch",
          detail: "the tool invocation errored",
          observedAt: "2026-09-23T08:59:00.000Z",
          observationDigest: digest.sha256Hex("observation:tool-invocation-error"),
        },
        "tool",
        { kind: "tool", toolErrorCode: "tool-timeout" },
        digest,
      ),
      attributeFailure(
        {
          signal: "resource-exhausted",
          component: "budget-authority",
          detail: "quota reached",
          observedAt: "2026-09-23T08:59:00.000Z",
          observationDigest: digest.sha256Hex("observation:resource-exhausted:quota"),
        },
        "resource",
        { kind: "resource", resourceKind: "quota" },
        digest,
      ),
    ]) {
      const roundTripped = validateFailureAttribution(
        JSON.parse(JSON.stringify(attribution)),
        digest,
      );
      expect(roundTripped.attributionId).toBe(attribution.attributionId);
    }
  });

  test("cross-classification is rejected: an infrastructure signal cannot become intelligence", () => {
    const error = expectReject("attribution-cross-classified", () =>
      attributeFailure(
        infraObservation(),
        "intelligence",
        {
          kind: "intelligence",
          observedQuality: 0.4,
        },
        digest,
      ),
    );
    expect(error.details.admissibleClasses).toBe("infrastructure");
  });

  test("cross-classification is rejected: evidence kind must match the claimed class", () => {
    expectReject("attribution-cross-classified", () =>
      attributeFailure(
        infraObservation(),
        "infrastructure",
        {
          kind: "provider",
          providerErrorClass: "server-error",
        },
        digest,
      ),
    );
  });

  test("provider evidence coherence with the signal is enforced", () => {
    expectReject("attribution-cross-classified", () =>
      attributeFailure(
        {
          signal: "provider-rate-limited",
          component: "provider-gateway",
          detail: "rate limited",
          observedAt: "2026-09-23T08:59:00.000Z",
          observationDigest: digest.sha256Hex("observation:provider-rate-limited"),
        },
        "provider",
        { kind: "provider", providerErrorClass: "server-error" },
        digest,
      ),
    );
  });

  test("unattributed inputs are rejected (no class, no evidence, malformed evidence)", () => {
    expectReject("attribution-unattributed", () =>
      attributeFailure(infraObservation(), "infrastructure", undefined as never, digest),
    );
    expectReject("attribution-unattributed", () =>
      attributeFailure(
        {
          signal: "tool-rejected",
          component: "tool-executor",
          detail: "rejected",
          observedAt: "2026-09-23T08:59:00.000Z",
          observationDigest: digest.sha256Hex("observation:tool-rejected"),
        },
        "tool",
        { kind: "tool", toolErrorCode: "NOT_A_SLUG!" },
        digest,
      ),
    );
    expectReject("attribution-unattributed", () =>
      attributeFailure(
        {
          signal: "quality-below-expectation",
          component: "verification-authority",
          detail: "quality below floor",
          observedAt: "2026-09-23T08:59:00.000Z",
          observationDigest: digest.sha256Hex("observation:quality-below"),
        },
        "intelligence",
        { kind: "intelligence", observedQuality: 1.5 },
        digest,
      ),
    );
  });

  test("observations outside the closed signal vocabulary are rejected", () => {
    expectReject("observation-shape", () =>
      validateFailureObservation({ ...infraObservation(), signal: " vibes-bad" }),
    );
    expectReject("observation-shape", () =>
      validateFailureObservation({ ...infraObservation(), component: "NOT A SLUG" }),
    );
    expectReject("observation-shape", () =>
      validateFailureObservation({ ...infraObservation(), observationDigest: "deadbeef" }),
    );
    expectReject("observation-shape", () =>
      validateFailureObservation({ ...infraObservation(), detail: "x".repeat(501) }),
    );
  });

  test("read-time validation rejects tampered identities", () => {
    const attribution = infraAttribution();
    const tampered = {
      ...JSON.parse(JSON.stringify(attribution)),
      observation: { ...JSON.parse(JSON.stringify(attribution.observation)), detail: "tampered" },
    };
    expectReject("attribution-shape", () => validateFailureAttribution(tampered, digest));
  });

  test("attribution determinism: input order of observation fields is identity-irrelevant", () => {
    const observation = infraObservation();
    const reordered = {
      observedAt: observation.observedAt,
      observationDigest: observation.observationDigest,
      detail: observation.detail,
      routeRef: observation.routeRef,
      stepId: observation.stepId,
      component: observation.component,
      signal: observation.signal,
    };
    const first = attributeFailure(
      observation,
      "infrastructure",
      { kind: "infrastructure", transient: true },
      digest,
    );
    const second = attributeFailure(
      reordered,
      "infrastructure",
      { kind: "infrastructure", transient: true },
      digest,
    );
    expect(first.attributionId).toBe(second.attributionId);
  });
});
