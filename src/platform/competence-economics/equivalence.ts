/**
 * Deterministic replacement candidates and the
 * differential/property/replay equivalence evidence suite (platform
 * competence-economics plane; WORK-056 / E1.1 — ADR-0019, ADR-0020
 * progressive deterministicization).
 *
 * EQUIVALENCE IS PROVEN, NOT ASSUMED (the Work Order's third
 * architecture invariant): every deterministic replacement carries
 * the FULL differential / property / replay evidence suite within
 * its declared bounds — unproven candidates are INADMISSIBLE by
 * construction:
 *
 *  - a replacement candidate REPLACES repeated probabilistic work
 *    (the incumbent representation with its own explicit-basis
 *    claim) with deterministic execution bound through the MERGED
 *    tool-surface plane's OWN closed representation vocabulary
 *    (`competence` reference bindings and `code` API bindings —
 *    validated with the plane's own `isToolRepresentation`,
 *    imported read-only; a binding outside their vocabulary is a
 *    typed rejection, never a silent binding);
 *  - the DIFFERENTIAL evidence records the sampled-case comparison
 *    of the probabilistic and deterministic paths within the
 *    declared input-space bounds (its `boundsDigest` pins the exact
 *    bounds): the match rate must meet the declared required rate;
 *  - the PROPERTY evidence records the property-based evaluation
 *    (typed property checks over the declared bounds): the failure
 *    count must be ZERO;
 *  - the REPLAY evidence records the replay of the RECORDED
 *    successful trajectories through the deterministic path (the
 *    mining corpus's own trajectories): the deviation count must be
 *    ZERO;
 *  - the suite is COMPLETE by type: a candidate without ALL THREE
 *    components cannot be constructed (admission fails closed —
 *    `evidence-suite-incomplete` is structurally unrepresentable at
 *    admission, and the promotion decision re-evaluates the suite
 *    under the governing policy floor);
 *  - the candidate is CONTENT-ADDRESSED (`replacementId` = digest
 *    over the canonical form) and read-time-validated with identity
 *    re-derivation (tampered values are rejected, never served).
 *
 * Pure and deterministic: no clock, no randomness, no ambient state.
 * The equivalence evidence never redefines quality gates
 * (VERIFICATION-SEPARATION): it records observed comparisons and
 * property/replay outcomes; the verification authority's contracts
 * remain the only quality authority.
 */

import type { TenantCacheScope } from "../context-economics/keys";
import { validateTenantCacheScope } from "../context-economics/keys";
import { canonicalJson, isCanonicalizable } from "../execution-ir/canonical";
import type { CostClaim, RepresentationClass } from "../execution-ir/cost-model";
import { REPRESENTATION_CLASSES, validateCostClaim } from "../execution-ir/cost-model";
import type { IrDigestPort } from "../execution-ir/ir";
import { isToolRepresentation } from "../tool-surface/catalog";
import {
  BINDING_REF_PATTERN,
  boundedDetail,
  CAPABILITY_REF_PATTERN,
  type EquivalenceEvidenceKind,
  MAX_APPLICABILITY_TAGS,
  MAX_EQUIVALENCE_CASES,
  PROMOTION_INADMISSIBLE_CODES,
  type PromotionInadmissibleCode,
  REPLACEMENT_BINDING_REPRESENTATIONS,
  type ReplacementBindingRepresentation,
  reject,
  SHA256_HEX_PATTERN,
  TAG_PATTERN,
} from "./catalog";

// ---------------------------------------------------------------------------
// The equivalence evidence suite (the three closed kinds)
// ---------------------------------------------------------------------------

/**
 * The DIFFERENTIAL evidence: the sampled-case comparison of the
 * probabilistic and deterministic paths within the declared
 * input-space bounds. The match rate must meet the declared
 * required rate (within bounds — never outside them).
 */
