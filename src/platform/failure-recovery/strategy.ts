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
 * THE DETERMINISTIC ORDER: expected successful-resolution cost
 * ascending, ties broken by strategy rank (retry first — the least
 * disruptive representation-preserving path; then re-route; then
 * escalate-fresh), then by candidateId. Every tie resolves on
 * content: non-deterministic tie-breaks are impossible by
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
  type FailureClass,
  MAX_RETRY_ATTEMPTS,
  type RecoveryFailClosedCode,
  type RecoveryInadmissibleCode,
  type RecoveryStrategy,
  type RerouteDimension,
  reject,
} from "./catalog";

// ---------------------------------------------------------------------------
// The selection input (typed, bounded, total)
// ---------------------------------------------------------------------------

/**
 * The bounded recovery configuration — EXPLICIT policy inputs (never
 * ambient, never self-raising): the retry attempt bound, and the
 * bounds the escalation/continuation constructors share.
 */
export interface RecoveryConfiguration {
  /** The maximum retry attempts the policy admits ([0, 10]). */
  readonly maxRetryAttempts: number;
  /** The evidence-entry bound for escalation packages ([1, 64]). */
  readonly escalationEvidenceBound: number;
  /** The step bound for continuation packages ([1, 256]). */
  readonly continuationStepBound: number;
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

/** The re-route path's facts — the economics planes' typed results, read-only. */
export interface RerouteFacts {
  /** Model re-selection facts, when a model re-route was offered. */
  readonly model: ModelRerouteFacts | null;
  /** Substrate re-selection facts, when a substrate re-route was offered. */
  readonly substrate: SubstrateRerouteFacts | null;
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

/** The economics facts of every recovery path. */
export interface RecoveryFacts {
  /** The retry path's facts, when a retry is representable at all. */
  readonly retry: RetryFacts | null;
  /** The re-route dimensions' facts (the economics planes, read-only). */
  readonly reroute: RerouteFacts;
  /** The fresh-escalation path's facts, when representable. */
  readonly escalation: EscalationFacts | null;
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
 * inadmissibility detail.
 */
export interface StrategyVerdict {
  readonly candidateId: string;
  readonly strategy: RecoveryStrategy;
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
  "attribution-before-action;retry-requires-typed-retryable-class-and-transient-and-attempts-and-economics;reroute-consumes-economics-planes-facts;escalation-requires-fresh-escalation-hook-justification;quality-floors-inviolable;cost-ascending-then-strategy-rank-then-candidateId;fail-closed-when-none-admissible";

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

/** The deterministic strategy rank (tie-break order). */
export const STRATEGY_RANK: Readonly<Record<RecoveryStrategy, number>> = {
  retry: 0,
  "re-route": 1,
  "escalate-fresh": 2,
  fail: 3,
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
    }
  }

  // --- RE-ROUTE (substrate): consult the substrate-economics plane -------
  if (facts.reroute.substrate !== null && facts.reroute.substrate !== undefined) {
    const substrateSelection = facts.reroute.substrate.selection;
    if (substrateSelection.selected === null) {
      structural.push({
        candidateId: "reroute-substrate",
        strategy: "re-route",
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
  const ordered = [...admissibleVerdicts, ...verdicts.filter((verdict) => !verdict.admissible)];
  const selected = admissibleVerdicts[0] ?? null;

  if (selected === null) {
    // The zero-recovery outcome: ALWAYS representable, typed, honest
    // (architecture invariant 7 — fail-closed, never a silent default).
    return {
      kind: "fail-closed",
      selected: null,
      failClosedCode: "no-admissible-strategy",
      verdicts: ordered,
      facts: governing,
      selectionBasis: RECOVERY_SELECTION_BASIS,
    };
  }
  return {
    kind: "recover",
    selected,
    verdicts: ordered,
    facts: governing,
    selectionBasis: RECOVERY_SELECTION_BASIS,
  };
}

// ---------------------------------------------------------------------------
// Deterministic comparison (the total order — invariant 5)
// ---------------------------------------------------------------------------

/**
 * Compare two ADMISSIBLE strategy verdicts by the deterministic total
 * order: expected successful-resolution cost ascending, ties by
 * strategy rank (retry < re-route < escalate-fresh), ties by
 * candidateId. Identical inputs can never produce a different order —
 * every tie resolves on content.
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
