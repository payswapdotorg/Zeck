/**
 * Unit: the verification result model invariants (WORK-013).
 *
 * The domain half of the VERIFICATION-SEPARATION contract: a result is
 * an immutable evidence record whose shape answers WHO/WHAT/WHEN/WHY/
 * WITH-WHICH-EVIDENCE — PASS without evidence (M4), PASS without
 * criteria binding (M21), results without evaluator identity/version
 * (M20), detached provenance (M24) and unknown status/target
 * vocabularies are all unrepresentable BEFORE the storage boundary.
 */

import { describe, expect, test } from "vitest";
import { deriveConclusion } from "../../../src/modules/verification/domain/conclusion";
import type { VerificationResultRecord } from "../../../src/modules/verification/domain/result";
import {
  EVALUATOR_KINDS,
  isVerificationStatus,
  isVerificationTargetKind,
  VERIFICATION_STATUSES,
  VERIFICATION_TARGET_KINDS,
  validateResult,
} from "../../../src/modules/verification/domain/result";

const baseResult = {
  id: "r1",
  applicationId: "app",
  tenantId: "tenant",
  executionId: "exec",
  target: { kind: "execution-output" as const, ref: "exec" },
  criterionId: "output-schema",
  criteriaVersion: 1,
  evaluator: { kind: "deterministic" as const, id: "schema-evaluator", version: "1" },
  status: "PASS" as const,
  observations: ["all fields present"],
  evidence: ["artifact:digest-1"],
  provenance: { evaluationId: "e1", actorId: "actor-1" },
  recordedBy: "deterministic:schema-evaluator@1",
};

describe("result validation", () => {
  test("accepts a well-formed PASS result", () => {
    expect(validateResult(baseResult).ok).toBe(true);
  });

  test("PASS without evidence is rejected (M4: no evidence, no PASS)", () => {
    const issues = validateResult({ ...baseResult, evidence: [] });
    expect(issues.ok).toBe(false);
    expect(issues.issues.join(" ")).toContain("PASS requires at least one evidence reference");
  });

  test("PASS without a criteria binding is rejected (M21)", () => {
    const issues = validateResult({ ...baseResult, criterionId: "" });
    expect(issues.ok).toBe(false);
    expect(issues.issues.join(" ")).toContain("criteria binding is mandatory");
  });

  test("an evaluator without version is rejected (M20)", () => {
    const issues = validateResult({
      ...baseResult,
      evaluator: { kind: "deterministic", id: "schema-evaluator", version: "" },
    });
    expect(issues.ok).toBe(false);
    expect(issues.issues.join(" ")).toContain("non-empty version");
  });

  test("a result detached from its evaluation provenance is rejected (M24)", () => {
    const issues = validateResult({
      ...baseResult,
      provenance: { evaluationId: "", actorId: "a" },
    });
    expect(issues.ok).toBe(false);
    expect(issues.issues.join(" ")).toContain("no detached results");
  });

  test("unknown status/target vocabularies are rejected", () => {
    expect(validateResult({ ...baseResult, status: "OK" }).ok).toBe(false);
    expect(validateResult({ ...baseResult, target: { kind: "vibes", ref: "x" } }).ok).toBe(false);
  });

  test("FAIL/INCONCLUSIVE may exist without evidence references (only PASS requires them)", () => {
    expect(validateResult({ ...baseResult, status: "FAIL", evidence: [] }).ok).toBe(true);
    expect(validateResult({ ...baseResult, status: "INCONCLUSIVE", evidence: [] }).ok).toBe(true);
  });

  test("confidence is bounded to [0,1]", () => {
    expect(validateResult({ ...baseResult, confidence: 1.5 }).ok).toBe(false);
    expect(validateResult({ ...baseResult, confidence: -0.1 }).ok).toBe(false);
    expect(validateResult({ ...baseResult, confidence: 0.9 }).ok).toBe(true);
  });

  test("the vocabularies are exactly the frozen ones", () => {
    expect(VERIFICATION_STATUSES).toEqual(["PASS", "FAIL", "INCONCLUSIVE"]);
    expect(EVALUATOR_KINDS).toEqual(["deterministic", "model", "human"]);
    expect(VERIFICATION_TARGET_KINDS).toContain("plan-revision");
    expect(VERIFICATION_TARGET_KINDS).toContain("artifact");
    expect(VERIFICATION_TARGET_KINDS).toContain("candidate");
    expect(isVerificationStatus("PASS")).toBe(true);
    expect(isVerificationTargetKind("artifact")).toBe(true);
  });
});

