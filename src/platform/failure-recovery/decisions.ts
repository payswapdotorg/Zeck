/**
 * Recovery decision records (platform failure-recovery plane; WORK-055 /
 * E1.1 — ADR-0020 "Required decision evidence").
 *
 * THE RECORD-CONSTRUCTION SEAM: every material recovery decision
 * (the selected retry / re-route / escalate-fresh strategy over an
 * attributed failure) is recorded through the WORK-049 evidence
 * contract (`buildOptimizationDecision`) — APPEND-ONLY EVIDENCE,
 * built here as VALUES, appended by the CALLER through the EXISTING
 * WORK-049 store at its seam (no new durable surface — architecture
 * invariant 8):
 *
 *  - the record's candidate corpus is the evidence-honest subset:
 *    every strategy candidate that reached the shared admissibility
 *    pass (admissible OR below-assurance — recorded with its invalid
 *    evaluation, the auditable "why the cheaper path did not win"
 *    evidence), plus the structurally inadmissible strategy verdicts
 *    that CARRY an evaluation (the retry/escalation discipline
 *    rejections — their typed reason codes ride the transformation
 *    basis detail; strategy verdicts with NO claim at all
 *    (no-alternative-route / no-substrate-selection) are excluded —
 *    their typed outcomes live in the selection result, exactly the
 *    sibling planes' discipline for hard-violating candidates);
 *  - the transformation basis comes from the closed WORK-049
 *    vocabulary, derived from the selected strategy: `identity` for
 *    retry (the same representation re-executed), and
 *    `representation-substitution` for re-route and escalate-fresh
 *    (the work's execution path is substituted), with a bounded
 *    detail carrying the failure-recovery provenance (attribution
 *    identity + class + signal, strategy, candidate, governing
 *    floor);
 *  - `recordedAt` is an explicit INPUT (determinism — the same
 *    inputs always produce the byte-identical record, so the
 *    content-addressed decisionId is stable and re-recording is a
 *    bounded no-op at the store's unique index);
 *  - the ATTRIBUTION rides the evidence: the attribution identity
 *    (content-addressed), class and signal are carried in the
 *    transformation-basis detail and the candidates' basis sources,
 *    so the durable record is replayable by deterministic audit
 *    (failure observation → attribution → recovery decision —
 *    EXECUTION-PROVENANCE);
 *  - foundation rejections are wrapped into this plane's closed
 *    `decision-invalid` error (fail closed — a record that fails its
 *    own total validation is never emitted).
 *
 * When the selection is `fail-closed` (the zero-recovery outcome),
 * NO record exists: the typed outcome IS the evidence (a
 * below-justification recovery is never recorded as an optimization
 * decision — exactly the sibling planes' no-selection discipline).
 */

import type { OptimizationConstraint } from "../execution-ir/constraints";
import { validateConstraintSet } from "../execution-ir/constraints";
import type { CandidateRepresentation, CostClaim } from "../execution-ir/cost-model";
import type { OptimizationDecisionRecord } from "../execution-ir/decision-record";
import { buildOptimizationDecision } from "../execution-ir/decision-record";
import type { ExecutionIr, IrDigestPort } from "../execution-ir/ir";
import type { FailureAttribution } from "./attribution";
import { boundedDetail, reject } from "./catalog";
import type { RecoveryFacts, RecoverySelection, StrategyVerdict } from "./strategy";

// ---------------------------------------------------------------------------
// The shared scope and provenance discipline
// ---------------------------------------------------------------------------

/** The decision-record scope + the explicit recorded-at instant. */
export interface RecoveryDecisionScope {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId?: string;
  /** The explicit recorded-at instant — an INPUT, never ambient time. */
  readonly recordedAt: string;
}

/** The bounded provenance-detail ceiling (the foundation's own rule). */
const DETAIL_MAX = 500;

// ---------------------------------------------------------------------------
// The canonical claims derivation (the corpus the selection ran on)
// ---------------------------------------------------------------------------

/**
 * Derive the canonical per-candidate claims map from the recovery
 * facts — EXACTLY the claim assembly `selectRecoveryStrategy` runs on
 * (the retry/escalation/repair claims as supplied; the re-route claims
 * derived from the economics/supply planes' OWN selected verdicts, the
 * same derivations the selection performs). This is the shared,
 * single derivation for every caller that records a selection's
 * decision through the WORK-049 seam — the plan-composition wiring
 * (PCR-002) and any tenant/evaluation driver consume it so the
 * recorded corpus provably corresponds to the selection's evaluated
 * verdicts (no second, drifting derivation).
 */
