/**
 * Decision-score typed facts (planning module domain, ACR-011 §2;
 * work order PCD-001 — the PREDICTION plane of the P4 program).
 *
 * THE GAP THIS MODULE TYPES (ACR-011 §1): the decision model carried
 * no typed contract for interchangeable scorers — an external
 * Jev/Laya/CLM-style scorer or a Zeck-trained scorer had no closed
 * vocabulary for what it may estimate (which score kinds exist), with
 * what provenance (scorer identity, version, configuration digest,
 * calibration basis) and what confidence discipline (declared bounds
 * or the honest unbounded-unknown). `DecisionScoreFacts` is that
 * typed contract: a closed, OPTIONAL, PREDICTION-ONLY fact block
 * attached to the planning decision record's candidate set (DATA,
 * never an engine — the continuation-package discipline), validated
 * fail-closed at the boundary and checked mechanically against the
 * decision record's candidate identities by pure function. A score is
 * a prediction with provenance and bounds — NEVER a measurement,
 * NEVER proof and NEVER an authority: the block carries no decision
 * rights, selects nothing, orders nothing, and wires itself into
 * NOTHING (the scorer seam is PCD-002's, default-off and
 * absence-equivalent; the evaluation is PCD-003's — both consume this
 * contract read-only).
 *
 * PLACEMENT (the PCL-001/PCS-002 location study applied to this
 * plane): the facts type the PLANNING decision's admissible candidates
 * — decision semantics belong to the planning module's domain layer
 * (AGENTS.md module table: "task profiling, plan generation and
 * deterministic plan selection"), so the pure prediction plane lives
 * here beside `decision.ts` (the record whose candidate set the block
 * attaches to), `strategy.ts` (the admissibility verdicts the boundary
 * check consumes) and `learned-policy-consultation.ts` (the LRN-002
 * ordering-only discipline a scored ordering must eventually obey:
 * after the hard admissibility filter, the deterministic-first
 * preference untouchable). Exactly as PCL-001 placed its typed facts
 * beside the outcome record they type, and PCS-002 beside the
 * capability record it types, this module owns ONLY the fact contract.
 *
 * THE CLOSED FACT BLOCK (every field closed and typed; unknown
 * kinds/values fail closed with a reason naming the field and the
 * offending value — never a default, never a widening):
 *
 *   score kind         → `candidate-success` |
 *                         `failure-class-distribution` |
 *                         `verifier-value` | `route-suitability` —
 *                         the closed vocabulary of what a scorer may
 *                         estimate about ONE admissible candidate;
 *   scorer kind        → `deterministic-baseline` |
 *                         `external-scorer` | `zeck-trained` — the
 *                         closed vocabulary of who scored;
 *   confidence
 *   discipline         → `bounded` | `unbounded-unknown` — every
 *                         estimate carries declared bounds in its own
 *                         scale, or states the honest unknown; a
 *                         scorer that cannot bound its confidence
 *                         says so — never a fabricated precision;
 *   failure classes    → the closed per-leg failure taxonomy of the
 *                         measured plane (provider-5xx,
 *                         provider-timeout, provider-throttle,
 *                         connection-error, verification-retry,
 *                         budget-exhausted, policy-denied) — MIRRORED
 *                         BY VALUE, never imported (the separation
 *                         law below); a distribution predicts a mass
 *                         over exactly these classes, absent classes
 *                         carry zero mass (undefined and null are BOTH
 *                         the absent spelling — never a widened
 *                         "none" member), the masses sum to at most
 *                         the unit mass, and the unattributed part is
 *                         the HONEST REMAINDER, recorded and
 *                         reconciled (never a silent gap);
 *   bounded estimates  → a probability in [0, 1] for
 *                         candidate-success; a non-negative estimate
 *                         in [0, 10^9] with a DECLARED SCALE (bounded,
 *                         non-empty) for verifier-value and
 *                         route-suitability — two estimates in
 *                         different declared scales are never
 *                         comparable numbers.
 *
 * EXPLICIT PROVENANCE ON EVERY FACT (ACR-011 §2, the explicit-basis
 * discipline applied to predictions): every score entry names its
 * scorer (the closed scorer-kind vocabulary + a neutral identity slug
 * + a version slug), the scorer's configuration digest, the
 * calibration basis digest, the candidate it scores, and the scoring
 * context digest (the read-only candidate/context facts the scorer
 * saw, digested). An unattributed prediction is unrepresentable.
 *
 * THE PREDICTION/MEASUREMENT SEPARATION LAW (ACR-011 §2/§5 — the
 * automatic-void condition): this is a PREDICTION plane. It imports
 * NOTHING from the outcome-evidence planes (structural: the module is
 * fully self-contained, zero imports of any kind), it shares NO
 * digest namespace with them (the canonical tag is this plane's own,
 * and the injected digest function is the CALLER's — never a shared
 * module-owned implementation), and the failure taxonomy above is
 * aligned with the measured plane BY VALUE (the same closed seven,
 * mirrored here, never imported). Prediction facts never merge with
 * measurement facts, never substitute for one another; conflation is
 * an automatic void condition. The architecture test pins the
 * separation mechanically.
 *
 * ABSENCE EQUIVALENCE (ACR-011 §2/§3; the PCR-002/ACR-009/ACR-010
 * discipline): the block is OPTIONAL — `undefined` and `null` are
 * BOTH the absent spelling (inside the block too: an absent failure
 * class is a zero-mass class, an absent bound is an absent bound), and
 * the canonical form renders every absence as key-omission, so all
 * absence spellings produce the byte-identical content address.
 * Absence of the block selects and records byte-identically to
 * today's behavior at every existing call site — this module adds no
 * call sites (the wiring is PCD-002's, default-off; the confinement
 * is pinned by the architecture test).
 *
 * NO DURABLE SURFACE, NO ENGINE (ACR-011 §5): this module declares no
 * store, no SQL, no state machine, no route decision, no selection, no
 * ordering, no scorer invocation — it types facts about candidates
 * that already exist in a planning decision record. The frozen
 * vocabularies here never widen the planning module's strategy or
 * admissibility vocabularies and never touch the measured plane's
 * taxonomies (alignment by value, never by import); the vocabulary
 * census is pinned by the architecture test (widening is a reviewed
 * change, never silent).
 *
 * Pure and total: no environment reads, no clock, no randomness, no
 * I/O — the same facts always produce the byte-identical validation
 * verdict, canonical form and content address (invariant 5). The
 * module is fully self-contained: zero imports.
 */

