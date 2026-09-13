/**
 * The platform-side canary-promotion engine (VAL-035).
 *
 * The mechanical engine of the canary slice: it takes VAL-034's
 * SHADOW-EXECUTED candidates (the lifecycle identities whose recorded
 * walk already ends at `shadow-executed` — the READ-ONLY input; a
 * recorded walk is never rewritten) and drives the governed
 * PROMOTION path — a canary execution where the replacement serves a
 * PINNED, gradually-ramped TRAFFIC SLICE (the ramp schedule's pinned
 * traffic fractions, e.g. 5% → 25% → 50% → 100%) under EXPLICIT
 * admission policy: every canary decision CITES its policy (the ramp
 * schedule, the failure budget and the divergence tolerance — stated
 * AND checked), the served outcome switches to the replacement ONLY
 * for the canary slice (the incumbent still serves the remainder),
 * and every canary step is compared against the recorded shadow
 * evidence's own criterion basis (the shadow's per-case agreement is
 * the canary's prior).
 *
 * The promotion oracle (the PURE derivations that make a governed
 * ramp trustworthy):
 *
 *   * `deriveCanaryPolicyExplicitness` — every canary step's decision
 *     must cite its policy: the ramp schedule, the failure budget and
 *     the divergence tolerance stated AND checked. An UNSTATED policy
 *     item, or a stated-but-UNCHECKED budget/tolerance, FAILs with the
 *     unchecked item named; a malformed ramp schedule (fractions not
 *     strictly increasing, a fraction outside (0, 1], or a schedule
 *     that does not end at the full-traffic step) FAILs just the same;
 *   * `derivePromotionLifecycleCompleteness` — the candidate's
 *     lifecycle walk must be the FULL evidenced chain
 *     (offline-replayed → differentially-evaluated → shadow-executed)
 *     before the canary: a skipped stage, a broken walk or an
 *     unevidenced transition FAILs; the canary advances
 *     `shadow-executed → canaried → promoted` one evidenced rung at a
 *     time — a jump (a promoted append without the canaried rung)
 *     FAILs, and nothing lands past `promoted` (the FINAL stage);
 *   * `deriveBreachHonesty` — an observed divergence count beyond the
 *     pinned failure budget FAILs the step and the decision MUST be
 *     breach-rollback (a smoothed breach that advances FAILs; a breach
 *     decision without the rollback trigger FAILs; an asserted count
 *     that contradicts the per-case record FAILs); a within-budget
 *     step advances honestly;
 *   * `deriveRollbackCompleteness` — the rollback is COMPLETE and
 *     mechanical: the served traffic reverts to the incumbent across
 *     the whole slice (a partial rollback that leaves ANY fraction
 *     serving the replacement FAILs, naming the residual), and the
 *     rollback plan must have been EXERCISED (an unevidenced rollback
 *     plan on a demanded rollback FAILs);
 *   * `deriveSliceIsolation` — an unpromoted candidate serves ONLY its
 *     canary slice fraction (an over-slice serve FAILs with the
 *     over-served cases named); a tenant outside the granted slice
 *     FAILs with the tenant named; after promotion the full traffic
 *     may serve the replacement;
 *   * `deriveCanaryCostSeparation` — the canary slice's cost is
 *     measured APART with its canary marker: a canary cost billed as
 *     ordinary served traffic without the marker FAILs, and an
 *     unmeasured or unbooked canary cost FAILs just the same.
 *
 * The isolation discipline carries into the canary (the containment
 * carry-over): the replacement still runs inside its GRANTED isolation
 * surface DURING the canary — an escape mid-canary is a containment
 * violation that FAILs and is recorded (VAL-033's
 * `deriveReplacementIsolation` is reused verbatim).
 *
 * Digest discipline: every identity, citation, decision, rollback
 * event and cost entry carries an FNV-1a payload-free digest; payload
 * bytes never enter the evidence. Latency is always measured; usage is
 * honestly none-reported offline and measured only on the live rail.
 *
 * Everything is seam-injected here (the lab contract); the integration
 * seam binds the REAL platform path and — for the live row — the REAL
 * model gateway dispatch.
 */

import type { LabUsage, LabVerificationCriterion } from "./derive";
import type {
  AcceptanceCriterion,
  CandidateLifecycleLedgerPort,
  DifferentialCase,
  EquivalenceRegistryFacts,
  IncumbentExecutorPort,
  LifecycleTransitionRecord,
  ReplacementIsolationVerdict,
  ReplacementShape,
} from "./equivalence-testing";
import {
  criterionSatisfiedForCase,
  deriveReplacementIsolation,
  equivalenceRegistryDigestOf,
  lifecycleEvidenceDigestOf,
  referenceReplacementOutcomeDigestOf,
} from "./equivalence-testing";
import type { CandidateLifecycleStage, DiscoveryProposalRecord } from "./learning-discovery";
import { CANDIDATE_LIFECYCLE_STAGES } from "./learning-discovery";
import type { ControlDispatch, TrajectoryStepRecord } from "./longitudinal-baseline";
import { isRetryableDispatchCategory, longitudinalDigestOf } from "./longitudinal-baseline";
import { SHADOW_STAGE } from "./shadow-execution";

// ---------------------------------------------------------------------------
// The canary vocabulary (the governed-ramp grammar)
// ---------------------------------------------------------------------------

/**
 * The canary phase's learning mode: the canary SERVES A SLICE under a
 * governed ramp — the replacement serves only its pinned traffic
 * fraction while the incumbent serves the remainder, every step's
 * decision cites its stated-and-checked policy, and a breach triggers
 * the complete mechanical rollback.
 */
export const CANARY_LEARNING_PHASE = "canary" as const;

/** The longitudinal-experiment kind every canary run registers as. */
export const CANARY_EXPERIMENT_KIND = "canary-promotion";

/**
 * The canary-mode vocabulary: the canary runs as a GOVERNED RAMP — a
 * pinned schedule of increasing traffic fractions under an explicit
 * failure budget. An "ungoverned" ramp (a slice without its policy) is
 * not a mode: it is a policy-explicitness failure, caught mechanically
 * by `deriveCanaryPolicyExplicitness`.
 */
export const CANARY_MODES = ["governed-ramp"] as const;

export type CanaryMode = (typeof CANARY_MODES)[number];

export function isCanaryMode(value: string): value is CanaryMode {
  return (CANARY_MODES as readonly string[]).includes(value);
}

/**
 * The canary decision kinds (the per-step admission vocabulary):
 *
 *   * `advance` — the step observed a divergence count within its
 *     pinned failure budget under its stated-and-checked policy, and
 *     the ramp advances to the next pinned fraction;
 *   * `breach-rollback` — the step observed a divergence count BEYOND
 *     its pinned budget: the step FAILs and the served traffic reverts
 *     to the incumbent across the whole slice (the complete,
 *     mechanical, exercised rollback);
 *   * `refuse` — the candidate's own recorded state does not support
 *     a canary run at all (the run-level honest refusal; never a
 *     mid-ramp decision).
 */
export const CANARY_DECISION_KINDS = ["advance", "breach-rollback", "refuse"] as const;

export type CanaryDecisionKind = (typeof CANARY_DECISION_KINDS)[number];

export function isCanaryDecisionKind(value: string): value is CanaryDecisionKind {
  return (CANARY_DECISION_KINDS as readonly string[]).includes(value);
}

/**
 * The canary verdict kinds (the per-row outcome vocabulary):
 *
 *   * `clean-promotion` — every ramp step advanced within its pinned
 *     budget under its stated-and-checked policy and the candidate
 *     landed its `promoted` transition (the FINAL stage) one evidenced
 *     rung at a time;
 *   * `honest-rollback` — a step's observed divergence exceeded the
 *     pinned budget, the step FAILs honestly and the served traffic
 *     reverted to the incumbent across the whole slice (the rollback
 *     is complete and exercised; the candidate lands `canaried` only);
 *   * `containment-violation` — the replacement escaped its granted
 *     isolation surface MID-CANARY (the containment carry-over);
 *   * `honest-refusal` — the candidate's own lifecycle state does not
 *     support a canary run (unregistered, or not yet shadow-executed);
 *   * `canary-invalid` — the run's mechanical shape is untrustworthy
 *     (an unstated or unchecked policy, a skipped or broken lifecycle
 *     walk, a smoothed breach, a partial or unevidenced rollback, an
 *     over-slice serve, a billed canary): an internal honesty failure,
 *     never a passable outcome.
 */
export const CANARY_VERDICTS = [
  "clean-promotion",
  "honest-rollback",
  "containment-violation",
  "honest-refusal",
  "canary-invalid",
] as const;

export type CanaryVerdictKind = (typeof CANARY_VERDICTS)[number];

export function isCanaryVerdictKind(value: string): value is CanaryVerdictKind {
  return (CANARY_VERDICTS as readonly string[]).includes(value);
}

/**
 * The honest refusal reasons (a canary run refuses only when the
 * candidate's own recorded state genuinely justifies it):
 *
 *   * `candidate-unregistered` — the cited candidate identity is not a
 *     member of the candidate registry (a phantom candidate);
 *   * `candidate-not-shadow-executed` — the candidate's recorded
 *     lifecycle walk has not yet reached the `shadow-executed` stage
 *     (VAL-034's landing) — a premature canary refuses honestly.
 */
export const CANARY_REFUSAL_REASONS = [
  "candidate-unregistered",
  "candidate-not-shadow-executed",
] as const;

export type CanaryRefusalReason = (typeof CANARY_REFUSAL_REASONS)[number];

export function isCanaryRefusalReason(value: string): value is CanaryRefusalReason {
  return (CANARY_REFUSAL_REASONS as readonly string[]).includes(value);
}

/**
 * The canary-probe kinds the corpus declares (the vocabulary the later
 * discrimination phases drive over the adversarial fixture variants —
 * designed here, pinned now):
 *
 *   * `skipped-lifecycle` — the candidate's walk is broken (a skipped
 *     stage or an unevidenced transition) or the append jumps a rung
 *     (a promoted landing without the canaried rung) — FAILs;
 *   * `unchecked-policy` — a decision cites an unstated
 *     ramp/budget/tolerance, or states one it never checked — FAILs
 *     with the unchecked item named;
 *   * `smoothed-breach` — a divergence count beyond the budget is
 *     claimed within (the step advances anyway) — FAILs;
 *   * `over-slice` — the serving path serves the replacement beyond
 *     the step's pinned slice fraction (or to a tenant outside the
 *     granted slice) — FAILs;
 *   * `partial-rollback` — the rollback leaves a residual fraction
 *     serving the replacement, or the plan was never exercised —
 *     FAILs;
 *   * `mid-canary-escape` — the replacement exercises a capability
 *     outside its granted surface DURING the canary (a containment
 *     violation) — FAILs.
 */
export const CANARY_PROBE_KINDS = [
  "skipped-lifecycle",
  "unchecked-policy",
  "smoothed-breach",
  "over-slice",
  "partial-rollback",
  "mid-canary-escape",
] as const;

export type CanaryProbeKind = (typeof CANARY_PROBE_KINDS)[number];

