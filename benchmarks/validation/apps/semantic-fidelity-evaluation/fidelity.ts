/**
 * The semantic-fidelity typed facts — the evaluation's app-local mirror
 * of the PCS-002 plane (ACR-009 §2; work order PCS-004).
 *
 * THE BOUNDARY DISCIPLINE (VAL-002 AC7 — never `src/**` from the
 * application tree): the PCS-002 fact plane lives in
 * `src/modules/capabilities/domain/semantic-fidelity.ts` and is NOT
 * importable here, so this module mirrors it the established way — the
 * workload-class mirror precedent (planning domain mirrors the closed
 * vocabularies by value and pins them against the authority BY TEST)
 * plus the PCR-003 canonical-serializer precedent (implemented locally
 * over neutral values, pinned byte-for-byte in-suite). The
 * `tests/unit/validation/pcs-004-semantic-fidelity-evaluation.test.ts`
 * suite pins: every vocabulary below is EXACTLY the capabilities
 * authority's frozen vocabulary, and every fact the evaluation emits
 * VALIDATES on the REAL `validateSemanticFidelityFacts` (the PCS-002
 * plane's own fail-closed validator) — drift is a typed failure, never
 * silent.
 *
 * THE CLOSED FACT BLOCK (ACR-009 §2 — every field closed and typed;
 * unknown values fail closed, never a default, never a widening):
 *
 *   representation kind → `semantic-model-backed` vs
 *                         `deterministic-substitute` — the closed
 *                         two-kind distinction ACR-009 exists to type;
 *   modality            → text | image | audio | multimodal;
 *   dimensionality      → the vector dimension count, an integer in
 *                         [1, 65536];
 *   normalization       → none | l2 | scale-bounded;
 *   similarity
 *   semantics           → cosine | dot | exact-match-lexical |
 *                         hash-proximity;
 *   quality contract    → the task-authored declared requirement (with
 *                         its bounded acceptance basis) or its explicit
 *                         absence;
 *   compatibility
 *   constraints         → the closed consumer-constraint list;
 *   basis               → the EXPLICIT provenance (which execution,
 *                         which capability, which substitute function —
 *                         required exactly when the representation kind
 *                         is `deterministic-substitute`).
 *
 * THE DISCRIMINATION LAW (ACR-009 §2 "no silent substitution" + §6
 * "differentiated evidence"): `discriminateRepresentation` reads ONLY
 * the typed facts of a record — never prose — and separates the two
 * kinds mechanically, rejecting every incoherent shape (a model-backed
 * fact claiming a substitute identity; a substitute fact without one;
 * an unknown kind; a malformed block). This is the mechanical
 * discriminator the work order requires: a consumer reading only the
 * typed facts separates `semantic-model-backed` from
 * `deterministic-substitute` on every emitted record.
 *
 * Pure and total: no environment reads, no clock, no randomness, no
 * I/O — the same facts always produce the byte-identical validation
 * verdict, canonical form and content address (invariant 5).
 */

// ---------------------------------------------------------------------------
// The frozen vocabularies (the mirror of the PCS-002 authority — pinned
// by test; widening is a reviewed change the pin catches)
// ---------------------------------------------------------------------------

/** The closed two-kind distinction ACR-009 exists to type. */
export const SEMANTIC_REPRESENTATION_KINDS = [
  "semantic-model-backed",
  "deterministic-substitute",
] as const;
export type SemanticRepresentationKind = (typeof SEMANTIC_REPRESENTATION_KINDS)[number];

/** The input modality a semantic representation is defined over (ACR-009 §2's closed list). */
export const SEMANTIC_MODALITIES = ["text", "image", "audio", "multimodal"] as const;
export type SemanticModality = (typeof SEMANTIC_MODALITIES)[number];

/** The declared normalization semantics of produced vectors. */
export const SEMANTIC_NORMALIZATIONS = ["none", "l2", "scale-bounded"] as const;
export type SemanticNormalization = (typeof SEMANTIC_NORMALIZATIONS)[number];

/** The declared similarity/distance semantics the representation supports. */
export const SEMANTIC_SIMILARITY_SEMANTICS = [
  "cosine",
  "dot",
  "exact-match-lexical",
  "hash-proximity",
] as const;
export type SemanticSimilaritySemantics = (typeof SEMANTIC_SIMILARITY_SEMANTICS)[number];

/**
 * The closed vocabulary of task-authored quality requirements a
 * semantic fact may declare (ACR-009 §3 names the one member). The
 * quality CONTRACT is task-authored and declared; Zeck types and
 * enforces it, it never fabricates a semantic-quality metric (§7).
 */
