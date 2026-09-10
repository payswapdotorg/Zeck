/**
 * Shadow/canary promotion gates (platform competence-economics
 * plane; WORK-056 / E1.1 — ADR-0019, ADR-0020 progressive
 * deterministicization).
 *
 * PROMOTION IS GATED, NEVER SKIPPED (the Work Order's second
 * architecture invariant): the ONLY promotion route is
 *
 *   candidate → shadow → canary → deterministic
 *
 * one stage at a time, each gate bounded by policy/budget inputs
 * and equivalence evidence. The target stage is COMPUTED from the
 * record's current stage (rank + 1) — never caller-supplied — so
 * gate-skipping is STRUCTURALLY IMPOSSIBLE (a record at `shadow`
 * presented with canary evidence still advances only to `canary`;
 * a record at `candidate` cannot jump to `deterministic`).
 *
 * THE GATES (each one's requirements are cumulative — the earlier
 * gates' conditions still hold):
 *
 *  - GATE candidate → shadow (BEGIN shadow evaluation): the
 *    deterministic replacement is ADMITTED (the full
 *    differential/property/replay suite, within its declared
 *    bounds — `admitDeterministicReplacement` fails closed on less),
 *    the suite re-evaluated under the governing policy floor HOLDS,
 *    the replacement's deterministic claim passes the shared
 *    admissibility machinery (the model-economics plane's OWN
 *    `governingFacts`/`evaluateAdmissibility`: inviolable quality
 *    floors, hard budget/latency ceilings — imported, never
 *    re-implemented), and the requesting authority is INDEPENDENT;
 *  - GATE shadow → canary (BEGIN bounded exposure): the SHADOW
 *    evidence must have observed the configured observation count
 *    with ZERO deviations (shadow runs alongside the probabilistic
 *    path — no production exposure);
 *  - GATE canary → deterministic (the promotion): the CANARY
 *    evidence must have completed its bounded exposure (within the
 *    policy exposure bound) with the required success rate and ZERO
 *    deviations.
 *
 * NO SELF-PROMOTION (LEARNING-NONAUTHORITY): the requesting
 * authority identity must differ from every trajectory executor
 * and from the record's miner — an agent NEVER promotes its own
 * output (typed `self-promotion` rejection, permanent).
 *
 * THE VERDICT IS EVIDENCE (never an engine): `promoted` carries the
 * ADVANCED record — a NEW content-addressed value with the advanced
 * stage (pure derivation: the same inputs always produce the
 * byte-identical advanced record, so re-running the same promotion
 * is idempotent); `hold` and `reject` carry the typed reasons (the
 * current-stage outcome IS the evidence — no record is emitted).
 * Promotion decisions are recorded through the WORK-049
 * decision-record ride (`decisions.ts`) and EXECUTED by the
 * existing authorities at their seams — this function authorizes
 * nothing (the plane exposes no admission vocabulary).
 *
 * Pure and deterministic: no clock, no randomness, no ambient state
 * (architecture invariant 5).
 */

import type { OptimizationConstraint } from "../execution-ir/constraints";
import { validateConstraintSet } from "../execution-ir/constraints";
import type { IrDigestPort } from "../execution-ir/ir";
import type { GoverningFacts } from "../model-economics/admissibility";
import { evaluateAdmissibility, governingFacts } from "../model-economics/admissibility";
import type { QualityFacts } from "../model-economics/vocabulary";
import { validateQualityFacts } from "../model-economics/vocabulary";
import {
  AUTHORITY_ID_PATTERN,
  boundedDetail,
  DETERMINISTIC_REPLACEMENT_CLASS,
  MAX_CANARY_EXPOSURE,
  MAX_SHADOW_OBSERVATIONS,
  PROMOTION_STAGE_RANK,
  PROMOTION_STAGES,
  type PromotionInadmissibleCode,
  type PromotionOutcome,
  type PromotionStage,
  reject,
} from "./catalog";
import {
  type DeterministicReplacementCandidate,
  type EquivalencePolicy,
  type EquivalenceVerdict,
  evaluateEquivalenceSuite,
  validateDeterministicReplacement,
  validateEquivalencePolicy,
} from "./equivalence";
import type { CompetenceRecord } from "./record";
import { buildCompetenceRecord, validateCompetenceRecord } from "./record";

