/**
 * Optimization decision record unit tests (WORK-049).
 *
 * Proves: the full ADR-0020 evidence contract on every record
 * (constraints → candidates → selected → expectations → quality →
 * transformation basis → provenance), content-addressed identity
 * (idempotent re-build), total validation with both digest checks, and
 * the fail-closed rules (hard-constraint violations, zero constraints,
 * selections below the quality threshold).
 */

import { describe, expect, test } from "vitest";
import { createIrPlanSource } from "../../../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan, createNodeDigest } from "../../../../src/modules/planning/public";
import { canonicalJson } from "../../../../src/platform/execution-ir/canonical";
import type { OptimizationConstraint } from "../../../../src/platform/execution-ir/constraints";
import type { CandidateRepresentation } from "../../../../src/platform/execution-ir/cost-model";
import type { BuildDecisionInput } from "../../../../src/platform/execution-ir/decision-record";
import {
  buildOptimizationDecision,
  DecisionValidationError,
  TRANSFORMATION_BASIS_CODES,
  validateOptimizationDecision,
} from "../../../../src/platform/execution-ir/decision-record";
import { deriveExecutionIr } from "../../../../src/platform/execution-ir/ir";

const nodeDigest = createNodeDigest();
const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

const APPLICATION_ID = "00000000-0000-7000-8000-0000000000aa";
const TENANT_ID = "00000000-0000-7000-8000-0000000000bb";
const EXECUTION_ID = "00000000-0000-7000-8000-0000000000cc";