export function isCanaryProbeKind(value: string): value is CanaryProbeKind {
  return (CANARY_PROBE_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The lifecycle ladder (the canary slice's walk — the FINAL stages)
// ---------------------------------------------------------------------------

/**
 * The lifecycle stage a canary run's ramp lands a candidate at: the
 * `canaried` rung. The walk is `shadow-executed → canaried` — one
 * evidenced rung, never a jump.
 */
export const CANARY_STAGE: CandidateLifecycleStage = "canaried";

/**
 * The FINAL lifecycle stage: `promoted`. A clean promotion lands it
 * exactly once, AFTER the `canaried` rung, with its evidence digest —
 * nothing on the pinned ladder lies beyond it.
 */
export const PROMOTED_STAGE: CandidateLifecycleStage = "promoted";

/**
 * The ONLY lifecycle stage a canary run may advance FROM: VAL-034's
 * landing. A candidate whose recorded walk has not yet reached it is
 * premature and refuses honestly.
 */
export const CANARY_SOURCE_STAGE: CandidateLifecycleStage = SHADOW_STAGE;

/** The ladder index of a stage (its position on the pinned candidate ladder). */
export function canaryLifecycleStageIndexOf(stage: CandidateLifecycleStage): number {
  return (CANDIDATE_LIFECYCLE_STAGES as readonly string[]).indexOf(stage);
}

/**
 * The recorded walk a canary run demands as its read-only input: the
 * FULL evidenced chain VAL-033 + VAL-034 appended —
 * `offline-replayed → differentially-evaluated → shadow-executed`.
 */
export const CANARY_REQUIRED_PRIOR_WALK: readonly CandidateLifecycleStage[] = [
  "offline-replayed",
  "differentially-evaluated",
  "shadow-executed",
];

/**
 * Whether a lifecycle stage lies BEYOND the promotion slice's scope
 * (any stage past `promoted` on the pinned ladder — there is none
 * today, and a future ladder extension must re-earn this pin). A
 * canary run that advances a candidate to any of these FAILs the
 * lifecycle discipline mechanically.
 */
export function isBeyondPromotionScope(stage: CandidateLifecycleStage): boolean {
  return canaryLifecycleStageIndexOf(stage) > canaryLifecycleStageIndexOf(PROMOTED_STAGE);
}

// ---------------------------------------------------------------------------
// The ramp / budget / tolerance vocabulary (the explicit policy)
// ---------------------------------------------------------------------------

/**
 * ONE ramp step: the pinned traffic fraction the replacement serves at
 * that step (e.g. 0.05 → 0.25 → 0.5 → 1). The fraction is a share of
 * the row's declared traffic population, and the schedule's LAST step
 * must be the full-traffic step (fraction 1) — the ramp completes only
 * by serving the whole population before promotion lands.
 */
export interface RampStep {
  /** 1-based step ordinal within the schedule. */
  readonly stepIndex: number;
  /** The pinned traffic fraction serving the replacement at this step (0, 1]. */
  readonly trafficFraction: number;
}

/**
 * The failure-budget shape: the MAXIMUM count of per-step divergences
 * the policy tolerates per ramp step. A step whose observed divergence
 * count exceeds this budget FAILs and the run rolls back — the budget
 * is stated AND checked (an unstated or unchecked budget FAILs the
 * policy explicitness).
 */
export interface FailureBudget {
  readonly maxDivergencesPerStep: number;
}

/**
 * The canonical digest over a ramp schedule (PURE — FNV-1a,
 * payload-free): the citation digest every canary decision must carry
 * for its ramp policy leg.
 */
export function rampScheduleDigestOf(schedule: readonly RampStep[]): string {
  return longitudinalDigestOf([
    "canary-ramp-schedule",
    schedule.map((step) => [step.stepIndex, step.trafficFraction]),
  ]);
}

/**
 * The canonical digest over a failure budget (PURE, payload-free).
 */
export function failureBudgetDigestOf(budget: FailureBudget): string {
  return longitudinalDigestOf(["canary-failure-budget", budget.maxDivergencesPerStep]);
}

/**
 * Whether a ramp schedule is WELL-FORMED (PURE): at least one step,
 * every fraction in (0, 1], fractions strictly increasing with the
 * step ordinals, ordinals gapless from 1, and the schedule ending at
 * the FULL-traffic step (fraction 1). A malformed schedule FAILs the
 * policy explicitness — the ramp is the pinned grammar of the slice.
 */
export function isRampScheduleWellFormed(schedule: readonly RampStep[]): boolean {
  if (schedule.length === 0) {
    return false;
  }
  for (let index = 0; index < schedule.length; index += 1) {
    const step = schedule[index];
    if (step === undefined) {
      return false;
    }
    if (step.stepIndex !== index + 1) {
      return false;
    }
    if (!(step.trafficFraction > 0 && step.trafficFraction <= 1)) {
      return false;
    }
    const previous = index > 0 ? schedule[index - 1] : undefined;
    if (previous !== undefined && !(step.trafficFraction > previous.trafficFraction)) {
      return false;
    }
  }
  const last = schedule[schedule.length - 1];
  return last !== undefined && last.trafficFraction === 1;
}

// ---------------------------------------------------------------------------
// The slice vocabulary (deterministic traffic slicing)
// ---------------------------------------------------------------------------

/**
 * The deterministic slice membership for one ramp fraction (PURE): the
 * population's case ids, sorted canonically, take the first
 * `max(1, floor(fraction * N))` cases (the whole population when the
 * fraction is the full-traffic step). The slice is a pure function of
 * the population and the pinned fraction — never a runtime choice.
 */
export function sliceCaseIdsOf(
  populationCaseIds: readonly string[],
  trafficFraction: number,
): readonly string[] {
  const sorted = [...populationCaseIds].sort((left, right) => left.localeCompare(right));
  if (trafficFraction >= 1) {
    return sorted;
  }
  const size = Math.max(1, Math.floor(trafficFraction * sorted.length));
  return sorted.slice(0, size);
}

/**
 * The deterministic tenant identity of one traffic case (PURE — a
 * stable function of the case id): the tenant the case's traffic
 * belongs to. A canary that serves the replacement to a tenant whose
 * cases lie OUTSIDE the granted slice FAILs the slice isolation with
 * the tenant named.
 */
export function canaryTenantIdOf(caseId: string): string {
  let sum = 0;
  for (const character of caseId) {
    sum += character.charCodeAt(0);
  }
  return `tenant-${sum % 4}`;
}

// ---------------------------------------------------------------------------
// The decision / divergence / rollback / cost record shapes
// ---------------------------------------------------------------------------

/**
 * ONE recorded canary decision (the append-only canary-decision
 * ledger's record): the step, the decision kind, the observed
 * divergence count against the budget limit, the policy CITATIONS
 * (the ramp schedule digest, the stated budget, the stated tolerance)
 * and the policy CHECKS (the legs the decision actually checked).
 * Every leg is cross-checked mechanically — never trusted.
 */
export interface CanaryDecisionRecord {
  readonly proposalId: string;
  readonly stepIndex: number;
  readonly kind: CanaryDecisionKind;
  /** The pinned slice fraction the step served. */
  readonly sliceFraction: number;
  /** The MECHANICALLY observed divergence count at this step. */
  readonly observedDivergenceCount: number;
  /** The pinned failure-budget limit the decision was judged against. */
  readonly budgetLimit: number;
  /** The policy citations (an empty digest / false = the item was UNSTATED). */
  readonly policyCitations: {
    readonly rampScheduleDigest: string;
    readonly failureBudgetStated: boolean;
    readonly toleranceStated: boolean;
  };
  /** The policy checks (false = the item was stated but NEVER checked). */
  readonly policyChecks: {
    readonly rampChecked: boolean;
    readonly budgetChecked: boolean;
    readonly toleranceChecked: boolean;
  };
  /** 1-based append order within the candidate's decision ledger. */
  readonly ordinal: number;
}

/** The canonical digest over one canary decision (PURE, payload-free). */
export function canaryDecisionDigestOf(record: Omit<CanaryDecisionRecord, "ordinal">): string {
  return longitudinalDigestOf([
    "canary-decision",
    record.proposalId,
    record.stepIndex,
    record.kind,
    record.sliceFraction,
    record.observedDivergenceCount,
    record.budgetLimit,
    record.policyCitations.rampScheduleDigest,
    record.policyCitations.failureBudgetStated,
    record.policyCitations.toleranceStated,
    record.policyChecks.rampChecked,
    record.policyChecks.budgetChecked,
    record.policyChecks.toleranceChecked,
  ]);
}

/**
 * ONE recorded canary divergence (the append-only divergence ledger's
 * record): the step, the case id and BOTH sides' outcome digests —
 * recorded case-by-case, never smoothed, never aggregated away.
 */
export interface CanaryDivergenceRecord {
  readonly proposalId: string;
  readonly stepIndex: number;
  readonly caseId: string;
  readonly incumbentDigest: string;
  readonly replacementDigest: string;
  /** 1-based append order within the candidate's divergence ledger. */
  readonly ordinal: number;
}

/** The canonical digest over one canary divergence record (PURE, payload-free). */
export function canaryDivergenceDigestOf(record: Omit<CanaryDivergenceRecord, "ordinal">): string {
  return longitudinalDigestOf([
    "canary-divergence",
    record.proposalId,
    record.stepIndex,
    record.caseId,
    record.incumbentDigest,
    record.replacementDigest,
  ]);
}

/**
 * The recorded ROLLBACK PLAN (the reversibility contract's record —
 * recorded on EVERY canary run, exercised on every breach and on
 * demand for the reversal probe): the served traffic reverts to the
 * incumbent across the WHOLE slice. The plan is a record, never a
 * promise: an unexercised plan on a demanded rollback FAILs the
 * rollback completeness mechanically.
 */
export interface RollbackPlanRecord {
  readonly proposalId: string;
  /** The serving reverts to the incumbent — the previous execution plan. */
  readonly revertsServingTo: "incumbent";
  /** The plan's scope: the WHOLE canary slice (1 — never a partial scope). */
  readonly scopeFraction: number;
}

/** The canonical digest over a rollback plan (PURE, payload-free). */
export function rollbackPlanDigestOf(plan: Omit<RollbackPlanRecord, never>): string {
  return longitudinalDigestOf([
    "canary-rollback-plan",
    plan.proposalId,
    plan.revertsServingTo,
    plan.scopeFraction,
  ]);
}

/**
 * ONE recorded rollback event (the append-only rollback-event
 * ledger's record — the EXERCISE of the plan): the step that breached,
 * the exercised plan's digest and the residual replacement serve the
 * exercise observed (0 cases = the complete mechanical revert).
 */
export interface RollbackEventRecord {
  readonly proposalId: string;
  readonly stepIndex: number;
  readonly planDigest: string;
  /** The cases STILL serving the replacement after the revert (empty = complete). */
  readonly residualReplacementCaseIds: readonly string[];
  /** 1-based append order within the candidate's rollback-event ledger. */
  readonly ordinal: number;
}

/** The canonical digest over one rollback event (PURE, payload-free). */
export function rollbackEventDigestOf(record: Omit<RollbackEventRecord, "ordinal">): string {
  return longitudinalDigestOf([
    "canary-rollback-event",
    record.proposalId,
    record.stepIndex,
    record.planDigest,
    record.residualReplacementCaseIds,
  ]);
}

/**
 * The canary's OWN measured cost + latency (measured SEPARATELY from
 * the served accounting — the canary-cost measurement shape). The
 * customer is never billed for these; they book to the canary cost
 * ledger under the canary marker.
 */
export interface CanaryCostMeasurement {
  readonly microUsd: number;
  readonly latencyMs: number;
}

/** The CANARY MARKER: the booking marker every canary cost entry carries. */
export const CANARY_COST_MARKER = "canary" as const;

/** ONE booked canary-cost ledger entry (the append-only canary cost ledger). */
export interface CanaryCostLedgerEntry {
  readonly proposalId: string;
  /** The canary marker — the cost's APART booking basis (never the served rails). */
  readonly marker: "canary";
  readonly microUsd: number;
  readonly latencyMs: number;
  /** 1-based append order within the candidate's cost ledger. */
  readonly ordinal: number;
}

/** The canonical digest over one canary-cost ledger entry (PURE, payload-free). */
export function canaryCostDigestOf(entry: Omit<CanaryCostLedgerEntry, "ordinal">): string {
  return longitudinalDigestOf([
    "canary-cost",
    entry.proposalId,
    entry.marker,
    entry.microUsd,
    entry.latencyMs,
  ]);
}

/**
 * The canonical digest over one ramp step's slice serve (PURE,
 * payload-free): the trajectory's per-step slice digest — a pure
 * function of the candidate, the step and the deterministic slice
 * membership.
 */
export function canarySliceDigestOf(input: {
  readonly proposalId: string;
  readonly stepIndex: number;
  readonly sliceCaseIds: readonly string[];
}): string {
  return longitudinalDigestOf([
    "canary-slice-served",
    input.proposalId,
    input.stepIndex,
    input.sliceCaseIds,
  ]);
}

/** The served accounting's snapshot (the customer-facing bill basis). */
export interface ServedAccountingSnapshot {
  /** The incumbent's own measured cost (the honest served basis). */
  readonly incumbentMicroUsd: number;
  /** What the served accounting bills in total (must equal the incumbent basis). */
  readonly billedMicroUsd: number;
  readonly latencyMs: number;
}

// ---------------------------------------------------------------------------
// The serving observation shapes (the slice serve + the revert)
// ---------------------------------------------------------------------------

/**
 * ONE customer-facing served outcome during the canary (the
 * slice-isolation basis): the step, the case id, the outcome's SOURCE
 * (`incumbent` or `replacement`) and the served digest. Pre-promotion
 * a `replacement` source is legal ONLY inside the step's granted
 * slice; post-promotion the full traffic may serve the replacement.
 */
export interface CanaryServedOutcome {
  readonly stepIndex: number;
  readonly caseId: string;
  readonly servedSource: string;
  readonly servedDigest: string;
}

// ---------------------------------------------------------------------------
// Policy explicitness (every decision cites its stated-and-checked policy)
// ---------------------------------------------------------------------------

/** One decision's policy legs as the ledger recorded them. */
export interface CanaryDecisionPolicyLeg {
  readonly stepIndex: number;
  readonly citations: {
    readonly rampScheduleDigest: string;
    readonly failureBudgetStated: boolean;
    readonly toleranceStated: boolean;
  };
  readonly checks: {
    readonly rampChecked: boolean;
    readonly budgetChecked: boolean;
    readonly toleranceChecked: boolean;
  };
}

/** The canary policy-explicitness verdict. */
export interface CanaryPolicyExplicitnessVerdict {
  /** Every step's decision cites its stated-and-checked policy over a well-formed ramp. */
  readonly explicit: boolean;
  /** The ramp schedule's well-formedness (increasing fractions ending at full traffic). */
  readonly rampScheduleWellFormed: boolean;
  /** The canonical digest over the stated ramp schedule (null when unstated). */
  readonly scheduleDigest: string | null;
  /** The policy items that were UNSTATED (named per step). */
  readonly unstatedItems: readonly string[];
  /** The policy items that were stated but NEVER checked (named per step). */
  readonly uncheckedItems: readonly string[];
  /** Schedule steps that hold no decision at all (a step skipped its policy). */
  readonly decisionlessStepIndexes: readonly number[];
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the canary policy explicitness (PURE — the governed ramp's
 * first oracle): every canary step's decision must cite its policy —
 * the RAMP SCHEDULE, the FAILURE BUDGET and the DIVERGENCE TOLERANCE
 * stated AND checked. An UNSTATED item (a decision whose citation for
 * the ramp schedule is empty, or whose budget/tolerance legs were
 * never stated) FAILs with the item named; a stated-but-UNCHECKED item
 * (a decision that never checked the served slice against the ramp,
 * never compared the observed divergence count against the budget, or
 * never evaluated the tolerance per case) FAILs just the same; a ramp
 * schedule that is malformed (fractions not strictly increasing, out
 * of (0, 1], or not ending at the full-traffic step) FAILs; and every
 * executed schedule step must hold exactly one decision (a step
 * without its decision is a policy the run never stated).
 */
export function deriveCanaryPolicyExplicitness(input: {
  /** The run's stated ramp schedule (null = the ramp was never stated). */
  readonly rampSchedule: readonly RampStep[] | null;
  /** The run's stated failure budget (null = never stated). */
  readonly failureBudget: FailureBudget | null;
  /** The run's stated divergence tolerance (null = never stated). */
  readonly tolerance: AcceptanceCriterion | null;
  /** The decisions' policy legs, in append order. */
  readonly decisions: readonly CanaryDecisionPolicyLeg[];
  /** The schedule steps the run actually executed (empty on a run-level refusal). */
  readonly executedStepIndexes: readonly number[];
}): CanaryPolicyExplicitnessVerdict {
  const schedule = input.rampSchedule ?? [];
  const rampScheduleWellFormed = input.rampSchedule !== null && isRampScheduleWellFormed(schedule);
  const scheduleDigest =
    input.rampSchedule !== null && schedule.length > 0 ? rampScheduleDigestOf(schedule) : null;
  const expectedScheduleDigest = rampScheduleDigestOf(schedule);

  const unstatedItems: string[] = [];
  const uncheckedItems: string[] = [];
  if (input.rampSchedule === null) {
    unstatedItems.push("ramp-schedule");
  }
  if (input.failureBudget === null) {
    unstatedItems.push("failure-budget");
  }
  if (input.tolerance === null) {
    unstatedItems.push("divergence-tolerance");
  }

  for (const decision of input.decisions) {
    const step = `step-${decision.stepIndex}`;
    if (decision.citations.rampScheduleDigest.length === 0) {
      unstatedItems.push(`${step}:ramp-schedule`);
    } else if (
      scheduleDigest !== null &&
      decision.citations.rampScheduleDigest !== scheduleDigest
    ) {
      unstatedItems.push(`${step}:ramp-schedule-digest-mismatch`);
    }
    if (!decision.citations.failureBudgetStated) {
      unstatedItems.push(`${step}:failure-budget`);
    }
    if (!decision.citations.toleranceStated) {
      unstatedItems.push(`${step}:divergence-tolerance`);
    }
    if (!decision.checks.rampChecked) {
      uncheckedItems.push(`${step}:ramp-schedule`);
    }
    if (!decision.checks.budgetChecked) {
      uncheckedItems.push(`${step}:failure-budget`);
    }
    if (!decision.checks.toleranceChecked) {
      uncheckedItems.push(`${step}:divergence-tolerance`);
    }
  }

  const executed = [...input.executedStepIndexes];
  const decisionSteps = new Set(input.decisions.map((decision) => decision.stepIndex));
  const decisionlessStepIndexes = executed.filter((stepIndex) => !decisionSteps.has(stepIndex));

  const explicit =
    rampScheduleWellFormed &&
    unstatedItems.length === 0 &&
    uncheckedItems.length === 0 &&
    decisionlessStepIndexes.length === 0;

  return {
    explicit,
    rampScheduleWellFormed,
    scheduleDigest,
    unstatedItems,
    uncheckedItems,
    decisionlessStepIndexes,
    criteria: [
      {
        criterionId: "policy-ramp-schedule-well-formed",
        strategy: "deterministic",
        status: rampScheduleWellFormed ? "PASS" : "FAIL",
        evidence: [
          `steps:${schedule.map((step) => step.trafficFraction).join("→") || "none"}`,
          `scheduleDigest:${expectedScheduleDigest}`,
          rampScheduleWellFormed
            ? "the-ramp-schedule-is-well-formed (fractions strictly increasing in (0, 1], ending at the full-traffic step)"
            : "MALFORMED-RAMP (the ramp schedule's fractions are not strictly increasing in (0, 1], or the schedule does not end at the full-traffic step)",
        ],
      },
      {
        criterionId: "policy-every-item-stated",
        strategy: "deterministic",
        status: unstatedItems.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `decisions:${input.decisions.length}`,
          `unstatedItems:${unstatedItems.join(",") || "none"}`,
          unstatedItems.length === 0
            ? "every-canary-decision-cites-its-stated-ramp-budget-and-tolerance"
            : `UNSTATED-POLICY (a canary decision was made without its stated policy: ${unstatedItems.join(",")})`,
        ],
      },
      {
        criterionId: "policy-every-item-checked",
        strategy: "deterministic",
        status: uncheckedItems.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `uncheckedItems:${uncheckedItems.join(",") || "none"}`,
          uncheckedItems.length === 0
            ? "every-stated-policy-item-was-checked (the served slice against the ramp, the observed count against the budget, the tolerance per case)"
            : `UNCHECKED-POLICY (a stated policy item was never checked: ${uncheckedItems.join(",")})`,
        ],
      },
      {
        criterionId: "policy-every-executed-step-decided",
        strategy: "deterministic",
        status: decisionlessStepIndexes.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `executedSteps:${executed.join(",") || "none"}`,
          `decisionlessStepIndexes:${decisionlessStepIndexes.join(",") || "none"}`,
          decisionlessStepIndexes.length === 0
            ? "every-executed-ramp-step-holds-its-decision"
            : "DECISIONLESS-STEP (an executed ramp step recorded no decision — its policy was never stated)",
        ],
      },
      {
        criterionId: "policy-explicitness-summary",
        strategy: "deterministic",
        status: explicit ? "PASS" : "FAIL",
        evidence: [
          `explicit:${String(explicit)}`,
          `rampScheduleWellFormed:${String(rampScheduleWellFormed)}`,
          `unstated:${unstatedItems.length}`,
          `unchecked:${uncheckedItems.length}`,
          `decisionless:${decisionlessStepIndexes.length}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Promotion lifecycle completeness (the full evidenced chain, one rung at a time)
// ---------------------------------------------------------------------------

/** The promotion lifecycle-completeness verdict. */
export interface PromotionLifecycleCompletenessVerdict {
  /** The prior walk is the full evidenced chain and the append advances one rung at a time. */
  readonly complete: boolean;
  /** The candidate's recorded walk BEFORE the canary append. */
  readonly priorWalk: readonly CandidateLifecycleStage[];
  /** The stages the canary run appended, in append order. */
  readonly appendedWalk: readonly CandidateLifecycleStage[];
  /** Required prior stages MISSING from the recorded walk (a skipped lifecycle). */
  readonly missingPriorStages: readonly CandidateLifecycleStage[];
  /** Recorded prior stages out of order or foreign to the required chain (a broken walk). */
  readonly brokenWalk: boolean;
  /** Ordinals of prior transitions that landed without evidence. */
  readonly unevidencedPriorOrdinals: readonly number[];
  /** Ordinals of appended transitions that SKIPPED a ladder rung (a jump). */
  readonly jumpedRungOrdinals: readonly number[];
  /** Appended stages that are neither canaried nor promoted (a wrong-stage landing). */
  readonly wrongStageLandings: readonly CandidateLifecycleStage[];
  /** Appended stages landing past the promoted stage (the final stage). */
  readonly beyondFinalStages: readonly CandidateLifecycleStage[];
  /** Ordinals of appended transitions that landed without evidence. */
  readonly unevidencedAppendedOrdinals: readonly number[];
  /** Whether the appended walk matches the expected landing shape. */
  readonly landingMatches: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the promotion lifecycle completeness (PURE — the ladder's
 * promotion oracle): the candidate's RECORDED walk must be the FULL
 * evidenced chain `offline-replayed → differentially-evaluated →
 * shadow-executed` before the canary (a SKIPPED stage, a BROKEN walk
 * or an UNEVIDENCED transition FAILs — the candidate must have earned
 * every rung), and the canary advances `shadow-executed → canaried →
 * promoted` ONE evidenced rung at a time: every appended transition
 * must advance exactly one ladder rung from its predecessor (a JUMP —
 * a promoted append without the canaried rung — FAILs), must land at
 * `canaried` or `promoted` only (never past the FINAL stage, never at
 * a foreign stage), and must carry its evidence digest.
 */
export function derivePromotionLifecycleCompleteness(input: {
  /** The ledger's recorded transitions for the candidate BEFORE the canary append. */
  readonly priorTransitions: readonly LifecycleTransitionRecord[];
  /** The transitions the canary run appended, in append order. */
  readonly appendedTransitions: readonly LifecycleTransitionRecord[];
  /** The run's expected landing: promoted (clean), canaried (rollback), or none (refusal). */
  readonly expectedLanding: "promoted" | "canaried" | "none";
}): PromotionLifecycleCompletenessVerdict {
  const priorWalk = input.priorTransitions.map((transition) => transition.toStage);
  const appendedWalk = input.appendedTransitions.map((transition) => transition.toStage);
  const required = [...CANARY_REQUIRED_PRIOR_WALK];

  const missingPriorStages = required.filter((stage) => !priorWalk.includes(stage));
  const brokenWalk = !(
    priorWalk.length === required.length &&
    priorWalk.every((stage, index) => stage === required[index])
  );
  const unevidencedPriorOrdinals = input.priorTransitions
    .filter((transition) => (transition.evidenceDigest ?? "").length === 0)
    .map((transition) => transition.ordinal);

  const sourceIndex = canaryLifecycleStageIndexOf(CANARY_SOURCE_STAGE);
  const jumpedRungOrdinals: number[] = [];
  const wrongStageLandings: CandidateLifecycleStage[] = [];
  const beyondFinalStages: CandidateLifecycleStage[] = [];
  const legalLandings: CandidateLifecycleStage[] = [CANARY_STAGE, PROMOTED_STAGE];
  for (let index = 0; index < input.appendedTransitions.length; index += 1) {
    const transition = input.appendedTransitions[index];
    if (transition === undefined) {
      continue;
    }
    const expectedStageIndex = sourceIndex + index + 1;
    const stageIndex = canaryLifecycleStageIndexOf(transition.toStage);
    if (stageIndex !== expectedStageIndex) {
      jumpedRungOrdinals.push(transition.ordinal);
    }
    if (!legalLandings.includes(transition.toStage)) {
      wrongStageLandings.push(transition.toStage);
    }
    if (isBeyondPromotionScope(transition.toStage)) {
      beyondFinalStages.push(transition.toStage);
    }
  }
  const unevidencedAppendedOrdinals = input.appendedTransitions
    .filter((transition) => (transition.evidenceDigest ?? "").length === 0)
    .map((transition) => transition.ordinal);

  const expectedAppendedWalk: CandidateLifecycleStage[] =
    input.expectedLanding === "promoted"
      ? [CANARY_STAGE, PROMOTED_STAGE]
      : input.expectedLanding === "canaried"
        ? [CANARY_STAGE]
        : [];
  const landingMatches =
    appendedWalk.length === expectedAppendedWalk.length &&
    appendedWalk.every((stage, index) => stage === expectedAppendedWalk[index]);

  const complete =
    missingPriorStages.length === 0 &&
    !brokenWalk &&
    unevidencedPriorOrdinals.length === 0 &&
    jumpedRungOrdinals.length === 0 &&
    wrongStageLandings.length === 0 &&
    beyondFinalStages.length === 0 &&
    unevidencedAppendedOrdinals.length === 0 &&
    landingMatches;

  return {
    complete,
    priorWalk,
    appendedWalk,
    missingPriorStages,
    brokenWalk,
    unevidencedPriorOrdinals,
    jumpedRungOrdinals,
    wrongStageLandings,
    beyondFinalStages,
    unevidencedAppendedOrdinals,
    landingMatches,
    criteria: [
      {
        criterionId: "lifecycle-prior-walk-complete",
        strategy: "deterministic",
        status: missingPriorStages.length === 0 && !brokenWalk ? "PASS" : "FAIL",
        evidence: [
          `priorWalk:${priorWalk.join("→") || "none"}`,
          `requiredWalk:${required.join("→")}`,
          `missingPriorStages:${missingPriorStages.join(",") || "none"}`,
          missingPriorStages.length === 0 && !brokenWalk
            ? "the-candidates-recorded-walk-is-the-full-evidenced-chain-to-shadow-executed (the read-only input)"
            : "SKIPPED-LIFECYCLE (the candidate's recorded walk skipped or broke the required chain — a promotion without its earned rungs never passes)",
        ],
      },
      {
        criterionId: "lifecycle-prior-transitions-evidenced",
        strategy: "deterministic",
        status: unevidencedPriorOrdinals.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `priorTransitions:${input.priorTransitions.length}`,
          `unevidencedPriorOrdinals:${unevidencedPriorOrdinals.join(",") || "none"}`,
          unevidencedPriorOrdinals.length === 0
            ? "every-prior-transition-carries-its-evidence-digest"
            : "UNEVIDENCED-PRIOR-TRANSITION (a prior lifecycle transition landed without its evidence)",
        ],
      },
      {
        criterionId: "lifecycle-one-rung-at-a-time",
        strategy: "deterministic",
        status: jumpedRungOrdinals.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `appendedWalk:${appendedWalk.join("→") || "none"}`,
          `jumpedRungOrdinals:${jumpedRungOrdinals.join(",") || "none"}`,
          jumpedRungOrdinals.length === 0
            ? "the-canary-advances-one-evidenced-rung-at-a-time (shadow-executed → canaried → promoted)"
            : "JUMPED-RUNG (a lifecycle append skipped a rung — a promoted landing without the canaried rung never passes)",
        ],
      },
      {
        criterionId: "lifecycle-landing-stages-legal",
        strategy: "deterministic",
        status: wrongStageLandings.length === 0 && beyondFinalStages.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `wrongStageLandings:${wrongStageLandings.join(",") || "none"}`,
          `beyondFinalStages:${beyondFinalStages.join(",") || "none"}`,
          `finalStage:${PROMOTED_STAGE}`,
          wrongStageLandings.length === 0 && beyondFinalStages.length === 0
            ? "every-appended-transition-lands-at-canaried-or-promoted (promoted-is-the-final-stage)"
            : "ILLEGAL-LANDING (an append landed at a foreign stage or past the final promoted stage)",
        ],
      },
      {
        criterionId: "lifecycle-appended-transitions-evidenced",
        strategy: "deterministic",
        status: unevidencedAppendedOrdinals.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `appendedTransitions:${input.appendedTransitions.length}`,
          `unevidencedAppendedOrdinals:${unevidencedAppendedOrdinals.join(",") || "none"}`,
          unevidencedAppendedOrdinals.length === 0
            ? "every-appended-transition-carries-its-evidence-digest"
            : "UNEVIDENCED-APPEND (a canary/promoted transition without its evidence FAILs)",
        ],
      },
      {
        criterionId: "lifecycle-landing-shape",
        strategy: "deterministic",
        status: landingMatches ? "PASS" : "FAIL",
        evidence: [
          `expectedLanding:${input.expectedLanding}`,
          `expectedAppendedWalk:${expectedAppendedWalk.join("→") || "none"}`,
          `appendedWalk:${appendedWalk.join("→") || "none"}`,
          landingMatches
            ? "the-ledger-holds-exactly-the-recorded-walk-plus-the-expected-canary-append"
            : "LANDING-MISMATCH (the appended walk differs from the expected landing shape)",
        ],
      },
      {
        criterionId: "lifecycle-completeness-summary",
        strategy: "deterministic",
        status: complete ? "PASS" : "FAIL",
        evidence: [
          `complete:${String(complete)}`,
          `missingPrior:${missingPriorStages.length}`,
          `jumpedRungs:${jumpedRungOrdinals.length}`,
          `unevidencedAppended:${unevidencedAppendedOrdinals.length}`,
          `landingMatches:${String(landingMatches)}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Breach honesty (within budget advances; beyond budget rolls back)
// ---------------------------------------------------------------------------

/** One step's breach legs as the run recorded them. */
export interface CanaryBreachLeg {
  readonly stepIndex: number;
  /** The pinned failure-budget limit for the step. */
  readonly budgetLimit: number;
  /** The MECHANICALLY evaluated divergent case ids at this step. */
  readonly mechanicalDivergenceCaseIds: readonly string[];
  /** The divergent case ids the run's divergence ledger actually recorded. */
  readonly recordedDivergenceCaseIds: readonly string[];
  /** The decision the step took (null = no decision was recorded). */
  readonly decisionKind: CanaryDecisionKind | null;
  /** The divergence count the decision ASSERTED (null = none asserted). */
  readonly assertedDivergenceCount: number | null;
  /** Whether the rollback was actually triggered for this step. */
  readonly rollbackTriggered: boolean;
}

/** The breach-honesty verdict. */
export interface BreachHonestyVerdict {
  /** Every step's decision is the honest judgment of its observed divergence count. */
  readonly honest: boolean;
  /** The steps whose observed divergence count exceeded the pinned budget. */
  readonly breachingStepIndexes: readonly number[];
  /** Breaching steps that ADVANCED anyway (a smoothed breach). */
  readonly smoothedBreachStepIndexes: readonly number[];
  /** Steps whose asserted count contradicts the per-case record (a smoothed count). */
  readonly countSmoothedStepIndexes: readonly number[];
  /** Within-budget steps that rolled back anyway (an unjustified rollback). */
  readonly unjustifiedRollbackStepIndexes: readonly number[];
  /** Breach-rollback decisions whose rollback was never triggered. */
  readonly uncontrolledRollbackStepIndexes: readonly number[];
  /** Steps whose recorded divergence ledger contradicts the mechanical record. */
  readonly recordMismatchStepIndexes: readonly number[];
  /** Steps that recorded no decision at all. */
  readonly missingDecisionStepIndexes: readonly number[];
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the breach honesty (PURE — the governed ramp's evidence
 * oracle): a step whose observed divergence count is WITHIN its pinned
 * failure budget advances honestly (a within-budget step that rolls
 * back anyway FAILs as an unjustified rollback); a step whose observed
 * count is BEYOND the budget FAILs and the decision MUST be
 * breach-rollback — a smoothed breach that advances FAILs, a
 * breach-rollback decision without the actual rollback trigger FAILs,
 * and an asserted count that contradicts the per-case record (the
 * divergence ledger's own record) FAILs just the same: every divergence
 * is recorded case-by-case, never smoothed, never aggregated away.
 */
export function deriveBreachHonesty(input: {
  readonly steps: readonly CanaryBreachLeg[];
}): BreachHonestyVerdict {
  const breachingStepIndexes: number[] = [];
  const smoothedBreachStepIndexes: number[] = [];
  const countSmoothedStepIndexes: number[] = [];
  const unjustifiedRollbackStepIndexes: number[] = [];
  const uncontrolledRollbackStepIndexes: number[] = [];
  const recordMismatchStepIndexes: number[] = [];
  const missingDecisionStepIndexes: number[] = [];

  for (const step of input.steps) {
    const mechanicalCount = step.mechanicalDivergenceCaseIds.length;
    const withinBudget = mechanicalCount <= step.budgetLimit;
    if (!withinBudget) {
      breachingStepIndexes.push(step.stepIndex);
    }
    if (step.decisionKind === null) {
      missingDecisionStepIndexes.push(step.stepIndex);
      continue;
    }
    if (step.assertedDivergenceCount !== null && step.assertedDivergenceCount !== mechanicalCount) {
      countSmoothedStepIndexes.push(step.stepIndex);
    }
    const recordedMatches =
      [...step.recordedDivergenceCaseIds].join(",") ===
      [...step.mechanicalDivergenceCaseIds].join(",");
    if (!recordedMatches) {
      recordMismatchStepIndexes.push(step.stepIndex);
    }
    if (withinBudget) {
      if (step.decisionKind !== "advance") {
        unjustifiedRollbackStepIndexes.push(step.stepIndex);
      }
    } else {
      if (step.decisionKind === "advance") {
        smoothedBreachStepIndexes.push(step.stepIndex);
      }
      if (step.decisionKind === "breach-rollback" && !step.rollbackTriggered) {
        uncontrolledRollbackStepIndexes.push(step.stepIndex);
      }
      if (step.decisionKind === "refuse") {
        unjustifiedRollbackStepIndexes.push(step.stepIndex);
      }
    }
  }

  const honest =
    smoothedBreachStepIndexes.length === 0 &&
    countSmoothedStepIndexes.length === 0 &&
    unjustifiedRollbackStepIndexes.length === 0 &&
    uncontrolledRollbackStepIndexes.length === 0 &&
    recordMismatchStepIndexes.length === 0 &&
    missingDecisionStepIndexes.length === 0;

  return {
    honest,
    breachingStepIndexes,
    smoothedBreachStepIndexes,
    countSmoothedStepIndexes,
    unjustifiedRollbackStepIndexes,
    uncontrolledRollbackStepIndexes,
    recordMismatchStepIndexes,
    missingDecisionStepIndexes,
    criteria: [
      {
        criterionId: "breach-within-budget-advances",
        strategy: "deterministic",
        status: unjustifiedRollbackStepIndexes.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `steps:${input.steps.length}`,
          `unjustifiedRollbackStepIndexes:${unjustifiedRollbackStepIndexes.join(",") || "none"}`,
          unjustifiedRollbackStepIndexes.length === 0
            ? "every-within-budget-step-advanced-honestly (a rollback needs its breach trigger)"
            : "UNJUSTIFIED-ROLLBACK (a within-budget step rolled back anyway — the breach trigger was absent)",
        ],
      },
      {
        criterionId: "breach-beyond-budget-rolls-back",
        strategy: "deterministic",
        status:
          smoothedBreachStepIndexes.length === 0 && uncontrolledRollbackStepIndexes.length === 0
            ? "PASS"
            : "FAIL",
        evidence: [
          `breachingStepIndexes:${breachingStepIndexes.join(",") || "none"}`,
          `smoothedBreachStepIndexes:${smoothedBreachStepIndexes.join(",") || "none"}`,
          `uncontrolledRollbackStepIndexes:${uncontrolledRollbackStepIndexes.join(",") || "none"}`,
          smoothedBreachStepIndexes.length === 0 && uncontrolledRollbackStepIndexes.length === 0
            ? "every-beyond-budget-step-failed-and-rolled-back (the decision is the honest judgment of the observed count)"
            : "SMOOTHED-BREACH (a divergence count beyond the pinned budget advanced anyway, or a breach-rollback decision never triggered its rollback)",
        ],
      },
      {
        criterionId: "breach-count-never-smoothed",
        strategy: "deterministic",
        status:
          countSmoothedStepIndexes.length === 0 && recordMismatchStepIndexes.length === 0
            ? "PASS"
            : "FAIL",
        evidence: [
          `countSmoothedStepIndexes:${countSmoothedStepIndexes.join(",") || "none"}`,
          `recordMismatchStepIndexes:${recordMismatchStepIndexes.join(",") || "none"}`,
          countSmoothedStepIndexes.length === 0 && recordMismatchStepIndexes.length === 0
            ? "every-divergence-recorded-case-by-case (the asserted count matches the per-case record)"
            : "SMOOTHED-COUNT (an asserted divergence count contradicts the per-case record — never smoothed, never aggregated away)",
        ],
      },
      {
        criterionId: "breach-every-step-decided",
        strategy: "deterministic",
        status: missingDecisionStepIndexes.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `missingDecisionStepIndexes:${missingDecisionStepIndexes.join(",") || "none"}`,
          missingDecisionStepIndexes.length === 0
            ? "every-executed-step-recorded-its-decision"
            : "MISSING-DECISION (an executed step recorded no decision)",
        ],
      },
      {
        criterionId: "breach-observed-beyond-budget",
        strategy: "deterministic",
        status: breachingStepIndexes.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `breachingStepIndexes:${breachingStepIndexes.join(",") || "none"}`,
          breachingStepIndexes.length === 0
            ? "no-step-observed-a-divergence-count-beyond-its-pinned-budget"
            : `HONEST-BREACH (steps ${breachingStepIndexes.join(",")} observed divergence counts beyond their pinned budgets — the steps FAIL honestly and the run rolls back)`,
        ],
      },
      {
        criterionId: "breach-honesty-summary",
        strategy: "deterministic",
        status: honest ? "PASS" : "FAIL",
        evidence: [
          `honest:${String(honest)}`,
          `breaching:${breachingStepIndexes.length}`,
          `smoothedBreach:${smoothedBreachStepIndexes.length}`,
          `countSmoothed:${countSmoothedStepIndexes.length}`,
          `unjustified:${unjustifiedRollbackStepIndexes.length}`,
          `uncontrolled:${uncontrolledRollbackStepIndexes.length}`,
          `recordMismatch:${recordMismatchStepIndexes.length}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Rollback completeness (complete, mechanical, exercised)
// ---------------------------------------------------------------------------

/** The rollback-completeness verdict. */
export interface RollbackCompletenessVerdict {
  /** The rollback (when demanded) is complete, mechanical and exercised. */
  readonly complete: boolean;
  /** Whether the run recorded its rollback plan (the reversibility contract). */
  readonly planRecorded: boolean;
  /** Whether a rollback was demanded (a breach occurred during the run). */
  readonly rollbackDemanded: boolean;
  /** Whether the demanded rollback was actually EXERCISED. */
  readonly rollbackExercised: boolean;
  /** The cases still serving the replacement after the revert (the residual). */
  readonly residualReplacementCaseIds: readonly string[];
  /** The rollback events recorded without a demanded rollback (unjustified events). */
  readonly unjustifiedEventOrdinals: readonly number[];
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the rollback completeness (PURE — the reversibility
 * oracle): when a breach demanded the rollback, the plan must have
 * been RECORDED and EXERCISED (an unevidenced rollback plan — a
 * demanded rollback whose plan was never exercised — FAILs), and the
 * revert must be COMPLETE and mechanical: the served traffic reverts
 * to the incumbent across the WHOLE slice (a partial rollback that
 * leaves ANY fraction serving the replacement FAILs, naming the
 * residual). When no breach demanded a rollback, a recorded plan alone
 * is the reversibility contract's honest state (exercised on demand
 * by the reversal probe) — but a rollback EVENT without its demanded
 * breach FAILs as an unjustified rollback.
 */
export function deriveRollbackCompleteness(input: {
  /** Whether a breach demanded the rollback during the run. */
  readonly rollbackDemanded: boolean;
  /** Whether the run recorded its rollback plan. */
  readonly planRecorded: boolean;
  /** The recorded rollback events (each with its residual serve), in append order. */
  readonly rollbackEvents: readonly {
    readonly ordinal: number;
    readonly stepIndex: number;
    readonly residualReplacementCaseIds: readonly string[];
  }[];
  /** The granted slice's case ids at the breach (the revert's whole scope). */
  readonly sliceCaseIdsAtBreach: readonly string[];
}): RollbackCompletenessVerdict {
  const rollbackExercised = input.rollbackEvents.length > 0;
  const residualReplacementCaseIds = input.rollbackEvents.flatMap(
    (event) => event.residualReplacementCaseIds,
  );
  const residualWithinSlice = residualReplacementCaseIds.filter((caseId) =>
    input.sliceCaseIdsAtBreach.includes(caseId),
  );
  const unjustifiedEventOrdinals = input.rollbackDemanded
    ? []
    : input.rollbackEvents.map((event) => event.ordinal);

  const complete = input.rollbackDemanded
    ? input.planRecorded &&
      rollbackExercised &&
      residualWithinSlice.length === 0 &&
      unjustifiedEventOrdinals.length === 0
    : input.rollbackEvents.length === 0;

  return {
    complete,
    planRecorded: input.planRecorded,
    rollbackDemanded: input.rollbackDemanded,
    rollbackExercised,
    residualReplacementCaseIds: residualWithinSlice,
    unjustifiedEventOrdinals,
    criteria: [
      {
        criterionId: "rollback-plan-recorded",
        strategy: "deterministic",
        status: input.planRecorded ? "PASS" : "FAIL",
        evidence: [
          `rollbackDemanded:${String(input.rollbackDemanded)}`,
          `planRecorded:${String(input.planRecorded)}`,
          input.planRecorded
            ? "the-rollback-plan-is-recorded (the reversibility contract — revert to the previous execution plan)"
            : "UNRECORDED-PLAN (the run never recorded its rollback plan — production promotion must be reversible)",
        ],
      },
      {
        criterionId: "rollback-plan-exercised",
        strategy: "deterministic",
        status: !input.rollbackDemanded || rollbackExercised ? "PASS" : "FAIL",
        evidence: [
          `rollbackDemanded:${String(input.rollbackDemanded)}`,
          `rollbackEvents:${input.rollbackEvents.length}`,
          !input.rollbackDemanded || rollbackExercised
            ? "the-demanded-rollback-was-exercised (a recorded plan is proven by its exercise)"
            : "UNEVIDENCED-ROLLBACK-PLAN (a breach demanded the rollback but the plan was never exercised)",
        ],
      },
      {
        criterionId: "rollback-complete-mechanical",
        strategy: "deterministic",
        status: residualWithinSlice.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `sliceCaseIds:${input.sliceCaseIdsAtBreach.length}`,
          `residualReplacementCaseIds:${residualWithinSlice.join(",") || "none"}`,
          residualWithinSlice.length === 0
            ? "the-served-traffic-reverted-to-the-incumbent-across-the-whole-slice (complete and mechanical)"
            : `PARTIAL-ROLLBACK (cases still serving the replacement after the revert: ${residualWithinSlice.join(",")})`,
        ],
      },
      {
        criterionId: "rollback-events-justified",
        strategy: "deterministic",
        status: unjustifiedEventOrdinals.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `unjustifiedEventOrdinals:${unjustifiedEventOrdinals.join(",") || "none"}`,
          unjustifiedEventOrdinals.length === 0
            ? "every-rollback-event-has-its-demanded-breach"
            : "UNJUSTIFIED-ROLLBACK-EVENT (a rollback event was recorded without its demanded breach)",
        ],
      },
      {
        criterionId: "rollback-completeness-summary",
        strategy: "deterministic",
        status: complete ? "PASS" : "FAIL",
        evidence: [
          `complete:${String(complete)}`,
          `rollbackDemanded:${String(input.rollbackDemanded)}`,
          `rollbackExercised:${String(rollbackExercised)}`,
          `residual:${residualWithinSlice.length}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Slice isolation (the unpromoted candidate serves ONLY its slice)
// ---------------------------------------------------------------------------

/** One step's slice-serve observation as the serving path recorded it. */
export interface CanarySliceServeStep {
  readonly stepIndex: number;
  /** The step's pinned traffic fraction. */
  readonly pinnedFraction: number;
  /** The full traffic population's case ids the step served against. */
  readonly populationCaseIds: readonly string[];
  /** The cases the step actually served the REPLACEMENT. */
  readonly servedReplacementCaseIds: readonly string[];
  /** The tenants the step actually served the replacement to. */
  readonly servedReplacementTenantIds: readonly string[];
}

/** The slice-isolation verdict. */
export interface SliceIsolationVerdict {
  /** The unpromoted candidate never served beyond its slice; the promoted serve is legal. */
  readonly isolated: boolean;
  /** Cases served the replacement BEYOND the pinned slice (flattened, named). */
  readonly overSliceCaseIds: readonly string[];
  /** Tenants served the replacement whose cases lie OUTSIDE the granted slice. */
  readonly outOfSliceTenantIds: readonly string[];
  /** Steps that served FEWER replacement cases than the pinned slice (a ramp-adherence break). */
  readonly underServedStepIndexes: readonly number[];
  /** Whether the post-promotion full serve is legal (only after the promoted rung). */
  readonly postPromotionServeLegal: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the slice isolation (PURE — the governed ramp's serving
 * oracle): an UNPROMOTED candidate serves ONLY its canary slice — at
 * every step the cases served the replacement must be exactly the
 * deterministic membership of the step's pinned fraction (an
 * OVER-SLICE serve — a case beyond the slice served the replacement —
 * FAILs with the case named; an UNDER-SERVE breaks the ramp's pinned
 * adherence and FAILs just the same); a TENANT outside the granted
 * slice served the replacement FAILs with the tenant named; and after
 * the promoted rung lands, the full traffic may serve the replacement
 * (the post-promotion serve is legal — never before).
 */
export function deriveSliceIsolation(input: {
  /** The step-level serve observations (pre-promotion steps). */
  readonly steps: readonly CanarySliceServeStep[];
  /** Whether the candidate's promoted rung had landed for these serves. */
  readonly promoted: boolean;
  /** The post-promotion serve observation (the cases served the replacement after promotion). */
  readonly postPromotionServedReplacementCaseIds: readonly string[] | null;
  /** The full population's case ids (the foreign-serve basis). */
  readonly populationCaseIds: readonly string[];
}): SliceIsolationVerdict {
  const overSliceCaseIds: string[] = [];
  const outOfSliceTenantIds: string[] = [];
  const underServedStepIndexes: number[] = [];

  for (const step of input.steps) {
    const expectedSliceCaseIds = sliceCaseIdsOf(step.populationCaseIds, step.pinnedFraction);
    const served = new Set(step.servedReplacementCaseIds);
    for (const caseId of step.servedReplacementCaseIds) {
      if (!expectedSliceCaseIds.includes(caseId)) {
        overSliceCaseIds.push(`step-${step.stepIndex}:${caseId}`);
      }
    }
    if (!input.promoted && served.size !== expectedSliceCaseIds.length) {
      underServedStepIndexes.push(step.stepIndex);
    }
    const grantedTenantIds = new Set(
      expectedSliceCaseIds.map((caseId) => canaryTenantIdOf(caseId)),
    );
    for (const tenantId of step.servedReplacementTenantIds) {
      if (!grantedTenantIds.has(tenantId)) {
        outOfSliceTenantIds.push(`step-${step.stepIndex}:${tenantId}`);
      }
    }
  }

  const postPromotionForeignCaseIds = (input.postPromotionServedReplacementCaseIds ?? []).filter(
    (caseId) => !input.populationCaseIds.includes(caseId),
  );
  const postPromotionServeLegal =
    input.postPromotionServedReplacementCaseIds === null ||
    postPromotionForeignCaseIds.length === 0;

  const isolated =
    overSliceCaseIds.length === 0 &&
    outOfSliceTenantIds.length === 0 &&
    underServedStepIndexes.length === 0 &&
    postPromotionServeLegal;

  return {
    isolated,
    overSliceCaseIds,
    outOfSliceTenantIds,
    underServedStepIndexes,
    postPromotionServeLegal,
    criteria: [
      {
        criterionId: "slice-no-over-slice-serve",
        strategy: "deterministic",
        status: overSliceCaseIds.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `promoted:${String(input.promoted)}`,
          `overSliceCaseIds:${overSliceCaseIds.join(",") || "none"}`,
          overSliceCaseIds.length === 0
            ? "the-unpromoted-candidate-serves-only-its-canary-slice (each step's serve is its pinned fraction's membership)"
            : `OVER-SLICE (cases served the replacement beyond the step's pinned slice: ${overSliceCaseIds.join(",")})`,
        ],
      },
      {
        criterionId: "slice-no-out-of-slice-tenant",
        strategy: "deterministic",
        status: outOfSliceTenantIds.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `outOfSliceTenantIds:${outOfSliceTenantIds.join(",") || "none"}`,
          outOfSliceTenantIds.length === 0
            ? "no-tenant-outside-the-granted-slice-was-served-the-replacement"
            : `OUT-OF-SLICE-TENANT (tenants outside the granted slice served the replacement: ${outOfSliceTenantIds.join(",")})`,
        ],
      },
      {
        criterionId: "slice-ramp-adherence",
        strategy: "deterministic",
        status: underServedStepIndexes.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `underServedStepIndexes:${underServedStepIndexes.join(",") || "none"}`,
          underServedStepIndexes.length === 0
            ? "every-step-served-exactly-its-pinned-fraction"
            : "RAMP-ADHERENCE (a step served fewer replacement cases than its pinned slice fraction)",
        ],
      },
      {
        criterionId: "slice-post-promotion-serve-legal",
        strategy: "deterministic",
        status: postPromotionServeLegal ? "PASS" : "FAIL",
        evidence: [
          `promoted:${String(input.promoted)}`,
          `postPromotionServed:${input.postPromotionServedReplacementCaseIds?.length ?? "none"}`,
          postPromotionServeLegal
            ? "after-promotion-the-full-traffic-may-serve-the-replacement (never before)"
            : "FOREIGN-POST-PROMOTION-SERVE (the post-promotion serve reached cases outside the population)",
        ],
      },
      {
        criterionId: "slice-isolation-summary",
        strategy: "deterministic",
        status: isolated ? "PASS" : "FAIL",
        evidence: [
          `isolated:${String(isolated)}`,
          `overSlice:${overSliceCaseIds.length}`,
          `outOfSliceTenants:${outOfSliceTenantIds.length}`,
          `underServedSteps:${underServedStepIndexes.length}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Canary cost separation (measured apart, under the canary marker)
// ---------------------------------------------------------------------------

/** The canary cost-separation verdict. */
export interface CanaryCostSeparationVerdict {
  /** The canary cost is measured, booked apart under its marker, and never billed. */
  readonly separated: boolean;
  /** The canary cost billed onto the served rails (the customer billed for the canary). */
  readonly billed: boolean;
  /** The canary cost was never measured. */
  readonly unmeasured: boolean;
  /** The canary cost was never booked to the canary ledger. */
  readonly unbooked: boolean;
  /** The canary cost booking lacks its CANARY marker. */
  readonly markerMissing: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the canary cost separation (PURE — the governed ramp's cost
 * oracle): the canary slice's cost is measured APART from the served
 * accounting and booked to the canary cost ledger UNDER ITS CANARY
 * MARKER — a canary cost billed as ordinary served traffic (the served
 * total inflated beyond the incumbent's own basis) FAILs with the
 * billed delta named, a booking without its canary marker FAILs just
 * the same, and an unmeasured or unbooked canary cost FAILs (the
 * customer is never billed for the canary).
 */
export function deriveCanaryCostSeparation(input: {
  /** The incumbent's own measured served cost (the honest served basis). */
  readonly incumbentCostMicroUsd: number;
  /** The canary's OWN measured cost (null = never measured). */
  readonly canaryCostMicroUsd: number | null;
  /** The served accounting's billed total. */
  readonly servedTotalMicroUsd: number;
  /** The canary ledger's booked total (null = nothing booked). */
  readonly canaryLedgerBookedMicroUsd: number | null;
  /** Whether the booking carries its canary marker (null = nothing booked). */
  readonly canaryMarkerPresent: boolean | null;
}): CanaryCostSeparationVerdict {
  const billedDelta = input.servedTotalMicroUsd - input.incumbentCostMicroUsd;
  const billed = billedDelta > 0;
  const unmeasured = input.canaryCostMicroUsd === null;
  const unbooked = input.canaryLedgerBookedMicroUsd === null;
  const markerMissing =
    input.canaryLedgerBookedMicroUsd !== null && input.canaryMarkerPresent !== true;
  const separated = !billed && !unmeasured && !unbooked && !markerMissing;

  return {
    separated,
    billed,
    unmeasured,
    unbooked,
    markerMissing,
    criteria: [
      {
        criterionId: "canary-cost-never-billed",
        strategy: "deterministic",
        status: billed ? "FAIL" : "PASS",
        evidence: [
          `incumbentBasis:${input.incumbentCostMicroUsd}`,
          `servedTotal:${input.servedTotalMicroUsd}`,
          `billedDelta:${billedDelta}`,
          billed
            ? `BILLED-CANARY (the served accounting bills the canary's cost too — a delta of ${billedDelta} micro-usd — the customer is never billed for the canary)`
            : "the-served-accounting-bills-the-incumbents-own-basis-only",
        ],
      },
      {
        criterionId: "canary-cost-measured",
        strategy: "deterministic",
        status: unmeasured ? "FAIL" : "PASS",
        evidence: [
          `canaryCostMicroUsd:${input.canaryCostMicroUsd ?? "none"}`,
          unmeasured
            ? "UNMEASURED-CANARY (the canary's cost was never measured — honesty demands the measurement)"
            : "the-canary-slice-cost-was-measured",
        ],
      },
      {
        criterionId: "canary-cost-booked-apart",
        strategy: "deterministic",
        status: unbooked ? "FAIL" : "PASS",
        evidence: [
          `canaryLedgerBookedMicroUsd:${input.canaryLedgerBookedMicroUsd ?? "none"}`,
          unbooked
            ? "UNBOOKED-CANARY (the canary's measured cost never booked to the canary ledger)"
            : "the-canary-cost-booked-to-the-canary-ledger-apart-from-the-served-accounting",
        ],
      },
      {
        criterionId: "canary-cost-marker-present",
        strategy: "deterministic",
        status: markerMissing ? "FAIL" : "PASS",
        evidence: [
          `canaryMarkerPresent:${String(input.canaryMarkerPresent)}`,
          `marker:${CANARY_COST_MARKER}`,
          markerMissing
            ? "UNMARKED-CANARY-COST (a canary cost billed as ordinary served traffic without its canary marker — the apart-booking is unattributable)"
            : "the-canary-cost-booking-carries-its-canary-marker (attributable apart from ordinary served traffic)",
        ],
      },
      {
        criterionId: "canary-cost-separation-summary",
        strategy: "deterministic",
        status: separated ? "PASS" : "FAIL",
        evidence: [
          `separated:${String(separated)}`,
          `billed:${String(billed)}`,
          `unmeasured:${String(unmeasured)}`,
          `unbooked:${String(unbooked)}`,
          `markerMissing:${String(markerMissing)}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The honest canary step (the PURE reference runtime)
// ---------------------------------------------------------------------------

/** The canary runtime's per-step outcome (the seam's return shape). */
export interface CanaryStepOutcome {
  readonly stepIndex: number;
  /** The slice's case ids the step drove the replacement over. */
  readonly sliceCaseIds: readonly string[];
  /** The replacement leg's per-case outcomes over the slice (digest + the runtime's own claim). */
  readonly outcomes: readonly {
    readonly caseId: string;
    readonly digest: string;
    readonly claimedAgrees: boolean;
  }[];
  /** The runtime's asserted aggregate divergence claim (cross-checked mechanically). */
  readonly aggregateClaim: {
    readonly assertedDivergenceCount: number;
    readonly assertedWithinBudget: boolean;
  } | null;
  /** The capabilities the runtime observed the replacement exercising mid-canary. */
  readonly exercisedCapabilities: readonly string[];
  /** The candidate id the run cites (null when uncited). */
  readonly citedProposalId: string | null;
  /** The step's own measured canary cost + latency (measured apart; null = unmeasured). */
  readonly canaryCost: CanaryCostMeasurement | null;
}

/**
 * The deterministic REFERENCE canary-cost measurement (the controlled
 * world's honest measurement): a pure function of the step's slice
 * size — the fixture world's measured canary cost + the measured
 * canary latency. The LIVE rail's measurement is REAL and rides the
 * dispatch seam instead.
 */
export function referenceCanaryMeasurementOf(
  sliceCaseIds: readonly string[],
): CanaryCostMeasurement {
  return {
    microUsd: 2 * sliceCaseIds.length + 1,
    latencyMs: 4 * sliceCaseIds.length + 2,
  };
}

/**
 * Derive the HONEST canary step for one ramp step over one traffic
 * population (PURE — the reference runtime): the slice membership is
 * the deterministic function of the pinned fraction, the replacement
 * leg's outcomes are the shape's deterministic reference digests
 * (VAL-033's reference replacement, carried into the canary), the
 * per-case agreement claims are the MECHANICAL tolerance evaluations
 * (never smoothed), the asserted aggregate is the mechanical count
 * judged against the pinned budget, the exercised capabilities are
 * exactly the declaration, the citation is the row's source candidate,
 * and the canary cost is the reference measurement (booked to the
 * canary ledger under the canary marker, never the served rails). The
 * deterministic fixtures pin the adversarial variants (escaping,
 * breaching, smoothing, unmeasured).
 */
export function deriveHonestCanaryStep(input: {
  readonly sourceProposalId: string;
  readonly replacementShape: ReplacementShape;
  readonly declaredCapabilities: readonly string[];
  readonly acceptanceCriterion: AcceptanceCriterion | null;
  readonly trafficPopulation: readonly DifferentialCase[];
  readonly stepIndex: number;
  readonly sliceFraction: number;
  readonly budgetLimit: number;
}): CanaryStepOutcome {
  const sliceCaseIds = sliceCaseIdsOf(
    input.trafficPopulation.map((tcase) => tcase.caseId),
    input.sliceFraction,
  );
  const sliceCases = input.trafficPopulation.filter((tcase) => sliceCaseIds.includes(tcase.caseId));
  const outcomes = sliceCases.map((tcase) => {
    const digest = referenceReplacementOutcomeDigestOf({
      shape: input.replacementShape,
      caseId: tcase.caseId,
      inputDigest: tcase.inputDigest,
      classDigests: tcase.classDigests,
    });
    return {
      caseId: tcase.caseId,
      digest,
      claimedAgrees: criterionSatisfiedForCase({
        dcase: tcase,
        replacementDigest: digest,
        incumbentDigest: tcase.incumbentDigest,
        criterion: input.acceptanceCriterion,
      }),
    };
  });
  const divergences = outcomes.filter((outcome) => !outcome.claimedAgrees);
  return {
    stepIndex: input.stepIndex,
    sliceCaseIds,
    outcomes,
    aggregateClaim: {
      assertedDivergenceCount: divergences.length,
      assertedWithinBudget: divergences.length <= input.budgetLimit,
    },
    exercisedCapabilities: [...input.declaredCapabilities],
    citedProposalId: input.sourceProposalId,
    canaryCost: referenceCanaryMeasurementOf(sliceCaseIds),
  };
}

/**
 * Derive the observed canary verdict kind (PURE): an honest refusal
 * when the run refused; a containment violation when the replacement
 * escaped its granted surface MID-CANARY; `canary-invalid` when the
 * run's mechanical shape is untrustworthy (an unstated or unchecked
 * policy, a broken lifecycle walk, a smoothed breach, a partial or
 * unevidenced rollback, an over-slice serve, a billed canary); an
 * honest rollback when a step's observed divergence exceeded its
 * pinned budget over an otherwise trustworthy run (the breach is
 * honest, the rollback complete and exercised); and a clean promotion
 * when every step advanced within its budget to the promoted rung.
 */
export function deriveCanaryVerdictKind(input: {
  readonly refusal: { readonly reason: CanaryRefusalReason } | null;
  readonly isolation: ReplacementIsolationVerdict | null;
  readonly policyExplicitness: CanaryPolicyExplicitnessVerdict | null;
  readonly lifecycleCompleteness: PromotionLifecycleCompletenessVerdict | null;
  readonly breachHonesty: BreachHonestyVerdict | null;
  readonly rollbackCompleteness: RollbackCompletenessVerdict | null;
  readonly sliceIsolation: SliceIsolationVerdict | null;
  readonly costSeparation: CanaryCostSeparationVerdict | null;
}): CanaryVerdictKind {
  if (input.refusal !== null) {
    return "honest-refusal";
  }
  if (input.isolation !== null && !input.isolation.contained) {
    return "containment-violation";
  }
  if (
    input.policyExplicitness === null ||
    input.lifecycleCompleteness === null ||
    input.breachHonesty === null ||
    input.rollbackCompleteness === null ||
    input.sliceIsolation === null ||
    input.costSeparation === null
  ) {
    return "canary-invalid";
  }
  if (
    !input.policyExplicitness.explicit ||
    !input.lifecycleCompleteness.complete ||
    !input.breachHonesty.honest ||
    !input.rollbackCompleteness.complete ||
    !input.sliceIsolation.isolated ||
    !input.costSeparation.separated
  ) {
    return "canary-invalid";
  }
  if (input.breachHonesty.breachingStepIndexes.length > 0) {
    return "honest-rollback";
  }
  return "clean-promotion";
}

// ---------------------------------------------------------------------------
// The driver seams (the read-only registry + the append-only ledgers)
// ---------------------------------------------------------------------------

/**
 * The candidate registry read port (the READ-ONLY input): VAL-032's
 * proposal records — the registry identities the canary rows cite.
 * The canary run NEVER rewrites an entry; a registry whose digest
 * changes over a run FAILs the read-only discipline.
 */
export interface CanaryCandidateRegistryPort {
  candidateFor(proposalId: string): DiscoveryProposalRecord | null;
  facts(): EquivalenceRegistryFacts;
}

/**
 * The canonical digest over the registry's facts (PURE — the
 * read-only fingerprint the driver snapshots before and after every
 * run: the registry entries are frozen inputs).
 */
export function canaryRegistryDigestOf(facts: EquivalenceRegistryFacts): string {
  return equivalenceRegistryDigestOf(facts);
}

/**
 * The candidate lifecycle ledger port (APPEND-ONLY): the canary run
 * APPENDS its `canaried` (and on a clean promotion, `promoted`)
 * transitions with their evidence digests to the candidate lifecycle —
 * the recorded VAL-033 + VAL-034 walk (the pre-seeded
 * `offline-replayed` + `differentially-evaluated` + `shadow-executed`
 * transitions) is a read-only input the append NEVER rewrites. An
 * identical re-append REPLAYS (idempotent); a different transition
 * under a recorded (proposalId, stage) key is REFUSED.
 */
export type CanaryLifecycleLedgerPort = CandidateLifecycleLedgerPort;

/** The append-only receipt every canary ledger append returns. */
export interface CanaryLedgerReceipt {
  readonly accepted: boolean;
  readonly replayed: boolean;
  readonly refused: boolean;
}

/**
 * The canary ledger port (APPEND-ONLY): the canary-decision ledger
 * (every step's decision with its policy citations and checks), the
 * divergence ledger (every canary divergence case-by-case with both
 * sides' digests), the rollback-event ledger (the EXERCISED rollback
 * records) and the canary cost ledger (the canary's measured cost
 * booked apart under its canary marker). None is ever rewritten; an
 * identical re-append REPLAYS idempotently.
 */
export interface CanaryLedgerPort {
  appendDecision(record: Omit<CanaryDecisionRecord, "ordinal">): Promise<CanaryLedgerReceipt>;
  decisionsFor(proposalId: string): readonly CanaryDecisionRecord[];
  appendDivergence(record: Omit<CanaryDivergenceRecord, "ordinal">): Promise<CanaryLedgerReceipt>;
  divergencesFor(proposalId: string): readonly CanaryDivergenceRecord[];
  appendRollbackEvent(record: Omit<RollbackEventRecord, "ordinal">): Promise<CanaryLedgerReceipt>;
  rollbackEventsFor(proposalId: string): readonly RollbackEventRecord[];
  bookCanaryCost(entry: Omit<CanaryCostLedgerEntry, "ordinal">): Promise<CanaryLedgerReceipt>;
  canaryCostsFor(proposalId: string): readonly CanaryCostLedgerEntry[];
}

/** The traffic-source port (the recorded workload mix serve). */
export interface CanaryTrafficSourcePort {
  /**
   * Serve the recorded traffic population for one canary run (the
   * honest source serves the row's declared population exactly).
   */
  populationFor(input: {
    readonly population: readonly DifferentialCase[];
  }): Promise<readonly DifferentialCase[]>;
}

/**
 * The canary serving-path port (the customer-facing slice serve + the
 * mechanical revert + the served accounting): the honest path serves
 * the INCUMBENT's executed digest on every case OUTSIDE the step's
 * granted slice and the REPLACEMENT's digest on every case INSIDE it;
 * the revert is complete and mechanical (the whole slice reverts to
 * the incumbent); the served accounting bills the incumbent's own
 * basis only.
 */
export interface CanaryServingPathPort {
  serveStep(input: {
    readonly tcase: DifferentialCase;
    readonly incumbentDigest: string;
    /** The replacement's executed digest (null when the case is outside the slice). */
    readonly replacementDigest: string | null;
    readonly inSlice: boolean;
    readonly stepIndex: number;
  }): Promise<{ readonly servedSource: string; readonly servedDigest: string }>;
  /**
   * The mechanical revert: the served traffic reverts to the incumbent
   * across the WHOLE slice. Returns the post-revert serve observations
   * (the residual-replacement basis — empty on the honest path).
   */
  revertToIncumbent(input: {
    readonly sliceCaseIds: readonly string[];
  }): Promise<readonly { readonly caseId: string; readonly servedSource: string }[]>;
  servedAccounting(): ServedAccountingSnapshot;
}

/** The canary-runtime port (the replacement serving its granted slice). */
export interface CanaryRuntimePort {
  runCanaryStep(input: {
    readonly sourceProposalId: string;
    readonly replacementShape: ReplacementShape;
    readonly declaredCapabilities: readonly string[];
    readonly acceptanceCriterion: AcceptanceCriterion | null;
    readonly trafficPopulation: readonly DifferentialCase[];
    readonly stepIndex: number;
    readonly sliceFraction: number;
    readonly budgetLimit: number;
  }): Promise<CanaryStepOutcome>;
}

// ---------------------------------------------------------------------------
// The corpus-row contract (the canary oracle)
// ---------------------------------------------------------------------------

/**
 * The canary-promotion corpus row (the full oracle — AC1's per-row
 * contract): the canaried candidate (the VAL-034 shadow-executed
 * lifecycle identity — the registry entry whose recorded walk ends at
 * `shadow-executed`), the replacement shape carried over from the
 * differential evaluation (with its declared capabilities and granted
 * isolation surface — the containment carry-over), the traffic
 * population (the workload mix the canary ramps over), the EXPLICIT
 * admission policy (the pinned ramp schedule, the failure budget and
 * the divergence tolerance — stated AND checked), and the expected
 * outcome (the clean promotion through the full ramp, the honest
 * budget-breach rollback mid-ramp, or the honest refusal).
 */
export interface CanaryCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The VAL-034 shadow-executed lifecycle identity this row canaries. */
  readonly sourceProposalId: string;
  /** The replacement shape (carried over from VAL-033's differential evaluation). */
  readonly replacementShape: ReplacementShape;
  /** The replacement's DECLARED capability set (the granted surface's demand). */
  readonly declaredCapabilities: readonly string[];
  /** The granted isolation surface (the ALLOWED capability set — carried over). */
  readonly grantedIsolationSurface: readonly string[];
  /** The traffic population (the workload mix the canary ramps over). */
  readonly trafficPopulation: readonly DifferentialCase[];
  /** The recorded workload class per traffic case (the mix basis). */
  readonly trafficWorkloadClasses: Readonly<Record<string, string>>;
  /** The EXPLICIT divergence tolerance (the per-case agreement basis). */
  readonly acceptanceCriterion: AcceptanceCriterion;
  /** The pinned RAMP SCHEDULE (the increasing traffic fractions, ending at full traffic). */
  readonly rampSchedule: readonly RampStep[];
  /** The pinned FAILURE BUDGET (the max divergences tolerated per step). */
  readonly failureBudget: FailureBudget;
  /** The expected outcome (the oracle proper). */
  readonly expected: {
    readonly verdict: Exclude<CanaryVerdictKind, "canary-invalid" | "containment-violation">;
    /** The expected refusal reason (null when a canary was expected). */
    readonly refusalReason: CanaryRefusalReason | null;
    /** The step whose observed divergence exceeds the budget (an honest rollback; null otherwise). */
    readonly breachingStepIndex: number | null;
    /** The final lifecycle stage the run lands (promoted / canaried / null on a refusal). */
    readonly finalStage: CandidateLifecycleStage | null;
    /** The run's own dispatch demand (0 offline; the live row's REAL confirmation round). */
    readonly modelCalls: number;
    /** The run's honest terminal (an honest rollback FAILs honestly; a refusal COMPLETES). */
    readonly terminal: "COMPLETED" | "FAILED";
  };
  /** The pinned canary-trajectory class (the app's re-derivation target). */
  readonly expectedTrajectoryClass: readonly string[];
  /** The canary-probe vocabulary (the phase-2 discrimination hooks). */
  readonly probe?: { readonly kind: CanaryProbeKind };
  /** Whether the run demands a REAL residual-AI model round (the live row). */
  readonly needsDispatch: boolean;
  /** The live gate (absent for offline rows — always drivable). */
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
}

// ---------------------------------------------------------------------------
// The canary trajectory (the app's re-derivation basis)
// ---------------------------------------------------------------------------

/**
 * The canonical canary-run trajectory (PURE): the steps ONE canary
 * run records — the live row's REAL residual-AI confirmation round
 * (dispatch), the read-only candidate read, the traffic population
 * serve, per ramp step the slice serve + the canary execution + the
 * decision record (and on a breach, the exercised rollback), the
 * canary-cost booking, the lifecycle appends (the canaried rung, then
 * the promoted rung on a clean promotion) and the criteria recording.
 * The app re-derives this trajectory's digest over the PUBLIC
 * step-event journal — never trusting the platform's claim.
 */
export function canaryTrajectoryStepsOf(input: {
  readonly proposalId: string;
  readonly populationDigest: string;
  readonly steps: readonly {
    readonly stepIndex: number;
    readonly sliceDigest: string;
    readonly decisionKind: CanaryDecisionKind;
    readonly divergenceCount: number;
    readonly rollbackExercised: boolean;
  }[];
  readonly canaryCostDigest: string | null;
  readonly landedStages: readonly CandidateLifecycleStage[];
  readonly refusalReason: CanaryRefusalReason | null;
  /** The run's own REAL residual-AI confirmation dispatches (the live row). */
  readonly confirmationRounds: number;
}): TrajectoryStepRecord[] {
  const steps: TrajectoryStepRecord[] = [];
  for (let round = 1; round <= input.confirmationRounds; round += 1) {
    steps.push({
      ordinal: steps.length + 1,
      kind: "dispatch",
      detail: `confirmation-round-${round}`,
      digest: longitudinalDigestOf(["dispatch", "confirmation", round, "fresh"]),
    });
  }
  steps.push({
    ordinal: steps.length + 1,
    kind: "effect",
    detail: "candidate-read",
    digest: longitudinalDigestOf(["candidate-read", input.proposalId]),
  });
  if (input.refusalReason !== null) {
    // The honest-refusal path: nothing executes, nothing lands.
    steps.push({
      ordinal: steps.length + 1,
      kind: "verification",
      detail: "refusal-recorded",
      digest: longitudinalDigestOf(["refusal-recorded", input.refusalReason]),
    });
  } else {
    steps.push({
      ordinal: steps.length + 1,
      kind: "effect",
      detail: "traffic-served",
      digest: input.populationDigest,
    });
    for (const step of input.steps) {
      steps.push({
        ordinal: steps.length + 1,
        kind: "effect",
        detail: `slice-served-step-${step.stepIndex}`,
        digest: step.sliceDigest,
      });
      steps.push({
        ordinal: steps.length + 1,
        kind: "effect",
        detail: `canary-executed-step-${step.stepIndex}`,
        digest: longitudinalDigestOf([
          "canary-executed-step",
          step.stepIndex,
          step.divergenceCount,
        ]),
      });
      steps.push({
        ordinal: steps.length + 1,
        kind: "verification",
        detail: `decision-recorded-step-${step.stepIndex}`,
        digest: longitudinalDigestOf([
          "decision-recorded-step",
          step.stepIndex,
          step.decisionKind,
          step.divergenceCount,
        ]),
      });
      if (step.rollbackExercised) {
        steps.push({
          ordinal: steps.length + 1,
          kind: "effect",
          detail: `rollback-exercised-step-${step.stepIndex}`,
          digest: longitudinalDigestOf(["rollback-exercised-step", step.stepIndex]),
        });
      }
    }
    if (input.canaryCostDigest !== null) {
      steps.push({
        ordinal: steps.length + 1,
        kind: "effect",
        detail: "canary-cost-booked",
        digest: input.canaryCostDigest,
      });
    }
    for (const stage of input.landedStages) {
      steps.push({
        ordinal: steps.length + 1,
        kind: "effect",
        detail: "lifecycle-appended",
        digest: longitudinalDigestOf(["lifecycle-appended", input.proposalId, stage]),
      });
    }
  }
  steps.push({
    ordinal: steps.length + 1,
    kind: "verification",
    detail: "criteria-recorded",
    digest: longitudinalDigestOf(["criteria-recorded", input.proposalId, input.populationDigest]),
  });
  return steps;
}

// ---------------------------------------------------------------------------
// The canary driver
// ---------------------------------------------------------------------------

/** The full canary-run result (the honest contract). */
export interface CanaryRunResult {
  readonly rowId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  /** The observed verdict kind (the honest derivation, never the runtime's claim). */
  readonly verdict: CanaryVerdictKind;
  readonly refusal: { readonly reason: CanaryRefusalReason } | null;
  readonly policyExplicitness: CanaryPolicyExplicitnessVerdict | null;
  readonly lifecycleCompleteness: PromotionLifecycleCompletenessVerdict | null;
  readonly breachHonesty: BreachHonestyVerdict | null;
  readonly rollbackCompleteness: RollbackCompletenessVerdict | null;
  readonly sliceIsolation: SliceIsolationVerdict | null;
  readonly costSeparation: CanaryCostSeparationVerdict | null;
  readonly isolation: ReplacementIsolationVerdict | null;
  readonly refusalHonesty: CanaryRefusalHonestyVerdict | null;
  /** The lifecycle landing receipts (null when nothing was appended). */
  readonly landings: {
    readonly canaried: { readonly accepted: boolean; readonly replayed: boolean } | null;
    readonly promoted: { readonly accepted: boolean; readonly replayed: boolean } | null;
  };
  /** The number of decision records appended to the canary ledger. */
  readonly decisionsAppended: number;
  /** The number of rollback events appended to the canary ledger. */
  readonly rollbackEventsAppended: number;
  /** The number of divergence records appended to the canary ledger. */
  readonly divergencesAppended: number;
  /** Whether the canary cost booked to the canary ledger. */
  readonly canaryCostBooked: boolean;
  readonly observedModelCalls: number;
  /** The run's measured usage (the live row; null offline — honestly none-reported). */
  readonly usage: LabUsage | null;
  /** The run's measured latency (ms). */
  readonly latencyMs: number;
  readonly failure: { readonly category: string; readonly message: string } | null;
}

/**
 * The canary refusal-honesty verdict.
 */
export interface CanaryRefusalHonestyVerdict {
  /** The refusal is mechanically justified by the registry's/lifecycle's own state. */
  readonly honest: boolean;
  readonly reason: CanaryRefusalReason | null;
  readonly justified: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the refusal honesty (PURE): a canary run refuses only when
 * the candidate's own recorded state genuinely justifies it —
 * `candidate-unregistered` only when the cited identity is not a
 * member of the candidate registry, and
 * `candidate-not-shadow-executed` only when the candidate's recorded
 * lifecycle walk has not yet reached the shadow-executed stage. A
 * refusal that hides a canaryable candidate FAILs just as a fabricated
 * comparison does — and a refusal accompanied by a canary execution
 * (or vice versa) is a malformed outcome that FAILs.
 */
export function deriveCanaryRefusalHonesty(input: {
  /** The run's refusal under test (null when a canary was executed). */
  readonly refusal: { readonly reason: CanaryRefusalReason } | null;
  /** Whether the run executed canary steps alongside the refusal under test. */
  readonly canaryExecuted: boolean;
  /** The registry's own entry for the row's cited candidate (null when unregistered). */
  readonly registryEntry: {
    readonly lifecycleStage: CandidateLifecycleStage;
    /** Whether the candidate's recorded walk ends at the shadow-executed stage. */
    readonly walkEndsAtShadowExecuted: boolean;
  } | null;
}): CanaryRefusalHonestyVerdict {
  const malformed = (input.refusal !== null) === input.canaryExecuted;
  let justified = false;
  let basis = "";
  if (input.refusal === null) {
    justified = !input.canaryExecuted;
    basis = "no-refusal-to-judge (the run executed its canary)";
  } else {
    switch (input.refusal.reason) {
      case "candidate-unregistered":
        justified = input.registryEntry === null;
        basis = "the cited candidate identity is not a member of the candidate registry";
        break;
      case "candidate-not-shadow-executed":
        justified = input.registryEntry !== null && !input.registryEntry.walkEndsAtShadowExecuted;
        basis =
          "the candidate's recorded lifecycle walk has not yet reached the shadow-executed stage";
        break;
    }
  }
  const honest = !malformed && justified;

  return {
    honest,
    reason: input.refusal?.reason ?? null,
    justified,
    criteria: [
      {
        criterionId: "canary-refusal-well-formed",
        strategy: "deterministic",
        status: malformed ? "FAIL" : "PASS",
        evidence: [
          `refusal:${input.refusal?.reason ?? "none"}`,
          `canaryExecuted:${String(input.canaryExecuted)}`,
          malformed
            ? "MALFORMED-OUTCOME (a refusal and a canary execution are mutually exclusive)"
            : "the-outcome-is-either-a-canary-or-a-refusal",
        ],
      },
      {
        criterionId: "canary-refusal-justified",
        strategy: "deterministic",
        status: justified ? "PASS" : "FAIL",
        evidence: [
          `reason:${input.refusal?.reason ?? "none"}`,
          `registryStage:${input.registryEntry?.lifecycleStage ?? "none"}`,
          `walkEndsAtShadowExecuted:${String(
            input.registryEntry?.walkEndsAtShadowExecuted ?? false,
          )}`,
          justified
            ? `justified (${basis})`
            : "UNJUSTIFIED-REFUSAL (the candidate's own state supports the canary run — hiding it FAILs)",
        ],
      },
      {
        criterionId: "canary-refusal-honesty-summary",
        strategy: "deterministic",
        status: honest ? "PASS" : "FAIL",
        evidence: [
          `honest:${String(honest)}`,
          `wellFormed:${String(!malformed)}`,
          `justified:${String(justified)}`,
        ],
      },
    ],
  };
}

/**
 * Drive ONE canary corpus row through the platform path: read the
 * row's candidate from the READ-ONLY candidate registry (the VAL-032
 * entry — never rewritten; a candidate whose recorded lifecycle walk
 * has not yet reached `shadow-executed` yields an HONEST refusal),
 * serve the recorded traffic population (the workload mix), record the
 * rollback plan (the reversibility contract — recorded on every run),
 * then advance the GOVERNED RAMP one pinned step at a time: at every
 * step the runtime executes the isolated replacement over the step's
 * deterministic SLICE, the incumbent executes and serves the remainder
 * (the customer-facing serve — the replacement serves ONLY inside the
 * slice), the observed divergence count is MECHANICALLY derived
 * case-by-case under the stated tolerance, the budget is checked, and
 * the decision (advance, or breach-rollback) is appended with its
 * policy citations and checks. On a breach the rollback is EXERCISED —
 * the served traffic reverts to the incumbent across the whole slice
 * (the residual is derived mechanically) and the ramp stops. On a
 * clean full ramp the verified transitions append to the candidate
 * lifecycle — `canaried`, then `promoted` (the FINAL stage) — one
 * evidenced rung at a time, never rewriting the recorded walk; the
 * canary's measured cost books to the canary ledger under its canary
 * marker, apart from the served accounting; and the registry is
 * snapshot before and after so the read-only discipline proves the run
 * mutated nothing.
 *
 * The live row additionally drives ONE REAL residual-AI confirmation
 * dispatch through the dispatch seam (env-gated, measured — never
 * fabricated); an offline canary run dispatches no model at all.
 */
export async function driveCanaryRun(options: {
  readonly row: CanaryCorpusRow;
  /** The READ-ONLY candidate registry (VAL-032's proposals). */
  readonly registry: CanaryCandidateRegistryPort;
  /** The APPEND-ONLY candidate lifecycle ledger (the pre-seeded VAL-033 + VAL-034 walk). */
  readonly lifecycle: CanaryLifecycleLedgerPort;
  /** The APPEND-ONLY canary ledger (decisions + divergences + rollback events + canary cost). */
  readonly canaryLedger: CanaryLedgerPort;
  /** The incumbent executor seam (the incumbent AI implementation). */
  readonly incumbentExecutor: IncumbentExecutorPort;
  /** The traffic source seam (the recorded workload mix serve). */
  readonly trafficSource: CanaryTrafficSourcePort;
  /** The canary serving-path seam (the slice serve + the mechanical revert). */
  readonly servingPath: CanaryServingPathPort;
  /** The canary runtime seam (the replacement serving its granted slice). */
  readonly canaryRuntime: CanaryRuntimePort;
  /** The dispatch seam (the live row's REAL residual-AI confirmation round). */
  readonly dispatch?: ControlDispatch;
  /** Bounded retry policy for RETRYABLE dispatch failures (the live row). */
  readonly retry?: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  readonly now: () => Date;
}): Promise<CanaryRunResult> {
  const { row } = options;
  if (row.needsDispatch && options.dispatch === undefined) {
    throw new Error(
      `corpus row ${row.rowId} demands a dispatch seam but none was bound ` +
        "(the live row's REAL residual-AI confirmation round requires it)",
    );
  }
  const retry = options.retry ?? {
    maxExtraAttempts: 0,
    backoffMs: 0,
    sleep: async () => {},
  };
  const startedAt = options.now().getTime();

  // ---- the frozen-registry snapshot BEFORE the run ----
  const beforeRegistryDigest = canaryRegistryDigestOf(options.registry.facts());

  // ---- the read-only candidate read ----
  const candidate = options.registry.candidateFor(row.sourceProposalId);
  // The recorded walk BEFORE this run's append, EXCLUDING any prior
  // canary landing (an honest re-drive REPLAYS the identical
  // transitions — the recorded VAL-033 + VAL-034 walk is the
  // read-only prefix).
  const preDriveTransitions = options.lifecycle.transitionsFor(row.sourceProposalId);
  const priorTransitions = preDriveTransitions.filter(
    (transition) => transition.toStage !== CANARY_STAGE && transition.toStage !== PROMOTED_STAGE,
  );
  const priorWalk = priorTransitions.map((transition) => transition.toStage);
  const walkEndsAtShadowExecuted =
    priorWalk.length === CANARY_REQUIRED_PRIOR_WALK.length &&
    priorWalk[CANARY_REQUIRED_PRIOR_WALK.length - 1] === CANARY_SOURCE_STAGE;

  let refusal: { reason: CanaryRefusalReason } | null = null;
  if (candidate === null) {
    refusal = { reason: "candidate-unregistered" };
  } else if (!walkEndsAtShadowExecuted) {
    refusal = { reason: "candidate-not-shadow-executed" };
  }

  let policyExplicitness: CanaryPolicyExplicitnessVerdict | null = null;
  let lifecycleCompleteness: PromotionLifecycleCompletenessVerdict | null = null;
  let breachHonesty: BreachHonestyVerdict | null = null;
  let rollbackCompleteness: RollbackCompletenessVerdict | null = null;
  let sliceIsolation: SliceIsolationVerdict | null = null;
  let costSeparation: CanaryCostSeparationVerdict | null = null;
  let isolation: ReplacementIsolationVerdict | null = null;
  let refusalHonesty: CanaryRefusalHonestyVerdict | null = null;
  let canaryLanding: { accepted: boolean; replayed: boolean } | null = null;
  let promotedLanding: { accepted: boolean; replayed: boolean } | null = null;
  let decisionsAppended = 0;
  let rollbackEventsAppended = 0;
  let divergencesAppended = 0;
  let canaryCostBooked = false;
  let servedAsPinned = true;
  let planDigest: string | null = null;
  const mechanicalDivergenceCaseIdsByStep = new Map<number, string[]>();
  const sliceServeSteps: CanarySliceServeStep[] = [];
  const executedStepIndexes: number[] = [];
  let rollbackDemanded = false;
  let sliceCaseIdsAtBreach: readonly string[] = [];
  let postRollbackResidualCaseIds: readonly string[] = [];
  let canaryCostTotalMicroUsd = 0;
  let canaryCostMeasured = false;
  let costMarkerPresent: boolean | null = null;

  if (refusal !== null) {
    // ---- the honest-refusal path (the candidate's own recorded state
    //      does not support a canary run: nothing executes, nothing lands) ----
    refusalHonesty = deriveCanaryRefusalHonesty({
      refusal,
      canaryExecuted: false,
      registryEntry:
        candidate === null
          ? null
          : {
              lifecycleStage: candidate.lifecycleStage,
              walkEndsAtShadowExecuted,
            },
    });
    policyExplicitness = deriveCanaryPolicyExplicitness({
      rampSchedule: row.rampSchedule,
      failureBudget: row.failureBudget,
      tolerance: row.acceptanceCriterion,
      decisions: [],
      executedStepIndexes: [],
    });
  } else {
    // ---- the traffic serve (the recorded workload mix) ----
    const servedPopulation = await options.trafficSource.populationFor({
      population: row.trafficPopulation,
    });
    const populationCaseIds = row.trafficPopulation.map((tcase) => tcase.caseId);

    // ---- the rollback plan record (the reversibility contract —
    //      recorded on EVERY canary run, exercised on every breach) ----
    const rollbackPlan: RollbackPlanRecord = {
      proposalId: row.sourceProposalId,
      revertsServingTo: "incumbent",
      scopeFraction: 1,
    };
    planDigest = rollbackPlanDigestOf(rollbackPlan);

    // ---- the governed ramp (one pinned step at a time) ----
    for (const step of row.rampSchedule) {
      executedStepIndexes.push(step.stepIndex);
      const runtimeOutcome = await options.canaryRuntime.runCanaryStep({
        sourceProposalId: row.sourceProposalId,
        replacementShape: row.replacementShape,
        declaredCapabilities: row.declaredCapabilities,
        acceptanceCriterion: row.acceptanceCriterion,
        trafficPopulation: servedPopulation,
        stepIndex: step.stepIndex,
        sliceFraction: step.trafficFraction,
        budgetLimit: row.failureBudget.maxDivergencesPerStep,
      });
      const expectedSliceCaseIds = sliceCaseIdsOf(populationCaseIds, step.trafficFraction);

      // ---- the mechanical per-case divergence evaluation over the slice ----
      const mechanicalDivergenceCaseIds: string[] = [];
      const replacementDigestByCase = new Map<string, string>();
      for (const tcase of servedPopulation) {
        if (!expectedSliceCaseIds.includes(tcase.caseId)) {
          continue;
        }
        const replacementDigest =
          runtimeOutcome.outcomes.find((outcome) => outcome.caseId === tcase.caseId)?.digest ??
          null;
        if (replacementDigest === null) {
          continue;
        }
        replacementDigestByCase.set(tcase.caseId, replacementDigest);
        const agrees = criterionSatisfiedForCase({
          dcase: tcase,
          replacementDigest,
          incumbentDigest: tcase.incumbentDigest,
          criterion: row.acceptanceCriterion,
        });
        if (!agrees) {
          mechanicalDivergenceCaseIds.push(tcase.caseId);
        }
      }
      mechanicalDivergenceCaseIdsByStep.set(step.stepIndex, mechanicalDivergenceCaseIds);

      // ---- the incumbent executes + the customer is served (the
      //      replacement serves ONLY inside the slice) ----
      const servedReplacementCaseIds: string[] = [];
      const servedReplacementTenantIds = new Set<string>();
      for (const tcase of servedPopulation) {
        const incumbentOutcome = await options.incumbentExecutor.outcomeFor({ dcase: tcase });
        if (incumbentOutcome.digest !== tcase.incumbentDigest) {
          servedAsPinned = false;
        }
        const inSlice = expectedSliceCaseIds.includes(tcase.caseId);
        const replacementDigest = replacementDigestByCase.get(tcase.caseId) ?? null;
        const served = await options.servingPath.serveStep({
          tcase,
          incumbentDigest: incumbentOutcome.digest,
          replacementDigest,
          inSlice,
          stepIndex: step.stepIndex,
        });
        if (served.servedSource === "replacement") {
          servedReplacementCaseIds.push(tcase.caseId);
          servedReplacementTenantIds.add(canaryTenantIdOf(tcase.caseId));
        }
      }
      sliceServeSteps.push({
        stepIndex: step.stepIndex,
        pinnedFraction: step.trafficFraction,
        populationCaseIds,
        servedReplacementCaseIds,
        servedReplacementTenantIds: [...servedReplacementTenantIds],
      });

      // ---- the mechanical containment carry-over ----
      isolation =
        isolation ??
        deriveReplacementIsolation({
          declaredCapabilities: row.declaredCapabilities,
          grantedSurface: row.grantedIsolationSurface,
          exercisedCapabilities: runtimeOutcome.exercisedCapabilities,
        });

      // ---- the canary cost booking (the canary's OWN ledger, under
      //      its canary marker — the measurement is real whenever the
      //      step ran) ----
      if (runtimeOutcome.canaryCost !== null) {
        const costReceipt = await options.canaryLedger.bookCanaryCost({
          proposalId: row.sourceProposalId,
          marker: CANARY_COST_MARKER,
          microUsd: runtimeOutcome.canaryCost.microUsd,
          latencyMs: runtimeOutcome.canaryCost.latencyMs,
        });
        canaryCostBooked = canaryCostBooked || costReceipt.accepted || costReceipt.replayed;
        canaryCostTotalMicroUsd += runtimeOutcome.canaryCost.microUsd;
        canaryCostMeasured = true;
      }

      // ---- the divergence-ledger append (mechanically-derived,
      //      per-case evidence only) ----
      for (const caseId of mechanicalDivergenceCaseIds) {
        const incumbentDigest = row.trafficPopulation.find(
          (tcase) => tcase.caseId === caseId,
        )?.incumbentDigest;
        const replacementDigest = replacementDigestByCase.get(caseId);
        if (incumbentDigest === undefined || replacementDigest === undefined) {
          continue;
        }
        await options.canaryLedger.appendDivergence({
          proposalId: row.sourceProposalId,
          stepIndex: step.stepIndex,
          caseId,
          incumbentDigest,
          replacementDigest,
        });
        divergencesAppended += 1;
      }

      // ---- the decision (the honest judgment of the observed count) ----
      const observedDivergenceCount = mechanicalDivergenceCaseIds.length;
      const beyondBudget = observedDivergenceCount > row.failureBudget.maxDivergencesPerStep;
      const decisionKind: CanaryDecisionKind = beyondBudget ? "breach-rollback" : "advance";
      const decisionRecord: Omit<CanaryDecisionRecord, "ordinal"> = {
        proposalId: row.sourceProposalId,
        stepIndex: step.stepIndex,
        kind: decisionKind,
        sliceFraction: step.trafficFraction,
        observedDivergenceCount,
        budgetLimit: row.failureBudget.maxDivergencesPerStep,
        policyCitations: {
          rampScheduleDigest: rampScheduleDigestOf(row.rampSchedule),
          failureBudgetStated: true,
          toleranceStated: true,
        },
        policyChecks: {
          rampChecked: true,
          budgetChecked: true,
          toleranceChecked: true,
        },
      };
      await options.canaryLedger.appendDecision(decisionRecord);
      decisionsAppended += 1;

      let rollbackTriggered = false;
      if (beyondBudget) {
        // ---- the breach: the complete mechanical rollback, EXERCISED ----
        rollbackDemanded = true;
        sliceCaseIdsAtBreach = expectedSliceCaseIds;
        const postRevert = await options.servingPath.revertToIncumbent({
          sliceCaseIds: expectedSliceCaseIds,
        });
        postRollbackResidualCaseIds = postRevert
          .filter((serve) => serve.servedSource === "replacement")
          .map((serve) => serve.caseId);
        await options.canaryLedger.appendRollbackEvent({
          proposalId: row.sourceProposalId,
          stepIndex: step.stepIndex,
          planDigest: planDigest ?? "",
          residualReplacementCaseIds: postRollbackResidualCaseIds,
        });
        rollbackEventsAppended += 1;
        rollbackTriggered = true;
      }

      if (rollbackTriggered) {
        // The ramp STOPS at the breach — no further step serves.
        break;
      }
    }
  }

  // ---- the mechanical verification of the run ----
  if (refusal === null) {
    // The evidence-based derivations read the DURABLE ledgers back —
    // the decision ledger's own records (never the in-memory intent)
    // are the policy and breach evidence.
    const ledgeredDecisions = options.canaryLedger.decisionsFor(row.sourceProposalId);
    policyExplicitness = deriveCanaryPolicyExplicitness({
      rampSchedule: row.rampSchedule,
      failureBudget: row.failureBudget,
      tolerance: row.acceptanceCriterion,
      decisions: ledgeredDecisions.map((decision) => ({
        stepIndex: decision.stepIndex,
        citations: decision.policyCitations,
        checks: decision.policyChecks,
      })),
      executedStepIndexes,
    });
    const recordedDivergenceCaseIdsByStep = new Map<number, string[]>();
    for (const divergence of options.canaryLedger.divergencesFor(row.sourceProposalId)) {
      const existing = recordedDivergenceCaseIdsByStep.get(divergence.stepIndex) ?? [];
      existing.push(divergence.caseId);
      recordedDivergenceCaseIdsByStep.set(divergence.stepIndex, existing);
    }
    const rollbackEventStepIndexes = new Set(
      options.canaryLedger.rollbackEventsFor(row.sourceProposalId).map((event) => event.stepIndex),
    );
    const ledgeredBreachLegs = ledgeredDecisions.map((decision) => ({
      stepIndex: decision.stepIndex,
      budgetLimit: decision.budgetLimit,
      mechanicalDivergenceCaseIds: mechanicalDivergenceCaseIdsByStep.get(decision.stepIndex) ?? [],
      recordedDivergenceCaseIds: recordedDivergenceCaseIdsByStep.get(decision.stepIndex) ?? [],
      decisionKind: decision.kind,
      assertedDivergenceCount: decision.observedDivergenceCount,
      rollbackTriggered: rollbackEventStepIndexes.has(decision.stepIndex),
    }));
    breachHonesty = deriveBreachHonesty({ steps: ledgeredBreachLegs });

    rollbackCompleteness = deriveRollbackCompleteness({
      rollbackDemanded,
      planRecorded: planDigest !== null,
      rollbackEvents: options.canaryLedger.rollbackEventsFor(row.sourceProposalId).map((event) => ({
        ordinal: event.ordinal,
        stepIndex: event.stepIndex,
        residualReplacementCaseIds: event.residualReplacementCaseIds,
      })),
      sliceCaseIdsAtBreach,
    });
    sliceIsolation = deriveSliceIsolation({
      steps: sliceServeSteps,
      promoted: false,
      postPromotionServedReplacementCaseIds: null,
      populationCaseIds: row.trafficPopulation.map((tcase) => tcase.caseId),
    });
    const accounting = options.servingPath.servedAccounting();
    const bookedCanaryCostEntries = options.canaryLedger.canaryCostsFor(row.sourceProposalId);
    const bookedCanaryCost = bookedCanaryCostEntries.reduce(
      (total, entry) => total + entry.microUsd,
      0,
    );
    costMarkerPresent =
      bookedCanaryCostEntries.length > 0 &&
      bookedCanaryCostEntries.every((entry) => entry.marker === CANARY_COST_MARKER);
    costSeparation = deriveCanaryCostSeparation({
      incumbentCostMicroUsd: accounting.incumbentMicroUsd,
      canaryCostMicroUsd: canaryCostMeasured ? canaryCostTotalMicroUsd : null,
      servedTotalMicroUsd: accounting.billedMicroUsd,
      canaryLedgerBookedMicroUsd: bookedCanaryCost > 0 ? bookedCanaryCost : null,
      canaryMarkerPresent: costMarkerPresent,
    });
  }

  // ---- the lifecycle append (ONLY a trustworthy canary ever lands:
  //      contained + policy-explicit + honest breach + complete
  //      rollback + isolated slice + separated cost; an HONEST
  //      ROLLBACK still lands its `canaried` rung — the canary run is
  //      the record — but never the promoted rung) ----
  if (refusal === null) {
    const verdictTrustworthy =
      (isolation?.contained ?? false) &&
      (policyExplicitness?.explicit ?? false) &&
      (breachHonesty?.honest ?? false) &&
      (rollbackCompleteness?.complete ?? false) &&
      (sliceIsolation?.isolated ?? false) &&
      (costSeparation?.separated ?? false);
    if (verdictTrustworthy) {
      const decisionsDigest = longitudinalDigestOf([
        "canary-decisions",
        options.canaryLedger.decisionsFor(row.sourceProposalId).map((decision) => decision.kind),
      ]);
      const canaryEvidence = lifecycleEvidenceDigestOf({
        proposalId: row.sourceProposalId,
        stage: CANARY_STAGE,
        members: [decisionsDigest],
      });
      const canaryReceipt = await options.lifecycle.append({
        proposalId: row.sourceProposalId,
        toStage: CANARY_STAGE,
        evidenceDigest: canaryEvidence,
      });
      canaryLanding = { accepted: canaryReceipt.accepted, replayed: canaryReceipt.replayed };
      if (!rollbackDemanded) {
        // The clean full ramp: the promoted rung — the FINAL stage.
        const rampDigest = rampScheduleDigestOf(row.rampSchedule);
        const promotedEvidence = lifecycleEvidenceDigestOf({
          proposalId: row.sourceProposalId,
          stage: PROMOTED_STAGE,
          members: [rampDigest, decisionsDigest],
        });
        const promotedReceipt = await options.lifecycle.append({
          proposalId: row.sourceProposalId,
          toStage: PROMOTED_STAGE,
          evidenceDigest: promotedEvidence,
        });
        promotedLanding = {
          accepted: promotedReceipt.accepted,
          replayed: promotedReceipt.replayed,
        };
      }
    }
  }

  // ---- the lifecycle completeness (the recorded walk + the canary append) ----
  if (refusal === null) {
    const postTransitions = options.lifecycle.transitionsFor(row.sourceProposalId);
    const appendedTransitions = postTransitions.slice(priorTransitions.length);
    const expectedLanding: "promoted" | "canaried" | "none" =
      canaryLanding === null ? "none" : promotedLanding !== null ? "promoted" : "canaried";
    lifecycleCompleteness = derivePromotionLifecycleCompleteness({
      priorTransitions,
      appendedTransitions,
      expectedLanding,
    });
  }

  // ---- the frozen-registry snapshot AFTER the run (the read-only proof) ----
  const afterRegistryDigest = canaryRegistryDigestOf(options.registry.facts());
  const registryUnchanged = beforeRegistryDigest === afterRegistryDigest;

  // ---- the live row's REAL residual-AI confirmation round (measured) ----
  let usage: LabUsage | null = null;
  let failure: { category: string; message: string } | null = null;
  let observedModelCalls = 0;
  if (row.needsDispatch && options.dispatch !== undefined) {
    for (let round = 1; round <= row.expected.modelCalls; round += 1) {
      for (let attempt = 1; ; attempt += 1) {
        const outcome = await options.dispatch({ round, attempt });
        if (outcome.kind === "success") {
          observedModelCalls += 1;
          if (outcome.usage !== undefined) {
            usage = {
              inputTokens: outcome.usage.inputTokens,
              outputTokens: outcome.usage.outputTokens,
              ...(outcome.usage.costUsd === undefined ? {} : { costUsd: outcome.usage.costUsd }),
            };
          }
          break;
        }
        const retryable = isRetryableDispatchCategory(outcome.category ?? "");
        if (!retryable || attempt > retry.maxExtraAttempts) {
          failure = {
            category: outcome.category ?? "unknown",
            message: outcome.message ?? "provider failure (no provider message)",
          };
          break;
        }
        await retry.sleep(retry.backoffMs);
      }
      if (failure !== null) {
        break;
      }
    }
  }

  const verdict = deriveCanaryVerdictKind({
    refusal,
    isolation,
    policyExplicitness,
    lifecycleCompleteness,
    breachHonesty,
    rollbackCompleteness,
    sliceIsolation,
    costSeparation,
  });

  // ---- the row-level mechanical criteria ----
  const criteria = deriveCanaryRowCriteria({
    row,
    servedAsPinned,
    refusal,
    refusalHonesty,
    policyExplicitness,
    lifecycleCompleteness,
    breachHonesty,
    rollbackCompleteness,
    sliceIsolation,
    costSeparation,
    isolation,
    landings: { canaried: canaryLanding, promoted: promotedLanding },
    decisionsAppended,
    rollbackEventsAppended,
    divergencesAppended,
    registryUnchanged,
    observedModelCalls,
    verdict,
    failure,
  });

  const anyFail =
    failure !== null ||
    criteria.some((criterion) => criterion.status === "FAIL") ||
    (refusal !== null) === (breachHonesty !== null);

  return {
    rowId: row.rowId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    verdict,
    refusal,
    policyExplicitness,
    lifecycleCompleteness,
    breachHonesty,
    rollbackCompleteness,
    sliceIsolation,
    costSeparation,
    isolation,
    refusalHonesty,
    landings: { canaried: canaryLanding, promoted: promotedLanding },
    decisionsAppended,
    rollbackEventsAppended,
    divergencesAppended,
    canaryCostBooked,
    observedModelCalls,
    usage,
    latencyMs: options.now().getTime() - startedAt,
    failure,
  };
}

// ---------------------------------------------------------------------------
// The row-level mechanical criteria (PURE)
// ---------------------------------------------------------------------------

/**
 * Derive the row-level mechanical criteria (PURE): the population pin
 * leg (the served incumbent digests are the recorded/pinned digests),
 * the policy-explicitness legs (stated AND checked per step), the
 * lifecycle-completeness legs (the full evidenced chain, one rung at
 * a time), the breach-honesty legs (within budget advances; beyond
 * budget rolls back — never smoothed), the rollback-completeness legs
 * (recorded, exercised, complete), the slice-isolation legs (the
 * unpromoted candidate serves only its slice), the cost-separation
 * legs (measured apart under the canary marker), the containment legs
 * (the isolation carry-over), the refusal-honesty legs, the ledger
 * landings, the read-only registry legs, the expected-verdict contract
 * (the observed verdict matches the pinned oracle — the kind, the
 * refusal reason, the breaching step and the final stage), the
 * payload-free digest discipline and the honest accounting.
 */
export function deriveCanaryRowCriteria(input: {
  readonly row: CanaryCorpusRow;
  /** Whether the incumbent executor served the population's pinned digests exactly. */
  readonly servedAsPinned: boolean;
  readonly refusal: { readonly reason: CanaryRefusalReason } | null;
  readonly refusalHonesty: CanaryRefusalHonestyVerdict | null;
  readonly policyExplicitness: CanaryPolicyExplicitnessVerdict | null;
  readonly lifecycleCompleteness: PromotionLifecycleCompletenessVerdict | null;
  readonly breachHonesty: BreachHonestyVerdict | null;
  readonly rollbackCompleteness: RollbackCompletenessVerdict | null;
  readonly sliceIsolation: SliceIsolationVerdict | null;
  readonly costSeparation: CanaryCostSeparationVerdict | null;
  readonly isolation: ReplacementIsolationVerdict | null;
  readonly landings: {
    readonly canaried: { readonly accepted: boolean; readonly replayed: boolean } | null;
    readonly promoted: { readonly accepted: boolean; readonly replayed: boolean } | null;
  };
  readonly decisionsAppended: number;
  readonly rollbackEventsAppended: number;
  readonly divergencesAppended: number;
  readonly registryUnchanged: boolean;
  readonly observedModelCalls: number;
  readonly verdict: CanaryVerdictKind;
  readonly failure: { readonly category: string; readonly message: string } | null;
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const { row } = input;

  // 1. The population pin (the served incumbent digests are the pins).
  if (input.breachHonesty !== null) {
    criteria.push({
      criterionId: "canary-population-served-as-pinned",
      strategy: "deterministic",
      status: input.servedAsPinned ? "PASS" : "FAIL",
      evidence: [
        `row:${row.rowId}`,
        `populationSize:${row.trafficPopulation.length}`,
        `rampSteps:${row.rampSchedule.length}`,
        input.servedAsPinned
          ? "served-as-pinned (the incumbent outcomes are the recorded/pinned digests — the read-only input)"
          : "POPULATION-MISMATCH (the incumbent executor served a digest the population does not pin)",
      ],
    });
  }

  // 2-9. The derivation legs.
  if (input.policyExplicitness !== null) {
    criteria.push(...input.policyExplicitness.criteria);
  }
  if (input.lifecycleCompleteness !== null) {
    criteria.push(...input.lifecycleCompleteness.criteria);
  }
  if (input.breachHonesty !== null) {
    criteria.push(...input.breachHonesty.criteria);
  }
  if (input.rollbackCompleteness !== null) {
    criteria.push(...input.rollbackCompleteness.criteria);
  }
  if (input.sliceIsolation !== null) {
    criteria.push(...input.sliceIsolation.criteria);
  }
  if (input.costSeparation !== null) {
    criteria.push(...input.costSeparation.criteria);
  }
  if (input.isolation !== null) {
    criteria.push(...input.isolation.criteria);
  }
  if (input.refusalHonesty !== null) {
    criteria.push(...input.refusalHonesty.criteria);
  }

  // 10. The decision-ledger append (every executed step decided).
  const executedSteps = input.refusal !== null ? 0 : row.rampSchedule.length;
  const stoppingBreach = row.expected.breachingStepIndex !== null;
  const expectedDecisions = stoppingBreach ? (row.expected.breachingStepIndex ?? 0) : executedSteps;
  const decisionsCorrect = input.decisionsAppended === expectedDecisions;
  criteria.push({
    criterionId: "canary-decision-ledger-complete",
    strategy: "deterministic",
    status: decisionsCorrect ? "PASS" : "FAIL",
    evidence: [
      `proposal:${row.sourceProposalId}`,
      `expectedDecisions:${expectedDecisions}`,
      `appended:${input.decisionsAppended}`,
      decisionsCorrect
        ? "every-executed-ramp-step-recorded-its-decision (the ramp stops at the breach)"
        : "DECISION-LEDGER-MISMATCH (the decision ledger does not hold exactly the executed steps' decisions)",
    ],
  });

  // 11. The ledger landings (the verified canary appends its rung(s)).
  const shouldLandCanaried =
    input.refusal === null &&
    (input.isolation?.contained ?? false) &&
    (input.policyExplicitness?.explicit ?? false) &&
    (input.breachHonesty?.honest ?? false) &&
    (input.rollbackCompleteness?.complete ?? false) &&
    (input.sliceIsolation?.isolated ?? false) &&
    (input.costSeparation?.separated ?? false);
  const shouldLandPromoted = shouldLandCanaried && !stoppingBreach;
  const canariedCorrect = shouldLandCanaried
    ? input.landings.canaried?.accepted === true
    : input.landings.canaried === null;
  const promotedCorrect = shouldLandPromoted
    ? input.landings.promoted?.accepted === true
    : input.landings.promoted === null;
  criteria.push({
    criterionId: "canary-ledger-landing",
    strategy: "deterministic",
    status: canariedCorrect && promotedCorrect ? "PASS" : "FAIL",
    evidence: [
      `proposal:${row.sourceProposalId}`,
      `shouldLandCanaried:${String(shouldLandCanaried)}`,
      `shouldLandPromoted:${String(shouldLandPromoted)}`,
      `canariedAccepted:${String(input.landings.canaried?.accepted ?? false)}`,
      `promotedAccepted:${String(input.landings.promoted?.accepted ?? false)}`,
      canariedCorrect && promotedCorrect
        ? "the-verified-canary-appended-its-rungs (canaried, then promoted on a clean full ramp — append-only, never rewriting the recorded walk)"
        : "LEDGER-LANDING-MISMATCH (a trustworthy canary never landed, or an untrustworthy one did)",
    ],
  });

  // 12. The read-only registry (the VAL-032 entries are frozen inputs).
  criteria.push({
    criterionId: "canary-registry-read-only",
    strategy: "deterministic",
    status: input.registryUnchanged ? "PASS" : "FAIL",
    evidence: [
      `registryUnchanged:${String(input.registryUnchanged)}`,
      input.registryUnchanged
        ? "the-candidate-registrys-existing-entries-are-read-only-inputs"
        : "REGISTRY-MUTATION (the run rewrote a candidate — the canary verdict APPENDS, never rewrites)",
    ],
  });

  // 13. The expected-verdict contract (the observed verdict is the pinned oracle).
  const observedFinalStage: CandidateLifecycleStage | null =
    input.landings.promoted !== null
      ? PROMOTED_STAGE
      : input.landings.canaried !== null
        ? CANARY_STAGE
        : null;
  const verdictMatches =
    input.verdict === row.expected.verdict &&
    (input.refusal === null
      ? row.expected.refusalReason === null
      : input.refusal.reason === row.expected.refusalReason) &&
    observedFinalStage === row.expected.finalStage;
  criteria.push({
    criterionId: "canary-verdict-contract",
    strategy: "deterministic",
    status: verdictMatches ? "PASS" : "FAIL",
    evidence: [
      `expectedVerdict:${row.expected.verdict}`,
      `observedVerdict:${input.verdict}`,
      `expectedRefusal:${row.expected.refusalReason ?? "none"}`,
      `observedRefusal:${input.refusal?.reason ?? "none"}`,
      `expectedFinalStage:${row.expected.finalStage ?? "none"}`,
      `observedFinalStage:${observedFinalStage ?? "none"}`,
      verdictMatches
        ? "the-canary-run-reproduces-the-pinned-verdict"
        : "VERDICT-MISMATCH (the observed verdict differs from the pinned oracle)",
    ],
  });

  // 14. The outcome well-formedness (a refusal XOR a canary).
  const wellFormed = (input.refusal !== null) !== (input.breachHonesty !== null);
  criteria.push({
    criterionId: "canary-outcome-well-formed",
    strategy: "deterministic",
    status: wellFormed ? "PASS" : "FAIL",
    evidence: [
      `refusal:${input.refusal !== null ? "reported" : "none"}`,
      `canary:${input.breachHonesty !== null ? "executed" : "none"}`,
      wellFormed
        ? "exactly-one-outcome (a canary or a refusal, never both, never neither)"
        : "MALFORMED-OUTCOME (the run emitted both or neither)",
    ],
  });

  // 15. The payload-free digest discipline (every digest is 8-hex FNV-1a).
  const digestsUnderTest = [
    ...row.trafficPopulation.map((tcase) => tcase.inputDigest),
    ...row.trafficPopulation.map((tcase) => tcase.incumbentDigest),
    ...row.trafficPopulation.flatMap((tcase) => tcase.classDigests),
  ];
  const digestsWellFormed = digestsUnderTest.every((digest) => /^[0-9a-f]{8}$/.test(digest));
  criteria.push({
    criterionId: "canary-payload-free-digest-discipline",
    strategy: "deterministic",
    status: digestsWellFormed ? "PASS" : "FAIL",
    evidence: [
      `digests:${digestsUnderTest.length}`,
      digestsWellFormed
        ? "digests-only (payload bytes never enter the evidence — both sides' outcomes digest-recorded)"
        : "MALFORMED-DIGEST (an outcome digest is not a payload-free FNV-1a digest)",
    ],
  });

  // 16. The run's own dispatch total (offline zero; the live row's confirmation).
  criteria.push({
    criterionId: "canary-own-dispatch-total",
    strategy: "deterministic",
    status: input.observedModelCalls === row.expected.modelCalls ? "PASS" : "FAIL",
    evidence: [
      `expected:${row.expected.modelCalls}`,
      `observed:${input.observedModelCalls}`,
      input.observedModelCalls === row.expected.modelCalls
        ? "the-canary-run-made-its-own-dispatches"
        : "WRONG-DISPATCH-TOTAL (the run under- or over-dispatched)",
    ],
  });

  return criteria;
}

// ---------------------------------------------------------------------------
// The app-side canary contract (PURE verification of app observations)
// ---------------------------------------------------------------------------

/** One canary run's app-side observation (the public-boundary read). */
export interface AppCanaryObservation {
  /** The durable execution the canary submission landed. */
  readonly executionId: string;
  /** True when the submission key REPLAYED an existing execution (a shoulder-in). */
  readonly replayed: boolean;
  readonly rejection: { readonly code: string } | null;
  /** The observed terminal from the public execution read. */
  readonly terminal: string | null;
  /** The verification statuses from the public result read. */
  readonly verificationStatuses: readonly string[];
  /** The verdict read back from the public result read (null when unreadable). */
  readonly verdict: {
    readonly kind: string;
    readonly refusalReason: string | null;
    readonly breachingStepIndex: number | null;
    readonly finalStage: string | null;
  } | null;
  /** The lifecycle landing read back from the public result read. */
  readonly lifecycleLanding: {
    readonly proposalId: string;
    readonly finalStage: string;
  } | null;
  /** The read-back canary decisions (with their policy citations and checks). */
  readonly decisions: readonly {
    readonly stepIndex: number;
    readonly kind: string;
    readonly sliceFraction: number;
    readonly observedDivergenceCount: number;
    readonly budgetLimit: number;
    readonly policyCitations: {
      readonly rampScheduleDigest: string;
      readonly failureBudgetStated: boolean;
      readonly toleranceStated: boolean;
    };
    readonly policyChecks: {
      readonly rampChecked: boolean;
      readonly budgetChecked: boolean;
      readonly toleranceChecked: boolean;
    };
  }[];
  /** The read-back per-case slice comparisons (both sides' digests — the boundary re-derivation basis). */
  readonly sliceComparisons: readonly {
    readonly stepIndex: number;
    readonly caseId: string;
    readonly incumbentDigest: string;
    readonly replacementDigest: string;
    readonly claimedAgrees: boolean;
  }[];
  /** The read-back rollback events (with their residual serves). */
  readonly rollbackEvents: readonly {
    readonly stepIndex: number;
    readonly residualReplacementCaseIds: readonly string[];
  }[];
  /** Whether the read-back holds the run's recorded rollback plan. */
  readonly rollbackPlanRecorded: boolean;
  /** The read-back customer-facing served outcomes (per step). */
  readonly servedOutcomes: readonly {
    readonly stepIndex: number;
    readonly caseId: string;
    readonly servedSource: string;
    readonly servedDigest: string;
  }[];
  /** The read-back canary cost measurement (null when unmeasured). */
  readonly canaryCost: CanaryCostMeasurement | null;
  /** The read-back served accounting's incumbent basis (null when unreadable). */
  readonly servedIncumbentMicroUsd: number | null;
  /** The read-back served accounting's billed total (null when unreadable). */
  readonly servedCostMicroUsd: number | null;
  /** The read-back canary ledger booking (null when nothing booked). */
  readonly canaryLedgerBookedMicroUsd: number | null;
  /** Whether the read-back canary cost booking carries its canary marker (null when nothing booked). */
  readonly canaryMarkerPresent: boolean | null;
  /** The capabilities the read-back reports the replacement exercising mid-canary. */
  readonly exercisedCapabilities: readonly string[];
  /** The app-side trajectory digest over the public events read. */
  readonly trajectoryDigest: string | null;
  /** The observed model-call count from the public route read. */
  readonly observedModelCalls: number | null;
}

/**
 * Judge the app-side observations against the row's canary contract
 * (PURE): the submission landed its OWN durable execution, the
 * terminal↔criteria agreement and the expected terminal hold, the
 * read-back verdict matches the row's pinned oracle (the kind, the
 * refusal reason, the breaching step and the final stage — the
 * promoted rung only on a clean full ramp), the read-back lifecycle
 * landing is the pinned final stage ONLY (a landing past promoted, or
 * a promoted landing on a rollback row, never passes), the policy
 * explicitness is re-derived at the boundary over the READ-BACK
 * decisions' citations and checks (never trusting the platform's
 * claim — an unstated or unchecked policy item never passes), the
 * breach honesty is re-derived at the boundary over the row's pinned
 * policy and the read-back per-case slice comparisons (a smoothed
 * breach never passes), the rollback completeness is re-derived at
 * the boundary over the read-back rollback events (a partial rollback
 * never passes), the slice isolation is re-derived at the boundary
 * over the read-back served outcomes (an over-slice serve never
 * passes), the cost separation is re-derived at the boundary over the
 * read-back costs (a billed or unmarked canary never passes), the run
 * made its OWN dispatches, and the app-side trajectory digest over
 * the public events read is a member of the row's pinned
 * canary-trajectory class.
 */
export function verifyCanaryPromotionAppContract(input: {
  readonly row: CanaryCorpusRow;
  readonly observation: AppCanaryObservation;
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const { row, observation } = input;

  // 1. The submission landed its own durable execution.
  criteria.push({
    criterionId: "app-submission-landed",
    strategy: "deterministic",
    status: observation.rejection === null && observation.executionId !== "" ? "PASS" : "FAIL",
    evidence: [
      `executionId:${observation.executionId || "none"}`,
      `replayed:${String(observation.replayed)}`,
      `rejection:${observation.rejection?.code ?? "none"}`,
      observation.rejection === null && observation.executionId !== ""
        ? "the-canary-submission-landed-its-own-execution"
        : "REJECTED (the canary submission never landed a durable execution)",
    ],
  });

  // 2-3. The terminal agreement + the expected terminal.
  const agreement =
    observation.terminal !== null &&
    observation.verificationStatuses.length > 0 &&
    ((observation.terminal === "COMPLETED" &&
      observation.verificationStatuses.every((status) => status === "PASS")) ||
      (observation.terminal === "FAILED" && observation.verificationStatuses.includes("FAIL")));
  criteria.push({
    criterionId: "app-terminal-criteria-agreement",
    strategy: "deterministic",
    status: agreement ? "PASS" : "FAIL",
    evidence: [
      `terminal:${observation.terminal ?? "none"}`,
      `statuses:${observation.verificationStatuses.join(",") || "none"}`,
      agreement
        ? "the-terminal-agrees-with-the-criteria"
        : "DISAGREEMENT (the terminal contradicts the verification statuses)",
    ],
  });
  criteria.push({
    criterionId: "app-expected-terminal",
    strategy: "deterministic",
    status: observation.terminal === row.expected.terminal ? "PASS" : "FAIL",
    evidence: [
      `expected:${row.expected.terminal}`,
      `observed:${observation.terminal ?? "none"}`,
      `note:an honest rollback FAILs honestly; an honest refusal is a COMPLETED run`,
    ],
  });

  // 4. The read-back verdict matches the pinned oracle.
  if (observation.verdict !== null) {
    const kindMatches = observation.verdict.kind === row.expected.verdict;
    criteria.push({
      criterionId: "app-verdict-kind-pinned",
      strategy: "deterministic",
      status: kindMatches ? "PASS" : "FAIL",
      evidence: [
        `expected:${row.expected.verdict}`,
        `observed:${observation.verdict.kind}`,
        kindMatches
          ? "the-read-back-verdict-matches-the-pin"
          : "VERDICT-MISMATCH (the read-back verdict differs from the pinned oracle)",
      ],
    });
    if (row.expected.refusalReason !== null) {
      criteria.push({
        criterionId: "app-refusal-reason-pinned",
        strategy: "deterministic",
        status: observation.verdict.refusalReason === row.expected.refusalReason ? "PASS" : "FAIL",
        evidence: [
          `expected:${row.expected.refusalReason}`,
          `observed:${observation.verdict.refusalReason ?? "none"}`,
        ],
      });
    }
    const finalStageMatches = observation.verdict.finalStage === row.expected.finalStage;
    criteria.push({
      criterionId: "app-final-stage-pinned",
      strategy: "deterministic",
      status: finalStageMatches ? "PASS" : "FAIL",
      evidence: [
        `expected:${row.expected.finalStage ?? "none"}`,
        `observed:${observation.verdict.finalStage ?? "none"}`,
        finalStageMatches
          ? "the-read-back-final-stage-matches-the-pin (promoted only on a clean full ramp)"
          : "FINAL-STAGE-MISMATCH (the read-back final stage differs from the pinned oracle)",
      ],
    });
  }

  // 5. The lifecycle landing: the pinned final stage ONLY.
  if (observation.lifecycleLanding !== null) {
    const landingOk =
      observation.lifecycleLanding.proposalId === row.sourceProposalId &&
      observation.lifecycleLanding.finalStage === row.expected.finalStage;
    criteria.push({
      criterionId: "app-lifecycle-landing-pinned-stage-only",
      strategy: "deterministic",
      status: landingOk ? "PASS" : "FAIL",
      evidence: [
        `proposal:${observation.lifecycleLanding.proposalId}`,
        `finalStage:${observation.lifecycleLanding.finalStage}`,
        `expectedFinalStage:${row.expected.finalStage ?? "none"}`,
        landingOk
          ? "the-candidate-lands-its-pinned-final-stage (canaried → promoted one evidenced rung at a time)"
          : "OUT-OF-CONTRACT-LANDING (the candidate landed past or short of its pinned final stage)",
      ],
    });
  } else if (row.expected.finalStage !== null) {
    criteria.push({
      criterionId: "app-lifecycle-landing-present",
      strategy: "deterministic",
      status: "FAIL",
      evidence: [
        `expectedFinalStage:${row.expected.finalStage}`,
        "MISSING-LANDING (an executed canary must append to the candidate lifecycle)",
      ],
    });
  }

  // 6. The boundary re-derivation of the policy explicitness (never
  //    trust the platform's claim — the read-back decisions' own
  //    citations and checks).
  const boundaryPolicy = deriveCanaryPolicyExplicitness({
    rampSchedule: row.rampSchedule,
    failureBudget: row.failureBudget,
    tolerance: row.acceptanceCriterion,
    decisions: observation.decisions.map((decision) => ({
      stepIndex: decision.stepIndex,
      citations: decision.policyCitations,
      checks: decision.policyChecks,
    })),
    executedStepIndexes: observation.decisions.map((decision) => decision.stepIndex),
  });
  criteria.push(
    ...boundaryPolicy.criteria.map((criterion) => ({
      ...criterion,
      criterionId: `app-${criterion.criterionId}`,
    })),
  );

  // 7. The boundary re-derivation of the breach honesty (over the
  //    read-back per-case slice comparisons + the row's pinned policy).
  if (observation.sliceComparisons.length > 0 || observation.decisions.length > 0) {
    const steps = observation.decisions.map((decision) => {
      const comparisons = observation.sliceComparisons.filter(
        (comparison) => comparison.stepIndex === decision.stepIndex,
      );
      const mechanicalDivergenceCaseIds = comparisons
        .filter((comparison) => {
          const tcase = row.trafficPopulation.find(
            (candidate) => candidate.caseId === comparison.caseId,
          );
          if (tcase === undefined) {
            return false;
          }
          return !criterionSatisfiedForCase({
            dcase: tcase,
            replacementDigest: comparison.replacementDigest,
            incumbentDigest: comparison.incumbentDigest,
            criterion: row.acceptanceCriterion,
          });
        })
        .map((comparison) => comparison.caseId);
      return {
        stepIndex: decision.stepIndex,
        budgetLimit: decision.budgetLimit,
        mechanicalDivergenceCaseIds,
        recordedDivergenceCaseIds: mechanicalDivergenceCaseIds,
        decisionKind: (isCanaryDecisionKind(decision.kind)
          ? decision.kind
          : null) as CanaryDecisionKind | null,
        assertedDivergenceCount: decision.observedDivergenceCount,
        rollbackTriggered:
          observation.rollbackEvents.some((event) => event.stepIndex === decision.stepIndex) ||
          decision.kind !== "breach-rollback",
      };
    });
    const boundaryBreach = deriveBreachHonesty({ steps });
    criteria.push(
      ...boundaryBreach.criteria.map((criterion) => ({
        ...criterion,
        criterionId: `app-${criterion.criterionId}`,
      })),
    );
  } else if (row.expected.verdict !== "honest-refusal") {
    criteria.push({
      criterionId: "app-canary-readable",
      strategy: "deterministic",
      status: "FAIL",
      evidence: [
        `expectedVerdict:${row.expected.verdict}`,
        "MISSING-CANARY (the boundary could not read the canary decisions or slice comparisons)",
      ],
    });
  }

  // 8. The boundary re-derivation of the rollback completeness (over
  //    the read-back rollback events).
  const boundaryRollback = deriveRollbackCompleteness({
    rollbackDemanded:
      observation.rollbackEvents.length > 0 || row.expected.breachingStepIndex !== null,
    planRecorded:
      observation.rollbackPlanRecorded ||
      (observation.rollbackEvents.length > 0 && row.expected.breachingStepIndex === null),
    rollbackEvents: observation.rollbackEvents.map((event, index) => ({
      ordinal: index + 1,
      stepIndex: event.stepIndex,
      residualReplacementCaseIds: event.residualReplacementCaseIds,
    })),
    sliceCaseIdsAtBreach:
      row.expected.breachingStepIndex === null
        ? []
        : sliceCaseIdsOf(
            row.trafficPopulation.map((tcase) => tcase.caseId),
            row.rampSchedule.find((step) => step.stepIndex === row.expected.breachingStepIndex)
              ?.trafficFraction ?? 1,
          ),
  });
  criteria.push(
    ...boundaryRollback.criteria.map((criterion) => ({
      ...criterion,
      criterionId: `app-${criterion.criterionId}`,
    })),
  );

  // 9. The boundary re-derivation of the slice isolation (over the
  //    read-back served outcomes).
  if (observation.servedOutcomes.length > 0) {
    const steps = row.rampSchedule
      .filter((step) =>
        observation.servedOutcomes.some((serve) => serve.stepIndex === step.stepIndex),
      )
      .map((step) => {
        const serves = observation.servedOutcomes.filter(
          (serve) => serve.stepIndex === step.stepIndex,
        );
        return {
          stepIndex: step.stepIndex,
          pinnedFraction: step.trafficFraction,
          populationCaseIds: row.trafficPopulation.map((tcase) => tcase.caseId),
          servedReplacementCaseIds: serves
            .filter((serve) => serve.servedSource === "replacement")
            .map((serve) => serve.caseId),
          servedReplacementTenantIds: [
            ...new Set(
              serves
                .filter((serve) => serve.servedSource === "replacement")
                .map((serve) => canaryTenantIdOf(serve.caseId)),
            ),
          ],
        };
      });
    const boundarySlice = deriveSliceIsolation({
      steps,
      promoted: observation.verdict?.finalStage === PROMOTED_STAGE,
      postPromotionServedReplacementCaseIds: null,
      populationCaseIds: row.trafficPopulation.map((tcase) => tcase.caseId),
    });
    criteria.push(
      ...boundarySlice.criteria.map((criterion) => ({
        ...criterion,
        criterionId: `app-${criterion.criterionId}`,
      })),
    );
  }

  // 10. The boundary re-derivation of the cost separation (over the
  //     read-back costs — only when a canary executed; a refusal ran
  //     nothing and measured nothing).
  if (observation.decisions.length > 0) {
    const boundaryCost = deriveCanaryCostSeparation({
      incumbentCostMicroUsd:
        observation.servedIncumbentMicroUsd === null ? 0 : observation.servedIncumbentMicroUsd,
      canaryCostMicroUsd: observation.canaryCost?.microUsd ?? null,
      servedTotalMicroUsd:
        observation.servedCostMicroUsd === null ? -1 : observation.servedCostMicroUsd,
      canaryLedgerBookedMicroUsd: observation.canaryLedgerBookedMicroUsd,
      canaryMarkerPresent: observation.canaryMarkerPresent,
    });
    criteria.push(
      ...boundaryCost.criteria.map((criterion) => ({
        ...criterion,
        criterionId: `app-${criterion.criterionId}`,
      })),
    );
  }

  // 11. The run's own dispatches.
  criteria.push({
    criterionId: "app-own-dispatches",
    strategy: "deterministic",
    status: observation.observedModelCalls === row.expected.modelCalls ? "PASS" : "FAIL",
    evidence: [
      `expected:${row.expected.modelCalls}`,
      `observed:${observation.observedModelCalls ?? "none"}`,
      observation.observedModelCalls === row.expected.modelCalls
        ? "the-canary-run-made-its-own-dispatches"
        : "WRONG-DISPATCH-TOTAL (the run under- or over-dispatched)",
    ],
  });

  // 12. The app-side trajectory membership (never trust the platform's claim).
  const inClass =
    observation.trajectoryDigest !== null &&
    row.expectedTrajectoryClass.includes(observation.trajectoryDigest);
  criteria.push({
    criterionId: "app-canary-trajectory-in-class",
    strategy: "deterministic",
    status: inClass ? "PASS" : "FAIL",
    evidence: [
      `trajectoryDigest:${observation.trajectoryDigest ?? "none"}`,
      `classSize:${row.expectedTrajectoryClass.length}`,
      inClass
        ? "in-class (the app re-derived the canary trajectory over the public journal)"
        : "OUT-OF-CLASS (the observed canary trajectory drifted from the pinned class)",
    ],
  });

  return criteria;
}