// ---------------------------------------------------------------------------
// The promotion configuration (bounded policy inputs)
// ---------------------------------------------------------------------------

/**
 * The bounded promotion configuration — EXPLICIT policy inputs
 * (never ambient, never self-raising): the shadow observation
 * bound, the canary exposure bound and required success rate, and
 * the equivalence policy floor.
 */
export interface PromotionConfiguration {
  /** The shadow observations required before canary ([1, 10000]). */
  readonly shadowObservationBound: number;
  /** The maximum canary exposure the policy admits ([1, 10000]). */
  readonly canaryExposureBound: number;
  /** The required canary success rate in (0, 1]. */
  readonly canaryRequiredSuccessRate: number;
  /** The equivalence policy floor (the suite's re-evaluation bound). */
  readonly equivalence: EquivalencePolicy;
}

/** Total, deterministic validation of the promotion configuration. */
export function validatePromotionConfiguration(
  value: PromotionConfiguration,
): PromotionConfiguration {
  if (typeof value !== "object" || value === null) {
    reject("promotion-input-shape", "promotion configuration must be an object");
  }
  const record = value as unknown as Record<string, unknown>;
  if (
    typeof record.shadowObservationBound !== "number" ||
    !Number.isInteger(record.shadowObservationBound) ||
    record.shadowObservationBound < 1 ||
    record.shadowObservationBound > MAX_SHADOW_OBSERVATIONS
  ) {
    reject("promotion-input-shape", "shadowObservationBound must be an integer in [1, 10000]", {
      got: boundedDetail(String(record.shadowObservationBound)),
    });
  }
  if (
    typeof record.canaryExposureBound !== "number" ||
    !Number.isInteger(record.canaryExposureBound) ||
    record.canaryExposureBound < 1 ||
    record.canaryExposureBound > MAX_CANARY_EXPOSURE
  ) {
    reject("promotion-input-shape", "canaryExposureBound must be an integer in [1, 10000]", {
      got: boundedDetail(String(record.canaryExposureBound)),
    });
  }
  if (
    typeof record.canaryRequiredSuccessRate !== "number" ||
    !Number.isFinite(record.canaryRequiredSuccessRate) ||
    record.canaryRequiredSuccessRate <= 0 ||
    record.canaryRequiredSuccessRate > 1
  ) {
    reject("promotion-input-shape", "canaryRequiredSuccessRate must be in (0, 1]", {
      got: boundedDetail(String(record.canaryRequiredSuccessRate)),
    });
  }
  if (record.equivalence === undefined || record.equivalence === null) {
    reject("promotion-input-shape", "the promotion configuration requires its equivalence policy");
  }
  validateEquivalencePolicy(record.equivalence as EquivalencePolicy);
  return value;
}

// ---------------------------------------------------------------------------
// The gate evidence (shadow / canary observations)
// ---------------------------------------------------------------------------

/** The SHADOW evidence: evaluation alongside the probabilistic path. */
export interface ShadowEvidence {
  /** The shadow evaluations observed ([0, 10000]). */
  readonly observationsCount: number;
  /** The output deviations observed ([0, observationsCount]). */
  readonly deviationCount: number;
  /** The explicit observation basis (bounded source attribution). */
  readonly basis: string;
}

/** Total, deterministic validation of the shadow evidence. */
export function validateShadowEvidence(value: ShadowEvidence): ShadowEvidence {
  if (typeof value !== "object" || value === null) {
    reject("promotion-input-shape", "shadow evidence must be an object");
  }
  const record = value as unknown as Record<string, unknown>;
  if (
    typeof record.observationsCount !== "number" ||
    !Number.isInteger(record.observationsCount) ||
    record.observationsCount < 0 ||
    record.observationsCount > MAX_SHADOW_OBSERVATIONS
  ) {
    reject("promotion-input-shape", "shadow observationsCount must be an integer in [0, 10000]", {
      got: boundedDetail(String(record.observationsCount)),
    });
  }
  if (
    typeof record.deviationCount !== "number" ||
    !Number.isInteger(record.deviationCount) ||
    record.deviationCount < 0 ||
    record.deviationCount > record.observationsCount
  ) {
    reject(
      "promotion-input-shape",
      "shadow deviationCount must be an integer in [0, observationsCount]",
      {
        got: boundedDetail(String(record.deviationCount)),
      },
    );
  }
  if (typeof record.basis !== "string" || record.basis.length === 0 || record.basis.length > 200) {
    reject("promotion-input-shape", "shadow evidence must carry its explicit basis");
  }
  return value;
}

