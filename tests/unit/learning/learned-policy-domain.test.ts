/**
 * Unit: the learned planning-policy domain (learning module; WORK-020 /
 * LRN-002) — mining, evaluation, closed-shape validation and the digest
 * bases of `learned-planning-policy.ts`.
 *
 * Every negative case proves a fail-closed typed failure (PROVIDER_ERROR
 * from the canonical taxonomy) — the honest-evidence floor, the
 * rollback-metadata discipline, the canary-binding requirement and the
 * shadow-unrepresentable-as-publication-mode invariant.
 */

import { describe, expect, test } from "vitest";
import type { ExecutionOutcomeTelemetry } from "../../../src/modules/learning/public";
import {
  type EvaluationScorecardLike,
  evaluateLearnedPolicyAgainstScorecard,
  isLearnedPolicyEvaluationKind,
  isLearnedPolicyPublicationMode,
  LEARNED_POLICY_ANALYSIS_VERSION,
  LEARNED_POLICY_CLASS,
  LEARNED_POLICY_PUBLICATION_MODES,
  LEARNED_POLICY_PUBLICATION_REASONS,
  type LearnedPlanningPolicy,
  type LearnedPolicyEvaluation,
  type LearnedPolicyPublication,
  learnedPolicyDigestBasis,
  learnedPolicyEvaluationDigestBasis,
  learnedPolicyPublicationDigestBasis,
  MINIMUM_PREFERENCE_POPULATION,
  mineLearnedRoutePreferences,
  validateLearnedPlanningPolicy,
  validateLearnedPolicyEvaluation,
  validateLearnedPolicyPublication,
} from "../../../src/modules/learning/public";
import { PlatformError } from "../../../src/shared/errors";

