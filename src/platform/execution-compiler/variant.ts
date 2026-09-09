/**
 * The optimized Execution IR VARIANT (platform execution-compiler plane;
 * WORK-050 / E1.1 charter stage 2).
 *
 * A compiled variant is the output representation of the deterministic
 * execution compiler: the transformed form of a governed, validated
 * Execution IR (WORK-049) under semantics-preserving transformations.
 *
 * Identity discipline (honest by construction):
 *
 *  - `variantIrId` — sha256 over the canonical VARIANT form (the
 *    transformed IR content, including the compiler provenance);
 *  - `variantPlanId` — sha256 over the variant's OWN canonical plan
 *    form (the transformed plan semantics). This is a SELF-CONSISTENCY
 *    identity: the variant is never a governed plan — it is a compiled
 *    representation, so it must not claim the governed plan's identity
 *    for content the governed plan does not have;
 *  - `sourceIrId` / `sourcePlanId` — the EXACT preserved chain to the
 *    governed inputs: the input IR's `irId` and the governed plan's
 *    `planId`, carried verbatim through every transformation (the
 *    EXECUTION-PROVENANCE anchor: plan → IR → variant is replayable
 *    and re-derivable by deterministic re-compilation).
 *
 * The IDENTITY variant (the untransformed starting state) has a plan
 * form byte-identical to the input IR's — so its `variantPlanId` IS the
 * governed `planId`: the variant container is a faithful carrier of
 * the governed plan semantics, and every later transformation evolves
 * that form under the equivalence proof.
 *
 * Validation (`validateExecutionIrVariant`) is total and deterministic
 * and enforces EXACTLY the WORK-049 IR invariant rules — rejections are
 * typed `IrValidationError`s naming codes from the closed
 * `IR_INVARIANT_CODES` 12-code vocabulary (step vocabulary, derived
 * facts, step identity, edge structure, route binding, strategy
 * consistency, canonical universe, provenance, both content
 * identities). The two differences from `validateExecutionIr` are
 * honest and recorded: the provenance source is the compiler (a closed
 * one-entry vocabulary here), and the plan-form identity verified is
 * the variant's own (self-consistency), with the governed chain
 * preserved through `sourceIrId`/`sourcePlanId` instead.
 *
 * Step/edge ORDER is part of the variant content (exactly as in the
 * IR): the digest discipline covers arrays in order, and passes never
 * re-order — they remove, replace in place, or insert deterministically.
 */

import { canonicalJson, isCanonicalizable } from "../execution-ir/canonical";
import type {
  ComputationType,
  ExecutionIr,
  IrDigestPort,
  SideEffectClass,
  StrategyClass,
} from "../execution-ir/ir";
import {
  computationTypeOfStep,
  type IrInvariantCode,
  IrValidationError,
  isGenerativeStepClass,
  PLAN_STEP_CLASSES,
  type PlanStepClass,
  STRATEGY_CLASSES,
  sideEffectClassOfStep,
} from "../execution-ir/ir";

// ---------------------------------------------------------------------------
// Provenance vocabularies (closed)
// ---------------------------------------------------------------------------

/** The only legitimate producer of a compiled variant. */
export const VARIANT_PROVENANCE_SOURCES = ["execution-compiler"] as const;
export type VariantProvenanceSource = (typeof VARIANT_PROVENANCE_SOURCES)[number];

/** The only derivation basis of a compiled variant. */
export const VARIANT_DERIVATION_BASES = ["semantics-preserving-composition"] as const;
export type VariantDerivationBasis = (typeof VARIANT_DERIVATION_BASES)[number];

export interface IrVariantProvenance {
  readonly source: VariantProvenanceSource;
  readonly derivationBasis: VariantDerivationBasis;
  /** sha256 over the pass-application trace that produced this variant. */
  readonly passTraceDigest: string;
}

// ---------------------------------------------------------------------------
// The variant
// ---------------------------------------------------------------------------

export interface IrVariantStep {
  readonly id: string;
  readonly stepClass: PlanStepClass;
  readonly computationType: ComputationType;
  readonly sideEffectClass: SideEffectClass;
  readonly capabilityId?: string;
  readonly routeRef?: { readonly provider: string; readonly model: string };
  readonly config?: Readonly<Record<string, unknown>>;
  readonly verificationStrategy?: string;
}

export interface IrVariantEdge {
  readonly from: string;
  readonly to: string;
}

/**
 * The optimized IR variant — a compiled representation of the governed
 * plan, never a second plan authority: the governed plan stays the
 * planner's; the executions ledger stays the durable plan-decision
 * authority; budgets/policy/capability/verification stay the
 * constraint authorities. The variant is executable-shape evidence
 * whose legitimacy is the recorded decision record (WORK-049 format).
 */
