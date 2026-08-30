/**
 * Immutable typed execution plans (planning module domain; WORK-009 /
 * INT-003, `spec/architecture.md` §9, ADR-0011).
 *
 * An `ExecutionPlan` is an immutable-at-construction DAG over the frozen
 * architecture step classes (§9). Identity is content-addressed: `planId`
 * is the server-derived SHA-256 digest over the canonical serialization of
 * the plan's typed form (WORK-008 digest discipline). Zero-model plans are
 * first-class: `modelCalls` is DERIVED from the step classes, and a plan
 * with no generative steps simply carries `modelCalls === 0` and no route
 * references — fabricating a provider/model route for such a plan is
 * unrepresentable (`routeRef` is legal ONLY on generative step classes).
 *
 * Immutability is by construction: every array is copied and frozen at
 * build time; there is no mutation surface anywhere on the built plan.
 */

import { PlatformError } from "../../../shared/errors";
import { canonicalJson, isCanonicalizable } from "./canonical";

/** The frozen architecture step classes (`spec/architecture.md` §9). */
export const PLAN_STEP_CLASSES = [
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
] as const;

export type PlanStepClass = (typeof PLAN_STEP_CLASSES)[number];

/**
 * Step classes that invoke generative inference. Route references are
 * legal ONLY on these classes — a deterministic step naming a provider
 * route is a plan-construction error (fail closed).
 */
export const GENERATIVE_STEP_CLASSES: readonly PlanStepClass[] = [
  "generate",
  "call-model",
  "call-agent",
];

export function isGenerativeStepClass(value: PlanStepClass): boolean {
  return GENERATIVE_STEP_CLASSES.includes(value);
}

/** Strategy classes the planner composes (ADR-0011 required properties). */
export const STRATEGY_CLASSES = [
  "deterministic-only",
  "hybrid",
  "generative",
  "cascade",
  "bounded-evaluation",
] as const;

export type StrategyClass = (typeof STRATEGY_CLASSES)[number];

/**
 * A provider/model route reference — provider-NEUTRAL opaque strings
 * exactly like the policy restriction vocabulary (never SDK types, never
 * adapter handles; the provider fabric stays behind its adapters).
 */
export interface PlanStepRouteRef {
  readonly provider: string;
  readonly model: string;
}

export interface PlanStep {
  /** Stable step identifier, unique within the plan. */
  readonly id: string;
  readonly stepClass: PlanStepClass;
  /** Bound capability requirement id (deterministic facets + tools). */
  readonly capabilityId?: string;
  /** Selected provider/model route (generative steps only). */
  readonly routeRef?: PlanStepRouteRef;
  /** Closed-universe step parameters (digest-stable, integers only). */
  readonly config?: Readonly<Record<string, unknown>>;
  /** How this step's output is verified (carried to verification). */
  readonly verificationStrategy?: string;
}

export interface PlanEdge {
  readonly from: string;
  readonly to: string;
}

export interface ExecutionPlan {
  /** Content-addressed identity: sha256 over the canonical plan form. */
  readonly planId: string;
  /** Monotonic plan revision (a logical execution may hold many). */
  readonly revision: number;
  readonly strategyClass: StrategyClass;
  readonly steps: readonly PlanStep[];
  readonly edges: readonly PlanEdge[];
  /** DERIVED: number of generative steps (zero-model ⇒ 0). */
  readonly modelCalls: number;
  /** DERIVED: true when no step carries a route reference. */
  readonly hasRouteRef: boolean;
}

export interface BuildPlanInput {
  readonly revision: number;
  readonly strategyClass: StrategyClass;
  readonly steps: readonly PlanStep[];
  readonly edges: readonly PlanEdge[];
}

const STEP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function reject(message: string, details?: Record<string, unknown>): never {
  throw new PlatformError({ code: "POLICY_DENIED", message, details });
}

function deepFreeze<T>(value: T): T {
  if (Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value);
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    return Object.freeze(value);
  }
  return value;
}