export interface DifferentialEvidence {
  readonly kind: "differential";
  /** The number of sampled input cases ([1, 10000]). */
  readonly casesCount: number;
  /** The cases whose outputs matched ([0, casesCount]). */
  readonly matchedCount: number;
  /** The declared required match rate in (0, 1] (the bounds' own threshold). */
  readonly requiredMatchRate: number;
  /** sha256 over the declared input-space bounds (the exact sampled space). */
  readonly boundsDigest: string;
  /** The explicit evaluation basis (bounded source attribution). */
  readonly basis: string;
}

/**
 * The PROPERTY evidence: the property-based evaluation over the
 * declared bounds. The failure count must be ZERO (any property
 * failure breaks equivalence).
 */
export interface PropertyEvidence {
  readonly kind: "property";
  /** The number of distinct properties evaluated ([1, 10000]). */
  readonly propertiesCount: number;
  /** The total property checks executed ([>= propertiesCount, 10000]). */
  readonly checksCount: number;
  /** The property failures observed ([0, checksCount]) — must be ZERO. */
  readonly failuresCount: number;
  /** sha256 over the declared property bounds. */
  readonly boundsDigest: string;
  /** The explicit evaluation basis. */
  readonly basis: string;
}

/**
 * The REPLAY evidence: the replay of the RECORDED successful
 * trajectories through the deterministic path. The deviation count
 * must be ZERO (any deviation breaks equivalence).
 */
export interface ReplayEvidence {
  readonly kind: "replay";
  /** The number of recorded trajectories replayed ([1, 10000]). */
  readonly trajectoriesReplayed: number;
  /** The output deviations observed ([0, trajectoriesReplayed]) — must be ZERO. */
  readonly deviationsCount: number;
  /** sha256 over the declared replay bounds (the trajectory corpus bounds). */
  readonly boundsDigest: string;
  /** The explicit evaluation basis. */
  readonly basis: string;
}

/**
 * THE FULL equivalence-evidence suite — all three components are
 * REQUIRED by type: a partial suite is unrepresentable (admission
 * fails closed on any missing component).
 */
