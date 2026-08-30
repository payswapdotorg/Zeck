/**
 * In-memory deterministic capability catalog (planning module adapter;
 * WORK-009).
 *
 * Seeds the planning contract's MINIMUM deterministic capability set
 * (calculators and arithmetic, database queries and lookups, sorting and
 * filtering and aggregation, parsers and schema validators, deterministic
 * transformations, compilers/tests/static analyzers, retrieval and search,
 * domain-specific algorithms, program execution) as first-class plan
 * candidates with typed estimates. Estimate semantics:
 * `qualityConfidence: "estimated"` marks unverified estimates that route
 * the planner into the bounded-evaluation path (ACR-002).
 *
 * Capability IDs align with the WORK-005 registry seed vocabulary where a
 * claim already exists (`structured-dataset-read`, `json-schema-validation`,
 * `document-retrieval`); the remaining claims are published INTO the
 * registry through the sanctioned publish path by
 * `publishDeterministicCapabilityFacts` (the rail-adapter precedent:
 * estimates live here, CLAIMS live in the single capability authority).
 *
 * The catalog is an INPUT to planning (never an authority): the port is
 * the future durable/remote seam (WORK-005 registry-port precedent).
 */

import type {
  DeterministicCapabilityCatalog,
  DeterministicCatalogEntry,
} from "../ports/deterministic-catalog";

export const DETERMINISTIC_CATALOG_SEED: readonly DeterministicCatalogEntry[] = [
  {
    capabilityId: "numeric-computation",
    kind: "algorithm",
    expectedQuality: 0.999,
    qualityConfidence: "verified",
    expectedCostMicroUsd: "1",
    expectedLatencyMs: 5,
    verificationStrategy: "exact-recomputation",
  },
  {
    capabilityId: "structured-dataset-read",
    kind: "data",
    expectedQuality: 0.999,
    qualityConfidence: "verified",
    expectedCostMicroUsd: "2",
    expectedLatencyMs: 10,
    verificationStrategy: "rowcount-and-shape-check",
  },
  {
    capabilityId: "deterministic-transform",
    kind: "algorithm",
    expectedQuality: 0.999,
    qualityConfidence: "verified",
    expectedCostMicroUsd: "1",
    expectedLatencyMs: 5,
    verificationStrategy: "golden-transform-replay",
  },
  {
    capabilityId: "sorting-aggregation",
    kind: "algorithm",
    expectedQuality: 0.999,
    qualityConfidence: "verified",
    expectedCostMicroUsd: "1",
    expectedLatencyMs: 4,
    verificationStrategy: "order-invariants",
  },
  {
    capabilityId: "json-schema-validation",
    kind: "algorithm",
    expectedQuality: 1.0,
    qualityConfidence: "verified",
    expectedCostMicroUsd: "1",
    expectedLatencyMs: 3,
    verificationStrategy: "property-tests",
  },
  {
    capabilityId: "static-analysis",
    kind: "algorithm",
    expectedQuality: 0.99,
    qualityConfidence: "verified",
    expectedCostMicroUsd: "5",
    expectedLatencyMs: 50,
    verificationStrategy: "known-finding-replay",
  },
  {
    capabilityId: "document-retrieval",
    kind: "tool",
    expectedQuality: 0.95,
    qualityConfidence: "estimated",
    expectedCostMicroUsd: "50",
    expectedLatencyMs: 80,
    verificationStrategy: "retrieval-recall-check",
  },
  {
    capabilityId: "program-execution",
    kind: "runtime",
    expectedQuality: 0.99,
    qualityConfidence: "verified",
    expectedCostMicroUsd: "10",
    expectedLatencyMs: 100,
    verificationStrategy: "sandboxed-replay",
  },
  {
    capabilityId: "domain-algorithm",
    kind: "algorithm",
    expectedQuality: 0.99,
    qualityConfidence: "verified",
    expectedCostMicroUsd: "3",
    expectedLatencyMs: 20,
    verificationStrategy: "oracle-tests",
  },
];

export function createInMemoryDeterministicCatalog(
  entries: readonly DeterministicCatalogEntry[] = DETERMINISTIC_CATALOG_SEED,
): DeterministicCapabilityCatalog {
  const snapshot = Object.freeze([...entries]);
  return {
    async list(): Promise<readonly DeterministicCatalogEntry[]> {
      return snapshot;
    },
  };
}
