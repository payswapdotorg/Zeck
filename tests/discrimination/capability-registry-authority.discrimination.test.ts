/**
 * Discrimination: capability registry authority (WORK-005 / INT-002,
 * acceptance criterion 2 — adapters may publish capability facts and
 * evidence without becoming the capability authority).
 *
 *   R1 — a published fact that fails registry validation is REJECTED: it
 *        never enters the arbitrated catalog and never satisfies a profile.
 *   R2 — a conflicting republish (same claim version, different attributes)
 *        is rejected and the arbitrated catalog is unchanged; an identical
 *        republish converges without a second record or revision bump.
 *   R3 (mutation record) — a registry mutated to accept-anything
 *        (`validateFact` override) ACCEPTS the invalid fact: the R1
 *        rejection provably lives in registry validation, so mutating the
 *        default validator to accept-anything would fail R1.
 *   R4 — publishing is not authority: even with valid adapter facts in the
 *        catalog, profile resolution is served ONLY by the registry's
 *        arbitrated state — a profile the catalog cannot satisfy fails
 *        resolution regardless of what adapters published, and adapter
 *        facts cannot inject themselves past arbitration.
 */

import { describe, expect, test } from "vitest";
import {
  createCapabilityRegistry,
  createInMemoryCatalogStore,
  type PublishedCapabilityFact,
} from "../../src/modules/capabilities/public";
import { anthropicCapabilityFacts } from "../../src/modules/models/adapters/anthropic";
import { openRouterCapabilityFacts } from "../../src/modules/models/adapters/openrouter";

const PUBLISHED_AT = "2026-08-30T00:00:00Z";

const validFact = (id: string, version = "1.0.0"): PublishedCapabilityFact => ({
  claim: { id, kind: "model", version, attributes: { streaming: true } },
  provenance: { publisher: "models:adapter:probe", publishedAt: PUBLISHED_AT },
  evidence: { kind: "adapter-declared", reference: `probe:${id}:${version}` },
});

const INVALID_FACT: PublishedCapabilityFact = {
  // Missing evidence reference — fails registry validation.
  claim: { id: "evidence-free-claim", kind: "model", version: "1.0.0" },
  provenance: { publisher: "models:adapter:probe", publishedAt: PUBLISHED_AT },
  evidence: { kind: "adapter-declared", reference: "" },
};

async function seededRegistry() {
  return createCapabilityRegistry({ store: createInMemoryCatalogStore() });
}

describe("discrimination: capability registry authority (adapters are not the authority)", () => {
  test("R1: a published fact failing registry validation is rejected and never resolvable", async () => {
    const registry = await seededRegistry();
    const outcome = await registry.publish(INVALID_FACT);
    expect(outcome.status).toBe("rejected");

    const claims = await registry.listClaims();
    expect(claims.filter((record) => record.claim.id === INVALID_FACT.claim.id)).toHaveLength(0);

    const resolution = await registry.resolve({
      requirements: [{ id: INVALID_FACT.claim.id, kind: "model" }],
    });
    expect(resolution.satisfied).toBe(false);
    if (!resolution.satisfied) {
      expect(resolution.unmet[0]?.reason).toBe("unknown-capability");
    }
  });

  test("R2: conflicting republish is rejected; identical republish converges without drift", async () => {
    const registry = await seededRegistry();
    const first = await registry.publish(validFact("structured-output"));
    expect(first.status).toBe("accepted");

    // Same (id, kind, version), DIFFERENT attributes → rejected conflict.
    const conflicting = await registry.publish({
      ...validFact("structured-output"),
      claim: {
        id: "structured-output",
        kind: "model",
        version: "1.0.0",
        attributes: { streaming: false },
      },
    });
    expect(conflicting.status).toBe("rejected");
    const revisionAfterConflict = registry.catalogRevision;

    // Identical republish → converged, no new record, no revision bump.
    const again = await registry.publish(validFact("structured-output"));
    expect(again.status).toBe("converged");
    const claims = await registry.listClaims();
    expect(claims.filter((record) => record.claim.id === "structured-output")).toHaveLength(1);
    expect(registry.catalogRevision).toBe(revisionAfterConflict);
  });

  test("R3 mutation record: a registry mutated to accept-anything admits the invalid fact (R1's protection lives in validation)", async () => {
    const mutant = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      validateFact: () => ({ valid: true }),
    });
    const outcome = await mutant.publish(INVALID_FACT);
    // The mutant ACCEPTS what the real registry rejects — proving R1 fails
    // if the default validator is mutated to accept-anything.
    expect(outcome.status).toBe("accepted");
    const claims = await mutant.listClaims();
    expect(claims.some((record) => record.claim.id === INVALID_FACT.claim.id)).toBe(true);
  });

  test("R4: publishing is not authority — resolution serves only the arbitrated catalog", async () => {
    const registry = await seededRegistry();
    // Real adapter facts publish cleanly…
    for (const fact of openRouterCapabilityFacts()) {
      expect((await registry.publish(fact)).status).toBe("accepted");
    }
    for (const fact of anthropicCapabilityFacts()) {
      const outcome = await registry.publish(fact);
      expect(outcome.status === "accepted" || outcome.status === "converged").toBe(true);
    }
    // …but a profile needing a capability NEITHER rail published still fails:
    const resolution = await registry.resolve({
      requirements: [
        { id: "structured-output", kind: "model" },
        { id: "human-review", kind: "human" },
        { id: "quantum-orchestration", kind: "algorithm" },
      ],
    });
    expect(resolution.satisfied).toBe(false);
    if (!resolution.satisfied) {
      expect(resolution.unmet.map((entry) => entry.requirementId)).toEqual([
        "human-review",
        "quantum-orchestration",
      ]);
    }
    // And the arbitrated catalog converges cross-rail duplicate claims to one.
    const structured = (await registry.listClaims()).filter(
      (record) => record.claim.id === "structured-output",
    );
    expect(structured).toHaveLength(1);
    expect(structured[0]?.provenance.publisher).toBe("models:adapter:openrouter");
  });
});