export function recoveryClaimsOf(facts: RecoveryFacts): ReadonlyMap<string, CostClaim> {
  const claims = new Map<string, CostClaim>();
  if (facts.retry !== null && facts.retry !== undefined) {
    claims.set(`retry-attempt-${facts.retry.nextAttempt}`, facts.retry.claim);
  }
  const model = facts.reroute?.model;
  if (model !== null && model !== undefined) {
    const selected = model.selection.selected;
    if (selected !== null) {
      const declared = model.declaredCandidates.find(
        (candidate) => candidate.candidateId === selected.candidateId,
      );
      if (declared !== undefined) {
        claims.set("reroute-model", {
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
        });
      }
    }
  }
  const substrate = facts.reroute?.substrate;
  if (substrate !== null && substrate !== undefined) {
    const selectedSubstrate = substrate.selection.selected;
    if (selectedSubstrate !== null) {
      claims.set("reroute-substrate", {
        expectedCostMicroUsd: selectedSubstrate.economics.expectedSuccessfulResolutionCostMicroUsd,
        expectedLatencyMs: selectedSubstrate.economics.totalLatencyMs,
        expectedQuality: selectedSubstrate.economics.execution.expectedQuality,
        expectedReliability: selectedSubstrate.economics.execution.expectedReliability,
        basis: {
          basis: selectedSubstrate.economics.execution.basis.basis,
          source: `substrate-economics:${substrate.selection.record.selectionId}`.slice(0, 200),
          ...(selectedSubstrate.economics.execution.basis.evidenceDigest === undefined
            ? {}
            : { evidenceDigest: selectedSubstrate.economics.execution.basis.evidenceDigest }),
        },
      });
    }
  }
  const provider = facts.reroute?.provider;
  if (provider !== null && provider !== undefined) {
    const selected = provider.selection.selected;
    if (selected !== null) {
      const declared = provider.declaredCandidates.find(
        (candidate) => candidate.candidateId === selected.candidateId,
      );
      if (declared !== undefined) {
        claims.set("reroute-provider", {
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
        });
      }
    }
  }
  if (facts.escalation !== null && facts.escalation !== undefined) {
    claims.set("escalate-fresh", facts.escalation.claim);
  }
  if (facts.contextRepair !== null && facts.contextRepair !== undefined) {
    claims.set("context-repair", facts.contextRepair.claim);
  }
  if (facts.verifierEscalation !== null && facts.verifierEscalation !== undefined) {
    claims.set("verifier-escalation", facts.verifierEscalation.claim);
  }
  return claims;
}

// ---------------------------------------------------------------------------
// The recovery decision-record builder
// ---------------------------------------------------------------------------

/** The recovery decision-record input. */
export interface RecoveryDecisionRecordInput {
  /** The attributed failure the recovery decided for (validated). */
  readonly attribution: FailureAttribution;
  /** The selection result to record (must carry a RECOVER outcome). */
  readonly selection: RecoverySelection;
  /**
   * The ORIGINAL strategy claims the selection ran on (the caller's
   * explicit-basis values, keyed by candidateId — the record's claim
   * corpus must correspond exactly to the selection's evaluated
   * verdicts).
   */
  readonly claims: ReadonlyMap<string, CostClaim>;
  /** The governed Execution IR the recovery belongs to. */
  readonly ir: ExecutionIr;
  /** The governing constraint set the selection ran under. */
  readonly constraints: readonly OptimizationConstraint[];
  /** The decision-record scope + the explicit recorded-at instant. */
  readonly scope: RecoveryDecisionScope;
  /**
   * The measured-facts provenance (ACR-008 §4; PCR-002) — the
   * selection's own `measuredProvenance`, carried onto the record so
   * every decision that consumed measured facts is explicitly and
   * auditably provenance-stamped (which observations, which window).
   * ABSENT when the selection ran declared-facts-only — the record is
   * byte-identical to the declared-only form.
   */
  readonly measuredProvenance?: string;
  readonly digest: IrDigestPort;
}