export const SEMANTIC_QUALITY_REQUIREMENTS = ["requires-semantic-retrieval-quality"] as const;
export type SemanticQualityRequirement = (typeof SEMANTIC_QUALITY_REQUIREMENTS)[number];

/** The closed consumer-constraint list (the frozen report order). */
export const SEMANTIC_COMPATIBILITY_CONSTRAINTS = [
  "dimensionality-match",
  "normalization-match",
  "similarity-semantics-match",
] as const;
export type SemanticCompatibilityConstraint = (typeof SEMANTIC_COMPATIBILITY_CONSTRAINTS)[number];

// ---------------------------------------------------------------------------
// The typed fact block (the mirror of the PCS-002 closed shape)
// ---------------------------------------------------------------------------

/**
 * The task-authored quality contract: EITHER a declared requirement
 * (with the task's own bounded acceptance basis) OR its explicit
 * absence. Both spellings are typed and closed; an unknown `kind` or a
 * declared requirement outside the vocabulary fails closed.
 */
export type SemanticQualityContract =
  | {
      readonly kind: "declared";
      readonly requirement: SemanticQualityRequirement;
      /** The task's own acceptance basis (bounded, non-empty). */
      readonly acceptanceBasis: string;
    }
  | { readonly kind: "absent" };

/**
 * The EXPLICIT basis of one semantic fact (the CostClaim discipline
 * applied to semantic facts): which execution produced it, which
 * declared capability it attaches to, and — exactly when the
 * representation kind is `deterministic-substitute` — which substitute
 * function produced it. An unattributed semantic fact is
 * unrepresentable.
 */
export interface SemanticFidelityBasis {
  /** The bounded identity of the execution that produced the fact. */
  readonly executionId: string;
  /** The declared capability the fact attaches to (neutral slug). */
  readonly capabilityId: string;
  /**
   * The substitute function identity — REQUIRED when the
   * representation kind is `deterministic-substitute`; explicitly
   * absent for `semantic-model-backed` (the incoherent shape is
   * rejected).
   */
  readonly substituteId?: string;
}

/**
 * The closed semantic-fidelity fact block (ACR-009 §2): the typed
 * distinction every emitted record of this evaluation carries.
 */
export interface SemanticFidelityFacts {
  readonly representationKind: SemanticRepresentationKind;
  readonly modality: SemanticModality;
  /** The vector dimension count — an integer in [1, 65536]. */
  readonly dimensionality: number;
  readonly normalization: SemanticNormalization;
  readonly similaritySemantics: SemanticSimilaritySemantics;
  readonly qualityContract: SemanticQualityContract;
  /** The closed constraint list a consumer must satisfy (>= 1, duplicate-free). */
  readonly compatibilityConstraints: readonly SemanticCompatibilityConstraint[];
  /** The EXPLICIT basis (required — provenance is never an afterthought). */
  readonly basis: SemanticFidelityBasis;
}

// ---------------------------------------------------------------------------
// Total, deterministic, fail-closed validation (the mirror of the
// PCS-002 validator — pinned byte-for-byte in-suite)
// ---------------------------------------------------------------------------

/** The dimensionality bound: a typed positive integer in [1, 65536]. */
export const MAX_SEMANTIC_DIMENSIONALITY = 65536;
/** Bounded free-text bound (the CostClaim attribution-source bound). */
const ACCEPTANCE_BASIS_MAX = 200;
/** Bounded identity fields (execution/substitute identities). */
const IDENTITY_MAX = 128;
/** Neutral vocabulary slugs (the module's capability-id discipline). */
const SEMANTIC_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The bounded rendering of an offending value inside a reason. */
const REASON_VALUE_LIMIT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Render an offending value bounded — the reason names it, never floods. */
function boundedValue(value: unknown): string {
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
  return `semanticFidelity.${field} must be one of ${vocabulary.join("|")}: ${boundedValue(value)}`;
}

function validateQualityContract(value: unknown): string | null {
  if (!isRecord(value)) {
    return `semanticFidelity.qualityContract must be an object with kind declared|absent: ${boundedValue(value)}`;
  }
  if (value.kind === "absent") {
    if (value.requirement !== undefined || value.acceptanceBasis !== undefined) {
      return "semanticFidelity.qualityContract absent cannot carry a requirement or acceptanceBasis (the incoherent shape is rejected)";
    }
    return null;
  }
  if (value.kind !== "declared") {
    return `semanticFidelity.qualityContract.kind must be declared|absent: ${boundedValue(value.kind)}`;
  }
  if (
    typeof value.requirement !== "string" ||
    !(SEMANTIC_QUALITY_REQUIREMENTS as readonly string[]).includes(value.requirement)
  ) {
    return closedVocabularyReason(
      "qualityContract.requirement",
      SEMANTIC_QUALITY_REQUIREMENTS,
      value.requirement,
    );
  }
  if (
    typeof value.acceptanceBasis !== "string" ||
    value.acceptanceBasis.length === 0 ||
    value.acceptanceBasis.length > ACCEPTANCE_BASIS_MAX
  ) {
    return `semanticFidelity.qualityContract.acceptanceBasis must be a bounded non-empty string (<=${ACCEPTANCE_BASIS_MAX}): ${boundedValue(value.acceptanceBasis)}`;
  }
  return null;
}

