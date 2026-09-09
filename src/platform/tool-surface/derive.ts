/**
 * The tool-surface derivation engine (platform tool-surface plane;
 * WORK-051 / E1.1 charter stage 3 — ADR-0019 §5, ADR-0020).
 *
 * `deriveToolSurface` is a PURE function of (plan IR, governing
 * constraints, configuration, digest): it compiles the plan's declared
 * tool needs into the MINIMAL tool surface that crosses the model
 * boundary, plus the programmatic-execution decisions for the plan's
 * mechanical steps:
 *
 *  - the surface is DERIVED, never negotiated: capability conditioning
 *    (READ-ONLY consultation of the governing capability facts — the
 *    WORK-049 constraint mirror of what the capability authority
 *    captured at planning time) and policy conditioning (READ-ONLY
 *    tool allow/deny consultation mirroring the planner's own
 *    composition semantics) gate EVERY need fail-closed BEFORE any
 *    representation is considered. The derivation can never widen,
 *    grant or bypass a capability or a policy restriction — it only
 *    reads facts (POLICY-BEFORE-DISPATCH);
 *  - every need gets EXACTLY ONE representation: the FIRST
 *    ADMISSIBLE representation in the frozen canonical selection
 *    order (catalog.ts), with the per-representation typed rejections
 *    recorded as bounded evidence. A need with NO admissible
 *    representation fails the whole derivation closed (never a
 *    silently dropped tool);
 *  - MINIMALITY is proven, not claimed: the surface carries exactly
 *    one binding per declared need and nothing else
 *    (`assertSurfaceMinimal` proves set equality against the plan's
 *    extracted needs; the audit re-proves it);
 *  - DETERMINISM: the surface is content-addressed (`surfaceId` =
 *    sha256 over the canonical surface form); the same (IR,
 *    constraints, configuration) always produce the identical
 *    surfaceId, byte-identical including every recorded rejection
 *    (deterministic tie-breaking everywhere);
 *  - PROVENANCE: the surface preserves the governed chain verbatim
 *    (planId, irId, and the compiled variant's identity when the
 *    derivation consumed one) — `auditToolSurface` replays the whole
 *    derivation deterministically and reports typed violations;
 *  - the derivation BUILDS ON the WORK-049/050 foundation
 *    (import-only: the IR, the constraint set, the compiled variant)
 *    and creates NO authority, NO state machine, NO durable surface.
 */

import { type ExecutionIrVariant, validateExecutionIrVariant } from "../execution-compiler/variant";
import { canonicalJson, isCanonicalizable } from "../execution-ir/canonical";
import { type OptimizationConstraint, validateConstraintSet } from "../execution-ir/constraints";
import type { ExecutionIr, IrDigestPort } from "../execution-ir/ir";
import { validateExecutionIr } from "../execution-ir/ir";
import {
  capabilityFactsFromConstraints,
  policyToolFactsFromConstraints,
  rejectSurface,
  SELECTION_ORDER,
  SELECTION_ORDER_BASIS,
  TOOL_SURFACE_INVARIANT_CODES,
  type ToolRepresentation,
  type ToolSurfaceConfig,
  ToolSurfaceError,
  toolAllowedByPolicyFacts,
  validateToolSurfaceConfig,
} from "./catalog";
import type { ProgrammaticDecision } from "./needs";
import { deriveProgrammaticDecisions, extractToolNeeds, type ToolNeed } from "./needs";
import { validateProgrammaticSpec } from "./programmatic";

// ---------------------------------------------------------------------------
// The derived tool surface
// ---------------------------------------------------------------------------

/**
 * The closed provenance vocabulary of the tool-surface plane: the only
 * legitimate sources a surface may claim.
 */
export const SURFACE_PROVENANCE_SOURCES = ["execution-ir.governed-plan"] as const;
export type SurfaceProvenanceSource = (typeof SURFACE_PROVENANCE_SOURCES)[number];

export const SURFACE_DERIVATION_BASES = ["plan-tool-needs-minimal-view"] as const;
export type SurfaceDerivationBasis = (typeof SURFACE_DERIVATION_BASES)[number];