/** The CANARY evidence: bounded production exposure under policy/budget. */
export interface CanaryEvidence {
  /** The production exposures observed ([0, 10000], within the policy bound). */
  readonly exposureCount: number;
  /** The successful exposures ([0, exposureCount]). */
  readonly successCount: number;
  /** The output deviations observed ([0, exposureCount]). */
  readonly deviationCount: number;
  /** The explicit exposure basis (bounded source attribution). */
  readonly basis: string;
}

/** Total, deterministic validation of the canary evidence. */
export function validateCanaryEvidence(value: CanaryEvidence): CanaryEvidence {
  if (typeof value !== "object" || value === null) {
    reject("promotion-input-shape", "canary evidence must be an object");
  }
  const record = value as unknown as Record<string, unknown>;
  if (
    typeof record.exposureCount !== "number" ||
    !Number.isInteger(record.exposureCount) ||
    record.exposureCount < 0 ||
    record.exposureCount > MAX_CANARY_EXPOSURE
  ) {
    reject("promotion-input-shape", "canary exposureCount must be an integer in [0, 10000]", {
      got: boundedDetail(String(record.exposureCount)),
    });
  }
  if (
    typeof record.successCount !== "number" ||
    !Number.isInteger(record.successCount) ||
    record.successCount < 0 ||
    record.successCount > record.exposureCount
  ) {
    reject(
      "promotion-input-shape",
      "canary successCount must be an integer in [0, exposureCount]",
      {
        got: boundedDetail(String(record.successCount)),
      },
    );
  }
  if (
    typeof record.deviationCount !== "number" ||
    !Number.isInteger(record.deviationCount) ||
    record.deviationCount < 0 ||
    record.deviationCount > record.exposureCount
  ) {
    reject(
      "promotion-input-shape",
      "canary deviationCount must be an integer in [0, exposureCount]",
      {
        got: boundedDetail(String(record.deviationCount)),
      },
    );
  }
  if (typeof record.basis !== "string" || record.basis.length === 0 || record.basis.length > 200) {
    reject("promotion-input-shape", "canary evidence must carry its explicit basis");
  }
  return value;
}

// ---------------------------------------------------------------------------
// The promotion decision input and verdict
// ---------------------------------------------------------------------------

/** The gate evidence available to the decision (validated when present). */
export interface GateEvidence {
  /** The shadow evidence, when shadow evaluation has begun. */
  readonly shadow: ShadowEvidence | null;
  /** The canary evidence, when canary exposure has begun. */
  readonly canary: CanaryEvidence | null;
}

/** The promotion decision input (everything, explicitly). */
export interface PromotionDecisionInput {
  /** The competence record being promoted (carries its current stage). */
  readonly record: CompetenceRecord;
  /** The deterministic replacement candidate (the full suite required). */
  readonly replacement: DeterministicReplacementCandidate;
  /** The gate evidence available (shadow/canary observations). */
  readonly gateEvidence: GateEvidence;
  /**
   * The authority identity REQUESTING the promotion (must differ
   * from every trajectory executor and the record's miner — agents
   * never promote their own output).
   */
  readonly requestedBy: string;
  /** The quality facts (the assurance floor — inviolable). */
  readonly qualityFacts: QualityFacts;
  /** The governing constraint set (hard constraints enforced). */
  readonly constraints: readonly OptimizationConstraint[];
  /** The bounded promotion configuration (explicit policy inputs). */
  readonly configuration: PromotionConfiguration;
  /** The digest port (content addressing — injected, never ambient). */
  readonly digest: IrDigestPort;
}

/** One typed promotion reason (recorded evidence, never silent). */
export interface PromotionReason {
  /** EXACTLY ONE closed inadmissible code. */
  readonly code: PromotionInadmissibleCode;
  /** The bounded human-auditable detail. */
  readonly detail: string;
}

