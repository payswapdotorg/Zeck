/**
 * The closed vocabularies, typed errors and bounds of the
 * competence-economics plane (platform competence-economics plane;
 * WORK-056 / E1.1 charter member "Competence-aware Optimization and
 * Progressive Deterministicization" — the FINAL E1.1 charter member;
 * ADR-0019, ADR-0020).
 *
 * COMPETENCE IS EVIDENCE, NEVER AUTHORITY (the Work Order's first
 * architecture invariant — the soul of this plane): competence
 * records carry expected-outcome and cost evidence with explicit
 * bases; no permission semantics ride on them. This catalog closes
 * the plane's vocabularies ONCE, fail-closed:
 *
 *  - the representation class of a competence record is the
 *    foundation's OWN `verified-competence` ladder rank (WORK-049
 *    `REPRESENTATION_CLASSES` — never a new class invented here);
 *  - the promotion stages are closed and ordered
 *    (candidate → shadow → canary → deterministic): the ONLY
 *    promotion route is one stage at a time — gate-skipping is
 *    structurally unrepresentable (a jump request is a typed
 *    gate-order violation, never a silent promotion);
 *  - the equivalence-evidence kinds are closed to exactly the full
 *    suite (differential / property / replay — the Work Order's
 *    own vocabulary): a deterministic replacement without ALL
 *    THREE is inadmissible by construction;
 *  - the rollback reason vocabulary is closed (equivalence-degraded
 *    / quality-degraded / economics-degraded / policy-revoked) —
 *    every rollback names exactly one, never a silent revert;
 *  - every bound (corpus size, retrieval results, applicability
 *    dimensions, equivalence cases, observation counts, exposure
 *    counts, evidence entries) is explicit and total: unbounded
 *    values are typed rejections, never silent defaults.
 *
 * Everything here is neutral vocabulary: capability references,
 * competence bindings and authority identities are OPAQUE bounded
 * slugs (no vendor, no provider SDK semantics — the discipline
 * shared with the whole E1.1 family).
 */

// ---------------------------------------------------------------------------
// The closed competence representation vocabulary
// ---------------------------------------------------------------------------

/**
 * THE representation class of every competence record: the
 * foundation's canonical ladder rank for verified competence
 * (WORK-049 `REPRESENTATION_CLASSES` — consumed, never re-declared:
 * a competence record competes in the E1.1 ladder exactly where the
 * foundation pinned it, between cache-reuse and programmatic
 * execution).
 */
export const COMPETENCE_REPRESENTATION_CLASS = "verified-competence" as const;

/**
 * The representation class of a deterministic replacement: the
 * foundation's OWN `deterministic-computation` ladder rank — the
 * cheapest rank a governed outcome can take (the progressive
 * deterministicization goal).
 */
export const DETERMINISTIC_REPLACEMENT_CLASS = "deterministic-computation" as const;

/**
 * The closed tool-representation vocabulary the deterministic
 * replacement's execution binding rides (the merged tool-surface
 * plane's OWN vocabulary — WORK-051; every member is a member of
 * `TOOL_REPRESENTATIONS`, validated through the plane's own
 * `isToolRepresentation` in `equivalence.ts`): `competence` (a
 * verified competence reference binding) and `code` (a bounded
 * code-API binding for programmatic deterministic execution).
 */
export const REPLACEMENT_BINDING_REPRESENTATIONS = ["competence", "code"] as const;
export type ReplacementBindingRepresentation = (typeof REPLACEMENT_BINDING_REPRESENTATIONS)[number];

// ---------------------------------------------------------------------------
// The closed promotion vocabulary (the gated path)
// ---------------------------------------------------------------------------

/**
 * THE four promotion stages — the ONLY promotion route. Stage order
 * is the array order: candidate → shadow → canary → deterministic.
 * `candidate` is the mining output (observation, never authority);
 * `shadow` is evaluation ALONGSIDE the probabilistic path (no
 * production exposure); `canary` is bounded exposure under explicit
 * policy/budget bounds; `deterministic` is the promoted replacement.
 * A promotion request that skips a stage is a typed gate-order
 * violation — PROMOTION-GATES.
 */