// ---------------------------------------------------------------------------
// The frozen vocabularies (closed — widening is a reviewed change)
// ---------------------------------------------------------------------------

/**
 * The closed vocabulary of what a scorer may estimate about one
 * admissible candidate (ACR-011 §2): the probability the candidate
 * succeeds, a mass distribution over the per-leg failure taxonomy, a
 * non-negative estimate of the verification value for the candidate,
 * or a non-negative bounded ranking score with a declared scale.
 * Never interchangeable, never defaulted — unknown kinds fail closed.
 */
export const DECISION_SCORE_KINDS = [
  "candidate-success",
  "failure-class-distribution",
  "verifier-value",
  "route-suitability",
] as const;
export type DecisionScoreKind = (typeof DECISION_SCORE_KINDS)[number];

/**
 * The closed vocabulary of who scored (ACR-011 §2): the deterministic
 * baseline the compiler already implies, an interchangeable external
 * scorer (a Jev/Laya/CLM-style scorer), or a Zeck-trained scorer.
 * The kind rides the full provenance — identity, version and
 * configuration digest — never an ambient flag.
 */
export const SCORER_KINDS = ["deterministic-baseline", "external-scorer", "zeck-trained"] as const;
export type ScorerKind = (typeof SCORER_KINDS)[number];

/**
 * The closed confidence discipline (ACR-011 §2): every estimate either
 * carries declared bounds in its own scale (`bounded` — and the
 * declared interval must contain the estimate it bounds), or states
 * the honest `unbounded-unknown`. A scorer that cannot bound its
 * confidence says so — never a fabricated precision.
 */
export const CONFIDENCE_DISCIPLINES = ["bounded", "unbounded-unknown"] as const;
export type ConfidenceDiscipline = (typeof CONFIDENCE_DISCIPLINES)[number];

/**
 * The closed per-leg failure taxonomy a `failure-class-distribution`
 * may predict a mass over — the measured plane's own closed seven
 * (ACR-010 §2), MIRRORED BY VALUE in this module and never imported
 * from it (the prediction/measurement separation law). The mirror
 * stays aligned by value — the architecture test pins the alignment;
 * widening either side is a reviewed change, never silent. An absent
 * class (undefined | null) carries zero mass — the taxonomy is never
 * widened with a "none" member.
 */
export const SCORED_FAILURE_CLASSES = [
  "provider-5xx",
  "provider-timeout",
  "provider-throttle",
  "connection-error",
  "verification-retry",
  "budget-exhausted",
  "policy-denied",
] as const;
export type ScoredFailureClass = (typeof SCORED_FAILURE_CLASSES)[number];

// ---------------------------------------------------------------------------
// The typed fact block
// ---------------------------------------------------------------------------

/**
 * Pure validation verdict for the closed fact block (the planning
 * domain's locally declared spelling of the typed-facts discipline —
 * this module is self-contained, mirroring the PCL-001 precedent).
 */
export type FactValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

/**
 * The candidate-success estimate: a probability in [0, 1]. The
 * confidence bounds live in the same probability scale and must
 * contain the probability.
 */
export interface CandidateSuccessValue {
  readonly kind: "candidate-success";
  /** The predicted probability of candidate success — a finite number in [0, 1]. */
  readonly probability: number;
}

/**
 * The failure-class-distribution estimate: a mass over the closed
 * per-leg failure taxonomy, summing to at most the unit mass, with
 * the unattributed part recorded as the HONEST REMAINDER and
 * reconciled (ACR-011 §2). The reconciliation IS the ≤-1 mass law:
 * an over-attributing distribution would need a negative remainder,
 * and an unattributed gap is never silent — both fail closed typed.
 */
export interface FailureClassDistributionValue {
  readonly kind: "failure-class-distribution";
  /**
   * The predicted mass per failure class (the closed seven, mirrored
   * by value). ABSENT (undefined | null) = zero mass for that class —
   * mass-function semantics over the closed taxonomy; a PRESENT zero
   * is the honest zero claim and never collapses into absence.
   */
  readonly masses: Readonly<Partial<Record<ScoredFailureClass, number | null>>>;
  /**
   * The honest remainder: the unit mass NOT attributed to any failure
   * class (the success-and-unpredicted part), REQUIRED and reconciled
   * to the masses within MASS_RECONCILIATION_TOLERANCE.
   */
  readonly remainder: number;
}

/**
 * The verifier-value estimate: a non-negative bounded estimate of the
 * verification value for the candidate, in a DECLARED scale (a
 * bounded, non-empty scale declaration — two estimates in different
 * declared scales are never comparable numbers).
 */
