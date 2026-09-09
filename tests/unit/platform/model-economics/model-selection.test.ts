/**
 * Quality-aware model-selection unit tests (WORK-053): the least
 * expensive SUFFICIENT route among declared candidates, inviolable
 * floors (below-floor is inadmissible regardless of cost), hard
 * ceilings and policy route restrictions, the frozen basis, the
 * fail-closed preconditions and determinism (including tie-breaking).
 */

import { describe, expect, test } from "vitest";
import {
  MODEL_SELECTION_BASIS,
  selectModelRepresentation,
} from "../../../../src/platform/model-economics/model-selection";
import type {
  ModelCandidate,
  ModelEconomicsError,
} from "../../../../src/platform/model-economics/vocabulary";
import { claim, constraints, governedIr } from "./world";

const STEP = "generate";

function model(
  candidateId: string,
  provider: string,
  modelId: string,
  input: {
    readonly cost: string;
    readonly latency: number;
    readonly quality: number;
    readonly reliability: number;
  },
  representationClass: "sufficient-model" | "stronger-model" = "sufficient-model",
): ModelCandidate {
  return {
    candidateId,
    route: { provider, model: modelId },
    representationClass,
    claim: claim(input),
  };
}

describe("quality-aware model selection", () => {
  test("selects the least expensive SUFFICIENT route (expected successful-resolution cost)", () => {
    // rail-b: cost 200, reliability 1 → 200. rail-a: cost 1000,
    // reliability 0.9 → ceil(1000/0.9) = 1112. Both above the floor.
    const selection = selectModelRepresentation({
      ir: governedIr(),
      stepId: STEP,
      candidates: [
        model("rail-a-model-x", "rail-a", "model-x", {
          cost: "1000",
          latency: 2000,
          quality: 0.95,
          reliability: 0.9,
        }),
        model("rail-b-model-y", "rail-b", "model-y", {
          cost: "200",
          latency: 1500,
          quality: 0.92,
          reliability: 1,
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(selection.kind).toBe("selected");
    expect(selection.selected?.candidateId).toBe("rail-b-model-y");
    expect(selection.selected?.route).toEqual({ provider: "rail-b", model: "model-y" });
    // The ordering evidence: admissible cost-ascending, inadmissible after.
    expect(selection.verdicts.map((verdict) => verdict.candidateId)).toEqual([
      "rail-b-model-y",
      "rail-a-model-x",
    ]);
    expect(selection.selectionBasis).toBe(MODEL_SELECTION_BASIS);
  });

  test("a cheaper below-floor candidate is INADMISSIBLE regardless of cost (invariant 8)", () => {
    const selection = selectModelRepresentation({
      ir: governedIr(),
      stepId: STEP,
      candidates: [
        // Cheap but below the 0.9 assurance floor (and above the 0.85
        // hard floor — the comparison-evidence code).
        model("cheap-bad", "rail-b", "model-y", {
          cost: "10",
          latency: 100,
          quality: 0.87,
          reliability: 1,
        }),
        model("dear-good", "rail-a", "model-x", {
          cost: "1000",
          latency: 2000,
          quality: 0.95,
          reliability: 0.9,
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(selection.kind).toBe("selected");
    expect(selection.selected?.candidateId).toBe("dear-good");
    expect(
      selection.verdicts.find((verdict) => verdict.candidateId === "cheap-bad")?.inadmissibleCode,
    ).toBe("quality-below-assurance");
  });

  test("no admissible candidate is the TYPED outcome (never a below-floor selection)", () => {
    const selection = selectModelRepresentation({
      ir: governedIr(),
      stepId: STEP,
      candidates: [
        model("low-1", "rail-a", "model-x", {
          cost: "10",
          latency: 100,
          quality: 0.8,
          reliability: 1,
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(selection.kind).toBe("no-admissible-candidate");
    expect(selection.selected).toBeNull();
    // Below the hard 0.85 floor — the constraint-violation code.
    expect(selection.verdicts[0]?.inadmissibleCode).toBe("quality-below-hard-floor");
  });

  test("hard constraints raise the effective floor above the assurance threshold", () => {
    const selection = selectModelRepresentation({
      ir: governedIr(),
      stepId: STEP,
      candidates: [
        model("marginal", "rail-b", "model-y", {
          cost: "10",
          latency: 100,
          quality: 0.87,
          reliability: 1,
        }),
      ],
      qualityFacts: { requiredQuality: 0.8 },
      constraints: [
        ...constraints().filter((constraint) => constraint.kind !== "quality"),
        {
          constraintId: "hard-quality-95",
          kind: "quality" as const,
          enforcement: "hard" as const,
          source: { authority: "policy" as const, policySetId: "ps-1" },
          payload: { minQuality: 0.95 },
        },
      ],
    });
    expect(selection.kind).toBe("no-admissible-candidate");
    expect(selection.facts.qualityFloor).toBe(0.95);
    expect(selection.verdicts[0]?.inadmissibleCode).toBe("quality-below-hard-floor");
  });

  test("a policy-forbidden route is inadmissible regardless of every other dimension", () => {
    const selection = selectModelRepresentation({
      ir: governedIr(),
      stepId: STEP,
      candidates: [
        model("rail-b-model-y", "rail-b", "model-y", {
          cost: "10",
          latency: 100,
          quality: 0.95,
          reliability: 1,
        }),
        model("rail-a-model-x", "rail-a", "model-x", {
          cost: "1000",
          latency: 2000,
          quality: 0.95,
          reliability: 0.9,
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: [
        ...constraints().filter((constraint) => constraint.constraintId !== "policy-eligibility"),
        {
          constraintId: "policy-eligibility",
          kind: "policy" as const,
          enforcement: "hard" as const,
          source: { authority: "policy" as const, policySetId: "ps-1" },
          payload: { providerModel: { allowedProviders: ["rail-a"] } },
        },
      ],
    });
    expect(selection.selected?.candidateId).toBe("rail-a-model-x");
    expect(
      selection.verdicts.find((verdict) => verdict.candidateId === "rail-b-model-y")
        ?.inadmissibleCode,
    ).toBe("policy-forbidden-route");
  });

  test("budget and latency ceilings are enforced per candidate", () => {
    const base = constraints().filter(
      (constraint) => constraint.constraintId === "verification-anchor",
    );
    const overBudget = selectModelRepresentation({
      ir: governedIr(),
      stepId: STEP,
      candidates: [
        model("dear", "rail-a", "model-x", {
          cost: "900000",
          latency: 100,
          quality: 0.95,
          reliability: 1,
        }),
        model("cheap", "rail-b", "model-y", {
          cost: "100",
          latency: 100,
          quality: 0.95,
          reliability: 1,
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: [
        ...base,
        {
          constraintId: "budget-1",
          kind: "budget" as const,
          enforcement: "hard" as const,
          source: { authority: "budget" as const, budgetId: "b-1", scopeKind: "monthly" as const },
          payload: { maxCostMicroUsd: "500000" },
        },
      ],
    });
    expect(overBudget.selected?.candidateId).toBe("cheap");
    expect(
      overBudget.verdicts.find((verdict) => verdict.candidateId === "dear")?.inadmissibleCode,
    ).toBe("budget-ceiling");

    const overLatency = selectModelRepresentation({
      ir: governedIr(),
      stepId: STEP,
      candidates: [
        model("slow", "rail-a", "model-x", {
          cost: "100",
          latency: 9000,
          quality: 0.95,
          reliability: 1,
        }),
        model("fast", "rail-b", "model-y", {
          cost: "200",
          latency: 100,
          quality: 0.95,
          reliability: 1,
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: [
        ...base,
        {
          constraintId: "latency-1",
          kind: "latency" as const,
          enforcement: "hard" as const,
          source: { authority: "policy" as const, policySetId: "ps-1" },
          payload: { maxLatencyMs: 4000 },
        },
      ],
    });
    expect(overLatency.selected?.candidateId).toBe("fast");
    expect(
      overLatency.verdicts.find((verdict) => verdict.candidateId === "slow")?.inadmissibleCode,
    ).toBe("latency-ceiling");
  });

  test("determinism: identical inputs produce the identical selection (deep equality)", () => {
    const input = {
      ir: governedIr(),
      stepId: STEP,
      candidates: [
        model("rail-b-model-y", "rail-b", "model-y", {
          cost: "200",
          latency: 1500,
          quality: 0.92,
          reliability: 1,
        }),
        model("rail-a-model-x", "rail-a", "model-x", {
          cost: "1000",
          latency: 2000,
          quality: 0.95,
          reliability: 0.9,
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    };
    expect(selectModelRepresentation(input)).toEqual(selectModelRepresentation(input));
  });
});

describe("the deterministic tie-breaking (content, never randomness)", () => {
  test("cost ties break by the canonical ladder (sufficient-model before stronger-model)", () => {
    const selection = selectModelRepresentation({
      ir: governedIr(),
      stepId: STEP,
      candidates: [
        model(
          "stronger-route",
          "rail-b",
          "model-y",
          {
            cost: "200",
            latency: 1500,
            quality: 0.92,
            reliability: 1,
          },
          "stronger-model",
        ),
        model("sufficient-route", "rail-a", "model-x", {
          cost: "200",
          latency: 1500,
          quality: 0.92,
          reliability: 1,
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(selection.selected?.candidateId).toBe("sufficient-route");
  });

  test("full ties break by candidateId — and the selection is permutation-invariant", () => {
    const candidates = [
      model("b-model", "rail-b", "model-y", {
        cost: "200",
        latency: 1500,
        quality: 0.92,
        reliability: 1,
      }),
      model("a-model", "rail-a", "model-x", {
        cost: "200",
        latency: 1500,
        quality: 0.92,
        reliability: 1,
      }),
      model("c-model", "rail-b", "model-z", {
        cost: "200",
        latency: 1500,
        quality: 0.92,
        reliability: 1,
      }),
    ];
    const outcomes = [
      [...candidates],
      [
        candidates[2] as ModelCandidate,
        candidates[0] as ModelCandidate,
        candidates[1] as ModelCandidate,
      ],
      [
        candidates[1] as ModelCandidate,
        candidates[2] as ModelCandidate,
        candidates[0] as ModelCandidate,
      ],
    ].map((corpus) =>
      selectModelRepresentation({
        ir: governedIr(),
        stepId: STEP,
        candidates: corpus,
        qualityFacts: { requiredQuality: 0.9 },
        constraints: constraints(),
      }),
    );
    // Every input permutation selects the SAME candidate and produces
    // the SAME ordered verdicts (a content-ordered tie-break cannot
    // depend on input order).
    for (const outcome of outcomes) {
      expect(outcome.selected?.candidateId).toBe("a-model");
      expect(outcome.verdicts.map((verdict) => verdict.candidateId)).toEqual([
        "a-model",
        "b-model",
        "c-model",
      ]);
    }
  });
});

describe("the fail-closed preconditions", () => {
  const candidates = [
    model("rail-a-model-x", "rail-a", "model-x", {
      cost: "1000",
      latency: 2000,
      quality: 0.95,
      reliability: 0.9,
    }),
  ];

  test("a missing step is rejected (step-not-found)", () => {
    try {
      selectModelRepresentation({
        ir: governedIr(),
        stepId: "no-such-step",
        candidates,
        qualityFacts: { requiredQuality: 0.9 },
        constraints: constraints(),
      });
      expect.unreachable("the missing step must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("step-not-found");
    }
  });

  test("model selection points are GENERATIVE steps only", () => {
    try {
      selectModelRepresentation({
        ir: governedIr(),
        stepId: "verify",
        candidates,
        qualityFacts: { requiredQuality: 0.9 },
        constraints: constraints(),
      });
      expect.unreachable("the non-generative step must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("step-not-generative");
    }
  });

  test("an empty candidate corpus is rejected (candidate-shape)", () => {
    try {
      selectModelRepresentation({
        ir: governedIr(),
        stepId: STEP,
        candidates: [],
        qualityFacts: { requiredQuality: 0.9 },
        constraints: constraints(),
      });
      expect.unreachable("the empty corpus must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("candidate-shape");
    }
  });

  test("duplicate candidate ids are rejected (candidate-shape)", () => {
    try {
      selectModelRepresentation({
        ir: governedIr(),
        stepId: STEP,
        candidates: [...candidates, ...candidates],
        qualityFacts: { requiredQuality: 0.9 },
        constraints: constraints(),
      });
      expect.unreachable("duplicate ids must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("candidate-shape");
    }
  });

  test("an unattributed claim is rejected through the closed vocabulary (claim-invalid)", () => {
    try {
      selectModelRepresentation({
        ir: governedIr(),
        stepId: STEP,
        candidates: [
          {
            candidateId: "unattributed",
            route: { provider: "rail-a", model: "model-x" },
            representationClass: "sufficient-model",
            claim: {
              expectedCostMicroUsd: "100",
              expectedLatencyMs: 100,
              expectedQuality: 0.95,
              expectedReliability: 1,
            } as unknown as ModelCandidate["claim"],
          },
        ],
        qualityFacts: { requiredQuality: 0.9 },
        constraints: constraints(),
      });
      expect.unreachable("the unattributed claim must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("claim-invalid");
    }
  });
});