function validateBasis(
  value: unknown,
  representationKind: SemanticRepresentationKind,
): string | null {
  if (!isRecord(value)) {
    return "semanticFidelity.basis is required on every semantic fact (the explicit-basis CostClaim discipline — an unattributed semantic fact is unrepresentable)";
  }
  if (
    typeof value.executionId !== "string" ||
    value.executionId.length === 0 ||
    value.executionId.length > IDENTITY_MAX
  ) {
    return `semanticFidelity.basis.executionId must be a bounded non-empty identity (<=${IDENTITY_MAX}): ${boundedValue(value.executionId)}`;
  }
  if (typeof value.capabilityId !== "string" || !SEMANTIC_ID_PATTERN.test(value.capabilityId)) {
    return `semanticFidelity.basis.capabilityId must be a neutral vocabulary slug: ${boundedValue(value.capabilityId)}`;
  }
  if (representationKind === "deterministic-substitute") {
    if (typeof value.substituteId !== "string" || !SEMANTIC_ID_PATTERN.test(value.substituteId)) {
      return `semanticFidelity.basis.substituteId is required when representationKind is deterministic-substitute (which substitute function produced the fact): ${boundedValue(value.substituteId)}`;
    }
    return null;
  }
  if (value.substituteId !== undefined) {
    return "semanticFidelity.basis.substituteId cannot ride a semantic-model-backed representation (the incoherent shape is rejected)";
  }
  return null;
}

/**
 * Total, deterministic, fail-closed validation of the closed fact
 * block (the mirror of the PCS-002 `validateSemanticFidelityFacts` —
 * pinned verdict-for-verdict in-suite). Absence is NOT handled here.
 */
export function validateSemanticFidelityFactsMirror(value: unknown):
  | { valid: true }
  | {
      valid: false;
      reason: string;
    } {
  if (!isRecord(value)) {
    return { valid: false, reason: "semanticFidelity must be an object (the closed fact block)" };
  }
  if (
    typeof value.representationKind !== "string" ||
    !(SEMANTIC_REPRESENTATION_KINDS as readonly string[]).includes(value.representationKind)
  ) {
    return {
      valid: false,
      reason: closedVocabularyReason(
        "representationKind",
        SEMANTIC_REPRESENTATION_KINDS,
        value.representationKind,
      ),
    };
  }
  const representationKind = value.representationKind as SemanticRepresentationKind;
  if (
    typeof value.modality !== "string" ||
    !(SEMANTIC_MODALITIES as readonly string[]).includes(value.modality)
  ) {
    return {
      valid: false,
      reason: closedVocabularyReason("modality", SEMANTIC_MODALITIES, value.modality),
    };
  }
  if (
    typeof value.dimensionality !== "number" ||
    !Number.isInteger(value.dimensionality) ||
    value.dimensionality < 1 ||
    value.dimensionality > MAX_SEMANTIC_DIMENSIONALITY
  ) {
    return {
      valid: false,
      reason: `semanticFidelity.dimensionality must be an integer in [1, ${MAX_SEMANTIC_DIMENSIONALITY}]: ${boundedValue(value.dimensionality)}`,
    };
  }
  if (
    typeof value.normalization !== "string" ||
    !(SEMANTIC_NORMALIZATIONS as readonly string[]).includes(value.normalization)
  ) {
    return {
      valid: false,
      reason: closedVocabularyReason("normalization", SEMANTIC_NORMALIZATIONS, value.normalization),
    };
  }
  if (
    typeof value.similaritySemantics !== "string" ||
    !(SEMANTIC_SIMILARITY_SEMANTICS as readonly string[]).includes(value.similaritySemantics)
  ) {
    return {
      valid: false,
      reason: closedVocabularyReason(
        "similaritySemantics",
        SEMANTIC_SIMILARITY_SEMANTICS,
        value.similaritySemantics,
      ),
    };
  }
  const qualityContractError = validateQualityContract(value.qualityContract);
  if (qualityContractError !== null) {
    return { valid: false, reason: qualityContractError };
  }
  if (!Array.isArray(value.compatibilityConstraints)) {
    return {
      valid: false,
      reason: "semanticFidelity.compatibilityConstraints must be an array of closed constraints",
    };
  }
  if (value.compatibilityConstraints.length === 0) {
    return {
      valid: false,
      reason: "semanticFidelity.compatibilityConstraints must declare at least one constraint",
    };
  }
  const seen = new Set<string>();
  for (const entry of value.compatibilityConstraints) {
    if (
      typeof entry !== "string" ||
      !(SEMANTIC_COMPATIBILITY_CONSTRAINTS as readonly string[]).includes(entry)
    ) {
      return {
        valid: false,
        reason: closedVocabularyReason(
          "compatibilityConstraints entry",
          SEMANTIC_COMPATIBILITY_CONSTRAINTS,
          entry,
        ),
      };
    }
    if (seen.has(entry)) {
      return {
        valid: false,
        reason: "semanticFidelity.compatibilityConstraints must not contain duplicates",
      };
    }
    seen.add(entry);
  }
  const basisError = validateBasis(value.basis, representationKind);
  if (basisError !== null) {
    return { valid: false, reason: basisError };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Canonical serialization + content-addressable identity
// ---------------------------------------------------------------------------

/** Recursively canonicalize (sorted keys at every depth). */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .map((key) => [key, canonical(record[key])]);
  }
  return value;
}