export interface VerifierValueEstimate {
  readonly kind: "verifier-value";
  /** The predicted estimate — a finite number in [0, MAX_SCORED_ESTIMATE]. */
  readonly estimate: number;
  /** The declared scale the estimate lives in (bounded, non-empty). */
  readonly scale: string;
}

/**
 * The route-suitability estimate: a non-negative bounded ranking
 * score with a declared scale (ACR-011 §2). The score may at most
 * refine the ORDERING among admissible candidates — never widen,
 * never bypass, never override; this module types the value and
 * carries no such rights.
 */
export interface RouteSuitabilityEstimate {
  readonly kind: "route-suitability";
  /** The predicted ranking score — a finite number in [0, MAX_SCORED_ESTIMATE]. */
  readonly estimate: number;
  /** The declared scale the score lives in (bounded, non-empty). */
  readonly scale: string;
}

/**
 * The typed bounded score value — one of the closed four score kinds.
 * The union's discriminator is the closed `kind` vocabulary; unknown
 * kinds fail closed, never default.
 */
export type DecisionScoreValue =
  | CandidateSuccessValue
  | FailureClassDistributionValue
  | VerifierValueEstimate
  | RouteSuitabilityEstimate;

/**
 * The confidence an estimate carries (ACR-011 §2): declared bounds in
 * the estimate's own scale, or the honest unbounded-unknown. The
 * incoherent shapes are rejected typed — a `bounded` without both
 * bounds, an inverted interval, an interval excluding its own point
 * estimate, or an `unbounded-unknown` carrying bounds (an honest
 * unknown is never a fabricated precision).
 */
export type ScoreConfidence =
  | {
      readonly kind: "bounded";
      /** The declared lower bound, in the estimate's own scale. */
      readonly lowerBound: number;
      /** The declared upper bound, in the estimate's own scale. */
      readonly upperBound: number;
    }
  | { readonly kind: "unbounded-unknown" };

/**
 * The scorer provenance: WHO scored (the closed scorer-kind
 * vocabulary, a neutral identity slug and a version slug) and UNDER
 * WHICH configuration (the configuration digest) — the explicit-basis
 * discipline applied to predictions. A score without its scorer is
 * unrepresentable.
 */
export interface ScorerProvenance {
  /** The closed scorer-kind vocabulary member. */
  readonly kind: ScorerKind;
  /** The scorer's neutral identity slug (e.g. an external scorer's name). */
  readonly identity: string;
  /** The scorer's version slug. */
  readonly version: string;
  /** The digest of the scorer configuration that produced the score. */
  readonly configurationDigest: string;
}

/**
 * The EXPLICIT provenance on every score entry (ACR-011 §2): the
 * scorer (kind, identity, version, configuration digest), the
 * calibration basis digest, the candidate the entry scores, and the
 * scoring context digest (the read-only candidate/context facts the
 * scorer saw, digested). Every element is required; an unattributed
 * prediction is unrepresentable.
 */
export interface ScoreProvenance {
  readonly scorer: ScorerProvenance;
  /** The digest of the calibration basis the scorer declares. */
  readonly calibrationBasisDigest: string;
  /** The bounded identity of the candidate this entry scores. */
  readonly candidateId: string;
  /** The digest of the scoring context the scorer saw. */
  readonly scoringContextDigest: string;
}

/**
 * One typed score entry: the bounded value (one of the closed four
 * score kinds), the confidence discipline it carries, and the
 * explicit provenance. A prediction with provenance and bounds —
 * never a measurement, never an authority.
 */
export interface DecisionScoreEntry {
  readonly value: DecisionScoreValue;
  readonly confidence: ScoreConfidence;
  readonly provenance: ScoreProvenance;
}

/**
 * The closed decision-score fact block (ACR-011 §2): an OPTIONAL,
 * PREDICTION-ONLY block attached to the planning decision record's
 * candidate set. Absent (undefined | null) = the
 * byte-identical-today state. The block carries NO decision rights —
 * it selects nothing, orders nothing, and never revisits an
 * admissibility verdict.
 */
export interface DecisionScoreFacts {
  /**
   * The score entries (bounded, non-empty, duplicate-free by the
   * score identity: candidate + score kind + scorer identity +
   * scorer version — the same scorer-version scoring the same
   * candidate on the same kind twice is the duplicate shape,
   * rejected typed; a different scorer, version, candidate or kind is
   * a distinct entry).
   */
  readonly entries: readonly DecisionScoreEntry[];
}

// ---------------------------------------------------------------------------
// Total, deterministic, fail-closed validation
// ---------------------------------------------------------------------------

/** The score-entry census bound. */
export const MAX_SCORE_ENTRIES = 256;
/** The boundary candidate census bound (the record side's candidate set). */
export const MAX_BOUNDARY_CANDIDATES = 256;
/** The declared-scale estimate bound: a finite number in [0, 10^9]. */
export const MAX_SCORED_ESTIMATE = 1_000_000_000;
/**
 * The unit-mass reconciliation tolerance: the predicted masses and
 * the honest remainder must reconcile the unit mass to within this
 * frozen epsilon. Decimal fractions rounding in double arithmetic
 * reconcile honestly (0.2 + 0.4 + 0.3 + 0.1 sums to 1.0000000000000002
 * in doubles — an honest scorer is never rejected for float noise);
 * an over-attribution or an unattributed gap beyond the tolerance
 * fails closed. Pinned by the architecture test — changing it is a
 * reviewed change.
 */
