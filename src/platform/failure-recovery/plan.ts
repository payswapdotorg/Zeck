/**
 * Policy-bounded recovery plans (platform failure-recovery plane;
 * ACR-008 §2 — the PCR-001 recovery-plan artifact).
 *
 * A recovery plan is a bounded, typed, deterministic SEQUENCE of
 * governed recovery moves — DATA, never an engine (the
 * continuation-package discipline):
 *
 *  - BOUNDED SEQUENCE: a closed list of plan steps, each carrying its
 *    move kind, its strategy-selection inputs (the then-current
 *    attribution, recovery context and economics facts) and its
 *    selected verdict. The step-count bound rides the configuration
 *    (`RecoveryPlanConfiguration.maxPlanSteps` — an EXPLICIT policy
 *    input, never ambient, never self-raising): the composer rejects a
 *    frame set that exceeds the declared bound, and no composed plan
 *    can exceed it (plans never loop, never exceed their bound).
 *
 *  - PER-STEP SELECTION IS THE EXISTING SEAM: every step is selected
 *    by `selectRecoveryStrategy` (strategy.ts) over the then-current
 *    frame. THE COMPOSER SEQUENCES; IT NEVER SELECTS — there is no
 *    second selection path, no second admissibility pass and no new
 *    authority anywhere in this module.
 *
 *  - HONEST TERMINAL FAILURE: a plan ends in `fail-closed` (the typed
 *    reason of the failing selection) when no admissible move remains;
 *    a plan that consumed its whole frame set under the bound ends
 *    `frames-exhausted`; a plan whose last step reached the configured
 *    bound ends `bound-reached`. The non-retryable is never retried
 *    past its terminal (frames after a fail-closed step are never
 *    composed — the count is carried as drift-visible evidence).
 *
 *  - DETERMINISTIC INCLUDING TIE-BREAKS (invariant 5): the same frames
 *    produce the byte-identical plan — the same `planId` (the content
 *    address, sha256 over the canonical plan form) and the same
 *    serialized value. Idempotent on re-run: replaying the same
 *    failure context yields the same plan; extending the frame set
 *    yields a plan whose steps extend the original's (prefix-stable,
 *    drift-visible through the content address — never silently
 *    divergent).
 *
 *  - FAIL-CLOSED ON EVERY UNMET PRECONDITION: absent per-step inputs,
 *    unknown move kinds, malformed frames, a frame set over the bound,
 *    a missing plan bound, non-canonicalizable inputs — typed
 *    rejections, never guesses, never silent defaults.
 *
 *  - EVIDENCE, NO NEW DURABLE SURFACE: the plan's per-step selections
 *    ARE the material decisions; the caller records them through the
 *    EXISTING WORK-049 decision-record seam (`decisions.ts` —
 *    append-only values at the caller's seam). This module creates no
 *    store, no state machine and no lifecycle (architecture tests
 *    prove it mechanically).
 */

import { canonicalJson, isCanonicalizable } from "../execution-ir/canonical";
import type { OptimizationConstraint } from "../execution-ir/constraints";
import { validateConstraintSet } from "../execution-ir/constraints";
import type { IrDigestPort } from "../execution-ir/ir";
import type { QualityFacts } from "../model-economics/vocabulary";
import { validateQualityFacts } from "../model-economics/vocabulary";
import type { FailureAttribution } from "./attribution";
import { validateFailureAttribution } from "./attribution";
import {
  boundedDetail,
  MAX_PLAN_STEPS,
  RECOVERY_MOVES,
  REROUTE_DIMENSIONS,
  type RecoveryFailClosedCode,
  type RecoveryMove,
  reject,
  SHA256_HEX_PATTERN,
} from "./catalog";
import type { ObservedReliabilityFacts } from "./measured";
import type {
  RecoveryConfiguration,
  RecoveryContext,
  RecoveryFacts,
  RecoverySelection,
  StrategyVerdict,
} from "./strategy";
import {
  selectRecoveryStrategy,
  validateRecoveryConfiguration,
  validateRecoveryContext,
} from "./strategy";

// ---------------------------------------------------------------------------
// The plan-governing configuration (the bound rides the configuration)
// ---------------------------------------------------------------------------