export const SURFACE_DERIVED_FROM = ["execution-ir", "execution-compiler-variant"] as const;
export type SurfaceDerivedFrom = (typeof SURFACE_DERIVED_FROM)[number];

export interface SurfaceProvenance {
  readonly source: SurfaceProvenanceSource;
  readonly derivationBasis: SurfaceDerivationBasis;
  readonly derivedFrom: SurfaceDerivedFrom;
}

/** One skipped representation, with exactly one closed rejection code. */
export interface RepresentationRejection {
  readonly representation: ToolRepresentation;
  readonly code: "binding-absent" | "mcp-adapter-disabled" | "lower-canonical-rank";
}

/** The selected representation binding for ONE declared tool need. */
export interface SurfaceNeedBinding {
  /** The stable need identity — the plan step's own id. */
  readonly needId: string;
  readonly stepId: string;
  /** The capability-bound tool identity the need declared. */
  readonly toolId: string;
  readonly representation: ToolRepresentation;
  /**
   * The materialization reference the selected representation binds
   * to (cli.command / script.scriptRef / code.api / mcp.server /
   * competence.competenceRef); null for direct/deferred.
   */
  readonly bindingRef: string | null;
  /** The bounded, deterministic selection-basis evidence. */
  readonly selectionBasis: string;
  /** The recorded per-representation rejections (bounded evidence). */
  readonly rejected: readonly RepresentationRejection[];
}

/**
 * The derived tool surface: the minimal set of representation bindings
 * for the plan's declared tool needs, plus the programmatic-execution
 * decisions for the plan's mechanical steps. A pure, content-addressed
 * VALUE — never an authority, never a state machine.
 */
