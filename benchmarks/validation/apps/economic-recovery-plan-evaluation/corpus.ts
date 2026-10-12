/**
 * The economic-recovery-plan-evaluation corpus (PCR-003 — the P1
 * program's three-arm replay evaluation).
 *
 * THE PINNED EVALUATION CORPUS: the targeted multi-provider cell family
 * (the PPR-027 capstone's 92.4%-mediated vs 97.2%-single-provider gap
 * territory — every multi-configuration cell of the capstone's sweep
 * matrix), the THREE pre-registered arms (un-retried direct /
 * strong-optimized / mediated-with-plan), the mediated arm's plan-mode
 * wiring (the PCR-002 evaluation configuration — plan mode ON through
 * `ComposeExperimentOptions.recovery`, NEVER a code-path default), the
 * explicit outcome thresholds (ACR-008 §7), and the honest labels every
 * number carries.
 *
 * PROVENANCE (the exact-revision rule): the cell family is DERIVED from
 * the capstone's own cell enumeration (`experiments/ppr-027` — imported
 * read-only, never modified): every subject × volume × modality cell of
 * the MULTI provider configuration. The capstone's RECORDED numbers are
 * NEVER reused — all three arms re-run FRESH at ONE exact revision
 * (driver.ts); only the cell DEFINITIONS (the workload model and the
 * deterministic synthetic supply profiles) are shared, which is the
 * same declared experiment configuration the capstone ran on.
 *
 * HONEST LABELS (binding on every number this corpus's evaluation
 * emits): synthetic-supply (the declared deterministic fault/latency
 * profiles — never a live provider), synthetic-cost (the declared price
 * schedule — never a provider invoice), synthetic-latency (the drawn
 * deterministic profile — never wall-clock or live latency). No market
 * or production claims; a threshold miss with honest attribution is a
 * valid delivery (the program's truth discipline).
 */

import { createHash } from "node:crypto";
import type { ExperimentRecoveryPlanInputs } from "../../../../experiments/ppr-027/compose";
import type {
  ModalityKind,
  SubjectDefinition,
  VolumeKind,
} from "../../../../experiments/ppr-027/config";
import { allSweepCells } from "../../../../experiments/ppr-027/sweep";
import { canonicalJson } from "./canonical";

/** The plan-governing configuration's type — the LAB's own interface type (never `src/**`). */
export type RecoveryPlanConfiguration = ExperimentRecoveryPlanInputs["planConfiguration"];
/** A declared claim's type (the lab's interface type). */
export type CostClaim = ExperimentRecoveryPlanInputs["retryClaim"];
/** A governing constraint's type (the lab's interface type). */
export type OptimizationConstraint = ExperimentRecoveryPlanInputs["constraints"][number];

/** The evaluation's identity (the benchmark app's task kind). */
export const EVALUATION_ID = "economic-recovery-plan-evaluation";
/** The corpus version (pinned; a corpus change is a new version). */
export const CORPUS_VERSION = "pcr-003-recovery-plan-evaluation-v1";
/** The task kind the evaluation's corpus rows carry. */
export const TASK_KIND = "economic-recovery-plan-evaluation.experiment.v1";
/**
 * The governed base revision the evaluation runs at (the PCR-003 branch
 * point — the exact-revision rule: all three arms run FRESH at ONE
 * revision; this app's files are the only additions above it).
 */
export const BASE_REVISION = "ef86cf49972faf8ce102d2d9f5f53ce13e0d5d9a";

// ---------------------------------------------------------------------------
// The three pre-registered arms
// ---------------------------------------------------------------------------

/** The closed arm vocabulary (the pre-registered three-arm comparison). */
export const ARM_IDS = ["un-retried-direct", "strong-optimized", "mediated-with-plan"] as const;
export type ArmId = (typeof ARM_IDS)[number];