/** The frozen promotion-decision basis. */
export const PROMOTION_DECISION_BASIS =
  "gated-path-only-one-stage-at-a-time;target-computed-never-supplied;full-equivalence-suite-required-at-every-gate;shadow-observations-before-canary;canary-exposure-before-deterministic;independent-requesting-authority;economics-through-shared-admissibility;verdict-is-evidence-never-an-engine";

/**
 * The promotion verdict: `promoted` (the advance happened — the
 * ADVANCED record is the evidence), `hold` (the current-stage gate
 * requirements are not yet met — keep observing), or `reject`
 * (permanent inadmissibility: self-promotion, gate-order violation,
 * equivalence failure, economics below floor).
 */
export interface PromotionVerdict {
  readonly kind: PromotionOutcome;
  /** The stage the record was advanced TO (promoted verdicts only). */
  readonly targetStage?: PromotionStage;
  /** The advanced record value (promoted verdicts only — content-addressed). */
  readonly advancedRecord?: CompetenceRecord;
  /** The typed reasons (empty iff promoted). */
  readonly reasons: readonly PromotionReason[];
  /** The record's stage the decision ran from. */
  readonly fromStage: PromotionStage;
  /** The equivalence verdict under the governing policy floor. */
  readonly equivalence: EquivalenceVerdict;
  /** The governing facts the decision ran under. */
  readonly facts: GoverningFacts;
  /** The frozen, human-auditable decision basis. */
  readonly decisionBasis: string;
}

// ---------------------------------------------------------------------------
// The promotion decision (pure, deterministic, total)
// ---------------------------------------------------------------------------

/**
 * Decide the gated promotion. THE pure decision: validate
 * everything → compute the target stage from the CURRENT stage
 * (rank + 1 — never caller-supplied) → apply the cumulative gate
 * requirements (equivalence suite under the policy floor, shared
 * economics admissibility, independence, then the current gate's
 * observation/exposure bounds) → the verdict.
 *
 * Fail-closed on unmet input preconditions (shapes, bounds,
 * record/replacement coherence); the verdict itself is typed
 * evidence (`promoted`/`hold`/`reject` with reasons).
 */
