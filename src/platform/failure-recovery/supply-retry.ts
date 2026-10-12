/**
 * The mediated supply retry/failover seam (platform failure-recovery
 * plane; ACR-008 §6 — the PCR-002 default-off plan-composition wiring).
 *
 * THE TRACED POSTURE (byte-preserved, DEFAULT OFF): this module's
 * decision core encodes the mediated supply path's CURRENT retry/
 * failover posture EXACTLY as it lives at the traced seam — ONE policy
 * retry, taken ONLY on a RETRYABLE provider-axis failure of the FIRST
 * dispatch attempt, failing over to the next supply; every other
 * outcome returns without a retry. With `RecoveryConfiguration.planMode`
 * ABSENT or `off` (the default, forever in this work order), the
 * decision is the traced posture byte-for-byte — the wired seam's
 * observable dispatch sequence is unchanged (integration-tested; the
 * program's honesty anchor).
 *
 * THE PLAN MODE (evaluation/tenant configuration ONLY — ACR-008 §6):
 * with planMode `on`, the SAME seam consults the PCR-001 plan composer
 * (`plan.ts` — the EXISTING composition seam, reused never rebuilt) and
 * the decision carries the composed bounded move sequence INSTEAD of
 * the hard-coded single retry. Plan mode `on` is never a code-path
 * default anywhere: the wiring FAILS CLOSED without its explicit plan
 * composition inputs (frames, governing facts, the plan step bound —
 * never ambient, never self-raising).
 *
 * EVIDENCE, NO NEW DURABLE SURFACE: every composed plan step's
 * selection is recorded through the EXISTING WORK-049 decision-record
 * seam (`decisions.ts` — `buildRecoveryDecisionRecord`, append-only
 * VALUES at the caller's seam). This module creates no store, no state
 * machine and no lifecycle (architecture tests prove it mechanically);
 * the caller appends the returned records through the existing store.
 *
 * REUSE, DO NOT REBUILD: the strategy selection, the admissibility
 * machinery, the attribution discipline, the plan composer and the
 * decision-record seam all exist and are composed here — there is no
 * second selection path, no second admissibility pass and no new
 * authority anywhere in this module.
 */

import type { OptimizationConstraint } from "../execution-ir/constraints";
import type { OptimizationDecisionRecord } from "../execution-ir/decision-record";
import type { ExecutionIr, IrDigestPort } from "../execution-ir/ir";
import type { QualityFacts } from "../model-economics/vocabulary";
import { boundedDetail, MAX_RETRY_ATTEMPTS, reject } from "./catalog";
import {
  buildRecoveryDecisionRecord,
  type RecoveryDecisionScope,
  recoveryClaimsOf,
} from "./decisions";
import {
  composeRecoveryPlan,
  type RecoveryPlan,
  type RecoveryPlanConfiguration,
  type RecoveryPlanStepFrame,
  validateRecoveryPlanConfiguration,
} from "./plan";
import { type RecoveryConfiguration, validateRecoveryConfiguration } from "./strategy";

// ---------------------------------------------------------------------------
// The seam's outcome mirror (neutral, closed — the caller maps its own
// transport taxonomy onto it; the plane never imports a transport)
// ---------------------------------------------------------------------------

/**
 * The neutral provider-axis dispatch outcome the seam reports to this
 * decision core: the closed two-kind vocabulary (success / provider
 * failure) plus the normalized retryability of the failure. The CALLER
 * maps its own transport/provider taxonomy onto this mirror — this
 * plane never imports or re-implements a transport's categories.
 */
export interface SupplyDispatchOutcomeMirror {
  readonly kind: "provider-success" | "provider-failure";
  /**
   * Whether retrying the same logical dispatch may succeed
   * (provider-failure only — a `provider-success` outcome carrying a
   * truthy retryability is an incoherent shape and fails closed).
   */
  readonly retryable: boolean;
}

// ---------------------------------------------------------------------------
// The decision (the traced posture, or the composed plan)
// ---------------------------------------------------------------------------

