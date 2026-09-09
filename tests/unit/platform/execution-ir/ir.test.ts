/**
 * Execution IR core unit tests (WORK-049).
 *
 * Proves the IR foundation's core contracts over REAL governed plans
 * built by the planning module's own `buildPlan` (the cross-plane
 * compatibility proof), plus total deterministic validation and every
 * typed invariant rejection.
 */

import { describe, expect, test } from "vitest";
import { createIrPlanSource } from "../../../../src/modules/planning/adapters/ir-plan-source";
import {
  buildPlan,
  canonicalPlanForm,
  createNodeDigest,
  PLAN_STEP_CLASSES as PLANNING_STEP_CLASSES,
  STRATEGY_CLASSES as PLANNING_STRATEGY_CLASSES,
} from "../../../../src/modules/planning/public";
import {
  AUTONOMY_MODES as POLICY_AUTONOMY,
  EGRESS_MODES as POLICY_EGRESS,
  ISOLATION_LEVELS as POLICY_ISOLATION,
  SECRET_ACCESS_MODES as POLICY_SECRET_ACCESS,
} from "../../../../src/modules/policies/public";
import { canonicalJson } from "../../../../src/platform/execution-ir/canonical";
import {
  AUTONOMY_MODES,
  EGRESS_MODES,
  ISOLATION_LEVELS,
  SECRET_ACCESS_MODES,
} from "../../../../src/platform/execution-ir/constraints";
import {
  COMPUTATION_TYPES,
  canonicalIrForm,
  canonicalPlanFormOfSnapshot,
  deriveExecutionIr,
  type ExecutionIr,
  GENERATIVE_STEP_CLASSES,
  type GovernedPlanSnapshot,
  type GovernedPlanStep,
  IR_DERIVATION_BASES,
  IR_INVARIANT_CODES,
  IR_PROVENANCE_SOURCES,
  IrValidationError,
  PLAN_STEP_CLASSES,
  planFormOfIr,
  SIDE_EFFECT_CLASSES,
  STRATEGY_CLASSES,
  validateExecutionIr,
} from "../../../../src/platform/execution-ir/ir";

/** The planner's digest discipline: sha256 over canonical JSON. */
const nodeDigest = createNodeDigest();
const digest = nodeDigest;
const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

/** A REAL governed plan via the planning module's own builder. */
function governedPlan() {
  return buildPlan(
    {
      revision: 1,
      strategyClass: "hybrid",
      steps: [
        { id: "retrieve-inputs", stepClass: "retrieve", capabilityId: "structured-dataset-read" },
        {
          id: "compute-answer",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
          config: { maxTokens: 1024 },
        },
        {
          id: "verify-answer",
          stepClass: "verify",
          verificationStrategy: "deterministic-schema-validation",
        },
      ],
      edges: [
        { from: "retrieve-inputs", to: "compute-answer" },
        { from: "compute-answer", to: "verify-answer" },
      ],
    },
    digestValue,
  );
}

