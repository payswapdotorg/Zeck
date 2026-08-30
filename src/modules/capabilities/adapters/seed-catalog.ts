/**
 * Code-resident seed catalog (capabilities module adapter, WORK-005).
 *
 * The platform's baseline capability claims — provider-neutral by
 * construction, one claim per frozen architecture kind (§10: model, tool,
 * algorithm, data, runtime and human capabilities). Seeds are arbitrated
 * through the registry's IDENTICAL publish path (a seed that failed
 * validation would fail construction): the catalog is earned, not assumed.
 *
 * Rail adapters publish ADDITIONAL facts (their rails' model capabilities)
 * from their own owning adapter files — provider specifics live in
 * provenance/evidence there, never in these descriptors.
 */

import type { PublishedCapabilityFact } from "../domain/capability";

const SEED_PUBLISHED_AT = "2026-08-30T00:00:00Z";
const SEED_PUBLISHER = "capabilities:seed-catalog";
const seedEvidence = (id: string) => ({
  kind: "catalog-seeded" as const,
  reference: `zeck-capability-catalog:v1:${id}`,
});

export const SEED_CAPABILITY_FACTS: readonly PublishedCapabilityFact[] = [
  {
    claim: {
      id: "text-generation",
      kind: "model",
      version: "1.0.0",
      attributes: { input: "text", output: "text" },
    },
    provenance: { publisher: SEED_PUBLISHER, publishedAt: SEED_PUBLISHED_AT },
    evidence: seedEvidence("text-generation"),
  },
  {
    claim: {
      id: "document-retrieval",
      kind: "tool",
      version: "1.0.0",
      attributes: { deterministic: true },
    },
    provenance: { publisher: SEED_PUBLISHER, publishedAt: SEED_PUBLISHED_AT },
    evidence: seedEvidence("document-retrieval"),
  },
  {
    claim: {
      id: "json-schema-validation",
      kind: "algorithm",
      version: "1.0.0",
      attributes: { deterministic: true },
    },
    provenance: { publisher: SEED_PUBLISHER, publishedAt: SEED_PUBLISHED_AT },
    evidence: seedEvidence("json-schema-validation"),
  },
  {
    claim: {
      id: "structured-dataset-read",
      kind: "data",
      version: "1.0.0",
      attributes: { access: "read-only" },
    },
    provenance: { publisher: SEED_PUBLISHER, publishedAt: SEED_PUBLISHED_AT },
    evidence: seedEvidence("structured-dataset-read"),
  },
  {
    claim: {
      id: "process-sandbox",
      kind: "runtime",
      version: "1.0.0",
      attributes: { isolation: "process", networkEgress: false },
    },
    provenance: { publisher: SEED_PUBLISHER, publishedAt: SEED_PUBLISHED_AT },
    evidence: seedEvidence("process-sandbox"),
  },
  {
    claim: {
      id: "human-review",
      kind: "human",
      version: "1.0.0",
      attributes: { escalation: true },
    },
    provenance: { publisher: SEED_PUBLISHER, publishedAt: SEED_PUBLISHED_AT },
    evidence: seedEvidence("human-review"),
  },
];
