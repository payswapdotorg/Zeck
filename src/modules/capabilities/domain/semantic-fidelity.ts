/**
 * Semantic-fidelity typed facts (capabilities module domain, ACR-009 §2;
 * work order PCS-002 — the PURE PLANE).
 *
 * THE MEASURED GAP THIS MODULE TYPES (ACR-009 §1): the plane carried no
 * typed distinction between "a semantic embedding was produced by a
 * model-backed capability" and "a deterministic vector was produced by a
 * lexical/hash substitute" — the substitution's quality semantics were
 * prose, never machine-checkable. `SemanticFidelityFacts` is that typed
 * distinction: a closed, OPTIONAL fact block on the capability/execution
 * representation (DATA, never an engine — the continuation-package
 * discipline), validated fail-closed at the registry boundary and
 * checked mechanically at the delegation boundary by pure function.
 *
 * THE CLOSED FACT BLOCK (every field closed and typed; unknown values
 * fail closed with a reason naming the field and the offending value —
 * never a default, never a widening):
 *
 *   representation kind → `semantic-model-backed` vs
 *                         `deterministic-substitute` — the closed
 *                         two-kind distinction ACR-009 exists to type;
 *   modality            → the input modality the representation is
 *                         defined over (text | image | audio |
 *                         multimodal — ACR-009 §2's own closed list);
 *   dimensionality      → the vector dimension count, a typed positive
 *                         integer in [1, 65536];
 *   normalization       → the declared normalization semantics of the
 *                         produced vectors (none | l2 | scale-bounded)
 *                         — a mismatch is a compatibility constraint,
 *                         never a silent fix;
 *   similarity semantics→ the declared similarity/distance semantics
 *                         the representation supports (cosine | dot |
 *                         exact-match-lexical | hash-proximity) — a
 *                         deterministic substitute may declare only the
 *                         weaker members;
 *   quality contract    → the task-authored declared requirement (with
 *                         the task's own acceptance basis) or its
 *                         EXPLICIT absence — typed and closed; Zeck
 *                         types and enforces it, it never fabricates a
 *                         semantic-quality metric (ACR-009 §7);
 *   compatibility
 *   constraints         → the closed list of constraints a consumer
 *                         must satisfy (dimensionality-match,
 *                         normalization-match,
 *                         similarity-semantics-match) — checked
 *                         mechanically at the delegation boundary.
 *
 * EXPLICIT PROVENANCE ON EVERY FACT (the explicit-basis `CostClaim`
 * discipline applied to semantic facts): each block carries its basis —
 * WHICH execution produced it, WHICH declared capability it attaches
 * to, and WHICH substitute function produced it (required exactly when
 * the representation kind is `deterministic-substitute`; a
 * model-backed representation claiming a substitute identity is the
 * incoherent shape, rejected typed). An unattributed semantic fact is
 * unrepresentable.
 *
 * ABSENCE EQUIVALENCE (ACR-009 §2/§5; the PCR-002 measured-evidence
 * discipline): the block is OPTIONAL on the published fact and the
 * arbitrated record — `undefined` and `null` are BOTH the absent
 * spelling, and absence selects and records byte-identically to the
 * pre-change behavior at every existing call site
 * (discrimination-tested against the captured pre-change baseline).
 *
 * NO FAMILY WIDENING (ACR-009 §2/§7): a deterministic substitute is NOT
 * a new capability family, NOT a new registry entry and never a renamed
 * broadening of the existing 22-family truth — it is a typed execution
 * representation of a task against a declared quality contract,
 * projected through the existing capability facts. This module declares
 * no capability identity vocabulary at all (no kinds, no families, no
 * registry): the frozen `CAPABILITY_KINDS` and the existing registry
 * remain the one truth.
 *
 * Pure and total: no environment reads, no clock, no randomness, no
 * I/O — same facts always produce the byte-identical validation
 * verdict, canonical form and content address (invariant 5).
 */

import type { FactValidation } from "./capability";
import { substrateContainsRawSecretValue } from "./substrate";

// ---------------------------------------------------------------------------
// The frozen vocabularies (closed — widening is a reviewed change)
// ---------------------------------------------------------------------------