export const MASS_RECONCILIATION_TOLERANCE = 1e-9;
/** Bounded identity fields (candidate/decision identities). */
const IDENTITY_MAX = 128;
/** The declared-scale bound (verifier-value and route-suitability scales). */
const SCALE_MAX = 64;
/** Neutral scorer identity/version slugs (the plane's slug discipline). */
const NEUTRAL_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Lowercase hex digests (provenance digests: 8..128 hex characters). */
const DIGEST_PATTERN = /^[0-9a-f]{8,128}$/;
/** The bounded rendering of an offending value inside a reason. */
const REASON_VALUE_LIMIT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Render an offending value bounded — the reason names it, never floods. */
function boundedValue(value: unknown): string {
  // Numbers render via String (NaN/Infinity keep their honest spelling —
  // JSON.stringify would flatten them to "null", naming the wrong value).
  const rendered =
    typeof value === "string"
      ? value
      : typeof value === "number"
        ? String(value)
        : value === undefined
          ? "undefined"
          : JSON.stringify(value);
  return rendered.length > REASON_VALUE_LIMIT
    ? `${rendered.slice(0, REASON_VALUE_LIMIT)}…`
    : rendered;
}

/** The closed-vocabulary rejection: names the field, the vocabulary and the offending value. */
function closedVocabularyReason(
  field: string,
  vocabulary: readonly string[],
  value: unknown,
): string {
  return `decisionScoreFacts.${field} must be one of ${vocabulary.join("|")}: ${boundedValue(value)}`;
}

/** The absence spelling: undefined and null are BOTH the absent spelling. */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * The frozen-order total of a distribution's predicted masses (the
 * closed taxonomy's own order — input key order is never the sum
 * order; the total is a deterministic function of the masses alone).
 */
function failureMassTotal(masses: unknown): number {
  if (!isRecord(masses)) {
    return 0;
  }
  let total = 0;
  for (const failureClass of SCORED_FAILURE_CLASSES) {
    const mass = masses[failureClass];
    if (!isAbsent(mass)) {
      total += mass as number;
    }
  }
  return total;
}

function validateFailureClassDistribution(
  value: Record<string, unknown>,
  field: string,
): string | null {
  if (!isRecord(value.masses)) {
    return `decisionScoreFacts.${field}.masses must be the mass record over the closed per-leg failure taxonomy (absent classes carry zero mass): ${boundedValue(value.masses)}`;
  }
  // The closed taxonomy: an unknown class key fails closed, never a widening.
  for (const key of Object.keys(value.masses)) {
    if (!(SCORED_FAILURE_CLASSES as readonly string[]).includes(key)) {
      return closedVocabularyReason(`${field}.masses key`, SCORED_FAILURE_CLASSES, key);
    }
  }
  // The frozen-order mass pass: each present mass is a finite [0, 1]
  // number; the total sums in the taxonomy's own order (deterministic).
  let total = 0;
  for (const failureClass of SCORED_FAILURE_CLASSES) {
    const mass = value.masses[failureClass];
    if (isAbsent(mass)) {
      continue;
    }
    if (typeof mass !== "number" || !Number.isFinite(mass) || mass < 0 || mass > 1) {
      return `decisionScoreFacts.${field}.masses.${failureClass} must be a finite mass in [0, 1] (absent classes carry zero mass — never a widened "none" member): ${boundedValue(mass)}`;
    }
    total += mass;
  }
  if (
    typeof value.remainder !== "number" ||
    !Number.isFinite(value.remainder) ||
    value.remainder < 0 ||
    value.remainder > 1
  ) {
    return `decisionScoreFacts.${field}.remainder must be a finite number in [0, 1] (the honest remainder — the unit mass not attributed to any failure class): ${boundedValue(value.remainder)}`;
  }
  const remainder = value.remainder as number;
  if (Math.abs(total + remainder - 1) > MASS_RECONCILIATION_TOLERANCE) {
    return `decisionScoreFacts.${field}: the predicted masses and the honest remainder must reconcile the unit mass within ${MASS_RECONCILIATION_TOLERANCE} (an over-attribution would need a negative remainder and an unattributed gap is never silent): Σmasses=${total}, remainder=${remainder}, Σmasses+remainder=${total + remainder}`;
  }
  return null;
}

function validateScoreValue(value: unknown, field: string): string | null {
  if (!isRecord(value)) {
    return `decisionScoreFacts.${field} must be the typed score value {kind: candidate-success | failure-class-distribution | verifier-value | route-suitability, …}: ${boundedValue(value)}`;
  }
  if (
    typeof value.kind !== "string" ||
    !(DECISION_SCORE_KINDS as readonly string[]).includes(value.kind)
  ) {
    return closedVocabularyReason(`${field}.kind`, DECISION_SCORE_KINDS, value.kind);
  }
  const kind = value.kind as DecisionScoreKind;
  if (kind === "candidate-success") {
    if (
      typeof value.probability !== "number" ||
      !Number.isFinite(value.probability) ||
      value.probability < 0 ||
      value.probability > 1
    ) {
      return `decisionScoreFacts.${field}.probability must be a finite number in [0, 1] (the candidate-success probability): ${boundedValue(value.probability)}`;
    }
    return null;
  }
  if (kind === "failure-class-distribution") {
    return validateFailureClassDistribution(value, field);
  }
  // verifier-value | route-suitability: the non-negative bounded
  // estimate with its declared scale.
  if (
    typeof value.estimate !== "number" ||
    !Number.isFinite(value.estimate) ||
    value.estimate < 0 ||
    value.estimate > MAX_SCORED_ESTIMATE
  ) {
    return `decisionScoreFacts.${field}.estimate must be a finite number in [0, ${MAX_SCORED_ESTIMATE}] (the non-negative bounded ${kind} estimate): ${boundedValue(value.estimate)}`;
  }
  if (
    typeof value.scale !== "string" ||
    value.scale.length === 0 ||
    value.scale.length > SCALE_MAX
  ) {
    return `decisionScoreFacts.${field}.scale must be a bounded non-empty declared scale (<=${SCALE_MAX}): ${boundedValue(value.scale)}`;
  }
  return null;
}