/**
 * Deterministic canonical JSON of the fact block (the mirror of the
 * PCS-002 `canonicalSemanticFidelityJson` — same tagged-tuple form,
 * sorted keys, sorted constraint vocabulary; pinned byte-for-byte
 * in-suite). Input order is never identity.
 */
export function canonicalSemanticFidelityJsonMirror(facts: SemanticFidelityFacts): string {
  return JSON.stringify([
    "capabilities.semantic-fidelity",
    facts.representationKind,
    facts.modality,
    facts.dimensionality,
    facts.normalization,
    facts.similaritySemantics,
    canonical(facts.qualityContract),
    [...facts.compatibilityConstraints].sort(),
    canonical(facts.basis),
  ]);
}

// ---------------------------------------------------------------------------
// The mechanical discriminator (ACR-009 §6 — differentiated evidence)
// ---------------------------------------------------------------------------

/**
 * The discriminator's verdict: the separated representation kind, with
 * the typed facts that derived it — or a typed rejection naming the
 * incoherence. A consumer reading ONLY the typed facts (never prose)
 * uses exactly this separation.
 */
export type DiscriminatorVerdict =
  | {
      readonly kind: "separated";
      readonly representationKind: SemanticRepresentationKind;
      /** The typed basis the separation read (the explicit provenance). */
      readonly basis: SemanticFidelityBasis;
      /**
       * The mechanical evidence of the separation (the typed fields
       * that derive the kind — never prose).
       */
      readonly evidence: readonly string[];
    }
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * THE MECHANICAL DISCRIMINATOR (the work order's differentiated-evidence
 * proof): read ONLY the typed facts of one record's fact block and
 * separate `semantic-model-backed` from `deterministic-substitute` —
 * rejecting every incoherent shape with a typed reason:
 *
 *  - an unknown representation kind is rejected (closed vocabulary);
 *  - a `deterministic-substitute` fact without its substitute identity
 *    is rejected (which substitute function produced it is not a
 *    prose question);
 *  - a `semantic-model-backed` fact claiming a substitute identity is
 *    rejected (the incoherent shape);
 *  - any malformed block is rejected (fail-closed, never a guess).
 *
 * Pure and total: the same facts always produce the byte-identical
 * verdict (invariant 5). NO prose field participates — the separation
 * is mechanical on the typed facts alone.
 */
export function discriminateRepresentation(value: unknown): DiscriminatorVerdict {
  const validation = validateSemanticFidelityFactsMirror(value);
  if (!validation.valid) {
    return { kind: "rejected", reason: validation.reason };
  }
  const facts = value as SemanticFidelityFacts;
  if (facts.representationKind === "deterministic-substitute") {
    return {
      kind: "separated",
      representationKind: "deterministic-substitute",
      basis: facts.basis,
      evidence: [
        "representationKind=deterministic-substitute (the closed two-kind vocabulary)",
        `basis.substituteId=${facts.basis.substituteId ?? ""} (required exactly for this kind)`,
        `basis.capabilityId=${facts.basis.capabilityId}`,
        `similaritySemantics=${facts.similaritySemantics} (the substitute's declared semantics)`,
      ],
    };
  }
  return {
    kind: "separated",
    representationKind: "semantic-model-backed",
    basis: facts.basis,
    evidence: [
      "representationKind=semantic-model-backed (the closed two-kind vocabulary)",
      "basis.substituteId=undefined (explicitly absent for this kind)",
      `basis.capabilityId=${facts.basis.capabilityId}`,
      `similaritySemantics=${facts.similaritySemantics} (the model-backed semantics)`,
    ],
  };
}