export interface ToolSurface {
  /** Content-addressed identity: sha256 over the canonical surface form. */
  readonly surfaceId: string;
  readonly surfaceSchema: 1;
  /** The governed plan's content identity — preserved verbatim. */
  readonly planId: string;
  readonly planRevision: number;
  /** The source IR's content identity — preserved verbatim. */
  readonly irId: string;
  /** The compiled variant's identity when derived over one, else null. */
  readonly sourceVariantIrId: string | null;
  readonly toolBindings: readonly SurfaceNeedBinding[];
  readonly programmatic: readonly ProgrammaticDecision[];
  readonly provenance: SurfaceProvenance;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const STEP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

export interface DeriveToolSurfaceInput {
  /** The governed, validated Execution IR (re-validated here). */
  readonly ir: ExecutionIr;
  /**
   * The WORK-050 compiled variant to derive over (optional). When
   * present, needs and mechanical steps are extracted from the
   * VARIANT's steps (the compiled form) and the variant's identity is
   * preserved in the surface provenance chain. The variant's source
   * chain MUST match the input IR (fail closed otherwise).
   */
  readonly variant?: ExecutionIrVariant;
  /** The governing constraint set (validated; READ-ONLY consultation). */
  readonly constraints: readonly OptimizationConstraint[];
  /** The tool-surface configuration (validated). */
  readonly config: ToolSurfaceConfig;
  /** The injected digest port (sha256, lowercase hex). */
  readonly digest: IrDigestPort;
}

/**
 * Derive the minimal tool surface for a governed plan. PURE and TOTAL:
 * every failure is a typed `ToolSurfaceError` naming a closed-vocabulary
 * invariant; nothing is emitted on failure.
 */
export function deriveToolSurface(input: DeriveToolSurfaceInput): ToolSurface {
  // 1. Validate every input (fail closed before anything derives).
  const ir = validateExecutionIr(input.ir, input.digest);
  const constraints = validateConstraintSet(input.constraints);
  const config = validateToolSurfaceConfig(input.config);

  let steps = ir.steps;
  let sourceVariantIrId: string | null = null;
  let derivedFrom: SurfaceDerivedFrom = "execution-ir";
  if (input.variant !== undefined) {
    const variant = validateExecutionIrVariant(input.variant, input.digest);
    if (variant.sourceIrId !== ir.irId || variant.sourcePlanId !== ir.planId) {
      rejectSurface(
        "surface-provenance",
        "the compiled variant's source chain does not match the input IR (the plan → IR → variant chain must be preserved exactly)",
        { variantSourceIrId: variant.sourceIrId, irId: ir.irId },
      );
    }
    steps = variant.steps;
    sourceVariantIrId = variant.variantIrId;
    derivedFrom = "execution-compiler-variant";
  }

  // 2. Extract the plan's declared tool needs (fail closed on
  //    unbindable tool identities) and the mechanical decisions.
  const needs = extractToolNeeds(steps);
  const programmatic = deriveProgrammaticDecisions(steps, config.programmaticEnabled);

  // 3. READ-ONLY capability/policy conditioning facts (constraint
  //    mirrors — nothing is mutated, nothing is widened).
  const capabilityFacts = capabilityFactsFromConstraints(constraints);
  const policyFacts = policyToolFactsFromConstraints(constraints);

  // 4. Per-need representation selection (deterministic, minimal).
  const bindingByTool = new Map<string, ToolSurfaceConfig["bindings"][number]>();
  for (const binding of config.bindings) {
    bindingByTool.set(binding.toolId, binding);
  }
  const toolBindings: SurfaceNeedBinding[] = [];
  for (const need of needs) {
    // Capability conditioning: the need's tool capability must be
    // satisfied by the governing facts. Absent facts + existing needs
    // is unprovenanced conditioning — fail closed.
    if (
      !capabilityFacts.present ||
      !capabilityFacts.satisfiedIds.has(need.toolId) ||
      capabilityFacts.unmetIds.has(need.toolId)
    ) {
      rejectSurface(
        "capability-condition",
        "the need's tool capability is not satisfied by the governing capability facts (fail closed — the derivation can never widen a capability)",
        {
          needId: need.needId,
          toolId: need.toolId,
          factsPresent: capabilityFacts.present,
          unmet: capabilityFacts.unmetIds.has(need.toolId),
        },
      );
    }
    // Policy conditioning: the planner's own composition semantics,
    // read-only over the governing policy facts.
    const eligibility = toolAllowedByPolicyFacts(need.toolId, policyFacts);
    if (!eligibility.allowed) {
      rejectSurface("policy-condition", `fail closed: ${eligibility.reason}`, {
        needId: need.needId,
        toolId: need.toolId,
      });
    }
    // Representation selection: the first admissible representation in
    // the frozen canonical order is selected; EVERY non-selected
    // representation records exactly one closed code (precondition
    // failure before the selection, lower canonical rank after it —
    // complete, bounded, deterministic selection evidence).
    const binding = bindingByTool.get(need.toolId);
    const rejected: RepresentationRejection[] = [];
    let selected: { representation: ToolRepresentation; bindingRef: string | null } | null = null;
    const evaluate = (
      representation: ToolRepresentation,
    ): {
      admissible: boolean;
      bindingRef: string | null;
      code: RepresentationRejection["code"] | null;
    } => {
      const reps = binding?.representations;
      if (reps === undefined) {
        return { admissible: false, bindingRef: null, code: "binding-absent" };
      }
      switch (representation) {
        case "direct":
          if (reps.direct === undefined) {
            return { admissible: false, bindingRef: null, code: "binding-absent" };
          }
          return { admissible: true, bindingRef: null, code: null };
        case "deferred":
          if (reps.deferred === undefined) {
            return { admissible: false, bindingRef: null, code: "binding-absent" };
          }
          return { admissible: true, bindingRef: null, code: null };
        case "cli":
          if (reps.cli === undefined) {
            return { admissible: false, bindingRef: null, code: "binding-absent" };
          }
          return { admissible: true, bindingRef: reps.cli.command, code: null };
        case "script":
          if (reps.script === undefined) {
            return { admissible: false, bindingRef: null, code: "binding-absent" };
          }
          return { admissible: true, bindingRef: reps.script.scriptRef, code: null };
        case "code":
          if (reps.code === undefined) {
            return { admissible: false, bindingRef: null, code: "binding-absent" };
          }
          return { admissible: true, bindingRef: reps.code.api, code: null };
        case "mcp":
          if (reps.mcp === undefined) {
            return { admissible: false, bindingRef: null, code: "binding-absent" };
          }
          if (!config.mcpEnabled) {
            // MCP is ONE representation among the closed set, NEVER
            // required: a disabled adapter records the typed rejection
            // and the selection moves on.
            return { admissible: false, bindingRef: null, code: "mcp-adapter-disabled" };
          }
          return { admissible: true, bindingRef: reps.mcp.server, code: null };
        case "competence":
          if (reps.competence === undefined) {
            return { admissible: false, bindingRef: null, code: "binding-absent" };
          }
          return { admissible: true, bindingRef: reps.competence.competenceRef, code: null };
      }
    };
    for (const representation of SELECTION_ORDER) {
      const verdict = evaluate(representation);
      if (!verdict.admissible) {
        rejected.push({ representation, code: verdict.code as RepresentationRejection["code"] });
        continue;
      }
      if (selected === null) {
        selected = { representation, bindingRef: verdict.bindingRef };
        continue;
      }
      // Admissible but ranked after the selected representation: the
      // deterministic preference itself is the recorded evidence.
      rejected.push({ representation, code: "lower-canonical-rank" });
    }
    if (selected === null) {
      rejectSurface(
        "no-admissible-representation",
        "no representation is materializable for the need (all seven rejected with recorded codes — never a silently dropped tool)",
        {
          needId: need.needId,
          toolId: need.toolId,
          rejections: rejected.map((entry) => `${entry.representation}:${entry.code}`).join(","),
        },
      );
    }
    toolBindings.push({
      needId: need.needId,
      stepId: need.stepId,
      toolId: need.toolId,
      representation: selected.representation,
      bindingRef: selected.bindingRef,
      selectionBasis: SELECTION_ORDER_BASIS,
      rejected,
    });
  }

  // 5. Build the content-addressed surface (canonical form → digest).
  const form = {
    surfaceSchema: 1 as const,
    planId: ir.planId,
    planRevision: ir.planRevision,
    irId: ir.irId,
    ...(sourceVariantIrId === null ? {} : { sourceVariantIrId }),
    toolBindings,
    programmatic,
    provenance: {
      source: "execution-ir.governed-plan" as const,
      derivationBasis: "plan-tool-needs-minimal-view" as const,
      derivedFrom,
    },
  };
  if (!isCanonicalizable(form)) {
    rejectSurface("surface-shape", "the derived surface is outside the closed JSON universe");
  }
  const surfaceId = input.digest.sha256Hex(canonicalJson(form));
  const surface: ToolSurface = {
    ...form,
    sourceVariantIrId,
    surfaceId,
  };

  // 6. Self-check: minimality is proven before the surface is emitted.
  assertSurfaceMinimal(surface, needs, steps);
  return surface;
}

// ---------------------------------------------------------------------------
// Minimality (proven, never claimed)
// ---------------------------------------------------------------------------

/**
 * Prove the surface is MINIMAL with respect to the plan's declared
 * needs: every declared tool need carries EXACTLY ONE binding, the
 * surface carries NO binding beyond the declared needs, and every
 * programmatic decision maps to an actual step of the plan's
 * mechanical family. A superset (or subset) surface is rejected
 * (`surface-non-minimal`).
 */
export function assertSurfaceMinimal(
  surface: ToolSurface,
  needs: readonly ToolNeed[],
  steps: readonly { id: string; stepClass: string }[],
): void {
  const needIds = new Set(needs.map((need) => need.needId));
  const bindingIds = new Set(surface.toolBindings.map((binding) => binding.needId));
  for (const needId of needIds) {
    if (!bindingIds.has(needId)) {
      rejectSurface("surface-non-minimal", "a declared tool need carries no binding", {
        needId,
      });
    }
  }
  for (const binding of surface.toolBindings) {
    if (!needIds.has(binding.needId)) {
      rejectSurface(
        "surface-non-minimal",
        "the surface carries a binding beyond the plan's declared tool needs",
        { needId: binding.needId },
      );
    }
    if (binding.needId !== binding.stepId) {
      rejectSurface("surface-non-minimal", "a binding's need identity must be its plan step", {
        needId: binding.needId,
        stepId: binding.stepId,
      });
    }
  }
  if (surface.toolBindings.length !== needs.length) {
    rejectSurface("surface-non-minimal", "the surface's binding count must equal the need count", {
      bindings: surface.toolBindings.length,
      needs: needs.length,
    });
  }
  const stepClasses = new Map(steps.map((step) => [step.id, step.stepClass]));
  for (const decision of surface.programmatic) {
    const stepClass = stepClasses.get(decision.stepId);
    if (stepClass === undefined) {
      rejectSurface("surface-non-minimal", "a programmatic decision references an unknown step", {
        stepId: decision.stepId,
      });
    }
    if (decision.stepClass !== stepClass) {
      rejectSurface("surface-non-minimal", "a programmatic decision's step class drifted", {
        stepId: decision.stepId,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Total validation (deterministic, identity-verifying)
// ---------------------------------------------------------------------------

/**
 * Total, deterministic validation of a tool-surface value (e.g. after
 * a round-trip): closed shapes, closed vocabularies, unique need
 * identities, recorded-rejection coherence (a selected representation
 * must not ALSO appear in the rejected list), programmatic-decision
 * coherence, provenance presence, AND identity verification — the
 * content must digest to the claimed `surfaceId`.
 */
export function validateToolSurface(value: unknown, digest: IrDigestPort): ToolSurface {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    rejectSurface("surface-shape", "a tool surface must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.surfaceId !== "string" || !SHA256_HEX.test(record.surfaceId)) {
    rejectSurface("surface-shape", "the surfaceId must be a sha256 hex digest", {
      got: String(record.surfaceId),
    });
  }
  if (record.surfaceSchema !== 1) {
    rejectSurface("surface-shape", "the tool surface schema must be 1");
  }
  if (typeof record.planId !== "string" || !SHA256_HEX.test(record.planId)) {
    rejectSurface("surface-shape", "the surface planId must be a sha256 hex digest");
  }
  if (typeof record.irId !== "string" || !SHA256_HEX.test(record.irId)) {
    rejectSurface("surface-shape", "the surface irId must be a sha256 hex digest");
  }
  if (
    record.sourceVariantIrId !== null &&
    record.sourceVariantIrId !== undefined &&
    (typeof record.sourceVariantIrId !== "string" || !SHA256_HEX.test(record.sourceVariantIrId))
  ) {
    rejectSurface("surface-shape", "the surface sourceVariantIrId must be sha256 hex or null");
  }
  if (!Number.isInteger(record.planRevision) || (record.planRevision as number) < 1) {
    rejectSurface("surface-shape", "the surface planRevision must be a positive integer");
  }
  if (!Array.isArray(record.toolBindings)) {
    rejectSurface("surface-shape", "the surface toolBindings must be an array");
  }
  const toolBindings: SurfaceNeedBinding[] = [];
  const seenNeedIds = new Set<string>();
  const REPRESENTATIONS = new Set<string>([
    "direct",
    "deferred",
    "cli",
    "script",
    "code",
    "mcp",
    "competence",
  ]);
  const CODES = new Set<string>(["binding-absent", "mcp-adapter-disabled", "lower-canonical-rank"]);
  for (const entry of record.toolBindings) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      rejectSurface("surface-shape", "each surface binding must be an object");
    }
    const binding = entry as Record<string, unknown>;
    if (
      typeof binding.needId !== "string" ||
      !STEP_ID.test(binding.needId) ||
      typeof binding.stepId !== "string" ||
      !STEP_ID.test(binding.stepId) ||
      binding.needId !== binding.stepId
    ) {
      rejectSurface("surface-shape", "a binding's need identity must be its plan step slug");
    }
    if (seenNeedIds.has(binding.needId)) {
      rejectSurface("surface-shape", "binding need ids must be unique", {
        needId: binding.needId,
      });
    }
    seenNeedIds.add(binding.needId);
    if (typeof binding.toolId !== "string" || binding.toolId.length === 0) {
      rejectSurface("surface-shape", "a binding's toolId must be non-empty");
    }
    if (
      typeof binding.representation !== "string" ||
      !REPRESENTATIONS.has(binding.representation)
    ) {
      rejectSurface("surface-shape", "a binding's representation is outside the closed set", {
        got: String(binding.representation),
      });
    }
    if (
      binding.bindingRef !== null &&
      (typeof binding.bindingRef !== "string" || binding.bindingRef.length === 0)
    ) {
      rejectSurface(
        "surface-shape",
        "a binding's materialization reference must be non-empty or null",
      );
    }
    if (typeof binding.selectionBasis !== "string" || binding.selectionBasis.length === 0) {
      rejectSurface("surface-shape", "a binding's selectionBasis must be non-empty");
    }
    if (!Array.isArray(binding.rejected)) {
      rejectSurface("surface-shape", "a binding's rejected list must be an array");
    }
    const rejected: RepresentationRejection[] = [];
    for (const rejection of binding.rejected) {
      if (typeof rejection !== "object" || rejection === null) {
        rejectSurface("surface-shape", "each recorded rejection must be an object");
      }
      const rejectionRecord = rejection as Record<string, unknown>;
      if (
        typeof rejectionRecord.representation !== "string" ||
        !REPRESENTATIONS.has(rejectionRecord.representation) ||
        typeof rejectionRecord.code !== "string" ||
        !CODES.has(rejectionRecord.code)
      ) {
        rejectSurface("surface-shape", "a recorded rejection is outside the closed vocabulary");
      }
      if (rejectionRecord.representation === binding.representation) {
        rejectSurface(
          "surface-shape",
          "the selected representation must not also appear in the rejected list",
          { representation: binding.representation },
        );
      }
      rejected.push({
        representation: rejectionRecord.representation as ToolRepresentation,
        code: rejectionRecord.code as RepresentationRejection["code"],
      });
    }
    toolBindings.push({
      needId: binding.needId,
      stepId: binding.stepId,
      toolId: binding.toolId,
      representation: binding.representation as ToolRepresentation,
      bindingRef: binding.bindingRef === null ? null : (binding.bindingRef as string),
      selectionBasis: binding.selectionBasis as string,
      rejected,
    });
  }
  if (!Array.isArray(record.programmatic)) {
    rejectSurface("surface-shape", "the surface programmatic decisions must be an array");
  }
  const programmatic: ProgrammaticDecision[] = [];
  const REASONS = new Set<string>(["declared", "not-declared", "disabled"]);
  for (const entry of record.programmatic) {
    if (typeof entry !== "object" || entry === null) {
      rejectSurface("surface-shape", "each programmatic decision must be an object");
    }
    const decision = entry as Record<string, unknown>;
    if (typeof decision.stepId !== "string" || !STEP_ID.test(decision.stepId)) {
      rejectSurface("surface-shape", "a programmatic decision's stepId must be a slug");
    }
    if (typeof decision.programmatic !== "boolean") {
      rejectSurface("surface-shape", "a programmatic decision's verdict must be boolean");
    }
    if (typeof decision.reason !== "string" || !REASONS.has(decision.reason)) {
      rejectSurface("surface-shape", "a programmatic decision's reason is outside the closed set");
    }
    const spec = decision.spec === null || decision.spec === undefined ? null : decision.spec;
    if (spec !== null) {
      programmatic.push({
        stepId: decision.stepId,
        stepClass: String(decision.stepClass),
        programmatic: decision.programmatic,
        reason: decision.reason as ProgrammaticDecision["reason"],
        spec: validateProgrammaticSpec(spec),
      });
    } else {
      programmatic.push({
        stepId: decision.stepId,
        stepClass: String(decision.stepClass),
        programmatic: decision.programmatic,
        reason: decision.reason as ProgrammaticDecision["reason"],
        spec: null,
      });
    }
  }
  if (
    typeof record.provenance !== "object" ||
    record.provenance === null ||
    Array.isArray(record.provenance)
  ) {
    rejectSurface("surface-provenance", "the surface requires provenance");
  }
  const provenance = record.provenance as Record<string, unknown>;
  if (
    provenance.source !== "execution-ir.governed-plan" ||
    provenance.derivationBasis !== "plan-tool-needs-minimal-view" ||
    (provenance.derivedFrom !== "execution-ir" &&
      provenance.derivedFrom !== "execution-compiler-variant")
  ) {
    rejectSurface("surface-provenance", "the surface provenance is outside the closed vocabulary");
  }

  const surface: ToolSurface = {
    surfaceId: record.surfaceId,
    surfaceSchema: 1,
    planId: record.planId,
    planRevision: record.planRevision as number,
    irId: record.irId,
    sourceVariantIrId:
      record.sourceVariantIrId === null || record.sourceVariantIrId === undefined
        ? null
        : (record.sourceVariantIrId as string),
    toolBindings,
    programmatic,
    provenance: {
      source: "execution-ir.governed-plan",
      derivationBasis: "plan-tool-needs-minimal-view",
      derivedFrom: provenance.derivedFrom as SurfaceDerivedFrom,
    },
  };

  // Identity verification: the canonical content must digest to the
  // claimed surfaceId (drift or tampering is unrepresentable).
  const form = {
    surfaceSchema: 1,
    planId: surface.planId,
    planRevision: surface.planRevision,
    irId: surface.irId,
    ...(surface.sourceVariantIrId === null ? {} : { sourceVariantIrId: surface.sourceVariantIrId }),
    toolBindings: surface.toolBindings,
    programmatic: surface.programmatic,
    provenance: surface.provenance,
  };
  const computed = digest.sha256Hex(canonicalJson(form));
  if (computed !== surface.surfaceId) {
    rejectSurface(
      "surface-identity-mismatch",
      "the surface content does not digest to the claimed surfaceId",
      {
        claimed: surface.surfaceId,
        computed,
      },
    );
  }
  return surface;
}

// ---------------------------------------------------------------------------
// The deterministic provenance audit (replayable)
// ---------------------------------------------------------------------------

/** The closed audit-violation vocabulary. */
export const SURFACE_AUDIT_CODES = [
  "surface-invalid",
  "derivation-mismatch",
  "surface-non-minimal",
  "provenance-mismatch",
] as const;
export type SurfaceAuditCode = (typeof SURFACE_AUDIT_CODES)[number];

export interface SurfaceAuditViolation {
  readonly code: SurfaceAuditCode;
  readonly message: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Audit a tool surface against its inputs: re-validate the surface,
 * re-derive it deterministically from the SAME inputs, and prove the
 * identity chain and minimality. Deterministic and replayable: the
 * same (surface, inputs) always produce the same violation list; a
 * clean chain produces ZERO violations.
 */
export function auditToolSurface(
  surface: unknown,
  input: DeriveToolSurfaceInput,
): readonly SurfaceAuditViolation[] {
  const violations: SurfaceAuditViolation[] = [];
  let validated: ToolSurface;
  try {
    validated = validateToolSurface(surface, input.digest);
  } catch (error) {
    return [
      {
        code: "surface-invalid",
        message: error instanceof Error ? error.message : String(error),
        details: error instanceof ToolSurfaceError ? { ...error.details } : { name: String(error) },
      },
    ];
  }
  const rederived = deriveToolSurface(input);
  if (rederived.surfaceId !== validated.surfaceId) {
    violations.push({
      code: "derivation-mismatch",
      message: "a deterministic re-derivation produced a different surface (drift detected)",
      details: { claimed: validated.surfaceId, rederived: rederived.surfaceId },
    });
  }
  if (rederived.planId !== validated.planId || rederived.irId !== validated.irId) {
    violations.push({
      code: "provenance-mismatch",
      message: "the surface's plan/IR identity does not match its source",
      details: { planId: validated.planId, irId: validated.irId },
    });
  }
  if ((rederived.sourceVariantIrId ?? null) !== (validated.sourceVariantIrId ?? null)) {
    violations.push({
      code: "provenance-mismatch",
      message: "the surface's variant identity does not match its source",
      details: {
        claimed: validated.sourceVariantIrId ?? "",
        rederived: rederived.sourceVariantIrId ?? "",
      },
    });
  }
  const steps = input.variant?.steps ?? input.ir.steps;
  try {
    assertSurfaceMinimal(validated, extractToolNeeds(steps), steps);
  } catch (error) {
    violations.push({
      code: "surface-non-minimal",
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof ToolSurfaceError ? { ...error.details } : {},
    });
  }
  return violations;
}

export { TOOL_SURFACE_INVARIANT_CODES };