/**
 * Validate the confidence discipline against the estimate it bounds.
 * `point` is what the bounds must contain (the probability, the
 * distribution's frozen-order total mass, or the declared-scale
 * estimate); `scaleMax` is the kind's scale ceiling (1 for the
 * probability and mass scales, MAX_SCORED_ESTIMATE for the declared
 * scales); `tolerantContainment` selects the tolerance-aware
 * containment the distribution's summed total requires (decimal
 * masses summing in double arithmetic reconcile within the frozen
 * tolerance, never exactly).
 */
function validateConfidence(
  confidence: unknown,
  field: string,
  point: number,
  scaleMax: number,
  tolerantContainment: boolean,
): string | null {
  if (!isRecord(confidence)) {
    return `decisionScoreFacts.${field} must be the confidence {kind: bounded, lowerBound, upperBound} | {kind: unbounded-unknown}: ${boundedValue(confidence)}`;
  }
  if (confidence.kind === "bounded") {
    for (const boundField of ["lowerBound", "upperBound"] as const) {
      const bound = confidence[boundField];
      if (typeof bound !== "number" || !Number.isFinite(bound) || bound < 0 || bound > scaleMax) {
        return `decisionScoreFacts.${field}.${boundField} must be a finite number in [0, ${scaleMax}] (the declared bound lives in the estimate's own scale): ${boundedValue(bound)}`;
      }
    }
    const lowerBound = confidence.lowerBound as number;
    const upperBound = confidence.upperBound as number;
    if (lowerBound > upperBound) {
      return `decisionScoreFacts.${field}: bounded requires lowerBound <= upperBound (a declared interval is never inverted): lowerBound=${lowerBound}, upperBound=${upperBound}`;
    }
    const contains = tolerantContainment
      ? point + MASS_RECONCILIATION_TOLERANCE >= lowerBound &&
        point - MASS_RECONCILIATION_TOLERANCE <= upperBound
      : point >= lowerBound && point <= upperBound;
    if (!contains) {
      return `decisionScoreFacts.${field}: bounded must contain the estimate (a declared interval excluding its own point estimate is the incoherent shape, rejected): estimate=${point}, lowerBound=${lowerBound}, upperBound=${upperBound}`;
    }
    return null;
  }
  if (confidence.kind === "unbounded-unknown") {
    if (!isAbsent(confidence.lowerBound) || !isAbsent(confidence.upperBound)) {
      return `decisionScoreFacts.${field}: unbounded-unknown cannot carry bounds (the incoherent shape is rejected — an honest unknown is never a fabricated precision)`;
    }
    return null;
  }
  return closedVocabularyReason(`${field}.kind`, CONFIDENCE_DISCIPLINES, confidence.kind);
}

/** Validate the confidence against the typed value it bounds (per-kind scale + containment). */
function validateConfidenceForValue(
  scoreValue: DecisionScoreValue,
  confidence: unknown,
  field: string,
): string | null {
  if (scoreValue.kind === "candidate-success") {
    return validateConfidence(confidence, field, scoreValue.probability, 1, false);
  }
  if (scoreValue.kind === "failure-class-distribution") {
    return validateConfidence(confidence, field, failureMassTotal(scoreValue.masses), 1, true);
  }
  return validateConfidence(confidence, field, scoreValue.estimate, MAX_SCORED_ESTIMATE, false);
}

function validateProvenance(value: unknown, field: string): string | null {
  if (!isRecord(value)) {
    return `decisionScoreFacts.${field} is required on every score entry (the explicit-provenance discipline — an unattributed prediction is unrepresentable): ${boundedValue(value)}`;
  }
  const scorer = value.scorer;
  if (!isRecord(scorer)) {
    return `decisionScoreFacts.${field}.scorer is required on every score entry (who scored, at which version, under which configuration digest): ${boundedValue(scorer)}`;
  }
  if (
    typeof scorer.kind !== "string" ||
    !(SCORER_KINDS as readonly string[]).includes(scorer.kind)
  ) {
    return closedVocabularyReason(`${field}.scorer.kind`, SCORER_KINDS, scorer.kind);
  }
  if (typeof scorer.identity !== "string" || !NEUTRAL_SLUG_PATTERN.test(scorer.identity)) {
    return `decisionScoreFacts.${field}.scorer.identity must be a neutral scorer slug: ${boundedValue(scorer.identity)}`;
  }
  if (typeof scorer.version !== "string" || !NEUTRAL_SLUG_PATTERN.test(scorer.version)) {
    return `decisionScoreFacts.${field}.scorer.version must be a neutral version slug: ${boundedValue(scorer.version)}`;
  }
  if (
    typeof scorer.configurationDigest !== "string" ||
    !DIGEST_PATTERN.test(scorer.configurationDigest)
  ) {
    return `decisionScoreFacts.${field}.scorer.configurationDigest must be a lowercase hex digest (8..128 hex characters): ${boundedValue(scorer.configurationDigest)}`;
  }
  if (
    typeof value.calibrationBasisDigest !== "string" ||
    !DIGEST_PATTERN.test(value.calibrationBasisDigest)
  ) {
    return `decisionScoreFacts.${field}.calibrationBasisDigest must be a lowercase hex digest (8..128 hex characters — the calibration basis, explicitly digested): ${boundedValue(value.calibrationBasisDigest)}`;
  }
  if (
    typeof value.candidateId !== "string" ||
    value.candidateId.length === 0 ||
    value.candidateId.length > IDENTITY_MAX
  ) {
    return `decisionScoreFacts.${field}.candidateId must be a bounded non-empty identity (<=${IDENTITY_MAX}): ${boundedValue(value.candidateId)}`;
  }
  if (
    typeof value.scoringContextDigest !== "string" ||
    !DIGEST_PATTERN.test(value.scoringContextDigest)
  ) {
    return `decisionScoreFacts.${field}.scoringContextDigest must be a lowercase hex digest (8..128 hex characters — the read-only context the scorer saw): ${boundedValue(value.scoringContextDigest)}`;
  }
  return null;
}

