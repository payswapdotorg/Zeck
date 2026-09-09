/**
 * Tool-need extraction (platform tool-surface plane; WORK-051 / E1.1
 * charter stage 3).
 *
 * The plan's DECLARED tool needs, extracted purely and losslessly from
 * the governed plan representation (the WORK-049 Execution IR, or the
 * WORK-050 compiled variant of it — both carry the same step fields):
 *
 *  - a TOOL NEED is a `call-tool` step: the plan's own declaration that
 *    a governed tool must be invoked. The need's tool identity is the
 *    step's bound `capabilityId` (the planner binds the tool capability
 *    exactly as its composition policy ranks tools by capability id —
 *    the same vocabulary, never re-derived here). A `call-tool` step
 *    WITHOUT a capability binding is structurally invalid for surface
 *    derivation (fail closed `need-shape`: the need cannot be
 *    capability-conditioned);
 *  - a MECHANICAL STEP is a deterministic, pure step (computation type
 *    `deterministic`, side-effect class `pure` — the frozen derived
 *    facts of the plan's step classes). Mechanical steps MAY declare
 *    bounded programmatic work through their closed config key
 *    `programmatic` (the plan's own declaration, validated against the
 *    closed operation vocabulary); the derivation records the honest
 *    decision for every mechanical step (declared / not-declared /
 *    disabled), and rejects invalid declarations fail-closed.
 *
 * Pure functions of the plan representation: no I/O, no clock, no
 * randomness — the same steps always produce the same needs and the
 * same mechanical-step decisions.
 */

import type { IrVariantStep } from "../execution-compiler/variant";
import type { IrStep } from "../execution-ir/ir";
import { computationTypeOfStep, sideEffectClassOfStep } from "../execution-ir/ir";
import { rejectSurface } from "./catalog";
import { type ProgrammaticSpec, validateProgrammaticSpec } from "./programmatic";

// ---------------------------------------------------------------------------
// The extracted tool need
// ---------------------------------------------------------------------------

/** One declared tool need: a `call-tool` step of the governed plan. */
export interface ToolNeed {
  /** The stable need identity — the plan step's own id. */
  readonly needId: string;
  readonly stepId: string;
  readonly stepClass: "call-tool";
  /** The bound tool identity (the planner's capability-bound tool id). */
  readonly toolId: string;
  /** The plan step's closed config, when present (carried verbatim). */
  readonly config: Readonly<Record<string, unknown>> | undefined;
}

/** The step facts shared by the IR and the compiled variant steps. */
type StepSource = IrStep | IrVariantStep;

function stepConfig(step: StepSource): Readonly<Record<string, unknown>> | undefined {
  return step.config;
}

/**
 * Extract the plan's declared tool needs (pure, deterministic, in plan
 * step order). A `call-tool` step without a capability binding fails
 * closed: its tool identity — and therefore its capability
 * conditioning — cannot be established.
 */
export function extractToolNeeds(steps: readonly StepSource[]): readonly ToolNeed[] {
  const needs: ToolNeed[] = [];
  for (const step of steps) {
    if (step.stepClass !== "call-tool") {
      continue;
    }
    if (step.capabilityId === undefined || step.capabilityId.length === 0) {
      rejectSurface("need-shape", "a call-tool step must bind a capability (tool identity)", {
        stepId: step.id,
      });
    }
    needs.push({
      needId: step.id,
      stepId: step.id,
      stepClass: "call-tool",
      toolId: step.capabilityId,
      config: stepConfig(step),
    });
  }
  return needs;
}

// ---------------------------------------------------------------------------
// The mechanical-step decision
// ---------------------------------------------------------------------------

/**
 * The mechanical family: the plan step classes whose derived facts are
 * deterministic AND pure — the only steps whose work may execute
 * programmatically outside model context (retrieve, transform,
 * run-algorithm, parallel, branch, compare; verification, tool,
 * generative, sandboxed-program and control-flow steps are excluded
 * by their derived side-effect classes).
 */
