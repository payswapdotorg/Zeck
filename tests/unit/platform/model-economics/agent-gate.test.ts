/**
 * The 0/1/N agent-gate unit tests (WORK-053): the gate defaults to
 * the cheapest path; N requires POSITIVE net expected-gain evidence
 * (always-on N is impossible by construction); a costlier N never
 * displaces a cheaper sufficient 0/1 path; every N candidate's gain
 * analysis is recorded; floors/ceilings/policy apply to every
 * strategy; the one-agent anchor is required; determinism.
 */

import { describe, expect, test } from "vitest";
import {
  AGENT_GATE_SELECTION_BASIS,
  selectAgentStrategy,
} from "../../../../src/platform/model-economics/agent-gate";
import type {
  ModelEconomicsError,
  NAgentCandidate,
  OneAgentCandidate,
  ZeroAgentCandidate,
} from "../../../../src/platform/model-economics/vocabulary";
import { claim, constraints, governedIr } from "./world";

const STEP = "generate";

const ECONOMICS = { qualityValueMicroUsd: "1000000" };

function zero(
  candidateId: string,
  cost: string,
  quality = 0.95,
  reliability = 1,
): ZeroAgentCandidate {
  return {
    candidateId,
    representationClass: "cache-reuse",
    claim: claim({ cost, latency: 500, quality, reliability, source: "learning.telemetry" }),
  };
}

function one(
  candidateId: string,
  cost: string,
  quality = 0.95,
  reliability = 0.9,
  route?: { provider: string; model: string },
): OneAgentCandidate {
  return {
    candidateId,
    ...(route === undefined ? {} : { route }),
    representationClass: "sufficient-model",
    claim: claim({ cost, latency: 2000, quality, reliability }),
  };
}

function nAgent(
  candidateId: string,
  cost: string,
  gainInput: {
    readonly expectedQualityGain: number;
    readonly expectedVerificationBurdenMicroUsd: string;
    readonly agentCount?: number;
  },
  quality = 0.95,
  route?: { provider: string; model: string },
): NAgentCandidate {
  return {
    candidateId,
    ...(route === undefined ? {} : { route }),
    claim: claim({ cost, latency: 1500, quality, reliability: 0.95 }),
    gain: {
      expectedQualityGain: gainInput.expectedQualityGain,
      expectedVerificationBurdenMicroUsd: gainInput.expectedVerificationBurdenMicroUsd,
      agentCount: gainInput.agentCount ?? 2,
      basis: { basis: "estimated", source: "learning.telemetry" },
    },
  };
}

