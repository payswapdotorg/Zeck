/**
 * Capability domain contracts (capabilities module domain, WORK-005 / INT-002).
 *
 * The capability vocabulary is PROVIDER-NEUTRAL BY CONSTRUCTION
 * (`spec/architecture.md` §2.5, §10): a capability names WHAT a task needs
 * ("structured-output", "human-review", "process-sandbox") — never which
 * provider, rail or product supplies it. Provider specifics enter only as
 * PROVENANCE/EVIDENCE on published facts (who asserted the claim, on what
 * evidence) and live in the publishing adapter files.
 *
 * The six capability kinds of the frozen architecture §10: model, tool,
 * algorithm, data, runtime and human capabilities.
 */

/** The capability kinds of `spec/architecture.md` §10 (frozen vocabulary). */
export const CAPABILITY_KINDS = ["model", "tool", "algorithm", "data", "runtime", "human"] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

/** How a capability claim is evidenced (frozen vocabulary). */
export const CAPABILITY_EVIDENCE_KINDS = [
  "adapter-declared",
  "catalog-seeded",
  "verified-observation",
] as const;
export type CapabilityEvidenceKind = (typeof CAPABILITY_EVIDENCE_KINDS)[number];

/** Neutral metadata attribute values — JSON primitives only. */
export type CapabilityAttributeValue = string | number | boolean | null;

/**
 * A provider-neutral capability claim descriptor. Identity is
 * `(id, kind, version)`; `id` belongs to exactly ONE kind (a shared
 * vocabulary, not per-provider namespaces).
 */
export interface CapabilityDescriptor {
  /** Neutral vocabulary identifier, e.g. `structured-output`. */
  readonly id: string;
  readonly kind: CapabilityKind;
  /** `major[.minor[.patch]]`, numerically comparable. */
  readonly version: string;
  /** Neutral metadata (modalities, determinism flags, isolation class…). */
  readonly attributes?: Readonly<Record<string, CapabilityAttributeValue>>;
}

/** Who asserted a claim and when (provider specifics live HERE, not in the descriptor). */
export interface CapabilityProvenance {
  readonly publisher: string;
  readonly publishedAt: string;
}

/** Evidence reference backing one claim (INT-002: claims are evidence-bound). */
export interface CapabilityEvidence {
  readonly kind: CapabilityEvidenceKind;
  /** Durable reference (document id, observation id, catalog revision…). */
  readonly reference: string;
}

/** What an adapter publishes INTO the registry — a claim plus its provenance and evidence. */
export interface PublishedCapabilityFact {
  readonly claim: CapabilityDescriptor;
  readonly provenance: CapabilityProvenance;
  readonly evidence: CapabilityEvidence;
}

/** An arbitrated claim as held by the catalog (immutable once accepted). */
export interface CapabilityClaimRecord {
  readonly claim: CapabilityDescriptor;
  readonly provenance: CapabilityProvenance;
  readonly evidence: CapabilityEvidence;
  /** Catalog revision at which the claim was accepted. */
  readonly acceptedAtRevision: string;
}

/** One capability requirement derived from a task profile (INT-001→INT-002 handoff). */
export interface CapabilityRequirement {
  readonly id: string;
  readonly kind: CapabilityKind;
  /** Minimum acceptable claim version (defaults to any). */
  readonly minVersion?: string;
}

/** The task profile's capability requirements, resolved BEFORE any route selection. */
export interface TaskCapabilityProfile {
  readonly requirements: readonly CapabilityRequirement[];
}

/** Which claim version satisfied a requirement — with its evidence and provenance. */
export interface ClaimSatisfaction {
  readonly requirementId: string;
  readonly claimId: string;
  readonly claimKind: CapabilityKind;
  readonly claimVersion: string;
  readonly evidenceKind: CapabilityEvidenceKind;
  readonly evidenceReference: string;
  readonly publisher: string;
}

export type UnmetReason = "unknown-capability" | "version-unavailable" | "invalid-requirement";

export interface UnmetRequirement {
  readonly requirementId: string;
  readonly kind: CapabilityKind | null;
  readonly reason: UnmetReason;
  readonly minVersion: string | null;
}

/**
 * Registry-arbitrated resolution of a task capability profile. Satisfactions
 * record the exact claim VERSIONS (plus evidence references and provenance)
 * that satisfied the profile — durable evidence for routing decisions.
 */
export type CapabilityResolution =
  | {
      readonly satisfied: true;
      readonly catalogRevision: string;
      readonly satisfactions: readonly ClaimSatisfaction[];
    }
  | {
      readonly satisfied: false;
      readonly catalogRevision: string;
      readonly unmet: readonly UnmetRequirement[];
    };

/** Pure validation verdict for a published fact (registry arbitration input). */
export type FactValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

/** Arbitrated outcome of publishing a fact into the registry. */
export type PublishOutcome =
  | { readonly status: "accepted"; readonly catalogRevision: string }
  | { readonly status: "converged"; readonly catalogRevision: string }
  | { readonly status: "rejected"; readonly reason: string };
