/**
 * Recovery strategy selection (platform failure-recovery plane; WORK-055 /
 * E1.1 — ADR-0019, ADR-0020 "economically appropriate recovery
 * strategies").
 *
 * THE PURE RECOVERY DECISION: given ONE attributed failure (typed,
 * evidence-bound — `attribution.ts`), the recovery context (attempt
 * history, the incumbent representation facts), the economics facts
 * of each recovery path, and the bounded configuration, select ONE
 * closed strategy — retry / re-route / escalate-fresh — or the
 * zero-recovery `fail-closed` outcome. Pure function of its inputs,
 * deterministic INCLUDING tie-breaks (architecture invariant 5),
 * idempotent on re-run (byte-identical output), fail-closed on every
 * unmet precondition (invariants 6 and 7).
 *
 * ECONOMICS, NOT AUTHORITY (invariant 2): every strategy candidate
 * carries an explicit-basis `CostClaim` exactly like the foundation's
 * candidate representations, and runs through the model-economics
 * plane's SHARED admissibility machinery (imported read-only — the
 * merged WORK-053 plane's `governingFacts` / `evaluateAdmissibility`:
 * quality floors are inviolable, hard budget/latency ceilings bind,
 * policy route restrictions apply). Recovery economics stay BOUNDED
 * EVIDENCE: budgets, policy, capabilities and verification remain the
 * authorities — this selection is a recorded decision input consumed
 * through the existing seams, never an authorization.
 *
 * RE-ROUTE MEANS CONSULT THE ECONOMICS PLANES (AC 5): model re-route
 * consumes the model-economics plane's typed `ModelSelection` over its
 * ORIGINAL declared candidates (the caller runs
 * `selectModelRepresentation` and passes the result — read-only
 * facts); substrate re-route consumes the substrate-economics plane's
 * typed `SubstrateSelectionResult` (the caller runs `selectSubstrate`).
 * This plane NEVER re-implements their economics — the re-route
 * candidates' claims derive from the planes' OWN typed selected
 * verdicts with their own basis attributions, and their no-selection
 * outcomes make the dimension inadmissible (typed reason, never a
 * silent default route/substrate).
 *
 * THE RETRY DISCIPLINE (no generic-failure retry loops):
 *  - retry requires the attribution class to be retryable AND
 *    (infrastructure) a TRANSIENT observation AND attempts remaining
 *    under the configuration bound — intelligence failures are NEVER
 *    same-representation-retryable (ADR-0020's runaway-token-inflation
 *    trap), budget exhaustion is never retryable (the budget authority
 *    stays the authority), non-transient infrastructure failures need
 *    re-route/escalation, not blind retries;
 *  - every admissible retry carries its economics (the explicit-basis
 *    retry claim against the governing floors/ceilings) — a retry
 *    without economic justification is inadmissible.
 *
 * ESCALATION IS EVIDENCE-DRIVEN (never self-authorizing): the
 * escalate-fresh candidate is admissible only when the caller supplies
 * the model-economics plane's typed `FreshEscalationDecision` with
 * kind `escalate-fresh-context` (WORK-053's fresh-escalation decision
 * hook — the economic justification) AND the escalation path claim
 * passes the governing floors/ceilings.
 *
 * THE ACR-008 §3 MOVE-CATALOG EXTENSION (fail-closed, composed into
 * the SAME selection — never a second selection path):
 *  - PROVIDER-FAILOVER RE-ROUTE: the re-route dimensions grow from
 *    model | substrate to model | substrate | provider — a
 *    capability-equal alternate SUPPLY route for the same selected
 *    representation, consumed through the supply plane's OWN typed
 *    selection verdict passed in by the caller (read-only facts,
 *    exactly the model/substrate re-route discipline: a no-selection
 *    outcome makes the dimension inadmissible with a typed reason,
 *    never a silent default);
 *  - CONTEXT-REPAIR: admissible only for attributed context-corruption
 *    failure classes (the closed CONTEXT_REPAIRABLE_CLASSES table) AND
 *    only when the caller supplies the typed repair-capability verdict
 *    (a bounded reconstruction directive over the governed context
 *    representation — this plane never edits context itself);
 *  - VERIFIER-ESCALATION: admissible only for attributed
 *    semantic-quality-suspect outcomes AND only when the caller
 *    supplies the verification authority's typed escalation decision
 *    through the existing verification escalation seam (assurance
 *    depth may increase, never decrease — invariant 19); a
 *    depth-reducing or depth-flat escalation verdict is a typed
 *    rejection, never a silent default.
 * Every new move carries an explicit-basis `CostClaim` through the
 * shared admissibility machinery exactly like the existing candidates
 * — a move without economic justification is inadmissible.
 *
 * THE DETERMINISTIC ORDER: expected successful-resolution cost
 * ascending, ties broken by strategy rank (retry first — the least
 * disruptive representation-preserving path; then re-route; then
 * context-repair — a bounded reconstruction of the corrupted context;
 * then escalate-fresh; then verifier-escalation — the assurance-
 * deepening terminal remedy), then by candidateId. Every tie resolves
 * on content: non-deterministic tie-breaks are impossible by
 * construction (discrimination-tested).
 */

import type { OptimizationConstraint } from "../execution-ir/constraints";
import { validateConstraintSet } from "../execution-ir/constraints";
import type { CandidateEvaluation, CostClaim } from "../execution-ir/cost-model";
import type { IrDigestPort } from "../execution-ir/ir";
import type { GoverningFacts } from "../model-economics/admissibility";
import { evaluateAdmissibility, governingFacts } from "../model-economics/admissibility";
import type { FreshEscalationDecision } from "../model-economics/escalation-hooks";
import type { ModelSelection } from "../model-economics/model-selection";
import type { ModelCandidate, QualityFacts } from "../model-economics/vocabulary";
import { validateQualityFacts } from "../model-economics/vocabulary";
import type { SubstrateSelectionResult } from "../substrate-economics/selection";
import type { FailureAttribution } from "./attribution";
import { validateFailureAttribution } from "./attribution";
import {
  boundedDetail,
  COMPONENT_REF_PATTERN,
  CONTEXT_REPAIRABLE_CLASSES,
  type FailureClass,
  MAX_PLAN_STEPS,
  MAX_RETRY_ATTEMPTS,
  RECOVERY_PLAN_MODES,
  type RecoveryFailClosedCode,
  type RecoveryInadmissibleCode,
  type RecoveryPlanMode,
  type RecoveryStrategy,
  type RerouteDimension,
  reject,
  SHA256_HEX_PATTERN,
  VERIFICATION_DEPTH_RANK,
  VERIFICATION_DEPTHS,
  type VerificationDepth,
} from "./catalog";
import {
  measuredProvenanceOf,
  type ObservedReliabilityFacts,
  type ObservedRouteReliability,
  validateObservedReliabilityFacts,
} from "./measured";

// ---------------------------------------------------------------------------
// The selection input (typed, bounded, total)
// ---------------------------------------------------------------------------