describe("the 0/1/N agent gate", () => {
  test("defaults to the CHEAPEST path: a sufficient zero-agent strategy wins", () => {
    const selection = selectAgentStrategy({
      ir: governedIr(),
      stepId: STEP,
      zeroAgent: [zero("cached", "50")],
      oneAgent: [one("single", "200")],
      nAgent: [],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
      economics: ECONOMICS,
    });
    expect(selection.kind).toBe("selected");
    expect(selection.gateMode).toBe("zero-agent");
    expect(selection.selected?.candidateId).toBe("cached");
    expect(selection.selectionBasis).toBe(AGENT_GATE_SELECTION_BASIS);
  });

  test("the one-agent single-model path is the default when no zero-agent candidate is sufficient", () => {
    const selection = selectAgentStrategy({
      ir: governedIr(),
      stepId: STEP,
      zeroAgent: [zero("cached-bad", "50", 0.87)],
      oneAgent: [one("single", "200")],
      nAgent: [],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
      economics: ECONOMICS,
    });
    expect(selection.gateMode).toBe("one-agent");
    expect(selection.selected?.candidateId).toBe("single");
    // The below-floor zero-agent verdict is recorded (typed evidence).
    expect(
      selection.verdicts.find((verdict) => verdict.candidateId === "cached-bad")?.inadmissibleCode,
    ).toBe("quality-below-assurance");
  });

  test("N is selected ONLY when its net gain is positive AND it is the cheapest sufficient path", () => {
    // N cost 100 < anchor 200; valueOfGain = 300000; burden 10000;
    // net = 300000 − (100 − 200) − 10000 = 290100 > 0.
    const selection = selectAgentStrategy({
      ir: governedIr(),
      stepId: STEP,
      zeroAgent: [],
      oneAgent: [one("single", "200")],
      nAgent: [
        nAgent("parallel", "100", {
          expectedQualityGain: 0.3,
          expectedVerificationBurdenMicroUsd: "10000",
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
      economics: ECONOMICS,
    });
    expect(selection.gateMode).toBe("n-agent");
    expect(selection.selected?.candidateId).toBe("parallel");
    expect(selection.selected?.agentCount).toBe(2);
    expect(selection.gainAnalyses).toHaveLength(1);
    expect(selection.gainAnalyses[0]?.positive).toBe(true);
    // valueOfGain 300000 − incremental (ceil(100/0.95)=106 − ceil(200/0.9)=223
    // = −117) − burden 10000 − latencyTerm 0 → 290117.
    expect(selection.gainAnalyses[0]?.netExpectedGainMicroUsd).toBe("290117");
  });

  test("a NON-POSITIVE net gain makes N inadmissible even when N is CHEAPER (always-on N impossible)", () => {
    // N cost 100 < anchor 200, but the burden swallows the gain:
    // net = 300000 − (−100) − 350000 < 0.
    const selection = selectAgentStrategy({
      ir: governedIr(),
      stepId: STEP,
      zeroAgent: [],
      oneAgent: [one("single", "200")],
      nAgent: [
        nAgent("parallel-bad", "100", {
          expectedQualityGain: 0.3,
          expectedVerificationBurdenMicroUsd: "350000",
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
      economics: ECONOMICS,
    });
    expect(selection.gateMode).toBe("one-agent");
    expect(
      selection.verdicts.find((verdict) => verdict.candidateId === "parallel-bad")
        ?.inadmissibleCode,
    ).toBe("quality-gain-below-threshold");
    // The gain analysis is STILL recorded (the evidence of why not).
    expect(selection.gainAnalyses[0]?.positive).toBe(false);
  });

  test("a POSITIVE-gain but COSTLIER N never displaces the cheaper sufficient 0/1 path", () => {
    // N cost 500 > anchor 200; net = 300000 − 300 − 10000 > 0 — yet the
    // gate selects the least expensive SUFFICIENT strategy.
    const selection = selectAgentStrategy({
      ir: governedIr(),
      stepId: STEP,
      zeroAgent: [],
      oneAgent: [one("single", "200")],
      nAgent: [
        nAgent("parallel-dear", "500", {
          expectedQualityGain: 0.3,
          expectedVerificationBurdenMicroUsd: "10000",
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
      economics: ECONOMICS,
    });
    expect(selection.gateMode).toBe("one-agent");
    expect(selection.selected?.candidateId).toBe("single");
    // ...and the costlier N IS admissible (positive net) — just not
    // the least expensive sufficient strategy.
    expect(
      selection.verdicts.find((verdict) => verdict.candidateId === "parallel-dear")?.admissible,
    ).toBe(true);
  });

  test("the N premium is measured against the deterministic anchor (the best admissible 0/1)", () => {
    // anchor = the zero-agent 50; N cost 100 → incremental 50.
    const selection = selectAgentStrategy({
      ir: governedIr(),
      stepId: STEP,
      zeroAgent: [zero("cached", "50")],
      oneAgent: [one("single", "200")],
      nAgent: [
        nAgent("parallel", "100", {
          expectedQualityGain: 0.3,
          expectedVerificationBurdenMicroUsd: "10000",
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
      economics: ECONOMICS,
    });
    expect(selection.gainAnalyses[0]?.incrementalCostMicroUsd).toBe("56");
    // The zero-agent path stays the cheapest sufficient strategy.
    expect(selection.gateMode).toBe("zero-agent");
  });

  test("a below-floor N is inadmissible regardless of its gain evidence", () => {
    const selection = selectAgentStrategy({
      ir: governedIr(),
      stepId: STEP,
      zeroAgent: [],
      oneAgent: [one("single", "200")],
      nAgent: [
        nAgent(
          "parallel-lowq",
          "100",
          {
            expectedQualityGain: 0.9,
            expectedVerificationBurdenMicroUsd: "10",
          },
          0.8,
        ),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
      economics: ECONOMICS,
    });
    expect(selection.gateMode).toBe("one-agent");
    expect(
      selection.verdicts.find((verdict) => verdict.candidateId === "parallel-lowq")
        ?.inadmissibleCode,
    ).toBe("quality-below-hard-floor");
  });

  test("policy-forbidden N routes are inadmissible; legal routes flow through", () => {
    const selection = selectAgentStrategy({
      ir: governedIr(),
      stepId: STEP,
      zeroAgent: [],
      oneAgent: [one("single", "200")],
      nAgent: [
        nAgent(
          "parallel-forbidden",
          "100",
          { expectedQualityGain: 0.3, expectedVerificationBurdenMicroUsd: "10000" },
          0.95,
          { provider: "rail-c", model: "model-z" },
        ),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: [
        ...constraints(),
        {
          constraintId: "policy-only-rail-ab",
          kind: "policy" as const,
          enforcement: "hard" as const,
          source: { authority: "policy" as const, policySetId: "ps-1" },
          payload: { providerModel: { deniedProviders: ["rail-c"] } },
        },
      ],
      economics: ECONOMICS,
    });
    expect(selection.gateMode).toBe("one-agent");
    expect(
      selection.verdicts.find((verdict) => verdict.candidateId === "parallel-forbidden")
        ?.inadmissibleCode,
    ).toBe("policy-forbidden-route");
  });

  test("EVERY N candidate's gain analysis is recorded (admissible or not)", () => {
    const selection = selectAgentStrategy({
      ir: governedIr(),
      stepId: STEP,
      zeroAgent: [],
      oneAgent: [one("single", "200")],
      nAgent: [
        nAgent("parallel-good", "100", {
          expectedQualityGain: 0.3,
          expectedVerificationBurdenMicroUsd: "10000",
        }),
        nAgent("parallel-bad", "100", {
          expectedQualityGain: 0.1,
          expectedVerificationBurdenMicroUsd: "200000",
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
      economics: ECONOMICS,
    });
    expect(selection.gainAnalyses.map((analysis) => analysis.candidateId)).toEqual([
      "parallel-good",
      "parallel-bad",
    ]);
    expect(selection.gainAnalyses[0]?.positive).toBe(true);
    expect(selection.gainAnalyses[1]?.positive).toBe(false);
  });

  test("determinism: identical inputs produce the identical gate decision", () => {
    const input = {
      ir: governedIr(),
      stepId: STEP,
      zeroAgent: [zero("cached", "50")],
      oneAgent: [one("single", "200")],
      nAgent: [
        nAgent("parallel", "100", {
          expectedQualityGain: 0.3,
          expectedVerificationBurdenMicroUsd: "10000",
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
      economics: ECONOMICS,
    };
    expect(selectAgentStrategy(input)).toEqual(selectAgentStrategy(input));
  });
});

describe("the fail-closed gate preconditions", () => {
  test("the one-agent anchor is REQUIRED (a gate without it is unanchored economics)", () => {
    try {
      selectAgentStrategy({
        ir: governedIr(),
        stepId: STEP,
        zeroAgent: [zero("cached", "50")],
        oneAgent: [],
        nAgent: [],
        qualityFacts: { requiredQuality: 0.9 },
        constraints: constraints(),
        economics: ECONOMICS,
      });
      expect.unreachable("the anchorless gate must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("gate-shape");
    }
  });

  test("an N candidate without a POSITIVE gain claim is unrepresentable (gate-shape)", () => {
    try {
      selectAgentStrategy({
        ir: governedIr(),
        stepId: STEP,
        zeroAgent: [],
        oneAgent: [one("single", "200")],
        nAgent: [
          nAgent("parallel-no-gain", "100", {
            expectedQualityGain: 0,
            expectedVerificationBurdenMicroUsd: "10000",
          }),
        ],
        qualityFacts: { requiredQuality: 0.9 },
        constraints: constraints(),
        economics: ECONOMICS,
      });
      expect.unreachable("the zero-gain N candidate must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("gate-shape");
    }
  });

  test("duplicate candidate ids across the three families are rejected", () => {
    try {
      selectAgentStrategy({
        ir: governedIr(),
        stepId: STEP,
        zeroAgent: [zero("same-id", "50")],
        oneAgent: [one("same-id", "200")],
        nAgent: [],
        qualityFacts: { requiredQuality: 0.9 },
        constraints: constraints(),
        economics: ECONOMICS,
      });
      expect.unreachable("duplicate ids must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("candidate-shape");
    }
  });

  test("the gate applies to GENERATIVE steps only", () => {
    try {
      selectAgentStrategy({
        ir: governedIr(),
        stepId: "verify",
        zeroAgent: [],
        oneAgent: [one("single", "200")],
        nAgent: [],
        qualityFacts: { requiredQuality: 0.9 },
        constraints: constraints(),
        economics: ECONOMICS,
      });
      expect.unreachable("the non-generative step must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("step-not-generative");
    }
  });
});