export interface ExecutionIrVariant {
  /** sha256 over the canonical variant form. */
  readonly variantIrId: string;
  readonly variantSchema: 1;
  /** The input IR's content identity — preserved verbatim. */
  readonly sourceIrId: string;
  /** The governed plan's content identity — preserved verbatim. */
  readonly sourcePlanId: string;
  readonly planRevision: number;
  readonly strategyClass: StrategyClass;
  /** sha256 over the variant's own canonical plan form (self-consistency). */
  readonly variantPlanId: string;
  readonly steps: readonly IrVariantStep[];
  readonly edges: readonly IrVariantEdge[];
  readonly modelCalls: number;
  readonly hasRouteRef: boolean;
  readonly provenance: IrVariantProvenance;
}

const STEP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DETAIL_LIMIT = 200;

function bounded(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

function reject(
  invariant: IrInvariantCode,
  message: string,
  details?: Record<string, string | number | boolean | null>,
): never {
  throw new IrValidationError(invariant, message, details);
}

// ---------------------------------------------------------------------------
// Canonical forms
// ---------------------------------------------------------------------------

/** The plan-semantic projection of a variant step (order-preserving). */
function planStepOf(step: IrVariantStep): Record<string, unknown> {
  return {
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
  };
}

/**
 * The variant's canonical PLAN form — the transformed plan semantics:
 * the plan-semantic fields of every step plus the graph, serialized
 * over the closed canonical JSON universe (sorted keys, in-order
 * arrays — byte-compatible with the WORK-049 plan form discipline).
 * The `variantPlanId` digest covers exactly these bytes
 * (self-consistency: a variant whose content drifted from its claimed
 * plan form is unrepresentable).
 */
export function canonicalVariantPlanForm(variant: ExecutionIrVariant): string {
  return canonicalJson({
    planSchema: 1,
    revision: variant.planRevision,
    strategyClass: variant.strategyClass,
    steps: variant.steps.map(planStepOf),
    edges: variant.edges,
  });
}

/** The canonical variant form — the bytes the `variantIrId` covers. */
export function canonicalVariantForm(variant: Omit<ExecutionIrVariant, "variantIrId">): string {
  return canonicalJson({
    variantSchema: variant.variantSchema,
    sourceIrId: variant.sourceIrId,
    sourcePlanId: variant.sourcePlanId,
    planRevision: variant.planRevision,
    strategyClass: variant.strategyClass,
    variantPlanId: variant.variantPlanId,
    steps: variant.steps,
    edges: variant.edges,
    modelCalls: variant.modelCalls,
    hasRouteRef: variant.hasRouteRef,
    provenance: variant.provenance,
  });
}

// ---------------------------------------------------------------------------
// Variant construction (deterministic, content-addressed)
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

/** Raw step material a variant can be (re)built from, in order. */
export interface VariantStepMaterial {
  readonly id: string;
  readonly stepClass: PlanStepClass;
  readonly capabilityId?: string;
  readonly routeRef?: { readonly provider: string; readonly model: string };
  readonly config?: Readonly<Record<string, unknown>>;
  readonly verificationStrategy?: string;
}

/**
 * Rebuild a variant from raw step/edge material: recomputes the frozen
 * derived step facts, recomputes the derived counts, and re-addresses
 * both content identities (`variantPlanId` then `variantIrId`).
 * Deterministic: the same material (in the same order) always yields
 * the same ids. Step/edge order is PRESERVED — it is part of the
 * content exactly as in the WORK-049 IR.
 */
export function buildVariant(
  material: {
    readonly source: Pick<
      ExecutionIrVariant,
      "sourceIrId" | "sourcePlanId" | "planRevision" | "strategyClass"
    >;
    readonly steps: readonly VariantStepMaterial[];
    readonly edges: readonly { from: string; to: string }[];
    readonly provenance: IrVariantProvenance;
  },
  digest: IrDigestPort,
): ExecutionIrVariant {
  const steps: IrVariantStep[] = material.steps.map((step) => ({
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
  const edges: IrVariantEdge[] = material.edges.map((edge) => ({ from: edge.from, to: edge.to }));
  const modelCalls = steps.filter((step) => isGenerativeStepClass(step.stepClass)).length;
  const hasRouteRef = steps.some((step) => step.routeRef !== undefined);
  const form: Omit<ExecutionIrVariant, "variantIrId"> = {
    variantSchema: 1,
    sourceIrId: material.source.sourceIrId,
    sourcePlanId: material.source.sourcePlanId,
    planRevision: material.source.planRevision,
    strategyClass: material.source.strategyClass,
    variantPlanId: digest.sha256Hex(
      canonicalJson({
        planSchema: 1,
        revision: material.source.planRevision,
        strategyClass: material.source.strategyClass,
        steps: steps.map(planStepOf),
        edges,
      }),
    ),
    steps,
    edges,
    modelCalls,
    hasRouteRef,
    provenance: material.provenance,
  };
  const variantIrId = digest.sha256Hex(canonicalVariantForm(form));
  return deepFreeze({ ...form, variantIrId });
}

/** The empty pass-trace digest (the identity variant's provenance). */
export function emptyTraceDigest(digest: IrDigestPort): string {
  return digest.sha256Hex(canonicalJson({ trace: [] }));
}

/**
 * The IDENTITY variant of a validated Execution IR: the untransformed
 * starting state of every compilation. Its `variantPlanId` digests to
 * the GOVERNED `planId` (the variant carries exactly the governed plan
 * semantics, byte-identically), and its steps/edges are the IR's own —
 * proof that the variant representation is a faithful container for
 * the input.
 */
export function variantFromIr(ir: ExecutionIr, digest: IrDigestPort): ExecutionIrVariant {
  return buildVariant(
    {
      source: {
        sourceIrId: ir.irId,
        sourcePlanId: ir.planId,
        planRevision: ir.planRevision,
        strategyClass: ir.strategyClass,
      },
      steps: ir.steps.map((step) => ({
        id: step.id,
        stepClass: step.stepClass,
        ...(step.capabilityId === undefined ? {} : { capabilityId: step.capabilityId }),
        ...(step.routeRef === undefined ? {} : { routeRef: step.routeRef }),
        ...(step.config === undefined ? {} : { config: step.config }),
        ...(step.verificationStrategy === undefined
          ? {}
          : { verificationStrategy: step.verificationStrategy }),
      })),
      edges: ir.edges.map((edge) => ({ from: edge.from, to: edge.to })),
      provenance: {
        source: "execution-compiler",
        derivationBasis: "semantics-preserving-composition",
        passTraceDigest: emptyTraceDigest(digest),
      },
    },
    digest,
  );
}

// ---------------------------------------------------------------------------
// Total validation (WORK-049 invariant rules, closed 12-code vocabulary)
// ---------------------------------------------------------------------------

/** Does the step graph form a DAG (Kahn topological check)? */
function assertAcyclic(steps: readonly IrVariantStep[], edges: readonly IrVariantEdge[]): void {
  const indegree = new Map<string, number>(steps.map((step) => [step.id, 0]));
  const outgoing = new Map<string, string[]>(steps.map((step) => [step.id, []]));
  for (const edge of edges) {
    outgoing.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const queue = steps.filter((step) => (indegree.get(step.id) ?? 0) === 0).map((step) => step.id);
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
    reject("edge-structure", "variant step graph must be acyclic (a cycle was detected)");
  }
}

/**
 * Total, deterministic validation of a compiled variant value: every
 * WORK-049 IR invariant rule (closed `IR_INVARIANT_CODES` vocabulary)
 * plus the variant's own two content identities — `variantIrId` over
 * the canonical variant form and `variantPlanId` over the variant's
 * canonical plan form. A variant that drifted from either claimed
 * identity is unrepresentable (`ir-identity-mismatch` /
 * `plan-identity-mismatch`).
 */
export function validateExecutionIrVariant(
  value: unknown,
  digest: IrDigestPort,
): ExecutionIrVariant {
  if (!isRecord(value)) {
    reject("ir-shape", "execution IR variant must be an object");
  }
  if (typeof value.variantIrId !== "string" || !SHA256_HEX.test(value.variantIrId)) {
    reject("ir-shape", "variant variantIrId must be a sha256 hex digest", {
      got: bounded(value.variantIrId),
    });
  }
  if (value.variantSchema !== 1) {
    reject("ir-shape", "variant schema version must be 1", { got: bounded(value.variantSchema) });
  }
  if (typeof value.sourceIrId !== "string" || !SHA256_HEX.test(value.sourceIrId)) {
    reject("ir-shape", "variant sourceIrId must be a sha256 hex digest", {
      got: bounded(value.sourceIrId),
    });
  }
  if (typeof value.sourcePlanId !== "string" || !SHA256_HEX.test(value.sourcePlanId)) {
    reject("ir-shape", "variant sourcePlanId must be a sha256 hex digest", {
      got: bounded(value.sourcePlanId),
    });
  }
  if (!Number.isInteger(value.planRevision) || (value.planRevision as number) < 1) {
    reject("ir-shape", "variant planRevision must be a positive integer");
  }
  if (
    typeof value.strategyClass !== "string" ||
    !(STRATEGY_CLASSES as readonly string[]).includes(value.strategyClass)
  ) {
    reject("ir-shape", "variant strategyClass is outside the frozen vocabulary", {
      got: bounded(value.strategyClass),
    });
  }
  if (typeof value.variantPlanId !== "string" || !SHA256_HEX.test(value.variantPlanId)) {
    reject("ir-shape", "variant variantPlanId must be a sha256 hex digest", {
      got: bounded(value.variantPlanId),
    });
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    reject("ir-shape", "an IR variant requires at least one step");
  }
  const steps: IrVariantStep[] = [];
  for (const step of value.steps) {
    if (!isRecord(step)) {
      reject("ir-shape", "each variant step must be an object");
    }
    if (typeof step.id !== "string" || !STEP_ID.test(step.id)) {
      reject("ir-shape", "variant step id must be a lowercase slug", { got: bounded(step.id) });
    }
    if (
      typeof step.stepClass !== "string" ||
      !(PLAN_STEP_CLASSES as readonly string[]).includes(step.stepClass)
    ) {
      reject("step-vocabulary", `variant step ${step.id} carries an unknown step class`, {
        got: bounded(step.stepClass),
      });
    }
    const stepClass = step.stepClass as PlanStepClass;
    if (
      step.computationType !== computationTypeOfStep(stepClass) ||
      step.sideEffectClass !== sideEffectClassOfStep(stepClass)
    ) {
      reject(
        "ir-shape",
        `variant step ${step.id} derived optimization facts do not match its class`,
        {
          stepClass,
          computationType: bounded(step.computationType),
          sideEffectClass: bounded(step.sideEffectClass),
        },
      );
    }
    if (step.routeRef !== undefined) {
      if (!isRecord(step.routeRef)) {
        reject("ir-shape", `variant step ${step.id} routeRef must be an object when present`);
      }
      const route = step.routeRef as Record<string, unknown>;
      if (
        typeof route.provider !== "string" ||
        route.provider.length === 0 ||
        typeof route.model !== "string" ||
        route.model.length === 0
      ) {
        reject("ir-shape", `variant step ${step.id} routeRef must carry non-empty provider/model`);
      }
      if (!isGenerativeStepClass(stepClass)) {
        reject(
          "route-binding",
          `variant step ${step.id} of class ${stepClass} must not carry a route`,
        );
      }
    }
    if (step.config !== undefined) {
      if (!isRecord(step.config)) {
        reject("ir-shape", `variant step ${step.id} config must be an object when present`);
      }
      if (!isCanonicalizable(step.config)) {
        reject(
          "canonical-universe",
          `variant step ${step.id} config must be inside the closed JSON universe`,
        );
      }
    }
    if (step.capabilityId !== undefined) {
      if (typeof step.capabilityId !== "string" || step.capabilityId.length === 0) {
        reject("ir-shape", `variant step ${step.id} capabilityId must be non-empty when present`);
      }
    }
    if (step.verificationStrategy !== undefined) {
      if (typeof step.verificationStrategy !== "string" || step.verificationStrategy.length === 0) {
        reject(
          "ir-shape",
          `variant step ${step.id} verificationStrategy must be non-empty when present`,
        );
      }
    }
    steps.push({
      id: step.id,
      stepClass,
      computationType: step.computationType as ComputationType,
      sideEffectClass: step.sideEffectClass as SideEffectClass,
      ...(step.capabilityId === undefined ? {} : { capabilityId: step.capabilityId as string }),
      ...(step.routeRef === undefined
        ? {}
        : { routeRef: step.routeRef as unknown as { provider: string; model: string } }),
      ...(step.config === undefined ? {} : { config: step.config }),
      ...(step.verificationStrategy === undefined
        ? {}
        : { verificationStrategy: step.verificationStrategy as string }),
    });
  }
  const stepIds = new Set(steps.map((step) => step.id));
  if (stepIds.size !== steps.length) {
    reject("step-identity", "variant step ids must be unique");
  }
  if (!Array.isArray(value.edges)) {
    reject("ir-shape", "variant edges must be an array");
  }
  const edges: IrVariantEdge[] = [];
  for (const edge of value.edges) {
    if (!isRecord(edge)) {
      reject("ir-shape", "each variant edge must be an object");
    }
    if (typeof edge.from !== "string" || typeof edge.to !== "string") {
      reject("ir-shape", "each variant edge must carry string from/to");
    }
    if (!stepIds.has(edge.from) || !stepIds.has(edge.to)) {
      reject("edge-structure", "variant edges must reference existing steps", {
        from: bounded(edge.from),
        to: bounded(edge.to),
      });
    }
    if (edge.from === edge.to) {
      reject("edge-structure", "variant edges must not be self-loops", {
        step: bounded(edge.from),
      });
    }
    edges.push({ from: edge.from, to: edge.to });
  }
  assertAcyclic(steps, edges);

  const modelCalls = steps.filter((step) => isGenerativeStepClass(step.stepClass)).length;
  const hasRouteRef = steps.some((step) => step.routeRef !== undefined);
  if (modelCalls === 0 && hasRouteRef) {
    reject("strategy-consistency", "a zero-model variant must not carry route references");
  }
  if (value.strategyClass === "deterministic-only" && modelCalls > 0) {
    reject(
      "strategy-consistency",
      "a deterministic-only variant must not contain generative steps",
    );
  }
  if (modelCalls > 0 && !hasRouteRef) {
    reject("strategy-consistency", "generative variant steps must carry route references");
  }
  if (value.modelCalls !== modelCalls || value.hasRouteRef !== hasRouteRef) {
    reject("ir-shape", "variant derived modelCalls/hasRouteRef do not match its steps", {
      claimedModelCalls: typeof value.modelCalls === "number" ? value.modelCalls : -1,
      computedModelCalls: modelCalls,
    });
  }
  if (!isRecord(value.provenance)) {
    reject("provenance-missing", "an IR variant must carry provenance");
  }
  if (
    typeof value.provenance.source !== "string" ||
    !(VARIANT_PROVENANCE_SOURCES as readonly string[]).includes(value.provenance.source)
  ) {
    reject("provenance-vocabulary", "variant provenance source is outside the closed vocabulary", {
      got: bounded(value.provenance.source),
    });
  }
  if (
    typeof value.provenance.derivationBasis !== "string" ||
    !(VARIANT_DERIVATION_BASES as readonly string[]).includes(value.provenance.derivationBasis)
  ) {
    reject(
      "provenance-vocabulary",
      "variant provenance derivationBasis is outside the closed vocabulary",
      {
        got: bounded(value.provenance.derivationBasis),
      },
    );
  }
  if (
    typeof value.provenance.passTraceDigest !== "string" ||
    !SHA256_HEX.test(value.provenance.passTraceDigest)
  ) {
    reject(
      "provenance-vocabulary",
      "variant provenance passTraceDigest must be a sha256 hex digest",
      {
        got: bounded(value.provenance.passTraceDigest),
      },
    );
  }

  const variant: ExecutionIrVariant = deepFreeze({
    variantIrId: value.variantIrId,
    variantSchema: 1,
    sourceIrId: value.sourceIrId,
    sourcePlanId: value.sourcePlanId,
    planRevision: value.planRevision as number,
    strategyClass: value.strategyClass as StrategyClass,
    variantPlanId: value.variantPlanId,
    steps,
    edges,
    modelCalls,
    hasRouteRef,
    provenance: {
      source: value.provenance.source as VariantProvenanceSource,
      derivationBasis: value.provenance.derivationBasis as VariantDerivationBasis,
      passTraceDigest: value.provenance.passTraceDigest,
    },
  });

  // Identity verification 1: the variant content must digest to the
  // claimed variantIrId (over the canonical variant form).
  const variantDigest = digest.sha256Hex(
    canonicalVariantForm({
      variantSchema: variant.variantSchema,
      sourceIrId: variant.sourceIrId,
      sourcePlanId: variant.sourcePlanId,
      planRevision: variant.planRevision,
      strategyClass: variant.strategyClass,
      variantPlanId: variant.variantPlanId,
      steps: variant.steps,
      edges: variant.edges,
      modelCalls: variant.modelCalls,
      hasRouteRef: variant.hasRouteRef,
      provenance: variant.provenance,
    }),
  );
  if (variantDigest !== variant.variantIrId) {
    reject("ir-identity-mismatch", "variant content does not digest to the claimed variantIrId", {
      claimed: variant.variantIrId,
      computed: variantDigest,
    });
  }
  // Identity verification 2 (self-consistency): the variant's plan
  // semantics must digest to the claimed variantPlanId.
  const planDigest = digest.sha256Hex(canonicalVariantPlanForm(variant));
  if (planDigest !== variant.variantPlanId) {
    reject(
      "plan-identity-mismatch",
      "variant plan semantics do not digest to the claimed variantPlanId",
      {
        claimed: variant.variantPlanId,
        computed: planDigest,
      },
    );
  }
  return variant;
}