export const MECHANICAL_STEP_CLASSES: readonly string[] = [
  "retrieve",
  "transform",
  "run-algorithm",
  "parallel",
  "branch",
  "compare",
];

/** The plan's reserved config key declaring bounded programmatic work. */
export const PROGRAMMATIC_CONFIG_KEY = "programmatic";

/** The closed decision-reason vocabulary (recorded evidence). */
export const PROGRAMMATIC_DECISION_REASONS = ["declared", "not-declared", "disabled"] as const;
export type ProgrammaticDecisionReason = (typeof PROGRAMMATIC_DECISION_REASONS)[number];

/**
 * The derivation's programmatic-execution decision for ONE mechanical
 * step: whether the step's declared mechanical work executes outside
 * model context, and (when declared) the validated closed spec.
 */
export interface ProgrammaticDecision {
  readonly stepId: string;
  readonly stepClass: string;
  readonly programmatic: boolean;
  readonly reason: ProgrammaticDecisionReason;
  /**
   * The validated declaration (present for `declared` and `disabled` —
   * the honest record of what the plan declared; null for
   * `not-declared`).
   */
  readonly spec: ProgrammaticSpec | null;
}

function isMechanicalStep(step: StepSource): boolean {
  return (
    computationTypeOfStep(step.stepClass) === "deterministic" &&
    sideEffectClassOfStep(step.stepClass) === "pure"
  );
}

/**
 * Derive the programmatic-execution decisions for every mechanical
 * step of the plan (pure, deterministic, in plan step order):
 *
 *  - a mechanical step whose config declares programmatic work AND is
 *    enabled ⇒ `declared` with the VALIDATED spec (an invalid
 *    declaration — closed vocabulary or bounds violated — fails closed
 *    `programmatic-spec`: never silently degraded);
 *  - a mechanical step without a declaration ⇒ `not-declared` (honest:
 *    the plan did not declare mechanical work);
 *  - a declared mechanical step with programmatic execution disabled
 *    in the configuration ⇒ `disabled` (honest availability fact; the
 *    work simply does not execute programmatically);
 *  - a NON-mechanical step carrying a programmatic declaration fails
 *    closed `programmatic-spec` (the plan declared mechanical work on
 *    a step whose derived facts exclude it — unrepresentable, never
 *    silently ignored).
 */
export function deriveProgrammaticDecisions(
  steps: readonly StepSource[],
  programmaticEnabled: boolean,
): readonly ProgrammaticDecision[] {
  const decisions: ProgrammaticDecision[] = [];
  for (const step of steps) {
    const declaration = stepConfig(step)?.[PROGRAMMATIC_CONFIG_KEY];
    if (declaration === undefined) {
      if (isMechanicalStep(step)) {
        decisions.push({
          stepId: step.id,
          stepClass: step.stepClass,
          programmatic: false,
          reason: "not-declared",
          spec: null,
        });
      }
      continue;
    }
    if (!isMechanicalStep(step)) {
      rejectSurface(
        "programmatic-spec",
        "a non-mechanical step declared programmatic work (programmatic work binds only to deterministic pure steps)",
        { stepId: step.id, stepClass: step.stepClass },
      );
    }
    const spec = validateProgrammaticSpec(declaration);
    if (spec.stepId !== step.id) {
      rejectSurface("programmatic-spec", "the declared spec's stepId must match its plan step", {
        stepId: step.id,
        specStepId: spec.stepId,
      });
    }
    if (!programmaticEnabled) {
      decisions.push({
        stepId: step.id,
        stepClass: step.stepClass,
        programmatic: false,
        reason: "disabled",
        spec,
      });
      continue;
    }
    decisions.push({
      stepId: step.id,
      stepClass: step.stepClass,
      programmatic: true,
      reason: "declared",
      spec,
    });
  }
  return decisions;
}