export function decidePromotion(input: PromotionDecisionInput): PromotionVerdict {
  // --- Input validation (total) ------------------------------------------
  if (typeof input !== "object" || input === null) {
    reject("promotion-input-shape", "the promotion decision requires its input");
  }
  const configuration = validatePromotionConfiguration(input.configuration);
  const qualityFacts = validateQualityFacts(input.qualityFacts);
  const constraints = validateConstraintSet(input.constraints);
  if (input.gateEvidence === undefined || input.gateEvidence === null) {
    reject("promotion-input-shape", "the promotion decision requires its gate evidence");
  }
  if (input.gateEvidence.shadow !== null && input.gateEvidence.shadow !== undefined) {
    validateShadowEvidence(input.gateEvidence.shadow);
  }
  if (input.gateEvidence.canary !== null && input.gateEvidence.canary !== undefined) {
    validateCanaryEvidence(input.gateEvidence.canary);
  }
  if (typeof input.requestedBy !== "string" || !AUTHORITY_ID_PATTERN.test(input.requestedBy)) {
    reject("promotion-input-shape", "the promotion decision requires the requesting authority", {
      got: boundedDetail(String(input.requestedBy)),
    });
  }

  // Read-time validation: the record and the replacement are both
  // content-addressed values re-validated here (tampered values
  // never reach a promotion verdict).
  const record = validateCompetenceRecord(input.record, input.digest);
  const replacement = validateDeterministicReplacement(input.replacement, input.digest);

  // --- Record/replacement coherence (the replacement replaces THE
  // record's work: same scope, same capability, tags covered) ------
  if (
    record.scope.tenantId !== replacement.scope.tenantId ||
    record.scope.applicationId !== replacement.scope.applicationId
  ) {
    reject("promotion-input-shape", "the replacement belongs to a different scope than the record");
  }
  if (record.capabilityId !== replacement.capabilityId) {
    reject(
      "promotion-input-shape",
      "the replacement's capability does not match the record's applicability",
      {
        recordCapability: record.capabilityId,
        replacementCapability: replacement.capabilityId,
      },
    );
  }
  const covers = record.tags.every((tag) => replacement.tags.includes(tag));
  if (!covers) {
    reject(
      "promotion-input-shape",
      "the replacement's applicability tags do not cover the record's",
    );
  }

  // --- THE GATED PATH: the target stage is COMPUTED, never supplied ---
  const fromStage = record.stage;
  const fromRank = PROMOTION_STAGE_RANK[fromStage];
  const targetRank = fromRank + 1;
  const targetStage: PromotionStage | undefined = PROMOTION_STAGES[targetRank];
  if (targetStage === undefined || targetRank > PROMOTION_STAGE_RANK.deterministic) {
    // The terminal stage cannot advance: a promotion request past
    // `deterministic` is a typed gate-order violation.
    return {
      kind: "reject",
      reasons: [
        {
          code: "gate-order-violated",
          detail: `the record is at the terminal stage ${fromStage} (no further promotion exists)`,
        },
      ],
      fromStage,
      equivalence: evaluateEquivalenceSuite(replacement.suite, configuration.equivalence),
      facts: governingFacts(qualityFacts, constraints),
      decisionBasis: PROMOTION_DECISION_BASIS,
    };
  }

  // --- CUMULATIVE GATE 1: the full equivalence suite under the policy
  // floor (every gate re-proves the equivalence — never assumed) ---
  const reasons: PromotionReason[] = [];
  let permanent = false;
  const equivalence = evaluateEquivalenceSuite(replacement.suite, configuration.equivalence);
  if (!equivalence.admissible) {
    for (const failingKind of equivalence.failingKinds) {
      reasons.push({
        code: "evidence-suite-failed",
        detail: `the ${failingKind} evidence failed within the declared bounds (observed match rate ${equivalence.observedMatchRate}, threshold ${equivalence.effectiveMatchRateThreshold})`,
      });
    }
    permanent = true;
  }

  // --- CUMULATIVE GATE 1b: the shared economics admissibility (the
  // model-economics plane's OWN machinery — imported read-only) ---
  const governing = governingFacts(qualityFacts, constraints);
  const admissibility = evaluateAdmissibility(
    {
      candidateId: replacement.replacementId,
      representationClass: DETERMINISTIC_REPLACEMENT_CLASS,
      claim: replacement.claim,
    },
    governing,
  );
  if (!admissibility.admissible) {
    const code = economicsCodeOf(admissibility.inadmissibleCode);
    reasons.push({
      code,
      detail: `the deterministic replacement claim failed the governing economics (${admissibility.inadmissibleCode ?? "unknown"})`,
    });
    permanent = true;
  }

  // --- CUMULATIVE GATE 1c: NO SELF-PROMOTION (the requesting
  // authority must be independent of the trajectory executors and
  // the miner — agents never promote their own output) -----------
  if (
    record.trajectoryExecutors.includes(input.requestedBy) ||
    record.minedBy === input.requestedBy
  ) {
    reasons.push({
      code: "self-promotion",
      detail:
        "the requesting authority is a trajectory executor or the record's miner (agents never promote their own output)",
    });
    permanent = true;
  }

  // --- THE CURRENT GATE'S requirements (the observation/exposure
  // bounds — the stage-specific discipline) -------------------------
  if (targetRank === PROMOTION_STAGE_RANK.canary) {
    // GATE shadow → canary: the shadow evidence must exist and have
    // observed the bound with ZERO deviations.
    const shadow = input.gateEvidence.shadow;
    if (shadow === null || shadow === undefined) {
      reasons.push({
        code: "shadow-observation-bound",
        detail:
          "the shadow gate requires its shadow evidence (evaluation alongside the probabilistic path)",
      });
    } else if (shadow.observationsCount < configuration.shadowObservationBound) {
      reasons.push({
        code: "shadow-observation-bound",
        detail: `the shadow gate observed ${shadow.observationsCount} of the required ${configuration.shadowObservationBound} observations`,
      });
    } else if (shadow.deviationCount > 0) {
      reasons.push({
        code: "shadow-observation-bound",
        detail: `the shadow gate observed ${shadow.deviationCount} deviations (zero required before canary exposure)`,
      });
      permanent = true;
    }
  }
  if (targetRank === PROMOTION_STAGE_RANK.deterministic) {
    // GATE canary → deterministic: the canary evidence must have
    // completed its bounded exposure with the required success rate
    // and ZERO deviations.
    const canary = input.gateEvidence.canary;
    if (canary === null || canary === undefined) {
      reasons.push({
        code: "canary-exposure-bound",
        detail: "the canary gate requires its canary evidence (bounded production exposure)",
      });
    } else if (canary.exposureCount < 1) {
      reasons.push({
        code: "canary-exposure-bound",
        detail: "the canary gate has not begun its bounded exposure",
      });
    } else if (canary.exposureCount > configuration.canaryExposureBound) {
      reasons.push({
        code: "canary-exposure-bound",
        detail: `the canary exposure ${canary.exposureCount} exceeds the policy bound ${configuration.canaryExposureBound}`,
      });
      permanent = true;
    } else if (
      canary.successCount / canary.exposureCount <
      configuration.canaryRequiredSuccessRate
    ) {
      reasons.push({
        code: "canary-exposure-bound",
        detail: `the canary success rate ${canary.successCount / canary.exposureCount} is below the required ${configuration.canaryRequiredSuccessRate}`,
      });
      permanent = true;
    } else if (canary.deviationCount > 0) {
      reasons.push({
        code: "canary-exposure-bound",
        detail: `the canary gate observed ${canary.deviationCount} deviations (zero required before deterministic promotion)`,
      });
      permanent = true;
    }
  }

  // --- THE VERDICT --------------------------------------------------------
  if (reasons.length > 0) {
    return {
      kind: permanent ? "reject" : "hold",
      reasons,
      fromStage,
      equivalence,
      facts: governing,
      decisionBasis: PROMOTION_DECISION_BASIS,
    };
  }
  // The advance: the advanced record is a NEW content-addressed
  // value (the same evidence, the advanced stage) — pure derivation,
  // idempotent on re-run.
  const advancedRecord = advanceStage(record, targetStage, input.digest);
  return {
    kind: "promoted",
    targetStage,
    advancedRecord,
    reasons: [],
    fromStage,
    equivalence,
    facts: governing,
    decisionBasis: PROMOTION_DECISION_BASIS,
  };
}