export interface EquivalenceEvidenceSuite {
  readonly differential: DifferentialEvidence;
  readonly property: PropertyEvidence;
  readonly replay: ReplayEvidence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Total, deterministic validation of the differential evidence. */
export function validateDifferentialEvidence(value: unknown): DifferentialEvidence {
  if (!isRecord(value)) {
    reject("equivalence-shape", "differential evidence must be an object");
  }
  const record = value;
  if (record.kind !== "differential") {
    reject("equivalence-shape", "the evidence kind must be differential", {
      got: boundedDetail(String(record.kind)),
    });
  }
  if (
    typeof record.casesCount !== "number" ||
    !Number.isInteger(record.casesCount) ||
    record.casesCount < 1 ||
    record.casesCount > MAX_EQUIVALENCE_CASES
  ) {
    reject("equivalence-shape", "differential casesCount must be an integer in [1, 10000]", {
      got: boundedDetail(String(record.casesCount)),
    });
  }
  if (
    typeof record.matchedCount !== "number" ||
    !Number.isInteger(record.matchedCount) ||
    record.matchedCount < 0 ||
    record.matchedCount > record.casesCount
  ) {
    reject("equivalence-shape", "differential matchedCount must be an integer in [0, casesCount]", {
      got: boundedDetail(String(record.matchedCount)),
    });
  }
  if (
    typeof record.requiredMatchRate !== "number" ||
    !Number.isFinite(record.requiredMatchRate) ||
    record.requiredMatchRate <= 0 ||
    record.requiredMatchRate > 1
  ) {
    reject("equivalence-shape", "differential requiredMatchRate must be in (0, 1]", {
      got: boundedDetail(String(record.requiredMatchRate)),
    });
  }
  if (typeof record.boundsDigest !== "string" || !SHA256_HEX_PATTERN.test(record.boundsDigest)) {
    reject("equivalence-shape", "differential boundsDigest must be a sha256 hex digest", {
      got: boundedDetail(String(record.boundsDigest)),
    });
  }
  if (typeof record.basis !== "string" || record.basis.length === 0 || record.basis.length > 200) {
    reject("equivalence-shape", "differential evidence must carry its explicit basis", {
      got: boundedDetail(String(record.basis)),
    });
  }
  return value as unknown as DifferentialEvidence;
}

/** Total, deterministic validation of the property evidence. */
export function validatePropertyEvidence(value: unknown): PropertyEvidence {
  if (!isRecord(value)) {
    reject("equivalence-shape", "property evidence must be an object");
  }
  const record = value;
  if (record.kind !== "property") {
    reject("equivalence-shape", "the evidence kind must be property", {
      got: boundedDetail(String(record.kind)),
    });
  }
  if (
    typeof record.propertiesCount !== "number" ||
    !Number.isInteger(record.propertiesCount) ||
    record.propertiesCount < 1 ||
    record.propertiesCount > MAX_EQUIVALENCE_CASES
  ) {
    reject("equivalence-shape", "property propertiesCount must be an integer in [1, 10000]", {
      got: boundedDetail(String(record.propertiesCount)),
    });
  }
  if (
    typeof record.checksCount !== "number" ||
    !Number.isInteger(record.checksCount) ||
    record.checksCount < record.propertiesCount ||
    record.checksCount > MAX_EQUIVALENCE_CASES
  ) {
    reject(
      "equivalence-shape",
      "property checksCount must be an integer in [propertiesCount, 10000]",
      { got: boundedDetail(String(record.checksCount)) },
    );
  }
  if (
    typeof record.failuresCount !== "number" ||
    !Number.isInteger(record.failuresCount) ||
    record.failuresCount < 0 ||
    record.failuresCount > record.checksCount
  ) {
    reject("equivalence-shape", "property failuresCount must be an integer in [0, checksCount]", {
      got: boundedDetail(String(record.failuresCount)),
    });
  }
  if (typeof record.boundsDigest !== "string" || !SHA256_HEX_PATTERN.test(record.boundsDigest)) {
    reject("equivalence-shape", "property boundsDigest must be a sha256 hex digest", {
      got: boundedDetail(String(record.boundsDigest)),
    });
  }
  if (typeof record.basis !== "string" || record.basis.length === 0 || record.basis.length > 200) {
    reject("equivalence-shape", "property evidence must carry its explicit basis", {
      got: boundedDetail(String(record.basis)),
    });
  }
  return value as unknown as PropertyEvidence;
}

/** Total, deterministic validation of the replay evidence. */
export function validateReplayEvidence(value: unknown): ReplayEvidence {
  if (!isRecord(value)) {
    reject("equivalence-shape", "replay evidence must be an object");
  }
  const record = value;
  if (record.kind !== "replay") {
    reject("equivalence-shape", "the evidence kind must be replay", {
      got: boundedDetail(String(record.kind)),
    });
  }
  if (
    typeof record.trajectoriesReplayed !== "number" ||
    !Number.isInteger(record.trajectoriesReplayed) ||
    record.trajectoriesReplayed < 1 ||
    record.trajectoriesReplayed > MAX_EQUIVALENCE_CASES
  ) {
    reject("equivalence-shape", "replay trajectoriesReplayed must be an integer in [1, 10000]", {
      got: boundedDetail(String(record.trajectoriesReplayed)),
    });
  }
  if (
    typeof record.deviationsCount !== "number" ||
    !Number.isInteger(record.deviationsCount) ||
    record.deviationsCount < 0 ||
    record.deviationsCount > record.trajectoriesReplayed
  ) {
    reject(
      "equivalence-shape",
      "replay deviationsCount must be an integer in [0, trajectoriesReplayed]",
      { got: boundedDetail(String(record.deviationsCount)) },
    );
  }
  if (typeof record.boundsDigest !== "string" || !SHA256_HEX_PATTERN.test(record.boundsDigest)) {
    reject("equivalence-shape", "replay boundsDigest must be a sha256 hex digest", {
      got: boundedDetail(String(record.boundsDigest)),
    });
  }
  if (typeof record.basis !== "string" || record.basis.length === 0 || record.basis.length > 200) {
    reject("equivalence-shape", "replay evidence must carry its explicit basis", {
      got: boundedDetail(String(record.basis)),
    });
  }
  return value as unknown as ReplayEvidence;
}

// ---------------------------------------------------------------------------
// The equivalence verdict (the pure suite evaluation)
// ---------------------------------------------------------------------------

/**
 * The equivalence policy floor — the governing policy input the
 * promotion decision runs the suite under (an EXPLICIT input,
 * never ambient; the policy authority stays the authority).
 */
export interface EquivalencePolicy {
  /**
   * The minimum acceptable differential match rate in (0, 1] — the
   * governing floor (the effective threshold is the MAXIMUM of the
   * suite's declared required rate and this floor).
   */
  readonly minimumMatchRate: number;
}

/** Total, deterministic validation of the equivalence policy. */
export function validateEquivalencePolicy(value: EquivalencePolicy): EquivalencePolicy {
  if (typeof value !== "object" || value === null) {
    reject("equivalence-shape", "equivalence policy must be an object");
  }
  const record = value as unknown as Record<string, unknown>;
  if (
    typeof record.minimumMatchRate !== "number" ||
    !Number.isFinite(record.minimumMatchRate) ||
    record.minimumMatchRate <= 0 ||
    record.minimumMatchRate > 1
  ) {
    reject("equivalence-shape", "equivalence policy minimumMatchRate must be in (0, 1]", {
      got: boundedDetail(String(record.minimumMatchRate)),
    });
  }
  return value;
}

/**
 * The equivalence verdict: the pure, deterministic evaluation of
 * the full suite within its declared bounds under the governing
 * policy floor. Reasons name the failing components (typed, never
 * silent); an empty reason set with `admissible: true` means the
 * suite HOLDS.
 */
export interface EquivalenceVerdict {
  readonly admissible: boolean;
  /**
   * The failing components (`differential` / `property` / `replay`
   * — closed vocabulary; empty iff admissible).
   */
  readonly failingKinds: readonly EquivalenceEvidenceKind[];
  /** The effective match-rate threshold applied (the max of declared and policy floor). */
  readonly effectiveMatchRateThreshold: number;
  /** The observed differential match rate. */
  readonly observedMatchRate: number;
}

/** The frozen equivalence-evaluation basis. */
export const EQUIVALENCE_EVALUATION_BASIS =
  "full-suite-required;differential-match-rate-within-declared-bounds;property-zero-failures;replay-zero-deviations;policy-floor-max-with-declared;pure-deterministic";

/**
 * Evaluate the equivalence suite: differential match rate within
 * the declared bounds (and the governing policy floor), property
 * failures ZERO, replay deviations ZERO. Pure function of (suite,
 * policy) — deterministic and idempotent.
 */
export function evaluateEquivalenceSuite(
  suite: EquivalenceEvidenceSuite,
  policy: EquivalencePolicy,
): EquivalenceVerdict {
  const validatedPolicy = validateEquivalencePolicy(policy);
  const differential = validateDifferentialEvidence(suite.differential);
  const property = validatePropertyEvidence(suite.property);
  const replay = validateReplayEvidence(suite.replay);
  const threshold = Math.max(differential.requiredMatchRate, validatedPolicy.minimumMatchRate);
  const observed = differential.matchedCount / differential.casesCount;
  const failing: EquivalenceEvidenceKind[] = [];
  if (observed < threshold) {
    failing.push("differential");
  }
  if (property.failuresCount > 0) {
    failing.push("property");
  }
  if (replay.deviationsCount > 0) {
    failing.push("replay");
  }
  return {
    admissible: failing.length === 0,
    failingKinds: failing,
    effectiveMatchRateThreshold: threshold,
    observedMatchRate: observed,
  };
}

// ---------------------------------------------------------------------------
// The deterministic replacement candidate
// ---------------------------------------------------------------------------

/** The execution binding — through the tool-surface plane's OWN vocabulary. */
export interface ReplacementBinding {
  /**
   * The tool-surface representation the replacement executes
   * through (a member of the merged plane's closed
   * `TOOL_REPRESENTATIONS` — validated with its own
   * `isToolRepresentation`): `competence` (a verified competence
   * reference) or `code` (a bounded code-API binding).
   */
  readonly toolRepresentation: ReplacementBindingRepresentation;
  /** The bounded neutral binding reference. */
  readonly ref: string;
}

/** The incumbent probabilistic representation being replaced. */
export interface IncumbentRepresentation {
  /** The incumbent's representation class (the foundation's ladder). */
  readonly representationClass: RepresentationClass;
  /** The incumbent's explicit-basis claim. */
  readonly claim: CostClaim;
}

/** The frozen replacement-candidate basis. */
export const REPLACEMENT_CANDIDATE_BASIS =
  "full-differential-property-replay-suite-required;tool-surface-vocabulary-binding;content-addressed-identity;incumbent-claim-explicit-basis;declared-bounds-digests;equivalence-proven-not-assumed";

/**
 * THE deterministic replacement candidate — a typed, content
 * addressed value carrying the incumbent probabilistic
 * representation, the deterministic execution binding, the
 * deterministic path's OWN explicit-basis economics claim, and the
 * FULL equivalence-evidence suite. Admissible ONLY with the
 * complete suite (construction fails closed otherwise); promotable
 * only through the gated path (promotion.ts).
 */
export interface DeterministicReplacementCandidate {
  /** Content-derived identity: sha256 over the canonical candidate form. */
  readonly replacementId: string;
  readonly scope: TenantCacheScope;
  readonly capabilityId: string;
  readonly tags: readonly string[];
  /** The incumbent probabilistic representation being replaced. */
  readonly incumbent: IncumbentRepresentation;
  /** The deterministic execution binding (tool-surface vocabulary). */
  readonly binding: ReplacementBinding;
  /** The deterministic path's OWN explicit-basis economics claim. */
  readonly claim: CostClaim;
  /** The FULL equivalence-evidence suite (all three components). */
  readonly suite: EquivalenceEvidenceSuite;
  /** The frozen, human-auditable candidate basis. */
  readonly candidateBasis: string;
}

/** The candidate form excluding the derived identity. */
type ReplacementCandidateForm = Omit<DeterministicReplacementCandidate, "replacementId">;

/** The admission input (the suite must be COMPLETE and self-passing). */
export interface ReplacementAdmissionInput {
  readonly scope: TenantCacheScope;
  readonly capabilityId: string;
  readonly tags: readonly string[];
  readonly incumbent: IncumbentRepresentation;
  readonly binding: ReplacementBinding;
  /** The deterministic path's OWN explicit-basis economics claim. */
  readonly claim: CostClaim;
  readonly suite: EquivalenceEvidenceSuite;
  readonly digest: IrDigestPort;
}

/**
 * Admit a deterministic replacement candidate: total validation,
 * the complete-suite requirement and the within-declared-bounds
 * self-check, then the content-addressed identity.
 *
 * Fail-closed BEFORE the candidate exists:
 *  - the suite must carry ALL THREE components (differential,
 *    property, replay — a missing component is a typed
 *    `evidence-suite-incomplete` rejection: no evidence-less
 *    replacement can EVER be admitted);
 *  - every component must hold WITHIN ITS OWN DECLARED BOUNDS (the
 *    differential match rate must meet its declared required rate;
 *    property failures ZERO; replay deviations ZERO);
 *  - the binding must ride the tool-surface plane's OWN closed
 *    vocabulary (its `isToolRepresentation` governs — imported,
 *    never re-implemented);
 *  - the incumbent must carry the foundation's own validated
 *    explicit-basis claim over its own ladder class.
 */
export function admitDeterministicReplacement(
  input: ReplacementAdmissionInput,
): DeterministicReplacementCandidate {
  const scope = validateTenantCacheScope(input.scope);
  if (typeof input.capabilityId !== "string" || !CAPABILITY_REF_PATTERN.test(input.capabilityId)) {
    reject("replacement-shape", "capabilityId must be a bounded neutral slug", {
      got: boundedDetail(String(input.capabilityId)),
    });
  }
  if (!Array.isArray(input.tags) || input.tags.length === 0) {
    reject("replacement-shape", "a replacement candidate must declare at least one tag");
  }
  if (input.tags.length > MAX_APPLICABILITY_TAGS) {
    reject("replacement-shape", "replacement tags exceed the bound", {
      bound: MAX_APPLICABILITY_TAGS,
      got: input.tags.length,
    });
  }
  const tags: string[] = [];
  const seenTags = new Set<string>();
  for (const tag of input.tags) {
    if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) {
      reject("replacement-shape", "replacement tags must be bounded neutral slugs", {
        got: boundedDetail(String(tag)),
      });
    }
    if (seenTags.has(tag)) {
      reject("replacement-shape", "replacement tags must be unique", { tag });
    }
    seenTags.add(tag);
    tags.push(tag);
  }
  tags.sort();