/**
 * The traced seam's retry decision:
 *
 *  - `no-retry` — return the outcome as-is (the byte-preserved
 *    terminal of the traced posture);
 *  - `retry-once-next-supply` — the ONE policy retry of the traced
 *    posture: fail over to the next supply, re-dispatch once, return
 *    the second outcome (the caller's cooldown/mechanics are its own);
 *  - `execute-plan` — plan mode ON: the composed bounded move sequence
 *    (data — the caller executes its steps at its own seam) plus the
 *    WORK-049 decision records of every composed step's selection
 *    (append-only values through the EXISTING seam).
 */
export type SupplyRetryDecision =
  | { readonly kind: "no-retry" }
  | { readonly kind: "retry-once-next-supply" }
  | {
      readonly kind: "execute-plan";
      readonly plan: RecoveryPlan;
      readonly decisionRecords: readonly OptimizationDecisionRecord[];
    };

/** The plan-composition inputs (REQUIRED when plan mode is `on`). */
export interface SupplyPlanCompositionInput {
  /**
   * The caller-supplied per-step frames — the then-current attribution,
   * context, economics facts (and optional measured evidence) of every
   * step the plan may compose. The caller owns the frames; the wiring
   * never derives them.
   */
  readonly frames: readonly RecoveryPlanStepFrame[];
  /** The governing quality facts (the assurance floor — inviolable). */
  readonly qualityFacts: QualityFacts;
  /** The governing constraint set (hard constraints enforced). */
  readonly constraints: readonly OptimizationConstraint[];
  /** The WORK-049 record inputs: the governed IR and the record scope. */
  readonly decision: {
    readonly ir: ExecutionIr;
    readonly scope: RecoveryDecisionScope;
  };
  /** The digest port (content addressing — injected, never ambient). */
  readonly digest: IrDigestPort;
}

/** The retry-decision input at the traced seam. */
export interface SupplyRetryDecisionInput {
  /**
   * The dispatch attempts already used at this seam for the logical
   * request ([1, 10] — the traced posture addresses attempts 1 and 2).
   */
  readonly attemptsUsed: number;
  /** The last dispatch outcome (the neutral mirror). */
  readonly lastOutcome: SupplyDispatchOutcomeMirror;
  /**
   * The recovery configuration — the plan mode rides HERE (ACR-008 §6):
   * ABSENT or `off` is the DEFAULT (the byte-preserved traced posture);
   * `on` is an explicit evaluation/tenant configuration.
   */
  readonly configuration: RecoveryConfiguration;
  /** The plan composition inputs — REQUIRED when planMode is `on`. */
  readonly plan?: SupplyPlanCompositionInput;
}

// ---------------------------------------------------------------------------
// The decision core (pure, deterministic, fail-closed)
// ---------------------------------------------------------------------------

/**
 * Decide the traced seam's retry posture. Pure and deterministic:
 *
 *  - plan mode OFF (or ABSENT — the default): the byte-preserved traced
 *    posture — one retry, only on a retryable provider failure of the
 *    first attempt, failing over to the next supply;
 *  - plan mode ON (an explicit evaluation/tenant configuration):
 *    compose the bounded recovery plan through the EXISTING composer
 *    over the caller-supplied frames and record every composed step's
 *    decision through the EXISTING WORK-049 seam (append-only values).
 *
 * Fail-closed on every unmet precondition: malformed outcome mirrors,
 * out-of-bound attempt counts, plan mode `on` without its plan inputs,
 * a missing plan step bound, malformed frames — typed rejections,
 * never guesses, never silent defaults.
 */
