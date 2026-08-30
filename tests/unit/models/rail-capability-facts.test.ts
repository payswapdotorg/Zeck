/**
 * Unit: rail adapter capability fact publishing (WORK-005 / INT-002
 * acceptance criterion 2) — both rails' adapters publish provider-neutral
 * facts that pass the REAL registry validation, arbitrate into the catalog,
 * and converge cross-rail on the shared neutral vocabulary.
 */

import { describe, expect, test } from "vitest";
import {
  createCapabilityRegistry,
  createInMemoryCatalogStore,
  SEED_CAPABILITY_FACTS,
} from "../../../src/modules/capabilities/public";
import { anthropicCapabilityFacts } from "../../../src/modules/models/adapters/anthropic";
import { openRouterCapabilityFacts } from "../../../src/modules/models/adapters/openrouter";

describe("rail adapters publish capability facts into the registry", () => {
  test("every adapter fact passes real registry validation and arbitration", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      seed: SEED_CAPABILITY_FACTS,
    });
    const facts = [...openRouterCapabilityFacts(), ...anthropicCapabilityFacts()];
    expect(facts.length).toBeGreaterThanOrEqual(8);
    for (const fact of facts) {
      const outcome = await registry.publish(fact);
      expect(outcome.status === "accepted" || outcome.status === "converged").toBe(true);
    }
  });

  test("both rails converge on the shared neutral vocabulary (one claim per capability)", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      seed: SEED_CAPABILITY_FACTS,
    });
    for (const fact of openRouterCapabilityFacts()) {
      const outcome = await registry.publish(fact);
      expect(outcome.status).toBe("accepted");
    }
    for (const fact of anthropicCapabilityFacts()) {
      const outcome = await registry.publish(fact);
      // Same descriptors as the first rail → converged (not a second claim).
      expect(outcome.status).toBe("converged");
    }
    const byId = new Map((await registry.listClaims()).map((record) => [record.claim.id, record]));
    expect(byId.get("structured-output")).toBeDefined();
    expect(byId.get("streaming-generation")).toBeDefined();
    expect(byId.get("tool-use-generation")).toBeDefined();
    expect(byId.get("text-generation")?.claim.version).toBe("1.1.0");
  });

  test("published adapter facts become resolvable evidence for task profiles", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      seed: SEED_CAPABILITY_FACTS,
    });
    for (const fact of openRouterCapabilityFacts()) {
      await registry.publish(fact);
    }
    const resolution = await registry.resolve({
      requirements: [
        { id: "structured-output", kind: "model" },
        { id: "streaming-generation", kind: "model" },
      ],
    });
    expect(resolution.satisfied).toBe(true);
    if (resolution.satisfied) {
      for (const satisfaction of resolution.satisfactions) {
        expect(satisfaction.evidenceKind).toBe("adapter-declared");
        expect(satisfaction.evidenceReference.length).toBeGreaterThan(0);
      }
    }
  });
});
