/**
 * Deterministic capability catalog port (planning module outbound;
 * WORK-009).
 *
 * The planning contract's minimum deterministic capability set
 * (calculators, database queries, sorting/filtering/aggregation, parsers
 * and validators, deterministic transformations, compilers/tests/static
 * analyzers, retrieval, domain algorithms, program execution) exposed as
 * FIRST-CLASS plan candidates with typed estimates. The in-memory seeded
 * adapter ships this round; the port is the durable/remote seam (the
 * WORK-005 registry-port precedent).
 */

export type CapabilityKindValue = "algorithm" | "data" | "tool" | "runtime" | "human" | "model";

/** Is the quality estimate verified or only estimated? */
export type QualityConfidence = "verified" | "estimated";

export interface DeterministicCatalogEntry {
  /** Matches a capability requirement id the profile derives. */
  readonly capabilityId: string;
  readonly kind: CapabilityKindValue;
  readonly expectedQuality: number;
  readonly qualityConfidence: QualityConfidence;
  /** Integer micro-USD string (never a float). */
  readonly expectedCostMicroUsd: string;
  readonly expectedLatencyMs: number;
  readonly verificationStrategy: string;
}

export interface DeterministicCapabilityCatalog {
  /** The deterministic capabilities available for planning (snapshot). */
  list(): Promise<readonly DeterministicCatalogEntry[]>;
}