export function decideSupplyRetry(input: SupplyRetryDecisionInput): SupplyRetryDecision {
  if (typeof input !== "object" || input === null) {
    reject("supply-retry-shape", "the supply retry decision requires its input");
  }
  if (
    typeof input.attemptsUsed !== "number" ||
    !Number.isInteger(input.attemptsUsed) ||
    input.attemptsUsed < 1 ||
    input.attemptsUsed > MAX_RETRY_ATTEMPTS
  ) {
    reject("supply-retry-shape", `attemptsUsed must be an integer in [1, ${MAX_RETRY_ATTEMPTS}]`, {
      got: boundedDetail(String(input.attemptsUsed)),
    });
  }
  if (typeof input.lastOutcome !== "object" || input.lastOutcome === null) {
    reject("supply-retry-shape", "the supply retry decision requires its last outcome mirror");
  }
  const outcome = input.lastOutcome;
  if (outcome.kind !== "provider-success" && outcome.kind !== "provider-failure") {
    reject("supply-retry-shape", "the outcome mirror kind is outside the closed vocabulary", {
      got: boundedDetail(String(outcome.kind)),
    });
  }
  if (typeof outcome.retryable !== "boolean") {
    reject("supply-retry-shape", "the outcome mirror retryability must be boolean");
  }
  if (outcome.kind === "provider-success" && outcome.retryable) {
    reject(
      "supply-retry-shape",
      "a provider-success outcome cannot carry retryability (the incoherent shape is rejected)",
    );
  }
  const configuration = validateRecoveryConfiguration(input.configuration);
  const planMode = configuration.planMode ?? "off";

  if (planMode === "off") {
    // THE TRACED POSTURE — byte-preserved (plan mode DEFAULT OFF): the
    // one-failover-retry posture exactly as it lives at the traced
    // seam today. No plan is composed; no record exists (the traced
    // posture's evidence discipline is unchanged).
    if (input.attemptsUsed === 1 && outcome.kind === "provider-failure" && outcome.retryable) {
      return { kind: "retry-once-next-supply" };
    }
    return { kind: "no-retry" };
  }

  // PLAN MODE ON — an explicit evaluation/tenant configuration ONLY
  // (ACR-008 §6). The composed bounded move sequence replaces the
  // hard-coded single retry at this seam; every unmet precondition
  // fails closed (never a silent fallback to the traced posture — the
  // evaluation must KNOW it is running plan mode).
  if (outcome.kind === "provider-success") {
    // A RESOLVED dispatch has no recovery to compose: plan mode
    // governs failure recovery only, and the resolved terminal is the
    // traced posture's own (return the outcome — no retry, no plan).
    return { kind: "no-retry" };
  }
  if (input.plan === undefined || input.plan === null || typeof input.plan !== "object") {
    reject(
      "supply-retry-shape",
      "plan mode on requires its plan composition input (fail closed — never a silent default posture)",
    );
  }
  if (configuration.maxPlanSteps === undefined) {
    reject(
      "supply-retry-shape",
      "plan mode on requires the recovery-plan step bound (maxPlanSteps) — never ambient, never self-raising",
    );
  }
  const planConfiguration = validateRecoveryPlanConfiguration(
    configuration as RecoveryPlanConfiguration,
  );
  const plan = composeRecoveryPlan({
    frames: input.plan.frames,
    qualityFacts: input.plan.qualityFacts,
    constraints: input.plan.constraints,
    configuration: planConfiguration,
    digest: input.plan.digest,
  });

  // Every composed step's decision is recorded through the EXISTING
  // WORK-049 seam (append-only values; the caller appends them at its
  // own seam — no new durable surface is created here). A fail-closed
  // terminal produces no record (the typed outcome IS the evidence).
  const decisionRecords: OptimizationDecisionRecord[] = [];
  for (const step of plan.steps) {
    const record = buildRecoveryDecisionRecord({
      attribution: step.attribution,
      selection: step.selection,
      claims: recoveryClaimsOf(step.facts),
      ir: input.plan.decision.ir,
      constraints: input.plan.constraints,
      scope: input.plan.decision.scope,
      ...(step.selection.measuredProvenance === undefined
        ? {}
        : { measuredProvenance: step.selection.measuredProvenance }),
      digest: input.plan.digest,
    });
    if (record !== null) {
      decisionRecords.push(record);
    }
  }
  return { kind: "execute-plan", plan, decisionRecords };
}