export const PROMOTION_STAGES = ["candidate", "shadow", "canary", "deterministic"] as const;
export type PromotionStage = (typeof PROMOTION_STAGES)[number];

/**
 * The deterministic stage rank (tie-break and gate-order proof).
 */
export const PROMOTION_STAGE_RANK: Readonly<Record<PromotionStage, number>> = {
  candidate: 0,
  shadow: 1,
  canary: 2,
  deterministic: 3,
};

/**
 * The closed promotion-request vocabulary: `advance` requests the
 * NEXT stage (exactly one — never more); `rollback` requests the
 * bounded revert (handled by `rollback.ts`, never by the promotion
 * decision).
 */
export const PROMOTION_REQUESTS = ["advance"] as const;
export type PromotionRequest = (typeof PROMOTION_REQUESTS)[number];

/**
 * The closed reason-code vocabulary for promotion inadmissibility —
 * every rejected promotion carries EXACTLY ONE code (recorded,
 * never silent):
 *
 *  - `evidence-suite-incomplete` — the deterministic-replacement
 *    candidate lacks the full differential/property/replay suite
 *    (the no-equivalence-evidence guard);
 *  - `evidence-suite-failed` — a suite component evaluated outside
 *    its declared bounds (match rate, property failures, replay
 *    deviations);
 *  - `gate-order-violated` — the request skips a stage (candidate →
 *    canary, candidate → deterministic, shadow → deterministic) or
 *    the current stage is already terminal;
 *  - `shadow-observation-bound` — the shadow gate has not observed
 *    the required observation count (or observed deviations);
 *  - `canary-exposure-bound` — the canary gate has not completed its
 *    bounded exposure (or the observed success rate is below the
 *    required bound);
 *  - `trajectory-not-successful` — the mining corpus carries a
 *    non-successful trajectory (mining observes successes only);
 *  - `insufficient-repetition` — the repetition evidence is below
 *    the minimum (single lucky runs never become competence);
 *  - `self-promotion` — the requesting identity is the trajectory's
 *    own executor or the record's miner (an agent NEVER promotes its
 *    own output — LEARNING-NONAUTHORITY);
 *  - `quality-below-hard-floor` / `quality-below-assurance` /
 *    `reliability-below-floor` / `budget-ceiling` /
 *    `latency-ceiling` — the governing economics (the
 *    model-economics plane's shared machinery — imported, never
 *    re-implemented) rejected the candidate's claim;
 *  - `replacement-not-bound` — the deterministic replacement carries
 *    no execution binding (an unbound replacement cannot be
 *    evaluated).
 */
export const PROMOTION_INADMISSIBLE_CODES = [
  "evidence-suite-incomplete",
  "evidence-suite-failed",
  "gate-order-violated",
  "shadow-observation-bound",
  "canary-exposure-bound",
  "trajectory-not-successful",
  "insufficient-repetition",
  "self-promotion",
  "quality-below-hard-floor",
  "quality-below-assurance",
  "reliability-below-floor",
  "budget-ceiling",
  "latency-ceiling",
  "replacement-not-bound",
] as const;
export type PromotionInadmissibleCode = (typeof PROMOTION_INADMISSIBLE_CODES)[number];

/**
 * The closed promotion-outcome vocabulary (the verdict kinds: a
 * gated advance, a hold, or a rejection — exactly one per decision).
 */
export const PROMOTION_OUTCOME_CODES = ["promoted", "hold", "reject"] as const;
export type PromotionOutcome = (typeof PROMOTION_OUTCOME_CODES)[number];

// ---------------------------------------------------------------------------
// The closed equivalence-evidence vocabulary
// ---------------------------------------------------------------------------

/**
 * THE full equivalence-evidence suite — closed to exactly the three
 * kinds the Work Order names. A deterministic replacement is
 * promotable ONLY with ALL THREE (a suite with a missing component
 * is structurally incomplete — typed rejection, never a partial
 * pass).
 */
