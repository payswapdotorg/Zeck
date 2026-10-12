/**
 * Measured-evidence facts unit suite (ACR-008 §4 / PCR-002): the
 * observed-reliability fact types — total validation (route shape,
 * probability bounds, latency-summary coherence, cooldown coherence,
 * explicit basis, window order, sample bounds, uniqueness, corpus
 * bound) and the content-derived auditable provenance statement
 * (determinism, boundedness, explicit basis carried).
 */

import { describe, expect, test } from "vitest";
import {
  FailureRecoveryError,
  MAX_MEASURED_ROUTE_FACTS,
  RECOVERY_PLAN_MODES,
} from "../../../../src/platform/failure-recovery/catalog";
import {
  measuredProvenanceOf,
  type ObservedReliabilityFacts,
  validateObservedReliabilityFacts,
} from "../../../../src/platform/failure-recovery/measured";
import { digest } from "./world";

function routeFact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    route: { provider: "rail-a", model: "model-x" },
    measuredSuccessRate: 0.93,
    latencySummary: { p50Ms: 120, p95Ms: 400 },
    cooldown: { active: false },
    basis: {
      sourceObservationId: "recovery-observer-1",
      windowStart: "2026-10-01T00:00:00.000Z",
      windowEnd: "2026-10-08T00:00:00.000Z",
      sampleCount: 4211,
    },
    ...overrides,
  };
}

function factsOf(routes: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { routes };
}

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

