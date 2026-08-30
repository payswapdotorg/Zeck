/**
 * Immutable typed execution-plan DAG tests (planning module; WORK-009 /
 * INT-003, `spec/architecture.md` §9).
 *
 * Proves: DAG validation (acyclicity, refs, unique ids), immutability by
 * construction, content-addressed identity stability, the frozen step
 * vocabulary, and THE zero-model fabrication boundary — a zero-model plan
 * can never carry a provider/model route, and a deterministic step can
 * never name one (AC-11 negative boundary).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { PlanStep } from "../../../src/modules/planning/public";
import {
  buildPlan,
  canonicalPlanForm,
  PLAN_STEP_CLASSES,
} from "../../../src/modules/planning/public";
import { PlatformError } from "../../../src/shared/errors";

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

const DETERMINISTIC_STEPS = [
  { id: "compute", stepClass: "run-algorithm", capabilityId: "numeric-computation" },
  { id: "verify", stepClass: "verify", verificationStrategy: "exact-recomputation" },
] as const;

describe("execution plan DAG (INT-003)", () => {
  test("builds a valid deterministic plan with derived zero-model identity", () => {
    const plan = buildPlan(
      {
        revision: 1,
        strategyClass: "deterministic-only",
        steps: [...DETERMINISTIC_STEPS],
        edges: [{ from: "compute", to: "verify" }],
      },
      digest,
    );
    expect(plan.modelCalls).toBe(0);
    expect(plan.hasRouteRef).toBe(false);
    expect(plan.planId).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.steps).toHaveLength(2);
  });

  test("the built plan is deeply frozen (immutable by construction)", () => {
    const plan = buildPlan(
      {
        revision: 1,
        strategyClass: "deterministic-only",
        steps: [...DETERMINISTIC_STEPS],
        edges: [{ from: "compute", to: "verify" }],
      },
      digest,
    );
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.steps)).toBe(true);
    expect(Object.isFrozen(plan.steps[0])).toBe(true);
    expect(() => {
      (plan as unknown as { revision: number }).revision = 99;
    }).toThrow();
  });

  test("identical typed inputs produce identical planIds (content addressing)", () => {
    const a = buildPlan(
      {
        revision: 1,
        strategyClass: "deterministic-only",
        steps: [...DETERMINISTIC_STEPS],
        edges: [{ from: "compute", to: "verify" }],
      },
      digest,
    );
    const b = buildPlan(
      {
        revision: 1,
        strategyClass: "deterministic-only",
        steps: [...DETERMINISTIC_STEPS],
        edges: [{ from: "compute", to: "verify" }],
      },
      digest,
    );
    expect(a.planId).toBe(b.planId);
  });

  test("any semantic difference diverges the planId", () => {
    const base = buildPlan(
      {
        revision: 1,
        strategyClass: "deterministic-only",
        steps: [...DETERMINISTIC_STEPS],
        edges: [{ from: "compute", to: "verify" }],
      },
      digest,
    );
    const differentStep = buildPlan(
      {
        revision: 1,
        strategyClass: "deterministic-only",
        steps: [
          { id: "compute", stepClass: "run-algorithm", capabilityId: "numeric-computation" },
          { id: "verify", stepClass: "verify", verificationStrategy: "property-tests" },
        ],
        edges: [{ from: "compute", to: "verify" }],
      },
      digest,
    );
    const differentRevision = buildPlan(
      {
        revision: 2,
        strategyClass: "deterministic-only",
        steps: [...DETERMINISTIC_STEPS],
        edges: [{ from: "compute", to: "verify" }],
      },
      digest,
    );
    expect(base.planId).not.toBe(differentStep.planId);
    expect(base.planId).not.toBe(differentRevision.planId);
  });

  test("generative steps carry route references and derive modelCalls", () => {
    const plan = buildPlan(
      {
        revision: 1,
        strategyClass: "generative",
        steps: [
          {
            id: "model",
            stepClass: "call-model",
            capabilityId: "text-generation",
            routeRef: { provider: "rail-a", model: "model-x" },
          },
          { id: "verify", stepClass: "verify" },
        ],
        edges: [{ from: "model", to: "verify" }],
      },
      digest,
    );
    expect(plan.modelCalls).toBe(1);
    expect(plan.hasRouteRef).toBe(true);
  });

  test("cycles, dangling edges, duplicate ids and self-loops are rejected", () => {
    expect(() =>
      buildPlan(
        {
          revision: 1,
          strategyClass: "deterministic-only",
          steps: [...DETERMINISTIC_STEPS],
          edges: [
            { from: "compute", to: "verify" },
            { from: "verify", to: "compute" },
          ],
        },
        digest,
      ),
    ).toThrowError(/acyclic/);
    expect(() =>
      buildPlan(
        {
          revision: 1,
          strategyClass: "deterministic-only",
          steps: [...DETERMINISTIC_STEPS],
          edges: [{ from: "compute", to: "missing" }],
        },
        digest,
      ),
    ).toThrowError(/reference existing steps/);
    expect(() =>
      buildPlan(
        {
          revision: 1,
          strategyClass: "deterministic-only",
          steps: [...DETERMINISTIC_STEPS, { id: "compute", stepClass: "verify" }],
          edges: [],
        },
        digest,
      ),
    ).toThrowError(/unique/);
    expect(() =>
      buildPlan(
        {
          revision: 1,
          strategyClass: "deterministic-only",
          steps: [...DETERMINISTIC_STEPS],
          edges: [{ from: "compute", to: "compute" }],
        },
        digest,
      ),
    ).toThrowError(/self-loops/);
  });

  test("THE FABRICATION BOUNDARY: deterministic steps must not carry provider routes", () => {
    expect(() =>
      buildPlan(
        {
          revision: 1,
          strategyClass: "deterministic-only",
          steps: [
            {
              id: "compute",
              stepClass: "run-algorithm",
              capabilityId: "numeric-computation",
              routeRef: { provider: "rail-a", model: "model-x" },
            },
            { id: "verify", stepClass: "verify" },
          ],
          edges: [{ from: "compute", to: "verify" }],
        },
        digest,
      ),
    ).toThrowError(/must not carry a provider\/model route/);
  });

  test("THE FABRICATION BOUNDARY: generative steps without routes are rejected", () => {
    expect(() =>
      buildPlan(
        {
          revision: 1,
          strategyClass: "generative",
          steps: [
            { id: "model", stepClass: "call-model", capabilityId: "text-generation" },
            { id: "verify", stepClass: "verify" },
          ],
          edges: [{ from: "model", to: "verify" }],
        },
        digest,
      ),
    ).toThrowError(/generative steps must carry/);
  });

  test("a deterministic-only strategy with generative steps is rejected", () => {
    expect(() =>
      buildPlan(
        {
          revision: 1,
          strategyClass: "deterministic-only",
          steps: [
            {
              id: "model",
              stepClass: "generate",
              capabilityId: "text-generation",
              routeRef: { provider: "rail-a", model: "model-x" },
            },
            { id: "verify", stepClass: "verify" },
          ],
          edges: [{ from: "model", to: "verify" }],
        },
        digest,
      ),
    ).toThrowError(/deterministic-only plan must not contain generative steps/);
  });

  test("unknown step classes and invalid shapes fail typed", () => {
    expect(() =>
      buildPlan(
        {
          revision: 1,
          strategyClass: "deterministic-only",
          steps: [{ id: "x", stepClass: "teleport" }] as unknown as PlanStep[],
          edges: [],
        },
        digest,
      ),
    ).toThrowError(PlatformError);
    expect(() =>
      buildPlan(
        {
          revision: 0,
          strategyClass: "deterministic-only",
          steps: [...DETERMINISTIC_STEPS],
          edges: [],
        },
        digest,
      ),
    ).toThrowError(/revision/);
    expect(() =>
      buildPlan({ revision: 1, strategyClass: "deterministic-only", steps: [], edges: [] }, digest),
    ).toThrowError(/at least one step/);
  });

  test("non-finite configs are rejected (closed JSON universe)", () => {
    expect(() =>
      buildPlan(
        {
          revision: 1,
          strategyClass: "deterministic-only",
          steps: [{ id: "compute", stepClass: "run-algorithm", config: { ratio: Number.NaN } }],
          edges: [],
        },
        digest,
      ),
    ).toThrowError(/closed JSON universe/);
    expect(() =>
      buildPlan(
        {
          revision: 1,
          strategyClass: "deterministic-only",
          steps: [
            {
              id: "compute",
              stepClass: "run-algorithm",
              config: { ratio: Number.POSITIVE_INFINITY },
            },
          ],
          edges: [],
        },
        digest,
      ),
    ).toThrowError(/closed JSON universe/);
  });

  test("finite float configs serialize deterministically (quality probabilities)", () => {
    const plan = buildPlan(
      {
        revision: 1,
        strategyClass: "deterministic-only",
        steps: [
          { id: "compute", stepClass: "run-algorithm", config: { quality: 0.95 } },
          { id: "verify", stepClass: "verify" },
        ],
        edges: [{ from: "compute", to: "verify" }],
      },
      digest,
    );
    const same = buildPlan(
      {
        revision: 1,
        strategyClass: "deterministic-only",
        steps: [
          { id: "compute", stepClass: "run-algorithm", config: { quality: 0.95 } },
          { id: "verify", stepClass: "verify" },
        ],
        edges: [{ from: "compute", to: "verify" }],
      },
      digest,
    );
    expect(plan.planId).toBe(same.planId);
  });

  test("the canonical plan form is byte-stable across construction orderings", () => {
    const plan = buildPlan(
      {
        revision: 1,
        strategyClass: "deterministic-only",
        steps: [...DETERMINISTIC_STEPS],
        edges: [{ from: "compute", to: "verify" }],
      },
      digest,
    );
    const same = buildPlan(
      {
        revision: 1,
        strategyClass: "deterministic-only",
        steps: [...DETERMINISTIC_STEPS],
        edges: [{ from: "compute", to: "verify" }],
      },
      digest,
    );
    expect(canonicalPlanForm(plan)).toBe(canonicalPlanForm(same));
  });

  test("the step-class vocabulary is frozen to the architecture §9 set", () => {
    expect([...PLAN_STEP_CLASSES]).toEqual([
      "retrieve",
      "transform",
      "generate",
      "call-model",
      "call-tool",
      "call-agent",
      "run-program",
      "run-algorithm",
      "parallel",
      "branch",
      "verify",
      "compare",
      "ask-user",
      "ask-human",
      "retry",
      "escalate",
      "terminate",
    ]);
  });
});