/**
 * Total, deterministic, fail-closed validation of the closed fact
 * block. Every field's vocabulary is closed; every bound is typed;
 * every rejection's reason names the field and the offending value.
 * The check order is frozen (the entries array's shape and census
 * bounds, then per entry: provenance → value → confidence, then the
 * duplicate-free entry census) — the same input always yields the
 * byte-identical first rejection. Absence is NOT handled here (the
 * riding point decides the absence spelling) — this function
 * validates a PRESENT block only.
 */
export function validateDecisionScoreFacts(value: unknown): FactValidation {
  if (!isRecord(value)) {
    return {
      valid: false,
      reason: "decisionScoreFacts must be an object (the closed fact block)",
    };
  }
  if (!Array.isArray(value.entries)) {
    return {
      valid: false,
      reason:
        "decisionScoreFacts.entries must be an array of score entries (the closed block carries its predictions as entries)",
    };
  }
  if (value.entries.length === 0) {
    return {
      valid: false,
      reason:
        "decisionScoreFacts.entries must declare at least one score entry (a present-but-empty block is the zombie shape — the block's absence is the absent spelling, never an empty block)",
    };
  }
  if (value.entries.length > MAX_SCORE_ENTRIES) {
    return {
      valid: false,
      reason: `decisionScoreFacts.entries must hold at most ${MAX_SCORE_ENTRIES} score entries (bounded): ${value.entries.length}`,
    };
  }
  const seenIdentities = new Set<string>();
  for (let index = 0; index < value.entries.length; index += 1) {
    const entry = value.entries[index];
    const field = `entries[${index}]`;
    if (!isRecord(entry)) {
      return {
        valid: false,
        reason: `decisionScoreFacts.${field} must be a score entry object {value, confidence, provenance}: ${boundedValue(entry)}`,
      };
    }
    // The frozen per-entry order: provenance first (the entry's
    // identity names the candidate for every later rejection), then
    // the typed value, then the confidence that bounds it.
    const provenanceError = validateProvenance(entry.provenance, `${field}.provenance`);
    if (provenanceError !== null) {
      return { valid: false, reason: provenanceError };
    }
    const provenance = entry.provenance as ScoreProvenance;
    const entryField = `${field}[candidate=${provenance.candidateId}]`;
    const valueError = validateScoreValue(entry.value, `${entryField}.value`);
    if (valueError !== null) {
      return { valid: false, reason: valueError };
    }
    const scoreValue = entry.value as DecisionScoreValue;
    const confidenceError = validateConfidenceForValue(
      scoreValue,
      entry.confidence,
      `${entryField}.confidence`,
    );
    if (confidenceError !== null) {
      return { valid: false, reason: confidenceError };
    }
    // The entry census: duplicate-free by the score identity (the
    // candidate, the score kind, the scorer identity and version).
    const identityKey = JSON.stringify([
      provenance.candidateId,
      scoreValue.kind,
      provenance.scorer.identity,
      provenance.scorer.version,
    ]);
    if (seenIdentities.has(identityKey)) {
      return {
        valid: false,
        reason: `decisionScoreFacts.entries must not contain a duplicate score identity (candidate, score kind, scorer identity, scorer version): ${boundedValue(identityKey)}`,
      };
    }
    seenIdentities.add(identityKey);
  }
  return { valid: true };
}

/**
 * Validate the OPTIONAL fact block at a riding point: absence
 * (undefined AND null — both the absent spelling) is valid and
 * byte-identical to the pre-change behavior; a present block is
 * validated fail-closed. Pure and total — the riding points PCD-002
 * wires call this seam.
 */
export function validateOptionalDecisionScoreFacts(
  value: DecisionScoreFacts | null | undefined,
): FactValidation {
  if (isAbsent(value)) {
    return { valid: true };
  }
  return validateDecisionScoreFacts(value);
}

// ---------------------------------------------------------------------------
// Canonical serialization + content-addressable identity (the PCR-001
// RecoveryPlan discipline: the content address is the digest over the
// canonical form; same facts → same address, always — and this
// plane's digest namespace is its OWN, never the measured plane's)
// ---------------------------------------------------------------------------

