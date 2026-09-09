/**
 * Compilation pipeline unit tests (WORK-050): the bounded deterministic
 * pass pipeline — total output validation, per-pass equivalence proof,
 * convergence bounds (fail-closed on non-convergence), determinism and
 * re-compile idempotence (byte-identical outputs and records), the
 * representation-ladder decision record (chosen and NOT chosen), the
 * full default pipeline over a representative governed-plan IR, and
 * the config-validation fail-closed rules.
 */

import { describe, expect, test } from "vitest";
import { createIrPlanSource } from "../../../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan, createNodeDigest } from "../../../../src/modules/planning/public";
import {
  CompilerError,
  type CompilerPassId,
  DEFAULT_MAX_PIPELINE_ROUNDS,
  DEFAULT_PIPELINE_PASSES,
  MAX_PIPELINE_ROUNDS_HARD,
  type RepresentationClaims,
} from "../../../../src/platform/execution-compiler/catalog";
import { compileExecutionIr } from "../../../../src/platform/execution-compiler/pipeline";
import { validateExecutionIrVariant } from "../../../../src/platform/execution-compiler/variant";
import { canonicalJson } from "../../../../src/platform/execution-ir/canonical";
import type { OptimizationConstraint } from "../../../../src/platform/execution-ir/constraints";
import { deriveExecutionIr } from "../../../../src/platform/execution-ir/ir";

const nodeDigest = createNodeDigest();
const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

const APPLICATION_ID = "00000000-0000-7000-8000-0000000000aa";
const TENANT_ID = "00000000-0000-7000-8000-0000000000bb";
const EXECUTION_ID = "00000000-0000-7000-8000-0000000000cc";
const RECORDED_AT = "2026-09-22T12:00:00.000Z";

function governedIr() {
  const plan = buildPlan(
    {
      revision: 5,
      strategyClass: "hybrid",
      steps: [
        {
          id: "fold-me",
          stepClass: "transform",
          config: { operation: "uppercase", inputs: ["abc"] },
        },
        {
          id: "junk",
          stepClass: "transform",
          config: { operation: "identity", inputs: [1] },
        },
        {
          id: "junk-sink",
          stepClass: "transform",
          config: { operation: "identity", inputs: [2] },
        },
        {
          id: "gen",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
        {
          id: "check",
          stepClass: "verify",
          verificationStrategy: "schema-check",
        },
      ],
      edges: [
        { from: "fold-me", to: "gen" },
        { from: "junk", to: "junk-sink" },
        { from: "gen", to: "check" },
      ],
    },
    digestValue,
  );
  return deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest);
}