function validateStep(step: unknown, index: number): PlanStep {
  if (step === null || typeof step !== "object" || Array.isArray(step)) {
    reject(`plan step ${index} must be an object`);
  }
  const record = step as Record<string, unknown>;
  if (typeof record.id !== "string" || !STEP_ID.test(record.id)) {
    reject(`plan step ${index} id must be a lowercase slug`, { got: String(record.id) });
  }
  if (
    typeof record.stepClass !== "string" ||
    !(PLAN_STEP_CLASSES as readonly string[]).includes(record.stepClass)
  ) {
    reject(`plan step ${record.id} carries an unknown step class`, {
      got: String(record.stepClass),
    });
  }
  const stepClass = record.stepClass as PlanStepClass;
  if (record.capabilityId !== undefined) {
    if (typeof record.capabilityId !== "string" || record.capabilityId.length === 0) {
      reject(`plan step ${record.id} capabilityId must be a non-empty string when present`);
    }
  }
  if (isGenerativeStepClass(stepClass) && record.capabilityId === undefined) {
    reject(`plan step ${record.id} generative steps must bind a capability`);
  }
  if (record.routeRef !== undefined) {
    if (
      record.routeRef === null ||
      typeof record.routeRef !== "object" ||
      Array.isArray(record.routeRef)
    ) {
      reject(`plan step ${record.id} routeRef must be an object when present`);
    }
    const route = record.routeRef as Record<string, unknown>;
    if (typeof route.provider !== "string" || route.provider.length === 0) {
      reject(`plan step ${record.id} routeRef.provider must be a non-empty string`);
    }
    if (typeof route.model !== "string" || route.model.length === 0) {
      reject(`plan step ${record.id} routeRef.model must be a non-empty string`);
    }
    if (!isGenerativeStepClass(stepClass)) {
      // The zero-model fabrication boundary: deterministic steps never
      // name provider/model routes.
      reject(
        `plan step ${record.id} of class ${stepClass} must not carry a provider/model route (routes are legal only on generative steps)`,
        { stepClass },
      );
    }
  }
  if (record.config !== undefined) {
    if (
      record.config === null ||
      typeof record.config !== "object" ||
      Array.isArray(record.config)
    ) {
      reject(`plan step ${record.id} config must be an object when present`);
    }
    if (!isCanonicalizable(record.config)) {
      reject(`plan step ${record.id} config must be inside the closed JSON universe`, {
        stepId: record.id,
      });
    }
  }
  if (record.verificationStrategy !== undefined) {
    if (
      typeof record.verificationStrategy !== "string" ||
      record.verificationStrategy.length === 0
    ) {
      reject(`plan step ${record.id} verificationStrategy must be a non-empty string`);
    }
  }
  return {
    id: record.id,
    stepClass,
    ...(record.capabilityId === undefined ? {} : { capabilityId: record.capabilityId }),
    ...(record.routeRef === undefined
      ? {}
      : {
          routeRef: {
            provider: (record.routeRef as Record<string, unknown>).provider as string,
            model: (record.routeRef as Record<string, unknown>).model as string,
          },
        }),
    ...(record.config === undefined
      ? {}
      : { config: record.config as Readonly<Record<string, unknown>> }),
    ...(record.verificationStrategy === undefined
      ? {}
      : { verificationStrategy: record.verificationStrategy }),
  };
}

/** Does the step graph form a DAG (Kahn topological check)? */
function assertAcyclic(steps: readonly PlanStep[], edges: readonly PlanEdge[]): void {
  const indegree = new Map<string, number>(steps.map((step) => [step.id, 0]));
  const outgoing = new Map<string, string[]>(steps.map((step) => [step.id, []]));
  for (const edge of edges) {
    outgoing.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const queue = steps.filter((step) => (indegree.get(step.id) ?? 0) === 0).map((s) => s.id);
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift() as string;
    visited += 1;
    for (const next of outgoing.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
      }
    }
  }
  if (visited !== steps.length) {
    reject("plan step graph must be acyclic (a cycle was detected)");
  }
}

/**
 * Build an immutable execution plan: validates the full typed shape,
 * derives `modelCalls`/`hasRouteRef`, freezes every layer and computes
 * the content-addressed `planId` via the injected digest function
 * (server-derived identity — callers never supply a planId).
 */
export function buildPlan(
  input: BuildPlanInput,
  digest: (value: unknown) => string,
): ExecutionPlan {
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    reject("plan revision must be a positive integer");
  }
  if (
    typeof input.strategyClass !== "string" ||
    !(STRATEGY_CLASSES as readonly string[]).includes(input.strategyClass)
  ) {
    reject("plan strategyClass is outside the frozen vocabulary", {
      got: String(input.strategyClass),
    });
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    reject("a plan requires at least one step");
  }
  const steps = input.steps.map((step, index) => validateStep(step, index));
  const stepIds = new Set(steps.map((step) => step.id));
  if (stepIds.size !== steps.length) {
    reject("plan step ids must be unique");
  }
  if (!Array.isArray(input.edges)) {
    reject("plan edges must be an array");
  }
  const edges: PlanEdge[] = [];
  for (const edge of input.edges) {
    if (edge === null || typeof edge !== "object") {
      reject("each plan edge must be an object");
    }
    const record = edge as Record<string, unknown>;
    if (typeof record.from !== "string" || typeof record.to !== "string") {
      reject("each plan edge must carry string from/to");
    }
    if (!stepIds.has(record.from) || !stepIds.has(record.to)) {
      reject("plan edges must reference existing steps", {
        from: record.from,
        to: record.to,
      });
    }
    if (record.from === record.to) {
      reject("plan edges must not be self-loops", { step: record.from });
    }
    edges.push({ from: record.from, to: record.to });
  }
  assertAcyclic(steps, edges);

  const modelCalls = steps.filter((step) => isGenerativeStepClass(step.stepClass)).length;
  const hasRouteRef = steps.some((step) => step.routeRef !== undefined);

  // Consistency: a zero-model plan NEVER fabricates route references, and a
  // strategy class of deterministic-only never carries generative steps.
  if (modelCalls === 0 && hasRouteRef) {
    reject("a zero-model plan must not carry provider/model route references");
  }
  if (input.strategyClass === "deterministic-only" && modelCalls > 0) {
    reject("a deterministic-only plan must not contain generative steps");
  }
  if (modelCalls > 0 && !hasRouteRef) {
    reject("generative steps must carry provider/model route references");
  }

  const canonicalForm = {
    planSchema: 1,
    revision: input.revision,
    strategyClass: input.strategyClass,
    steps,
    edges,
  };
  const planId = digest(canonicalForm);

  return deepFreeze({
    planId,
    revision: input.revision,
    strategyClass: input.strategyClass,
    steps,
    edges,
    modelCalls,
    hasRouteRef,
  });
}

/**
 * The canonical serialization of a plan (the exact bytes the digest
 * covers). Exposed for reproducibility proofs.
 */
export function canonicalPlanForm(plan: ExecutionPlan): string {
  return canonicalJson({
    planSchema: 1,
    revision: plan.revision,
    strategyClass: plan.strategyClass,
    steps: plan.steps,
    edges: plan.edges,
  });
}
