/**
 * Context-cost measurement tests (WORK-052 AC 1): bounded,
 * explicit-basis cost estimates for representative context
 * compositions; unattributed/unbounded claims are rejected
 * (fail-closed); determinism of the measurement.
 */

import { describe, expect, test } from "vitest";
import {
  ContextEconomicsError,
  type ContextSegmentKind,
  MAX_CONTEXT_SEGMENTS,
  MAX_SEGMENT_TOKENS,
} from "../../../../src/platform/context-economics/catalog";
import {
  type ContextComposition,
  measureContextCost,
  validateContextComposition,
  validateContextPricingBasis,
} from "../../../../src/platform/context-economics/cost";
import { canonicalJson } from "../../../../src/platform/execution-ir/canonical";
import type { CostBasisAttribution } from "../../../../src/platform/execution-ir/cost-model";
import { nodeDigest } from "./helpers";

const OBSERVED = { basis: "observed" as const, source: "context.tokenizer" };
const ESTIMATED = { basis: "estimated" as const, source: "context.estimator" };

function composition(
  segments: Array<{
    kind: ContextSegmentKind;
    tokenCount: number;
    basis?: CostBasisAttribution;
  }>,
): ContextComposition {
  return { segments: segments.map((s) => ({ ...s, basis: s.basis ?? OBSERVED })) };
}

describe("context-cost measurement", () => {
  test("measures a representative composition with totals and per-kind breakdown", () => {
    const measurement = measureContextCost(
      {
        composition: composition([
          { kind: "system-prompt", tokenCount: 1_200 },
          { kind: "tool-surface", tokenCount: 800 },
          { kind: "retrieved-context", tokenCount: 9_000 },
          { kind: "user-input", tokenCount: 42 },
        ]),
        pricing: { microUsdPerMillionTokens: "3000", basis: ESTIMATED },
      },
      nodeDigest,
    );
    expect(measurement.totalTokens).toBe(11_042);
    expect(measurement.segmentCount).toBe(4);
    expect(measurement.tokensByKind["system-prompt"]).toBe(1_200);
    expect(measurement.tokensByKind["tool-surface"]).toBe(800);
    expect(measurement.tokensByKind["retrieved-context"]).toBe(9_000);
    expect(measurement.tokensByKind["user-input"]).toBe(42);
    // ceil(11042 × 3000 / 1e6) = ceil(33.126) = 34.
    expect(measurement.expectedCostMicroUsd).toBe("34");
    // The stable prefix: system-prompt + tool-surface (leading run).
    expect(measurement.stablePrefixTokens).toBe(2_000);
    expect(measurement.stablePrefixSegments).toBe(2);
    // The composite basis is explicit (weakest input wins: estimated).
    expect(measurement.basis.basis).toBe("estimated");
    expect(measurement.basis.source).toContain("context-cost.composite");
    // The measurement is content-addressed.
    expect(measurement.measurementDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("ceil rounding keeps fractional per-token prices exact", () => {
    const measurement = measureContextCost(
      {
        composition: composition([{ kind: "user-input", tokenCount: 3 }]),
        pricing: { microUsdPerMillionTokens: "1000", basis: ESTIMATED },
      },
      nodeDigest,
    );
    // ceil(3 × 1000 / 1e6) = ceil(0.003) = 1 µUSD.
    expect(measurement.expectedCostMicroUsd).toBe("1");
  });

  test("observed basis wins only when every input is observed", () => {
    const measurement = measureContextCost(
      {
        composition: composition([{ kind: "user-input", tokenCount: 10 }]),
        pricing: { microUsdPerMillionTokens: "1000", basis: OBSERVED },
      },
      nodeDigest,
    );
    expect(measurement.basis.basis).toBe("observed");
  });

  test("the composition is validated: unknown kinds are rejected", () => {
    expect(() =>
      validateContextComposition({
        segments: [
          { kind: "magic-prompt" as unknown as ContextSegmentKind, tokenCount: 1, basis: OBSERVED },
        ],
      }),
    ).toThrow(ContextEconomicsError);
  });

  test("UNATTRIBUTED segments are rejected (the estimation-basis contract)", () => {
    expect(() =>
      validateContextComposition({
        segments: [
          {
            kind: "user-input",
            tokenCount: 1,
            basis: undefined as unknown as CostBasisAttribution,
          },
        ],
      }),
    ).toThrow(/estimation basis/);
    expect(() =>
      validateContextComposition({
        segments: [
          {
            kind: "user-input",
            tokenCount: 1,
            basis: { source: "context.tokenizer" } as unknown as CostBasisAttribution,
          },
        ],
      }),
    ).toThrow(ContextEconomicsError);
  });

  test("UNATTRIBUTED pricing is rejected", () => {
    expect(() => validateContextPricingBasis({ microUsdPerMillionTokens: "1000" })).toThrow(
      ContextEconomicsError,
    );
    expect(() =>
      validateContextPricingBasis({
        microUsdPerMillionTokens: "1000",
        basis: { basis: "guessed", source: "somewhere" },
      }),
    ).toThrow(/closed estimation vocabulary/);
  });

  test("UNBOUNDED claims are rejected (segments, tokens, price, total)", () => {
    expect(() =>
      validateContextComposition({
        segments: Array.from({ length: MAX_CONTEXT_SEGMENTS + 1 }, () => ({
          kind: "user-input",
          tokenCount: 1,
          basis: OBSERVED,
        })),
      }),
    ).toThrow(/segment bound/);
    expect(() =>
      validateContextComposition(
        composition([{ kind: "user-input", tokenCount: MAX_SEGMENT_TOKENS + 1 }]),
      ),
    ).toThrow(ContextEconomicsError);
    expect(() =>
      validateContextPricingBasis({
        microUsdPerMillionTokens: "9999999999999999999999",
        basis: OBSERVED,
      }),
    ).toThrow(ContextEconomicsError);
    // A total-exceeding composition is rejected at the bound.
    expect(() =>
      validateContextComposition({
        segments: Array.from({ length: 11 }, () => ({
          kind: "user-input",
          tokenCount: 1_000_000_000,
          basis: OBSERVED,
        })),
      }),
    ).toThrow(/total tokens exceed/);
    // A cost exceeding the money universe is rejected at measurement
    // (max legal total × max legal price exceeds the bounded universe).
    expect(() =>
      measureContextCost(
        {
          composition: {
            segments: Array.from({ length: 10 }, () => ({
              kind: "user-input",
              tokenCount: 1_000_000_000,
              basis: OBSERVED,
            })),
          },
          pricing: { microUsdPerMillionTokens: "999999999999999999", basis: OBSERVED },
        },
        nodeDigest,
      ),
    ).toThrow(/money universe/);
  });

  test("deterministic: identical inputs produce the identical measurement", () => {
    const input = {
      composition: composition([
        { kind: "system-prompt", tokenCount: 100 },
        { kind: "user-input", tokenCount: 5, basis: ESTIMATED },
      ]),
      pricing: { microUsdPerMillionTokens: "2000", basis: ESTIMATED },
    };
    const first = measureContextCost(input, nodeDigest);
    const second = measureContextCost(input, nodeDigest);
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.measurementDigest).toBe(second.measurementDigest);
  });
});