const APP_ID = "00000000-0000-7000-8000-0000000000f1";
const TENANT_ID = "00000000-0000-7000-8000-0000000000f2";

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${String(idCounter).padStart(4, "0")}`;
}

/** An honest telemetry datum (the immutable population unit). */
function datum(
  overrides: Partial<ExecutionOutcomeTelemetry> & {
    readonly route?: { provider: string; model: string };
  } = {},
): ExecutionOutcomeTelemetry {
  const { route, ...rest } = overrides;
  return {
    telemetryId: nextId("tel"),
    executionId: nextId("exec"),
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    taskClass: "generation",
    capabilities: ["text-generation"],
    planId: "plan-1",
    planRevision: 1,
    strategyClass: "generative",
    routes: [route ?? { provider: "rail-a", model: "model-x" }],
    tools: [],
    environments: [],
    verification: {
      resultIds: ["ver-1"],
      statuses: ["PASS"],
      evaluatorIds: ["deterministic:schema@1"],
      passCount: 1,
      failCount: 0,
      inconclusiveCount: 0,
      verified: true,
    },
    costMicroUsd: "1000",
    latencyMs: 2000,
    outcome: "execution-completed",
    evidenceRefs: ["execution:1:receipt"],
    subgraphs: [],
    recordedAt: "2026-09-01T10:00:00Z",
    schemaVersion: 1,
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Mining: route preferences from the immutable population
// ---------------------------------------------------------------------------

describe("learning domain: mineLearnedRoutePreferences", () => {
  test("subjects below the population floor are never ranked (honest-evidence floor)", () => {
    const population: ExecutionOutcomeTelemetry[] = [];
    for (let index = 0; index < MINIMUM_PREFERENCE_POPULATION - 1; index += 1) {
      population.push(datum({ recordedAt: `2026-09-01T10:0${index}:00Z` }));
    }
    const preferences = mineLearnedRoutePreferences(population);
    expect(preferences).toEqual([]);
  });

  test("ranking is success-rate descending with the deterministic tie-breaks", () => {
    const population: ExecutionOutcomeTelemetry[] = [];
    // rail-a/model-x: 6 observations, 3 successes (rate 0.5).
    for (let index = 0; index < 6; index += 1) {
      population.push(
        datum({
          route: { provider: "rail-a", model: "model-x" },
          outcome: index < 3 ? "execution-completed" : "execution-failed",
          recordedAt: `2026-09-01T10:${String(index).padStart(2, "0")}:00Z`,
        }),
      );
    }
    // rail-b/model-y: 6 observations, 5 successes (rate 0.833).
    for (let index = 0; index < 6; index += 1) {
      population.push(
        datum({
          route: { provider: "rail-b", model: "model-y" },
          outcome: index < 5 ? "execution-completed" : "execution-failed",
          recordedAt: `2026-09-01T11:${String(index).padStart(2, "0")}:00Z`,
        }),
      );
    }
    const preferences = mineLearnedRoutePreferences(population);
    expect(preferences).toHaveLength(1);
    const preference = preferences[0];
    expect(preference?.taskClass).toBe("generation");
    expect(preference?.ranked.map((metric) => metric.subjectKey)).toEqual([
      "rail-b/model-y",
      "rail-a/model-x",
    ]);
    expect(preference?.ranked[0]?.population).toBe(6);
    expect(preference?.ranked[0]?.successCount).toBe(5);
    expect(preference?.ranked[0]?.successRate).toBeCloseTo(5 / 6, 6);
    // Provenance is mandatory and sorted.
    expect(preference?.sourceExecutionIds).toHaveLength(12);
    expect(preference?.sourceExecutionIds).toEqual(
      [...(preference?.sourceExecutionIds ?? [])].sort(),
    );
    expect(preference?.evidenceRefs.length).toBeGreaterThan(0);
    // The window is the honest observation window.
    expect(preference?.windowFrom).toBe("2026-09-01T10:00:00Z");
    expect(preference?.windowTo).toBe("2026-09-01T11:05:00Z");
  });

  test("equal success rates tie-break on lower mean cost, then latency, then key", () => {
    const population: ExecutionOutcomeTelemetry[] = [];
    for (let index = 0; index < 6; index += 1) {
      population.push(
        datum({
          route: { provider: "rail-a", model: "model-x" },
          costMicroUsd: "5000",
          latencyMs: 300,
          recordedAt: `2026-09-01T10:${String(index).padStart(2, "0")}:00Z`,
        }),
      );
    }
    for (let index = 0; index < 6; index += 1) {
      population.push(
        datum({
          route: { provider: "rail-b", model: "model-y" },
          costMicroUsd: "1000",
          latencyMs: 900,
          recordedAt: `2026-09-01T11:${String(index).padStart(2, "0")}:00Z`,
        }),
      );
    }
    const [preference] = mineLearnedRoutePreferences(population);
    expect(preference?.ranked.map((metric) => metric.subjectKey)).toEqual([
      "rail-b/model-y",
      "rail-a/model-x",
    ]);
  });

  test("task classes partition; a class without ANY qualifying subject produces no preference", () => {
    const population: ExecutionOutcomeTelemetry[] = [];
    for (let index = 0; index < 6; index += 1) {
      population.push(datum({ taskClass: "generation" }));
    }
    // The summarize class has only 2 observations — below the floor.
    for (let index = 0; index < 2; index += 1) {
      population.push(datum({ taskClass: "summarize" }));
    }
    const preferences = mineLearnedRoutePreferences(population);
    expect(preferences.map((preference) => preference.taskClass)).toEqual(["generation"]);
  });

  test("uncertainty is honest: the small-sample spread is recorded, never collapsed", () => {
    const population: ExecutionOutcomeTelemetry[] = [];
    // population 5 → spread 2*sqrt(0.25/5) ≈ 0.447 → 'high'.
    for (let index = 0; index < 5; index += 1) {
      population.push(
        datum({
          route: { provider: "rail-a", model: "model-x" },
          recordedAt: `2026-09-01T10:${String(index).padStart(2, "0")}:00Z`,
        }),
      );
    }
    // population 26 → spread 2*sqrt(0.25/26) ≈ 0.196 → 'low'.
    for (let index = 0; index < 26; index += 1) {
      population.push(
        datum({
          route: { provider: "rail-b", model: "model-y" },
          recordedAt: `2026-09-02T10:${String(index % 60).padStart(2, "0")}:00Z`,
        }),
      );
    }
    const [preference] = mineLearnedRoutePreferences(population);
    const byKey = new Map(preference?.ranked.map((metric) => [metric.subjectKey, metric]));
    expect(byKey.get("rail-a/model-x")?.uncertaintyLevel).toBe("high");
    expect(byKey.get("rail-b/model-y")?.uncertaintyLevel).toBe("low");
    // The whole-preference confidence is the WORST ranked subject.
    expect(preference?.confidence.level).toBe("high");
    expect(preference?.confidence.reasonCode).toBe("binomial-spread");
  });

  test("an empty population produces an empty result (no fabricated guidance)", () => {
    expect(mineLearnedRoutePreferences([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Evaluation against a durable scorecard
// ---------------------------------------------------------------------------

function scorecard(entries: EvaluationScorecardLike["entries"]): EvaluationScorecardLike {
  return {
    scorecardId: "sc-1",
    scorecardVersion: 4,
    definitionId: "route-outcome-by-task-class",
    definitionVersion: 1,
    telemetrySchemaVersion: 1,
    populationFrom: "2026-08-01T00:00:00Z",
    populationTo: "2026-09-01T00:00:00Z",
    entries,
  };
}

function policyWithTopSubject(subjectKey: string): LearnedPlanningPolicy {
  const population: ExecutionOutcomeTelemetry[] = [];
  for (let index = 0; index < 30; index += 1) {
    population.push(
      datum({
        route: {
          provider: subjectKey.slice(0, subjectKey.indexOf("/")),
          model: subjectKey.slice(subjectKey.indexOf("/") + 1),
        },
        outcome: index < 27 ? "execution-completed" : "execution-failed",
        recordedAt: `2026-09-03T10:${String(index % 60).padStart(2, "0")}:00Z`,
      }),
    );
  }
  const [preference] = mineLearnedRoutePreferences(population);
  if (preference === undefined) {
    throw new Error("test setup: preference expected");
  }
  return {
    policyClass: LEARNED_POLICY_CLASS,
    policyId: "policy-1",
    policyVersion: 1,
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    analysisVersion: LEARNED_POLICY_ANALYSIS_VERSION,
    telemetrySchemaVersion: 1,
    populationFingerprint: "fingerprint-1",
    totalPopulation: population.length,
    evaluationWindowFrom: "2026-08-01T00:00:00Z",
    evaluationWindowTo: "2026-09-04T00:00:00Z",
    preferences: [preference],
    rollback: { rollbackToPolicyVersion: null, priorPolicyDigest: null, note: "first version" },
    generatedAt: "2026-09-04T00:00:00Z",
    digest: "digest-1",
    policySchemaVersion: 1,
  };
}

describe("learning domain: evaluateLearnedPolicyAgainstScorecard", () => {
  test("a null scorecard is insufficient-evidence with the honest 'none' basis", () => {
    const outcome = evaluateLearnedPolicyAgainstScorecard(
      policyWithTopSubject("rail-a/model-x"),
      null,
    );
    expect(outcome.status).toBe("insufficient-evidence");
    expect(outcome.verdict).toBeNull();
    expect(outcome.metrics).toBeNull();
    expect(outcome.basis).toEqual({ kind: "none" });
    expect(outcome.evidenceRefs).toEqual([]);
  });

  test("the basis records the EXACT scorecard version consulted (revision-bound evidence)", () => {
    const policy = policyWithTopSubject("rail-a/model-x");
    const outcome = evaluateLearnedPolicyAgainstScorecard(
      policy,
      scorecard([
        {
          subjectKind: "route",
          subjectKey: "rail-a/model-x",
          taskClass: "generation",
          population: 30,
          successCount: 27,
          successRate: 0.9,
          meanCostMicroUsd: "1000",
          evidenceRefs: ["execution:a:receipt"],
          sourceExecutionIds: ["exec-a"],
        },
      ]),
    );
    expect(outcome.status).not.toBe("insufficient-evidence");
    expect(outcome.basis).toEqual({
      kind: "scorecard",
      scorecardId: "sc-1",
      scorecardVersion: 4,
      definitionId: "route-outcome-by-task-class",
      definitionVersion: 1,
      telemetrySchemaVersion: 1,
      populationWindowFrom: "2026-08-01T00:00:00Z",
      populationWindowTo: "2026-09-01T00:00:00Z",
    });
  });

  test("overlapping spreads are INCONCLUSIVE (uncertainty preserved, never collapsed)", () => {
    const policy = policyWithTopSubject("rail-a/model-x");
    // Learned top subject: population 30 (rate 0.9, spread ≈ 0.18).
    // Baseline (cheapest qualifying): population 8 (rate 0.5, spread ≈ 0.35).
    // |0.9 − 0.5| = 0.4 ≤ 0.18 + 0.35 → overlap → inconclusive.
    const outcome = evaluateLearnedPolicyAgainstScorecard(
      policy,
      scorecard([
        {
          subjectKind: "route",
          subjectKey: "rail-a/model-x",
          taskClass: "generation",
          population: 30,
          successCount: 27,
          successRate: 0.9,
          meanCostMicroUsd: "1000",
          evidenceRefs: ["execution:a:receipt"],
          sourceExecutionIds: ["exec-a"],
        },
        {
          subjectKind: "route",
          subjectKey: "rail-cheap/model-z",
          taskClass: "generation",
          population: 8,
          successCount: 4,
          successRate: 0.5,
          meanCostMicroUsd: "100",
          evidenceRefs: ["execution:b:receipt"],
          sourceExecutionIds: ["exec-b"],
        },
      ]),
    );
    expect(outcome.status).toBe("inconclusive");
    expect(outcome.verdict).toBe("inconclusive");
    expect(outcome.comparison?.preferred).toBe("inconclusive");
    expect(outcome.metrics?.taskClasses).toEqual(["generation"]);
  });

  test("non-overlapping spreads produce the honest winner (prefer-learned)", () => {
    const policy = policyWithTopSubject("rail-a/model-x");
    const outcome = evaluateLearnedPolicyAgainstScorecard(
      policy,
      scorecard([
        {
          subjectKind: "route",
          subjectKey: "rail-a/model-x",
          taskClass: "generation",
          population: 30,
          successCount: 29,
          successRate: 0.9667,
          meanCostMicroUsd: "1000",
          evidenceRefs: ["execution:a:receipt"],
          sourceExecutionIds: ["exec-a"],
        },
        {
          subjectKind: "route",
          subjectKey: "rail-cheap/model-z",
          taskClass: "generation",
          population: 50,
          successCount: 20,
          successRate: 0.4,
          meanCostMicroUsd: "100",
          evidenceRefs: ["execution:b:receipt"],
          sourceExecutionIds: ["exec-b"],
        },
      ]),
    );
    expect(outcome.status).toBe("evaluated");
    expect(outcome.verdict).toBe("prefer-learned");
    expect(outcome.comparison?.preferred).toBe("learned");
    expect(outcome.evidenceRefs).toContain("execution:b:receipt");
    expect(outcome.sourceExecutionIds).toContain("exec-b");
  });

  test("no comparable pair for any task class is insufficient-evidence", () => {
    const policy = policyWithTopSubject("rail-a/model-x");
    // The scorecard has entries only for OTHER task classes.
    const outcome = evaluateLearnedPolicyAgainstScorecard(
      policy,
      scorecard([
        {
          subjectKind: "route",
          subjectKey: "rail-a/model-x",
          taskClass: "summarize",
          population: 30,
          successCount: 27,
          successRate: 0.9,
          meanCostMicroUsd: "1000",
          evidenceRefs: ["execution:a:receipt"],
          sourceExecutionIds: ["exec-a"],
        },
      ]),
    );
    expect(outcome.status).toBe("insufficient-evidence");
    expect(outcome.verdict).toBeNull();
    // The basis is still recorded — the evaluation consulted the exact version.
    expect(outcome.basis.kind).toBe("scorecard");
  });
});

// ---------------------------------------------------------------------------
// Closed-shape validation (fail-closed, typed)
// ---------------------------------------------------------------------------

describe("learning domain: validateLearnedPlanningPolicy (fail closed)", () => {
  function validPolicy(): LearnedPlanningPolicy {
    const population: ExecutionOutcomeTelemetry[] = [];
    for (let index = 0; index < 6; index += 1) {
      population.push(
        datum({
          route: { provider: "rail-a", model: "model-x" },
          outcome: index < 5 ? "execution-completed" : "execution-failed",
        }),
      );
    }
    const [preference] = mineLearnedRoutePreferences(population);
    return {
      policyClass: LEARNED_POLICY_CLASS,
      policyId: "policy-1",
      policyVersion: 2,
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      analysisVersion: LEARNED_POLICY_ANALYSIS_VERSION,
      telemetrySchemaVersion: 1,
      populationFingerprint: "fp",
      totalPopulation: 6,
      evaluationWindowFrom: null,
      evaluationWindowTo: "2026-09-04T00:00:00Z",
      preferences: [preference as never],
      rollback: {
        rollbackToPolicyVersion: 1,
        priorPolicyDigest: "digest-v1",
        note: "rollback target",
      },
      generatedAt: "2026-09-04T00:00:00Z",
      digest: "digest-2",
      policySchemaVersion: 1,
    };
  }

  test("a well-formed artifact validates", () => {
    expect(() => validateLearnedPlanningPolicy(validPolicy())).not.toThrow();
  });

  test("the frozen non-authority class is mandatory", () => {
    const policy = { ...validPolicy(), policyClass: "authoritative-planning-policy" };
    expect(() => validateLearnedPlanningPolicy(policy)).toThrow(PlatformError);
  });

  test("an artifact without preferences is unrepresentable", () => {
    const policy = { ...validPolicy(), preferences: [] };
    expect(() => validateLearnedPlanningPolicy(policy)).toThrow(/preferences/);
  });

  test("a ranked subject below the population floor is unrepresentable", () => {
    const policy = validPolicy();
    const mutated = {
      ...policy,
      preferences: [
        {
          ...policy.preferences[0],
          ranked: [
            {
              ...(policy.preferences[0]?.ranked[0] as unknown as Record<string, unknown>),
              population: MINIMUM_PREFERENCE_POPULATION - 1,
              successCount: 1,
            },
          ],
        },
      ],
    };
    expect(() => validateLearnedPlanningPolicy(mutated)).toThrow(/population floor/);
  });

  test("successCount beyond population is unrepresentable", () => {
    const policy = validPolicy();
    const mutated = {
      ...policy,
      preferences: [
        {
          ...policy.preferences[0],
          ranked: [
            {
              ...(policy.preferences[0]?.ranked[0] as unknown as Record<string, unknown>),
              successCount: 99,
            },
          ],
        },
      ],
    };
    expect(() => validateLearnedPlanningPolicy(mutated)).toThrow(/successCount/);
  });

  test("rollback metadata must point at a STRICTLY earlier version", () => {
    const policy = validPolicy();
    const mutated = {
      ...policy,
      rollback: { rollbackToPolicyVersion: 2, priorPolicyDigest: "d", note: "n" },
    };
    expect(() => validateLearnedPlanningPolicy(mutated)).toThrow(/STRICTLY EARLIER/);
  });

  test("a prior version without its digest is unrepresentable (deterministic rollback)", () => {
    const policy = validPolicy();
    const mutated = {
      ...policy,
      rollback: { rollbackToPolicyVersion: 1, priorPolicyDigest: null, note: "n" },
    };
    expect(() => validateLearnedPlanningPolicy(mutated)).toThrow(/prior digest/);
  });

  test("empty provenance arrays are rejected (provenance is mandatory)", () => {
    const policy = validPolicy();
    const mutated = {
      ...policy,
      preferences: [{ ...policy.preferences[0], sourceExecutionIds: [] }],
    };
    expect(() => validateLearnedPlanningPolicy(mutated)).toThrow(/sourceExecutionIds/);
  });
});

describe("learning domain: validateLearnedPolicyEvaluation (fail closed)", () => {
  function validEvaluation(
    overrides: Partial<LearnedPolicyEvaluation> = {},
  ): LearnedPolicyEvaluation {
    return {
      evaluationId: "eval-1",
      policyId: "policy-1",
      policyVersion: 1,
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      evaluationClass: "shadow",
      status: "insufficient-evidence",
      verdict: null,
      metrics: null,
      comparison: null,
      basis: { kind: "none" },
      canaryBinding: null,
      evidenceRefs: [],
      sourceExecutionIds: [],
      evaluatedAt: "2026-09-04T00:00:00Z",
      schemaVersion: 1,
      ...overrides,
    };
  }

  test("an honest shadow evaluation with a 'none' basis requires the insufficient status", () => {
    expect(() => validateLearnedPolicyEvaluation(validEvaluation())).not.toThrow();
    const mutated = validEvaluation({ status: "evaluated", verdict: "prefer-learned" });
    expect(() => validateLearnedPolicyEvaluation(mutated)).toThrow(/none/);
  });

  test("a canary evaluation MUST bind the exact canary publication (the ran-in-canary proof)", () => {
    const scorecardBasis = {
      kind: "scorecard",
      scorecardId: "sc-1",
      scorecardVersion: 4,
      definitionId: "route-outcome-by-task-class",
      definitionVersion: 1,
      telemetrySchemaVersion: 1,
      populationWindowFrom: null,
      populationWindowTo: "2026-09-01T00:00:00Z",
    } as const;
    const unbound = validEvaluation({
      evaluationClass: "canary",
      status: "inconclusive",
      verdict: "inconclusive",
      basis: scorecardBasis,
    });
    expect(() => validateLearnedPolicyEvaluation(unbound)).toThrow(/canary/i);

    const bound = validEvaluation({
      evaluationClass: "canary",
      status: "inconclusive",
      verdict: "inconclusive",
      basis: scorecardBasis,
      canaryBinding: { publicationId: "pub-1", publishedAt: "2026-09-04T00:00:00Z" },
    });
    expect(() => validateLearnedPolicyEvaluation(bound)).not.toThrow();
  });

  test("a canary evaluation cannot be insufficient-evidence (it observed the canary run)", () => {
    const mutated = validEvaluation({
      evaluationClass: "canary",
      status: "insufficient-evidence",
      verdict: null,
      canaryBinding: { publicationId: "pub-1", publishedAt: "2026-09-04T00:00:00Z" },
    });
    expect(() => validateLearnedPolicyEvaluation(mutated)).toThrow(/insufficient-evidence/);
  });

  test("only a canary evaluation may carry a canary binding", () => {
    const mutated = validEvaluation({
      canaryBinding: { publicationId: "pub-1", publishedAt: "2026-09-04T00:00:00Z" },
    });
    expect(() => validateLearnedPolicyEvaluation(mutated)).toThrow(/only a canary/);
  });

  test("an insufficient-evidence evaluation carries no verdict (uncertainty honesty)", () => {
    const mutated = validEvaluation({ verdict: "prefer-learned" });
    expect(() => validateLearnedPolicyEvaluation(mutated)).toThrow(/no verdict/);
  });

  test("the evaluation-kind vocabulary is closed", () => {
    expect(isLearnedPolicyEvaluationKind("shadow")).toBe(true);
    expect(isLearnedPolicyEvaluationKind("canary")).toBe(true);
    expect(isLearnedPolicyEvaluationKind("production")).toBe(false);
  });
});

describe("learning domain: validateLearnedPolicyPublication (fail closed)", () => {
  function validPublication(
    overrides: Partial<LearnedPolicyPublication> = {},
  ): LearnedPolicyPublication {
    return {
      publicationId: "pub-1",
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: "policy-1",
      policyVersion: 1,
      publicationMode: "canary",
      publicationReason: "initial",
      evaluationEvidence: [
        {
          evaluationId: "eval-1",
          evaluationClass: "shadow",
          evaluationDigest: "digest-e1",
          evaluatedAt: "2026-09-04T00:00:00Z",
        },
      ],
      publishedAt: "2026-09-04T01:00:00Z",
      publishedBy: "operator-1",
      publicationSchemaVersion: 1,
      ...overrides,
    };
  }

  test("a well-formed publication validates; the vocabularies are closed", () => {
    expect(() => validateLearnedPolicyPublication(validPublication())).not.toThrow();
    expect(LEARNED_POLICY_PUBLICATION_MODES).toEqual(["canary", "promoted"]);
    expect(LEARNED_POLICY_PUBLICATION_REASONS).toEqual(["initial", "rollback", "refresh"]);
    expect(isLearnedPolicyPublicationMode("shadow")).toBe(false);
  });

  test("shadow is UNREPRESENTABLE as a publication mode (it is pre-publication evaluation)", () => {
    const mutated = validPublication({ publicationMode: "shadow" as never });
    expect(() => validateLearnedPolicyPublication(mutated)).toThrow(/shadow/);
  });

  test("a publication without evaluation evidence is unrepresentable (the explicit gate)", () => {
    const mutated = validPublication({ evaluationEvidence: [] });
    expect(() => validateLearnedPolicyPublication(mutated)).toThrow(/evaluation evidence/);
  });

  test("an unversioned evidence reference is rejected", () => {
    const mutated = validPublication({
      evaluationEvidence: [
        { evaluationId: "", evaluationClass: "shadow", evaluationDigest: "d", evaluatedAt: "t" },
      ],
    });
    expect(() => validateLearnedPolicyPublication(mutated)).toThrow(/evaluation evidence/);
  });
});

// ---------------------------------------------------------------------------
// Digest bases (the canonical integrity anchors)
// ---------------------------------------------------------------------------

describe("learning domain: the canonical digest bases", () => {
  test("the policy basis covers every artifact field except the digest itself", () => {
    const basis = learnedPolicyDigestBasis(policyWithTopSubject("rail-a/model-x"));
    expect(Object.keys(basis).sort()).toEqual([
      "analysisVersion",
      "applicationId",
      "evaluationWindowFrom",
      "evaluationWindowTo",
      "generatedAt",
      "policyClass",
      "policyId",
      "policySchemaVersion",
      "policyVersion",
      "populationFingerprint",
      "preferences",
      "rollback",
      "telemetrySchemaVersion",
      "totalPopulation",
    ]);
  });

  test("the evaluation basis covers the full revision-bound record", () => {
    const evaluation: LearnedPolicyEvaluation = {
      evaluationId: "eval-1",
      policyId: "policy-1",
      policyVersion: 1,
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      evaluationClass: "canary",
      status: "inconclusive",
      verdict: "inconclusive",
      metrics: null,
      comparison: null,
      basis: { kind: "none" },
      canaryBinding: { publicationId: "pub-1", publishedAt: "2026-09-04T00:00:00Z" },
      evidenceRefs: ["e"],
      sourceExecutionIds: ["s"],
      evaluatedAt: "2026-09-04T00:00:00Z",
      schemaVersion: 1,
    };
    const basis = learnedPolicyEvaluationDigestBasis(evaluation);
    expect(basis.evaluationId).toBe("eval-1");
    expect(basis.canaryBinding).toEqual(evaluation.canaryBinding);
    expect(basis.evidenceRefs).toEqual(["e"]);
  });

  test("the publication basis covers the journal entry (content-derived identity)", () => {
    const publication: LearnedPolicyPublication = {
      publicationId: "pub-1",
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: "policy-1",
      policyVersion: 1,
      publicationMode: "promoted",
      publicationReason: "rollback",
      evaluationEvidence: [
        {
          evaluationId: "eval-1",
          evaluationClass: "shadow",
          evaluationDigest: "d",
          evaluatedAt: "t",
        },
      ],
      publishedAt: "2026-09-04T01:00:00Z",
      publishedBy: "operator-1",
      publicationSchemaVersion: 1,
    };
    const basis = learnedPolicyPublicationDigestBasis(publication);
    expect(basis.publicationMode).toBe("promoted");
    expect(basis.publicationReason).toBe("rollback");
    expect(basis.evaluationEvidence).toEqual([
      {
        evaluationId: "eval-1",
        evaluationClass: "shadow",
        evaluationDigest: "d",
        evaluatedAt: "t",
      },
    ]);
  });
});
