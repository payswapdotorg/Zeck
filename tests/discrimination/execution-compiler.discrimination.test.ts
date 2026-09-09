/**
 * Discrimination tests — the deterministic Execution Compiler
 * protections (WORK-050, HIGH_ASSURANCE; the worker-runbook rule:
 * "For HIGH_ASSURANCE and CRITICAL, add an explicit discrimination
 * test that proves a weakened protection is rejected").
 *
 * Every fail-closed protection introduced by WORK-050 is
 * mutation-proven — the WEAKENED or VIOLATING form is rejected by the
 * machinery that owns it:
 *
 *  - D1 a semantics-VIOLATING transformation output (dropped side
 *    effect, changed route, invented verification strategy) fails the
 *    semantic-core equivalence proof;
 *  - D2 precondition violations fail closed per site (typed rejection
 *    codes, the site is never applied);
 *  - D3 non-deterministic orderings are structurally rejected
 *    (duplicate pass ids — ambiguous ordering) and determinism is
 *    proven by byte-identical double compilation;
 *  - D4 unbounded / unattributed cost claims are rejected in the
 *    ladder configuration;
 *  - D5 below-threshold quality selections are impossible (the
 *    WORK-049 cost-model gate holds through the compiler's decision
 *    path);
 *  - D6 decision records cannot be consulted for authorization: the
 *    compiler plane carries no store, no admission vocabulary and no
 *    authorization-shaped surface (mechanical boundary proof);
 *  - D7 variant identity tampering is unrepresentable;
 *  - D8 a non-converging bounded pipeline fails closed (nothing is
 *    emitted);
 *  - D9 the compiler never clobbers plan-owned config (the reserved
 *    annotation key is rejected, not overwritten);
 *  - D10 an anchor-materialization mutation that redefines the
 *    verification strategy (instead of carrying it verbatim) breaks
 *    the anchor bindings and is rejected;
 *  - D11 an arity-violating CSE merge (shared successor) is detected
 *    and rejected;
 *  - D12 pass injection is impossible (an unknown pass id fails
 *    closed).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createIrPlanSource } from "../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan, createNodeDigest } from "../../src/modules/planning/public";
import {
  CompilerError,
  type CompilerPassId,
  DEFAULT_MAX_PIPELINE_ROUNDS,
  DEFAULT_PIPELINE_PASSES,
  type RepresentationClaims,
} from "../../src/platform/execution-compiler/catalog";
import type { PassInput } from "../../src/platform/execution-compiler/passes";
import {
  applyCommonSubexpressionReuse,
  applyConstantFolding,
} from "../../src/platform/execution-compiler/passes";
import { compileExecutionIr } from "../../src/platform/execution-compiler/pipeline";
import {
  COMPILER_ANNOTATION_KEY,
  verifySemanticsPreservation,
} from "../../src/platform/execution-compiler/semantics";
import {
  buildVariant,
  validateExecutionIrVariant,
  variantFromIr,
} from "../../src/platform/execution-compiler/variant";
import { canonicalJson } from "../../src/platform/execution-ir/canonical";
import type { OptimizationConstraint } from "../../src/platform/execution-ir/constraints";
import { deriveExecutionIr } from "../../src/platform/execution-ir/ir";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nodeDigest = createNodeDigest();
const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

const APPLICATION_ID = "00000000-0000-7000-8000-0000000000aa";
const TENANT_ID = "00000000-0000-7000-8000-0000000000bb";
const RECORDED_AT = "2026-09-22T12:00:00.000Z";

function plan(
  steps: Parameters<typeof buildPlan>[0]["steps"],
  edges: Parameters<typeof buildPlan>[0]["edges"],
) {
  return buildPlan({ revision: 1, strategyClass: "hybrid", steps, edges }, digestValue);
}

function irOf(
  steps: Parameters<typeof buildPlan>[0]["steps"],
  edges: Parameters<typeof buildPlan>[0]["edges"],
) {
  return deriveExecutionIr(planSource.toPlanSnapshot(plan(steps, edges)), nodeDigest);
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

const GOVERNED = () =>
  irOf(
    [
      {
        id: "fold-me",
        stepClass: "transform",
        config: { operation: "uppercase", inputs: ["abc"] },
      },
      {
        id: "gen",
        stepClass: "call-model",
        capabilityId: "text-generation",
        routeRef: { provider: "rail-a", model: "model-x" },
      },
      { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
    ],
    [
      { from: "fold-me", to: "gen" },
      { from: "gen", to: "check" },
    ],
  );

describe("execution compiler discrimination (WORK-050)", () => {
  test("D1 a semantics-violating transformation output fails the equivalence proof", () => {
    const input = variantFromIr(GOVERNED(), nodeDigest);
    // Mutation 1: the route silently changed (a "cheaper" model swap
    // masquerading as an optimization).
    const routeMutated = buildVariant(
      {
        source: input,
        steps: input.steps.map((step) =>
          step.id === "gen"
            ? { ...step, routeRef: { provider: "rail-b", model: "model-y" } }
            : step,
        ),
        edges: input.edges,
        provenance: input.provenance,
      },
      nodeDigest,
    );
    expect(verifySemanticsPreservation(input, routeMutated, nodeDigest).ok).toBe(false);
    // Mutation 2: the verification anchor silently dropped.
    const anchorDropped = buildVariant(
      {
        source: input,
        steps: input.steps.map((step) =>
          step.id === "check" ? { ...step, verificationStrategy: undefined } : step,
        ),
        edges: input.edges,
        provenance: input.provenance,
      },
      nodeDigest,
    );
    expect(verifySemanticsPreservation(input, anchorDropped, nodeDigest).ok).toBe(false);
    // Mutation 3: the external effect silently dropped.
    const effectPlan = irOf(
      [
        { id: "call", stepClass: "call-tool", capabilityId: "web-fetch" },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [{ from: "call", to: "check" }],
    );
    const effectInput = variantFromIr(effectPlan, nodeDigest);
    const effectDropped = buildVariant(
      {
        source: effectInput,
        steps: effectInput.steps.filter((step) => step.id !== "call"),
        edges: effectInput.edges.filter((edge) => edge.from !== "call"),
        provenance: effectInput.provenance,
      },
      nodeDigest,
    );
    expect(verifySemanticsPreservation(effectInput, effectDropped, nodeDigest).ok).toBe(false);
    // And the whole compilation rejects such an output: the pipeline's
    // per-pass proof is the same machinery (proven via the direct
    // verdicts above; the pipeline applies it after every pass).
  });

  test("D2 precondition violations fail closed per site (typed codes, never applied)", () => {
    const ir = irOf(
      [
        {
          id: "cap-bound",
          stepClass: "transform",
          capabilityId: "owned-transform",
          config: { operation: "identity", inputs: [1] },
        },
        {
          id: "anchored-fold",
          stepClass: "transform",
          verificationStrategy: "schema-check",
          config: { operation: "identity", inputs: [1] },
        },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [
        { from: "cap-bound", to: "check" },
        { from: "anchored-fold", to: "check" },
      ],
    );
    const input: PassInput = {
      variant: variantFromIr(ir, nodeDigest),
      constraints: constraints(),
      digest: nodeDigest,
      traceDigest: variantFromIr(ir, nodeDigest).provenance.passTraceDigest,
    };
    const outcome = applyConstantFolding(input);
    expect(outcome.status).toBe("noop");
    const checks = outcome.rejections.map((rejection) => rejection.check);
    // The capability-bound site: the capability authority owns its
    // semantics — the compiler never folds what it cannot prove.
    expect(checks).toContain("fold-capability-bound");
    // The anchored site: the anchor is preserved — never folded away.
    expect(checks).toContain("fold-strategy-bound");
    // Nothing was applied.
    expect(outcome.sitesApplied).toBe(0);
    expect(outcome.output).toBe(input.variant);
  });

  test("D3 non-deterministic orderings are structurally rejected; determinism is byte-proven", () => {
    // A duplicated pass id makes the effective ordering ambiguous —
    // the config is rejected as a determinism hazard.
    expect(() =>
      compileExecutionIr({
        ir: GOVERNED(),
        constraints: constraints(),
        config: {
          passes: [
            "dead-step-elimination",
            "constant-folding",
            "dead-step-elimination",
          ] as CompilerPassId[],
          maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
          qualityThreshold: 0.9,
        },
        digest: nodeDigest,
      }),
    ).toThrow(CompilerError);
    // And the determinism proof: identical inputs → byte-identical
    // outputs, traces and records (including tie-breaking).
    const input = {
      ir: GOVERNED(),
      constraints: constraints(),
      config: {
        passes: DEFAULT_PIPELINE_PASSES,
        maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
        qualityThreshold: 0.9,
        representationClaims: claims(),
      },
      digest: nodeDigest,
      decisionScope: { applicationId: APPLICATION_ID, tenantId: TENANT_ID },
      recordedAt: RECORDED_AT,
    } as const;
    const first = compileExecutionIr(input);
    const second = compileExecutionIr(input);
    expect(first.output.variantIrId).toBe(second.output.variantIrId);
    expect(first.traceDigest).toBe(second.traceDigest);
    expect(first.decisionRecord?.recordDigest).toBe(second.decisionRecord?.recordDigest);
    expect(canonicalJson(first.trace)).toBe(canonicalJson(second.trace));
  });

  test("D4 unbounded and unattributed cost claims are rejected in the ladder configuration", () => {
    const base = {
      ir: GOVERNED(),
      constraints: constraints(),
      digest: nodeDigest,
      decisionScope: { applicationId: APPLICATION_ID, tenantId: TENANT_ID },
      recordedAt: RECORDED_AT,
    };
    // Unbounded cost (above the bounded money universe).
    expect(() =>
      compileExecutionIr({
        ...base,
        config: {
          passes: DEFAULT_PIPELINE_PASSES,
          maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
          qualityThreshold: 0.9,
          representationClaims: {
            base: claims().base,
            compiled: {
              candidateId: "unbounded",
              representationClass: "deterministic-computation",
              claim: {
                expectedCostMicroUsd: "1000000000000000000000000",
                expectedLatencyMs: 100,
                expectedQuality: 0.95,
                expectedReliability: 1,
                basis: { basis: "estimated" as const, source: "planning.route-table" },
              },
            },
          },
        },
      }),
    ).toThrow(CompilerError);
    // Unattributed claim (no estimation basis).
    expect(() =>
      compileExecutionIr({
        ...base,
        config: {
          passes: DEFAULT_PIPELINE_PASSES,
          maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
          qualityThreshold: 0.9,
          representationClaims: {
            base: claims().base,
            compiled: {
              candidateId: "unattributed",
              representationClass: "deterministic-computation",
              claim: {
                expectedCostMicroUsd: "100",
                expectedLatencyMs: 100,
                expectedQuality: 0.95,
                expectedReliability: 1,
                basis: { basis: "estimated" as const, source: "" },
              },
            },
          },
        },
      }),
    ).toThrow(CompilerError);
  });

  test("D5 a below-threshold quality selection is impossible through the compiler decision path", () => {
    // The compiled claim is above the hard floor (0.85) but below the
    // threshold (0.9): it CANNOT be selected; the base wins.
    const result = compileExecutionIr({
      ir: GOVERNED(),
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
    expect(result.decisionRecord?.selectedCandidateId).toBe("base-plan");
    // And with NO admissible candidate there is NO record at all.
    const noneAdmissible = compileExecutionIr({
      ir: GOVERNED(),
      constraints: constraints(),
      config: {
        passes: DEFAULT_PIPELINE_PASSES,
        maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
        qualityThreshold: 0.99,
        representationClaims: claims(),
      },
      digest: nodeDigest,
      decisionScope: { applicationId: APPLICATION_ID, tenantId: TENANT_ID },
      recordedAt: RECORDED_AT,
    });
    expect(noneAdmissible.decisionRecord).toBeNull();
    expect(noneAdmissible.ladderOutcome).toBe("no-admissible-candidate");
  });

  test("D6 decision records cannot be consulted for authorization (mechanical boundary proof)", () => {
    // The compiler plane is pure: no store import, no durable client,
    // no admission/authorization vocabulary anywhere in its surface.
    const files = [
      "catalog.ts",
      "variant.ts",
      "semantics.ts",
      "passes.ts",
      "decisions.ts",
      "pipeline.ts",
    ];
    for (const file of files) {
      const content = readFileSync(
        join(REPO_ROOT, "src/platform/execution-compiler", file),
        "utf8",
      );
      // No durable-surface vocabulary.
      expect(content, `${file} must not import the store`).not.toContain("decision-store");
      expect(content, `${file} must not import the store`).not.toContain(
        "OptimizationDecisionStore",
      );
      expect(content, `${file} must not carry SQL`).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
      expect(content, `${file} must not carry SELECT`).not.toMatch(/\bSELECT\b/);
      // No admission/authorization-shaped surface.
      for (const word of ["authorize", "admission", "approve", "reserve", "settle", "release"]) {
        expect(content, `${file} must not expose "${word}"`).not.toContain(`readonly ${word}`);
        expect(content, `${file} must not expose "${word}"`).not.toContain(`function ${word}`);
      }
      // No ambient state (determinism): no clock, no randomness.
      expect(content, `${file} must not read ambient time`).not.toContain("Date.now");
      expect(content, `${file} must not read ambient time`).not.toContain("new Date(");
      expect(content, `${file} must not use randomness`).not.toContain("Math.random");
    }
  });

  test("D7 variant identity tampering is unrepresentable", () => {
    const variant = variantFromIr(GOVERNED(), nodeDigest);
    const tampered = {
      ...variant,
      steps: variant.steps.map((step) =>
        step.id === "gen" ? { ...step, routeRef: { provider: "rail-b", model: "model-y" } } : step,
      ),
    };
    expect(() => validateExecutionIrVariant(tampered, nodeDigest)).toThrow();
    // The identity checks name the exact violated invariant.
    try {
      validateExecutionIrVariant(tampered, nodeDigest);
    } catch (error) {
      expect((error as { invariant?: string }).invariant).toBe("ir-identity-mismatch");
    }
  });

  test("D8 a non-converging bounded pipeline fails closed (nothing is emitted)", () => {
    let threw: CompilerError | null = null;
    try {
      compileExecutionIr({
        ir: GOVERNED(),
        constraints: constraints(),
        config: {
          passes: DEFAULT_PIPELINE_PASSES,
          maxRounds: 1,
          qualityThreshold: 0.9,
        },
        digest: nodeDigest,
      });
    } catch (error) {
      threw = error as CompilerError;
    }
    expect(threw).not.toBeNull();
    expect(threw?.invariant).toBe("pipeline-unbounded");
  });

  test("D9 the compiler never clobbers plan-owned config (reserved key rejected)", () => {
    // A plan-authored config already carrying the reserved annotation
    // key: the compiler records annotation-already-present and never
    // writes over it.
    const ir = irOf(
      [
        {
          id: "owned",
          stepClass: "transform",
          config: {
            [COMPILER_ANNOTATION_KEY]: { "plan-authored": true },
            operation: "identity",
            inputs: [1],
          },
        },
        {
          id: "gen",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [
        { from: "owned", to: "gen" },
        { from: "gen", to: "check" },
      ],
    );
    const result = compileExecutionIr({
      ir,
      constraints: constraints(),
      config: {
        passes: DEFAULT_PIPELINE_PASSES,
        maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
        qualityThreshold: 0.9,
      },
      digest: nodeDigest,
    });
    const owned = result.output.steps.find((step) => step.id === "owned");
    // The plan-authored annotation content is PRESERVED verbatim.
    expect(owned?.config?.[COMPILER_ANNOTATION_KEY]).toEqual({ "plan-authored": true });
    // And the site was rejected, never re-annotated.
    const rejections = result.trace
      .flatMap((entry) => entry.rejections)
      .filter((rejection) => rejection.stepId === "owned");
    expect(rejections.some((rejection) => rejection.check === "annotation-already-present")).toBe(
      true,
    );
  });

  test("D10 an anchor-materialization mutation that redefines the strategy is rejected", () => {
    // The honest materialization carries the strategy VERBATIM. A
    // mutation that renames/redefines it (the compiler inventing a
    // quality gate) breaks the anchor bindings.
    const anchoredIr = irOf(
      [
        {
          id: "anchored",
          stepClass: "retrieve",
          verificationStrategy: "schema-check",
        },
        {
          id: "gen",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
      ],
      [{ from: "gen", to: "anchored" }],
    );
    const input = variantFromIr(anchoredIr, nodeDigest);
    // The honest materialized form (strategy verbatim, terminal anchor).
    const honest = buildVariant(
      {
        source: input,
        steps: [
          {
            id: "gen",
            stepClass: "call-model",
            capabilityId: "text-generation",
            routeRef: { provider: "rail-a", model: "model-x" },
          },
          { id: "anchored", stepClass: "retrieve" },
          { id: "vf-honest", stepClass: "verify", verificationStrategy: "schema-check" },
        ],
        edges: [
          { from: "gen", to: "anchored" },
          { from: "anchored", to: "vf-honest" },
        ],
        provenance: input.provenance,
      },
      nodeDigest,
    );
    expect(verifySemanticsPreservation(input, honest, nodeDigest).ok).toBe(true);
    // The mutated form (an INVENTED strategy — the compiler redefining
    // a quality gate): rejected.
    const invented = buildVariant(
      {
        source: input,
        steps: [
          {
            id: "gen",
            stepClass: "call-model",
            capabilityId: "text-generation",
            routeRef: { provider: "rail-a", model: "model-x" },
          },
          { id: "anchored", stepClass: "retrieve" },
          {
            id: "vf-invented",
            stepClass: "verify",
            verificationStrategy: "compiler-invented-check",
          },
        ],
        edges: [
          { from: "gen", to: "anchored" },
          { from: "anchored", to: "vf-invented" },
        ],
        provenance: input.provenance,
      },
      nodeDigest,
    );
    expect(verifySemanticsPreservation(input, invented, nodeDigest).ok).toBe(false);
  });

  test("D11 an arity-violating CSE merge (shared successor) is detected and rejected", () => {
    // Two identical duplicates sharing a successor: merging them would
    // change the consumer's input arity (or duplicate an edge) — the
    // pass rejects the class instead of merging.
    const ir = irOf(
      [
        { id: "dup-a", stepClass: "transform", config: { operation: "identity", inputs: [1] } },
        { id: "dup-b", stepClass: "transform", config: { operation: "identity", inputs: [1] } },
        // A capability-bound consumer: NOT statically foldable — its
        // contribution references its predecessors (the arity shows).
        {
          id: "shared",
          stepClass: "transform",
          capabilityId: "owned-transform",
          config: { combine: "both" },
        },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [
        { from: "dup-a", to: "shared" },
        { from: "dup-b", to: "shared" },
        { from: "shared", to: "check" },
      ],
    );
    const input = variantFromIr(ir, nodeDigest);
    // The arity-violating "merge": the consumer's TWO inputs collapse
    // to ONE (the duplicate's edge silently dropped instead of
    // re-pointed) — the consumer's contribution arity changed.
    const arityMutated = buildVariant(
      {
        source: input,
        steps: input.steps.filter((step) => step.id !== "dup-b"),
        edges: [
          { from: "dup-a", to: "shared" },
          { from: "shared", to: "check" },
        ],
        provenance: input.provenance,
      },
      nodeDigest,
    );
    expect(verifySemanticsPreservation(input, arityMutated, nodeDigest).ok).toBe(false);
    // The real pass rejects the class with the typed shared-successor
    // code (never merges).
    const outcome = applyCommonSubexpressionReuse({
      variant: input,
      constraints: constraints(),
      digest: nodeDigest,
      traceDigest: input.provenance.passTraceDigest,
    });
    expect(outcome.status).toBe("noop");
    expect(outcome.rejections.map((rejection) => rejection.check)).toContain(
      "cse-shared-successor",
    );
  });

  test("D12 pass injection is impossible (an unknown pass id fails closed)", () => {
    let threw: CompilerError | null = null;
    try {
      compileExecutionIr({
        ir: GOVERNED(),
        constraints: constraints(),
        config: {
          passes: ["constant-folding", "vendor-optimizer" as unknown as CompilerPassId],
          maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
          qualityThreshold: 0.9,
        },
        digest: nodeDigest,
      });
    } catch (error) {
      threw = error as CompilerError;
    }
    expect(threw).not.toBeNull();
    expect(threw?.invariant).toBe("compiler-config");
    expect(threw?.details.passId).toBe("vendor-optimizer");
  });
});