/**
 * The bounded recovery configuration — EXPLICIT policy inputs (never
 * ambient, never self-raising): the retry attempt bound, the bounds
 * the escalation/continuation constructors share, and (ACR-008 §2)
 * the recovery-plan step bound. The plan bound is OPTIONAL here — the
 * single-decision selection surface is preserved byte-for-byte for
 * its existing callers — and MANDATORY at the plan-composition seam
 * (`RecoveryPlanConfiguration` in `plan.ts` rejects its absence, so
 * the bound can never be ambient or defaulted).
 */
export interface RecoveryConfiguration {
  /** The maximum retry attempts the policy admits ([0, 10]). */
  readonly maxRetryAttempts: number;
  /** The evidence-entry bound for escalation packages ([1, 64]). */
  readonly escalationEvidenceBound: number;
  /** The step bound for continuation packages ([1, 256]). */
  readonly continuationStepBound: number;
  /** The step bound for recovery plans ([1, 16]) — validated when present. */
  readonly maxPlanSteps?: number;
  /**
   * The recovery-plan composition mode (ACR-008 §6; PCR-002) — DEFAULT
   * OFF: an ABSENT planMode is `off` (the byte-preserved current
   * posture at the wired seam). `on` is an evaluation/tenant
   * configuration ONLY; the wiring fails closed without its explicit
   * plan inputs — no code path promotes plan mode by default.
   */
  readonly planMode?: RecoveryPlanMode;
}

/** Total, deterministic validation of the recovery configuration. */
export function validateRecoveryConfiguration(value: RecoveryConfiguration): RecoveryConfiguration {
  if (typeof value !== "object" || value === null) {
    reject("recovery-input-shape", "recovery configuration must be an object");
  }
  const record = value as unknown as Record<string, unknown>;
  if (
    typeof record.maxRetryAttempts !== "number" ||
    !Number.isInteger(record.maxRetryAttempts) ||
    record.maxRetryAttempts < 0 ||
    record.maxRetryAttempts > MAX_RETRY_ATTEMPTS
  ) {
    reject("recovery-input-shape", "maxRetryAttempts must be an integer in [0, 10]", {
      got: boundedDetail(String(record.maxRetryAttempts)),
    });
  }
  if (
    typeof record.escalationEvidenceBound !== "number" ||
    !Number.isInteger(record.escalationEvidenceBound) ||
    record.escalationEvidenceBound < 1 ||
    record.escalationEvidenceBound > 64
  ) {
    reject("recovery-input-shape", "escalationEvidenceBound must be an integer in [1, 64]");
  }
  if (
    typeof record.continuationStepBound !== "number" ||
    !Number.isInteger(record.continuationStepBound) ||
    record.continuationStepBound < 1 ||
    record.continuationStepBound > 256
  ) {
    reject("recovery-input-shape", "continuationStepBound must be an integer in [1, 256]");
  }
  if (record.maxPlanSteps !== undefined) {
    if (
      typeof record.maxPlanSteps !== "number" ||
      !Number.isInteger(record.maxPlanSteps) ||
      record.maxPlanSteps < 1 ||
      record.maxPlanSteps > MAX_PLAN_STEPS
    ) {
      reject("recovery-input-shape", `maxPlanSteps must be an integer in [1, ${MAX_PLAN_STEPS}]`);
    }
  }
  if (
    record.planMode !== undefined &&
    !(RECOVERY_PLAN_MODES as readonly string[]).includes(record.planMode as string)
  ) {
    reject("recovery-input-shape", "planMode is outside the closed vocabulary", {
      got: boundedDetail(String(record.planMode)),
    });
  }
  return value;
}

/**
 * The recovery context: the attempt history and the incumbent
 * representation facts (WHERE the failure happened — read-only
 * context, never authority).
 */
export interface RecoveryContext {
  /** The execution the recovery decides for, when bound. */
  readonly executionId?: string;
  /** The governed IR step the failure was observed at. */
  readonly stepId?: string;
  /** Retry attempts already used for this logical operation ([0, 10]). */
  readonly attemptsUsed: number;
  /** The incumbent model route, when the failing work is route-bound. */
  readonly incumbentRoute?: { readonly provider: string; readonly model: string };
  /** The incumbent substrate, when the failing work is substrate-bound. */
  readonly incumbentSubstrate?: { readonly substrateId: string; readonly version: string };
}

/** Total, deterministic validation of the recovery context. */
export function validateRecoveryContext(value: RecoveryContext): RecoveryContext {
  if (typeof value !== "object" || value === null) {
    reject("recovery-input-shape", "recovery context must be an object");
  }
  const record = value as unknown as Record<string, unknown>;
  if (
    typeof record.attemptsUsed !== "number" ||
    !Number.isInteger(record.attemptsUsed) ||
    record.attemptsUsed < 0 ||
    record.attemptsUsed > MAX_RETRY_ATTEMPTS
  ) {
    reject("recovery-input-shape", "attemptsUsed must be an integer in [0, 10]", {
      got: boundedDetail(String(record.attemptsUsed)),
    });
  }
  if (record.executionId !== undefined && typeof record.executionId !== "string") {
    reject("recovery-input-shape", "executionId must be a string when present");
  }
  if (record.stepId !== undefined && typeof record.stepId !== "string") {
    reject("recovery-input-shape", "stepId must be a string when present");
  }
  if (record.incumbentRoute !== undefined) {
    const route = record.incumbentRoute as { provider?: unknown; model?: unknown };
    if (typeof route?.provider !== "string" || typeof route?.model !== "string") {
      reject("recovery-input-shape", "incumbentRoute must carry provider/model when present");
    }
  }
  if (record.incumbentSubstrate !== undefined) {
    const substrate = record.incumbentSubstrate as {
      substrateId?: unknown;
      version?: unknown;
    };
    if (typeof substrate?.substrateId !== "string" || typeof substrate?.version !== "string") {
      reject(
        "recovery-input-shape",
        "incumbentSubstrate must carry substrateId/version when present",
      );
    }
  }
  return value;
}

/** The retry path's explicit-basis facts. */
export interface RetryFacts {
  /** The next attempt's number (attemptsUsed + 1, validated coherent). */
  readonly nextAttempt: number;
  /** The retry path's explicit-basis claim (bounded, attributed). */
  readonly claim: CostClaim;
}

/**
 * The model re-route facts — the model-economics plane's typed
 * selection over its ORIGINAL declared candidates, both read-only
 * (the claim derivation needs the selected candidate's own claim
 * values — never re-implemented economics).
 */
export interface ModelRerouteFacts {
  /** The model-economics plane's selection result (read-only facts). */
  readonly selection: ModelSelection;
  /** The ORIGINAL declared candidates the selection ran on. */
  readonly declaredCandidates: readonly ModelCandidate[];
}

/** The substrate re-route facts — the substrate-economics plane's result, read-only. */
export interface SubstrateRerouteFacts {
  /** The substrate-economics plane's selection result (read-only facts). */
  readonly selection: SubstrateSelectionResult;
}