/** The arms' honest labels (carried on every artifact). */
export const ARM_LABELS: Readonly<Record<ArmId, string>> = {
  "un-retried-direct":
    "the un-retried direct arm — the same corpus-derived request stream dispatched straight to the primary synthetic supply, single attempt, no retry, no cache (BASELINE facts — never Zeck evidence)",
  "strong-optimized":
    "the strong-optimized non-Zeck baseline — the app-owned reliability machinery: a 3-attempt retry ladder, an app-owned provider fallback chain, an app-owned content-addressed response cache and a response-shape normalization shim (BASELINE facts — never Zeck evidence; never a strawman)",
  "mediated-with-plan":
    "the mediated-with-plan arm — the real Zeck public API stack (the PPR-027 composed experiment world: real gateway, rails, executions authority, ledger, idempotency) with plan mode ON through the PCR-002 evaluation configuration (ComposeExperimentOptions.recovery), composing the bounded recovery ladder [same-provider retry, alternate-provider failover] through the PCR-001 plan composer",
};

/** The maximum physical attempts per logical request each arm may take (the attempt economics). */
export const ARM_ATTEMPT_BOUNDS: Readonly<Record<ArmId, number>> = {
  "un-retried-direct": 1,
  "strong-optimized": 3,
  "mediated-with-plan": 3,
};

// ---------------------------------------------------------------------------
// The targeted cell family (the capstone's multi-provider gap territory)
// ---------------------------------------------------------------------------

/** One targeted evaluation cell (one multi-configuration sweep cell, namespaced for this evaluation's fresh runs). */
export interface EvaluationCell {
  /** This evaluation's cell id (namespaced — its stream keys draw a fresh, distinct deterministic space). */
  readonly cellId: string;
  /** The capstone cell id this cell targets (the 92.4% gap territory's own enumeration). */
  readonly capstoneCellId: string;
  readonly subjectId: string;
  readonly subject: SubjectDefinition;
  readonly volume: VolumeKind;
  readonly repetitions: number;
  readonly modality: ModalityKind;
  readonly providerConfig: "multi";
  readonly providerIds: readonly string[];
}

const MULTI_PROVIDER_IDS = ["supply-a", "supply-b", "supply-c"] as const;

/**
 * The targeted multi-provider cell family: every multi-configuration cell
 * of the capstone's sweep matrix (the cell family where the capstone
 * measured mediated resolution 92.4% vs single-provider 97.2% — the
 * PPR-027 observed-distributions byProviderConfig "multi" slice, 51
 * cells at the capstone's 102-cell matrix). Derived from the capstone's
 * OWN enumeration (`allSweepCells`, imported read-only) — never a
 * hand-picked subset (no cherry-picking: the family is the complete
 * multi-configuration slice).
 */
export const TARGETED_CELLS: readonly EvaluationCell[] = allSweepCells()
  .filter((cell) => cell.providerConfig === "multi")
  .map((cell) => ({
    cellId: `pcr003-${cell.cellId}`,
    capstoneCellId: cell.cellId,
    subjectId: cell.subject.subjectId,
    subject: cell.subject,
    volume: cell.volume,
    repetitions: cell.repetitions,
    modality: cell.modality,
    providerConfig: "multi" as const,
    providerIds: [...MULTI_PROVIDER_IDS],
  }));

/** The targeted cell ids (the pinned task slice). */
export const TARGETED_CELL_IDS: readonly string[] = TARGETED_CELLS.map((cell) => cell.cellId);

// ---------------------------------------------------------------------------
// The mediated-with-plan arm's plan-mode wiring (the PCR-002 evaluation
// configuration — plan mode ON, never a code-path default)
// ---------------------------------------------------------------------------

/**
 * The plan-governing configuration: the bounded recovery ladder the
 * strong baseline exercises, expressed in the recovery plane's own
 * bounds — maxRetryAttempts 2 admits the same-representation retry of
 * attempt 2 (frame 0: attemptsUsed 1 < 2) and refuses it at frame 1
 * (attemptsUsed 2 >= 2 — retry-attempt-bound, the honest inadmissibility
 * that forces the failover move); maxPlanSteps 2 bounds the plan to the
 * two-move ladder [same-provider retry, alternate-provider failover] —
 * 3 total attempts per logical request, the strong baseline's own
 * attempt bound. planMode "on" is the EVALUATION configuration (the
 * ComposeExperimentOptions.recovery path); the default everywhere else
 * is OFF.
 */
export const MEDIATED_PLAN_CONFIGURATION: RecoveryPlanConfiguration = {
  maxRetryAttempts: 2,
  escalationEvidenceBound: 8,
  continuationStepBound: 32,
  maxPlanSteps: 2,
  planMode: "on",
};