/**
 * Assemble the evidence-honest candidate corpus from the selection's
 * verdicts and the original claims: every verdict that carries an
 * evaluation (a claim exists) becomes one candidate representation of
 * the `sufficient-model` class (the recovery strategy routes HOW the
 * work recovers — it does not change the work's representation
 * class), carrying the ORIGINAL claim the selection ran on.
 * Verdicts without claims are structurally inadmissible (typed
 * outcomes in the selection result — excluded, the sibling planes'
 * discipline).
 */
function buildCorpus(
  verdicts: readonly StrategyVerdict[],
  claims: ReadonlyMap<string, CostClaim>,
): CandidateRepresentation[] {
  const corpus: CandidateRepresentation[] = [];
  for (const verdict of verdicts) {
    if (verdict.evaluation === undefined) {
      // Structurally inadmissible (no claim exists): the typed
      // outcome lives in the selection result — never a phantom
      // candidate.
      continue;
    }
    const claim = claims.get(verdict.candidateId);
    if (claim === undefined) {
      reject(
        "decision-invalid",
        "an evaluated strategy verdict references a claim the record input does not carry",
        { candidateId: verdict.candidateId },
      );
    }
    corpus.push({
      candidateId: verdict.candidateId,
      representationClass: "sufficient-model",
      description: `the ${verdict.strategy} recovery path`,
      claim,
    });
  }
  return corpus;
}

/**
 * Build the WORK-049 record of a recovery-strategy selection. The
 * basis is `identity` when the selected strategy is RETRY (the same
 * representation re-executed), `representation-substitution` for
 * re-route and escalate-fresh (the execution path is substituted).
 *
 * Fail-closed BEFORE the record exists:
 *  - the selection outcome must be `recover` (a fail-closed selection
 *    is not an optimization decision — its typed outcome is the
 *    evidence);
 *  - the corpus must be non-empty and carry the selected candidate;
 *  - the foundation's own total validation (claims, selection,
 *    hard constraints, quality threshold) applies WHOLESALE.
 */
export function buildRecoveryDecisionRecord(
  input: RecoveryDecisionRecordInput,
): OptimizationDecisionRecord | null {
  if (input.selection.kind !== "recover" || input.selection.selected === null) {
    // The zero-recovery outcome: the typed result IS the evidence —
    // never a below-justification recovery recorded as a decision.
    return null;
  }
  const constraints = validateConstraintSet(input.constraints);
  if (constraints.length === 0) {
    reject(
      "decision-invalid",
      "a recovery decision must record at least its governing constraints",
    );
  }
  const selected = input.selection.selected;
  const corpus = buildCorpus(input.selection.verdicts, input.claims);
  if (corpus.length === 0) {
    reject("decision-invalid", "a recovery decision must record at least one strategy candidate");
  }
  if (!corpus.some((candidate) => candidate.candidateId === selected.candidateId)) {
    reject("decision-invalid", "the selected strategy candidate is absent from the record corpus", {
      selectedCandidateId: selected.candidateId,
    });
  }
  const attribution = input.attribution;
  const detail = (
    `failure-recovery;feature=strategy-selection;` +
    `attribution=${attribution.attributionId};class=${attribution.failureClass};` +
    `signal=${attribution.observation.signal};strategy=${selected.strategy};` +
    `candidate=${selected.candidateId};floor=${input.selection.facts.qualityFloor};` +
    `verdicts=${input.selection.verdicts.length}` +
    (input.measuredProvenance === undefined ? "" : `;measured=${input.measuredProvenance}`)
  ).slice(0, DETAIL_MAX);

  try {
    return buildOptimizationDecision(
      {
        applicationId: input.scope.applicationId,
        tenantId: input.scope.tenantId,
        ...(input.scope.executionId === undefined ? {} : { executionId: input.scope.executionId }),
        ir: input.ir,
        constraints,
        candidates: corpus,
        selectedCandidateId: selected.candidateId,
        qualityThreshold: input.selection.facts.qualityFloor,
        transformationBasis: {
          code: selected.strategy === "retry" ? "identity" : "representation-substitution",
          detail: boundedDetail(detail),
        },
        recordedAt: input.scope.recordedAt,
      },
      input.digest,
    );
  } catch (error) {
    // The foundation's total validation (hard constraints, selection
    // coherence, digests) rejected the record: the plane's closed
    // fail-closed error — never an unvalidated emission.
    reject("decision-invalid", "the recovery decision record failed its total validation", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