/**
 * The provider-failover re-route facts (ACR-008 §3.1): the supply
 * plane's OWN typed selection over its capability-equal alternate
 * routes for the SAME selected representation, read-only — exactly the
 * model re-route discipline (the claim derivation needs the selected
 * candidate's own claim values; this plane never re-implements the
 * supply plane's economics; a no-selection outcome makes the dimension
 * inadmissible with a typed reason, never a silent default route).
 */
export interface ProviderRerouteFacts {
  /** The supply plane's selection result over the provider-alternate corpus (read-only facts). */
  readonly selection: ModelSelection;
  /** The ORIGINAL declared provider-alternate candidates the selection ran on. */
  readonly declaredCandidates: readonly ModelCandidate[];
}

/** The re-route path's facts — the economics/supply planes' typed results, read-only. */
export interface RerouteFacts {
  /** Model re-selection facts, when a model re-route was offered. */
  readonly model: ModelRerouteFacts | null;
  /** Substrate re-selection facts, when a substrate re-route was offered. */
  readonly substrate: SubstrateRerouteFacts | null;
  /** Provider-failover facts, when a provider re-route was offered (ACR-008 §3.1). */
  readonly provider?: ProviderRerouteFacts | null;
}

/** The fresh-escalation path's facts. */
export interface EscalationFacts {
  /**
   * The model-economics plane's fresh-escalation decision hook value
   * (the caller runs `decideFreshEscalation`; kind
   * `escalate-fresh-context` is the economic justification — this
   * plane never self-authorizes escalation).
   */
  readonly decision: FreshEscalationDecision;
  /** The escalation path's explicit-basis claim (bounded, attributed). */
  readonly claim: CostClaim;
}

// ---------------------------------------------------------------------------
// The ACR-008 §3 new moves' facts (typed verdicts the CALLER supplies)
// ---------------------------------------------------------------------------

/**
 * A bounded context-repair reconstruction directive — DATA over the
 * governed context representation, consumed by the caller's context
 * authority at its own seam. This plane never edits context itself
 * (ACR-008 §3.2): the directive names WHAT the context authority
 * rebuilds, never how this plane would touch a context value.
 */
export interface ContextRepairDirective {
  /** The bounded neutral repair-strategy slug (the context authority's own vocabulary, opaque here). */
  readonly strategy: string;
  /** The content-addressed anchor the reconstruction resumes from, when bound (sha256 hex). */
  readonly anchorDigest?: string;
}

/**
 * The caller's typed repair-capability verdict — the context
 * authority's own decision whether a bounded reconstruction of the
 * governed context is possible, passed in read-only. `repair-capable`
 * requires its bounded reconstruction directive; any other outcome
 * leaves the move inadmissible with the typed reason (never a silent
 * default repair).
 */
export type ContextRepairCapability =
  | { readonly kind: "repair-capable"; readonly directive: ContextRepairDirective }
  | { readonly kind: "repair-not-capable" };

/** The context-repair path's facts. */
export interface ContextRepairFacts {
  /** The caller's typed repair-capability verdict (read-only). */
  readonly capability: ContextRepairCapability;
  /** The repair path's explicit-basis claim (bounded, attributed). */
  readonly claim: CostClaim;
}

/**
 * The verification authority's typed verifier-escalation decision —
 * the NEUTRAL consumed shape of the EXISTING verification escalation
 * seam's verdict (the caller runs the authority's escalation decision
 * and passes the result read-only; this plane never re-decides
 * verification depth). The depth ladder is the closed
 * VERIFICATION_DEPTHS mirror; escalation may only INCREASE depth
 * (invariant 19 — a depth-reducing or depth-flat escalation verdict
 * is a typed rejection, never a silent default).
 */
export interface VerifierEscalationDecision {
  /** `escalate-verification` — the authority justified deeper verification; `verification-sufficient` — the incumbent depth stands; `no-admissible-evaluation` — neither depth is admissible (the honest typed outcome). */
  readonly kind: "escalate-verification" | "verification-sufficient" | "no-admissible-evaluation";
  /** The incumbent assurance depth (the floor the escalation starts from). */
  readonly fromDepth: VerificationDepth;
  /** The escalation target depth (must strictly exceed fromDepth when escalating). */
  readonly toDepth: VerificationDepth;
  /** The verification evidence identity binding (the suspect outcome's evaluation), when bound. */
  readonly verificationId?: string;
}

/** The verifier-escalation path's facts. */
export interface VerifierEscalationFacts {
  /** The verification authority's typed escalation decision (read-only). */
  readonly decision: VerifierEscalationDecision;
  /** The verifier-escalation path's explicit-basis claim (bounded, attributed). */
  readonly claim: CostClaim;
}

/** The economics facts of every recovery path. */
export interface RecoveryFacts {
  /** The retry path's facts, when a retry is representable at all. */
  readonly retry: RetryFacts | null;
  /** The re-route dimensions' facts (the economics/supply planes, read-only). */
  readonly reroute: RerouteFacts;
  /** The fresh-escalation path's facts, when representable. */
  readonly escalation: EscalationFacts | null;
  /** The context-repair path's facts, when offered (ACR-008 §3.2). */
  readonly contextRepair?: ContextRepairFacts | null;
  /** The verifier-escalation path's facts, when offered (ACR-008 §3.3). */
  readonly verifierEscalation?: VerifierEscalationFacts | null;
}

/** The strategy-selection input (everything, explicitly). */
export interface RecoverySelectionInput {
  /** The attributed failure — REQUIRED (no attribution → no recovery action). */
  readonly attribution: FailureAttribution;
  /** The recovery context (attempt history, incumbent facts). */
  readonly context: RecoveryContext;
  /** The economics facts of each recovery path. */
  readonly facts: RecoveryFacts;
  /** The quality facts (the assurance floor — inviolable). */
  readonly qualityFacts: QualityFacts;
  /** The governing constraint set (hard constraints enforced). */
  readonly constraints: readonly OptimizationConstraint[];
  /** The bounded recovery configuration (explicit policy inputs). */
  readonly configuration: RecoveryConfiguration;
  /**
   * The observed-reliability facts — the OPTIONAL measured-evidence
   * input (ACR-008 §4; PCR-002). ABSENCE (undefined or null) is the
   * default state and selects byte-identically to the declared-
   * facts-only selection (the reorder pass never runs — discrimination-
   * tested); PRESENCE may reorder candidate preferences among the
   * ALREADY-admissible verdicts, never their admissibility.
   */
  readonly measured?: ObservedReliabilityFacts | null;
  /** The digest port (content addressing — injected, never ambient). */
  readonly digest: IrDigestPort;
}

// ---------------------------------------------------------------------------
// Strategy candidates and verdicts
// ---------------------------------------------------------------------------