/**
 * The plan-governing configuration: the bounded recovery
 * configuration EXTENDED with the MANDATORY plan step bound (ACR-008
 * §2 — the step-count bound rides `RecoveryConfiguration`, never
 * ambient, never self-raising; its absence at this seam is a typed
 * rejection, so a plan can never be composed without an explicit
 * policy bound).
 */
export interface RecoveryPlanConfiguration extends RecoveryConfiguration {
  /** The maximum number of plan steps the policy admits ([1, 16]). */
  readonly maxPlanSteps: number;
}

/** Total, deterministic validation of the plan-governing configuration. */
export function validateRecoveryPlanConfiguration(
  value: RecoveryPlanConfiguration,
): RecoveryPlanConfiguration {
  if (typeof value !== "object" || value === null) {
    reject("plan-shape", "the recovery-plan configuration must be an object");
  }
  const record = value as unknown as Record<string, unknown>;
  if (
    typeof record.maxPlanSteps !== "number" ||
    !Number.isInteger(record.maxPlanSteps) ||
    record.maxPlanSteps < 1 ||
    record.maxPlanSteps > MAX_PLAN_STEPS
  ) {
    reject("plan-shape", `maxPlanSteps must be an integer in [1, ${MAX_PLAN_STEPS}]`, {
      got: boundedDetail(String(record.maxPlanSteps)),
    });
  }
  // The base configuration's own total validation (retry bound,
  // escalation/continuation bounds) applies wholesale — the plan
  // bound EXTENDS it, never replaces it.
  const base = validateRecoveryConfiguration(value);
  return { ...base, maxPlanSteps: record.maxPlanSteps } as RecoveryPlanConfiguration;
}

// ---------------------------------------------------------------------------
// The caller-supplied per-step frames (the then-current selection inputs)
// ---------------------------------------------------------------------------

/**
 * One caller-supplied per-step frame: the then-current attributed
 * failure, recovery context and economics facts the step's selection
 * runs on. The caller owns the frames (the pure plane never derives
 * them); absent or malformed frame inputs fail closed.
 */
export interface RecoveryPlanStepFrame {
  /** The then-current attributed failure (validated — REQUIRED). */
  readonly attribution: FailureAttribution;
  /** The then-current recovery context (validated — REQUIRED). */
  readonly context: RecoveryContext;
  /** The then-current economics facts (REQUIRED — the selection input). */
  readonly facts: RecoveryFacts;
  /**
   * The then-current observed-reliability facts — the OPTIONAL
   * measured-evidence input (ACR-008 §4; PCR-002), threaded to the
   * step's selection through the EXISTING seam. ABSENCE (undefined or
   * null) composes byte-identically to the declared-facts-only plan
   * (discrimination-tested); PRESENCE may reorder that step's
   * admissible-candidate preferences (never their admissibility).
   */
  readonly measured?: ObservedReliabilityFacts | null;
}

// ---------------------------------------------------------------------------
// The move derivation (the closed move vocabulary, fail-closed)
// ---------------------------------------------------------------------------

/**
 * Derive the typed recovery move of a SELECTED strategy verdict. The
 * move is never free-typed: an unknown strategy kind, or a re-route
 * verdict without its dimension, is a typed rejection — fail-closed
 * on every unknown move kind (discrimination-tested).
 */
export function recoveryMoveOf(verdict: StrategyVerdict): RecoveryMove {
  switch (verdict.strategy) {
    case "retry":
      return { kind: "retry" };
    case "re-route":
      if (
        verdict.rerouteDimension === undefined ||
        !(REROUTE_DIMENSIONS as readonly string[]).includes(verdict.rerouteDimension)
      ) {
        reject("plan-shape", "a re-route verdict must carry its closed re-route dimension", {
          got: boundedDetail(String(verdict.rerouteDimension)),
        });
      }
      return { kind: "re-route", dimension: verdict.rerouteDimension };
    case "escalate-fresh":
      return { kind: "escalate-fresh" };
    case "context-repair":
      return { kind: "context-repair" };
    case "verifier-escalation":
      return { kind: "verifier-escalation" };
    case "fail":
      return { kind: "fail" };
    default:
      reject("plan-shape", "the strategy is outside the closed move vocabulary", {
        got: boundedDetail(String((verdict as { strategy?: unknown }).strategy)),
      });
  }
}

