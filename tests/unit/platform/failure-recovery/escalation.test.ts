/**
 * Fresh escalation package unit suite (WORK-055): bounded, typed
 * packages carrying the attributed failure + accumulated evidence +
 * continuation payload; content-addressed identity; the
 * escalation-requires-justification discipline; read-time tamper
 * detection.
 */

import { describe, expect, test } from "vitest";
import { FailureRecoveryError } from "../../../../src/platform/failure-recovery/catalog";
import { buildContinuationPackage } from "../../../../src/platform/failure-recovery/continuation";
import {
  buildEscalationPackage,
  validateEscalationPackage,
} from "../../../../src/platform/failure-recovery/escalation";
import { fingerprintOf } from "../../../../src/platform/failure-recovery/fingerprint";
import { selectRecoveryStrategy } from "../../../../src/platform/failure-recovery/strategy";
import {
  APPLICATION_ID,
  claim,
  constraints,
  digest,
  EXECUTION_ID,
  freshEscalationDecision,
  governedIr,
  infraAttribution,
  intelligenceAttribution,
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

function continuation() {
  const ir = governedIr();
  return buildContinuationPackage({
    applicationId: APPLICATION_ID,
    tenantId: TENANT_ID,
    executionId: EXECUTION_ID,
    planId: ir.planId,
    irId: ir.irId,
    steps: [
      { stepId: "fetch", status: "completed" },
      { stepId: "generate", status: "skipped" },
    ],
    environment: fingerprintOf(
      [
        { kind: "model-route", provider: "rail-a", model: "model-x" },
        { kind: "configuration", name: "sandbox-profile", digest: digest.sha256Hex("cfg:1") },
      ],
      digest,
    ),
    attribution: intelligenceAttribution(),
    createdAt: OBSERVED_AT,
    digest,
  });
}

/** A selection whose outcome is the selected escalate-fresh verdict. */
function escalateSelection() {
  return selectRecoveryStrategy({
    attribution: intelligenceAttribution(),
    context: { attemptsUsed: 1, incumbentRoute: { provider: "rail-a", model: "model-x" } },
    facts: {
      retry: null,
      reroute: { model: null, substrate: null },
      escalation: {
        decision: freshEscalationDecision(true),
        claim: claim("600", 5200, 0.92, 0.94, "recovery:fresh-context-path"),
      },
    },
    qualityFacts: { requiredQuality: 0.85 },
    constraints: constraints(),
    configuration: { maxRetryAttempts: 3, escalationEvidenceBound: 8, continuationStepBound: 32 },
    digest,
  });
}

function escalationInput() {
  return {
    applicationId: APPLICATION_ID,
    tenantId: TENANT_ID,
    executionId: EXECUTION_ID,
    failure: intelligenceAttribution(),
    evidence: [
      { kind: "decision-record" as const, decisionId: digest.sha256Hex("decision:1") },
      { kind: "observation" as const, observationDigest: digest.sha256Hex("observation:1") },
    ],
    strategy: escalateSelection().selected as never,
    continuation: continuation(),
    evidenceBound: 8,
    createdAt: OBSERVED_AT,
    digest,
  };
}

describe("fresh escalation packages (WORK-055)", () => {
  test("construction is content-addressed, deterministic and round-trippable", () => {
    const first = buildEscalationPackage(escalationInput());
    const second = buildEscalationPackage(escalationInput());
    expect(first.escalationId).toBe(second.escalationId);
    expect(first.escalationId).toMatch(/^[0-9a-f]{64}$/);
    const roundTripped = validateEscalationPackage(JSON.parse(JSON.stringify(first)), digest);
    expect(roundTripped.escalationId).toBe(first.escalationId);
    // The package carries the three required contents.
    expect(first.failure.failureClass).toBe("intelligence");
    expect(first.evidence).toHaveLength(2);
    expect(first.continuation.packageId).toBe(continuation().packageId);
  });

  test("escalation REQUIRES the selected escalate-fresh strategy verdict (never self-authorizing)", () => {
    const selection = escalateSelection();
    expect(selection.selected?.strategy).toBe("escalate-fresh");
    const selected = selection.selected;
    if (selected === null) {
      throw new Error("fixture broken: no selected escalate-fresh verdict");
    }
    // An inadmissible verdict cannot carry an escalation package.
    expectReject("escalation-shape", () =>
      buildEscalationPackage({
        ...escalationInput(),
        strategy: { ...selected, admissible: false } as never,
      }),
    );
    // A retry verdict cannot carry an escalation package.
    expectReject("escalation-shape", () =>
      buildEscalationPackage({
        ...escalationInput(),
        strategy: { ...selected, strategy: "retry" } as never,
      }),
    );
  });

  test("escalation requires the ATTRIBUTED failure (no attribution → no escalation)", () => {
    // A class-forged failure is rejected by the ATTRIBUTION discipline
    // itself — the deeper invariant fires first (fail closed).
    expectReject("attribution-cross-classified", () =>
      buildEscalationPackage({
        ...escalationInput(),
        failure: { ...intelligenceAttribution(), failureClass: "infrastructure" } as never,
      }),
    );
    expectReject("attribution-shape", () =>
      buildEscalationPackage({ ...escalationInput(), failure: { bogus: true } as never }),
    );
  });

  test("the evidence set is bounded by the explicit configuration input", () => {
    expectReject("escalation-shape", () =>
      buildEscalationPackage({
        ...escalationInput(),
        evidence: [
          ...escalationInput().evidence,
          { kind: "decision-record", decisionId: digest.sha256Hex("d:2") },
        ],
        evidenceBound: 2,
      }),
    );
    // Duplicates are rejected (bounded honest evidence).
    expectReject("escalation-shape", () =>
      buildEscalationPackage({
        ...escalationInput(),
        evidence: [
          { kind: "decision-record", decisionId: digest.sha256Hex("decision:1") },
          { kind: "decision-record", decisionId: digest.sha256Hex("decision:1") },
        ],
      }),
    );
  });

  test("malformed evidence references are rejected (typed, content-addressed only)", () => {
    expectReject("escalation-shape", () =>
      buildEscalationPackage({
        ...escalationInput(),
        evidence: [{ kind: "decision-record", decisionId: "not-a-digest" } as never],
      }),
    );
    expectReject("escalation-shape", () =>
      buildEscalationPackage({ ...escalationInput(), evidence: [] }),
    );
  });

  test("tampered packages are rejected at read time", () => {
    const pkg = buildEscalationPackage(escalationInput());
    const tampered = JSON.parse(JSON.stringify(pkg));
    tampered.failure.observation.detail = "tampered";
    // The embedded attribution's identity no longer digests — the
    // attribution discipline fires inside the escalation validation.
    expectReject("attribution-shape", () => validateEscalationPackage(tampered, digest));
    const forged = JSON.parse(JSON.stringify(pkg));
    forged.escalationId = digest.sha256Hex("forged");
    expectReject("escalation-shape", () => validateEscalationPackage(forged, digest));
    const mutatedEvidence = JSON.parse(JSON.stringify(pkg));
    mutatedEvidence.evidence.push({ kind: "decision-record", decisionId: digest.sha256Hex("d:x") });
    expectReject("escalation-shape", () => validateEscalationPackage(mutatedEvidence, digest));
  });

  test("the escalation payload is DATA: identical inputs rebuild byte-identically", () => {
    const first = JSON.stringify(buildEscalationPackage(escalationInput()));
    const second = JSON.stringify(buildEscalationPackage(escalationInput()));
    expect(first).toBe(second);
  });

  test("the attribution-strategy coherence holds end-to-end: a verdict from another failure cannot justify escalation", () => {
    // The escalate-fresh verdict was decided under the INTELLIGENCE
    // attribution; an infrastructure failure riding it is a provenance
    // mismatch — the incoherent package is unrepresentable.
    const verdict = escalateSelection().selected;
    if (verdict === null) {
      throw new Error("fixture broken: no selected escalate-fresh verdict");
    }
    const error = expectReject("escalation-shape", () =>
      buildEscalationPackage({
        ...escalationInput(),
        failure: infraAttribution(),
        strategy: { ...verdict } as never,
      }),
    );
    expect(error.details.strategyAttributionId).toBeDefined();
  });
});
