/**
 * Reasoning-effort selection unit tests (WORK-053): the same
 * explicit-basis economics as model selection over the effort
 * dimension — floors inviolable, the effort-rank tie-break toward
 * LOWER effort (the cheaper-path default), no route dimension, the
 * fail-closed preconditions and determinism.
 */

import { describe, expect, test } from "vitest";
import {
  EFFORT_SELECTION_BASIS,
  selectReasoningEffort,
} from "../../../../src/platform/model-economics/effort-selection";
import type {
  EffortCandidate,
  ModelEconomicsError,
} from "../../../../src/platform/model-economics/vocabulary";
import { claim, constraints, governedIr } from "./world";

const STEP = "generate";

function effort(
  candidateId: string,
  level: EffortCandidate["effort"],
  input: {
    readonly cost: string;
    readonly latency: number;
    readonly quality: number;
    readonly reliability: number;
  },
): EffortCandidate {
  return {
    candidateId,
    effort: level,
    representationClass: "sufficient-model",
    claim: claim(input),
  };
}

describe("reasoning-effort selection", () => {
  test("selects the least expensive SUFFICIENT effort level", () => {
    const selection = selectReasoningEffort({
      ir: governedIr(),
      stepId: STEP,
      candidates: [
        effort("effort-high", "high", {
          cost: "1000",
          latency: 4000,
          quality: 0.97,
          reliability: 1,
        }),
        effort("effort-minimal", "minimal", {
          cost: "200",
          latency: 900,
          quality: 0.91,
          reliability: 1,
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(selection.kind).toBe("selected");
    expect(selection.selected?.candidateId).toBe("effort-minimal");
    expect(selection.selected?.effort).toBe("minimal");
    expect(selection.selectionBasis).toBe(EFFORT_SELECTION_BASIS);
  });

  test("a cheaper below-floor effort is inadmissible regardless of cost", () => {
    const selection = selectReasoningEffort({
      ir: governedIr(),
      stepId: STEP,
      candidates: [
        effort("effort-cheap-bad", "minimal", {
          cost: "10",
          latency: 100,
          quality: 0.87,
          reliability: 1,
        }),
        effort("effort-high", "high", {
          cost: "1000",
          latency: 4000,
          quality: 0.97,
          reliability: 1,
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(selection.selected?.candidateId).toBe("effort-high");
    expect(
      selection.verdicts.find((verdict) => verdict.candidateId === "effort-cheap-bad")
        ?.inadmissibleCode,
    ).toBe("quality-below-assurance");
  });

  test("cost ties break toward LOWER effort (the cheaper-path default)", () => {
    const selection = selectReasoningEffort({
      ir: governedIr(),
      stepId: STEP,
      candidates: [
        effort("effort-high", "high", { cost: "200", latency: 900, quality: 0.92, reliability: 1 }),
        effort("effort-minimal", "minimal", {
          cost: "200",
          latency: 900,
          quality: 0.92,
          reliability: 1,
        }),
        effort("effort-medium", "medium", {
          cost: "200",
          latency: 900,
          quality: 0.92,
          reliability: 1,
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(selection.selected?.effort).toBe("minimal");
    // Admissible ordering: cost, then effort rank (minimal < medium < high).
    expect(selection.verdicts.map((verdict) => verdict.effort)).toEqual([
      "minimal",
      "medium",
      "high",
    ]);
  });

  test("no admissible effort is the typed outcome", () => {
    const selection = selectReasoningEffort({
      ir: governedIr(),
      stepId: STEP,
      candidates: [
        effort("effort-low", "low", { cost: "10", latency: 100, quality: 0.8, reliability: 1 }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(selection.kind).toBe("no-admissible-candidate");
    expect(selection.selected).toBeNull();
  });

  test("the one-agent anchor rules: a non-generative step is rejected", () => {
    try {
      selectReasoningEffort({
        ir: governedIr(),
        stepId: "verify",
        candidates: [
          effort("effort-low", "low", { cost: "10", latency: 100, quality: 0.95, reliability: 1 }),
        ],
        qualityFacts: { requiredQuality: 0.9 },
        constraints: constraints(),
      });
      expect.unreachable("the non-generative step must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("step-not-generative");
    }
  });

  test("determinism: identical inputs produce the identical selection", () => {
    const input = {
      ir: governedIr(),
      stepId: STEP,
      candidates: [
        effort("effort-high", "high", { cost: "300", latency: 900, quality: 0.97, reliability: 1 }),
        effort("effort-minimal", "minimal", {
          cost: "200",
          latency: 900,
          quality: 0.91,
          reliability: 1,
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    };
    expect(selectReasoningEffort(input)).toEqual(selectReasoningEffort(input));
  });
});
