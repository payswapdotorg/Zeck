/**
 * Unit: capability registry validation, arbitration, versioning and
 * concurrency (WORK-005 / INT-002 acceptance criteria 1, 2 and 4).
 */

import { describe, expect, test } from "vitest";
import {
  CAPABILITY_KINDS,
  createCapabilityRegistry,
  createInMemoryCatalogStore,
  type PublishedCapabilityFact,
  SEED_CAPABILITY_FACTS,
  validatePublishedFact,
} from "../../../src/modules/capabilities/public";

const PUBLISHED_AT = "2026-08-30T00:00:00Z";

const fact = (mutation: Partial<PublishedCapabilityFact> = {}): PublishedCapabilityFact => ({
  claim: { id: "probe-claim", kind: "model", version: "1.0.0", attributes: { streaming: true } },
  provenance: { publisher: "probe", publishedAt: PUBLISHED_AT },
  evidence: { kind: "adapter-declared", reference: "probe:ref" },
  ...mutation,
});

async function emptyRegistry() {
  return createCapabilityRegistry({ store: createInMemoryCatalogStore() });
}

describe("capability registry — published fact validation", () => {
  test("a valid fact passes pure validation", () => {
    expect(validatePublishedFact(fact())).toEqual({ valid: true });
  });

  test("unknown capability kinds are rejected", () => {
    const verdict = validatePublishedFact(
      fact({ claim: { id: "x", kind: "vibes" as never, version: "1.0.0" } }),
    );
    expect(verdict.valid).toBe(false);
  });

  test("missing evidence reference is rejected (evidence is mandatory per claim)", () => {
    const verdict = validatePublishedFact(
      fact({ evidence: { kind: "adapter-declared", reference: "" } }),
    );
    expect(verdict.valid).toBe(false);
  });

  test("malformed versions are rejected", () => {
    for (const version of ["1.x", "v1", "1.0.0.0", "", "one"]) {
      const verdict = validatePublishedFact(fact({ claim: { id: "x", kind: "model", version } }));
      expect(verdict.valid, `version ${version}`).toBe(false);
    }
  });

  test("non-primitive attribute values are rejected (neutral metadata only)", () => {
    const verdict = validatePublishedFact(
      fact({
        claim: {
          id: "x",
          kind: "model",
          version: "1.0.0",
          attributes: { nested: { deep: true } as never },
        },
      }),
    );
    expect(verdict.valid).toBe(false);
  });

  test("missing provenance is rejected", () => {
    const verdict = validatePublishedFact(
      fact({ provenance: { publisher: "", publishedAt: PUBLISHED_AT } }),
    );
    expect(verdict.valid).toBe(false);
  });

  test("non-slug capability ids are rejected (no provider namespacing)", () => {
    for (const id of ["", "UPPER", "has space", "a".repeat(100), "slash/id"]) {
      const verdict = validatePublishedFact(
        fact({ claim: { id, kind: "model", version: "1.0.0" } }),
      );
      expect(verdict.valid, `id "${id}"`).toBe(false);
    }
  });
});

describe("capability registry — arbitration and versioning", () => {
  test("accepted publishes advance the catalog revision monotonically", async () => {
    const registry = await emptyRegistry();
    expect(registry.catalogRevision).toBe("rev-0");
    const first = await registry.publish(fact());
    expect(first).toEqual({ status: "accepted", catalogRevision: "rev-1" });
    const second = await registry.publish(
      fact({ claim: { id: "other", kind: "tool", version: "2.0.0" } }),
    );
    expect(second).toEqual({ status: "accepted", catalogRevision: "rev-2" });
    expect(registry.catalogRevision).toBe("rev-2");
  });

  test("an id already bound to a different kind is rejected (vocabulary conflict)", async () => {
    const registry = await emptyRegistry();
    await registry.publish(fact());
    const outcome = await registry.publish(
      fact({ claim: { id: "probe-claim", kind: "runtime", version: "1.0.0" } }),
    );
    expect(outcome.status).toBe("rejected");
  });

  test("a higher version of the same claim coexists; resolution picks the highest", async () => {
    const registry = await emptyRegistry();
    await registry.publish(fact({ claim: { id: "c", kind: "model", version: "1.0.0" } }));
    await registry.publish(fact({ claim: { id: "c", kind: "model", version: "1.2.0" } }));
    await registry.publish(fact({ claim: { id: "c", kind: "model", version: "1.10.0" } }));
    const resolution = await registry.resolve({
      requirements: [{ id: "c", kind: "model" }],
    });
    expect(resolution.satisfied).toBe(true);
    if (resolution.satisfied) {
      // 1.10.0 > 1.2.0 numerically (not lexically).
      expect(resolution.satisfactions[0]?.claimVersion).toBe("1.10.0");
    }
  });

  test("concurrent identical publishes converge to one accepted record and one revision", async () => {
    const registry = await emptyRegistry();
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => registry.publish(fact())));
    const accepted = outcomes.filter((outcome) => outcome.status === "accepted");
    const converged = outcomes.filter((outcome) => outcome.status === "converged");
    expect(accepted).toHaveLength(1);
    expect(converged).toHaveLength(7);
    expect(registry.catalogRevision).toBe("rev-1");
    const claims = await registry.listClaims();
    expect(claims).toHaveLength(1);
  });

  test("concurrent distinct publishes are all accepted with no lost records", async () => {
    const registry = await emptyRegistry();
    const ids = Array.from({ length: 10 }, (_, index) => `claim-${index}`);
    const outcomes = await Promise.all(
      ids.map((id) => registry.publish(fact({ claim: { id, kind: "model", version: "1.0.0" } }))),
    );
    expect(outcomes.every((outcome) => outcome.status === "accepted")).toBe(true);
    expect(registry.catalogRevision).toBe(`rev-${ids.length}`);
    expect(await registry.listClaims()).toHaveLength(ids.length);
  });
});

describe("capability registry — seed catalog (six architecture kinds)", () => {
  test("the seed catalog represents model, tool, algorithm, data, runtime and human capabilities", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      seed: SEED_CAPABILITY_FACTS,
    });
    const kinds = new Set((await registry.listClaims()).map((record) => record.claim.kind));
    expect([...kinds].sort()).toEqual([...CAPABILITY_KINDS].sort());
    expect(registry.catalogRevision).toBe(`rev-${SEED_CAPABILITY_FACTS.length}`);
  });

  test("seed claims are evidence-bound and provenance-recorded", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      seed: SEED_CAPABILITY_FACTS,
    });
    for (const record of await registry.listClaims()) {
      expect(record.evidence.reference.length).toBeGreaterThan(0);
      expect(record.evidence.kind).toBe("catalog-seeded");
      expect(record.provenance.publisher).toBe("capabilities:seed-catalog");
      expect(record.acceptedAtRevision).toMatch(/^rev-\d+$/);
    }
  });

  test("a seed fact that fails validation fails construction (fail closed)", async () => {
    const invalidSeed = [fact({ evidence: { kind: "adapter-declared", reference: "" } })];
    await expect(
      createCapabilityRegistry({ store: createInMemoryCatalogStore(), seed: invalidSeed }),
    ).rejects.toThrow(/seed capability fact rejected/);
  });
});
