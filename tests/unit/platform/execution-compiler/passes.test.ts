/**
 * Transformation catalog unit tests (WORK-050): every catalogued pass —
 * application, explicit preconditions (typed per-site rejections),
 * semantics preservation (the core digest), determinism and re-run
 * idempotence guards.
 */

import { describe, expect, test } from "vitest";
import { createIrPlanSource } from "../../../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan, createNodeDigest } from "../../../../src/modules/planning/public";
import type { PassInput } from "../../../../src/platform/execution-compiler/passes";
import {
  applyBatching,
  applyCommonSubexpressionReuse,
  applyConstantFolding,
  applyDeadStepElimination,
  applyMemoizationHooks,
  applyRepresentationLadderHooks,
  applyResultShaping,
  applyRetryNormalization,
  applySafeParallelization,
  applySubgraphDecomposition,
  applyVerificationInsertion,
} from "../../../../src/platform/execution-compiler/passes";
import { semanticCoreDigest } from "../../../../src/platform/execution-compiler/semantics";
import {
  validateExecutionIrVariant,
  variantFromIr,
} from "../../../../src/platform/execution-compiler/variant";
import { canonicalJson } from "../../../../src/platform/execution-ir/canonical";
import type { OptimizationConstraint } from "../../../../src/platform/execution-ir/constraints";
import type { ExecutionIr } from "../../../../src/platform/execution-ir/ir";
import { deriveExecutionIr } from "../../../../src/platform/execution-ir/ir";

const nodeDigest = createNodeDigest();
const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

const ANCHOR_CONSTRAINT: OptimizationConstraint = {
  constraintId: "verification-anchor",
  kind: "verification",
  enforcement: "hard",
  source: { authority: "verification" },
  payload: { requiresVerificationAnchor: true },
};

function compileIr(
  steps: Parameters<typeof buildPlan>[0]["steps"],
  edges: Parameters<typeof buildPlan>[0]["edges"],
  strategyClass: Parameters<typeof buildPlan>[0]["strategyClass"] = "hybrid",
): ExecutionIr {
  const plan = buildPlan({ revision: 1, strategyClass, steps, edges }, digestValue);
  return deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest);
}

function passInput(
  ir: ExecutionIr,
  constraints: OptimizationConstraint[] = [ANCHOR_CONSTRAINT],
): PassInput {
  return {
    variant: variantFromIr(ir, nodeDigest),
    constraints,
    digest: nodeDigest,
    traceDigest: variantFromIr(ir, nodeDigest).provenance.passTraceDigest,
  };
}

function annotationOf(
  stepId: string,
  passId: string,
  variant: ReturnType<typeof variantFromIr>,
): Record<string, unknown> | undefined {
  const step = variant.steps.find((s) => s.id === stepId);
  const config = step?.config as Record<string, unknown> | undefined;
  const annotationMap = config?.["execution-compiler"] as Record<string, unknown> | undefined;
  return annotationMap?.[passId] as Record<string, unknown> | undefined;
}