/**
 * Advance a competence record to the NEXT stage: a new
 * content-addressed value with the same evidence and the advanced
 * stage. Pure and deterministic (the same record + target always
 * produce the byte-identical advanced record). The stage transition
 * is exactly +1 (validated — never a jump).
 */
export function advanceStage(
  record: CompetenceRecord,
  targetStage: PromotionStage,
  digest: IrDigestPort,
): CompetenceRecord {
  const fromRank = PROMOTION_STAGE_RANK[record.stage];
  const toRank = PROMOTION_STAGE_RANK[targetStage];
  if (toRank !== fromRank + 1) {
    reject("promotion-input-shape", "a stage advance is exactly one stage (never a jump)", {
      from: record.stage,
      to: targetStage,
    });
  }
  return buildCompetenceRecord({
    scope: record.scope,
    capabilityId: record.capabilityId,
    tags: record.tags,
    environment: record.environment,
    trajectoryDigest: record.trajectoryDigest,
    trajectoryExecutors: record.trajectoryExecutors,
    minedBy: record.minedBy,
    expectedOutcome: record.expectedOutcome,
    claim: record.claim,
    stage: targetStage,
    digest,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map the model-economics plane's inadmissible codes into this
 * plane's closed vocabulary (the economics dimensions overlap by
 * design — the shared machinery's codes are the same economics,
 * imported not re-invented). An unmappable code fails closed.
 */
function economicsCodeOf(code: string | undefined): PromotionInadmissibleCode {
  switch (code) {
    case "quality-below-hard-floor":
    case "quality-below-assurance":
    case "reliability-below-floor":
    case "budget-ceiling":
    case "latency-ceiling":
      return code;
    default:
      reject("promotion-input-shape", "the shared admissibility emitted an unmappable code", {
        got: boundedDetail(String(code)),
      });
  }
}