/** Total, deterministic validation of one plan-step move value. */
function validateRecoveryMove(value: unknown): RecoveryMove {
  if (typeof value !== "object" || value === null) {
    reject("plan-shape", "a plan step's move must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.kind !== "string" ||
    !(RECOVERY_MOVES as readonly string[]).includes(record.kind)
  ) {
    reject("plan-shape", "the move kind is outside the closed vocabulary", {
      got: boundedDetail(String(record.kind)),
    });
  }
  if (record.kind === "re-route") {
    if (
      typeof record.dimension !== "string" ||
      !(REROUTE_DIMENSIONS as readonly string[]).includes(record.dimension)
    ) {
      reject("plan-shape", "the re-route move's dimension is outside the closed vocabulary", {
        got: boundedDetail(String(record.dimension)),
      });
    }
    return { kind: "re-route", dimension: record.dimension as (typeof REROUTE_DIMENSIONS)[number] };
  }
  const extra = Object.keys(record).filter((key) => key !== "kind" && key !== "dimension");
  if (extra.length > 0) {
    reject("plan-shape", "the move carries fields outside its kind's shape", {
      got: boundedDetail(extra.join(",")),
    });
  }
  return { kind: record.kind } as RecoveryMove;
}

// ---------------------------------------------------------------------------
// The plan artifact (typed, bounded, content-addressed)
// ---------------------------------------------------------------------------

/** One composed plan step — the move plus its selection inputs and verdict. */
export interface RecoveryPlanStep {
  /** The step's ordinal position ([0, bound) — contiguous from zero). */
  readonly stepIndex: number;
  /** The governed move this step instantiates (derived from the selected verdict). */
  readonly move: RecoveryMove;
  /** The attributed failure this step decided for (validated provenance). */
  readonly attribution: FailureAttribution;
  /** The recovery context the step's selection ran under. */
  readonly context: RecoveryContext;
  /** The economics facts the step's selection ran on. */
  readonly facts: RecoveryFacts;
  /** The EXISTING seam's full selection result (kind `recover`, with its selected verdict). */
  readonly selection: RecoverySelection;
}

/**
 * The typed terminal outcome of a composed plan:
 *
 *  - `fail-closed` — a step's selection found NO admissible move (the
 *    honest terminal failure; carries the selection's typed reason,
 *    the failing attribution identity, the full fail-closed selection
 *    and the count of supplied frames never composed — drift-visible);
 *  - `bound-reached` — every frame composed `recover` and the last step
 *    consumed the configured step bound (the policy bound is the
 *    limiter);
 *  - `frames-exhausted` — every frame composed `recover` under the
 *    bound (the caller supplied no further continuation frames).
 */
export type RecoveryPlanTerminal =
  | {
      readonly kind: "fail-closed";
      readonly failClosedCode: RecoveryFailClosedCode;
      readonly stepIndex: number;
      readonly attributionId: string;
      readonly selection: RecoverySelection;
      readonly remainingFrames: number;
    }
  | { readonly kind: "bound-reached" }
  | { readonly kind: "frames-exhausted" };

/** The frozen basis statement of every recovery plan. */
export const RECOVERY_PLAN_BASIS =
  "bounded-typed-move-sequence;per-step-selection-through-existing-strategy-seam;step-bound-rides-configuration-never-ambient;honest-typed-terminal-failure;content-addressed-plan-identity;idempotent-prefix-stable-composition;fail-closed-on-unmet-preconditions-and-unknown-moves";

/**
 * The recovery plan — a bounded, typed, content-addressed sequence of
 * governed recovery moves. DATA ONLY: the existing execution layer
 * consumes it at its own seam; no store, no state machine, no
 * lifecycle lives here.
 */
export interface RecoveryPlan {
  /** Content-derived identity: sha256 over the canonical plan form. */
  readonly planId: string;
  /** The root attributed failure the plan recovers from (frames[0]'s). */
  readonly failure: FailureAttribution;
  /** The composed steps (bounded, contiguous, every selection `recover`). */
  readonly steps: readonly RecoveryPlanStep[];
  /** The typed terminal outcome. */
  readonly terminal: RecoveryPlanTerminal;
  /** The governing quality facts the composition ran under. */
  readonly qualityFacts: QualityFacts;
  /** The governing constraint set the composition ran under. */
  readonly constraints: readonly OptimizationConstraint[];
  /** The plan-governing configuration (with the mandatory step bound). */
  readonly configuration: RecoveryPlanConfiguration;
  /** The frozen, human-auditable plan basis. */
  readonly planBasis: string;
}

/** The plan form excluding the derived identity. */
type RecoveryPlanForm = Omit<RecoveryPlan, "planId">;

// ---------------------------------------------------------------------------
// The plan-composition seam (pure — the composer sequences, never selects)
// ---------------------------------------------------------------------------

/** The plan-composition input. */
export interface RecoveryPlanInput {
  /**
   * The caller-supplied per-step frames — the then-current attribution,
   * context and facts of every step the plan may compose. Non-empty,
   * at most `maxPlanSteps` frames (over the bound is a typed
   * rejection), consumed in order until the terminal.
   */
  readonly frames: readonly RecoveryPlanStepFrame[];
  /** The governing quality facts (the assurance floor — inviolable). */
  readonly qualityFacts: QualityFacts;
  /** The governing constraint set (hard constraints enforced). */
  readonly constraints: readonly OptimizationConstraint[];
  /** The plan-governing configuration (the step bound is REQUIRED). */
  readonly configuration: RecoveryPlanConfiguration;
  /** The digest port (content addressing — injected, never ambient). */
  readonly digest: IrDigestPort;
}

/**
 * Compose the recovery plan: sequence the per-step selections through
 * the EXISTING `selectRecoveryStrategy` seam until the typed terminal.
 * Pure and deterministic — the same input always produces the
 * byte-identical plan (the same `planId`).
 *
 * Fail-closed BEFORE the plan exists on every unmet precondition:
 * absent plan bound, empty frame set, a frame set over the configured
 * bound, absent/malformed per-step inputs, non-canonicalizable
 * values, or an unknown move kind — typed rejections, never guesses.
 */
export function composeRecoveryPlan(input: RecoveryPlanInput): RecoveryPlan {
  const configuration = validateRecoveryPlanConfiguration(input.configuration);
  const qualityFacts = validateQualityFacts(input.qualityFacts);
  const constraints = validateConstraintSet(input.constraints);
  if (!Array.isArray(input.frames) || input.frames.length === 0) {
    reject("plan-shape", "a recovery plan requires at least one step frame");
  }
  if (input.frames.length > configuration.maxPlanSteps) {
    reject(
      "plan-shape",
      `the supplied step frames exceed the configured plan step bound of ${configuration.maxPlanSteps}`,
      { frames: input.frames.length, maxPlanSteps: configuration.maxPlanSteps },
    );
  }
  if (
    !isCanonicalizable({ qualityFacts, constraints, configuration }) ||
    input.frames.some((frame) => !isCanonicalizable(frame))
  ) {
    // Content addressing requires the closed JSON universe: any
    // non-canonicalizable input is rejected, never silently rounded.
    reject("plan-shape", "the plan inputs must be canonicalizable (closed JSON universe)");
  }
  for (const frame of input.frames) {
    if (typeof frame !== "object" || frame === null) {
      reject("plan-shape", "a plan step frame must be an object");
    }
  }

  const failure = validateFailureAttribution(input.frames[0].attribution, input.digest);
  const steps: RecoveryPlanStep[] = [];
  let terminal: RecoveryPlanTerminal | undefined;

  for (let index = 0; index < input.frames.length; index += 1) {
    const frame = input.frames[index];
    const attribution = validateFailureAttribution(frame.attribution, input.digest);
    const context = validateRecoveryContext(frame.context);
    if (frame.facts === undefined || frame.facts === null || typeof frame.facts !== "object") {
      reject("plan-shape", "a plan step frame requires its economics facts", {
        stepIndex: index,
      });
    }
    // THE EXISTING SEAM (the composer sequences; it never selects).
    const selection = selectRecoveryStrategy({
      attribution,
      context,
      facts: frame.facts,
      qualityFacts,
      constraints,
      configuration,
      digest: input.digest,
      ...(frame.measured === undefined ? {} : { measured: frame.measured }),
    });
    if (selection.kind === "recover" && selection.selected !== null) {
      steps.push({
        stepIndex: steps.length,
        move: recoveryMoveOf(selection.selected),
        attribution,
        context,
        facts: frame.facts,
        selection,
      });
      continue;
    }
    // The honest terminal failure: no admissible move remains (the
    // failing selection's typed reason IS the plan's terminal reason).
    if (selection.failClosedCode === undefined) {
      reject("plan-shape", "a fail-closed selection must carry its typed reason");
    }
    terminal = {
      kind: "fail-closed",
      failClosedCode: selection.failClosedCode,
      stepIndex: steps.length,
      attributionId: attribution.attributionId,
      selection,
      remainingFrames: input.frames.length - (steps.length + 1),
    };
    break;
  }

  if (terminal === undefined) {
    terminal =
      steps.length === configuration.maxPlanSteps
        ? { kind: "bound-reached" }
        : { kind: "frames-exhausted" };
  }

  const form: RecoveryPlanForm = {
    failure,
    steps,
    terminal,
    qualityFacts,
    constraints,
    configuration,
    planBasis: RECOVERY_PLAN_BASIS,
  };
  if (!isCanonicalizable(form)) {
    reject("plan-shape", "the plan form is not canonicalizable");
  }
  return { planId: input.digest.sha256Hex(canonicalJson(form)), ...form };
}

// ---------------------------------------------------------------------------
// Total validation of a (deserialized) plan
// ---------------------------------------------------------------------------

/**
 * Total, deterministic validation of a recovery-plan value (e.g. after
 * a durable round-trip): full shape validation (the closed move
 * vocabulary, step contiguity, bounds, selection coherence, terminal
 * coherence) AND the identity re-derivation — tampered or foreign
 * values are rejected at read time, never served.
 */
export function validateRecoveryPlan(value: unknown, digest: IrDigestPort): RecoveryPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("plan-shape", "recovery plan must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.planId !== "string" || !SHA256_HEX_PATTERN.test(record.planId)) {
    reject("plan-shape", "planId must be a sha256 hex digest", {
      got: boundedDetail(String(record.planId)),
    });
  }
  if (record.planBasis !== RECOVERY_PLAN_BASIS) {
    reject("plan-shape", "the plan basis is outside the frozen vocabulary", {
      got: boundedDetail(String(record.planBasis)),
    });
  }
  const failure = validateFailureAttribution(record.failure, digest);
  const configuration = validateRecoveryPlanConfiguration(
    record.configuration as RecoveryPlanConfiguration,
  );
  const qualityFacts = validateQualityFacts(record.qualityFacts as QualityFacts);
  const constraints = validateConstraintSet(
    record.constraints as readonly OptimizationConstraint[],
  );
  if (!Array.isArray(record.steps)) {
    reject("plan-shape", "plan steps must be an array");
  }
  if (record.steps.length > configuration.maxPlanSteps || record.steps.length > MAX_PLAN_STEPS) {
    reject("plan-shape", "the plan steps exceed the configured step bound", {
      steps: record.steps.length,
      maxPlanSteps: configuration.maxPlanSteps,
    });
  }
  const steps: RecoveryPlanStep[] = [];
  for (let index = 0; index < record.steps.length; index += 1) {
    const step = record.steps[index] as unknown as Record<string, unknown>;
    if (typeof step !== "object" || step === null) {
      reject("plan-shape", "a plan step must be an object");
    }
    if (step.stepIndex !== index) {
      reject("plan-shape", "plan steps must be contiguous from zero", {
        expected: index,
        got: boundedDetail(String(step.stepIndex)),
      });
    }
    const move = validateRecoveryMove(step.move);
    const attribution = validateFailureAttribution(step.attribution, digest);
    const context = validateRecoveryContext(step.context as RecoveryContext);
    if (typeof step.selection !== "object" || step.selection === null) {
      reject("plan-shape", "a plan step must carry its selection");
    }
    const selection = step.selection as unknown as RecoverySelection;
    if (selection.kind !== "recover" || selection.selected === null) {
      reject("plan-shape", "a composed plan step's selection must be a recover outcome");
    }
    if (selection.selected.attributionId !== attribution.attributionId) {
      reject("plan-shape", "a plan step's selection was decided under a different attribution");
    }
    // The move is DERIVED from the selected verdict — a move that does
    // not match its own selection is a tamper, never served.
    if (JSON.stringify(move) !== JSON.stringify(recoveryMoveOf(selection.selected))) {
      reject("plan-shape", "a plan step's move does not match its selected verdict");
    }
    if (step.facts === undefined || step.facts === null || typeof step.facts !== "object") {
      reject("plan-shape", "a plan step must carry its economics facts", { stepIndex: index });
    }
    steps.push({
      stepIndex: index,
      move,
      attribution,
      context,
      facts: step.facts as RecoveryFacts,
      selection,
    });
  }
  const terminal = validatePlanTerminal(record.terminal, steps, configuration);

  const form: RecoveryPlanForm = {
    failure,
    steps,
    terminal,
    qualityFacts,
    constraints,
    configuration,
    planBasis: RECOVERY_PLAN_BASIS,
  };
  if (!isCanonicalizable(form)) {
    reject("plan-shape", "the plan form is not canonicalizable");
  }
  const computed = digest.sha256Hex(canonicalJson(form));
  if (computed !== record.planId) {
    reject("plan-shape", "plan content does not digest to the claimed identity", {
      claimed: record.planId,
      computed,
    });
  }
  return { planId: record.planId, ...form };
}