/**
 * The closed two-kind distinction ACR-009 exists to type: a real
 * model-backed semantic capability vs a deterministic Zeck-side
 * substitute. Never interchangeable, never defaulted.
 */
export const SEMANTIC_REPRESENTATION_KINDS = [
  "semantic-model-backed",
  "deterministic-substitute",
] as const;
export type SemanticRepresentationKind = (typeof SEMANTIC_REPRESENTATION_KINDS)[number];

/**
 * The input modality a semantic representation is defined over
 * (ACR-009 §2's own closed list — NOT the substrate modality atoms; a
 * semantic representation is defined over text, image, audio or several
 * at once).
 */
export const SEMANTIC_MODALITIES = ["text", "image", "audio", "multimodal"] as const;
export type SemanticModality = (typeof SEMANTIC_MODALITIES)[number];

/**
 * The declared normalization semantics of produced vectors. Mismatched
 * normalization is a compatibility constraint, never a silent fix.
 */
export const SEMANTIC_NORMALIZATIONS = ["none", "l2", "scale-bounded"] as const;
export type SemanticNormalization = (typeof SEMANTIC_NORMALIZATIONS)[number];

/**
 * The declared similarity/distance semantics the representation
 * supports. A deterministic substitute may declare only the weaker
 * members (`exact-match-lexical`, `hash-proximity`); the boundary check
 * compares the declared semantics exactly.
 */
export const SEMANTIC_SIMILARITY_SEMANTICS = [
  "cosine",
  "dot",
  "exact-match-lexical",
  "hash-proximity",
] as const;
export type SemanticSimilaritySemantics = (typeof SEMANTIC_SIMILARITY_SEMANTICS)[number];

/**
 * The closed vocabulary of task-authored quality requirements a
 * semantic fact may declare (ACR-009 §3 names `requires-semantic-
 * retrieval-quality`). The quality CONTRACT is task-authored and
 * declared; Zeck types and enforces it, it never fabricates a
 * semantic-quality metric (§7). An unknown requirement is fail-closed
 * inadmissible input, never a permissive default.
 */
export const SEMANTIC_QUALITY_REQUIREMENTS = ["requires-semantic-retrieval-quality"] as const;
export type SemanticQualityRequirement = (typeof SEMANTIC_QUALITY_REQUIREMENTS)[number];

/**
 * The closed list of constraints a consumer must satisfy, checked
 * mechanically at the delegation boundary (ACR-009 §2). The frozen
 * order is the canonical order mismatches are reported in.
 */
export const SEMANTIC_COMPATIBILITY_CONSTRAINTS = [
  "dimensionality-match",
  "normalization-match",
  "similarity-semantics-match",
] as const;
export type SemanticCompatibilityConstraint = (typeof SEMANTIC_COMPATIBILITY_CONSTRAINTS)[number];

// ---------------------------------------------------------------------------
// The typed fact block
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
      /** The task's own acceptance basis (bounded, secret-scanned). */
      readonly acceptanceBasis: string;
    }
  | { readonly kind: "absent" };

/**
 * The EXPLICIT basis of one semantic fact (the CostClaim discipline
 * applied to semantic facts): which execution produced it, which
 * declared capability it attaches to, and — exactly when the
 * representation kind is `deterministic-substitute` — which substitute
 * function produced it. Every element is required; an unattributed
 * semantic fact is unrepresentable.
 */
export interface SemanticFidelityBasis {
  /** The bounded identity of the execution that produced the fact. */
  readonly executionId: string;
  /** The declared capability the fact attaches to (neutral slug). */
  readonly capabilityId: string;
  /**
   * The substitute function identity — REQUIRED when the
   * representation kind is `deterministic-substitute`; explicitly
   * absent (undefined) for `semantic-model-backed` (a model-backed
   * representation claiming a substitute identity is the incoherent
   * shape, rejected typed).
   */
  readonly substituteId?: string;
}

