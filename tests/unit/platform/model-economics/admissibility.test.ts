/**
 * Admissibility core unit tests (WORK-053): the constraint-conditioned
 * governing facts (the assurance/hard floor split, soft constraints
 * recorded never enforced), the per-candidate typed verdicts (every
 * inadmissible code), the deterministic comparison order (cost,
 * ladder, candidateId) and the closed fail-closed rules.
 */

import { describe, expect, test } from "vitest";
import type { OptimizationConstraint } from "../../../../src/platform/execution-ir/constraints";
import type { CandidateRepresentation } from "../../../../src/platform/execution-ir/cost-model";
import {
  compareAdmissible,
  evaluateAdmissibility,
  governingFacts,
  orderVerdicts,
  rejectDuplicateIds,
} from "../../../../src/platform/model-economics/admissibility";
import type { QualityFacts } from "../../../../src/platform/model-economics/vocabulary";
import { ModelEconomicsError } from "../../../../src/platform/model-economics/vocabulary";
import { claim } from "./world";

const QUALITY: QualityFacts = { requiredQuality: 0.9 };

function softQualityConstraint(minQuality: number): OptimizationConstraint {
  return {
    constraintId: "soft-quality",
    kind: "quality",
    enforcement: "soft",
    source: { authority: "planning" },
    payload: { minQuality },
  };
}

function hardQualityConstraint(minQuality: number): OptimizationConstraint {
  return {
    constraintId: "hard-quality",
    kind: "quality",
    enforcement: "hard",
    source: { authority: "policy", policySetId: "ps-1" },
    payload: { minQuality },
  };
}

function candidate(
  candidateId: string,
  quality: number,
  cost = "1000",
  reliability = 0.9,
  latency = 2000,
  representationClass: CandidateRepresentation["representationClass"] = "sufficient-model",
): CandidateRepresentation {
  return {
    candidateId,
    representationClass,
    claim: claim({ cost, latency, quality, reliability }),
  };
}

describe("the governing facts (constraint-conditioned, deterministic)", () => {
  test("the effective floor is the assurance threshold alone when no hard quality constraint exists", () => {
    const facts = governingFacts(QUALITY, [
      {
        constraintId: "verification-anchor",
        kind: "verification",
        enforcement: "hard",
        source: { authority: "verification" },
        payload: { requiresVerificationAnchor: true },
      },
    ]);
    expect(facts.qualityFloor).toBe(0.9);
    expect(facts.assuranceThreshold).toBe(0.9);
    expect(facts.hardQualityFloor).toBe(0);
  });

  test("a hard quality constraint RAISES the floor; the hard floor is tracked separately", () => {
    const facts = governingFacts(QUALITY, [hardQualityConstraint(0.85)]);
    expect(facts.qualityFloor).toBe(0.9);
    expect(facts.hardQualityFloor).toBe(0.85);
    expect(facts.assuranceThreshold).toBe(0.9);

    const raised = governingFacts({ requiredQuality: 0.8 }, [hardQualityConstraint(0.95)]);
    expect(raised.qualityFloor).toBe(0.95);
    expect(raised.hardQualityFloor).toBe(0.95);
    expect(raised.assuranceThreshold).toBe(0.8);
  });

  test("soft quality constraints are recorded, never enforced (no floor contribution)", () => {
    const facts = governingFacts(QUALITY, [softQualityConstraint(0.99)]);
    expect(facts.qualityFloor).toBe(0.9);
    expect(facts.hardQualityFloor).toBe(0);
  });

  test("budget, latency and reliability floors come from hard constraints only", () => {
    const facts = governingFacts(QUALITY, [
      {
        constraintId: "budget-1",
        kind: "budget",
        enforcement: "hard",
        source: { authority: "budget", budgetId: "b-1", scopeKind: "monthly" },
        payload: { maxCostMicroUsd: "500000" },
      },
      {
        constraintId: "budget-2",
        kind: "budget",
        enforcement: "hard",
        source: { authority: "budget", budgetId: "b-2", scopeKind: "per-execution" },
        payload: { maxCostMicroUsd: "900000" },
      },
      {
        constraintId: "latency-1",
        kind: "latency",
        enforcement: "hard",
        source: { authority: "policy", policySetId: "ps-1" },
        payload: { maxLatencyMs: 4000 },
      },
      {
        constraintId: "reliability-1",
        kind: "quality",
        enforcement: "hard",
        source: { authority: "policy", policySetId: "ps-1" },
        payload: { minReliability: 0.95 },
      },
    ]);
    expect(facts.budgetCeilingsMicroUsd).toEqual(["500000", "900000"]);
    expect(facts.latencyCeilingsMs).toEqual([4000]);
    expect(facts.reliabilityFloor).toBe(0.95);
    expect(facts.policyRestrictions).toEqual([]);
  });

  test("hard policy provider/model restrictions are collected with their constraint identity", () => {
    const facts = governingFacts(QUALITY, [
      {
        constraintId: "policy-routes",
        kind: "policy",
        enforcement: "hard",
        source: { authority: "policy", policySetId: "ps-1" },
        payload: {
          providerModel: { allowedProviders: ["rail-a"], deniedModels: ["model-y"] },
        },
      },
    ]);
    expect(facts.policyRestrictions).toHaveLength(1);
    expect(facts.policyRestrictions[0]?.constraintId).toBe("policy-routes");
    expect(facts.policyRestrictions[0]?.providerModel.allowedProviders).toEqual(["rail-a"]);
  });
});

