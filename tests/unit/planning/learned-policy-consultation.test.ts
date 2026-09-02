/**
 * Unit: the learned-policy consultation domain (planning module;
 * WORK-020 / LRN-002) — the planning-side read seam of learned
 * planning policies.
 *
 * Negative guarantees proven here (the LRN-002 boundary):
 *  - a FORBIDDEN ranked subject never enters an ordering input
 *    (splitRankedSubjectsByPolicy / learnedOrderingSubjects);
 *  - a learned preference can never INTRODUCE an unregistered subject
 *    (unmatched subjects are recorded, never selected);
 *  - inadmissible candidates never become the learned preference;
 *  - the ordering key refines cheap-first only (ties keep the
 *    governed order);
 *  - unversioned/unprovenanced consulted records fail closed (never
 *    enter a decision record).
 */

import { describe, expect, test } from "vitest";
import {
  buildLearnedPolicyConsultation,
  CONSULTED_LEARNED_POLICY_CLASS,
  type ConsultedLearnedPolicy,
  type ConsultedLearnedRoutePreference,
  compareLearnedThenCheapFirst,
  LEARNED_PREFERENCE_MINIMUM_POPULATION,
  learnedOrderingSubjects,
  learnedPreferredCandidateId,
  splitRankedSubjectsByPolicy,
  validateConsultedLearnedPolicy,
  validateLearnedPolicyConsultation,
} from "../../../src/modules/planning/domain";
import type { CandidateStrategy } from "../../../src/modules/planning/public";
import { buildPlan, createNodeDigest } from "../../../src/modules/planning/public";
import type { RestrictionSet } from "../../../src/modules/policies/public";
import { PlatformError } from "../../../src/shared/errors";

const digest = createNodeDigest();

function metric(
  subjectKey: string,
  overrides: Partial<{ population: number; successCount: number; uncertaintyLevel: string }> = {},
): {
  readonly subjectKey: string;
  readonly population: number;
  readonly successCount: number;
  readonly successRate: number;
  readonly meanCostMicroUsd: string;
  readonly meanLatencyMs: number;
  readonly uncertaintyLevel: string;
} {
  const population = overrides.population ?? 12;
  const successCount = overrides.successCount ?? Math.floor(population * 0.9);
  return {
    subjectKey,
    population,
    successCount,
    successRate: successCount / population,
    meanCostMicroUsd: "1000",
    meanLatencyMs: 1500,
    uncertaintyLevel: overrides.uncertaintyLevel ?? "low",
  };
}

function preference(
  ranked: readonly ReturnType<typeof metric>[],
  taskClass = "generation",
): ConsultedLearnedRoutePreference {
  return {
    taskClass,
    ranked,
    confidenceLevel: "low",
    population: ranked.reduce((sum, entry) => sum + entry.population, 0),
    windowFrom: "2026-08-01T00:00:00Z",
    windowTo: "2026-08-31T00:00:00Z",
    evidenceRefs: ["execution:1:receipt"],
    sourceExecutionIds: ["exec-1"],
  };
}