describe("measured-evidence facts (ACR-008 §4 — PCR-002)", () => {
  test("a fully-specified fact validates and round-trips its explicit basis", () => {
    const validated = validateObservedReliabilityFacts(factsOf([routeFact()]));
    expect(validated.routes).toHaveLength(1);
    expect(validated.routes[0]?.route).toEqual({ provider: "rail-a", model: "model-x" });
    expect(validated.routes[0]?.measuredSuccessRate).toBe(0.93);
    expect(validated.routes[0]?.latencySummary).toEqual({ p50Ms: 120, p95Ms: 400 });
    expect(validated.routes[0]?.cooldown).toEqual({ active: false });
    expect(validated.routes[0]?.basis).toEqual({
      sourceObservationId: "recovery-observer-1",
      windowStart: "2026-10-01T00:00:00.000Z",
      windowEnd: "2026-10-08T00:00:00.000Z",
      sampleCount: 4211,
    });
  });

  test("an active cooldown carries its remaining duration; an inactive one carries nothing", () => {
    const active = validateObservedReliabilityFacts(
      factsOf([routeFact({ cooldown: { active: true, remainingMs: 30_000 } })]),
    );
    expect(active.routes[0]?.cooldown).toEqual({ active: true, remainingMs: 30_000 });
    const inactive = validateObservedReliabilityFacts(factsOf([routeFact()]));
    expect(inactive.routes[0]?.cooldown).toEqual({ active: false });
  });

  test("the empty corpus is representable (presence without measured routes)", () => {
    const validated = validateObservedReliabilityFacts(factsOf([]));
    expect(validated.routes).toEqual([]);
  });

  test("route slugs are bounded and neutral (no free-typed routes)", () => {
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts(
        factsOf([routeFact({ route: { provider: "Not A Slug", model: "model-x" } })]),
      ),
    );
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts(factsOf([routeFact({ route: null })])),
    );
  });

  test("the measured success rate is a probability in [0, 1]", () => {
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts(factsOf([routeFact({ measuredSuccessRate: 1.5 })])),
    );
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts(factsOf([routeFact({ measuredSuccessRate: -0.1 })])),
    );
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts(factsOf([routeFact({ measuredSuccessRate: "high" })])),
    );
    // The inclusive endpoints are legal probabilities.
    expect(
      validateObservedReliabilityFacts(factsOf([routeFact({ measuredSuccessRate: 0 })])).routes[0]
        ?.measuredSuccessRate,
    ).toBe(0);
    expect(
      validateObservedReliabilityFacts(factsOf([routeFact({ measuredSuccessRate: 1 })])).routes[0]
        ?.measuredSuccessRate,
    ).toBe(1);
  });

  test("the latency summary is bounded and ordered (p95 >= p50)", () => {
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts(
        factsOf([routeFact({ latencySummary: { p50Ms: 500, p95Ms: 100 } })]),
      ),
    );
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts(
        factsOf([routeFact({ latencySummary: { p50Ms: 0, p95Ms: 100 } })]),
      ),
    );
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts(factsOf([routeFact({ latencySummary: null })])),
    );
  });

  test("the cooldown state is closed and coherent", () => {
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts(
        factsOf([routeFact({ cooldown: { active: false, remainingMs: 5 } })]),
      ),
    );
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts(
        factsOf([routeFact({ cooldown: { active: true, remainingMs: 0 } })]),
      ),
    );
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts(factsOf([routeFact({ cooldown: { active: "yes" } })])),
    );
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts(factsOf([routeFact({ cooldown: null })])),
    );
  });

  test("the explicit basis is REQUIRED in full (source identity, window, sample count)", () => {
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts(factsOf([routeFact({ basis: undefined })])),
    );
    const basis = routeFact().basis as Record<string, unknown>;
    for (const field of ["sourceObservationId", "windowStart", "windowEnd", "sampleCount"]) {
      const mutated = { ...basis, [field]: undefined };
      expectReject("measured-shape", () =>
        validateObservedReliabilityFacts(factsOf([routeFact({ basis: mutated })])),
      );
    }
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts(
        factsOf([routeFact({ basis: { ...basis, sampleCount: 0 } })]),
      ),
    );
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts(
        factsOf([
          routeFact({
            basis: {
              ...basis,
              windowStart: "2026-10-08T00:00:00.000Z",
              windowEnd: "2026-10-01T00:00:00.000Z",
            },
          }),
        ]),
      ),
    );
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts(
        factsOf([routeFact({ basis: { ...basis, windowStart: "not-an-instant" } })]),
      ),
    );
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts(
        factsOf([routeFact({ basis: { ...basis, sourceObservationId: "" } })]),
      ),
    );
  });

  test("the corpus is bounded and unique-route", () => {
    const over: Record<string, unknown>[] = [];
    const basisTemplate = routeFact().basis;
    if (typeof basisTemplate === "object" && basisTemplate !== null) {
      for (let index = 0; index < MAX_MEASURED_ROUTE_FACTS + 1; index += 1) {
        over.push(
          routeFact({
            route: { provider: `rail-${index}`, model: `model-${index}` },
            basis: { ...basisTemplate, sourceObservationId: `observer-${index}` },
          }),
        );
      }
    }
    expectReject("measured-shape", () => validateObservedReliabilityFacts(factsOf(over)));
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts(factsOf([routeFact(), routeFact()])),
    );
    expectReject("measured-shape", () =>
      validateObservedReliabilityFacts({ routes: "not-an-array" }),
    );
    expectReject("measured-shape", () => validateObservedReliabilityFacts(null));
    expectReject("measured-shape", () => validateObservedReliabilityFacts("facts"));
  });

  test("the provenance statement is deterministic, content-derived and bounded", () => {
    const facts: ObservedReliabilityFacts = validateObservedReliabilityFacts(
      factsOf([
        routeFact(),
        routeFact({
          route: { provider: "rail-b", model: "model-y" },
          basis: {
            sourceObservationId: "recovery-observer-2",
            windowStart: "2026-10-02T00:00:00.000Z",
            windowEnd: "2026-10-09T00:00:00.000Z",
            sampleCount: 99,
          },
        }),
      ]),
    );
    const first = measuredProvenanceOf(facts, digest);
    const second = measuredProvenanceOf(facts, digest);
    expect(first).toBe(second);
    expect(first).toMatch(/^measured;digest=[0-9a-f]{64};routes=2;samples=4310;/);
    expect(first).toContain("window=2026-10-01T00:00:00.000Z/2026-10-09T00:00:00.000Z");
    expect(first.length).toBeLessThanOrEqual(500);
    // A mutated fact produces a DIFFERENT digest (the provenance is
    // content-derived, never a template).
    const mutated = validateObservedReliabilityFacts(
      factsOf([routeFact({ measuredSuccessRate: 0.5 })]),
    );
    expect(measuredProvenanceOf(mutated, digest)).not.toBe(
      measuredProvenanceOf(validateObservedReliabilityFacts(factsOf([routeFact()])), digest),
    );
    // The empty corpus still carries its honest provenance.
    const empty = validateObservedReliabilityFacts(factsOf([]));
    expect(measuredProvenanceOf(empty, digest)).toMatch(/routes=0;samples=0;/);
  });

  test("the plan-mode vocabulary is closed with off as the declared default", () => {
    expect(RECOVERY_PLAN_MODES).toEqual(["off", "on"]);
  });
});