/** The governing quality facts (the assurance floor — inviolable). */
export const MEDIATED_PLAN_QUALITY_FACTS: ExperimentRecoveryPlanInputs["qualityFacts"] = {
  requiredQuality: 0.85,
};

/** The governing constraint set (hard constraints enforced). */
export const MEDIATED_PLAN_CONSTRAINTS: ExperimentRecoveryPlanInputs["constraints"] = [
  {
    constraintId: "pcr003-quality-floor",
    kind: "quality",
    enforcement: "hard",
    source: { authority: "planning" },
    payload: { minQuality: 0.8 },
  },
  {
    constraintId: "pcr003-budget-ceiling",
    kind: "budget",
    enforcement: "hard",
    source: {
      authority: "budget",
      budgetId: "pcr003-evaluation-budget",
      scopeKind: "per-execution",
    },
    payload: { maxCostMicroUsd: "1000000" },
  },
];

/**
 * The declared economics of the ladder's paths (EXPERIMENT
 * CONFIGURATION — synthetic, disclosed): the retry path's claim is the
 * CHEAPEST candidate (the least-disruptive representation-preserving
 * move composes first — the plane's own deterministic order: cost
 * ascending, then strategy rank with retry first); the alternate
 * supplies' claims order the failover target (the projected frame-1
 * incumbent supply-b is excluded by the wired seam's own projection, so
 * the failover selects supply-c — 420 < 500).
 */
export const MEDIATED_PLAN_RETRY_CLAIM: ExperimentRecoveryPlanInputs["retryClaim"] = {
  expectedCostMicroUsd: "300",
  expectedLatencyMs: 2000,
  expectedQuality: 0.92,
  expectedReliability: 0.95,
  basis: { basis: "estimated", source: "pcr-003:recovery:retry-path" },
};

/** The declared provider-failover alternates (capability-equal alternate supplies). */
export const MEDIATED_PLAN_PROVIDER_ALTERNATES: ExperimentRecoveryPlanInputs["providerAlternates"] =
  [
    {
      providerId: "supply-a",
      claim: {
        expectedCostMicroUsd: "500",
        expectedLatencyMs: 2400,
        expectedQuality: 0.92,
        expectedReliability: 0.95,
        basis: { basis: "estimated", source: "pcr-003:model-economics:alternate-a" },
      },
    },
    {
      providerId: "supply-b",
      claim: {
        expectedCostMicroUsd: "410",
        expectedLatencyMs: 1600,
        expectedQuality: 0.92,
        expectedReliability: 0.95,
        basis: { basis: "estimated", source: "pcr-003:model-economics:alternate-b" },
      },
    },
    {
      providerId: "supply-c",
      claim: {
        expectedCostMicroUsd: "420",
        expectedLatencyMs: 1900,
        expectedQuality: 0.92,
        expectedReliability: 0.95,
        basis: { basis: "estimated", source: "pcr-003:model-economics:alternate-c" },
      },
    },
  ];

/** The governed IR step the mediated arm's recovery decisions belong to (a generative step). */
export const MEDIATED_PLAN_STEP_ID = "generate";

/**
 * The composed ladder this wiring produces (verified in-suite against
 * the REAL composer): step 0 = same-provider retry (the retry claim is
 * the cheapest admissible candidate); step 1 = alternate-provider
 * failover to supply-c (the retry is retry-attempt-bound at frame 1;
 * supply-c is the cheapest declared alternate the wired seam's frame-1
 * projection admits). Terminal: bound-reached.
 */
export const EXPECTED_MEDIATED_LADDER = {
  steps: [
    {
      move: { kind: "retry" },
      attempt: 2,
      semantics: "same-provider retry (re-address the incumbent supply)",
    },
    {
      move: { kind: "re-route", dimension: "provider" },
      attempt: 3,
      route: "supply-c",
      semantics: "alternate-provider failover (the capability-equal alternate supply)",
    },
  ],
  terminal: "bound-reached",
  totalAttemptBound: 3,
} as const;

// ---------------------------------------------------------------------------
// The explicit outcome thresholds (ACR-008 §7 — the evaluation contract)
// ---------------------------------------------------------------------------

