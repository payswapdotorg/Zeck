/**
 * Composition consultation tests (planning module domain; WORK-017).
 *
 * Required-test mapping (acceptance criterion 3 and §6/§9/§16):
 *  - the policy gate: a tool forbidden by the effective restriction set
 *    can NEVER qualify — regardless of the learning score (M5);
 *  - the preference among ADMISSIBLE candidates only (M1: a
 *    recommendation cannot authorize a forbidden route);
 *  - fail-closed validation: unversioned/unprovenanced/unpinned
 *    recommendations are rejected (M11/M12/M13/M26);
 *  - the consultation capture: preferredStrategyId/agreement recorded
 *    as EVIDENCE (never applied).
 */

import { describe, expect, test } from "vitest";
import {
  buildCompositionConsultation,
  type CandidateStrategy,
  COMPOSITION_PREFERENCE_MINIMUM_POPULATION,
  CONSULTED_COMPOSITION_CLASS,
  type ConsultedCompositionRecommendation,
  compositionAllowedByPolicy,
  compositionPreferredCandidateId,
  validateConsultedCompositionRecommendation,
} from "../../../src/modules/planning/public";
import { PlatformError } from "../../../src/shared/errors";

function consulted(
  overrides: Partial<ConsultedCompositionRecommendation> = {},
): ConsultedCompositionRecommendation {
  return {
    recommendationClass: CONSULTED_COMPOSITION_CLASS,
    taskClass: "extract",
    contextCapabilities: ["web-retrieval"],
    contextStrategyClass: "hybrid",
    toolVersions: [
      { toolId: "fetch", version: "1.0.0" },
      { toolId: "parse", version: "2.1.0" },
    ],
    toolCapabilityIds: ["web-retrieval", "parsing"],
    status: "supported",
    rank: 1,
    confidenceLevel: "low",
    population: 10,
    successCount: 9,
    successRate: 0.9,
    meanCostMicroUsd: "1200",
    meanLatencyMs: 900,
    setId: "set-1",
    setVersion: 1,
    analysisVersion: 1,
    compositionSchemaVersion: 1,
    recommendationSchemaVersion: 1,
    evaluationWindowFrom: "2026-08-01T00:00:00Z",
    evaluationWindowTo: "2026-08-31T00:00:00Z",
    evidenceRefs: ["execution:1:receipt"],
    sourceExecutionIds: ["exec-1"],
    ...overrides,
  };
}

function candidate(
  strategyId: string,
  capabilityIds: readonly string[],
  admissible = true,
): CandidateStrategy {
  return {
    strategyId,
    plan: {
      planId: `plan-${strategyId}`,
      revision: 1,
      strategyClass: "hybrid",
      steps: capabilityIds.map((capabilityId, index) => ({
        id: `s${index}`,
        stepClass: "call-tool" as const,
        capabilityId,
      })),
      edges: [],
      hasRouteRef: false,
    },
    admissible,
    ...(admissible ? {} : { inadmissibleReason: "policy-forbidden-route" }),
  } as unknown as CandidateStrategy;
}

describe("planning: the composition policy gate (M5)", () => {
  test("no tool restriction ⇒ allowed", () => {
    expect(compositionAllowedByPolicy(["fetch"], undefined)).toBe(true);
  });

  test("denied tools never qualify regardless of the learning score", () => {
    expect(compositionAllowedByPolicy(["fetch"], { deniedTools: ["fetch"] })).toBe(false);
    expect(compositionAllowedByPolicy(["fetch", "parse"], { deniedTools: ["parse"] })).toBe(false);
  });

  test("a non-empty allowlist excludes unlisted tools", () => {
    expect(compositionAllowedByPolicy(["fetch"], { allowedTools: ["fetch", "parse"] })).toBe(true);
    expect(compositionAllowedByPolicy(["ghost"], { allowedTools: ["fetch", "parse"] })).toBe(false);
  });

  test("a forbidden tool disqualifies the preference even with a GLOWING recommendation (M5/§9)", () => {
    const glowing = consulted({ population: 50, successCount: 50, successRate: 1, rank: 1 });
    const preferred = compositionPreferredCandidateId(
      [candidate("aligned", ["web-retrieval", "parsing"])],
      [glowing],
      { tool: { deniedTools: ["parse"] } },
    );
    expect(preferred).toBeNull();
  });
});