function baseIr() {
  const plan = buildPlan(
    {
      revision: 2,
      strategyClass: "hybrid",
      steps: [
        {
          id: "fetch-docs",
          stepClass: "retrieve",
          capabilityId: "document-retrieval",
        },
        {
          id: "summarize",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
        { id: "check-output", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      edges: [
        { from: "fetch-docs", to: "summarize" },
        { from: "summarize", to: "check-output" },
      ],
    },
    digestValue,
  );
  return deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest);
}

function constraints(): readonly OptimizationConstraint[] {
  return [
    {
      constraintId: "policy-eligibility",
      kind: "policy",
      enforcement: "hard",
      source: {
        authority: "policy",
        policySetId: "ps-1",
        policySetVersion: 3,
      },
      payload: { providerModel: { allowedProviders: ["rail-a"] } },
    },
    {
      constraintId: "policy-quality-floor",
      kind: "quality",
      enforcement: "hard",
      source: { authority: "policy", policySetId: "ps-1" },
      payload: { minQuality: 0.85 },
    },
    {
      constraintId: "verification-anchor",
      kind: "verification",
      enforcement: "hard",
      source: { authority: "verification" },
      payload: { requiresVerificationAnchor: true },
    },
  ];
}

function candidates(): readonly CandidateRepresentation[] {
  return [
    {
      candidateId: "deterministic-run",
      representationClass: "deterministic-computation",
      claim: {
        expectedCostMicroUsd: "20000",
        expectedLatencyMs: 200,
        expectedQuality: 0.95,
        expectedReliability: 1,
        basis: { basis: "observed", source: "learning.telemetry" },
      },
    },
    {
      candidateId: "model-route",
      representationClass: "sufficient-model",
      claim: {
        expectedCostMicroUsd: "500000",
        expectedLatencyMs: 2000,
        expectedQuality: 0.93,
        expectedReliability: 0.9,
        basis: { basis: "estimated", source: "planning.route-table" },
      },
    },
  ];
}

function buildInput(overrides: Record<string, unknown> = {}) {
  return {
    applicationId: APPLICATION_ID,
    tenantId: TENANT_ID,
    executionId: EXECUTION_ID,
    ir: baseIr(),
    constraints: constraints(),
    candidates: candidates(),
    qualityThreshold: 0.9,
    selectedCandidateId: "deterministic-run",
    transformationBasis: {
      code: "representation-substitution",
      detail:
        "The governed plan's model route can be represented by the deterministic capability for the retrieval+summarize subgraph; verification anchor preserved.",
    },
    recordedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  } as BuildDecisionInput;
}

describe("optimization decision records (WORK-049)", () => {
  test("the transformation basis vocabulary is closed to the foundation scope", () => {
    expect([...TRANSFORMATION_BASIS_CODES]).toEqual(["identity", "representation-substitution"]);
  });

  test("a decision records the full ADR-0020 evidence contract", () => {
    const record = buildOptimizationDecision(buildInput(), nodeDigest);
    expect(record.planId).toBe(buildInput().ir.planId);
    expect(record.irId).toBe(buildInput().ir.irId);
    expect(record.constraints).toHaveLength(3);
    expect(record.candidates).toHaveLength(2);
    expect(record.selectedCandidateId).toBe("deterministic-run");
    // Cost/latency expectations + quality expectation of the selection.
    expect(record.selectedExpectation).toMatchObject({
      candidateId: "deterministic-run",
      representationClass: "deterministic-computation",
      expectedCostMicroUsd: "20000",
      expectedLatencyMs: 200,
      expectedSuccessfulResolutionCostMicroUsd: "20000",
      basis: { basis: "observed", source: "learning.telemetry" },
    });
    // The per-candidate evaluations carry the quality expectation.
    expect(record.candidates[0]?.evaluation.qualityExpectation).toMatchObject({
      expectedQuality: 0.95,
      threshold: 0.9,
      meetsThreshold: true,
    });
    // Provenance: plan → IR → decision.
    expect(record.provenance).toEqual({
      planProvenance: { planId: record.planId, planRevision: 2 },
      derivationProvenance: {
        irId: record.irId,
        source: "planning.governed-plan",
      },
      recordedVia: "execution-ir-foundation",
    });
  });

  test("decision identity is content-derived and idempotent", () => {
    const first = buildOptimizationDecision(buildInput(), nodeDigest);
    const second = buildOptimizationDecision(buildInput(), nodeDigest);
    expect(second.decisionId).toBe(first.decisionId);
    expect(second.recordDigest).toBe(first.recordDigest);
    // Content drift (a different threshold) produces a different identity.
    const drifted = buildOptimizationDecision(buildInput({ qualityThreshold: 0.88 }), nodeDigest);
    expect(drifted.decisionId).not.toBe(first.decisionId);
  });

  test("total validation round-trips and detects tampering (both digests)", () => {
    const record = buildOptimizationDecision(buildInput(), nodeDigest);
    const roundTripped = validateOptimizationDecision(
      JSON.parse(JSON.stringify(record)),
      nodeDigest,
    );
    expect(roundTripped.decisionId).toBe(record.decisionId);

    // Tamper with the selected expectation: record digest must catch it.
    const tampered = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    (tampered.selectedExpectation as Record<string, unknown>).expectedCostMicroUsd = "1";
    expect(() => validateOptimizationDecision(tampered, nodeDigest)).toThrow(
      DecisionValidationError,
    );
    try {
      validateOptimizationDecision(tampered, nodeDigest);
    } catch (error) {
      expect((error as DecisionValidationError).invariant).toBe("decision-identity-mismatch");
    }
  });

  test("hard-constraint violations reject the decision before it exists", () => {
    // A budget ceiling the candidates exceed.
    const withBudget = [
      ...constraints(),
      {
        constraintId: "budget-monthly",
        kind: "budget",
        enforcement: "hard",
        source: { authority: "budget", budgetId: "b-1", scopeKind: "monthly" },
        payload: { maxCostMicroUsd: "10000" },
      },
    ];
    expect(() =>
      buildOptimizationDecision(buildInput({ constraints: withBudget }), nodeDigest),
    ).toThrow(DecisionValidationError);
    try {
      buildOptimizationDecision(buildInput({ constraints: withBudget }), nodeDigest);
    } catch (error) {
      expect((error as DecisionValidationError).invariant).toBe(
        "decision-hard-constraint-violation",
      );
    }
  });

  test("a decision without governing constraints is rejected (missing provenance)", () => {
    expect(() => buildOptimizationDecision(buildInput({ constraints: [] }), nodeDigest)).toThrow(
      DecisionValidationError,
    );
    try {
      buildOptimizationDecision(buildInput({ constraints: [] }), nodeDigest);
    } catch (error) {
      expect((error as DecisionValidationError).invariant).toBe("decision-provenance");
    }
  });

  test("selecting a candidate below the quality threshold is rejected", () => {
    const belowThreshold = [
      {
        candidateId: "cheap-insufficient",
        representationClass: "cache-reuse",
        claim: {
          expectedCostMicroUsd: "100",
          expectedLatencyMs: 100,
          expectedQuality: 0.5,
          expectedReliability: 1,
          basis: { basis: "defaulted", source: "capability-catalog-default" },
        },
      },
    ];
    // Isolate the selection-threshold rule: drop the policy quality
    // floor so only the decision's own quality threshold applies.
    const constraintsWithoutQualityFloor = constraints().filter(
      (constraint) => constraint.constraintId !== "policy-quality-floor",
    );
    expect(() =>
      buildOptimizationDecision(
        buildInput({
          constraints: constraintsWithoutQualityFloor,
          candidates: belowThreshold,
          selectedCandidateId: "cheap-insufficient",
        }),
        nodeDigest,
      ),
    ).toThrow(DecisionValidationError);
    try {
      buildOptimizationDecision(
        buildInput({
          constraints: constraintsWithoutQualityFloor,
          candidates: belowThreshold,
          selectedCandidateId: "cheap-insufficient",
        }),
        nodeDigest,
      );
    } catch (error) {
      expect((error as DecisionValidationError).invariant).toBe("decision-selection");
    }
  });

  test("selections referencing unknown candidates and bad shapes are rejected", () => {
    expect(() =>
      buildOptimizationDecision(buildInput({ selectedCandidateId: "not-recorded" }), nodeDigest),
    ).toThrow(DecisionValidationError);
    expect(() => buildOptimizationDecision(buildInput({ candidates: [] }), nodeDigest)).toThrow(
      DecisionValidationError,
    );
    expect(() =>
      buildOptimizationDecision(
        buildInput({
          transformationBasis: { code: "constant-folding", detail: "WORK-050 scope creep" },
        }),
        nodeDigest,
      ),
    ).toThrow(DecisionValidationError);
    expect(() =>
      buildOptimizationDecision(buildInput({ applicationId: "not-a-uuid" }), nodeDigest),
    ).toThrow(DecisionValidationError);
  });
});
