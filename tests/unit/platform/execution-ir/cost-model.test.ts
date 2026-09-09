/**
 * Expected successful-resolution cost model unit tests (WORK-049).
 *
 * Proves: bounded attributed claims (unbounded / unattributed /
 * zero-reliability rejections), the ceil(expectedCost / reliability)
 * computation, quality-preserving economics (a cheaper candidate below
 * the threshold is INVALID), and the deterministic selection basis
 * (cost ordering, representation-ladder tie-breaks, candidate-id
 * tie-breaks).
 */

import { describe, expect, test } from "vitest";
import {
  COST_BASES,
  CostModelError,
  evaluateCandidate,
  MAX_IR_COST_MICRO_USD,
  REPRESENTATION_CLASSES,
  representationLadderRank,
  selectCandidate,
  validateCandidateRepresentation,
  validateCostClaim,
} from "../../../../src/platform/execution-ir/cost-model";

function claim(overrides: Record<string, unknown> = {}) {
  return {
    expectedCostMicroUsd: "100000",
    expectedLatencyMs: 2000,
    expectedQuality: 0.92,
    expectedReliability: 0.8,
    basis: { basis: "estimated" as const, source: "planning.route-table" },
    ...overrides,
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: "candidate-a",
    representationClass: "sufficient-model" as const,
    claim: claim(),
    ...overrides,
  };
}