/**
 * The closed semantic-fidelity fact block (ACR-009 §2): an OPTIONAL
 * block on the published capability fact and the arbitrated record.
 * Absent (`undefined` | `null`) = the byte-identical-today state.
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
// Total, deterministic, fail-closed validation
// ---------------------------------------------------------------------------

/** The dimensionality bound: a typed positive integer in [1, 65536]. */
export const MAX_SEMANTIC_DIMENSIONALITY = 65536;
/** Bounded free-text bound (the CostClaim attribution-source bound). */
const ACCEPTANCE_BASIS_MAX = 200;
/** Bounded identity fields (execution/substitute identities). */
const IDENTITY_MAX = 128;
/** Neutral vocabulary slugs (the module's capability-id discipline). */
const SEMANTIC_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The bounded rendering of an offending value inside a reason (fail-closed evidence, never unbounded). */
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
  return `semanticFidelity.${field} must be one of ${vocabulary.join("|")}: ${boundedValue(value)}`;
}

function validateQualityContract(value: unknown): string | null {
  if (!isRecord(value)) {
    return `semanticFidelity.qualityContract must be an object with kind declared|absent: ${boundedValue(value)}`;
  }
  if (value.kind === "absent") {
    // The incoherent shape is rejected: an EXPLICIT absence cannot
    // carry a requirement or an acceptance basis (the inactive-cooldown
    // discipline — presence spelled on an absence is rejected).
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
  if (substrateContainsRawSecretValue(value.acceptanceBasis)) {
    return "semanticFidelity.qualityContract.acceptanceBasis looks like it embeds a raw secret value";
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
  // semantic-model-backed: the substitute identity is explicitly absent
  // — a model-backed representation claiming a substitute identity is
  // the incoherent shape, rejected typed.
  if (value.substituteId !== undefined) {
    return "semanticFidelity.basis.substituteId cannot ride a semantic-model-backed representation (the incoherent shape is rejected)";
  }
  return null;
}

/**
 * Total, deterministic, fail-closed validation of the closed fact
 * block. Every field's vocabulary is closed; every bound is typed;
 * every rejection's reason names the field and the offending value.
 * Absence is NOT handled here (the riding point decides the absence
 * spelling) — this function validates a PRESENT block only.
 */
export function validateSemanticFidelityFacts(value: unknown): FactValidation {
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
// Canonical serialization + content-addressable identity (the PCR-001
// RecoveryPlan discipline: the content address is the digest over the
// canonical form; same facts → same address, always)
// ---------------------------------------------------------------------------

/** Recursively canonicalize (sorted keys at every depth, sorted vocabularies). */
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
 * Deterministic canonical JSON of the fact block (the module's own
 * content-addressing base, mirroring `canonicalSubstrateJson`: a
 * tagged tuple, sorted keys, sorted constraint vocabulary — input
 * order is never identity). The same facts always produce the
 * byte-identical canonical form.
 */
export function canonicalSemanticFidelityJson(facts: SemanticFidelityFacts): string {
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

/**
 * The content-addressable identity of one fact block for evidence
 * correlation: the digest (INJECTED — never ambient, never
 * module-owned) over the canonical form. Deterministic — the same
 * facts always produce the byte-identical identity.
 */
export function semanticFidelityIdentity(
  facts: SemanticFidelityFacts,
  digest: (canonical: string) => string,
): string {
  return digest(canonicalSemanticFidelityJson(facts));
}

// ---------------------------------------------------------------------------
// The delegation-boundary compatibility check (pure, no wiring —
// PCS-003 wires the planner gating; this is the mechanical check)
// ---------------------------------------------------------------------------

/** Why the boundary check was skipped (absence of either side's facts — exactly today's behavior). */
export type SemanticBoundarySkipReason =
  | "consumer-facts-absent"
  | "producer-facts-absent"
  | "both-sides-absent";

/**
 * One typed compatibility failure at the delegation boundary: the
 * constraint the consumer declared, BOTH sides' declared bases (which
 * execution, which capability, which substitute — the mismatch names
 * both sides), and both sides' declared values for the mismatched
 * field (deterministic renderings).
 */
export interface SemanticFidelityMismatch {
  readonly constraint: SemanticCompatibilityConstraint;
  /** The consumer side's declared basis (named). */
  readonly consumerBasis: SemanticFidelityBasis;
  /** The producer side's declared basis (named). */
  readonly producerBasis: SemanticFidelityBasis;
  /** The consumer's declared value for the constrained field (deterministic rendering). */
  readonly consumerValue: string;
  /** The producer's declared value for the constrained field (deterministic rendering). */
  readonly producerValue: string;
}

/**
 * The typed boundary verdict. DATA, never an engine: `compatible`
 * (every consumer-declared constraint satisfied), `skipped` (absence
 * of either side's facts — the check does not fire, exactly today),
 * `invalid` (a present-but-malformed fact at the boundary — fail
 * closed, never a permissive default) or `incompatible` (every
 * mismatch typed, both sides named).
 */
export type SemanticFidelityBoundaryCheck =
  | { readonly kind: "compatible" }
  | { readonly kind: "skipped"; readonly reason: SemanticBoundarySkipReason }
  | { readonly kind: "invalid"; readonly side: "consumer" | "producer"; readonly reason: string }
  | { readonly kind: "incompatible"; readonly mismatches: readonly SemanticFidelityMismatch[] };

/**
 * Check the compatibility constraints mechanically at the delegation
 * boundary: the CONSUMER's declared constraints are enforced against
 * the PRODUCER's facts. Pure and deterministic — the same inputs
 * always produce the byte-identical verdict (invariant 5).
 *
 * Absence of either side's facts skips the check exactly as today
 * (absence-equivalent); a malformed fact on either side is a typed
 * `invalid` verdict naming the side (fail closed, never a permissive
 * default). Mismatches are reported in the frozen constraint order.
 */
export function checkSemanticFidelityBoundary(input: {
  readonly consumer: SemanticFidelityFacts | null | undefined;
  readonly producer: SemanticFidelityFacts | null | undefined;
}): SemanticFidelityBoundaryCheck {
  const consumerAbsent = input.consumer === undefined || input.consumer === null;
  const producerAbsent = input.producer === undefined || input.producer === null;
  if (consumerAbsent && producerAbsent) {
    return { kind: "skipped", reason: "both-sides-absent" };
  }
  if (consumerAbsent) {
    return { kind: "skipped", reason: "consumer-facts-absent" };
  }
  if (producerAbsent) {
    return { kind: "skipped", reason: "producer-facts-absent" };
  }
  // Both sides PRESENT: validate both fail-closed before any
  // comparison (a malformed fact at the boundary is never compared).
  const consumerValidation = validateSemanticFidelityFacts(input.consumer);
  if (!consumerValidation.valid) {
    return { kind: "invalid", side: "consumer", reason: consumerValidation.reason };
  }
  const producerValidation = validateSemanticFidelityFacts(input.producer);
  if (!producerValidation.valid) {
    return { kind: "invalid", side: "producer", reason: producerValidation.reason };
  }
  const consumer = input.consumer;
  const producer = input.producer;
  const mismatches: SemanticFidelityMismatch[] = [];
  // The frozen vocabulary order is the canonical mismatch order —
  // input spelling never reorders the verdict.
  for (const constraint of SEMANTIC_COMPATIBILITY_CONSTRAINTS) {
    if (!(consumer.compatibilityConstraints as readonly string[]).includes(constraint)) {
      // The consumer did not declare this constraint: not enforced
      // (the closed-list semantics — only declared constraints bind).
      continue;
    }
    const consumerValue =
      constraint === "dimensionality-match"
        ? String(consumer.dimensionality)
        : constraint === "normalization-match"
          ? consumer.normalization
          : consumer.similaritySemantics;
    const producerValue =
      constraint === "dimensionality-match"
        ? String(producer.dimensionality)
        : constraint === "normalization-match"
          ? producer.normalization
          : producer.similaritySemantics;
    if (consumerValue !== producerValue) {
      mismatches.push({
        constraint,
        consumerBasis: consumer.basis,
        producerBasis: producer.basis,
        consumerValue,
        producerValue,
      });
    }
  }
  if (mismatches.length > 0) {
    return { kind: "incompatible", mismatches };
  }
  return { kind: "compatible" };
}