  // The incumbent: the foundation's own claim discipline.
  if (!isRecord(input.incumbent)) {
    reject("replacement-shape", "the replacement must carry its incumbent representation");
  }
  if (
    typeof input.incumbent.representationClass !== "string" ||
    !(REPRESENTATION_CLASSES as readonly string[]).includes(input.incumbent.representationClass)
  ) {
    reject("replacement-shape", "the incumbent class is outside the foundation ladder", {
      got: boundedDetail(String(input.incumbent.representationClass)),
    });
  }
  const incumbentClaim = validateCostClaim(input.incumbent.claim);
  // The deterministic path's own claim (the economics the promotion
  // gates evaluate — explicit basis, never unattributed).
  const replacementClaim = validateCostClaim(input.claim);

  // The binding: the merged tool-surface plane's OWN vocabulary.
  if (!isRecord(input.binding)) {
    reject("replacement-shape", "the replacement must carry its execution binding");
  }
  const bindingRepresentation = input.binding.toolRepresentation;
  if (
    typeof bindingRepresentation !== "string" ||
    !(REPLACEMENT_BINDING_REPRESENTATIONS as readonly string[]).includes(bindingRepresentation) ||
    !isToolRepresentation(bindingRepresentation)
  ) {
    reject(
      "replacement-shape",
      "the binding must ride the tool-surface representation vocabulary",
      {
        got: boundedDetail(String(bindingRepresentation)),
      },
    );
  }
  if (typeof input.binding.ref !== "string" || !BINDING_REF_PATTERN.test(input.binding.ref)) {
    reject("replacement-shape", "the binding reference must be a bounded neutral slug", {
      got: boundedDetail(String(input.binding.ref)),
    });
  }

