/**
 * Expected-gain arithmetic unit tests (WORK-053): the bounded, typed
 * 0/1/N trade-off machinery — valueOfGain (conservative ceiling),
 * signed incremental cost, signed latency term, the net and its
 * positivity gate rule, and the closed fail-closed bounds (gain
 * scaling, money universe overflow).
 */

import { describe, expect, test } from "vitest";
import {
  analyzeExpectedGain,
  anchorOf,
} from "../../../../src/platform/model-economics/expected-gain";
import type {
  AgentGainClaim,
  ModelEconomicsError,
} from "../../../../src/platform/model-economics/vocabulary";

function gain(input: Partial<AgentGainClaim> = {}): AgentGainClaim {
  return {
    expectedQualityGain: 0.3,
    expectedVerificationBurdenMicroUsd: "10000",
    agentCount: 4,
    basis: { basis: "estimated", source: "learning.telemetry" },
    ...input,
  };
}

const ECONOMICS = {
  qualityValueMicroUsd: "1000000",
  latencyValueMicroUsdPerMs: "5",
};

describe("the expected-gain arithmetic (bounded, typed, signed)", () => {
  test("valueOfGain = ceil(qualityValue × expectedQualityGain) — the conservative ceiling", () => {
    const analysis = analyzeExpectedGain({
      candidateId: "n-1",
      expectedSuccessfulResolutionCostMicroUsd: "300",
      claim: { expectedLatencyMs: 1000 },
      gain: gain({ expectedQualityGain: 0.5 }),
      anchorCostMicroUsd: "200",
      anchorLatencyMs: 1000,
      economics: { qualityValueMicroUsd: "1000000" },
    });
    expect(analysis.valueOfGainMicroUsd).toBe("500000");
    // The fractional case rounds UP (ceil): 1000000 × 0.0000003 → 1.
    const fractional = analyzeExpectedGain({
      candidateId: "n-2",
      expectedSuccessfulResolutionCostMicroUsd: "300",
      claim: { expectedLatencyMs: 1000 },
      gain: gain({ expectedQualityGain: 0.0000003 }),
      anchorCostMicroUsd: "200",
      anchorLatencyMs: 1000,
      economics: { qualityValueMicroUsd: "1000000" },
    });
    expect(fractional.valueOfGainMicroUsd).toBe("1");
  });

  test("incrementalCost is SIGNED: a genuinely cheaper parallel path carries a negative premium", () => {
    const analysis = analyzeExpectedGain({
      candidateId: "n-cheap",
      expectedSuccessfulResolutionCostMicroUsd: "100",
      claim: { expectedLatencyMs: 1000 },
      gain: gain(),
      anchorCostMicroUsd: "300",
      anchorLatencyMs: 1000,
      economics: { qualityValueMicroUsd: "1000000" },
    });
    expect(analysis.incrementalCostMicroUsd).toBe("-200");
  });

  test("latencyTerm is SIGNED: a parallel latency benefit offsets cost", () => {
    const analysis = analyzeExpectedGain({
      candidateId: "n-fast",
      expectedSuccessfulResolutionCostMicroUsd: "300",
      claim: { expectedLatencyMs: 400 },
      gain: gain(),
      anchorCostMicroUsd: "200",
      anchorLatencyMs: 1000,
      economics: ECONOMICS,
    });
    expect(analysis.latencyDeltaMs).toBe(-600);
    expect(analysis.latencyTermMicroUsd).toBe("-3000");
  });

  test("the net is valueOfGain − incrementalCost − verificationBurden − latencyTerm", () => {
    // valueOfGain = 300000; incremental = 300−200 = 100; burden = 10000;
    // latencyTerm = 5 × (1000−1000) = 0 → net = 300000 − 100 − 10000 = 289900.
    const analysis = analyzeExpectedGain({
      candidateId: "n-1",
      expectedSuccessfulResolutionCostMicroUsd: "300",
      claim: { expectedLatencyMs: 1000 },
      gain: gain(),
      anchorCostMicroUsd: "200",
      anchorLatencyMs: 1000,
      economics: ECONOMICS,
    });
    expect(analysis.netExpectedGainMicroUsd).toBe("289900");
    expect(analysis.positive).toBe(true);
  });

  test("a non-positive net is NOT positive — the gate rule (below-threshold N is inadmissible)", () => {
    // valueOfGain = 300000; incremental = 9000−200 = 8800; burden = 990000;
    // latencyTerm = 0 → net = 300000 − 8800 − 990000 < 0.
    const analysis = analyzeExpectedGain({
      candidateId: "n-bad",
      expectedSuccessfulResolutionCostMicroUsd: "9000",
      claim: { expectedLatencyMs: 1000 },
      gain: gain({ expectedVerificationBurdenMicroUsd: "990000" }),
      anchorCostMicroUsd: "200",
      anchorLatencyMs: 1000,
      economics: ECONOMICS,
    });
    expect(analysis.positive).toBe(false);
    // Net zero is also not positive ("strictly").
    const zero = analyzeExpectedGain({
      candidateId: "n-zero",
      expectedSuccessfulResolutionCostMicroUsd: "200",
      claim: { expectedLatencyMs: 1000 },
      // valueOfGain 300000 − incremental 0 − burden 300000 − latency 0 = 0.
      gain: gain({ expectedVerificationBurdenMicroUsd: "300000" }),
      anchorCostMicroUsd: "200",
      anchorLatencyMs: 1000,
      economics: { qualityValueMicroUsd: "1000000" },
    });
    expect(zero.netExpectedGainMicroUsd).toBe("0");
    expect(zero.positive).toBe(false);
  });

  test("the empty anchor (no admissible cheaper path) measures the premium against nothing", () => {
    const analysis = analyzeExpectedGain({
      candidateId: "n-1",
      expectedSuccessfulResolutionCostMicroUsd: "300",
      claim: { expectedLatencyMs: 1000 },
      gain: gain(),
      anchorCostMicroUsd: "0",
      anchorLatencyMs: 0,
      economics: ECONOMICS,
    });
    expect(analysis.incrementalCostMicroUsd).toBe("300");
    expect(analysis.latencyDeltaMs).toBe(1000);
    expect(analysis.latencyTermMicroUsd).toBe("5000");
  });

  test("the anchor facts helper extracts the anchor from an evaluated verdict", () => {
    const anchor = anchorOf({
      evaluation: { expectedSuccessfulResolutionCostMicroUsd: "222" },
      claim: { expectedLatencyMs: 700 },
    });
    expect(anchor.expectedSuccessfulResolutionCostMicroUsd).toBe("222");
    expect(anchor.expectedLatencyMs).toBe(700);
  });
});

