/**
 * Deterministic capability fact publisher (planning module adapter;
 * WORK-009).
 *
 * Publishes the planning deterministic catalog's capability CLAIMS into
 * the WORK-005 capability registry through its sanctioned public publish
 * path — the rail-adapter precedent ("rail adapters publish ADDITIONAL
 * facts from their own owning adapter files"): estimates live in the
 * planning catalog, CLAIMS live in the single capability authority.
 *
 * Claims the registry already arbitrates (the WORK-005 seed vocabulary:
 * `structured-dataset-read`, `json-schema-validation`,
 * `document-retrieval`…) are NOT republished — the registry owns
 * arbitration, and a conflicting re-assertion would be rejected. The
 * publisher adds the planning catalog's ADDITIONAL deterministic claims
 * (numeric computation, transforms, sorting/aggregation, static
 * analysis, program execution, domain algorithms) so the authority can
 * resolve them.
 *
 * Called once at composition/wiring time (assembly roots and integration
 * tests); idempotent (a converged republish is accepted).
 */

import type { CapabilityRegistry } from "../../capabilities/public";
import { DETERMINISTIC_CATALOG_SEED } from "./in-memory-deterministic-catalog";

const PLANNING_PUBLISHER = "planning:deterministic-catalog";
const PLANNING_PUBLISHED_AT = "2026-08-30T00:00:00Z";

export interface DeterministicFactEntry {
  readonly capabilityId: string;
  readonly kind: "algorithm" | "data" | "tool" | "runtime";
}

export const DETERMINISTIC_CAPABILITY_FACT_ENTRIES: readonly DeterministicFactEntry[] =
  DETERMINISTIC_CATALOG_SEED.filter(
    (entry) => entry.kind !== "human" && entry.kind !== "model",
  ).map((entry) => ({
    capabilityId: entry.capabilityId,
    kind: entry.kind as "algorithm" | "data" | "tool" | "runtime",
  }));

export async function publishDeterministicCapabilityFacts(
  registry: CapabilityRegistry,
  entries: readonly DeterministicFactEntry[] = DETERMINISTIC_CAPABILITY_FACT_ENTRIES,
): Promise<void> {
  // Claims the authority already arbitrated are left untouched (the
  // registry owns arbitration — including the WORK-005 seed vocabulary).
  const existing = new Set((await registry.listClaims()).map((record) => record.claim.id));
  for (const entry of entries) {
    if (existing.has(entry.capabilityId)) {
      continue;
    }
    const outcome = await registry.publish({
      claim: {
        id: entry.capabilityId,
        kind: entry.kind,
        version: "1.0.0",
        attributes: { deterministic: true },
      },
      provenance: { publisher: PLANNING_PUBLISHER, publishedAt: PLANNING_PUBLISHED_AT },
      evidence: {
        kind: "catalog-seeded",
        reference: `zeck-planning-deterministic-catalog:v1:${entry.capabilityId}`,
      },
    });
    if (outcome.status === "rejected") {
      // Fail closed at wiring time: an invalid claim must never silently
      // disappear from the capability authority.
      throw new Error(
        `deterministic capability fact rejected by the registry: ${entry.capabilityId} (${outcome.reason})`,
      );
    }
  }
}