/** Total, deterministic validation of the typed terminal outcome. */
function validatePlanTerminal(
  value: unknown,
  steps: readonly RecoveryPlanStep[],
  configuration: RecoveryPlanConfiguration,
): RecoveryPlanTerminal {
  if (typeof value !== "object" || value === null) {
    reject("plan-shape", "a plan must carry its terminal outcome");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "bound-reached") {
    if (steps.length !== configuration.maxPlanSteps) {
      reject("plan-shape", "a bound-reached plan must have exactly maxPlanSteps steps", {
        steps: steps.length,
        maxPlanSteps: configuration.maxPlanSteps,
      });
    }
    return { kind: "bound-reached" };
  }
  if (record.kind === "frames-exhausted") {
    if (steps.length >= configuration.maxPlanSteps) {
      reject("plan-shape", "a frames-exhausted plan must be under its configured bound");
    }
    return { kind: "frames-exhausted" };
  }
  if (record.kind !== "fail-closed") {
    reject("plan-shape", "the terminal kind is outside the closed vocabulary", {
      got: boundedDetail(String(record.kind)),
    });
  }
  if (
    typeof record.failClosedCode !== "string" ||
    !["no-admissible-strategy", "no-economic-justification"].includes(record.failClosedCode)
  ) {
    reject("plan-shape", "the terminal fail-closed code is outside the closed vocabulary", {
      got: boundedDetail(String(record.failClosedCode)),
    });
  }
  if (record.stepIndex !== steps.length) {
    reject("plan-shape", "the terminal failure must sit at the first non-composed step", {
      expected: steps.length,
      got: boundedDetail(String(record.stepIndex)),
    });
  }
  if (typeof record.attributionId !== "string" || !SHA256_HEX_PATTERN.test(record.attributionId)) {
    reject("plan-shape", "the terminal failure must name its attribution identity");
  }
  const selection = record.selection as unknown as RecoverySelection;
  if (typeof selection !== "object" || selection === null) {
    reject("plan-shape", "the terminal failure must carry its selection");
  }
  if (selection.kind !== "fail-closed" || selection.selected !== null) {
    reject("plan-shape", "the terminal failure's selection must be a fail-closed outcome");
  }
  if (selection.failClosedCode !== record.failClosedCode) {
    reject("plan-shape", "the terminal code must be the failing selection's typed reason");
  }
  if (!Array.isArray(selection.verdicts) || selection.verdicts.length === 0) {
    reject("plan-shape", "the terminal failure's selection must carry its verdicts");
  }
  const firstVerdict = selection.verdicts[0];
  if (firstVerdict === undefined || firstVerdict.attributionId !== record.attributionId) {
    reject("plan-shape", "the terminal selection was decided under a different attribution");
  }
  if (
    typeof record.remainingFrames !== "number" ||
    !Number.isInteger(record.remainingFrames) ||
    record.remainingFrames < 0
  ) {
    reject("plan-shape", "the terminal's remaining-frame count must be a non-negative integer");
  }
  return {
    kind: "fail-closed",
    failClosedCode: record.failClosedCode as RecoveryFailClosedCode,
    stepIndex: record.stepIndex as number,
    attributionId: record.attributionId,
    selection,
    remainingFrames: record.remainingFrames,
  };
}