describe("planning: consulted recommendation validation (consumer side)", () => {
  test("a well-formed recommendation passes", () => {
    expect(() => validateConsultedCompositionRecommendation(consulted())).not.toThrow();
  });

  test("a recommendation without the non-authority class is rejected", () => {
    expect(() =>
      validateConsultedCompositionRecommendation(
        consulted({ recommendationClass: "authorization" as never }),
      ),
    ).toThrow(PlatformError);
  });

  test("unpinned tool versions are rejected (M26)", () => {
    expect(() =>
      validateConsultedCompositionRecommendation(
        consulted({ toolVersions: [{ toolId: "fetch", version: "" }] }),
      ),
    ).toThrow(PlatformError);
  });

  test("missing provenance is rejected (M11)", () => {
    expect(() =>
      validateConsultedCompositionRecommendation(consulted({ evidenceRefs: [] })),
    ).toThrow(PlatformError);
    expect(() =>
      validateConsultedCompositionRecommendation(consulted({ sourceExecutionIds: [] })),
    ).toThrow(PlatformError);
  });

  test("missing evaluation window is rejected (M12)", () => {
    expect(() =>
      validateConsultedCompositionRecommendation(consulted({ evaluationWindowTo: "" })),
    ).toThrow(PlatformError);
  });

  test("missing set anchors is rejected (M13)", () => {
    expect(() => validateConsultedCompositionRecommendation(consulted({ setId: "" }))).toThrow(
      PlatformError,
    );
    expect(() => validateConsultedCompositionRecommendation(consulted({ setVersion: 0 }))).toThrow(
      PlatformError,
    );
  });
});

describe("planning: the composition preference (evidence, never authority)", () => {
  test("the aligned ADMISSIBLE candidate is preferred by the best-ranked recommendation", () => {
    const preferred = compositionPreferredCandidateId(
      [candidate("aligned", ["web-retrieval", "parsing"]), candidate("other", ["translation"])],
      [consulted()],
      {},
    );
    expect(preferred).toBe("aligned");
  });

  test("inadmissible candidates NEVER qualify (M1)", () => {
    const preferred = compositionPreferredCandidateId(
      [candidate("aligned", ["web-retrieval", "parsing"], false)],
      [consulted()],
      {},
    );
    expect(preferred).toBeNull();
  });

  test("unsupported/inconclusive recommendations never inform the preference (M12)", () => {
    const preferred = compositionPreferredCandidateId(
      [candidate("aligned", ["web-retrieval", "parsing"])],
      [consulted({ status: "unsupported", rank: null })],
      {},
    );
    expect(preferred).toBeNull();
  });

  test("tiny populations never inform the preference (M10)", () => {
    const preferred = compositionPreferredCandidateId(
      [candidate("aligned", ["web-retrieval", "parsing"])],
      [consulted({ population: COMPOSITION_PREFERENCE_MINIMUM_POPULATION - 1 })],
      {},
    );
    expect(preferred).toBeNull();
  });

  test("high-uncertainty recommendations never inform the preference", () => {
    const preferred = compositionPreferredCandidateId(
      [candidate("aligned", ["web-retrieval", "parsing"])],
      [consulted({ confidenceLevel: "high" })],
      {},
    );
    expect(preferred).toBeNull();
  });

  test("the consultation capture records agreement/disagreement as EVIDENCE", () => {
    const consultation = buildCompositionConsultation({
      candidates: [candidate("aligned", ["web-retrieval", "parsing"])],
      recommendations: [consulted()],
      policy: {},
      selectedStrategyId: "aligned",
      consultedAt: "2026-09-01T00:00:00Z",
    });
    expect(consultation.preferredStrategyId).toBe("aligned");
    expect(consultation.agreesWithSelection).toBe(true);

    const disagreeing = buildCompositionConsultation({
      candidates: [candidate("aligned", ["web-retrieval", "parsing"])],
      recommendations: [consulted()],
      policy: {},
      selectedStrategyId: "other-selection",
      consultedAt: "2026-09-01T00:00:00Z",
    });
    expect(disagreeing.preferredStrategyId).toBe("aligned");
    expect(disagreeing.agreesWithSelection).toBe(false);
  });

  test("candidates without call-tool steps never align (honest no-preference)", () => {
    const preferred = compositionPreferredCandidateId(
      [candidate("model-only", [])],
      [consulted()],
      {},
    );
    expect(preferred).toBeNull();
  });
});