describe("the closed fail-closed bounds", () => {
  test("a zero or negative expected quality gain is unrepresentable (gate-shape)", () => {
    for (const bad of [0, -0.1, 1.5, Number.NaN]) {
      try {
        analyzeExpectedGain({
          candidateId: "n-1",
          expectedSuccessfulResolutionCostMicroUsd: "300",
          claim: { expectedLatencyMs: 1000 },
          gain: gain({ expectedQualityGain: bad }),
          anchorCostMicroUsd: "200",
          anchorLatencyMs: 1000,
          economics: ECONOMICS,
        });
        expect.unreachable(`gain ${bad} must be rejected`);
      } catch (error) {
        expect((error as ModelEconomicsError).invariant).toBe("gate-shape");
      }
    }
  });

  test("overflow past the bounded money universe is a typed rejection (never a silent infinity)", () => {
    try {
      analyzeExpectedGain({
        candidateId: "n-overflow",
        expectedSuccessfulResolutionCostMicroUsd: "999999999999999998",
        claim: { expectedLatencyMs: 1000 },
        gain: gain(),
        // anchorCost 0 → incremental ≈ 10^18; valueOfGain 300000;
        // latencyTerm = 999999999999999999 × 1000 overflows.
        anchorCostMicroUsd: "0",
        anchorLatencyMs: 0,
        economics: {
          qualityValueMicroUsd: "1000000",
          latencyValueMicroUsdPerMs: "999999999999999999",
        },
      });
      expect.unreachable("the overflow must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("claim-overflow");
    }
  });

  test("unbounded money inputs are rejected (claim-overflow)", () => {
    try {
      analyzeExpectedGain({
        candidateId: "n-1",
        expectedSuccessfulResolutionCostMicroUsd: "not-a-number",
        claim: { expectedLatencyMs: 1000 },
        gain: gain(),
        anchorCostMicroUsd: "200",
        anchorLatencyMs: 1000,
        economics: ECONOMICS,
      });
      expect.unreachable("malformed money must be rejected");
    } catch (error) {
      expect((error as ModelEconomicsError).invariant).toBe("claim-overflow");
    }
  });
});