describe("cost model (WORK-049)", () => {
  test("the neutral representation ladder vocabulary", () => {
    expect([...REPRESENTATION_CLASSES]).toEqual([
      "deterministic-computation",
      "cache-reuse",
      "verified-competence",
      "programmatic-execution",
      "sufficient-model",
      "stronger-model",
      "parallel-multi-agent",
      "computer-use",
      "human-escalation",
    ]);
    expect(representationLadderRank("deterministic-computation")).toBe(0);
    expect(representationLadderRank("human-escalation")).toBe(8);
    expect([...COST_BASES]).toEqual(["observed", "estimated", "defaulted"]);
  });

  test("valid claims round-trip validation", () => {
    const validated = validateCostClaim(claim());
    expect(validated.expectedCostMicroUsd).toBe("100000");
    expect(validated.basis.basis).toBe("estimated");
    expect(
      validateCandidateRepresentation({ ...candidate(), variantIrId: "a".repeat(64) }).variantIrId,
    ).toBe("a".repeat(64));
  });

  test("unattributed claims are rejected", () => {
    expect(() => validateCostClaim(claim({ basis: undefined }))).toThrow(CostModelError);
    try {
      validateCostClaim(claim({ basis: undefined }));
    } catch (error) {
      expect((error as CostModelError).invariant).toBe("unattributed-cost");
    }
    expect(() =>
      validateCostClaim(claim({ basis: { basis: "guessed", source: "someone" } })),
    ).toThrow(CostModelError);
    expect(() => validateCostClaim(claim({ basis: { basis: "estimated", source: "" } }))).toThrow(
      CostModelError,
    );
  });

  test("unbounded claims are rejected", () => {
    expect(() => validateCostClaim(claim({ expectedCostMicroUsd: "-1" }))).toThrow(CostModelError);
    expect(() => validateCostClaim(claim({ expectedCostMicroUsd: "1.5" }))).toThrow(CostModelError);
    expect(() => validateCostClaim(claim({ expectedCostMicroUsd: "1000000000000000000" }))).toThrow(
      CostModelError,
    );
    expect(() =>
      validateCostClaim(claim({ expectedCostMicroUsd: Number.MAX_SAFE_INTEGER })),
    ).toThrow(CostModelError);
    expect(() => validateCostClaim(claim({ expectedLatencyMs: Number.NaN }))).toThrow(
      CostModelError,
    );
    expect(() => validateCostClaim(claim({ expectedLatencyMs: Number.POSITIVE_INFINITY }))).toThrow(
      CostModelError,
    );
    expect(() => validateCostClaim(claim({ expectedQuality: 1.5 }))).toThrow(CostModelError);
  });

  test("zero-reliability claims are rejected (unbounded successful-resolution cost)", () => {
    expect(() => validateCostClaim(claim({ expectedReliability: 0 }))).toThrow(CostModelError);
    try {
      validateCostClaim(claim({ expectedReliability: 0 }));
    } catch (error) {
      expect((error as CostModelError).invariant).toBe("unreliable-representation");
    }
  });

  test("expected successful-resolution cost = ceil(cost / reliability), bounded", () => {
    // 100000 / 0.8 = 125000 exactly.
    const exact = evaluateCandidate(candidate(), 0.9);
    expect(exact.expectedSuccessfulResolutionCostMicroUsd).toBe("125000");
    // 100001 / 0.8 = 125001.25 -> ceil 125002.
    const ceiled = evaluateCandidate(
      candidate({ claim: claim({ expectedCostMicroUsd: "100001" }) }),
      0.9,
    );
    expect(ceiled.expectedSuccessfulResolutionCostMicroUsd).toBe("125002");
    // reliability 1 -> identity.
    const identity = evaluateCandidate(
      candidate({ claim: claim({ expectedReliability: 1 }) }),
      0.9,
    );
    expect(identity.expectedSuccessfulResolutionCostMicroUsd).toBe("100000");
    // Overflow past the bounded universe is a typed rejection.
    expect(() =>
      evaluateCandidate(
        candidate({
          claim: claim({
            expectedCostMicroUsd: MAX_IR_COST_MICRO_USD,
            expectedReliability: 0.5,
          }),
        }),
        0.9,
      ),
    ).toThrow(CostModelError);
  });

  test("quality-preserving economics: a candidate below the threshold is INVALID", () => {
    const below = evaluateCandidate(candidate(), 0.95);
    expect(below.valid).toBe(false);
    expect(below.inadmissibleReason).toBe("quality-below-threshold");
    expect(below.qualityExpectation).toMatchObject({
      expectedQuality: 0.92,
      threshold: 0.95,
      meetsThreshold: false,
    });
    const at = evaluateCandidate(candidate(), 0.92);
    expect(at.valid).toBe(true);
  });

  test("deterministic selection: lowest expected successful-resolution cost wins", () => {
    const selection = selectCandidate(
      [
        // Expensive model, high reliability.
        candidate({
          candidateId: "strong-model",
          representationClass: "stronger-model",
          claim: claim({ expectedCostMicroUsd: "900000", expectedReliability: 0.99 }),
        }),
        // Cheap sufficient model, lower reliability: 100000/0.8=125000.
        candidate({
          candidateId: "cheap-model",
          representationClass: "sufficient-model",
        }),
        // Deterministic program: 20000/1=20000 — cheapest.
        candidate({
          candidateId: "deterministic-run",
          representationClass: "deterministic-computation",
          claim: claim({
            expectedCostMicroUsd: "20000",
            expectedLatencyMs: 200,
            expectedReliability: 1,
          }),
        }),
      ],
      0.9,
    );
    expect(selection.kind).toBe("selected");
    expect(selection.selected?.candidateId).toBe("deterministic-run");
    expect(selection.evaluations.map((evaluation) => evaluation.candidateId)).toEqual([
      "deterministic-run",
      "cheap-model",
      "strong-model",
    ]);
    expect(selection.selectionBasis).toContain("lowest-expected-successful-resolution-cost");
  });

  test("quality-preserving selection: the cheaper-but-insufficient candidate can never win", () => {
    const selection = selectCandidate(
      [
        // Cheaper but BELOW the threshold: invalid regardless of price.
        candidate({
          candidateId: "cheap-below-threshold",
          representationClass: "deterministic-computation",
          claim: claim({ expectedCostMicroUsd: "1000", expectedQuality: 0.5 }),
        }),
        // More expensive but sufficient: must win.
        candidate({
          candidateId: "sufficient-model",
          representationClass: "sufficient-model",
          claim: claim({ expectedCostMicroUsd: "500000", expectedQuality: 0.95 }),
        }),
      ],
      0.9,
    );
    expect(selection.selected?.candidateId).toBe("sufficient-model");
    const invalid = selection.evaluations.find(
      (evaluation) => evaluation.candidateId === "cheap-below-threshold",
    );
    expect(invalid?.valid).toBe(false);
    expect(invalid?.inadmissibleReason).toBe("quality-below-threshold");
  });

  test("ties break on the representation ladder, then candidate id", () => {
    const selection = selectCandidate(
      [
        // Same expected successful-resolution cost (100000):
        candidate({
          candidateId: "zzz-model",
          representationClass: "sufficient-model",
          claim: claim({ expectedReliability: 1 }),
        }),
        candidate({
          candidateId: "aaa-cache",
          representationClass: "cache-reuse",
          claim: claim({ expectedReliability: 1 }),
        }),
        candidate({
          candidateId: "bbb-cache",
          representationClass: "cache-reuse",
          claim: claim({ expectedReliability: 1 }),
        }),
      ],
      0.9,
    );
    // cache-reuse (ladder rank 1) beats sufficient-model (rank 4);
    // within the tie, candidate id orders aaa before bbb.
    expect(selection.evaluations.map((evaluation) => evaluation.candidateId)).toEqual([
      "aaa-cache",
      "bbb-cache",
      "zzz-model",
    ]);
  });

  test("no admissible candidate is a typed outcome; duplicate ids are rejected", () => {
    const selection = selectCandidate([candidate({ claim: claim({ expectedQuality: 0.1 }) })], 0.9);
    expect(selection.kind).toBe("no-admissible-candidate");
    expect(selection.selected).toBeNull();
    expect(() =>
      selectCandidate([candidate(), candidate({ candidateId: "candidate-a" })], 0.9),
    ).toThrow(CostModelError);
  });
});