describe("constant folding (WORK-050)", () => {
  test("folds a statically-foldable pure step in place, preserving the core digest", () => {
    const ir = compileIr(
      [
        {
          id: "fold",
          stepClass: "transform",
          config: { operation: "uppercase", inputs: ["abc"] },
        },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [{ from: "fold", to: "check" }],
    );
    const input = passInput(ir);
    const outcome = applyConstantFolding(input);
    expect(outcome.status).toBe("applied");
    expect(outcome.sitesApplied).toBe(1);
    const folded = outcome.output.steps.find((s) => s.id === "fold");
    expect(folded?.stepClass).toBe("retrieve");
    const foldedRecord = ((folded?.config ?? {}) as Record<string, unknown>)[
      "compiler-folded"
    ] as Record<string, unknown>;
    expect(foldedRecord.result).toBe("ABC");
    expect(foldedRecord.operation).toBe("uppercase");
    expect(foldedRecord.inputs).toEqual(["abc"]);
    // Equivalence: the core digest is unchanged (folded and unfoldable
    // forms normalize to the same evaluated contribution).
    expect(semanticCoreDigest(input.variant, nodeDigest)).toBe(
      semanticCoreDigest(outcome.output, nodeDigest),
    );
    // The output is a fully valid variant.
    expect(() => validateExecutionIrVariant(outcome.output, nodeDigest)).not.toThrow();
  });

  test("precondition rejections are typed and recorded (capability-bound, unparseable)", () => {
    const ir = compileIr(
      [
        {
          id: "cap-bound",
          stepClass: "transform",
          capabilityId: "owned-transform",
          config: { operation: "identity", inputs: [1] },
        },
        {
          id: "not-an-expression",
          stepClass: "transform",
          config: { arbitrary: true },
        },
        {
          id: "unknown-op",
          stepClass: "run-algorithm",
          config: { operation: "mystery", inputs: [1] },
        },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [
        { from: "cap-bound", to: "check" },
        { from: "not-an-expression", to: "check" },
        { from: "unknown-op", to: "check" },
      ],
    );
    const outcome = applyConstantFolding(passInput(ir));
    expect(outcome.status).toBe("noop");
    const checks = outcome.rejections.map((rejection) => rejection.check);
    expect(checks).toContain("fold-capability-bound");
    expect(checks).toContain("fold-config-unparseable");
    // Nothing was folded.
    expect(outcome.output.steps.every((step) => step.stepClass !== "retrieve")).toBe(true);
  });

  test("folding is guarded on re-run (idempotence: a folded step is not foldable again)", () => {
    const ir = compileIr(
      [
        { id: "fold", stepClass: "transform", config: { operation: "add", inputs: [1, 2] } },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [{ from: "fold", to: "check" }],
    );
    const first = applyConstantFolding(passInput(ir));
    expect(first.status).toBe("applied");
    const second = applyConstantFolding({
      ...passInput(ir),
      variant: first.output,
      traceDigest: first.output.provenance.passTraceDigest,
    });
    expect(second.status).toBe("noop");
    expect(second.output).toBe(first.output);
  });
});

describe("dead-step elimination (WORK-050)", () => {
  test("eliminates the pure unanchored junk chain under the active anchor binding", () => {
    const ir = compileIr(
      [
        { id: "junk", stepClass: "transform", config: { operation: "identity", inputs: [1] } },
        { id: "junk-sink", stepClass: "transform", config: { operation: "identity", inputs: [2] } },
        {
          id: "real",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [
        { from: "junk", to: "junk-sink" },
        { from: "real", to: "check" },
      ],
    );
    const input = passInput(ir);
    const outcome = applyDeadStepElimination(input);
    expect(outcome.status).toBe("applied");
    expect(outcome.sitesApplied).toBe(2);
    expect(outcome.output.steps.map((step) => step.id).sort()).toEqual(["check", "real"]);
    expect(outcome.output.edges).toEqual([{ from: "real", to: "check" }]);
    // Core digest preserved (the eliminated chain was non-observable
    // under the active binding).
    expect(semanticCoreDigest(input.variant, nodeDigest, true)).toBe(
      semanticCoreDigest(outcome.output, nodeDigest, true),
    );
  });

  test("without the anchor binding the pass is the conservative no-op", () => {
    const ir = compileIr(
      [
        { id: "junk-sink", stepClass: "transform", config: { operation: "identity", inputs: [2] } },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [],
    );
    const outcome = applyDeadStepElimination(passInput(ir, []));
    expect(outcome.status).toBe("noop");
    expect(outcome.output.steps).toHaveLength(2);
    expect(outcome.rejections.map((r) => r.check)).toContain("dead-step-reachable");
  });

  test("a would-empty elimination is rejected inadmissible (the guard)", () => {
    const ir = compileIr(
      [{ id: "only", stepClass: "transform", config: { operation: "identity", inputs: [2] } }],
      [],
    );
    const outcome = applyDeadStepElimination(passInput(ir));
    expect(outcome.status).toBe("noop");
    expect(outcome.output.steps).toHaveLength(1);
    expect(outcome.rejections.some((r) => r.detail.includes("would empty the plan"))).toBe(true);
  });
});

describe("common-subexpression reuse (WORK-050)", () => {
  test("merges identical deterministic steps (survivor = smallest id), re-pointing successors", () => {
    const ir = compileIr(
      [
        { id: "dup-b", stepClass: "transform", config: { operation: "uppercase", inputs: ["x"] } },
        { id: "dup-a", stepClass: "transform", config: { operation: "uppercase", inputs: ["x"] } },
        { id: "use-b", stepClass: "transform", config: { operation: "identity", inputs: [1] } },
        { id: "use-a", stepClass: "transform", config: { operation: "identity", inputs: [2] } },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [
        { from: "dup-b", to: "use-b" },
        { from: "dup-a", to: "use-a" },
        { from: "use-b", to: "check" },
        { from: "use-a", to: "check" },
      ],
    );
    const input = passInput(ir);
    const outcome = applyCommonSubexpressionReuse(input);
    expect(outcome.status).toBe("applied");
    // dup-a survives (smallest id); dup-b removed.
    expect(outcome.output.steps.map((s) => s.id).sort()).toEqual([
      "check",
      "dup-a",
      "use-a",
      "use-b",
    ]);
    // use-b's edge re-pointed to dup-a.
    expect(outcome.output.edges).toContainEqual({ from: "dup-a", to: "use-b" });
    expect(outcome.output.edges).not.toContainEqual({ from: "dup-b", to: "use-b" });
    // Core digest preserved.
    expect(semanticCoreDigest(input.variant, nodeDigest)).toBe(
      semanticCoreDigest(outcome.output, nodeDigest),
    );
    expect(() => validateExecutionIrVariant(outcome.output, nodeDigest)).not.toThrow();
  });

  test("shared-successor duplicates are rejected (arity preservation)", () => {
    const ir = compileIr(
      [
        { id: "dup-a", stepClass: "transform", config: { operation: "identity", inputs: [1] } },
        { id: "dup-b", stepClass: "transform", config: { operation: "identity", inputs: [1] } },
        { id: "shared", stepClass: "transform", config: { operation: "identity", inputs: [2] } },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [
        { from: "dup-a", to: "shared" },
        { from: "dup-b", to: "shared" },
        { from: "shared", to: "check" },
      ],
    );
    const outcome = applyCommonSubexpressionReuse(passInput(ir));
    expect(outcome.status).toBe("noop");
    expect(outcome.rejections.map((r) => r.check)).toContain("cse-shared-successor");
  });

  test("probabilistic duplicates are never merged (independent sampling)", () => {
    const ir = compileIr(
      [
        {
          id: "gen-a",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
        {
          id: "gen-b",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [
        { from: "gen-a", to: "check" },
        { from: "gen-b", to: "check" },
      ],
    );
    const outcome = applyCommonSubexpressionReuse(passInput(ir));
    expect(outcome.status).toBe("noop");
    expect(outcome.rejections.map((r) => r.check)).toContain("cse-step-not-deterministic");
    expect(outcome.output.steps).toHaveLength(3);
  });
});

describe("verification insertion — terminal anchor materialization (WORK-050)", () => {
  test("materializes a terminal step-level anchor into an explicit verify step (strategy verbatim)", () => {
    const ir = compileIr(
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
    const input = passInput(ir);
    const outcome = applyVerificationInsertion(input);
    expect(outcome.status).toBe("applied");
    const materialized = outcome.output.steps.find((step) => step.stepClass === "verify");
    expect(materialized).toBeDefined();
    expect(materialized?.verificationStrategy).toBe("schema-check");
    const anchored = outcome.output.steps.find((step) => step.id === "anchored");
    expect(anchored?.verificationStrategy).toBeUndefined();
    // The new edge observes the anchored step's output.
    expect(outcome.output.edges).toContainEqual({ from: "anchored", to: materialized?.id });
    // Core digest preserved (the anchor binding is re-bound identically).
    expect(semanticCoreDigest(input.variant, nodeDigest)).toBe(
      semanticCoreDigest(outcome.output, nodeDigest),
    );
    expect(() => validateExecutionIrVariant(outcome.output, nodeDigest)).not.toThrow();
  });

  test("non-terminal anchored steps are rejected (materialization is provable only for terminals)", () => {
    const ir = compileIr(
      [
        {
          id: "anchored-mid",
          stepClass: "transform",
          verificationStrategy: "schema-check",
          config: { operation: "identity", inputs: [1] },
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
        { from: "gen", to: "anchored-mid" },
        { from: "anchored-mid", to: "check" },
      ],
    );
    const outcome = applyVerificationInsertion(passInput(ir));
    expect(outcome.status).toBe("noop");
    expect(outcome.rejections.map((r) => r.check)).toContain("anchor-step-not-terminal");
  });
});

describe("retry normalization (WORK-050)", () => {
  test("projects the canonical bounded retry parameters verbatim as the annotation surface", () => {
    const ir = compileIr(
      [
        { id: "retry-a", stepClass: "retry", config: { retries: 2, backoffMs: 500 } },
        {
          id: "gen",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
      ],
      [{ from: "retry-a", to: "gen" }],
    );
    const input = passInput(ir);
    const outcome = applyRetryNormalization(input);
    expect(outcome.status).toBe("applied");
    const annotation = annotationOf("retry-a", "retry-normalization", outcome.output) as Record<
      string,
      unknown
    >;
    expect(annotation.retries).toBe(2);
    expect(annotation.backoffMs).toBe(500);
    // The plan-semantic config keys are carried verbatim (values copied,
    // never rewritten); the annotation rides under the reserved key.
    const step = outcome.output.steps.find((s) => s.id === "retry-a");
    expect(step?.config?.retries).toBe(2);
    expect(step?.config?.backoffMs).toBe(500);
    expect(semanticCoreDigest(input.variant, nodeDigest)).toBe(
      semanticCoreDigest(outcome.output, nodeDigest),
    );
  });

  test("an unbounded or nonconforming retry config is rejected (typed), never blessed", () => {
    const ir = compileIr(
      [
        { id: "retry-unbounded", stepClass: "retry", config: { retries: 1000000 } },
        {
          id: "gen",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
      ],
      [{ from: "retry-unbounded", to: "gen" }],
    );
    const outcome = applyRetryNormalization(passInput(ir));
    expect(outcome.status).toBe("noop");
    expect(outcome.rejections.map((r) => r.check)).toContain("retry-config-non-canonical");
  });
});

describe("safe parallelization (WORK-050)", () => {
  test("annotates pairwise-unreachable same-shape groups with the independence proof", () => {
    const ir = compileIr(
      [
        { id: "a1", stepClass: "transform", config: { operation: "identity", inputs: [1] } },
        { id: "a2", stepClass: "transform", config: { operation: "identity", inputs: [1] } },
        { id: "sink", stepClass: "transform", config: { operation: "identity", inputs: [0] } },
      ],
      [
        { from: "a1", to: "sink" },
        { from: "a2", to: "sink" },
      ],
    );
    const input = passInput(ir);
    const outcome = applySafeParallelization(input);
    expect(outcome.status).toBe("applied");
    const group1 = annotationOf("a1", "safe-parallelization", outcome.output) as Record<
      string,
      unknown
    >;
    const group2 = annotationOf("a2", "safe-parallelization", outcome.output) as Record<
      string,
      unknown
    >;
    expect(group1.group).toBe(group2.group);
    expect(group1.members).toEqual(["a1", "a2"]);
    // Edges unchanged (annotation-only; the runtime decides).
    expect(outcome.output.edges).toEqual(input.variant.edges);
    expect(semanticCoreDigest(input.variant, nodeDigest)).toBe(
      semanticCoreDigest(outcome.output, nodeDigest),
    );
  });

  test("dependent same-shape steps are rejected (no independence proof)", () => {
    const ir = compileIr(
      [
        { id: "p1", stepClass: "transform", config: { operation: "identity", inputs: [1] } },
        { id: "p2", stepClass: "transform", config: { operation: "identity", inputs: [1] } },
        { id: "sink", stepClass: "transform", config: { operation: "identity", inputs: [0] } },
      ],
      [
        { from: "p1", to: "p2" },
        { from: "p2", to: "sink" },
      ],
    );
    const outcome = applySafeParallelization(passInput(ir));
    expect(outcome.status).toBe("noop");
    expect(outcome.rejections.map((r) => r.check)).toContain("parallel-dependency-exists");
  });
});

describe("batching (WORK-050)", () => {
  test("annotates homogeneous independent deterministic batch groups", () => {
    const ir = compileIr(
      [
        { id: "b1", stepClass: "run-algorithm", config: { op: "vectorize" } },
        { id: "b2", stepClass: "run-algorithm", config: { op: "vectorize" } },
        { id: "sink", stepClass: "transform", config: { operation: "identity", inputs: [0] } },
      ],
      [
        { from: "b1", to: "sink" },
        { from: "b2", to: "sink" },
      ],
    );
    const input = passInput(ir);
    const outcome = applyBatching(input);
    expect(outcome.status).toBe("applied");
    const annotation = annotationOf("b1", "batching", outcome.output) as Record<string, unknown>;
    expect(annotation.members).toEqual(["b1", "b2"]);
    expect(semanticCoreDigest(input.variant, nodeDigest)).toBe(
      semanticCoreDigest(outcome.output, nodeDigest),
    );
  });

  test("generative steps are excluded from batch groups (context semantics)", () => {
    const ir = compileIr(
      [
        {
          id: "g1",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
        {
          id: "g2",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [
        { from: "g1", to: "check" },
        { from: "g2", to: "check" },
      ],
    );
    const outcome = applyBatching(passInput(ir));
    expect(outcome.status).toBe("noop");
    expect(outcome.rejections.map((r) => r.check)).toContain("batch-class-excluded");
  });
});

describe("memoization hooks (WORK-050)", () => {
  test("annotates deterministic steps with content-addressed memo keys", () => {
    const ir = compileIr(
      [
        { id: "det", stepClass: "transform", config: { operation: "identity", inputs: [1] } },
        {
          id: "gen",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [
        { from: "det", to: "gen" },
        { from: "gen", to: "check" },
      ],
    );
    const input = passInput(ir);
    const outcome = applyMemoizationHooks(input);
    expect(outcome.status).toBe("applied");
    const annotation = annotationOf("det", "memoization-hooks", outcome.output) as Record<
      string,
      unknown
    >;
    expect(typeof annotation.memoKey).toBe("string");
    // Determinism: same input → same memo key.
    const rerun = applyMemoizationHooks(input);
    const rerunAnnotation = annotationOf("det", "memoization-hooks", rerun.output) as Record<
      string,
      unknown
    >;
    expect(rerunAnnotation.memoKey).toBe(annotation.memoKey);
    expect(semanticCoreDigest(input.variant, nodeDigest)).toBe(
      semanticCoreDigest(outcome.output, nodeDigest),
    );
  });

  test("verification-anchored steps are never memoization hooks", () => {
    const ir = compileIr(
      [
        {
          id: "anchored",
          stepClass: "transform",
          verificationStrategy: "schema-check",
          config: { operation: "identity", inputs: [1] },
        },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [{ from: "anchored", to: "check" }],
    );
    const outcome = applyMemoizationHooks(passInput(ir));
    expect(outcome.status).toBe("noop");
    expect(outcome.rejections.map((r) => r.check)).toContain("memo-verification-step");
  });
});

describe("subgraph decomposition (WORK-050)", () => {
  test("annotates deterministic-closure vs probabilistic-reachable membership", () => {
    const ir = compileIr(
      [
        { id: "det-only", stepClass: "transform", config: { operation: "identity", inputs: [1] } },
        {
          id: "gen",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
        { id: "post", stepClass: "transform", config: { operation: "identity", inputs: [2] } },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [
        { from: "det-only", to: "gen" },
        { from: "gen", to: "post" },
        { from: "post", to: "check" },
      ],
    );
    const input = passInput(ir);
    const outcome = applySubgraphDecomposition(input);
    expect(outcome.status).toBe("applied");
    const detRegion = annotationOf("det-only", "subgraph-decomposition", outcome.output) as Record<
      string,
      unknown
    >;
    const postRegion = annotationOf("post", "subgraph-decomposition", outcome.output) as Record<
      string,
      unknown
    >;
    const genRegion = annotationOf("gen", "subgraph-decomposition", outcome.output) as Record<
      string,
      unknown
    >;
    expect(detRegion.region).toBe("deterministic");
    expect(postRegion.region).toBe("probabilistic");
    expect(genRegion.region).toBe("probabilistic");
    expect(typeof detRegion.regionKey).toBe("string");
    expect(semanticCoreDigest(input.variant, nodeDigest)).toBe(
      semanticCoreDigest(outcome.output, nodeDigest),
    );
  });
});

describe("result shaping (WORK-050)", () => {
  test("records the statically-derivable terminal output shape (folded constant object)", () => {
    const ir = compileIr(
      [
        {
          id: "terminal",
          stepClass: "retrieve",
          config: {
            "compiler-folded": {
              foldedFrom: "transform",
              operation: "project",
              fields: ["alpha", "beta"],
              inputs: [{ alpha: 1, beta: 2, gamma: 3 }],
              result: { alpha: 1, beta: 2 },
            },
          },
        },
      ],
      [],
    );
    const input = passInput(ir);
    const outcome = applyResultShaping(input);
    expect(outcome.status).toBe("applied");
    const annotation = annotationOf("terminal", "result-shaping", outcome.output) as Record<
      string,
      unknown
    >;
    expect(annotation.fields).toEqual(["alpha", "beta"]);
    expect(semanticCoreDigest(input.variant, nodeDigest)).toBe(
      semanticCoreDigest(outcome.output, nodeDigest),
    );
  });

  test("records a terminal projection's field list", () => {
    const ir = compileIr(
      [
        {
          id: "projection",
          stepClass: "transform",
          config: { operation: "project", fields: ["x", "y"], inputs: [{ x: 1, y: 2, z: 3 }] },
        },
      ],
      [],
    );
    const outcome = applyResultShaping(passInput(ir));
    expect(outcome.status).toBe("applied");
    const annotation = annotationOf("projection", "result-shaping", outcome.output) as Record<
      string,
      unknown
    >;
    expect(annotation.fields).toEqual(["x", "y"]);
  });

  test("non-terminal steps and underivable shapes are rejected", () => {
    const ir = compileIr(
      [
        { id: "mid", stepClass: "transform", config: { operation: "identity", inputs: [1] } },
        { id: "sink", stepClass: "transform", config: { arbitrary: true } },
      ],
      [{ from: "mid", to: "sink" }],
    );
    const outcome = applyResultShaping(passInput(ir));
    expect(outcome.status).toBe("noop");
    expect(outcome.rejections.map((r) => r.check)).toContain("shape-step-not-terminal");
    expect(outcome.rejections.map((r) => r.check)).toContain("shape-not-derivable");
  });
});

describe("representation-ladder hooks (WORK-050)", () => {
  test("annotates generative steps with the selection facts (hooks only — route untouched)", () => {
    const ir = compileIr(
      [
        {
          id: "gen",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [{ from: "gen", to: "check" }],
    );
    const input = passInput(ir);
    const outcome = applyRepresentationLadderHooks(input, {
      selectedCandidateId: "compiled-variant",
      representationClass: "deterministic-computation",
      ladderRank: 0,
      qualityThreshold: 0.9,
    });
    expect(outcome.status).toBe("applied");
    const annotation = annotationOf("gen", "representation-ladder-hooks", outcome.output) as Record<
      string,
      unknown
    >;
    expect(annotation.hook).toBe("representation-ladder");
    expect(annotation.selectedCandidateId).toBe("compiled-variant");
    expect(annotation.ladderRank).toBe(0);
    // The route is NEVER changed (no live selection).
    const gen = outcome.output.steps.find((step) => step.id === "gen");
    expect(gen?.routeRef).toEqual({ provider: "rail-a", model: "model-x" });
    expect(semanticCoreDigest(input.variant, nodeDigest)).toBe(
      semanticCoreDigest(outcome.output, nodeDigest),
    );
  });

  test("without claims the pass records the typed no-claims rejection", () => {
    const ir = compileIr(
      [
        {
          id: "gen",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [{ from: "gen", to: "check" }],
    );
    const outcome = applyRepresentationLadderHooks(passInput(ir), null);
    expect(outcome.status).toBe("noop");
    expect(outcome.rejections.map((r) => r.check)).toContain("ladder-no-claims");
  });
});
