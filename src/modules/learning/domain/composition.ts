/**
 * The tool-composition model (learning module domain; WORK-017 /
 * ADR-0005, `spec/architecture.md` §19 "tool sequence").
 *
 * A `ToolComposition` is a STRUCTURALLY SAFE, provider-neutral DAG of
 * concrete tool-version steps with explicit dependency edges:
 *
 * ```text
 *   Tool A (v1.0.0)  →  Tool B (v2.1.0)  →  Tool C (v1.4.0)
 *        (edge compatibility checked at the field level)
 * ```
 *
 * WHAT THIS IS: the learned/recommended representation of a tool
 * SEQUENCE — which tools, in what order, at which versions, under
 * which recorded assumptions. It is OBSERVATIONAL guidance material
 * for planning, never executable code.
 *
 * WHAT THIS IS NOT (the §18 boundary — WORK-018 owns synthesis):
 *  - it contains NO generated code, NO synthesized tool binaries and
 *    NO ephemeral programs — every step references an EXISTING
 *    registered tool at a pinned version (M24);
 *  - it is NOT executed here — execution remains downstream of the
 *    planner, policy, capability, budget and verification gates
 *    (§6: TOOL LEARNING ≠ TOOL AUTHORIZATION);
 *  - it is NOT a plan (no planner vocabulary, no strategy classes) —
 *    the planner owns every planning decision.
 *
 * STRUCTURAL SAFETY (§10/§11/§12, made mechanical):
 *  - every step pins an EXACT (toolId, version) — unresolved tool
 *    references and unresolvable versions are REJECTED (M8/M26);
 *  - step ids are unique within the composition (no alias shadowing —
 *    implicit cycles through duplicated identities are unrepresentable);
 *  - edges reference existing step ids only; SELF-EDGES are rejected;
 *  - the step graph must be ACYCLIC — deterministic 3-color DFS cycle
 *    detection rejects A→A, A→B→A, A→B→C→A and every longer cycle
 *    (M7); the architecture permits bounded iteration only through an
 *    explicit future decision, which this model does not encode;
 *  - every edge's input/output COMPATIBILITY is checked against the
 *    neutral tool facts: each REQUIRED input field of the downstream
 *    step must be name-and-type satisfiable by the upstream step's
 *    declared output fields (M9);
 *  - a composition whose evidence cannot be evaluated (facts missing,
 *    empty steps) never becomes a recommendation.
 *
 * This file contains NO side effects and imports NO other module.
 */

import { PlatformError } from "../../../shared/errors";
import type { ToolFact, ToolFactCatalog, ToolVersionRef } from "./tool-facts";
import { findToolFact, toolExistsInCatalog } from "./tool-facts";

/** Frozen composition record schema version (versioning anchor). */
export const COMPOSITION_SCHEMA_VERSION = 1;

/** One step of a composition: a concrete tool version at a position. */
export interface CompositionStep {
  /** Stable step identifier, unique within the composition. */
  readonly stepId: string;
  /** The EXACT pinned tool version (never a bare tool name — M26). */
  readonly tool: ToolVersionRef;
}

/** A dependency edge: upstream output feeds downstream input. */
export interface CompositionEdge {
  readonly fromStepId: string;
  readonly toStepId: string;
}

/** The structurally validated tool composition (DAG, versioned tools). */
export interface ToolComposition {
  readonly steps: readonly CompositionStep[];
  readonly edges: readonly CompositionEdge[];
}

/** Machine-readable structural check reasons (closed vocabulary). */
export const COMPOSITION_UNSUPPORTED_REASONS = [
  "empty-composition",
  "unknown-tool-reference",
  "unresolved-tool-version",
  "duplicate-step-id",
  "unknown-edge-endpoint",
  "self-edge",
  "cyclic-composition",
  "incompatible-input-output",
] as const;

export type CompositionUnsupportedReason = (typeof COMPOSITION_UNSUPPORTED_REASONS)[number];

export type CompositionCheck =
  | { readonly valid: true; readonly composition: ToolComposition }
  | {
      readonly valid: false;
      readonly reason: CompositionUnsupportedReason;
      readonly detail: string;
    };