  // THE complete-suite requirement: all three components present.
  if (!isRecord(input.suite)) {
    reject("equivalence-shape", "a replacement candidate requires its equivalence-evidence suite");
  }
  if (!isRecord(input.suite.differential)) {
    reject(
      "equivalence-suite-incomplete",
      "a replacement candidate without differential evidence is inadmissible",
    );
  }
  const differential = validateDifferentialEvidence(input.suite.differential);
  if (!isRecord(input.suite.property)) {
    reject(
      "equivalence-suite-incomplete",
      "a replacement candidate without property evidence is inadmissible",
    );
  }
  const property = validatePropertyEvidence(input.suite.property);
  if (!isRecord(input.suite.replay)) {
    reject(
      "equivalence-suite-incomplete",
      "a replacement candidate without replay evidence is inadmissible",
    );
  }
  const replay = validateReplayEvidence(input.suite.replay);

  // THE within-declared-bounds self-check: every component must hold
  // within its OWN declared bounds at admission (the promotion gates
  // re-evaluate under the governing policy floor).
  if (differential.matchedCount / differential.casesCount < differential.requiredMatchRate) {
    reject(
      "equivalence-suite-failed",
      "the differential match rate is below the suite's own declared bound",
      {
        observed: differential.matchedCount / differential.casesCount,
        required: differential.requiredMatchRate,
      },
    );
  }
  if (property.failuresCount > 0) {
    reject(
      "equivalence-suite-failed",
      "property failures break equivalence within the declared bounds",
      {
        failuresCount: property.failuresCount,
      },
    );
  }
  if (replay.deviationsCount > 0) {
    reject(
      "equivalence-suite-failed",
      "replay deviations break equivalence within the declared bounds",
      {
        deviationsCount: replay.deviationsCount,
      },
    );
  }