describe("per-candidate admissibility (typed, total)", () => {
  test("an admissible candidate carries no inadmissible code", () => {
    const facts = governingFacts(QUALITY, []);
    const verdict = evaluateAdmissibility(candidate("ok", 0.92), facts);
    expect(verdict.admissible).toBe(true);
    expect(verdict.inadmissibleCode).toBeUndefined();
    // ceil(1000 / 0.9) = 1112 expected successful-resolution cost.
    expect(verdict.evaluation.expectedSuccessfulResolutionCostMicroUsd).toBe("1112");
  });

  test("a candidate below a HARD quality floor violates a governing constraint", () => {
    const facts = governingFacts({ requiredQuality: 0.9 }, [hardQualityConstraint(0.85)]);
    const verdict = evaluateAdmissibility(candidate("low", 0.84), facts);
    expect(verdict.admissible).toBe(false);
    expect(verdict.inadmissibleCode).toBe("quality-below-hard-floor");
  });

  test("a candidate below only the assurance threshold is inadmissible with the comparison-evidence code", () => {
    const facts = governingFacts({ requiredQuality: 0.9 }, [hardQualityConstraint(0.85)]);
    const verdict = evaluateAdmissibility(candidate("marginal", 0.87), facts);
    expect(verdict.admissible).toBe(false);
    expect(verdict.inadmissibleCode).toBe("quality-below-assurance");
  });

  test("reliability, budget and latency ceilings each produce their typed code", () => {
    const base = governingFacts(QUALITY, []);
    expect(
      evaluateAdmissibility(candidate("shaky", 0.92, "1000", 0.8), {
        ...base,
        reliabilityFloor: 0.9,
      }).inadmissibleCode,
    ).toBe("reliability-below-floor");
    expect(
      evaluateAdmissibility(candidate("expensive", 0.92, "900000"), {
        ...base,
        budgetCeilingsMicroUsd: ["500000"],
      }).inadmissibleCode,
    ).toBe("budget-ceiling");
    expect(
      evaluateAdmissibility(candidate("slow", 0.92, "1000", 0.9, 5000), {
        ...base,
        latencyCeilingsMs: [4000],
      }).inadmissibleCode,
    ).toBe("latency-ceiling");
  });

  test("the hard floor dominates the code order (checked before the assurance threshold)", () => {
    const facts = governingFacts({ requiredQuality: 0.95 }, [hardQualityConstraint(0.85)]);
    const verdict = evaluateAdmissibility(candidate("very-low", 0.8, "900000", 0.8, 9000), {
      ...facts,
      budgetCeilingsMicroUsd: ["500000"],
      latencyCeilingsMs: [4000],
      reliabilityFloor: 0.9,
    });
    expect(verdict.inadmissibleCode).toBe("quality-below-hard-floor");
  });
});

describe("the deterministic selection order", () => {
  test("expected successful-resolution cost ascending", () => {
    const facts = governingFacts(QUALITY, []);
    const cheap = evaluateAdmissibility(candidate("cheap", 0.92, "200", 1), facts);
    const dear = evaluateAdmissibility(candidate("dear", 0.95, "1000", 0.9), facts);
    expect(compareAdmissible(cheap, dear)).toBeLessThan(0);
    expect(compareAdmissible(dear, cheap)).toBeGreaterThan(0);
  });

  test("cost ties break by the canonical representation ladder (cheaper rung first)", () => {
    const facts = governingFacts(QUALITY, []);
    const sufficient = evaluateAdmissibility(
      candidate("s", 0.92, "1000", 0.9, 2000, "sufficient-model"),
      facts,
    );
    const stronger = evaluateAdmissibility(
      candidate("t", 0.95, "1000", 0.9, 2000, "stronger-model"),
      facts,
    );
    expect(compareAdmissible(sufficient, stronger)).toBeLessThan(0);
  });

  test("full ties break by candidateId (content, never randomness)", () => {
    const facts = governingFacts(QUALITY, []);
    const a = evaluateAdmissibility(candidate("a-model", 0.92), facts);
    const b = evaluateAdmissibility(candidate("b-model", 0.92), facts);
    expect(compareAdmissible(a, b)).toBeLessThan(0);
    expect(compareAdmissible(b, a)).toBeGreaterThan(0);
    expect(compareAdmissible(a, a)).toBe(0);
  });

  test("orderVerdicts: admissible first in the deterministic order, inadmissible after (input order)", () => {
    const facts = governingFacts({ requiredQuality: 0.9 }, [hardQualityConstraint(0.85)]);
    const inadmissibleFirst = evaluateAdmissibility(candidate("z-below", 0.84), facts);
    const cheap = evaluateAdmissibility(candidate("z-cheap", 0.92, "200", 1), facts);
    const dear = evaluateAdmissibility(candidate("a-dear", 0.95, "1000", 0.9), facts);
    const { ordered, selected } = orderVerdicts([inadmissibleFirst, dear, cheap]);
    expect(ordered.map((verdict) => verdict.candidateId)).toEqual(["z-cheap", "a-dear", "z-below"]);
    expect(selected?.candidateId).toBe("z-cheap");
  });

  test("orderVerdicts: no admissible candidate selects null (never a below-floor selection)", () => {
    const facts = governingFacts({ requiredQuality: 0.9 }, [hardQualityConstraint(0.85)]);
    const { ordered, selected } = orderVerdicts([
      evaluateAdmissibility(candidate("low-1", 0.8), facts),
      evaluateAdmissibility(candidate("low-2", 0.84), facts),
    ]);
    expect(selected).toBeNull();
    expect(ordered).toHaveLength(2);
  });
});

describe("the closed fail-closed rules", () => {
  test("duplicate candidate ids within one decision are rejected", () => {
    expect(() => rejectDuplicateIds(["a", "b", "a"])).toThrow(ModelEconomicsError);
    try {
      rejectDuplicateIds(["a", "a"]);
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("candidate-shape");
    }
    expect(() => rejectDuplicateIds(["a", "b", "c"])).not.toThrow();
  });
});
