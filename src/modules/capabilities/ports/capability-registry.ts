/**
 * Capability registry ports (capabilities module, WORK-005 / INT-002).
 *
 * The REGISTRY is the capability authority: adapters may publish facts into
 * it, but publishing never bypasses validation or arbitration — the
 * registry alone decides what the arbitrated catalog contains and what a
 * task profile resolves to (acceptance criterion 2: adapters are never the
 * authority).
 */

import type {
  CapabilityClaimRecord,
  CapabilityResolution,
  FactValidation,
  PublishedCapabilityFact,
  PublishOutcome,
  TaskCapabilityProfile,
} from "../domain/capability";

/**
 * Storage boundary of the arbitrated catalog. The in-memory adapter ships
 * today; a durable adapter would implement the identical contract (see the
 * durability decision in `docs/work-items/WORK-005.md`).
 */
export interface CapabilityCatalogStore {
  /** All arbitrated claims (snapshot read for resolution). */
  list(): Promise<readonly CapabilityClaimRecord[]>;
  /** All arbitrated claims for one vocabulary id (any kind/version). */
  findById(id: string): Promise<readonly CapabilityClaimRecord[]>;
  /** Insert one PRE-ARBITRATED record (registry calls only, under its lock). */
  insert(record: CapabilityClaimRecord): Promise<void>;
}

/** The capability registry — the single capability authority. */
export interface CapabilityRegistry {
  /**
   * Publish a fact INTO the registry. Validation and arbitration happen
   * HERE: an invalid or conflicting fact is rejected; an identical
   * republish converges. Publishing is an input, never an authority.
   */
  publish(fact: PublishedCapabilityFact): Promise<PublishOutcome>;
  /** Resolve a task capability profile against the arbitrated catalog. */
  resolve(profile: TaskCapabilityProfile): Promise<CapabilityResolution>;
  /** The arbitrated catalog (evidence/inspection surface). */
  listClaims(): Promise<readonly CapabilityClaimRecord[]>;
  /** Current catalog revision (monotonic; advances on accepted publishes). */
  readonly catalogRevision: string;
}

/**
 * The narrowed surface handed to publishing adapters: they may submit
 * facts and observe the outcome — nothing else.
 */
export type CapabilityFactPublisher = Pick<CapabilityRegistry, "publish">;

/** Overridable validation hook (used by discrimination mutations only). */
export type FactValidator = (fact: PublishedCapabilityFact) => FactValidation;

export interface CapabilityRegistryOptions {
  /** Storage for arbitrated claims (the in-memory adapter ships in this module). */
  readonly store: CapabilityCatalogStore;
  /** Code-resident seed facts arbitrated into the catalog at construction. */
  readonly seed?: readonly PublishedCapabilityFact[];
  /**
   * Validation hook — the registry's default is `validatePublishedFact`.
   * Injection exists so discrimination proofs can demonstrate that the
   * published-fact rejection protection lives in validation (a registry
   * mutated to accept-anything loses the protection; proven in tests).
   */
  readonly validateFact?: FactValidator;
}
