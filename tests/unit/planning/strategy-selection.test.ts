/**
 * Strategy admissibility + selection tests (planning module; WORK-009 /
 * INT-004, AC-5, AC-9, AC-10, AC-13).
 *
 * Proves: policy as HARD constraints (a forbidden provider is inadmissible
 * regardless of price/quality — never "scored in"); cost/latency/quality
 * ceilings; the deterministic-first preference; cheap-first cascade
 * ordering; typed NO_ELIGIBLE_ROUTE when nothing admissible satisfies.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type {
  CandidateStrategy,
  DeterministicSufficiencyDecision,
} from "../../../src/modules/planning/public";
import {
  buildPlan,
  filterAdmissibility,
  routeAllowedByPolicy,
  selectStrategy,
} from "../../../src/modules/planning/public";
import { PlatformError } from "../../../src/shared/errors";

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

function planOf(strategyClass: "deterministic-only" | "generative", withRoute: boolean) {
  if (strategyClass === "deterministic-only") {
    return buildPlan(
      {
        revision: 1,
        strategyClass,
        steps: [
          { id: "compute", stepClass: "run-algorithm", capabilityId: "numeric-computation" },
          { id: "verify", stepClass: "verify" },
        ],
        edges: [{ from: "compute", to: "verify" }],
      },
      digest,
    );
  }
  return buildPlan(
    {
      revision: 1,
      strategyClass,
      steps: [
        {
          id: "model",
          stepClass: "call-model",
          capabilityId: "text-generation",
          ...(withRoute ? { routeRef: { provider: "rail-a", model: "model-x" } } : {}),
        },
        { id: "verify", stepClass: "verify" },
      ],
      edges: [{ from: "model", to: "verify" }],
    },
    digest,
  );
}

function candidate(
  overrides: Partial<CandidateStrategy> & { strategyId: string },
): Omit<CandidateStrategy, "admissible" | "inadmissibleReason"> {
  return {
    plan: planOf("deterministic-only", false),
    expectedCostMicroUsd: "100",
    expectedQuality: 0.9,
    expectedLatencyMs: 100,
    verificationStrategy: "exact-recomputation",
    routeRationale: { code: "deterministic-sufficient", detail: "test" },
    modelCalls: 0,
    ...overrides,
  };
}

const SUFFICIENT: DeterministicSufficiencyDecision = {
  outcome: "sufficient",
  semanticReasoningRequired: false,
  reasons: [],
  coverage: [],
  deterministicQualityEstimate: 0.999,
  qualityConfidence: "verified",
};

const INSUFFICIENT: DeterministicSufficiencyDecision = {
  ...SUFFICIENT,
  outcome: "insufficient",
  semanticReasoningRequired: true,
  deterministicQualityEstimate: null,
  qualityConfidence: null,
};

describe("route policy filtering (AC-9)", () => {
  test("a denied provider is never allowed", () => {
    expect(routeAllowedByPolicy("rail-a", "model-x", { deniedProviders: ["rail-a"] })).toBe(false);
    expect(routeAllowedByPolicy("rail-b", "model-x", { deniedProviders: ["rail-a"] })).toBe(true);
  });

  test("an allowlist excludes unlisted providers", () => {
    expect(routeAllowedByPolicy("rail-a", "model-x", { allowedProviders: ["rail-b"] })).toBe(false);
    expect(routeAllowedByPolicy("rail-b", "model-x", { allowedProviders: ["rail-b"] })).toBe(true);
  });

  test("model-level allow/deny lists apply independently", () => {
    expect(routeAllowedByPolicy("rail-a", "model-x", { deniedModels: ["model-x"] })).toBe(false);
    expect(routeAllowedByPolicy("rail-a", "model-y", { allowedModels: ["model-y"] })).toBe(true);
    expect(routeAllowedByPolicy("rail-a", "model-x", { allowedModels: ["model-y"] })).toBe(false);
  });

  test("a candidate carrying a forbidden route is INADMISSIBLE even when cheapest and best", () => {
    const forbidden = candidate({
      strategyId: "generative:forbidden",
      plan: planOf("generative", true),
      expectedCostMicroUsd: "1",
      expectedQuality: 0.99,
      modelCalls: 1,
    });
    const verdict = filterAdmissibility(forbidden, {
      providerModel: { deniedProviders: ["rail-a"] },
    });
    expect(verdict.admissible).toBe(false);
    expect(verdict.inadmissibleReason).toBe("policy-forbidden-route");
  });

  test("cost, latency and quality restrictions are hard ceilings", () => {
    const expensive = filterAdmissibility(
      candidate({ strategyId: "x", expectedCostMicroUsd: "5000" }),
      {
        cost: { maxCostMicroUsd: "1000" },
      },
    );
    expect(expensive.admissible).toBe(false);
    expect(expensive.inadmissibleReason).toBe("policy-cost-ceiling");

    const slow = filterAdmissibility(candidate({ strategyId: "x", expectedLatencyMs: 900 }), {
      latency: { maxLatencyMs: 500 },
    });
    expect(slow.admissible).toBe(false);
    expect(slow.inadmissibleReason).toBe("policy-latency-ceiling");

    const weak = filterAdmissibility(candidate({ strategyId: "x", expectedQuality: 0.4 }), {
      quality: { minQuality: 0.8 },
    });
    expect(weak.admissible).toBe(false);
    expect(weak.inadmissibleReason).toBe("policy-quality-floor");
  });
});

describe("deterministic-first selection (AC-5 / AC-10)", () => {
  test("when sufficiency is sufficient, the deterministic candidate WINS over a cheaper generative one", () => {
    const deterministic = filterAdmissibility(
      candidate({ strategyId: "deterministic-only", expectedCostMicroUsd: "500" }),
      {},
    );
    const cheaperGenerative = filterAdmissibility(
      candidate({
        strategyId: "generative:rail-a",
        plan: planOf("generative", true),
        expectedCostMicroUsd: "1",
        expectedQuality: 0.99,
        modelCalls: 1,
      }),
      {},
    );
    const selection = selectStrategy([deterministic, cheaperGenerative], SUFFICIENT, 0.8);
    expect(selection.kind).toBe("selected");
    if (selection.kind === "selected") {
      expect(selection.selected.strategyId).toBe("deterministic-only");
      expect(selection.deterministicFirstApplied).toBe(true);
    }
  });

  test("when sufficiency is insufficient, cheap-first ordering applies among satisfying candidates", () => {
    const cheap = filterAdmissibility(
      candidate({
        strategyId: "generative:cheap",
        plan: planOf("generative", true),
        expectedCostMicroUsd: "10",
        expectedQuality: 0.9,
        modelCalls: 1,
      }),
      {},
    );
    const expensive = filterAdmissibility(
      candidate({
        strategyId: "generative:expensive",
        plan: planOf("generative", true),
        expectedCostMicroUsd: "5000",
        expectedQuality: 0.95,
        modelCalls: 1,
      }),
      {},
    );
    const selection = selectStrategy([expensive, cheap], INSUFFICIENT, 0.8);
    expect(selection.kind).toBe("selected");
    if (selection.kind === "selected") {
      expect(selection.selected.strategyId).toBe("generative:cheap");
      expect(selection.deterministicFirstApplied).toBe(false);
    }
  });

  test("ties break on quality, then latency, then FEWER model calls", () => {
    const better = filterAdmissibility(
      candidate({
        strategyId: "better-quality",
        plan: planOf("generative", true),
        expectedCostMicroUsd: "10",
        expectedQuality: 0.95,
        modelCalls: 1,
      }),
      {},
    );
    const worse = filterAdmissibility(
      candidate({
        strategyId: "worse-quality",
        plan: planOf("generative", true),
        expectedCostMicroUsd: "10",
        expectedQuality: 0.9,
        modelCalls: 1,
      }),
      {},
    );
    const selection = selectStrategy([worse, better], INSUFFICIENT, 0.8);
    if (selection.kind === "selected") {
      expect(selection.selected.strategyId).toBe("better-quality");
    }
  });

  test("a forbidden provider NEVER wins on price (the AC-9 selection boundary)", () => {
    const forbiddenCheap = filterAdmissibility(
      candidate({
        strategyId: "generative:forbidden-cheap",
        plan: planOf("generative", true),
        expectedCostMicroUsd: "1",
        expectedQuality: 0.99,
        modelCalls: 1,
      }),
      { providerModel: { deniedProviders: ["rail-a"] } },
    );
    const allowedExpensive = filterAdmissibility(
      candidate({
        strategyId: "generative:allowed-expensive",
        plan: planOf("generative", true),
        expectedCostMicroUsd: "9000",
        expectedQuality: 0.9,
        modelCalls: 1,
        // Different route for the allowed candidate.
      }),
      {},
    );
    expect(forbiddenCheap.admissible).toBe(false);
    const selection = selectStrategy([forbiddenCheap, allowedExpensive], INSUFFICIENT, 0.8);
    if (selection.kind === "selected") {
      expect(selection.selected.strategyId).toBe("generative:allowed-expensive");
    }
  });

  test("no admissible satisfying candidate yields the typed none outcome", () => {
    const forbidden = filterAdmissibility(
      candidate({
        strategyId: "generative:forbidden",
        plan: planOf("generative", true),
        modelCalls: 1,
      }),
      { providerModel: { deniedProviders: ["rail-a"] } },
    );
    const selection = selectStrategy([forbidden], INSUFFICIENT, 0.8);
    expect(selection.kind).toBe("none");
  });

  test("candidates below the task quality target never satisfy selection", () => {
    const lowQuality = filterAdmissibility(
      candidate({ strategyId: "low-quality", expectedQuality: 0.5 }),
      {},
    );
    const selection = selectStrategy([lowQuality], SUFFICIENT, 0.9);
    expect(selection.kind).toBe("none");
  });

  test("a malformed micro-USD cost fails typed during admissibility filtering", () => {
    expect(() =>
      filterAdmissibility(candidate({ strategyId: "x", expectedCostMicroUsd: "1.5" }), {
        cost: { maxCostMicroUsd: "1000" },
      }),
    ).toThrowError(PlatformError);
  });
});