/** One candidate recovery path (a strategy instance with its economics). */
export interface StrategyCandidate {
  /** The neutral candidate slug (unique within one selection). */
  readonly candidateId: string;
  /** The closed strategy this candidate instantiates. */
  readonly strategy: RecoveryStrategy;
  /** The re-route dimension (re-route candidates only). */
  readonly rerouteDimension?: RerouteDimension;
  /** The candidate's explicit-basis claim (bounded, attributed). */
  readonly claim: CostClaim;
}

/**
 * The per-strategy verdict: admissibility over the closed reason-code
 * vocabulary, the WORK-049 evaluation (present whenever a claim
 * exists — the auditable comparison evidence), and the bounded
 * inadmissibility detail. Every verdict carries the ATTRIBUTION
 * identity it was decided under (exact provenance: failure
 * observation → attribution → recovery decision).
 */
export interface StrategyVerdict {
  readonly candidateId: string;
  readonly strategy: RecoveryStrategy;
  /** The attribution this verdict was decided under (provenance). */
  readonly attributionId: string;
  readonly rerouteDimension?: RerouteDimension;
  readonly representationClass: string;
  /** False when the strategy violates the retry/escalation discipline or the economics. */
  readonly admissible: boolean;
  /** EXACTLY ONE closed reason code when inadmissible (never silent). */
  readonly inadmissibleCode?: RecoveryInadmissibleCode;
  /** The bounded human-auditable inadmissibility detail. */
  readonly inadmissibleDetail?: string;
  /** The WORK-049 evaluation (present whenever a claim exists). */
  readonly evaluation?: CandidateEvaluation;
}

/** The frozen selection-basis statement. */
export const RECOVERY_SELECTION_BASIS =
  "attribution-before-action;retry-requires-typed-retryable-class-and-transient-and-attempts-and-economics;reroute-consumes-economics-planes-facts;escalation-requires-fresh-escalation-hook-justification;context-repair-requires-repairable-class-and-capability-verdict;verifier-escalation-requires-quality-suspect-outcome-and-authority-justification-and-depth-increase;quality-floors-inviolable;cost-ascending-then-strategy-rank-then-candidateId;fail-closed-when-none-admissible";

/** The strategy-selection result. */
export interface RecoverySelection {
  /**
   * `recover` — an actionable strategy was selected (retry/re-route/
   * escalate-fresh, economically justified);
   * `fail-closed` — the zero-recovery outcome (the honest typed
   * result when no strategy is admissible — invariant 7).
   */
  readonly kind: "recover" | "fail-closed";
  /** The selected verdict, or null when fail-closed. */
  readonly selected: StrategyVerdict | null;
  /** The typed fail-closed reason (fail-closed only). */
  readonly failClosedCode?: RecoveryFailClosedCode;
  /** Every candidate's verdict (the auditable comparison evidence). */
  readonly verdicts: readonly StrategyVerdict[];
  /** The governing facts the selection ran under. */
  readonly facts: GoverningFacts;
  /** The frozen, human-auditable selection basis. */
  readonly selectionBasis: string;
  /**
   * The measured-facts provenance (ACR-008 §4; PCR-002) — present IFF
   * the selection consumed observed-reliability facts (the auditable
   * which-observations/which-window statement). ABSENT when the
   * selection ran declared-facts-only — the byte-identical default.
   */
  readonly measuredProvenance?: string;
}

// ---------------------------------------------------------------------------
// The retryability discipline (typed, closed)
// ---------------------------------------------------------------------------

/**
 * The class-specific retryability table: WHICH attributed classes may
 * take a same-representation retry at all. Intelligence failures are
 * absent by design (retrying the same model on a quality failure is
 * the runaway-token-inflation trap ADR-0020 forbids); resource-budget
 * exhaustion is excluded in the discipline check (the budget
 * authority stays the authority); non-transient infrastructure
 * failures are excluded by the transient requirement.
 */
export const RETRYABLE_CLASSES: readonly FailureClass[] = [
  "infrastructure",
  "provider",
  "resource",
];

/** The deterministic strategy rank (tie-break order — the disruption ladder). */
export const STRATEGY_RANK: Readonly<Record<RecoveryStrategy, number>> = {
  retry: 0,
  "re-route": 1,
  "context-repair": 2,
  "escalate-fresh": 3,
  "verifier-escalation": 4,
  fail: 5,
};

const VERDICT_CLASS = "sufficient-model";

// ---------------------------------------------------------------------------
// The selection (pure, deterministic, total)
// ---------------------------------------------------------------------------

/**
 * Select the recovery strategy. THE pure decision: attribution →
 * candidate assembly → shared admissibility (the model-economics
 * plane's own machinery, imported read-only) → the deterministic
 * total order → the selected strategy or the typed fail-closed
 * outcome.
 */