export const EQUIVALENCE_EVIDENCE_KINDS = ["differential", "property", "replay"] as const;
export type EquivalenceEvidenceKind = (typeof EQUIVALENCE_EVIDENCE_KINDS)[number];

/**
 * The closed retrieval inadmissibility vocabulary (per-record
 * applicability verdicts — recorded evidence, never silent):
 *
 *  - `capability-mismatch` — the record's capability bound does not
 *    cover the query's capability (including scope mismatch — a
 *    different tenant/application is a different capability
 *    position);
 *  - `tag-bounds-mismatch` — the record's applicability tags do not
 *    cover the query's declared tags (the work is out of bounds);
 *  - `environment-drift` — the query's environment fingerprint does
 *    not match the record's (out-of-environment competence is not
 *    applicable — WORK-055's own comparison, consumed);
 *  - `quality-below-floor` — the record's expected quality is below
 *    the configuration's quality floor (the foundation's own
 *    quality-preserving rule, applied as validity);
 *  - `record-shape` — the record failed read-time validation.
 */
export const RETRIEVAL_INADMISSIBLE_CODES = [
  "capability-mismatch",
  "tag-bounds-mismatch",
  "environment-drift",
  "quality-below-floor",
  "record-shape",
] as const;
export type RetrievalInadmissibleCode = (typeof RETRIEVAL_INADMISSIBLE_CODES)[number];

// ---------------------------------------------------------------------------
// The closed rollback vocabulary
// ---------------------------------------------------------------------------

/**
 * The closed degradation vocabulary — the typed reasons a promotion
 * may be rolled back to the prior representation (evidence
 * degradation only, never silent):
 *
 *  - `equivalence-degraded` — the equivalence evidence no longer
 *    holds within its declared bounds (new differential/property/
 *    replay observations broke equivalence);
 *  - `quality-degraded` — the observed quality fell below the
 *    governing floor (the verification authority's own measurement);
 *  - `economics-degraded` — the expected successful-resolution cost
 *    regressed beyond the prior representation's (the economics
 *    inverted);
 *  - `policy-revoked` — the governing policy authority revoked the
 *    promotion basis (the policy authority stays the authority).
 */
export const ROLLBACK_REASON_CODES = [
  "equivalence-degraded",
  "quality-degraded",
  "economics-degraded",
  "policy-revoked",
] as const;
export type RollbackReasonCode = (typeof ROLLBACK_REASON_CODES)[number];

// ---------------------------------------------------------------------------
// Bounds (every value the plane admits is bounded)
// ---------------------------------------------------------------------------

/** Bounded opaque capability references (neutral slugs, no vendor words). */
export const CAPABILITY_REF_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Bounded neutral applicability tags. */
export const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Bounded opaque authority identities (the promotion-executing authority). */
export const AUTHORITY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** Bounded neutral execution-binding references (the tool-surface discipline). */
export const BINDING_REF_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** Bounded human-auditable detail text. */
export const DETAIL_MAX = 500;
/** The hard bound on records a retrieval corpus may carry. */
export const MAX_CORPUS_SIZE = 1024;
/** The hard bound on results a retrieval may return ([1, 16]). */
export const MAX_RETRIEVAL_RESULTS = 16;
/** The hard bound on applicability tags per record/query ([1, 32]). */
export const MAX_APPLICABILITY_TAGS = 32;
/** The hard bound on trajectories a mining corpus may carry ([1, 256]). */
export const MAX_MINING_TRAJECTORIES = 256;
/** The minimum distinct successful trajectories mining requires (>= 2). */
export const MIN_SUCCESSFUL_TRAJECTORIES = 2;
/** The hard bound on differential/property/replay evaluation cases ([1, 10000]). */
export const MAX_EQUIVALENCE_CASES = 10000;
/** The hard bound on shadow observations the evidence may carry ([0, 10000]). */
export const MAX_SHADOW_OBSERVATIONS = 10000;
/** The hard bound on canary exposure counts ([1, 10000]). */
export const MAX_CANARY_EXPOSURE = 10000;
/** The hard bound on degradation-evidence entries a rollback may carry ([1, 64]). */
export const MAX_ROLLBACK_EVIDENCE_ENTRIES = 64;
/** sha256 hex digest shape (content addressing across the plane). */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
/** The bounded detail ceiling shared with the sibling planes. */
export const BASIS_DETAIL_MAX = 500;

