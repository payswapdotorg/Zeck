/**
 * The Execution Intermediate Representation (platform execution-ir plane;
 * WORK-049 / E1.1 foundation — ADR-0019 §3, ADR-0020).
 *
 * The Execution IR is a machine-readable, optimizable REPRESENTATION of a
 * governed execution plan. It is NEVER a second plan authority
 * (architecture invariant 1):
 *
 *  - it is DERIVED, deterministically and totally, from a neutral
 *    `GovernedPlanSnapshot` produced through the declared planning seam
 *    (the plan stays the planner's authority; the executions ledger stays
 *    the durable plan-decision authority);
 *  - the derivation is LOSSLESS with respect to plan semantics — the
 *    canonical plan form is reconstructible from the IR and its digest
 *    MUST equal the governed `planId` (identity preservation + the
 *    anti-second-authority proof in one check: an IR that drifted from
 *    the governed plan is unrepresentable);
 *  - derivation is IDEMPOTENT: the same snapshot always produces the
 *    same content-addressed `irId` (re-derivation drift is detectable);
 *  - validation is DETERMINISTIC and TOTAL: every rejection is a typed,
 *    bounded `IrValidationError` naming the violated invariant
 *    (invariant 2).
 *
 * Step-level optimization facts (ADR-0019 §3) are DERIVED from the frozen
 * architecture step classes (`spec/architecture.md` §9) through frozen
 * tables — never invented: computation type (deterministic /
 * probabilistic / human) and side-effect class. Model/provider route
 * references stay provider-NEUTRAL opaque strings exactly like the policy
 * restriction vocabulary; capability references and verification anchors
 * are carried verbatim from the governed plan.
 *
 * This plane is platform code: it imports no module, keeps no state and
 * runs no lifecycle (no state machine — architecture invariant 7); the
 * digest is injected so the plane stays pure and testable.
 */

import { canonicalJson, isCanonicalizable } from "./canonical";

// ---------------------------------------------------------------------------
// Typed, bounded validation errors (invariant 2)
// ---------------------------------------------------------------------------

/**
 * The closed vocabulary of Execution IR invariants. Every rejection
 * names exactly one of these — machine-checkable, bounded evidence.
 */
export const IR_INVARIANT_CODES = [
  "snapshot-shape",
  "step-vocabulary",
  "step-identity",
  "edge-structure",
  "plan-identity-mismatch",
  "route-binding",
  "strategy-consistency",
  "ir-shape",
  "ir-identity-mismatch",
  "provenance-missing",
  "provenance-vocabulary",
  "canonical-universe",
] as const;

export type IrInvariantCode = (typeof IR_INVARIANT_CODES)[number];

/** Bounded detail carried by a validation error (never unbounded payloads). */
export interface IrErrorDetails {
  readonly [key: string]: string | number | boolean | null;
}

/**
 * The typed, bounded IR validation error. `invariant` names the violated
 * invariant; `details` carries only bounded scalar evidence (identifiers
 * are truncated; payloads are never echoed wholesale).
 */
export class IrValidationError extends Error {
  readonly invariant: IrInvariantCode;
  readonly details: IrErrorDetails;

  constructor(invariant: IrInvariantCode, message: string, details?: IrErrorDetails) {
    super(message);
    this.name = "IrValidationError";
    this.invariant = invariant;
    this.details = Object.freeze({ ...details }) as IrErrorDetails;
  }
}

const DETAIL_LIMIT = 200;