function result(overrides: Partial<VerificationResultRecord>): VerificationResultRecord {
  return { ...baseResult, ...overrides } as VerificationResultRecord;
}

describe("conclusion derivation", () => {
  const criteria = [
    { criterionId: "a", version: 1, required: true },
    { criterionId: "b", version: 1, required: true },
    { criterionId: "c", version: 1, required: false },
  ];

  test("all required criteria PASS ⇒ criteriaMet", () => {
    const derived = deriveConclusion({
      criteria,
      results: [
        result({ criterionId: "a", status: "PASS" }),
        result({ criterionId: "b", status: "PASS" }),
        result({ criterionId: "c", status: "INCONCLUSIVE" }),
      ],
    });
    expect(derived.criteriaMet).toBe(true);
    expect(derived.requiredUnmet).toEqual([]);
  });

  test("a required INCONCLUSIVE is unmet — never acceptance (M5/M22)", () => {
    const derived = deriveConclusion({
      criteria,
      results: [
        result({ criterionId: "a", status: "PASS" }),
        result({ criterionId: "b", status: "INCONCLUSIVE" }),
      ],
    });
    expect(derived.criteriaMet).toBe(false);
    expect(derived.requiredUnmet.map((entry) => entry.criterionId)).toEqual(["b"]);
    expect(derived.requiredUnmet[0]?.status).toBe("INCONCLUSIVE");
  });

  test("a required FAIL is unmet and surfaces with its status (M6)", () => {
    const derived = deriveConclusion({
      criteria,
      results: [
        result({ criterionId: "a", status: "PASS" }),
        result({ criterionId: "b", status: "FAIL" }),
      ],
    });
    expect(derived.criteriaMet).toBe(false);
    expect(derived.requiredUnmet[0]?.status).toBe("FAIL");
  });

  test("a missing required criterion is unmet INCONCLUSIVE", () => {
    const derived = deriveConclusion({
      criteria,
      results: [result({ criterionId: "a", status: "PASS" })],
    });
    expect(derived.criteriaMet).toBe(false);
    expect(derived.requiredUnmet[0]?.status).toBe("INCONCLUSIVE");
  });

  test("a stale PASS for an older target revision does not satisfy the current one (M12)", () => {
    const derived = deriveConclusion({
      criteria: [{ criterionId: "a", version: 1, required: true }],
      targetRevision: "plan-v2",
      results: [
        result({
          criterionId: "a",
          status: "PASS",
          target: { kind: "plan-revision", ref: "plan-1", revision: "plan-v1" },
        }),
      ],
    });
    expect(derived.criteriaMet).toBe(false);
    expect(derived.requiredUnmet[0]?.reason).toContain("revision");
  });

  test("the LATEST result per criterion is decisive (re-verification supersedes)", () => {
    const derived = deriveConclusion({
      criteria: [{ criterionId: "a", version: 1, required: true }],
      results: [
        result({ criterionId: "a", status: "PASS" }),
        result({ criterionId: "a", status: "FAIL" }),
      ],
    });
    expect(derived.criteriaMet).toBe(false);
    expect(derived.requiredUnmet[0]?.status).toBe("FAIL");
  });

  test("optional criteria never gate", () => {
    const derived = deriveConclusion({
      criteria,
      results: [
        result({ criterionId: "a", status: "PASS" }),
        result({ criterionId: "b", status: "PASS" }),
      ],
    });
    expect(derived.criteriaMet).toBe(true);
  });
});