/**
 * Recursively canonicalize: sorted keys at every depth; undefined and
 * null values are BOTH the absent spelling and render as key-omission
 * (all absence spellings produce the byte-identical canonical form);
 * arrays keep their element order (entries are pre-sorted by their
 * identity tuple — the caller-visible order is never identity).
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .filter((key) => !isAbsent(record[key]))
      .sort()
      .map((key) => [key, canonical(record[key])]);
  }
  return value;
}

/** Code-unit ordering (deterministic across environments — never locale-dependent). */
function byCodeUnitOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The entry identity tuple order (the canonical entry census order):
 * candidate, score kind, scorer identity, scorer version — each by
 * code-unit ordering. The frozen order is the canonical order;
 * input order is never identity.
 */
function compareEntryIdentity(left: DecisionScoreEntry, right: DecisionScoreEntry): number {
  const candidate = byCodeUnitOrder(left.provenance.candidateId, right.provenance.candidateId);
  if (candidate !== 0) {
    return candidate;
  }
  const kind = byCodeUnitOrder(left.value.kind, right.value.kind);
  if (kind !== 0) {
    return kind;
  }
  const identity = byCodeUnitOrder(
    left.provenance.scorer.identity,
    right.provenance.scorer.identity,
  );
  if (identity !== 0) {
    return identity;
  }
  return byCodeUnitOrder(left.provenance.scorer.version, right.provenance.scorer.version);
}

/**
 * Deterministic canonical JSON of the fact block (the module's own
 * content-addressing base, mirroring the PCL-001 canonical-JSON
 * discipline): a tagged tuple carrying THIS plane's own namespace tag,
 * with the entries sorted by their identity tuple and every nested
 * object rendered as sorted-key pair arrays with absence as
 * key-omission. The same facts always produce the byte-identical
 * canonical form — and the tag never collides with any measured
 * plane's namespace (the prediction/measurement separation law).
 */
export function canonicalDecisionScoreJson(facts: DecisionScoreFacts): string {
  return JSON.stringify([
    "planning.decision-score-facts",
    [...facts.entries].sort(compareEntryIdentity).map((entry) => canonical(entry)),
  ]);
}

/**
 * The content-addressable identity of one fact block for evidence
 * correlation: the digest (INJECTED — never ambient, never
 * module-owned, never shared with the measured planes) over the
 * canonical form. Deterministic — the same facts always produce the
 * byte-identical identity.
 */
export function decisionScoreFactsIdentity(
  facts: DecisionScoreFacts,
  digest: (canonical: string) => string,
): string {
  return digest(canonicalDecisionScoreJson(facts));
}

// ---------------------------------------------------------------------------
// The attachment-boundary check (pure, no wiring — PCD-002 wires the
// riding points; this is the mechanical identity check)
// ---------------------------------------------------------------------------

/**
 * The decision-record side of the attachment boundary: one candidate
 * identity from the planning decision record's candidate set — the
 * candidate's bounded identity and the record's OWN admissibility
 * verdict (mirrored by value into a minimal typed view; the record
 * itself is never duplicated).
 */
export interface PlanningCandidateIdentity {
  readonly candidateId: string;
  readonly admissible: boolean;
}

/**
 * The decision-record side of the attachment boundary: the decision's
 * bounded identity and its candidate set's identity view (bounded,
 * non-empty, duplicate-free by candidateId).
 */
export interface DecisionRecordIdentity {
  readonly decisionId: string;
  readonly candidates: readonly PlanningCandidateIdentity[];
}

/** Why the boundary check was skipped (absence of either side — exactly today's behavior). */
export type DecisionScoreBoundarySkipReason =
  | "facts-absent"
  | "record-absent"
  | "both-sides-absent";

/**
 * The closed mismatch vocabulary at the attachment boundary: an entry
 * claiming a candidate the record's candidate set does not carry
 * (`candidate-not-in-set`), or an entry scoring a candidate the
 * record itself marks INADMISSIBLE (`candidate-not-admissible` — the
 * ordering-only law made mechanical: scores refine the ordering among
 * candidates the effective policy ALREADY admits, and a score for an
 * inadmissible candidate is the authority-encroachment shape, typed
 * and named, never a silent ride).
 */
export type DecisionScoreMismatchKind = "candidate-not-in-set" | "candidate-not-admissible";

/**
 * One typed mismatch at the attachment boundary: the mismatch kind,
 * the entry's provenance (the side the fact claims), the candidate the
 * entry claims to score, and BOTH sides of the record — the record's
 * full candidate-id census and its admissible subset (deterministic
 * code-unit-sorted renderings; the mismatch names both sides, never
 * just one).
 */
export interface DecisionScoreMismatch {
  readonly kind: DecisionScoreMismatchKind;
  /** The entry's provenance — the side the fact claims. */
  readonly factsProvenance: ScoreProvenance;
  /** The candidate the entry claims to score. */
  readonly claimedCandidateId: string;
  /** The record's full candidate-id census (the other side, named). */
  readonly recordCandidateIds: readonly string[];
  /** The record's ADMISSIBLE candidate ids (the ordering-only law's side, named). */
  readonly recordAdmissibleCandidateIds: readonly string[];
}

/**
 * The typed boundary verdict. DATA, never an engine: `compatible`
 * (every entry scores an admissible candidate the record carries),
 * `skipped` (absence of either side — the check does not fire,
 * exactly today), `invalid` (a present-but-malformed side at the
 * boundary — fail closed, never a permissive default) or
 * `incompatible` (every mismatch typed, both sides named).
 */
export type DecisionScoreBoundaryCheck =
  | { readonly kind: "compatible" }
  | { readonly kind: "skipped"; readonly reason: DecisionScoreBoundarySkipReason }
  | { readonly kind: "invalid"; readonly side: "facts" | "record"; readonly reason: string }
  | { readonly kind: "incompatible"; readonly mismatches: readonly DecisionScoreMismatch[] };