  const form: ReplacementCandidateForm = {
    scope,
    capabilityId: input.capabilityId,
    tags,
    incumbent: {
      representationClass: input.incumbent.representationClass,
      claim: incumbentClaim,
    },
    binding: { toolRepresentation: bindingRepresentation, ref: input.binding.ref },
    claim: replacementClaim,
    suite: { differential, property, replay },
    candidateBasis: REPLACEMENT_CANDIDATE_BASIS,
  };
  if (!isCanonicalizable(form)) {
    reject("replacement-shape", "replacement candidate form is not canonicalizable");
  }
  const replacementId = input.digest.sha256Hex(canonicalJson(form));
  return { replacementId, ...form };
}

/**
 * Total, deterministic validation of a (deserialized) replacement
 * candidate: the full admission discipline re-proven AND identity
 * verification — `replacementId` must be the digest of the
 * canonical form (tampered or foreign values are rejected at read
 * time, never served).
 */
export function validateDeterministicReplacement(
  value: unknown,
  digest: IrDigestPort,
): DeterministicReplacementCandidate {
  if (!isRecord(value)) {
    reject("replacement-shape", "deterministic replacement candidate must be an object");
  }
  const record = value;
  if (typeof record.replacementId !== "string" || !SHA256_HEX_PATTERN.test(record.replacementId)) {
    reject("replacement-shape", "replacementId must be a sha256 hex digest", {
      got: boundedDetail(String(record.replacementId)),
    });
  }
  if (record.candidateBasis !== REPLACEMENT_CANDIDATE_BASIS) {
    reject("replacement-shape", "candidate basis is outside the frozen vocabulary", {
      got: boundedDetail(String(record.candidateBasis)),
    });
  }
  const rebuilt = admitDeterministicReplacement({
    scope: record.scope as TenantCacheScope,
    capabilityId: record.capabilityId as string,
    tags: record.tags as readonly string[],
    incumbent: record.incumbent as IncumbentRepresentation,
    binding: record.binding as ReplacementBinding,
    claim: record.claim as CostClaim,
    suite: record.suite as EquivalenceEvidenceSuite,
    digest,
  });
  if (rebuilt.replacementId !== record.replacementId) {
    reject("replacement-shape", "candidate content does not digest to the claimed identity", {
      claimed: record.replacementId,
      computed: rebuilt.replacementId,
    });
  }
  return record as unknown as DeterministicReplacementCandidate;
}

/**
 * Map an equivalence failure to the closed promotion inadmissible
 * code (the shared promotion vocabulary — `evidence-suite-failed`
 * when a suite component failed, `evidence-suite-incomplete` when a
 * component is absent). Fail-closed on unmappable codes.
 */
export function equivalenceFailureCode(kind: EquivalenceEvidenceKind): PromotionInadmissibleCode {
  switch (kind) {
    case "differential":
    case "property":
    case "replay":
      return "evidence-suite-failed";
    default:
      reject("equivalence-shape", "an unmappable equivalence failure kind", {
        got: boundedDetail(String(kind)),
      });
  }
}

/** The promotion inadmissible codes this module may emit (closed set proof). */
export const EQUIVALENCE_EMITTED_CODES: readonly PromotionInadmissibleCode[] = [
  "evidence-suite-incomplete",
  "evidence-suite-failed",
];

/** Check a code is within the closed promotion vocabulary (total). */
export function isPromotionInadmissibleCode(value: unknown): value is PromotionInadmissibleCode {
  return (
    typeof value === "string" && (PROMOTION_INADMISSIBLE_CODES as readonly string[]).includes(value)
  );
}