export function selectRecoveryStrategy(input: RecoverySelectionInput): RecoverySelection {
  const attribution = validateFailureAttribution(input.attribution, input.digest);
  const context = validateRecoveryContext(input.context);
  const configuration = validateRecoveryConfiguration(input.configuration);
  const qualityFacts = validateQualityFacts(input.qualityFacts);
  const constraints = validateConstraintSet(input.constraints);
  if (input.facts === undefined || input.facts === null || typeof input.facts !== "object") {
    reject("recovery-input-shape", "the selection requires its recovery facts");
  }
  const facts = input.facts;
  const governing = governingFacts(qualityFacts, constraints);

  const candidates: StrategyCandidate[] = [];
  const structural: StrategyVerdict[] = [];
  const disciplineVerdicts: StrategyVerdict[] = [];
  // The candidate route registry (ACR-008 §4; PCR-002): the measured-
  // evidence preference pass resolves each candidate's route through
  // this registry — populated during candidate assembly, consumed ONLY
  // by the ordering of the already-admissible verdicts (never by the
  // admissibility machinery — the invariant-13 boundary is structural).
  const candidateRoutes = new Map<string, { provider: string; model: string }>();

  // --- RETRY: the typed retryability discipline -------------------------
  if (facts.retry !== null && facts.retry !== undefined) {
    if (
      typeof facts.retry.nextAttempt !== "number" ||
      !Number.isInteger(facts.retry.nextAttempt) ||
      facts.retry.nextAttempt !== context.attemptsUsed + 1
    ) {
      reject("recovery-input-shape", "retry facts must carry the coherent next attempt number", {
        attemptsUsed: context.attemptsUsed,
        nextAttempt: boundedDetail(String(facts.retry.nextAttempt)),
      });
    }
    const retryClaim = facts.retry.claim;
    let code: RecoveryInadmissibleCode | undefined;
    let detail: string | undefined;
    if (!RETRYABLE_CLASSES.includes(attribution.failureClass)) {
      code = "class-not-retryable";
      detail =
        attribution.failureClass === "intelligence"
          ? "intelligence failures are never retried on the same representation (re-route or escalate)"
          : `failure class ${attribution.failureClass} is not same-representation-retryable`;
    } else if (
      attribution.failureClass === "resource" &&
      attribution.evidence.kind === "resource" &&
      attribution.evidence.resourceKind === "budget"
    ) {
      code = "budget-resource-not-retryable";
      detail = "budget exhaustion is a budget-authority signal, never a retry trigger";
    } else if (
      attribution.failureClass === "infrastructure" &&
      attribution.evidence.kind === "infrastructure" &&
      !(attribution.evidence as { transient?: unknown }).transient
    ) {
      code = "retry-not-transient";
      detail = "a non-transient infrastructure failure needs re-route or escalation, not a retry";
    } else if (context.attemptsUsed >= configuration.maxRetryAttempts) {
      code = "retry-attempt-bound";
      detail = `attempts used ${context.attemptsUsed} reached the configured bound ${configuration.maxRetryAttempts}`;
    }
    const candidate: StrategyCandidate = {
      candidateId: `retry-attempt-${facts.retry.nextAttempt}`,
      strategy: "retry",
      claim: retryClaim,
    };
    if (context.incumbentRoute !== undefined) {
      candidateRoutes.set(candidate.candidateId, { ...context.incumbentRoute });
    }
    const evaluation = evaluateAdmissibility(
      {
        candidateId: candidate.candidateId,
        representationClass: VERDICT_CLASS,
        claim: retryClaim,
      },
      governing,
    );
    if (code === undefined && !evaluation.admissible) {
      // The discipline passed; the economics rejected the retry claim
      // (quality/reliability floors, budget/latency ceilings).
      code = economicsCodeOf(evaluation.inadmissibleCode);
      detail = `the retry claim failed the governing economics (${evaluation.inadmissibleCode ?? "unknown"})`;
    }
    if (code === undefined) {
      candidates.push(candidate);
    } else {
      disciplineVerdicts.push({
        candidateId: candidate.candidateId,
        strategy: "retry",
        attributionId: attribution.attributionId,
        representationClass: VERDICT_CLASS,
        admissible: false,
        inadmissibleCode: code,
        inadmissibleDetail: boundedDetail(detail ?? code),
        evaluation: evaluation.evaluation,
      });
    }
  }

  // --- RE-ROUTE (model): consult the model-economics plane, read-only ----
  if (facts.reroute.model !== null && facts.reroute.model !== undefined) {
    const modelFacts = facts.reroute.model;
    const selected = modelFacts.selection.selected;
    if (selected === null) {
      structural.push({
        candidateId: "reroute-model",
        strategy: "re-route",
        attributionId: attribution.attributionId,
        rerouteDimension: "model",
        representationClass: VERDICT_CLASS,
        admissible: false,
        inadmissibleCode: "no-alternative-route",
        inadmissibleDetail:
          "the model-economics selection found no admissible alternative route (or the incumbent route)",
      });
    } else if (
      context.incumbentRoute !== undefined &&
      selected.route.provider === context.incumbentRoute.provider &&
      selected.route.model === context.incumbentRoute.model
    ) {
      structural.push({
        candidateId: "reroute-model",
        strategy: "re-route",
        attributionId: attribution.attributionId,
        rerouteDimension: "model",
        representationClass: VERDICT_CLASS,
        admissible: false,
        inadmissibleCode: "no-alternative-route",
        inadmissibleDetail:
          "the model-economics selection re-selected the incumbent route (no alternative exists)",
      });
    } else {
      // The claim derives from the model-economics plane's OWN selected
      // verdict and its ORIGINAL declared candidate — never
      // re-implemented economics (the plane's evaluation carries the
      // expected successful-resolution cost; the declared candidate's
      // claim carries quality/reliability/latency and the basis).
      const declared = modelFacts.declaredCandidates.find(
        (candidate) => candidate.candidateId === selected.candidateId,
      );
      if (declared === undefined) {
        reject(
          "strategy-shape",
          "the model re-route facts lost the selected candidate's declared claim",
          { selectedId: selected.candidateId },
        );
      }
      candidates.push({
        candidateId: "reroute-model",
        strategy: "re-route",
        rerouteDimension: "model",
        claim: {
          expectedCostMicroUsd: selected.evaluation.expectedSuccessfulResolutionCostMicroUsd,
          expectedLatencyMs: declared.claim.expectedLatencyMs,
          expectedQuality: declared.claim.expectedQuality,
          expectedReliability: declared.claim.expectedReliability,
          basis: {
            basis: declared.claim.basis.basis,
            source:
              `model-economics;route=${selected.route.provider}/${selected.route.model}`.slice(
                0,
                200,
              ),
            ...(declared.claim.basis.evidenceDigest === undefined
              ? {}
              : { evidenceDigest: declared.claim.basis.evidenceDigest }),
          },
        },
      });
      candidateRoutes.set("reroute-model", { ...selected.route });
    }
  }

  // --- RE-ROUTE (substrate): consult the substrate-economics plane -------
  if (facts.reroute.substrate !== null && facts.reroute.substrate !== undefined) {
    const substrateSelection = facts.reroute.substrate.selection;
    if (substrateSelection.selected === null) {
      structural.push({
        candidateId: "reroute-substrate",
        strategy: "re-route",
        attributionId: attribution.attributionId,
        rerouteDimension: "substrate",
        representationClass: VERDICT_CLASS,
        admissible: false,
        inadmissibleCode: "no-substrate-selection",
        inadmissibleDetail:
          "the substrate-economics selection found no sufficient substrate (or none was offered)",
      });
    } else {
      const selectedSubstrate = substrateSelection.selected;
      candidates.push({
        candidateId: "reroute-substrate",
        strategy: "re-route",
        rerouteDimension: "substrate",
        claim: {
          expectedCostMicroUsd:
            selectedSubstrate.economics.expectedSuccessfulResolutionCostMicroUsd,
          expectedLatencyMs: selectedSubstrate.economics.totalLatencyMs,
          expectedQuality: selectedSubstrate.economics.execution.expectedQuality,
          expectedReliability: selectedSubstrate.economics.execution.expectedReliability,
          basis: {
            basis: selectedSubstrate.economics.execution.basis.basis,
            source: `substrate-economics:${substrateSelection.record.selectionId}`.slice(0, 200),
            ...(selectedSubstrate.economics.execution.basis.evidenceDigest === undefined
              ? {}
              : { evidenceDigest: selectedSubstrate.economics.execution.basis.evidenceDigest }),
          },
        },
      });
    }
  }

  // --- RE-ROUTE (provider): the supply plane's own failover verdict ------
  if (facts.reroute.provider !== null && facts.reroute.provider !== undefined) {
    const providerFacts = facts.reroute.provider;
    const selected = providerFacts.selection.selected;
    if (selected === null) {
      // The no-selection outcome: inadmissible with the typed reason,
      // never a silent default route (the ACR-008 §3.1 discipline).
      structural.push({
        candidateId: "reroute-provider",
        strategy: "re-route",
        attributionId: attribution.attributionId,
        rerouteDimension: "provider",
        representationClass: VERDICT_CLASS,
        admissible: false,
        inadmissibleCode: "no-provider-selection",
        inadmissibleDetail:
          "the supply selection found no admissible provider-failover route (or none was offered)",
      });
    } else if (
      context.incumbentRoute !== undefined &&
      selected.route.provider === context.incumbentRoute.provider &&
      selected.route.model === context.incumbentRoute.model
    ) {
      structural.push({
        candidateId: "reroute-provider",
        strategy: "re-route",
        attributionId: attribution.attributionId,
        rerouteDimension: "provider",
        representationClass: VERDICT_CLASS,
        admissible: false,
        inadmissibleCode: "no-alternative-provider",
        inadmissibleDetail:
          "the supply selection re-selected the incumbent provider route (no provider alternative exists)",
      });
    } else if (
      context.incumbentRoute !== undefined &&
      selected.route.model !== context.incumbentRoute.model
    ) {
      // A capability-EQUAL alternate for the SAME selected
      // representation: a different model is the model dimension's
      // move, never a provider failover (fail-closed on the dimension's
      // own semantics — the misattributed move is unrepresentable).
      structural.push({
        candidateId: "reroute-provider",
        strategy: "re-route",
        attributionId: attribution.attributionId,
        rerouteDimension: "provider",
        representationClass: VERDICT_CLASS,
        admissible: false,
        inadmissibleCode: "provider-route-not-same-representation",
        inadmissibleDetail:
          "the selected alternate substitutes the representation (a different model) — the model dimension's move, never a provider failover",
      });
    } else {
      // The claim derives from the supply plane's OWN selected verdict
      // and its ORIGINAL declared candidate — never re-implemented
      // economics (exactly the model re-route discipline).
      const declared = providerFacts.declaredCandidates.find(
        (candidate) => candidate.candidateId === selected.candidateId,
      );
      if (declared === undefined) {
        reject(
          "strategy-shape",
          "the provider re-route facts lost the selected candidate's declared claim",
          { selectedId: selected.candidateId },
        );
      }
      candidates.push({
        candidateId: "reroute-provider",
        strategy: "re-route",
        rerouteDimension: "provider",
        claim: {
          expectedCostMicroUsd: selected.evaluation.expectedSuccessfulResolutionCostMicroUsd,
          expectedLatencyMs: declared.claim.expectedLatencyMs,
          expectedQuality: declared.claim.expectedQuality,
          expectedReliability: declared.claim.expectedReliability,
          basis: {
            basis: declared.claim.basis.basis,
            source:
              `model-economics;provider-failover=${selected.route.provider}/${selected.route.model}`.slice(
                0,
                200,
              ),
            ...(declared.claim.basis.evidenceDigest === undefined
              ? {}
              : { evidenceDigest: declared.claim.basis.evidenceDigest }),
          },
        },
      });
      candidateRoutes.set("reroute-provider", { ...selected.route });
    }
  }

  // --- ESCALATE-FRESH: evidence-driven, never self-authorizing -----------
  if (facts.escalation !== null && facts.escalation !== undefined) {
    const decision = facts.escalation.decision;
    const escalationClaim = facts.escalation.claim;
    if (decision.kind !== "escalate-fresh-context") {
      const evaluation = evaluateAdmissibility(
        {
          candidateId: "escalate-fresh",
          representationClass: VERDICT_CLASS,
          claim: escalationClaim,
        },
        governing,
      );
      disciplineVerdicts.push({
        candidateId: "escalate-fresh",
        strategy: "escalate-fresh",
        attributionId: attribution.attributionId,
        representationClass: VERDICT_CLASS,
        admissible: false,
        inadmissibleCode: "escalation-not-justified",
        inadmissibleDetail: `the fresh-escalation hook decided ${decision.kind} (no economic justification for a fresh context)`,
        evaluation: evaluation.evaluation,
      });
    } else {
      candidates.push({
        candidateId: "escalate-fresh",
        strategy: "escalate-fresh",
        claim: escalationClaim,
      });
    }
  }

  // --- CONTEXT-REPAIR: the caller's typed repair-capability verdict -------
  if (facts.contextRepair !== null && facts.contextRepair !== undefined) {
    const capability = validateContextRepairCapability(facts.contextRepair.capability);
    const repairClaim = facts.contextRepair.claim;
    let code: RecoveryInadmissibleCode | undefined;
    let detail: string | undefined;
    if (!CONTEXT_REPAIRABLE_CLASSES.includes(attribution.failureClass)) {
      code = "class-not-repairable";
      detail = `failure class ${attribution.failureClass} is not a context-corruption class (a bounded context repair is unrepresentable for it)`;
    } else if (capability.kind !== "repair-capable") {
      code = "repair-not-capable";
      detail = `the repair-capability verdict decided ${capability.kind} (no bounded reconstruction directive exists)`;
    }
    const candidate: StrategyCandidate = {
      candidateId: "context-repair",
      strategy: "context-repair",
      claim: repairClaim,
    };
    const evaluation = evaluateAdmissibility(
      {
        candidateId: candidate.candidateId,
        representationClass: VERDICT_CLASS,
        claim: repairClaim,
      },
      governing,
    );
    if (code === undefined && !evaluation.admissible) {
      code = economicsCodeOf(evaluation.inadmissibleCode);
      detail = `the context-repair claim failed the governing economics (${evaluation.inadmissibleCode ?? "unknown"})`;
    }
    if (code === undefined) {
      candidates.push(candidate);
    } else {
      disciplineVerdicts.push({
        candidateId: candidate.candidateId,
        strategy: "context-repair",
        attributionId: attribution.attributionId,
        representationClass: VERDICT_CLASS,
        admissible: false,
        inadmissibleCode: code,
        inadmissibleDetail: boundedDetail(detail ?? code),
        evaluation: evaluation.evaluation,
      });
    }
  }

  // --- VERIFIER-ESCALATION: the existing verification escalation seam ------
  if (facts.verifierEscalation !== null && facts.verifierEscalation !== undefined) {
    const decision = validateVerifierEscalationDecision(facts.verifierEscalation.decision);
    const verifierClaim = facts.verifierEscalation.claim;
    let code: RecoveryInadmissibleCode | undefined;
    let detail: string | undefined;
    if (attribution.failureClass !== "intelligence") {
      code = "outcome-not-quality-suspect";
      detail = `verifier escalation requires an attributed semantic-quality-suspect outcome (class ${attribution.failureClass} is not)`;
    } else if (decision.kind !== "escalate-verification") {
      code = "verifier-escalation-not-justified";
      detail = `the verification escalation decision was ${decision.kind} (no authority justification for deeper verification)`;
    }
    const candidate: StrategyCandidate = {
      candidateId: "verifier-escalation",
      strategy: "verifier-escalation",
      claim: verifierClaim,
    };
    const evaluation = evaluateAdmissibility(
      {
        candidateId: candidate.candidateId,
        representationClass: VERDICT_CLASS,
        claim: verifierClaim,
      },
      governing,
    );
    if (code === undefined && !evaluation.admissible) {
      code = economicsCodeOf(evaluation.inadmissibleCode);
      detail = `the verifier-escalation claim failed the governing economics (${evaluation.inadmissibleCode ?? "unknown"})`;
    }
    if (code === undefined) {
      candidates.push(candidate);
    } else {
      disciplineVerdicts.push({
        candidateId: candidate.candidateId,
        strategy: "verifier-escalation",
        attributionId: attribution.attributionId,
        representationClass: VERDICT_CLASS,
        admissible: false,
        inadmissibleCode: code,
        inadmissibleDetail: boundedDetail(detail ?? code),
        evaluation: evaluation.evaluation,
      });
    }
  }

  // --- SHARED ADMISSIBILITY (the model-economics plane's own machinery) --
  const verdicts: StrategyVerdict[] = [...disciplineVerdicts, ...structural];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.candidateId)) {
      reject("strategy-shape", "strategy candidate ids must be unique within one selection", {
        candidateId: candidate.candidateId,
      });
    }
    seen.add(candidate.candidateId);
    const admissibility = evaluateAdmissibility(
      {
        candidateId: candidate.candidateId,
        representationClass: VERDICT_CLASS,
        claim: candidate.claim,
      },
      governing,
    );
    if (admissibility.admissible) {
      verdicts.push({
        candidateId: candidate.candidateId,
        strategy: candidate.strategy,
        attributionId: attribution.attributionId,
        ...(candidate.rerouteDimension === undefined
          ? {}
          : { rerouteDimension: candidate.rerouteDimension }),
        representationClass: VERDICT_CLASS,
        admissible: true,
        evaluation: admissibility.evaluation,
      });
    } else {
      verdicts.push({
        candidateId: candidate.candidateId,
        strategy: candidate.strategy,
        attributionId: attribution.attributionId,
        ...(candidate.rerouteDimension === undefined
          ? {}
          : { rerouteDimension: candidate.rerouteDimension }),
        representationClass: VERDICT_CLASS,
        admissible: false,
        inadmissibleCode: economicsCodeOf(admissibility.inadmissibleCode),
        inadmissibleDetail: `the strategy claim failed the governing economics (${admissibility.inadmissibleCode ?? "unknown"})`,
        evaluation: admissibility.evaluation,
      });
    }
  }

  // --- THE DETERMINISTIC ORDER (total: cost → strategy rank → id) --------
  const admissibleVerdicts = verdicts
    .filter((verdict) => verdict.admissible)
    .sort(compareStrategies);

  // --- THE MEASURED-EVIDENCE PREFERENCE (ACR-008 §4; PCR-002) ------------
  // OPTIONAL input: ABSENCE (undefined or null) never enters this block —
  // the ordering, the selected verdict and the serialized selection are
  // byte-identical to the declared-facts-only selection (discrimination-
  // tested; the program's honesty anchor). PRESENCE validates the facts
  // (fail-closed), derives the auditable provenance and re-orders the
  // ALREADY-ADMISSIBLE verdicts' preferences — the invariant-13 boundary:
  // the admissibility verdicts, their typed reason codes, the governing
  // floors/ceilings and the policy restrictions were all computed ABOVE
  // from the declared facts alone and are never revisited (measured
  // facts can reorder preferences; they can never lower a quality floor,
  // raise a budget ceiling, bypass a policy restriction or admit an
  // otherwise-inadmissible move — the re-admission is unrepresentable
  // because the reorder operates exclusively on the admissible list).
  let measuredProvenance: string | undefined;
  let preferred = admissibleVerdicts;
  const measuredInput = input.measured ?? null;
  if (measuredInput !== null) {
    const measured = validateObservedReliabilityFacts(measuredInput);
    measuredProvenance = measuredProvenanceOf(measured, input.digest);
    preferred = measuredPreferenceOrder(admissibleVerdicts, measured, candidateRoutes);
  }

  const ordered = [...preferred, ...verdicts.filter((verdict) => !verdict.admissible)];
  const selected = preferred[0] ?? null;

  if (selected === null) {
    // The zero-recovery outcome: ALWAYS representable, typed, honest
    // (architecture invariant 7 — fail-closed, never a silent default).
    return measuredProvenance === undefined
      ? {
          kind: "fail-closed",
          selected: null,
          failClosedCode: "no-admissible-strategy",
          verdicts: ordered,
          facts: governing,
          selectionBasis: RECOVERY_SELECTION_BASIS,
        }
      : {
          kind: "fail-closed",
          selected: null,
          failClosedCode: "no-admissible-strategy",
          verdicts: ordered,
          facts: governing,
          selectionBasis: RECOVERY_SELECTION_BASIS,
          measuredProvenance,
        };
  }
  return measuredProvenance === undefined
    ? {
        kind: "recover",
        selected,
        verdicts: ordered,
        facts: governing,
        selectionBasis: RECOVERY_SELECTION_BASIS,
      }
    : {
        kind: "recover",
        selected,
        verdicts: ordered,
        facts: governing,
        selectionBasis: RECOVERY_SELECTION_BASIS,
        measuredProvenance,
      };
}

