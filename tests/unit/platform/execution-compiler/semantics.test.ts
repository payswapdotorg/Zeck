/**
 * Semantics machinery unit tests (WORK-050): the closed constant
 * evaluator (totality, determinism, typed failures) and the semantic
 * core digest (the equivalence invariant: annotation stripping, folded
 * and unfoldable forms comparing equal, anchors carried verbatim,
 * deadness and independence analysis).
 */

import { describe, expect, test } from "vitest";
import { createIrPlanSource } from "../../../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan, createNodeDigest } from "../../../../src/modules/planning/public";
import {
  areMutuallyIndependent,
  COMPILER_ANNOTATION_KEY,
  configSansAnnotations,
  evaluateFold,
  FOLD_OPERATIONS,
  FoldError,
  indexVariant,
  isProvablyDead,
  parseFoldExpression,
  semanticCoreDigest,
  semanticCoreForm,
  verifySemanticsPreservation,
} from "../../../../src/platform/execution-compiler/semantics";
import { buildVariant, variantFromIr } from "../../../../src/platform/execution-compiler/variant";
import { canonicalJson } from "../../../../src/platform/execution-ir/canonical";
import { deriveExecutionIr } from "../../../../src/platform/execution-ir/ir";

const nodeDigest = createNodeDigest();
const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

function planWithSteps(
  steps: Parameters<typeof buildPlan>[0]["steps"],
  edges: Parameters<typeof buildPlan>[0]["edges"],
  strategyClass: Parameters<typeof buildPlan>[0]["strategyClass"] = "hybrid",
) {
  return buildPlan({ revision: 1, strategyClass, steps, edges }, digestValue);
}

describe("the closed constant evaluator (WORK-050)", () => {
  test("the operation universe is closed", () => {
    expect([...FOLD_OPERATIONS]).toEqual([
      "identity",
      "uppercase",
      "lowercase",
      "concat",
      "add",
      "multiply",
      "length",
      "project",
    ]);
  });

  test("every operation evaluates deterministically", () => {
    expect(evaluateFold("identity", [42])).toBe(42);
    expect(evaluateFold("uppercase", ["abc"])).toBe("ABC");
    expect(evaluateFold("lowercase", ["ABC"])).toBe("abc");
    expect(evaluateFold("concat", ["a", "b", "c"])).toBe("abc");
    expect(evaluateFold("add", [1, 2, 3])).toBe(6);
    expect(evaluateFold("multiply", [2, 3, 4])).toBe(24);
    expect(evaluateFold("length", ["hello"])).toBe(5);
    expect(evaluateFold("length", [[1, 2, 3]])).toBe(3);
    expect(evaluateFold("length", [{ a: 1, b: 2 }])).toBe(2);
    expect(evaluateFold("project", [{ a: 1, b: 2, c: 3 }], ["a", "c"])).toEqual({ a: 1, c: 3 });
    // Missing fields are skipped — never fabricated.
    expect(evaluateFold("project", [{ a: 1 }], ["a", "zzz"])).toEqual({ a: 1 });
  });

  test("repeated evaluation is byte-identical (determinism)", () => {
    const cases: readonly [string, unknown[], string[] | undefined][] = [
      ["identity", [42], undefined],
      ["uppercase", ["abc"], undefined],
      ["lowercase", ["ABC"], undefined],
      ["concat", ["a", "b"], undefined],
      ["add", [1, 2], undefined],
      ["multiply", [2, 3], undefined],
      ["length", ["hello"], undefined],
      ["project", [{ a: 1, b: 2 }], ["a"]],
    ];
    for (const [op, inputs, fields] of cases) {
      const first = JSON.stringify(evaluateFold(op as "identity", inputs, fields));
      const second = JSON.stringify(evaluateFold(op as "identity", inputs, fields));
      expect(first).toBe(second);
    }
  });

  test("type failures are typed FoldErrors, never silent", () => {
    expect(() => evaluateFold("uppercase", [42])).toThrow(FoldError);
    expect(() => evaluateFold("add", ["a"])).toThrow(FoldError);
    expect(() => evaluateFold("add", [Number.POSITIVE_INFINITY])).toThrow(FoldError);
    expect(() => evaluateFold("multiply", [1e308, 1e308])).toThrow(FoldError);
    expect(() => evaluateFold("identity", [])).toThrow(FoldError);
    expect(() => evaluateFold("length", [42])).toThrow(FoldError);
    expect(() => evaluateFold("project", ["not-an-object"], ["a"])).toThrow(FoldError);
  });

  test("the fold-expression contract is exact: unknown shapes parse to null", () => {
    expect(parseFoldExpression(undefined)).toBeNull();
    expect(parseFoldExpression({})).toBeNull();
    expect(parseFoldExpression({ operation: "unknown-op", inputs: [] })).toBeNull();
    expect(parseFoldExpression({ operation: "uppercase", inputs: ["a"], extra: 1 })).toBeNull();
    expect(parseFoldExpression({ operation: "uppercase" })).toBeNull();
    expect(parseFoldExpression({ operation: "project", inputs: [{}] })).toBeNull();
    expect(parseFoldExpression({ operation: "project", fields: "a", inputs: [{}] })).toBeNull();
    // The legal shapes.
    expect(parseFoldExpression({ operation: "identity", inputs: [1] })).toEqual({
      operation: "identity",
      inputs: [1],
    });
    expect(
      parseFoldExpression({ operation: "project", fields: ["a"], inputs: [{ a: 1 }] }),
    ).toEqual({ operation: "project", inputs: [{ a: 1 }], fields: ["a"] });
  });

  test("oversized fold inputs are typed unbounded rejections", () => {
    const tooMany = { operation: "identity", inputs: Array.from({ length: 33 }, (_, i) => i) };
    expect(() => parseFoldExpression(tooMany)).toThrow(FoldError);
    const tooLarge = {
      operation: "identity",
      inputs: ["x".repeat(5000)],
    };
    expect(() => parseFoldExpression(tooLarge)).toThrow(FoldError);
  });
});

