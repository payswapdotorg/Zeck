/**
 * Execution IR variant unit tests (WORK-050).
 *
 * Proves: the identity variant is the faithful container (its plan
 * form is byte-identical to the IR's, so variantPlanId IS the governed
 * planId); total validation with both content identities over the
 * WORK-049 closed 12-code vocabulary; identity drift is
 * unrepresentable; construction determinism; the empty trace digest.
 */

import { describe, expect, test } from "vitest";
import { createIrPlanSource } from "../../../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan, createNodeDigest } from "../../../../src/modules/planning/public";
import type { ExecutionIrVariant } from "../../../../src/platform/execution-compiler/variant";
import {
  canonicalVariantForm,
  canonicalVariantPlanForm,
  emptyTraceDigest,
  validateExecutionIrVariant,
  variantFromIr,
} from "../../../../src/platform/execution-compiler/variant";
import { canonicalJson } from "../../../../src/platform/execution-ir/canonical";
import {
  deriveExecutionIr,
  IrValidationError,
  planFormOfIr,
} from "../../../../src/platform/execution-ir/ir";

const nodeDigest = createNodeDigest();
const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

function basePlan() {
  return buildPlan(
    {
      revision: 3,
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
}

function ir() {
  return deriveExecutionIr(planSource.toPlanSnapshot(basePlan()), nodeDigest);
}

describe("execution IR variants (WORK-050)", () => {
  test("the identity variant is the faithful container: variantPlanId IS the governed planId", () => {
    const input = ir();
    const variant = variantFromIr(input, nodeDigest);
    expect(variant.sourceIrId).toBe(input.irId);
    expect(variant.sourcePlanId).toBe(input.planId);
    expect(variant.variantPlanId).toBe(input.planId);
    // Byte equality with the WORK-049 plan form (lossless container).
    expect(canonicalVariantPlanForm(variant)).toBe(planFormOfIr(input));
  });

  test("variant construction is deterministic and idempotent", () => {
    const input = ir();
    const first = variantFromIr(input, nodeDigest);
    const second = variantFromIr(input, nodeDigest);
    expect(first).toEqual(second);
    expect(first.variantIrId).toBe(second.variantIrId);
  });

  test("the identity variant passes total validation (both identities)", () => {
    const variant = variantFromIr(ir(), nodeDigest);
    const validated = validateExecutionIrVariant(variant, nodeDigest);
    expect(validated.variantIrId).toBe(variant.variantIrId);
    expect(validated.steps).toHaveLength(3);
  });

  test("a variant round-trip through canonical JSON re-validates", () => {
    const variant = variantFromIr(ir(), nodeDigest);
    const roundTripped = JSON.parse(canonicalVariantForm(variant)) as ExecutionIrVariant;
    // The canonical variant form lacks variantIrId; re-attach it.
    const restored = { ...roundTripped, variantIrId: variant.variantIrId };
    expect(() => validateExecutionIrVariant(restored, nodeDigest)).not.toThrow();
  });

  test("identity drift is unrepresentable (ir-identity-mismatch)", () => {
    const variant = variantFromIr(ir(), nodeDigest);
    // Mutate a step's semantic config consistently (edges stay valid) —
    // the structural checks pass and the identity check isolates.
    const mutated = {
      ...variant,
      steps: variant.steps.map((step) =>
        step.id === "fetch-docs" ? { ...step, config: { drifted: true } } : step,
      ),
    };
    expect(() => validateExecutionIrVariant(mutated, nodeDigest)).toThrow(IrValidationError);
    try {
      validateExecutionIrVariant(mutated, nodeDigest);
    } catch (error) {
      expect((error as IrValidationError).invariant).toBe("ir-identity-mismatch");
    }
  });

  test("plan-form drift is unrepresentable (plan-identity-mismatch)", () => {
    const variant = variantFromIr(ir(), nodeDigest);
    // Mutate a plan-semantic field but RE-ADDRESS the variantIrId over
    // the mutated content — only the variantPlanId stays stale, so the
    // failure isolates the plan-form identity invariant.
    const mutatedSteps = variant.steps.map((step) =>
      step.id === "fetch-docs" ? { ...step, config: { drifted: true } } : step,
    );
    const mutated = {
      ...variant,
      steps: mutatedSteps,
    };
    const recomputedVariantIrId = nodeDigest.sha256Hex(canonicalVariantForm(mutated));
    const drifted = { ...mutated, variantIrId: recomputedVariantIrId };
    expect(() => validateExecutionIrVariant(drifted, nodeDigest)).toThrow(IrValidationError);
    try {
      validateExecutionIrVariant(drifted, nodeDigest);
    } catch (error) {
      expect((error as IrValidationError).invariant).toBe("plan-identity-mismatch");
    }
  });

  test("a cycle in the variant graph is rejected (edge-structure)", () => {
    const variant = variantFromIr(ir(), nodeDigest);
    const mutated = {
      ...variant,
      edges: [...variant.edges, { from: "check-output", to: "fetch-docs" }],
    };
    expect(() => validateExecutionIrVariant(mutated, nodeDigest)).toThrow(IrValidationError);
    try {
      validateExecutionIrVariant(mutated, nodeDigest);
    } catch (error) {
      expect((error as IrValidationError).invariant).toBe("edge-structure");
    }
  });

  test("a route on a non-generative variant step is rejected (route-binding)", () => {
    const variant = variantFromIr(ir(), nodeDigest);
    const steps = variant.steps.map((step) =>
      step.id === "fetch-docs"
        ? { ...step, routeRef: { provider: "rail-a", model: "model-x" } }
        : step,
    );
    const mutated = { ...variant, steps };
    expect(() => validateExecutionIrVariant(mutated, nodeDigest)).toThrow(IrValidationError);
    try {
      validateExecutionIrVariant(mutated, nodeDigest);
    } catch (error) {
      expect((error as IrValidationError).invariant).toBe("route-binding");
    }
  });

  test("a foreign provenance source is rejected (provenance-vocabulary)", () => {
    const variant = variantFromIr(ir(), nodeDigest);
    const mutated = {
      ...variant,
      provenance: { ...variant.provenance, source: "unknown-producer" },
    };
    expect(() => validateExecutionIrVariant(mutated, nodeDigest)).toThrow(IrValidationError);
    try {
      validateExecutionIrVariant(mutated, nodeDigest);
    } catch (error) {
      expect((error as IrValidationError).invariant).toBe("provenance-vocabulary");
    }
  });

  test("the empty trace digest is stable", () => {
    expect(emptyTraceDigest(nodeDigest)).toBe(nodeDigest.sha256Hex(canonicalJson({ trace: [] })));
    expect(emptyTraceDigest(nodeDigest)).toBe(emptyTraceDigest(nodeDigest));
  });
});