// ---------------------------------------------------------------------------
// Deterministic comparison (the total order — invariant 5)
// ---------------------------------------------------------------------------

/**
 * Compare two ADMISSIBLE strategy verdicts by the deterministic total
 * order: expected successful-resolution cost ascending, ties by
 * strategy rank (retry < re-route < context-repair < escalate-fresh <
 * verifier-escalation — the disruption ladder), ties by candidateId.
 * Identical inputs can never produce a different order — every tie
 * resolves on content.
 */
export function compareStrategies(a: StrategyVerdict, b: StrategyVerdict): number {
  const costA = BigInt(a.evaluation?.expectedSuccessfulResolutionCostMicroUsd ?? "0");
  const costB = BigInt(b.evaluation?.expectedSuccessfulResolutionCostMicroUsd ?? "0");
  if (costA !== costB) {
    return costA < costB ? -1 : 1;
  }
  const rankA = STRATEGY_RANK[a.strategy];
  const rankB = STRATEGY_RANK[b.strategy];
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  if (a.candidateId !== b.candidateId) {
    return a.candidateId < b.candidateId ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// The measured-evidence preference order (ACR-008 §4; PCR-002)
// ---------------------------------------------------------------------------

/**
 * Apply the measured-evidence preference order to the ALREADY-admissible
 * verdicts (the invariant-13 boundary's structural enforcement): the
 * input list is the declared-facts-only deterministic order (cost
 * ascending → strategy rank → candidateId — fully total), and the
 * measured facts may ONLY re-arrange preferences within it:
 *
 *  - G1 — routes with a measured fact and NO active cooldown, ordered
 *    by measured success rate DESCENDING (ties keep the declared
 *    order — every tie resolves on content);
 *  - G2 — routes without a measured fact, in their declared order
 *    (the declared-only preference is preserved among unmeasured
 *    candidates);
 *  - G3 — routes with an ACTIVE measured cooldown, demoted to the
 *    back in their declared order (the measured evidence that the
 *    route is currently degrading).
 *
 * The partition and the rate ordering are pure functions of the verdict
 * identities, the candidate routes and the measured facts — the same
 * inputs always produce the byte-identical order (determinism including
 * tie-breaks). No verdict's admissibility, reason code, evaluation or
 * governing fact is read or written here — the reorder CANNOT admit an
 * inadmissible move (it never sees one) and CANNOT touch a floor or a
 * ceiling (it never recomputes admissibility).
 */
function measuredPreferenceOrder(
  admissible: readonly StrategyVerdict[],
  measured: ObservedReliabilityFacts,
  candidateRoutes: ReadonlyMap<string, { provider: string; model: string }>,
): StrategyVerdict[] {
  const factOf = new Map<string, ObservedRouteReliability>();
  for (const fact of measured.routes) {
    factOf.set(`${fact.route.provider}/${fact.route.model}`, fact);
  }
  const indexed = admissible.map((verdict, index) => ({ verdict, index }));
  const healthy: { verdict: StrategyVerdict; index: number; rate: number }[] = [];
  const unmeasured: { verdict: StrategyVerdict; index: number }[] = [];
  const cooldown: { verdict: StrategyVerdict; index: number }[] = [];
  for (const entry of indexed) {
    const route = candidateRoutes.get(entry.verdict.candidateId);
    const fact = route === undefined ? undefined : factOf.get(`${route.provider}/${route.model}`);
    if (fact === undefined) {
      unmeasured.push(entry);
    } else if (fact.cooldown.active) {
      cooldown.push(entry);
    } else {
      healthy.push({ ...entry, rate: fact.measuredSuccessRate });
    }
  }
  healthy.sort((a, b) => b.rate - a.rate || a.index - b.index);
  return [...healthy, ...unmeasured, ...cooldown].map((entry) => entry.verdict);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map the model-economics plane's inadmissible codes into this plane's
 * closed vocabulary (the economics dimensions overlap by design — the
 * shared machinery's codes are the same economics, imported not
 * re-invented). An unmappable code fails closed: never an invented
 * reason, never a silent default.
 */
function economicsCodeOf(code: string | undefined): RecoveryInadmissibleCode {
  switch (code) {
    case "quality-below-hard-floor":
    case "quality-below-assurance":
    case "reliability-below-floor":
    case "budget-ceiling":
    case "latency-ceiling":
      return code;
    default:
      reject("strategy-shape", "the shared admissibility emitted an unmappable code", {
        got: boundedDetail(String(code)),
      });
  }
}

/**
 * Total, deterministic validation of a caller-supplied repair-
 * capability verdict: the closed kind vocabulary, and the bounded
 * reconstruction directive a `repair-capable` verdict must carry (a
 * bounded neutral strategy slug; an optional sha256 anchor). A
 * malformed verdict is a typed rejection — never a silent default
 * repair (fail-closed on unmet preconditions).
 */
function validateContextRepairCapability(value: ContextRepairCapability): ContextRepairCapability {
  if (typeof value !== "object" || value === null) {
    reject("recovery-input-shape", "the context-repair facts require their capability verdict");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "repair-not-capable") {
    return { kind: "repair-not-capable" };
  }
  if (record.kind !== "repair-capable") {
    reject("recovery-input-shape", "the repair-capability kind is outside the closed vocabulary", {
      got: boundedDetail(String(record.kind)),
    });
  }
  const directive = record.directive as ContextRepairDirective | undefined;
  if (
    typeof directive !== "object" ||
    directive === null ||
    typeof directive.strategy !== "string" ||
    !COMPONENT_REF_PATTERN.test(directive.strategy)
  ) {
    reject(
      "recovery-input-shape",
      "a repair-capable verdict must carry its bounded reconstruction directive (a neutral strategy slug)",
      { got: boundedDetail(String(record.directive)) },
    );
  }
  if (
    directive.anchorDigest !== undefined &&
    (typeof directive.anchorDigest !== "string" || !SHA256_HEX_PATTERN.test(directive.anchorDigest))
  ) {
    reject(
      "recovery-input-shape",
      "the reconstruction directive's anchor digest must be sha256 hex",
    );
  }
  return {
    kind: "repair-capable",
    directive: {
      strategy: directive.strategy,
      ...(directive.anchorDigest === undefined ? {} : { anchorDigest: directive.anchorDigest }),
    },
  };
}

/**
 * Total, deterministic validation of a caller-supplied verifier-
 * escalation decision: the closed kind vocabulary, the closed depth
 * ladder, and invariant 19's never-decrease discipline — an
 * `escalate-verification` verdict whose target depth does not
 * STRICTLY exceed its incumbent depth is a typed rejection (a
 * depth-flat or depth-reducing escalation is unrepresentable), never
 * a silent default.
 */
function validateVerifierEscalationDecision(
  value: VerifierEscalationDecision,
): VerifierEscalationDecision {
  if (typeof value !== "object" || value === null) {
    reject("recovery-input-shape", "the verifier-escalation facts require their decision verdict");
  }
  const record = value as unknown as Record<string, unknown>;
  if (
    record.kind !== "escalate-verification" &&
    record.kind !== "verification-sufficient" &&
    record.kind !== "no-admissible-evaluation"
  ) {
    reject(
      "recovery-input-shape",
      "the verifier-escalation decision kind is outside the closed vocabulary",
      {
        got: boundedDetail(String(record.kind)),
      },
    );
  }
  if (
    typeof record.fromDepth !== "string" ||
    typeof record.toDepth !== "string" ||
    !(VERIFICATION_DEPTHS as readonly string[]).includes(record.fromDepth) ||
    !(VERIFICATION_DEPTHS as readonly string[]).includes(record.toDepth)
  ) {
    reject("recovery-input-shape", "the verifier-escalation depths are outside the closed ladder", {
      fromDepth: boundedDetail(String(record.fromDepth)),
      toDepth: boundedDetail(String(record.toDepth)),
    });
  }
  if (record.verificationId !== undefined && typeof record.verificationId !== "string") {
    reject("recovery-input-shape", "verificationId must be a string when present");
  }
  if (
    record.kind === "escalate-verification" &&
    VERIFICATION_DEPTH_RANK[record.toDepth as VerificationDepth] <=
      VERIFICATION_DEPTH_RANK[record.fromDepth as VerificationDepth]
  ) {
    reject(
      "recovery-input-shape",
      "the verifier-escalation decision must strictly increase the assurance depth (invariant 19: never decrease, never stay flat)",
      {
        fromDepth: record.fromDepth,
        toDepth: record.toDepth,
      },
    );
  }
  return {
    kind: record.kind,
    fromDepth: record.fromDepth as VerificationDepth,
    toDepth: record.toDepth as VerificationDepth,
    ...(record.verificationId === undefined ? {} : { verificationId: record.verificationId }),
  };
}