function constraints(): OptimizationConstraint[] {
  return [
    {
      constraintId: "policy-eligibility",
      kind: "policy",
      enforcement: "hard",
      source: { authority: "policy", policySetId: "ps-1" },
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

function claims(): RepresentationClaims {
  return {
    base: {
      candidateId: "base-plan",
      representationClass: "sufficient-model",
      claim: {
        expectedCostMicroUsd: "500000",
        expectedLatencyMs: 2000,
        expectedQuality: 0.93,
        expectedReliability: 0.9,
        basis: { basis: "estimated" as const, source: "planning.route-table" },
      },
    },
    compiled: {
      candidateId: "compiled-variant",
      representationClass: "deterministic-computation",
      claim: {
        expectedCostMicroUsd: "100000",
        expectedLatencyMs: 400,
        expectedQuality: 0.95,
        expectedReliability: 1,
        basis: { basis: "observed" as const, source: "learning.telemetry" },
      },
    },
  };
}

describe("the compilation pipeline (WORK-050)", () => {
  test("compiles a governed IR through the full default pipeline with total validation and equivalence", () => {
    const result = compileExecutionIr({
      ir: governedIr(),
      constraints: constraints(),
      config: {
        passes: DEFAULT_PIPELINE_PASSES,
        maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
        qualityThreshold: 0.9,
      },
      digest: nodeDigest,
    });
    expect(result.changed).toBe(true);
    // The output is a fully valid variant (both content identities).
    expect(() => validateExecutionIrVariant(result.output, nodeDigest)).not.toThrow();
    // The preserved chain.
    expect(result.output.sourceIrId).toBe(result.inputVariant.sourceIrId);
    expect(result.output.sourcePlanId).toBe(result.inputVariant.sourcePlanId);
    // The equivalence proof: the semantic core digests are EQUAL.
    expect(result.semanticCore.inputDigest).toBe(result.semanticCore.outputDigest);
    // Constant folding applied: fold-me became a folded retrieve.
    const folded = result.output.steps.find((step) => step.id === "fold-me");
    expect(folded?.stepClass).toBe("retrieve");
    // Dead-step elimination applied: the junk chain is gone.
    expect(result.output.steps.some((step) => step.id === "junk")).toBe(false);
    expect(result.output.steps.some((step) => step.id === "junk-sink")).toBe(false);
    // Verification and the generative route are untouched.
    expect(result.output.steps.some((step) => step.stepClass === "verify")).toBe(true);
    const gen = result.output.steps.find((step) => step.id === "gen");
    expect(gen?.routeRef).toEqual({ provider: "rail-a", model: "model-x" });
    // Memoization/parallel/shape/subgraph annotations are present where applicable.
    const annotationKeys = new Set(
      result.output.steps.flatMap((step) =>
        Object.keys(
          ((step.config as Record<string, unknown> | undefined)?.["execution-compiler"] as
            | Record<string, unknown>
            | undefined) ?? {},
        ),
      ),
    );
    expect(annotationKeys).toContain("memoization-hooks");
    expect(annotationKeys).toContain("subgraph-decomposition");
    // The trace is bounded and records every pass.
    expect(result.trace.length).toBeGreaterThanOrEqual(DEFAULT_PIPELINE_PASSES.length);
    expect(result.trace.every((entry) => entry.round <= DEFAULT_MAX_PIPELINE_ROUNDS)).toBe(true);
    // No claims ⇒ no decision record, and the ladder outcome is recorded.
    expect(result.decisionRecord).toBeNull();
    expect(result.ladderOutcome).toBe("no-claims");
  });

  test("determinism: the same inputs produce byte-identical outputs, traces and records", () => {
    const input = {
      ir: governedIr(),
      constraints: constraints(),
      config: {
        passes: DEFAULT_PIPELINE_PASSES,
        maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
        qualityThreshold: 0.9,
        representationClaims: claims(),
      },
      digest: nodeDigest,
      decisionScope: {
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        executionId: EXECUTION_ID,
      },
      recordedAt: RECORDED_AT,
    } as const;
    const first = compileExecutionIr(input);
    const second = compileExecutionIr(input);
    // Byte-identical output variant, trace digest and decision record.
    expect(canonicalJson(first.output)).toBe(canonicalJson(second.output));
    expect(first.output.variantIrId).toBe(second.output.variantIrId);
    expect(first.traceDigest).toBe(second.traceDigest);
    expect(canonicalJson(first.trace)).toBe(canonicalJson(second.trace));
    expect(first.decisionRecord?.decisionId).toBe(second.decisionRecord?.decisionId);
    expect(first.decisionRecord?.recordDigest).toBe(second.decisionRecord?.recordDigest);
    expect(first.semanticCore).toEqual(second.semanticCore);
  });

  test("idempotence: re-compiling the same input is a bounded no-op (identical result)", () => {
    const input = {
      ir: governedIr(),
      constraints: constraints(),
      config: {
        passes: DEFAULT_PIPELINE_PASSES,
        maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
        qualityThreshold: 0.9,
      },
      digest: nodeDigest,
    } as const;
    const first = compileExecutionIr(input);
    const rerun = compileExecutionIr(input);
    expect(rerun.output.variantIrId).toBe(first.output.variantIrId);
    expect(rerun.changed).toBe(first.changed);
    expect(rerun.roundsExecuted).toBe(first.roundsExecuted);
    // The re-run converges: the second round is a full no-op round.
    const lastRound = rerun.trace[rerun.trace.length - 1]?.round ?? 0;
    expect(lastRound).toBeLessThanOrEqual(DEFAULT_MAX_PIPELINE_ROUNDS);
  });

  test("the ladder decision record: the cheaper sufficient compiled variant is selected and recorded", () => {
    const result = compileExecutionIr({
      ir: governedIr(),
      constraints: constraints(),
      config: {
        passes: DEFAULT_PIPELINE_PASSES,
        maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
        qualityThreshold: 0.9,
        representationClaims: claims(),
      },
      digest: nodeDigest,
      decisionScope: {
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        executionId: EXECUTION_ID,
      },
      recordedAt: RECORDED_AT,
    });
    expect(result.ladderOutcome).toBe("selected");
    const record = result.decisionRecord;
    expect(record).not.toBeNull();
    // The WORK-049 evidence contract.
    expect(record?.applicationId).toBe(APPLICATION_ID);
    expect(record?.planId).toBe(result.inputVariant.sourcePlanId);
    expect(record?.irId).toBe(result.inputVariant.sourceIrId);
    expect(record?.qualityThreshold).toBe(0.9);
    expect(record?.candidates).toHaveLength(2);
    // The compiled candidate references the FINAL output variant.
    const compiled = record?.candidates.find((c) => c.candidateId === "compiled-variant");
    expect(compiled?.claim.expectedCostMicroUsd).toBe("100000");
    // Selection: quality-preserving + lowest expected successful-resolution cost.
    expect(record?.selectedCandidateId).toBe("compiled-variant");
    expect(record?.selectedExpectation.expectedSuccessfulResolutionCostMicroUsd).toBe("100000");
    // The transformation basis is the closed vocabulary with the
    // compilation provenance.
    expect(record?.transformationBasis.code).toBe("representation-substitution");
    expect(record?.transformationBasis.detail).toContain("execution-compiler");
    expect(record?.transformationBasis.detail).toContain(result.output.variantIrId);
    // The generative steps carry the ladder hook annotation with the
    // selection facts (hooks only — the route is untouched).
    const gen = result.output.steps.find((step) => step.id === "gen");
    const annotation = (gen?.config as Record<string, unknown> | undefined)?.[
      "execution-compiler"
    ] as Record<string, Record<string, unknown>> | undefined;
    const hook = annotation?.["representation-ladder-hooks"];
    expect(hook?.selectedCandidateId).toBe("compiled-variant");
    expect(hook?.ladderRank).toBe(0);
    expect(gen?.routeRef).toEqual({ provider: "rail-a", model: "model-x" });
  });

  test("the cheaper base can win when the compiled claim is below the quality threshold", () => {
    const result = compileExecutionIr({
      ir: governedIr(),
      constraints: constraints(),
      config: {
        passes: DEFAULT_PIPELINE_PASSES,
        maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
        qualityThreshold: 0.9,
        representationClaims: {
          base: claims().base,
          compiled: {
            candidateId: "cheap-but-insufficient",
            representationClass: "deterministic-computation",
            claim: {
              // Cheap and above the hard quality FLOOR (0.85) but BELOW
              // the assurance threshold (0.9): inadmissible for
              // selection — never merely more expensive
              // (quality-preserving economics).
              expectedCostMicroUsd: "1000",
              expectedLatencyMs: 100,
              expectedQuality: 0.87,
              expectedReliability: 1,
              basis: { basis: "estimated" as const, source: "planning.route-table" },
            },
          },
        },
      },
      digest: nodeDigest,
      decisionScope: { applicationId: APPLICATION_ID, tenantId: TENANT_ID },
      recordedAt: RECORDED_AT,
    });
    expect(result.ladderOutcome).toBe("selected");
    // The below-threshold candidate CANNOT win: the base is selected.
    expect(result.decisionRecord?.selectedCandidateId).toBe("base-plan");
  });

  test("no admissible candidate ⇒ no decision record, typed ladder outcome", () => {
    const result = compileExecutionIr({
      ir: governedIr(),
      constraints: constraints(),
      config: {
        passes: DEFAULT_PIPELINE_PASSES,
        maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
        qualityThreshold: 0.99,
        representationClaims: {
          base: {
            candidateId: "base-plan",
            representationClass: "sufficient-model",
            claim: {
              expectedCostMicroUsd: "500000",
              expectedLatencyMs: 2000,
              expectedQuality: 0.93,
              expectedReliability: 0.9,
              basis: { basis: "estimated" as const, source: "planning.route-table" },
            },
          },
          compiled: {
            candidateId: "compiled-variant",
            representationClass: "deterministic-computation",
            claim: {
              expectedCostMicroUsd: "100000",
              expectedLatencyMs: 400,
              expectedQuality: 0.95,
              expectedReliability: 1,
              basis: { basis: "observed" as const, source: "learning.telemetry" },
            },
          },
        },
      },
      digest: nodeDigest,
      decisionScope: { applicationId: APPLICATION_ID, tenantId: TENANT_ID },
      recordedAt: RECORDED_AT,
    });
    // Both candidates are below 0.99: no admissible candidate, NO
    // decision record (never a below-threshold selection).
    expect(result.ladderOutcome).toBe("no-admissible-candidate");
    expect(result.decisionRecord).toBeNull();
  });

  test("claims without governing constraints fail closed (unprovenanced optimization)", () => {
    expect(() =>
      compileExecutionIr({
        ir: governedIr(),
        constraints: [],
        config: {
          passes: DEFAULT_PIPELINE_PASSES,
          maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
          qualityThreshold: 0.9,
          representationClaims: claims(),
        },
        digest: nodeDigest,
        decisionScope: { applicationId: APPLICATION_ID, tenantId: TENANT_ID },
        recordedAt: RECORDED_AT,
      }),
    ).toThrow(CompilerError);
    try {
      compileExecutionIr({
        ir: governedIr(),
        constraints: [],
        config: {
          passes: DEFAULT_PIPELINE_PASSES,
          maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
          qualityThreshold: 0.9,
          representationClaims: claims(),
        },
        digest: nodeDigest,
        decisionScope: { applicationId: APPLICATION_ID, tenantId: TENANT_ID },
        recordedAt: RECORDED_AT,
      });
    } catch (error) {
      expect((error as CompilerError).invariant).toBe("compiler-config");
    }
  });

  test("a non-converging budget fails closed (pipeline-unbounded, nothing emitted)", () => {
    // maxRounds=1 with a plan that changes in round 1: convergence is
    // NOT proven inside the budget — fail closed, never truncate.
    expect(() =>
      compileExecutionIr({
        ir: governedIr(),
        constraints: constraints(),
        config: {
          passes: DEFAULT_PIPELINE_PASSES,
          maxRounds: 1,
          qualityThreshold: 0.9,
        },
        digest: nodeDigest,
      }),
    ).toThrow(CompilerError);
    try {
      compileExecutionIr({
        ir: governedIr(),
        constraints: constraints(),
        config: {
          passes: DEFAULT_PIPELINE_PASSES,
          maxRounds: 1,
          qualityThreshold: 0.9,
        },
        digest: nodeDigest,
      });
    } catch (error) {
      expect((error as CompilerError).invariant).toBe("pipeline-unbounded");
    }
  });

  test("pipeline config validation fails closed on unknown, duplicate and unbounded configs", () => {
    const base = {
      ir: governedIr(),
      constraints: constraints(),
      digest: nodeDigest,
    };
    // Unknown pass id (no pass injection).
    expect(() =>
      compileExecutionIr({
        ...base,
        config: {
          passes: ["constant-folding", "mystery-pass" as unknown as CompilerPassId],
          maxRounds: 4,
          qualityThreshold: 0.9,
        },
      }),
    ).toThrow(CompilerError);
    // Duplicate pass id (ambiguous ordering — a determinism hazard).
    expect(() =>
      compileExecutionIr({
        ...base,
        config: {
          passes: ["constant-folding", "constant-folding"],
          maxRounds: 4,
          qualityThreshold: 0.9,
        },
      }),
    ).toThrow(CompilerError);
    // Unbounded rounds.
    expect(() =>
      compileExecutionIr({
        ...base,
        config: {
          passes: ["constant-folding"],
          maxRounds: MAX_PIPELINE_ROUNDS_HARD + 1,
          qualityThreshold: 0.9,
        },
      }),
    ).toThrow(CompilerError);
    // Invalid threshold.
    expect(() =>
      compileExecutionIr({
        ...base,
        config: { passes: ["constant-folding"], maxRounds: 4, qualityThreshold: 1.5 },
      }),
    ).toThrow(CompilerError);
    // Unbounded cost claim in the ladder configuration.
    expect(() =>
      compileExecutionIr({
        ...base,
        config: {
          passes: DEFAULT_PIPELINE_PASSES,
          maxRounds: 4,
          qualityThreshold: 0.9,
          representationClaims: {
            base: claims().base,
            compiled: {
              candidateId: "compiled-variant",
              representationClass: "deterministic-computation",
              claim: {
                expectedCostMicroUsd: "1000000000000000000000000",
                expectedLatencyMs: 100,
                expectedQuality: 0.95,
                expectedReliability: 1,
                basis: { basis: "observed" as const, source: "learning.telemetry" },
              },
            },
          },
        },
        decisionScope: { applicationId: APPLICATION_ID, tenantId: TENANT_ID },
        recordedAt: RECORDED_AT,
      }),
    ).toThrow(CompilerError);
  });

  test("an invalid input IR fails closed before any pass runs (the WORK-049 gate)", () => {
    const ir = governedIr();
    const mutated = {
      ...ir,
      steps: ir.steps.map((step) =>
        step.id === "gen" ? { ...step, routeRef: { provider: "", model: "" } } : step,
      ),
    };
    expect(() =>
      compileExecutionIr({
        ir: mutated,
        constraints: constraints(),
        config: {
          passes: DEFAULT_PIPELINE_PASSES,
          maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
          qualityThreshold: 0.9,
        },
        digest: nodeDigest,
      }),
    ).toThrow();
  });

  test("a single-pass pipeline converges within one extra round", () => {
    const result = compileExecutionIr({
      ir: governedIr(),
      constraints: constraints(),
      config: {
        passes: ["constant-folding"],
        maxRounds: 3,
        qualityThreshold: 0.9,
      },
      digest: nodeDigest,
    });
    expect(result.changed).toBe(true);
    expect(result.roundsExecuted).toBe(2); // round 1 applies; round 2 proves the fixpoint.
    // Only the folding pass appears in the trace (per round).
    expect(result.trace.every((entry) => entry.passId === "constant-folding")).toBe(true);
  });
});