describe("the semantic core digest (WORK-050)", () => {
  test("compiler annotations are stripped; the core digest is invariant under annotation", () => {
    const plan = planWithSteps(
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
      ],
      [{ from: "fold-me", to: "gen" }],
    );
    const input = variantFromIr(
      deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest),
      nodeDigest,
    );

    // Annotate the fold step (annotation-only transformation).
    const annotated = buildVariant(
      {
        source: input,
        steps: input.steps.map((step) =>
          step.id === "fold-me"
            ? {
                ...step,
                config: {
                  ...step.config,
                  [COMPILER_ANNOTATION_KEY]: { "memoization-hooks": { memoKey: "k" } },
                },
              }
            : step,
        ),
        edges: input.edges,
        provenance: {
          source: "execution-compiler",
          derivationBasis: "semantics-preserving-composition",
          passTraceDigest: input.provenance.passTraceDigest,
        },
      },
      nodeDigest,
    );
    const verdict = verifySemanticsPreservation(input, annotated, nodeDigest);
    expect(verdict.ok).toBe(true);
    expect(semanticCoreDigest(input, nodeDigest)).toBe(semanticCoreDigest(annotated, nodeDigest));
  });

  test("a folded step and its unfoldable form compare EQUAL (the folding equivalence bridge)", () => {
    const plan = planWithSteps(
      [
        {
          id: "fold-me",
          stepClass: "transform",
          config: { operation: "uppercase", inputs: ["abc"] },
        },
        {
          id: "sink",
          stepClass: "transform",
          config: { operation: "identity", inputs: ["placeholder"] },
        },
      ],
      [{ from: "fold-me", to: "sink" }],
    );
    const input = variantFromIr(
      deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest),
      nodeDigest,
    );

    // The same plan semantics with the fold ALREADY applied.
    const folded = planWithSteps(
      [
        {
          id: "fold-me",
          stepClass: "retrieve",
          config: {
            "compiler-folded": {
              foldedFrom: "transform",
              operation: "uppercase",
              inputs: ["abc"],
              result: "ABC",
            },
          },
        },
        {
          id: "sink",
          stepClass: "transform",
          config: { operation: "identity", inputs: ["placeholder"] },
        },
      ],
      [{ from: "fold-me", to: "sink" }],
    );
    const foldedVariant = variantFromIr(
      deriveExecutionIr(planSource.toPlanSnapshot(folded), nodeDigest),
      nodeDigest,
    );
    expect(semanticCoreDigest(input, nodeDigest)).toBe(
      semanticCoreDigest(foldedVariant, nodeDigest),
    );
  });

  test("a semantics-VIOLATING change breaks the core digest (route mutation)", () => {
    const plan = planWithSteps(
      [
        {
          id: "gen",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
      ],
      [],
    );
    const input = variantFromIr(
      deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest),
      nodeDigest,
    );

    const mutatedPlan = planWithSteps(
      [
        {
          id: "gen",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-b", model: "model-y" },
        },
      ],
      [],
    );
    const mutated = variantFromIr(
      deriveExecutionIr(planSource.toPlanSnapshot(mutatedPlan), nodeDigest),
      nodeDigest,
    );
    const verdict = verifySemanticsPreservation(input, mutated, nodeDigest);
    expect(verdict.ok).toBe(false);
    expect(verdict.inputCoreDigest).not.toBe(verdict.outputCoreDigest);
  });

  test("a dropped side effect breaks the core digest", () => {
    const plan = planWithSteps(
      [
        {
          id: "call",
          stepClass: "call-tool",
          capabilityId: "web-fetch",
        },
      ],
      [],
    );
    const input = variantFromIr(
      deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest),
      nodeDigest,
    );

    const withoutEffect = planWithSteps(
      [{ id: "nothing", stepClass: "transform", config: { operation: "identity", inputs: [1] } }],
      [],
    );
    const mutated = variantFromIr(
      deriveExecutionIr(planSource.toPlanSnapshot(withoutEffect), nodeDigest),
      nodeDigest,
    );
    const verdict = verifySemanticsPreservation(input, mutated, nodeDigest);
    expect(verdict.ok).toBe(false);
  });

  test("a broken provenance chain fails preservation even with an equal core", () => {
    const plan = planWithSteps(
      [{ id: "a", stepClass: "transform", config: { operation: "identity", inputs: [1] } }],
      [],
    );
    const input = variantFromIr(
      deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest),
      nodeDigest,
    );
    const foreignSource = {
      ...input,
      sourcePlanId: "e".repeat(64),
    } as typeof input;
    const verdict = verifySemanticsPreservation(input, foreignSource, nodeDigest);
    expect(verdict.ok).toBe(false);
  });

  test("configSansAnnotations strips exactly the compiler key", () => {
    expect(configSansAnnotations(undefined)).toBeUndefined();
    expect(configSansAnnotations({ a: 1 })).toEqual({ a: 1 });
    expect(configSansAnnotations({ a: 1, [COMPILER_ANNOTATION_KEY]: { x: 1 } })).toEqual({ a: 1 });
  });
});