function consultedPolicy(overrides: Partial<ConsultedLearnedPolicy> = {}): ConsultedLearnedPolicy {
  return {
    policyClass: CONSULTED_LEARNED_POLICY_CLASS,
    policyId: "policy-1",
    policyVersion: 2,
    publicationId: "pub-1",
    publicationMode: "promoted",
    publicationReason: "initial",
    analysisVersion: 1,
    telemetrySchemaVersion: 1,
    digest: "digest-1",
    evaluationWindowFrom: "2026-08-01T00:00:00Z",
    evaluationWindowTo: "2026-08-31T00:00:00Z",
    preferences: [
      preference([
        metric("rail-a/model-x"),
        metric("rail-b/model-y", { population: 20, successCount: 10 }),
      ]),
    ],
    publishedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function planOf(route: { provider: string; model: string } | null) {
  return buildPlan(
    {
      revision: 1,
      strategyClass: "generative",
      steps: [
        {
          id: "model",
          stepClass: "call-model",
          capabilityId: "text-generation",
          ...(route === null ? {} : { routeRef: { provider: route.provider, model: route.model } }),
        },
        { id: "verify", stepClass: "verify" },
      ],
      edges: [{ from: "model", to: "verify" }],
    },
    (value) => digest.sha256Hex(JSON.stringify(value)),
  );
}

function candidate(
  strategyId: string,
  route: { provider: string; model: string } | null,
  options: { readonly cost?: string; readonly admissible?: boolean } = {},
): CandidateStrategy {
  return {
    strategyId,
    plan: planOf(route),
    expectedCostMicroUsd: options.cost ?? "1000",
    expectedQuality: 0.9,
    expectedLatencyMs: 1500,
    verificationStrategy: "exact-recomputation",
    routeRationale: { code: "cheap-first-cascade", detail: "test" },
    modelCalls: 1,
    admissible: options.admissible ?? true,
  };
}

// ---------------------------------------------------------------------------
// The current-policy recheck (a forbidden subject never orders anything)
// ---------------------------------------------------------------------------

describe("planning domain: splitRankedSubjectsByPolicy / learnedOrderingSubjects", () => {
  test("a subject forbidden by deniedProviders is rejected", () => {
    const ranked = [metric("rail-a/model-x"), metric("rail-forbidden/model-hot")];
    const policy: RestrictionSet = {
      providerModel: { deniedProviders: ["rail-forbidden"] },
    };
    expect(splitRankedSubjectsByPolicy(ranked, policy)).toEqual({
      allowed: ["rail-a/model-x"],
      rejected: ["rail-forbidden/model-hot"],
    });
  });

  test("a subject outside allowedModels is rejected (allowlist semantics)", () => {
    const ranked = [metric("rail-a/model-x"), metric("rail-b/model-y")];
    const policy: RestrictionSet = {
      providerModel: { allowedModels: ["model-x"] },
    };
    expect(splitRankedSubjectsByPolicy(ranked, policy).allowed).toEqual(["rail-a/model-x"]);
  });

  test("a subject forbidden by deniedModels is rejected even when its provider is allowed", () => {
    const ranked = [metric("rail-a/model-x"), metric("rail-a/model-hot")];
    const policy: RestrictionSet = {
      providerModel: { deniedModels: ["model-hot"] },
    };
    expect(splitRankedSubjectsByPolicy(ranked, policy).rejected).toEqual(["rail-a/model-hot"]);
  });

  test("high-uncertainty subjects never enter the ordering input (honest evidence only)", () => {
    const pref = preference([
      metric("rail-a/model-x"),
      metric("rail-b/model-y", { uncertaintyLevel: "high" }),
    ]);
    const ordering = learnedOrderingSubjects(pref, {});
    expect(ordering).toEqual(["rail-a/model-x"]);
  });

  test("the ordering preserves the learned preference order among ALLOWED subjects", () => {
    const pref = preference([
      metric("rail-a/model-x"),
      metric("rail-b/model-y"),
      metric("rail-forbidden/model-hot"),
    ]);
    const ordering = learnedOrderingSubjects(pref, {
      providerModel: { deniedProviders: ["rail-forbidden"] },
    });
    expect(ordering).toEqual(["rail-a/model-x", "rail-b/model-y"]);
  });
});

// ---------------------------------------------------------------------------
// The learned preference among ADMISSIBLE candidates
// ---------------------------------------------------------------------------

describe("planning domain: learnedPreferredCandidateId / compareLearnedThenCheapFirst", () => {
  test("the candidate holding the top-ranked subject is preferred", () => {
    const pref = preference([metric("rail-a/model-x"), metric("rail-b/model-y")]);
    const candidates = [
      candidate("strategy-rail-b", { provider: "rail-b", model: "model-y" }),
      candidate("strategy-rail-a", { provider: "rail-a", model: "model-x" }),
    ];
    expect(learnedPreferredCandidateId(candidates, pref, {})).toBe("strategy-rail-a");
  });

  test("an INADMISSIBLE candidate never becomes the learned preference", () => {
    const pref = preference([metric("rail-a/model-x")]);
    const candidates = [
      candidate("strategy-rail-a", { provider: "rail-a", model: "model-x" }, { admissible: false }),
      candidate("strategy-rail-b", { provider: "rail-b", model: "model-y" }),
    ];
    expect(learnedPreferredCandidateId(candidates, pref, {})).toBeNull();
  });

  test("a learned preference CANNOT introduce an unregistered subject (no candidate matches)", () => {
    const pref = preference([metric("rail-ghost/model-unregistered")]);
    const candidates = [candidate("strategy-rail-b", { provider: "rail-b", model: "model-y" })];
    expect(learnedPreferredCandidateId(candidates, pref, {})).toBeNull();
  });

  test("a FORBIDDEN top subject never redirects the preference (the policy recheck)", () => {
    const pref = preference([metric("rail-a/model-x"), metric("rail-b/model-y")]);
    const candidates = [
      candidate("strategy-rail-a", { provider: "rail-a", model: "model-x" }),
      candidate("strategy-rail-b", { provider: "rail-b", model: "model-y" }),
    ];
    const policy: RestrictionSet = { providerModel: { deniedProviders: ["rail-a"] } };
    // rail-a is forbidden → the ordering falls to rail-b → the rail-b
    // strategy is the preference among ADMISSIBLE candidates.
    expect(learnedPreferredCandidateId(candidates, pref, policy)).toBe("strategy-rail-b");
  });

  test("compareLearnedThenCheapFirst: preferred subjects come first; ties keep cheap-first", () => {
    const order = ["rail-a/model-x"];
    const railB = candidate(
      "strategy-rail-b",
      { provider: "rail-b", model: "model-y" },
      { cost: "100" },
    );
    const railA = candidate(
      "strategy-rail-a",
      { provider: "rail-a", model: "model-x" },
      { cost: "900" },
    );
    expect(compareLearnedThenCheapFirst(railA, railB, order)).toBeLessThan(0);
    expect(compareLearnedThenCheapFirst(railB, railA, order)).toBeGreaterThan(0);
    // Candidates with NO ranked subject keep the pure cheap-first order.
    const unrankedCheap = candidate(
      "strategy-unranked-1",
      { provider: "rail-c", model: "model-z" },
      { cost: "50" },
    );
    const unrankedDear = candidate(
      "strategy-unranked-2",
      { provider: "rail-d", model: "model-w" },
      { cost: "500" },
    );
    expect(compareLearnedThenCheapFirst(unrankedDear, unrankedCheap, order)).toBeGreaterThan(0);
    // A ranked subject outranks an unranked cheaper candidate.
    expect(compareLearnedThenCheapFirst(railA, unrankedCheap, order)).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// The consultation capture + closed-shape validation
// ---------------------------------------------------------------------------

describe("planning domain: buildLearnedPolicyConsultation + validation", () => {
  test("the capture records the honest verdicts (rejected, unmatched, applied)", () => {
    const consulted = consultedPolicy({
      preferences: [
        preference([
          metric("rail-a/model-x"),
          metric("rail-forbidden/model-hot"),
          metric("rail-ghost/model-unregistered"),
        ]),
      ],
    });
    const capture = buildLearnedPolicyConsultation({
      candidates: [
        candidate("strategy-rail-a", { provider: "rail-a", model: "model-x" }),
        candidate(
          "strategy-rail-forbidden",
          { provider: "rail-forbidden", model: "model-hot" },
          {
            admissible: false,
          },
        ),
      ],
      consultedPolicy: consulted,
      taskClass: "generation",
      policy: { providerModel: { deniedProviders: ["rail-forbidden"] } },
      governedStrategyId: "strategy-rail-a",
      selectedStrategyId: "strategy-rail-a",
      appliedToSelection: false,
      consultedAt: "2026-09-01T00:00:00Z",
    });
    expect(capture.preferredStrategyId).toBe("strategy-rail-a");
    expect(capture.agreesWithSelection).toBe(true);
    expect(capture.appliedToSelection).toBe(false);
    expect(capture.rejectedByPolicy).toEqual(["rail-forbidden/model-hot"]);
    // Unmatched: subjects matching NO ADMISSIBLE candidate — the
    // forbidden candidate is inadmissible, so BOTH it and the ghost
    // subject are unmatched (a learned preference cannot introduce
    // either; both are recorded as honest evidence).
    expect(capture.unmatchedSubjects).toEqual([
      "rail-forbidden/model-hot",
      "rail-ghost/model-unregistered",
    ]);
    expect(() => validateLearnedPolicyConsultation(capture)).not.toThrow();
  });

  test("an unmatched subject is recorded even when it is also forbidden (both verdicts honest)", () => {
    const consulted = consultedPolicy({
      preferences: [preference([metric("rail-ghost/model-hot")])],
    });
    const capture = buildLearnedPolicyConsultation({
      candidates: [candidate("strategy-rail-a", { provider: "rail-a", model: "model-x" })],
      consultedPolicy: consulted,
      taskClass: "generation",
      policy: { providerModel: { deniedProviders: ["rail-ghost"] } },
      governedStrategyId: "strategy-rail-a",
      selectedStrategyId: "strategy-rail-a",
      appliedToSelection: false,
      consultedAt: "2026-09-01T00:00:00Z",
    });
    expect(capture.rejectedByPolicy).toEqual(["rail-ghost/model-hot"]);
    expect(capture.unmatchedSubjects).toEqual(["rail-ghost/model-hot"]);
    expect(capture.preferredStrategyId).toBeNull();
  });

  test("no preference for the task class ⇒ an empty consultation with no preference", () => {
    const capture = buildLearnedPolicyConsultation({
      candidates: [candidate("strategy-rail-a", { provider: "rail-a", model: "model-x" })],
      consultedPolicy: consultedPolicy({
        preferences: [preference([metric("rail-a/model-x")], "summarize")],
      }),
      taskClass: "generation",
      policy: {},
      governedStrategyId: "strategy-rail-a",
      selectedStrategyId: "strategy-rail-a",
      appliedToSelection: false,
      consultedAt: "2026-09-01T00:00:00Z",
    });
    expect(capture.preferredStrategyId).toBeNull();
    expect(capture.rejectedByPolicy).toEqual([]);
    expect(capture.unmatchedSubjects).toEqual([]);
  });

  test("validateConsultedLearnedPolicy fails closed on the unversioned/unprovenanced shapes", () => {
    expect(() => validateConsultedLearnedPolicy(consultedPolicy())).not.toThrow();

    expect(() => validateConsultedLearnedPolicy(consultedPolicy({ policyVersion: 0 }))).toThrow(
      PlatformError,
    );
    expect(() =>
      validateConsultedLearnedPolicy(consultedPolicy({ publicationMode: "shadow" as never })),
    ).toThrow(/canary.*promoted|promoted.*canary|shadow/i);
    expect(() => validateConsultedLearnedPolicy(consultedPolicy({ digest: "" }))).toThrow(
      PlatformError,
    );
    // Below the population floor.
    const small = consultedPolicy({
      preferences: [
        preference([
          metric("rail-a/model-x", { population: LEARNED_PREFERENCE_MINIMUM_POPULATION - 1 }),
        ]),
      ],
    });
    expect(() => validateConsultedLearnedPolicy(small)).toThrow(/population floor/);
    // Empty provenance.
    const unprovenanced = consultedPolicy({
      preferences: [preference([metric("rail-a/model-x")])],
    });
    const mutated = {
      ...unprovenanced,
      preferences: [{ ...unprovenanced.preferences[0], evidenceRefs: [] }],
    };
    expect(() => validateConsultedLearnedPolicy(mutated)).toThrow(/evidenceRefs/);
    // The frozen non-authority class is mandatory.
    expect(() =>
      validateConsultedLearnedPolicy(consultedPolicy({ policyClass: "authoritative" as never })),
    ).toThrow(/non-authority/);
  });

  test("validateLearnedPolicyConsultation fails closed on malformed captures", () => {
    const consulted = consultedPolicy();
    const base = {
      consultedPolicy: consulted,
      governedStrategyId: "strategy-1",
      preferredStrategyId: null,
      agreesWithSelection: true,
      appliedToSelection: false,
      rejectedByPolicy: [],
      unmatchedSubjects: [],
      consultedAt: "2026-09-01T00:00:00Z",
    };
    expect(() => validateLearnedPolicyConsultation(base)).not.toThrow();
    expect(() =>
      validateLearnedPolicyConsultation({ ...base, agreesWithSelection: "yes" as never }),
    ).toThrow(PlatformError);
    expect(() => validateLearnedPolicyConsultation({ ...base, consultedAt: "" })).toThrow(
      PlatformError,
    );
  });
});