function validateDecisionRecordIdentity(value: unknown): string | null {
  if (!isRecord(value)) {
    return `decisionRecord must be the record identity {decisionId, candidates}: ${boundedValue(value)}`;
  }
  if (
    typeof value.decisionId !== "string" ||
    value.decisionId.length === 0 ||
    value.decisionId.length > IDENTITY_MAX
  ) {
    return `decisionRecord.decisionId must be a bounded non-empty identity (<=${IDENTITY_MAX}): ${boundedValue(value.decisionId)}`;
  }
  if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
    return `decisionRecord.candidates must be a non-empty array of candidate identities {candidateId, admissible}: ${boundedValue(value.candidates)}`;
  }
  if (value.candidates.length > MAX_BOUNDARY_CANDIDATES) {
    return `decisionRecord.candidates must hold at most ${MAX_BOUNDARY_CANDIDATES} candidates (bounded): ${value.candidates.length}`;
  }
  const seen = new Set<string>();
  for (const candidate of value.candidates) {
    if (!isRecord(candidate)) {
      return `decisionRecord.candidates entry must be the candidate identity {candidateId, admissible}: ${boundedValue(candidate)}`;
    }
    if (
      typeof candidate.candidateId !== "string" ||
      candidate.candidateId.length === 0 ||
      candidate.candidateId.length > IDENTITY_MAX
    ) {
      return `decisionRecord.candidates entry candidateId must be a bounded non-empty identity (<=${IDENTITY_MAX}): ${boundedValue(candidate.candidateId)}`;
    }
    if (typeof candidate.admissible !== "boolean") {
      return `decisionRecord.candidates entry admissible must be a boolean (the record's own admissibility verdict — never revisited by a score): ${boundedValue(candidate.admissible)}`;
    }
    if (seen.has(candidate.candidateId)) {
      return `decisionRecord.candidates must not contain duplicate candidateId: ${boundedValue(candidate.candidateId)}`;
    }
    seen.add(candidate.candidateId);
  }
  return null;
}

/**
 * Check the fact block's entries against the decision record's
 * candidate set at the attachment boundary: every entry's claimed
 * candidate must be one the record carries, and one the record itself
 * marks admissible (the ordering-only law — a score may only refine
 * the ordering among candidates the effective policy already admits).
 * Pure and deterministic — the same inputs always produce the
 * byte-identical verdict (invariant 5); mismatches are reported in the
 * canonical entry-identity order.
 *
 * Absence of either side skips the check exactly as today
 * (absence-equivalent); a malformed fact block OR a malformed record
 * identity is a typed `invalid` verdict naming the side — both sides
 * are pre-validated fail-closed BEFORE any comparison (a malformed
 * side is never compared).
 */
export function checkDecisionScoreBoundary(input: {
  readonly facts: DecisionScoreFacts | null | undefined;
  readonly record: DecisionRecordIdentity | null | undefined;
}): DecisionScoreBoundaryCheck {
  // undefined and null are BOTH the absent spelling on either side.
  const facts = input.facts;
  const record = input.record;
  if ((facts === undefined || facts === null) && (record === undefined || record === null)) {
    return { kind: "skipped", reason: "both-sides-absent" };
  }
  if (facts === undefined || facts === null) {
    return { kind: "skipped", reason: "facts-absent" };
  }
  if (record === undefined || record === null) {
    return { kind: "skipped", reason: "record-absent" };
  }
  // Both sides PRESENT: validate both fail-closed before any
  // comparison (a malformed side at the boundary is never compared).
  const factsValidation = validateDecisionScoreFacts(facts);
  if (!factsValidation.valid) {
    return { kind: "invalid", side: "facts", reason: factsValidation.reason };
  }
  const recordError = validateDecisionRecordIdentity(record);
  if (recordError !== null) {
    return { kind: "invalid", side: "record", reason: recordError };
  }
  const recordCandidateIds = record.candidates
    .map((candidate) => candidate.candidateId)
    .sort(byCodeUnitOrder);
  const recordAdmissibleCandidateIds = record.candidates
    .filter((candidate) => candidate.admissible)
    .map((candidate) => candidate.candidateId)
    .sort(byCodeUnitOrder);
  const mismatches: DecisionScoreMismatch[] = [];
  // The canonical entry-identity order is the frozen mismatch order —
  // input order never reorders the verdict.
  for (const entry of [...facts.entries].sort(compareEntryIdentity)) {
    const claimedCandidateId = entry.provenance.candidateId;
    const inSet = record.candidates.some(
      (candidate) => candidate.candidateId === claimedCandidateId,
    );
    if (!inSet) {
      mismatches.push({
        kind: "candidate-not-in-set",
        factsProvenance: entry.provenance,
        claimedCandidateId,
        recordCandidateIds,
        recordAdmissibleCandidateIds,
      });
      continue;
    }
    const admissible = record.candidates.some(
      (candidate) => candidate.candidateId === claimedCandidateId && candidate.admissible,
    );
    if (!admissible) {
      mismatches.push({
        kind: "candidate-not-admissible",
        factsProvenance: entry.provenance,
        claimedCandidateId,
        recordCandidateIds,
        recordAdmissibleCandidateIds,
      });
    }
  }
  if (mismatches.length > 0) {
    return { kind: "incompatible", mismatches };
  }
  return { kind: "compatible" };
}
