/**
 * Unit: task capability profile resolution (WORK-005 / INT-002 acceptance
 * criteria 3 and 4) — profiles resolve against the arbitrated catalog with
 * per-claim version/evidence recording, and every negative case fails
 * closed.
 */

import { describe, expect, test } from "vitest";
import {
  createCapabilityRegistry,
  createInMemoryCatalogStore,
  SEED_CAPABILITY_FACTS,
  type TaskCapabilityProfile,
} from "../../../src/modules/capabilities/public";
import { openRouterCapabilityFacts } from "../../../src/modules/models/adapters/openrouter";

const PUBLISHED_AT = "2026-08-30T00:00:00Z";

describe("capability profile resolution", () => {
  test("an empty profile resolves trivially satisfied", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
    });
    const resolution = await registry.resolve({ requirements: [] });
    expect(resolution.satisfied).toBe(true);
    if (resolution.satisfied) {
      expect(resolution.satisfactions).toEqual([]);
    }
  });

  test("requirements across all six kinds resolve from the seeded catalog", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      seed: SEED_CAPABILITY_FACTS,
    });
    const resolution = await registry.resolve({
      requirements: [
        { id: "text-generation", kind: "model" },
        { id: "document-retrieval", kind: "tool" },
        { id: "json-schema-validation", kind: "algorithm" },
        { id: "structured-dataset-read", kind: "data" },
        { id: "process-sandbox", kind: "runtime" },
        { id: "human-review", kind: "human" },
      ],
    });
    expect(resolution.satisfied).toBe(true);
    if (resolution.satisfied) {
      expect(resolution.satisfactions).toHaveLength(6);
      // Every satisfaction records the claim version + evidence reference.
      for (const satisfaction of resolution.satisfactions) {
        expect(satisfaction.claimVersion).toMatch(/^\d+(\.\d+){0,2}$/);
        expect(satisfaction.evidenceReference).toBe(
          `zeck-capability-catalog:v1:${satisfaction.requirementId}`,
        );
        expect(satisfaction.publisher).toBe("capabilities:seed-catalog");
      }
    }
  });

  test("adapter-published facts raise the resolvable version (1.1.0 beats seed 1.0.0)", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      seed: SEED_CAPABILITY_FACTS,
    });
    for (const adapterFact of openRouterCapabilityFacts()) {
      await registry.publish(adapterFact);
    }
    const resolution = await registry.resolve({
      requirements: [{ id: "text-generation", kind: "model", minVersion: "1.1.0" }],
    });
    expect(resolution.satisfied).toBe(true);
    if (resolution.satisfied) {
      expect(resolution.satisfactions[0]?.claimVersion).toBe("1.1.0");
      expect(resolution.satisfactions[0]?.evidenceKind).toBe("adapter-declared");
    }
  });

  test("an unknown capability id is unmet with reason unknown-capability", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      seed: SEED_CAPABILITY_FACTS,
    });
    const resolution = await registry.resolve({
      requirements: [{ id: "telepathy", kind: "model" }],
    });
    expect(resolution.satisfied).toBe(false);
    if (!resolution.satisfied) {
      expect(resolution.unmet).toEqual([
        {
          requirementId: "telepathy",
          kind: "model",
          reason: "unknown-capability",
          minVersion: null,
        },
      ]);
    }
  });

  test("a known capability below the required minimum version is unmet with reason version-unavailable", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      seed: SEED_CAPABILITY_FACTS,
    });
    const resolution = await registry.resolve({
      requirements: [{ id: "text-generation", kind: "model", minVersion: "2.0.0" }],
    });
    expect(resolution.satisfied).toBe(false);
    if (!resolution.satisfied) {
      expect(resolution.unmet[0]?.reason).toBe("version-unavailable");
      expect(resolution.unmet[0]?.minVersion).toBe("2.0.0");
    }
  });

  test("a wrong-kind requirement for a known id is unmet (vocabulary is kind-bound)", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      seed: SEED_CAPABILITY_FACTS,
    });
    const resolution = await registry.resolve({
      requirements: [{ id: "text-generation", kind: "algorithm" }],
    });
    expect(resolution.satisfied).toBe(false);
    if (!resolution.satisfied) {
      expect(resolution.unmet[0]?.reason).toBe("unknown-capability");
    }
  });

  test("an invalid requirement fails the whole resolution closed (invalid-requirement)", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      seed: SEED_CAPABILITY_FACTS,
    });
    const resolution = await registry.resolve({
      requirements: [
        { id: "text-generation", kind: "model" },
        { id: "bad id!", kind: "model" },
      ],
    });
    expect(resolution.satisfied).toBe(false);
    if (!resolution.satisfied) {
      expect(resolution.unmet[0]?.reason).toBe("invalid-requirement");
    }
  });

  test("a profile mixing satisfiable and unsatisfiable requirements reports exactly the unmet ones", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      seed: SEED_CAPABILITY_FACTS,
    });
    const resolution = await registry.resolve({
      requirements: [
        { id: "text-generation", kind: "model" },
        { id: "human-review", kind: "human" },
        { id: "teleportation", kind: "runtime" },
        { id: "text-generation", kind: "model", minVersion: "99.0.0" },
      ],
    });
    expect(resolution.satisfied).toBe(false);
    if (!resolution.satisfied) {
      expect(resolution.unmet.map((entry) => entry.requirementId)).toEqual([
        "teleportation",
        "text-generation",
      ]);
    }
  });

  test("resolution is rail-agnostic: identical profile, identical output, no rail input exists", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      seed: SEED_CAPABILITY_FACTS,
    });
    const profile: TaskCapabilityProfile = {
      requirements: [{ id: "text-generation", kind: "model" }],
    };
    const one = await registry.resolve(profile);
    const two = await registry.resolve(profile);
    expect(one).toEqual(two);
  });
});

describe("capability profile resolution — fresh publishes are visible", () => {
  test("a claim published after a failed resolution unblocks the same profile", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
    });
    const profile: TaskCapabilityProfile = {
      requirements: [{ id: "structured-output", kind: "model" }],
    };
    expect((await registry.resolve(profile)).satisfied).toBe(false);
    await registry.publish({
      claim: { id: "structured-output", kind: "model", version: "1.0.0" },
      provenance: { publisher: "probe", publishedAt: PUBLISHED_AT },
      evidence: { kind: "adapter-declared", reference: "probe:structured-output" },
    });
    expect((await registry.resolve(profile)).satisfied).toBe(true);
  });
});