/** The closed threshold vocabulary (the four threshold families + the eligibility statement). */
export interface EvaluationThresholds {
  /** Resolution: mediated-with-plan equal-or-better than the FRESH strong-optimized arm in the targeted multi-provider cells. */
  readonly resolution: "equal-or-better-vs-fresh-strong-optimized";
  /** Failure-adjusted cost per resolved outcome: improved vs strong-optimized, or a documented tradeoff with attribution. */
  readonly cost: "improved-or-documented-tradeoff";
  /** Policy/budget violations: ZERO (the hard gate — any violation is delivery-blocking). */
  readonly violationsCeiling: 0;
  /** Latency tails: p95/p99 by failure class and route, explicit tradeoff accounting (no silent regressions). */
  readonly latencyTails: "explicit-p95-p99-tradeoff-accounting";
}

export const THRESHOLDS: EvaluationThresholds = {
  resolution: "equal-or-better-vs-fresh-strong-optimized",
  cost: "improved-or-documented-tradeoff",
  violationsCeiling: 0,
  latencyTails: "explicit-p95-p99-tradeoff-accounting",
};

/** The closed verdict vocabulary per threshold. */
export const THRESHOLD_VERDICTS = [
  "met",
  "missed",
  "documented-tradeoff",
  "accounted",
  "delivery-blocking",
] as const;
export type ThresholdVerdictKind = (typeof THRESHOLD_VERDICTS)[number];

// ---------------------------------------------------------------------------
// The honest labels (carried on every number the evaluation emits)
// ---------------------------------------------------------------------------

export const SYNTHETIC_LABELS = {
  supply:
    "synthetic-supply (the declared deterministic fault/latency profiles — never a live provider)",
  cost: "synthetic-cost (the declared price schedule — never a provider invoice)",
  latency:
    "synthetic-latency (the drawn deterministic supply profile — never wall-clock, never live latency)",
} as const;

/** The disclosure note carried on every cost figure (the capstone's own labeling law). */
export const COST_BASIS_NOTE =
  "cost figures are the synthetic supply's charge for every physical dispatch the arm made (the declared price schedule: full price on success, input-only partial on timeout, zero on rate-limit/unavailable; the mediated arm's deterministic substrate executions make zero supply dispatches — the PPR-024 plane, a disclosed structural difference; the baselines route substrate requests through the supply at the per-call schedule price) — experiment configuration, never provider invoices";

export const LATENCY_BASIS_NOTE =
  "latency figures are the drawn deterministic supply latencies summed over each logical request's physical attempts (the declared profiles; cross-arm deltas are the mediation structure, not live provider latency)";

// ---------------------------------------------------------------------------
// The pinned corpus digest (config pinning + arm digest integrity)
// ---------------------------------------------------------------------------

/** The canonical corpus projection the digest covers (deterministic — no timestamps, no run ids). */
export function evaluationCorpusForm(): Record<string, unknown> {
  return {
    version: CORPUS_VERSION,
    baseRevision: BASE_REVISION,
    arms: ARM_IDS.map((armId) => ({
      armId,
      label: ARM_LABELS[armId],
      attemptBound: ARM_ATTEMPT_BOUNDS[armId],
    })),
    targetedCells: TARGETED_CELLS.map((cell) => ({
      cellId: cell.cellId,
      capstoneCellId: cell.capstoneCellId,
      subjectId: cell.subjectId,
      volume: cell.volume,
      repetitions: cell.repetitions,
      modality: cell.modality,
      providerConfig: cell.providerConfig,
      providerIds: [...cell.providerIds],
    })),
    mediatedPlanWiring: {
      configuration: MEDIATED_PLAN_CONFIGURATION,
      qualityFacts: MEDIATED_PLAN_QUALITY_FACTS,
      constraints: MEDIATED_PLAN_CONSTRAINTS,
      retryClaim: MEDIATED_PLAN_RETRY_CLAIM,
      providerAlternates: MEDIATED_PLAN_PROVIDER_ALTERNATES,
      stepId: MEDIATED_PLAN_STEP_ID,
      expectedLadder: EXPECTED_MEDIATED_LADDER,
    },
    thresholds: THRESHOLDS,
    labels: SYNTHETIC_LABELS,
  };
}

/** The pinned corpus digest (sha256 over the canonical corpus form — stable across runs). */
export function pinnedEvaluationCorpusDigest(): string {
  return createHash("sha256").update(canonicalJson(evaluationCorpusForm())).digest("hex");
}