const STEP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deterministic 3-color DFS cycle detection over the step graph.
 * WHITE/GRAY/BLACK coloring: a GRAY node reached again IS a back edge
 * — a cycle. Deterministic by construction (step ids iterated in
 * insertion order, adjacency in edge order).
 */
function compositionCycleExists(composition: ToolComposition): string | null {
  const adjacency = new Map<string, string[]>();
  for (const step of composition.steps) {
    adjacency.set(step.stepId, []);
  }
  for (const edge of composition.edges) {
    const list = adjacency.get(edge.fromStepId);
    if (list !== undefined) {
      list.push(edge.toStepId);
    }
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const step of composition.steps) {
    color.set(step.stepId, WHITE);
  }
  const visit = (stepId: string): string | null => {
    color.set(stepId, GRAY);
    for (const next of adjacency.get(stepId) ?? []) {
      const nextColor = color.get(next);
      if (nextColor === GRAY) {
        return next; // back edge — cycle found
      }
      if (nextColor === WHITE) {
        const found = visit(next);
        if (found !== null) {
          return found;
        }
      }
    }
    color.set(stepId, BLACK);
    return null;
  };
  for (const step of composition.steps) {
    if (color.get(step.stepId) === WHITE) {
      const found = visit(step.stepId);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Input/output compatibility of one edge (M9): every REQUIRED input
 * field of the downstream tool must be satisfiable by a declared
 * output field of the upstream tool with the SAME NAME and the SAME
 * TYPE. Optional fields participate when present on both sides.
 */
export function edgeCompatible(
  upstream: ToolFact,
  downstream: ToolFact,
): { readonly ok: boolean; readonly field?: string } {
  const outputNames = new Map(upstream.outputFields.map((field) => [field.name, field.type]));
  for (const input of downstream.inputFields) {
    if (!input.required) {
      continue;
    }
    const outputType = outputNames.get(input.name);
    if (outputType === undefined || outputType !== input.type) {
      return { ok: false, field: input.name };
    }
  }
  return { ok: true };
}

/**
 * THE structural safety check (pure, fail-closed semantics): validates
 * a candidate composition against the neutral tool-fact catalog.
 *
 * Rejected (returned as typed reasons — the caller turns them into
 * UNSUPPORTED recommendations or validation failures, never silently
 * accepted structures):
 *  - empty steps (§12: a composition whose evidence cannot be
 *    evaluated is not a composition);
 *  - unknown tool references (facts missing the toolId);
 *  - unresolved versions (the exact pinned version is not in the
 *    facts — M8/M26);
 *  - duplicate step ids (alias shadowing);
 *  - edges referencing unknown endpoints;
 *  - self-edges;
 *  - cycles (deterministic DFS — M7);
 *  - incompatible input/output edges (M9).
 */
export function checkToolComposition(value: unknown, catalog: ToolFactCatalog): CompositionCheck {
  if (!isRecord(value)) {
    return { valid: false, reason: "empty-composition", detail: "composition must be an object" };
  }
  const rawSteps = value.steps;
  const rawEdges = value.edges;
  if (!Array.isArray(rawSteps) || !Array.isArray(rawEdges)) {
    return {
      valid: false,
      reason: "empty-composition",
      detail: "composition steps and edges must be arrays",
    };
  }
  if (rawSteps.length === 0) {
    return { valid: false, reason: "empty-composition", detail: "no steps" };
  }

  const steps: CompositionStep[] = [];
  const stepIds = new Set<string>();
  for (const raw of rawSteps) {
    if (!isRecord(raw)) {
      return {
        valid: false,
        reason: "empty-composition",
        detail: "each step must be an object",
      };
    }
    const stepId = raw.stepId;
    if (typeof stepId !== "string" || !STEP_ID_PATTERN.test(stepId)) {
      return {
        valid: false,
        reason: "empty-composition",
        detail: `stepId must match ${STEP_ID_PATTERN}`,
      };
    }
    if (stepIds.has(stepId)) {
      return {
        valid: false,
        reason: "duplicate-step-id",
        detail: `step id repeated: ${stepId}`,
      };
    }
    const tool = raw.tool;
    if (!isRecord(tool)) {
      return {
        valid: false,
        reason: "empty-composition",
        detail: `step ${stepId} must pin a tool reference`,
      };
    }
    const toolId = tool.toolId;
    const version = tool.version;
    if (typeof toolId !== "string" || typeof version !== "string") {
      return {
        valid: false,
        reason: "unresolved-tool-version",
        detail: `step ${stepId} tool reference must be (toolId, version) strings`,
      };
    }
    if (!toolExistsInCatalog(catalog, toolId)) {
      return {
        valid: false,
        reason: "unknown-tool-reference",
        detail: `step ${stepId} references tool unknown to the fact catalog: ${toolId}`,
      };
    }
    if (findToolFact(catalog, toolId, version) === null) {
      return {
        valid: false,
        reason: "unresolved-tool-version",
        detail: `step ${stepId} pins version ${version} of ${toolId}, which the catalog does not carry`,
      };
    }
    stepIds.add(stepId);
    steps.push({ stepId, tool: { toolId, version } });
  }

  const edges: CompositionEdge[] = [];
  for (const raw of rawEdges) {
    if (!isRecord(raw)) {
      return {
        valid: false,
        reason: "unknown-edge-endpoint",
        detail: "each edge must be an object",
      };
    }
    const fromStepId = raw.fromStepId;
    const toStepId = raw.toStepId;
    if (typeof fromStepId !== "string" || typeof toStepId !== "string") {
      return {
        valid: false,
        reason: "unknown-edge-endpoint",
        detail: "edge endpoints must be step id strings",
      };
    }
    if (!stepIds.has(fromStepId) || !stepIds.has(toStepId)) {
      return {
        valid: false,
        reason: "unknown-edge-endpoint",
        detail: `edge ${fromStepId} -> ${toStepId} references an unknown step`,
      };
    }
    if (fromStepId === toStepId) {
      return {
        valid: false,
        reason: "self-edge",
        detail: `step ${fromStepId} depends on itself`,
      };
    }
    edges.push({ fromStepId, toStepId });
  }

  const composition: ToolComposition = { steps, edges };
  const cycleAt = compositionCycleExists(composition);
  if (cycleAt !== null) {
    return {
      valid: false,
      reason: "cyclic-composition",
      detail: `the step graph is cyclic (back edge into ${cycleAt}; A -> A, A -> B -> A and every longer cycle are rejected)`,
    };
  }

  const factOfStep = new Map<string, ToolFact>();
  for (const step of steps) {
    const fact = findToolFact(catalog, step.tool.toolId, step.tool.version);
    if (fact !== null) {
      factOfStep.set(step.stepId, fact);
    }
  }
  for (const edge of edges) {
    const upstream = factOfStep.get(edge.fromStepId);
    const downstream = factOfStep.get(edge.toStepId);
    if (upstream === undefined || downstream === undefined) {
      continue; // unreachable: resolved above
    }
    const compatibility = edgeCompatible(upstream, downstream);
    if (!compatibility.ok) {
      return {
        valid: false,
        reason: "incompatible-input-output",
        detail: `edge ${edge.fromStepId} -> ${edge.toStepId}: required input field ${compatibility.field} is not satisfiable by the upstream outputs`,
      };
    }
  }

  return { valid: true, composition };
}

/** The pinned tool version refs of a composition (canonical order). */
export function compositionToolRefs(composition: ToolComposition): readonly ToolVersionRef[] {
  return composition.steps.map((step) => step.tool);
}

/**
 * Build a linear chain composition from a tool sequence (the mining
 * output shape): steps s0..sN with edges s0→s1→…→sN.
 */
export function linearCompositionOf(sequence: readonly ToolVersionRef[]): ToolComposition {
  if (sequence.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "a linear composition requires a non-empty tool sequence",
    });
  }
  const steps: CompositionStep[] = sequence.map((tool, index) => ({
    stepId: `s${index}`,
    tool: { toolId: tool.toolId, version: tool.version },
  }));
  const edges: CompositionEdge[] = [];
  for (let index = 1; index < steps.length; index += 1) {
    const previous = steps[index - 1];
    if (previous === undefined) {
      continue;
    }
    edges.push({ fromStepId: previous.stepId, toStepId: steps[index]?.stepId ?? "" });
  }
  return { steps, edges };
}