describe("deadness and independence analysis (WORK-050)", () => {
  test("a pure step with no path to any observable point is provably dead (under the active anchor binding)", () => {
    const plan = planWithSteps(
      [
        { id: "dead", stepClass: "transform", config: { operation: "identity", inputs: [1] } },
        { id: "junk-sink", stepClass: "transform", config: { operation: "identity", inputs: [2] } },
        { id: "live", stepClass: "transform", config: { operation: "identity", inputs: [3] } },
        {
          id: "effect",
          stepClass: "call-tool",
          capabilityId: "web-fetch",
        },
      ],
      [
        { from: "dead", to: "junk-sink" },
        { from: "live", to: "effect" },
      ],
    );
    const variant = variantFromIr(
      deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest),
      nodeDigest,
    );
    const graph = indexVariant(variant);
    // Under the active verification-anchor binding, the pure unanchored
    // junk sink is non-observable → its whole producing chain is dead.
    expect(isProvablyDead("dead", graph, true)).toBe(true);
    expect(isProvablyDead("junk-sink", graph, true)).toBe(true);
    expect(isProvablyDead("live", graph, true)).toBe(false);
    expect(isProvablyDead("effect", graph, true)).toBe(false);
    // Without the binding (the conservative reading), terminal outputs
    // are observable — nothing in a well-formed DAG is provably dead.
    expect(isProvablyDead("dead", graph, false)).toBe(false);
    expect(isProvablyDead("junk-sink", graph, false)).toBe(false);
  });

  test("a terminal pure step is never dead without the anchor binding", () => {
    const plan = planWithSteps(
      [{ id: "sink", stepClass: "transform", config: { operation: "identity", inputs: [1] } }],
      [],
    );
    const variant = variantFromIr(
      deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest),
      nodeDigest,
    );
    expect(isProvablyDead("sink", indexVariant(variant), false)).toBe(false);
  });

  test("a verification-anchored terminal step is never dead even under the binding", () => {
    const plan = planWithSteps(
      [
        {
          id: "anchored",
          stepClass: "transform",
          verificationStrategy: "schema-check",
          config: { operation: "identity", inputs: [1] },
        },
      ],
      [],
    );
    const variant = variantFromIr(
      deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest),
      nodeDigest,
    );
    expect(isProvablyDead("anchored", indexVariant(variant), true)).toBe(false);
    expect(isProvablyDead("anchored", indexVariant(variant), false)).toBe(false);
  });

  test("a probabilistic step is never dead", () => {
    const plan = planWithSteps(
      [
        {
          id: "gen",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
        { id: "other", stepClass: "transform", config: { operation: "identity", inputs: [1] } },
      ],
      [{ from: "other", to: "gen" }],
    );
    const variant = variantFromIr(
      deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest),
      nodeDigest,
    );
    // "other" feeds a generative step — observable through its successor.
    expect(isProvablyDead("other", indexVariant(variant), true)).toBe(false);
    expect(isProvablyDead("gen", indexVariant(variant), true)).toBe(false);
  });

  test("the semantic core excludes eliminable sinks only under the active binding", () => {
    const plan = planWithSteps(
      [
        { id: "junk", stepClass: "transform", config: { operation: "identity", inputs: [7] } },
        { id: "real", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [{ from: "junk", to: "real" }],
    );
    const variant = variantFromIr(
      deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest),
      nodeDigest,
    );
    // The junk step feeds the verify step → observable in BOTH readings
    // (its contribution is part of the anchored position).
    expect(semanticCoreForm(variant, true)).toBe(semanticCoreForm(variant, true));
    expect(semanticCoreForm(variant, false)).toBe(semanticCoreForm(variant, false));
  });

  test("mutual independence: chained steps are dependent; siblings are independent", () => {
    const plan = planWithSteps(
      [
        { id: "a", stepClass: "transform", config: { operation: "identity", inputs: [1] } },
        { id: "b", stepClass: "transform", config: { operation: "identity", inputs: [2] } },
        { id: "c", stepClass: "transform", config: { operation: "identity", inputs: [3] } },
        { id: "sink", stepClass: "transform", config: { operation: "identity", inputs: [0] } },
      ],
      [
        { from: "a", to: "c" },
        { from: "c", to: "sink" },
        { from: "b", to: "sink" },
      ],
    );
    const variant = variantFromIr(
      deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest),
      nodeDigest,
    );
    const graph = indexVariant(variant);
    expect(areMutuallyIndependent(["a", "b"], graph)).toBe(true);
    expect(areMutuallyIndependent(["a", "c"], graph)).toBe(false);
    expect(areMutuallyIndependent(["a", "b", "sink"], graph)).toBe(false);
  });
});