function bounded(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

function reject(invariant: IrInvariantCode, message: string, details?: IrErrorDetails): never {
  const boundedDetails: Record<string, string | number | boolean | null> = {};
  if (details !== undefined) {
    for (const [key, value] of Object.entries(details)) {
      boundedDetails[key] = typeof value === "string" ? bounded(value) : value;
    }
  }
  throw new IrValidationError(invariant, message, boundedDetails);
}

// ---------------------------------------------------------------------------
// Frozen vocabularies (mirrored from the governed plan contract)
// ---------------------------------------------------------------------------

/**
 * The frozen architecture step classes (`spec/architecture.md` §9). The
 * neutral snapshot carries the same closed vocabulary as the planning
 * module's public contract — boundary tests pin the two vocabularies
 * together so this mirror cannot drift silently.
 */
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

/** Step classes that invoke generative inference (routes legal only here). */
export const GENERATIVE_STEP_CLASSES: readonly PlanStepClass[] = [
  "generate",
  "call-model",
  "call-agent",
];

export function isGenerativeStepClass(value: PlanStepClass): boolean {
  return GENERATIVE_STEP_CLASSES.includes(value);
}

/** Strategy classes of the governed plan (planning module vocabulary). */
export const STRATEGY_CLASSES = [
  "deterministic-only",
  "hybrid",
  "generative",
  "cascade",
  "bounded-evaluation",
] as const;

export type StrategyClass = (typeof STRATEGY_CLASSES)[number];

/**
 * Computation type of a step (ADR-0019 §3 "deterministic vs
 * probabilistic", plus the human-interaction representation the frozen
 * step vocabulary carries). DERIVED from the frozen step classes — a
 * descriptive optimization fact, never an authority.
 */
export const COMPUTATION_TYPES = ["deterministic", "probabilistic", "human"] as const;
export type ComputationType = (typeof COMPUTATION_TYPES)[number];

const COMPUTATION_TYPE_BY_CLASS: Readonly<Record<PlanStepClass, ComputationType>> = {
  retrieve: "deterministic",
  transform: "deterministic",
  generate: "probabilistic",
  "call-model": "probabilistic",
  "call-tool": "deterministic",
  "call-agent": "probabilistic",
  "run-program": "deterministic",
  "run-algorithm": "deterministic",
  parallel: "deterministic",
  branch: "deterministic",
  verify: "deterministic",
  compare: "deterministic",
  "ask-user": "human",
  "ask-human": "human",
  retry: "deterministic",
  escalate: "deterministic",
  terminate: "deterministic",
};

/**
 * Side-effect class of a step (ADR-0019 §3 "risk/side-effect class").
 * DERIVED from the frozen step classes — a descriptive optimization
 * fact consumed by side-effect constraints, never an authority:
 *
 *  - `pure` — computation/retrieval/branching with no external effect;
 *  - `sandboxed-compute` — bounded program execution inside the sandbox
 *    authority;
 *  - `model-inference` — probabilistic inference (cost-incurring, no
 *    direct external effect);
 *  - `external-effect` — governed tool invocation crossing the external
 *    side-effect boundary;
 *  - `verification` — verification observation (evidence-producing);
 *  - `human-interaction` — governed user/human interaction;
 *  - `control-flow` — execution control (retry/escalation/termination).
 */
export const SIDE_EFFECT_CLASSES = [
  "pure",
  "sandboxed-compute",
  "model-inference",
  "external-effect",
  "verification",
  "human-interaction",
  "control-flow",
] as const;
export type SideEffectClass = (typeof SIDE_EFFECT_CLASSES)[number];

const SIDE_EFFECT_CLASS_BY_STEP: Readonly<Record<PlanStepClass, SideEffectClass>> = {
  retrieve: "pure",
  transform: "pure",
  generate: "model-inference",
  "call-model": "model-inference",
  "call-tool": "external-effect",
  "call-agent": "model-inference",
  "run-program": "sandboxed-compute",
  "run-algorithm": "pure",
  parallel: "pure",
  branch: "pure",
  verify: "verification",
  compare: "pure",
  "ask-user": "human-interaction",
  "ask-human": "human-interaction",
  retry: "control-flow",
  escalate: "control-flow",
  terminate: "control-flow",
};

export function computationTypeOfStep(stepClass: PlanStepClass): ComputationType {
  return COMPUTATION_TYPE_BY_CLASS[stepClass];
}

export function sideEffectClassOfStep(stepClass: PlanStepClass): SideEffectClass {
  return SIDE_EFFECT_CLASS_BY_STEP[stepClass];
}

// ---------------------------------------------------------------------------
// The neutral governed-plan snapshot (the planning seam's data shape)
// ---------------------------------------------------------------------------

/** Provider/model route reference — provider-NEUTRAL opaque strings. */
export interface IrRouteRef {
  readonly provider: string;
  readonly model: string;
}

/** A governed plan step in neutral form (exact plan semantics). */
export interface GovernedPlanStep {
  /** Stable step identifier, unique within the plan (plan slug rule). */
  readonly id: string;
  readonly stepClass: PlanStepClass;
  /** Bound capability requirement id (deterministic facets + tools). */
  readonly capabilityId?: string;
  /** Selected provider/model route (generative steps only). */
  readonly routeRef?: IrRouteRef;
  /** Closed-universe step parameters (digest-stable). */
  readonly config?: Readonly<Record<string, unknown>>;
  /** Verification anchor carried from the governed plan, when present. */
  readonly verificationStrategy?: string;
}

export interface GovernedPlanEdge {
  readonly from: string;
  readonly to: string;
}

/**
 * The neutral snapshot of a GOVERNED plan, produced through the declared
 * planning seam. Carries the plan's exact semantics plus its
 * content-addressed identity — the derivation VERIFIES that the content
 * digests to the claimed `planId`, so a snapshot (or an IR) cannot claim
 * an identity it does not have (the second-authority boundary).
 */
export interface GovernedPlanSnapshot {
  /** Content-addressed identity: sha256 over the canonical plan form. */
  readonly planId: string;
  /** Monotonic plan revision (a logical execution may hold many). */
  readonly revision: number;
  readonly strategyClass: StrategyClass;
  readonly steps: readonly GovernedPlanStep[];
  readonly edges: readonly GovernedPlanEdge[];
}

// ---------------------------------------------------------------------------
// The Execution IR
// ---------------------------------------------------------------------------

/**
 * IR provenance — the exact, closed record of where this IR came from.
 * The only legitimate source in the E1.1 foundation is the governed plan
 * derived through the planning seam; anything else is rejected
 * (invariants 1, 6, 8).
 */
export const IR_PROVENANCE_SOURCES = ["planning.governed-plan"] as const;
export type IrProvenanceSource = (typeof IR_PROVENANCE_SOURCES)[number];

/** The only derivation basis in the E1.1 foundation (lossless view). */
export const IR_DERIVATION_BASES = ["governed-plan-lossless-view"] as const;
export type IrDerivationBasis = (typeof IR_DERIVATION_BASES)[number];

export interface IrProvenance {
  readonly source: IrProvenanceSource;
  readonly derivationBasis: IrDerivationBasis;
}

/** An IR step: plan semantics plus the DERIVED optimization facts. */
export interface IrStep {
  readonly id: string;
  readonly stepClass: PlanStepClass;
  /** Derived: deterministic | probabilistic | human. */
  readonly computationType: ComputationType;
  /** Derived: side-effect class of the frozen step vocabulary. */
  readonly sideEffectClass: SideEffectClass;
  readonly capabilityId?: string;
  readonly routeRef?: IrRouteRef;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly verificationStrategy?: string;
}

export interface IrEdge {
  readonly from: string;
  readonly to: string;
}

/** The Execution IR: a lossless, optimizable representation of a plan. */
export interface ExecutionIr {
  /** Content-addressed IR identity: sha256 over the canonical IR form. */
  readonly irId: string;
  /** Schema version of the IR (frozen for E1.1 foundation). */
  readonly irSchema: 1;
  /** The GOVERNED plan identity — preserved verbatim, never re-derived. */
  readonly planId: string;
  readonly planRevision: number;
  readonly strategyClass: StrategyClass;
  readonly steps: readonly IrStep[];
  readonly edges: readonly IrEdge[];
  /** DERIVED: number of generative steps (must match the plan's). */
  readonly modelCalls: number;
  /** DERIVED: true when any step carries a route reference. */
  readonly hasRouteRef: boolean;
  readonly provenance: IrProvenance;
}

/** The injected digest port (sha256, lowercase hex — the plan discipline). */
export interface IrDigestPort {
  sha256Hex(value: string): string;
}

const STEP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Snapshot validation (total, deterministic)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSnapshotStep(step: unknown, index: number): GovernedPlanStep {
  if (!isRecord(step)) {
    reject("snapshot-shape", `plan step ${index} must be an object`);
  }
  if (typeof step.id !== "string" || !STEP_ID.test(step.id)) {
    reject("snapshot-shape", `plan step ${index} id must be a lowercase slug`, {
      got: bounded(step.id),
    });
  }
  if (
    typeof step.stepClass !== "string" ||
    !(PLAN_STEP_CLASSES as readonly string[]).includes(step.stepClass)
  ) {
    reject("step-vocabulary", `plan step ${step.id} carries an unknown step class`, {
      got: bounded(step.stepClass),
    });
  }
  const stepClass = step.stepClass as PlanStepClass;
  if (step.capabilityId !== undefined) {
    if (typeof step.capabilityId !== "string" || step.capabilityId.length === 0) {
      reject("snapshot-shape", `plan step ${step.id} capabilityId must be a non-empty string`);
    }
  }
  if (isGenerativeStepClass(stepClass) && step.capabilityId === undefined) {
    reject("route-binding", `plan step ${step.id} generative steps must bind a capability`);
  }
  if (step.routeRef !== undefined) {
    if (!isRecord(step.routeRef)) {
      reject("snapshot-shape", `plan step ${step.id} routeRef must be an object when present`);
    }
    const provider = step.routeRef.provider;
    const model = step.routeRef.model;
    if (typeof provider !== "string" || provider.length === 0) {
      reject("snapshot-shape", `plan step ${step.id} routeRef.provider must be a non-empty string`);
    }
    if (typeof model !== "string" || model.length === 0) {
      reject("snapshot-shape", `plan step ${step.id} routeRef.model must be a non-empty string`);
    }
    if (!isGenerativeStepClass(stepClass)) {
      // The zero-model fabrication boundary (the governed plan's own rule):
      // deterministic steps never name provider/model routes.
      reject(
        "route-binding",
        `plan step ${step.id} of class ${stepClass} must not carry a provider/model route (routes are legal only on generative steps)`,
        { stepClass },
      );
    }
  }
  if (step.config !== undefined) {
    if (!isRecord(step.config)) {
      reject("snapshot-shape", `plan step ${step.id} config must be an object when present`);
    }
    if (!isCanonicalizable(step.config)) {
      reject(
        "canonical-universe",
        `plan step ${step.id} config must be inside the closed JSON universe`,
      );
    }
  }
  if (step.verificationStrategy !== undefined) {
    if (typeof step.verificationStrategy !== "string" || step.verificationStrategy.length === 0) {
      reject(
        "snapshot-shape",
        `plan step ${step.id} verificationStrategy must be a non-empty string when present`,
      );
    }
  }
  const routeRecord = step.routeRef as Record<string, unknown> | undefined;
  return {
    id: step.id,
    stepClass,
    ...(step.capabilityId === undefined ? {} : { capabilityId: step.capabilityId as string }),
    ...(routeRecord === undefined
      ? {}
      : {
          routeRef: {
            provider: routeRecord.provider as string,
            model: routeRecord.model as string,
          },
        }),
    ...(step.config === undefined ? {} : { config: step.config }),
    ...(step.verificationStrategy === undefined
      ? {}
      : { verificationStrategy: step.verificationStrategy as string }),
  };
}

/** Does the step graph form a DAG (Kahn topological check)? */
function assertAcyclic(stepIds: readonly string[], edges: readonly GovernedPlanEdge[]): void {
  const indegree = new Map<string, number>(stepIds.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>(stepIds.map((id) => [id, []]));
  for (const edge of edges) {
    outgoing.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const queue = stepIds.filter((id) => (indegree.get(id) ?? 0) === 0);
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
  if (visited !== stepIds.length) {
    reject("edge-structure", "plan step graph must be acyclic (a cycle was detected)");
  }
}

/**
 * Validate a governed-plan snapshot: closed shapes, frozen vocabularies,
 * structural invariants — the governed plan's own construction rules,
 * mirrored over the neutral form. Total and deterministic.
 */
export function validateGovernedPlanSnapshot(value: unknown): GovernedPlanSnapshot {
  if (!isRecord(value)) {
    reject("snapshot-shape", "governed plan snapshot must be an object");
  }
  if (typeof value.planId !== "string" || !SHA256_HEX.test(value.planId)) {
    reject("snapshot-shape", "snapshot planId must be a sha256 hex digest", {
      got: bounded(value.planId),
    });
  }
  if (!Number.isInteger(value.revision) || (value.revision as number) < 1) {
    reject("snapshot-shape", "snapshot revision must be a positive integer");
  }
  if (
    typeof value.strategyClass !== "string" ||
    !(STRATEGY_CLASSES as readonly string[]).includes(value.strategyClass)
  ) {
    reject("strategy-consistency", "snapshot strategyClass is outside the frozen vocabulary", {
      got: bounded(value.strategyClass),
    });
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    reject("snapshot-shape", "a plan snapshot requires at least one step");
  }
  const steps = value.steps.map((step, index) => validateSnapshotStep(step, index));
  const stepIds = new Set(steps.map((step) => step.id));
  if (stepIds.size !== steps.length) {
    reject("step-identity", "plan step ids must be unique");
  }
  if (!Array.isArray(value.edges)) {
    reject("snapshot-shape", "snapshot edges must be an array");
  }
  const edges: GovernedPlanEdge[] = [];
  for (const edge of value.edges) {
    if (!isRecord(edge)) {
      reject("snapshot-shape", "each plan edge must be an object");
    }
    if (typeof edge.from !== "string" || typeof edge.to !== "string") {
      reject("snapshot-shape", "each plan edge must carry string from/to");
    }
    if (!stepIds.has(edge.from) || !stepIds.has(edge.to)) {
      reject("edge-structure", "plan edges must reference existing steps", {
        from: bounded(edge.from),
        to: bounded(edge.to),
      });
    }
    if (edge.from === edge.to) {
      reject("edge-structure", "plan edges must not be self-loops", { step: bounded(edge.from) });
    }
    edges.push({ from: edge.from, to: edge.to });
  }
  assertAcyclic([...stepIds], edges);

  const modelCalls = steps.filter((step) => isGenerativeStepClass(step.stepClass)).length;
  const hasRouteRef = steps.some((step) => step.routeRef !== undefined);
  // Consistency (the governed plan's own rules, mirrored): zero-model
  // plans never fabricate routes; deterministic-only never generates;
  // generative plans always carry routes.
  if (modelCalls === 0 && hasRouteRef) {
    reject(
      "strategy-consistency",
      "a zero-model plan must not carry provider/model route references",
    );
  }
  if (value.strategyClass === "deterministic-only" && modelCalls > 0) {
    reject("strategy-consistency", "a deterministic-only plan must not contain generative steps");
  }
  if (modelCalls > 0 && !hasRouteRef) {
    reject("strategy-consistency", "generative steps must carry provider/model route references");
  }
  return {
    planId: value.planId,
    revision: value.revision as number,
    strategyClass: value.strategyClass as StrategyClass,
    steps,
    edges,
  };
}

// ---------------------------------------------------------------------------
// Canonical forms and identity reconstruction
// ---------------------------------------------------------------------------

/**
 * The canonical PLAN form of a snapshot — the exact bytes the governed
 * `planId` digest covers (`planSchema: 1` + the semantic fields; the
 * planning module's public canonical-plan contract, mirrored over the
 * neutral form; boundary tests pin the two byte-for-byte).
 */
export function canonicalPlanFormOfSnapshot(snapshot: GovernedPlanSnapshot): string {
  return canonicalJson({
    planSchema: 1,
    revision: snapshot.revision,
    strategyClass: snapshot.strategyClass,
    steps: snapshot.steps,
    edges: snapshot.edges,
  });
}

/**
 * Reconstruct the canonical plan form from an IR (the losslessness
 * proof's core): strip the DERIVED optimization facts and re-serialize
 * the exact plan semantics. `digest(planFormOfIr(ir))` MUST equal
 * `ir.planId`.
 */
export function planFormOfIr(ir: ExecutionIr): string {
  const steps = ir.steps.map((step) => ({
    id: step.id,
    stepClass: step.stepClass,
    ...(step.capabilityId === undefined ? {} : { capabilityId: step.capabilityId }),
    ...(step.routeRef === undefined
      ? {}
      : { routeRef: { provider: step.routeRef.provider, model: step.routeRef.model } }),
    ...(step.config === undefined ? {} : { config: step.config }),
    ...(step.verificationStrategy === undefined
      ? {}
      : { verificationStrategy: step.verificationStrategy }),
  }));
  return canonicalJson({
    planSchema: 1,
    revision: ir.planRevision,
    strategyClass: ir.strategyClass,
    steps,
    edges: ir.edges,
  });
}

/** The canonical IR form — the exact bytes the `irId` digest covers. */
export function canonicalIrForm(ir: Omit<ExecutionIr, "irId">): string {
  return canonicalJson({
    irSchema: ir.irSchema,
    planId: ir.planId,
    planRevision: ir.planRevision,
    strategyClass: ir.strategyClass,
    steps: ir.steps,
    edges: ir.edges,
    provenance: ir.provenance,
  });
}

// ---------------------------------------------------------------------------
// Derivation (deterministic, idempotent) and total validation
// ---------------------------------------------------------------------------

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

/**
 * Derive the Execution IR from a governed-plan snapshot.
 *
 * Deterministic and idempotent: the same snapshot always yields the same
 * content-addressed `irId`. The derivation VERIFIES that the snapshot
 * content digests to the claimed governed `planId` — a snapshot that
 * claims an identity its content does not have is rejected
 * (`plan-identity-mismatch`), which is the anti-second-authority
 * boundary: the IR can only represent an actual governed plan.
 */
export function deriveExecutionIr(
  snapshot: GovernedPlanSnapshot,
  digest: IrDigestPort,
): ExecutionIr {
  const validated = validateGovernedPlanSnapshot(snapshot);

  // Identity verification: the snapshot content must digest to the
  // claimed governed plan identity (losslessness precondition; the plan
  // authority's own content addressing).
  const planDigest = digest.sha256Hex(canonicalPlanFormOfSnapshot(validated));
  if (planDigest !== validated.planId) {
    reject("plan-identity-mismatch", "snapshot content does not digest to the claimed planId", {
      claimed: validated.planId,
      computed: planDigest,
    });
  }

  const steps: IrStep[] = validated.steps.map((step) => ({
    id: step.id,
    stepClass: step.stepClass,
    computationType: computationTypeOfStep(step.stepClass),
    sideEffectClass: sideEffectClassOfStep(step.stepClass),
    ...(step.capabilityId === undefined ? {} : { capabilityId: step.capabilityId }),
    ...(step.routeRef === undefined ? {} : { routeRef: step.routeRef }),
    ...(step.config === undefined ? {} : { config: step.config }),
    ...(step.verificationStrategy === undefined
      ? {}
      : { verificationStrategy: step.verificationStrategy }),
  }));
  const edges: IrEdge[] = validated.edges.map((edge) => ({ from: edge.from, to: edge.to }));
  const modelCalls = steps.filter((step) => isGenerativeStepClass(step.stepClass)).length;
  const hasRouteRef = steps.some((step) => step.routeRef !== undefined);

  const form: Omit<ExecutionIr, "irId"> = {
    irSchema: 1,
    planId: validated.planId,
    planRevision: validated.revision,
    strategyClass: validated.strategyClass,
    steps,
    edges,
    modelCalls,
    hasRouteRef,
    provenance: {
      source: "planning.governed-plan",
      derivationBasis: "governed-plan-lossless-view",
    },
  };
  const irId = digest.sha256Hex(canonicalIrForm(form));
  return deepFreeze({ ...form, irId });
}

/**
 * Total, deterministic validation of an Execution IR value (e.g. after a
 * store round-trip): closed shape, frozen vocabularies, structural
 * invariants, provenance presence, AND identity verification — the
 * content must digest to the claimed `irId` and the reconstructed plan
 * semantics must digest to the claimed governed `planId` (drift or
 * tampering is unrepresentable). Every rejection is a typed, bounded
 * `IrValidationError`.
 */
export function validateExecutionIr(value: unknown, digest: IrDigestPort): ExecutionIr {
  if (!isRecord(value)) {
    reject("ir-shape", "execution IR must be an object");
  }
  if (typeof value.irId !== "string" || !SHA256_HEX.test(value.irId)) {
    reject("ir-shape", "execution IR irId must be a sha256 hex digest", {
      got: bounded(value.irId),
    });
  }
  if (value.irSchema !== 1) {
    reject("ir-shape", "execution IR schema version must be 1", { got: bounded(value.irSchema) });
  }
  if (typeof value.planId !== "string" || !SHA256_HEX.test(value.planId)) {
    reject("ir-shape", "execution IR planId must be a sha256 hex digest", {
      got: bounded(value.planId),
    });
  }
  if (!Number.isInteger(value.planRevision) || (value.planRevision as number) < 1) {
    reject("ir-shape", "execution IR planRevision must be a positive integer");
  }
  if (
    typeof value.strategyClass !== "string" ||
    !(STRATEGY_CLASSES as readonly string[]).includes(value.strategyClass)
  ) {
    reject("ir-shape", "execution IR strategyClass is outside the frozen vocabulary", {
      got: bounded(value.strategyClass),
    });
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    reject("ir-shape", "execution IR requires at least one step");
  }
  const steps: IrStep[] = [];
  for (const step of value.steps) {
    if (!isRecord(step)) {
      reject("ir-shape", "each IR step must be an object");
    }
    if (typeof step.id !== "string" || !STEP_ID.test(step.id)) {
      reject("ir-shape", `IR step id must be a lowercase slug`, { got: bounded(step.id) });
    }
    if (
      typeof step.stepClass !== "string" ||
      !(PLAN_STEP_CLASSES as readonly string[]).includes(step.stepClass)
    ) {
      reject("step-vocabulary", `IR step ${step.id} carries an unknown step class`, {
        got: bounded(step.stepClass),
      });
    }
    const stepClass = step.stepClass as PlanStepClass;
    if (
      step.computationType !== computationTypeOfStep(stepClass) ||
      step.sideEffectClass !== sideEffectClassOfStep(stepClass)
    ) {
      // Derived facts are frozen tables over the step class — a step
      // carrying drifted facts is unrepresentable.
      reject("ir-shape", `IR step ${step.id} derived optimization facts do not match its class`, {
        stepClass,
        computationType: bounded(step.computationType),
        sideEffectClass: bounded(step.sideEffectClass),
      });
    }
    if (step.routeRef !== undefined && !isGenerativeStepClass(stepClass)) {
      reject("route-binding", `IR step ${step.id} of class ${stepClass} must not carry a route`);
    }
    if (step.config !== undefined && !isRecord(step.config)) {
      reject("ir-shape", `IR step ${step.id} config must be an object when present`);
    }
    if (
      step.capabilityId !== undefined &&
      (typeof step.capabilityId !== "string" || step.capabilityId.length === 0)
    ) {
      reject("ir-shape", `IR step ${step.id} capabilityId must be a non-empty string when present`);
    }
    if (
      step.verificationStrategy !== undefined &&
      (typeof step.verificationStrategy !== "string" || step.verificationStrategy.length === 0)
    ) {
      reject(
        "ir-shape",
        `IR step ${step.id} verificationStrategy must be a non-empty string when present`,
      );
    }
    if (step.routeRef !== undefined && !isRecord(step.routeRef)) {
      reject("ir-shape", `IR step ${step.id} routeRef must be an object when present`);
    }
    if (step.routeRef !== undefined) {
      const routeRecord = step.routeRef as Record<string, unknown>;
      if (
        typeof routeRecord.provider !== "string" ||
        routeRecord.provider.length === 0 ||
        typeof routeRecord.model !== "string" ||
        routeRecord.model.length === 0
      ) {
        reject("ir-shape", `IR step ${step.id} routeRef must carry non-empty provider/model`);
      }
    }
    steps.push({
      id: step.id,
      stepClass,
      computationType: step.computationType as ComputationType,
      sideEffectClass: step.sideEffectClass as SideEffectClass,
      ...(step.capabilityId === undefined ? {} : { capabilityId: step.capabilityId as string }),
      ...(step.routeRef === undefined ? {} : { routeRef: step.routeRef as unknown as IrRouteRef }),
      ...(step.config === undefined ? {} : { config: step.config }),
      ...(step.verificationStrategy === undefined
        ? {}
        : { verificationStrategy: step.verificationStrategy as string }),
    });
  }
  const stepIds = new Set(steps.map((step) => step.id));
  if (stepIds.size !== steps.length) {
    reject("step-identity", "IR step ids must be unique");
  }
  if (!Array.isArray(value.edges)) {
    reject("ir-shape", "execution IR edges must be an array");
  }
  const edges: IrEdge[] = [];
  for (const edge of value.edges) {
    if (!isRecord(edge)) {
      reject("ir-shape", "each IR edge must be an object");
    }
    if (typeof edge.from !== "string" || typeof edge.to !== "string") {
      reject("ir-shape", "each IR edge must carry string from/to");
    }
    if (!stepIds.has(edge.from) || !stepIds.has(edge.to)) {
      reject("edge-structure", "IR edges must reference existing steps", {
        from: bounded(edge.from),
        to: bounded(edge.to),
      });
    }
    if (edge.from === edge.to) {
      reject("edge-structure", "IR edges must not be self-loops", { step: bounded(edge.from) });
    }
    edges.push({ from: edge.from, to: edge.to });
  }
  assertAcyclic([...stepIds], edges);

  const modelCalls = steps.filter((step) => isGenerativeStepClass(step.stepClass)).length;
  const hasRouteRef = steps.some((step) => step.routeRef !== undefined);
  if (modelCalls === 0 && hasRouteRef) {
    reject("strategy-consistency", "a zero-model IR must not carry route references");
  }
  if (value.strategyClass === "deterministic-only" && modelCalls > 0) {
    reject("strategy-consistency", "a deterministic-only IR must not contain generative steps");
  }
  if (modelCalls > 0 && !hasRouteRef) {
    reject("strategy-consistency", "generative IR steps must carry route references");
  }
  if (value.modelCalls !== modelCalls || value.hasRouteRef !== hasRouteRef) {
    reject("ir-shape", "IR derived modelCalls/hasRouteRef do not match its steps", {
      claimedModelCalls: typeof value.modelCalls === "number" ? value.modelCalls : -1,
      computedModelCalls: modelCalls,
    });
  }
  if (!isRecord(value.provenance)) {
    reject("provenance-missing", "execution IR must carry provenance");
  }
  if (
    typeof value.provenance.source !== "string" ||
    !(IR_PROVENANCE_SOURCES as readonly string[]).includes(value.provenance.source)
  ) {
    reject("provenance-vocabulary", "IR provenance source is outside the closed vocabulary", {
      got: bounded(value.provenance.source),
    });
  }
  if (
    typeof value.provenance.derivationBasis !== "string" ||
    !(IR_DERIVATION_BASES as readonly string[]).includes(value.provenance.derivationBasis)
  ) {
    reject(
      "provenance-vocabulary",
      "IR provenance derivationBasis is outside the closed vocabulary",
      { got: bounded(value.provenance.derivationBasis) },
    );
  }

  const ir: ExecutionIr = deepFreeze({
    irId: value.irId,
    irSchema: 1,
    planId: value.planId,
    planRevision: value.planRevision as number,
    strategyClass: value.strategyClass as StrategyClass,
    steps,
    edges,
    modelCalls,
    hasRouteRef,
    provenance: {
      source: value.provenance.source as IrProvenanceSource,
      derivationBasis: value.provenance.derivationBasis as IrDerivationBasis,
    },
  });

  // Identity verification 1: the IR content must digest to the claimed irId.
  const irDigest = digest.sha256Hex(
    canonicalIrForm({
      irSchema: ir.irSchema,
      planId: ir.planId,
      planRevision: ir.planRevision,
      strategyClass: ir.strategyClass,
      steps: ir.steps,
      edges: ir.edges,
      modelCalls: ir.modelCalls,
      hasRouteRef: ir.hasRouteRef,
      provenance: ir.provenance,
    }),
  );
  if (irDigest !== ir.irId) {
    reject("ir-identity-mismatch", "IR content does not digest to the claimed irId", {
      claimed: ir.irId,
      computed: irDigest,
    });
  }

  // Identity verification 2 (losslessness): the reconstructed plan
  // semantics must digest to the governed planId.
  const planDigest = digest.sha256Hex(planFormOfIr(ir));
  if (planDigest !== ir.planId) {
    reject("plan-identity-mismatch", "IR plan semantics do not digest to the governed planId", {
      claimed: ir.planId,
      computed: planDigest,
    });
  }
  return ir;
}