describe("Execution IR core (WORK-049)", () => {
  test("the frozen vocabularies are pinned to the authority contracts", () => {
    expect([...PLAN_STEP_CLASSES]).toEqual([...PLANNING_STEP_CLASSES]);
    expect([...STRATEGY_CLASSES]).toEqual([...PLANNING_STRATEGY_CLASSES]);
    expect([...EGRESS_MODES]).toEqual([...POLICY_EGRESS]);
    expect([...SECRET_ACCESS_MODES]).toEqual([...POLICY_SECRET_ACCESS]);
    expect([...AUTONOMY_MODES]).toEqual([...POLICY_AUTONOMY]);
    expect([...ISOLATION_LEVELS]).toEqual([...POLICY_ISOLATION]);
    expect([...GENERATIVE_STEP_CLASSES]).toEqual(["generate", "call-model", "call-agent"]);
    expect(IR_INVARIANT_CODES.length).toBeGreaterThan(10);
    expect([...IR_PROVENANCE_SOURCES]).toEqual(["planning.governed-plan"]);
    expect([...IR_DERIVATION_BASES]).toEqual(["governed-plan-lossless-view"]);
    expect([...COMPUTATION_TYPES]).toEqual(["deterministic", "probabilistic", "human"]);
    expect(SIDE_EFFECT_CLASSES.length).toBe(7);
  });

  test("a governed plan derives to an IR losslessly and idempotently (cross-plane proof)", () => {
    const plan = governedPlan();
    const snapshot = planSource.toPlanSnapshot(plan);

    // The neutral snapshot's canonical form is byte-identical to the
    // planning module's own canonical plan form (lossless conversion —
    // the two serializers are pinned to the same discipline).
    expect(canonicalPlanFormOfSnapshot(snapshot)).toBe(canonicalPlanForm(plan));

    const ir = deriveExecutionIr(snapshot, digest);
    expect(ir.planId).toBe(plan.planId);
    expect(ir.planRevision).toBe(plan.revision);
    expect(ir.strategyClass).toBe(plan.strategyClass);
    expect(ir.modelCalls).toBe(plan.modelCalls);
    expect(ir.hasRouteRef).toBe(plan.hasRouteRef);
    expect(ir.provenance).toEqual({
      source: "planning.governed-plan",
      derivationBasis: "governed-plan-lossless-view",
    });

    // The reconstruction digests to the governed planId (losslessness).
    expect(digest.sha256Hex(planFormOfIr(ir))).toBe(plan.planId);

    // Idempotent re-derivation: same snapshot, same irId.
    const rederived = deriveExecutionIr(snapshot, digest);
    expect(rederived.irId).toBe(ir.irId);

    // Derived optimization facts match the frozen tables.
    const compute = ir.steps.find((step) => step.id === "compute-answer");
    expect(compute?.computationType).toBe("probabilistic");
    expect(compute?.sideEffectClass).toBe("model-inference");
    expect(compute?.routeRef).toEqual({ provider: "rail-a", model: "model-x" });
    const retrieve = ir.steps.find((step) => step.id === "retrieve-inputs");
    expect(retrieve?.computationType).toBe("deterministic");
    expect(retrieve?.sideEffectClass).toBe("pure");
    const verify = ir.steps.find((step) => step.id === "verify-answer");
    expect(verify?.sideEffectClass).toBe("verification");

    // The IR is deeply immutable.
    expect(Object.isFrozen(ir)).toBe(true);
    expect(Object.isFrozen(ir.steps)).toBe(true);
  });

  test("total validation round-trips a valid IR (both identities verified)", () => {
    const plan = governedPlan();
    const ir = deriveExecutionIr(planSource.toPlanSnapshot(plan), digest);
    const roundTripped = validateExecutionIr(JSON.parse(JSON.stringify(ir)), digest);
    expect(roundTripped.irId).toBe(ir.irId);
    expect(roundTripped.planId).toBe(ir.planId);
    expect(roundTripped.steps.length).toBe(ir.steps.length);
  });

  test("a snapshot claiming an identity its content does not have is rejected (second-authority boundary)", () => {
    const plan = governedPlan();
    const snapshot = planSource.toPlanSnapshot(plan);
    const forged = { ...snapshot, planId: "0".repeat(64) };
    expect(() => deriveExecutionIr(forged, digest)).toThrow(IrValidationError);
    try {
      deriveExecutionIr(forged, digest);
    } catch (error) {
      expect((error as IrValidationError).invariant).toBe("plan-identity-mismatch");
    }
  });

  test("drifted IR content is rejected by total validation (tamper proof)", () => {
    const plan = governedPlan();
    const ir = deriveExecutionIr(planSource.toPlanSnapshot(plan), digest);
    const tampered = JSON.parse(JSON.stringify(ir)) as Record<string, unknown>;
    const steps = tampered.steps as Record<string, unknown>[];
    (steps[0] as Record<string, unknown>).id = "drifted-step";
    expect(() => validateExecutionIr(tampered, digest)).toThrow(IrValidationError);

    // Repairing the identity claim but breaking the plan semantics is
    // STILL rejected (the plan reconstruction digest must match): drop a
    // step's verification anchor (semantic content, structure intact).
    const repaired = JSON.parse(JSON.stringify(ir)) as Record<string, unknown>;
    const repairedSteps = repaired.steps as Record<string, unknown>[];
    delete (repairedSteps[2] as Record<string, unknown>).verificationStrategy;
    const form = {
      irSchema: 1,
      planId: repaired.planId,
      planRevision: repaired.planRevision,
      strategyClass: repaired.strategyClass,
      steps: repairedSteps,
      edges: repaired.edges,
      provenance: repaired.provenance,
    };
    repaired.irId = digest.sha256Hex(canonicalIrForm(form as unknown as Omit<ExecutionIr, "irId">));
    expect(() => validateExecutionIr(repaired, digest)).toThrow(IrValidationError);
    try {
      validateExecutionIr(repaired, digest);
    } catch (error) {
      expect((error as IrValidationError).invariant).toBe("plan-identity-mismatch");
    }
  });

  test("route refs are legal only on generative steps (zero-model fabrication boundary)", () => {
    const plan = governedPlan();
    const snapshot = planSource.toPlanSnapshot(plan);
    const withRoute = {
      ...snapshot,
      steps: snapshot.steps.map((step) =>
        step.id === "retrieve-inputs"
          ? { ...step, routeRef: { provider: "rail-a", model: "model-x" } }
          : step,
      ),
    };
    expect(() => deriveExecutionIr(withRoute, digest)).toThrow(IrValidationError);
    try {
      deriveExecutionIr(withRoute, digest);
    } catch (error) {
      expect((error as IrValidationError).invariant).toBe("route-binding");
    }
  });

  test("structural violations are typed and bounded", () => {
    const plan = governedPlan();
    const snapshot = planSource.toPlanSnapshot(plan);

    // Duplicated step identity.
    const first = snapshot.steps[0] as GovernedPlanStep;
    const duplicated: GovernedPlanSnapshot = {
      ...snapshot,
      steps: [...snapshot.steps, { ...first }],
    };
    expect(() => deriveExecutionIr(duplicated, digest)).toThrow(/unique/i);

    // Unknown step class.
    const unknownClass: GovernedPlanSnapshot = {
      ...snapshot,
      steps: snapshot.steps.map((step, index) =>
        index === 0 ? { ...step, stepClass: "quantum-leap" } : step,
      ) as GovernedPlanStep[],
    };
    expect(() => deriveExecutionIr(unknownClass, digest)).toThrow(IrValidationError);

    // Self-loop edge.
    const selfLoop = {
      ...snapshot,
      edges: [...snapshot.edges, { from: "verify-answer", to: "verify-answer" }],
    };
    expect(() => deriveExecutionIr(selfLoop, digest)).toThrow(/self-loop/i);

    // Cycle.
    const cyclic = {
      ...snapshot,
      edges: [
        { from: "retrieve-inputs", to: "compute-answer" },
        { from: "compute-answer", to: "retrieve-inputs" },
      ],
    };
    expect(() => deriveExecutionIr(cyclic, digest)).toThrow(/acyclic/i);

    // Missing provenance on a presented IR value.
    const ir = deriveExecutionIr(snapshot, digest);
    const noProvenance = JSON.parse(JSON.stringify(ir)) as Record<string, unknown>;
    delete noProvenance.provenance;
    expect(() => validateExecutionIr(noProvenance, digest)).toThrow(IrValidationError);
    try {
      validateExecutionIr(noProvenance, digest);
    } catch (error) {
      expect((error as IrValidationError).invariant).toBe("provenance-missing");
    }

    // Unknown provenance vocabulary.
    const foreignSource = JSON.parse(JSON.stringify(ir)) as Record<string, unknown>;
    (foreignSource.provenance as Record<string, unknown>).source = "some-other-plan-authority";
    expect(() => validateExecutionIr(foreignSource, digest)).toThrow(IrValidationError);
    try {
      validateExecutionIr(foreignSource, digest);
    } catch (error) {
      expect((error as IrValidationError).invariant).toBe("provenance-vocabulary");
    }
  });

  test("a zero-model plan derives with no routes and deterministic-only consistency holds", () => {
    const plan = buildPlan(
      {
        revision: 3,
        strategyClass: "deterministic-only",
        steps: [
          { id: "run-algo", stepClass: "run-algorithm", capabilityId: "numeric-computation" },
          { id: "verify-result", stepClass: "verify", verificationStrategy: "exact-match" },
        ],
        edges: [{ from: "run-algo", to: "verify-result" }],
      },
      digestValue,
    );
    const snapshot = planSource.toPlanSnapshot(plan);
    const ir = deriveExecutionIr(snapshot, digest);
    expect(ir.modelCalls).toBe(0);
    expect(ir.hasRouteRef).toBe(false);
    expect(digest.sha256Hex(planFormOfIr(ir))).toBe(plan.planId);

    // deterministic-only + generative step is unrepresentable.
    expect(() =>
      deriveExecutionIr(
        {
          ...snapshot,
          steps: [
            ...snapshot.steps,
            {
              id: "generate-extra",
              stepClass: "generate",
              capabilityId: "text-generation",
              routeRef: { provider: "rail-a", model: "model-x" },
            },
          ],
        },
        digest,
      ),
    ).toThrow(/deterministic-only/i);
  });
});