/** Bounded detail helper (the sibling planes' own discipline). */
export function boundedDetail(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;
}

// ---------------------------------------------------------------------------
// The typed, bounded competence-economics error
// ---------------------------------------------------------------------------

/**
 * The closed invariant-code vocabulary of the competence-economics
 * plane. Every rejection names exactly one — machine-checkable,
 * bounded evidence:
 *
 *  - `record-shape` — a competence record failed its total
 *    validation (bounds, basis, identity);
 *  - `record-self-asserted` — the record's miner identity is one of
 *    the trajectory's own executors (an agent NEVER marks its own
 *    output as competence — LEARNING-NONAUTHORITY);
 *  - `record-unattributed` — the record carries no miner identity or
 *    no repetition evidence (no attribution → no competence);
 *  - `trajectory-shape` — a successful trajectory failed its total
 *    validation (outcome, verification binding, digest, bounds);
 *  - `mining-input-shape` — the mining corpus failed validation
 *    (bounds, coherence, success discipline);
 *  - `retrieval-input-shape` — the retrieval input failed validation
 *    (query bounds, configuration bounds, corpus bound);
 *  - `equivalence-shape` — the equivalence-evidence suite failed
 *    validation (kinds, counts, bounds digests, ratios);
 *  - `equivalence-suite-incomplete` — a deterministic replacement
 *    admission lacked one of the three suite components (the
 *    no-equivalence-evidence guard, fail-closed);
 *  - `equivalence-suite-failed` — a suite component failed within
 *    its declared bounds (admission-time guard);
 *  - `replacement-shape` — the deterministic-replacement candidate
 *    failed validation (binding, applicability, incumbent facts);
 *  - `promotion-input-shape` — the promotion input failed validation
 *    (configuration bounds, evidence bounds, authority identity);
 *  - `rollback-shape` — the rollback input/record failed validation
 *    (promotion binding, degradation evidence, bounds);
 *  - `decision-invalid` — a WORK-049 decision record failed its own
 *    total validation (fail closed — never emitted unvalidated).
 */
export const COMPETENCE_ECONOMICS_INVARIANT_CODES = [
  "record-shape",
  "record-self-asserted",
  "record-unattributed",
  "trajectory-shape",
  "mining-input-shape",
  "retrieval-input-shape",
  "equivalence-shape",
  "equivalence-suite-incomplete",
  "equivalence-suite-failed",
  "replacement-shape",
  "promotion-input-shape",
  "rollback-shape",
  "decision-invalid",
] as const;
export type CompetenceEconomicsInvariantCode =
  (typeof COMPETENCE_ECONOMICS_INVARIANT_CODES)[number];

/** The typed, bounded competence-economics error. */
export class CompetenceEconomicsError extends Error {
  readonly invariant: CompetenceEconomicsInvariantCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    invariant: CompetenceEconomicsInvariantCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = "CompetenceEconomicsError";
    this.invariant = invariant;
    const boundedDetails: Record<string, string | number | boolean | null> = {};
    if (details !== undefined) {
      for (const [key, value] of Object.entries(details)) {
        boundedDetails[key] = typeof value === "string" ? boundedDetail(value) : value;
      }
    }
    this.details = Object.freeze(boundedDetails);
  }
}

/** Fail closed with the typed error (never a silent default). */
export function reject(
  invariant: CompetenceEconomicsInvariantCode,
  message: string,
  details?: Readonly<Record<string, string | number | boolean | null>>,
): never {
  throw new CompetenceEconomicsError(invariant, message, details);
}
