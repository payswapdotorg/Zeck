/**
 * Unit tests — the substrate federation domain + registries (WORK-031,
 * CSX-001/CSX-002/CSX-004).
 *
 * Proves the frozen vocabularies, the fail-closed substrate validation,
 * the claim publication through the EXISTING capability registry, the
 * lifecycle transitions, and the planning-side workload-class contracts
 * and substrate-selection validation (the CSX-003 ordering evidence).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { ComputationalSubstrateInput } from "../../../src/modules/capabilities/public";
import {
  canonicalSubstrateJson,
  createCapabilityRegistry,
  createInMemoryCatalogStore,
  createSubstrateRegistry,
  InMemorySubstrateStore,
  SEED_CAPABILITY_FACTS,
  SUBSTRATE_LIFECYCLE_TRANSITIONS,
  substrateCapabilityClaim,
  validateComputationalSubstrate,
  WORKLOAD_CLASSES,
} from "../../../src/modules/capabilities/public";
import {
  SUBSTRATE_INADMISSIBLE_REASONS,
  validateSubstrateSelection,
  validateWorkloadClassProfile,
  WORKLOAD_CLASS_REQUIREMENTS,
  workloadClassProfileOf,
} from "../../../src/modules/planning/public";

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");

const ACTOR = {
  actorId: "00000000-0000-7000-8000-000000000051",
  applicationId: "00000000-0000-7000-8000-000000000052",
  tenantId: "00000000-0000-7000-8000-000000000053",
};

function substrateInput(
  overrides: Partial<ComputationalSubstrateInput> = {},
): ComputationalSubstrateInput {
  return {
    substrateId: "gpu-fleet-a",
    version: "1.0.0",
    workloadClasses: ["batch", "training-evaluation"],
    modalities: ["text"],
    latencyClass: "batch",
    resource: {
      cpuMilliCores: 4000,
      memoryMiB: 8192,
      estimatedDurationMs: 60_000,
      estimatedCostMicroUsd: "500",
    },
    isolation: "container",
    sideEffectClasses: ["none"],
    executionCapability: { id: "batch-execution", minVersion: "1.0.0" },
    adapterRef: "batch-substrate-adapter",
    description: "A neutral GPU fleet substrate",
    ...overrides,
  };
}

describe("the frozen vocabularies (CSX-001/CSX-002)", () => {
  test("the workload-class vocabulary is the ADR-0016 taxonomy", () => {
    expect([...WORKLOAD_CLASSES]).toEqual([
      "interactive",
      "realtime",
      "asynchronous",
      "batch",
      "training-evaluation",
      "edge",
      "embodied",
      "specialized-accelerator",
    ]);
  });

  test("the substrate lifecycle is strict (retired terminal)", () => {
    expect(SUBSTRATE_LIFECYCLE_TRANSITIONS.available).toEqual(["suspended", "retired"]);
    expect(SUBSTRATE_LIFECYCLE_TRANSITIONS.suspended).toEqual(["available", "retired"]);
    expect(SUBSTRATE_LIFECYCLE_TRANSITIONS.retired).toEqual([]);
  });
});

describe("substrate validation (fail-closed)", () => {
  test("a well-formed substrate passes", () => {
    expect(validateComputationalSubstrate(substrateInput()).valid).toBe(true);
  });

  test("vocabulary violations are rejected", () => {
    expect(
      validateComputationalSubstrate(substrateInput({ latencyClass: "urgent" as never })).valid,
    ).toBe(false);
    expect(
      validateComputationalSubstrate(substrateInput({ isolation: "kubernetes" as never })).valid,
    ).toBe(false);
    expect(
      validateComputationalSubstrate(substrateInput({ workloadClasses: ["metaverse" as never] }))
        .valid,
    ).toBe(false);
    expect(
      validateComputationalSubstrate(substrateInput({ modalities: ["smell" as never] })).valid,
    ).toBe(false);
    expect(
      validateComputationalSubstrate(substrateInput({ sideEffectClasses: ["mutating" as never] }))
        .valid,
    ).toBe(false);
  });

  test("at least one workload class and side-effect class; no duplicates", () => {
    expect(validateComputationalSubstrate(substrateInput({ workloadClasses: [] })).valid).toBe(
      false,
    );
    expect(
      validateComputationalSubstrate(substrateInput({ workloadClasses: ["batch", "batch"] })).valid,
    ).toBe(false);
    expect(validateComputationalSubstrate(substrateInput({ sideEffectClasses: [] })).valid).toBe(
      false,
    );
  });

  test("the resource profile is explicit and neutral (bounded)", () => {
    expect(
      validateComputationalSubstrate(
        substrateInput({
          resource: {
            cpuMilliCores: -1,
            memoryMiB: 1,
            estimatedDurationMs: 1,
            estimatedCostMicroUsd: "0",
          },
        }),
      ).valid,
    ).toBe(false);
    expect(
      validateComputationalSubstrate(
        substrateInput({
          resource: {
            cpuMilliCores: 1,
            memoryMiB: 1,
            estimatedDurationMs: 86_400_001,
            estimatedCostMicroUsd: "0",
          },
        }),
      ).valid,
    ).toBe(false);
    expect(
      validateComputationalSubstrate(
        substrateInput({
          resource: {
            cpuMilliCores: 1,
            memoryMiB: 1,
            estimatedDurationMs: 1,
            estimatedCostMicroUsd: "1.5",
          },
        }),
      ).valid,
    ).toBe(false);
  });

  test("secret-shaped descriptions are rejected", () => {
    expect(
      validateComputationalSubstrate(
        substrateInput({ description: "key sk-abcdefghijklmnopqrstuvwx" }),
      ).valid,
    ).toBe(false);
  });

  test("content addressing is deterministic", () => {
    const a = canonicalSubstrateJson(substrateInput());
    const reordered = canonicalSubstrateJson(
      substrateInput({ workloadClasses: ["training-evaluation", "batch"] }),
    );
    expect(reordered).toBe(a); // vocabularies are canonically sorted
    expect(digest(a)).toBe(digest(a));
    const changed = canonicalSubstrateJson(substrateInput({ adapterRef: "other-adapter" }));
    expect(digest(a)).not.toBe(digest(changed));
  });

  test("the capability claim is a runtime claim with neutral attributes", () => {
    const { claim, evidenceReference } = substrateCapabilityClaim(substrateInput());
    expect(claim.kind).toBe("runtime");
    expect(claim.id).toBe("batch-execution");
    expect(claim.attributes?.substrateId).toBe("gpu-fleet-a");
    expect(claim.attributes?.adapterRef).toBe("batch-substrate-adapter");
    expect(evidenceReference).toBe("substrates:gpu-fleet-a@1.0.0");
  });
});

describe("the substrate registry (claims through the EXISTING authority)", () => {
  async function buildRegistry() {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      seed: [...SEED_CAPABILITY_FACTS],
    });
    const store = new InMemorySubstrateStore();
    const substrateRegistry = createSubstrateRegistry({
      store,
      registry,
      digest,
      generateId: (() => {
        let n = 0;
        return () => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`;
      })(),
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    return { registry, store, substrateRegistry };
  }

  test("publishing records the substrate AND the capability claim resolves", async () => {
    const { registry, substrateRegistry } = await buildRegistry();
    const outcome = await substrateRegistry.publish(substrateInput(), ACTOR);
    expect(outcome.status).toBe("published");
    expect(outcome.record.status).toBe("available");
    // The claim is IN the existing registry (the one authority).
    const claims = await registry.listClaims();
    expect(claims.some((claim) => claim.claim.id === "batch-execution")).toBe(true);
    // Identical republish converges.
    const again = await substrateRegistry.publish(substrateInput(), ACTOR);
    expect(again.status).toBe("converged");
  });

  test("a different body under the same identity+version fails closed", async () => {
    const { substrateRegistry } = await buildRegistry();
    await substrateRegistry.publish(substrateInput(), ACTOR);
    await expect(
      substrateRegistry.publish(substrateInput({ adapterRef: "other-adapter" }), ACTOR),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("the lifecycle is guarded and retirement is terminal", async () => {
    const { substrateRegistry } = await buildRegistry();
    await substrateRegistry.publish(substrateInput(), ACTOR);
    const suspendInput = {
      applicationId: ACTOR.applicationId,
      substrateId: "gpu-fleet-a",
      version: "1.0.0",
      actor: ACTOR,
    };
    const suspended = await substrateRegistry.suspend(suspendInput);
    expect(suspended.status).toBe("suspended");
    const resumed = await substrateRegistry.resume(suspendInput);
    expect(resumed.status).toBe("available");
    await substrateRegistry.retire(suspendInput);
    await expect(substrateRegistry.resume(suspendInput)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
  });

  test("workload-class listing filters by availability and class", async () => {
    const { substrateRegistry } = await buildRegistry();
    await substrateRegistry.publish(substrateInput(), ACTOR);
    await substrateRegistry.publish(
      substrateInput({
        substrateId: "edge-fabric-b",
        workloadClasses: ["edge", "interactive"],
        latencyClass: "interactive",
        executionCapability: { id: "edge-execution", minVersion: "1.0.0" },
      }),
      ACTOR,
    );
    expect(
      await substrateRegistry.listAvailableByWorkloadClass(ACTOR.applicationId, "edge"),
    ).toHaveLength(1);
    expect(
      await substrateRegistry.listAvailableByWorkloadClass(ACTOR.applicationId, "batch"),
    ).toHaveLength(1);
    expect(
      await substrateRegistry.listAvailableByWorkloadClass(ACTOR.applicationId, "embodied"),
    ).toHaveLength(0);
  });
});

describe("the workload-class contracts (CSX-002, planning side)", () => {
  test("every workload class maps to its runtime requirement", () => {
    for (const klass of WORKLOAD_CLASSES) {
      const profile = workloadClassProfileOf(klass);
      expect(profile.workloadClass).toBe(klass);
      expect(profile.requirements.length).toBeGreaterThanOrEqual(1);
      expect(WORKLOAD_CLASS_REQUIREMENTS[klass].length).toBeGreaterThanOrEqual(1);
    }
    expect(WORKLOAD_CLASS_REQUIREMENTS.interactive[0]?.id).toBe("interactive-execution");
  });

  test("the profile validation is fail-closed", () => {
    expect(() =>
      validateWorkloadClassProfile({ workloadClass: "metaverse", requirements: [] }),
    ).toThrow();
    expect(() =>
      validateWorkloadClassProfile({ workloadClass: "batch", requirements: [] }),
    ).toThrow();
    expect(
      validateWorkloadClassProfile({
        workloadClass: "batch",
        requirements: WORKLOAD_CLASS_REQUIREMENTS.batch,
      }),
    ).toEqual({ workloadClass: "batch", requirements: WORKLOAD_CLASS_REQUIREMENTS.batch });
  });
});

describe("the substrate-selection validation (CSX-003 ordering)", () => {
  const AFTER = {
    policyInputsCaptured: true,
    capabilityResolutionCaptured: true,
    deterministicSufficiencyApplied: true,
  };

  test("a no-substrate-required outcome is valid (deterministic-first)", () => {
    const selection = validateSubstrateSelection({
      outcome: "no-substrate-required",
      workloadClass: "batch",
      admissible: [],
      inadmissible: [],
      selected: null,
      rationale: "deterministic-sufficient",
      after: AFTER,
    });
    expect(selection.outcome).toBe("no-substrate-required");
  });

  test("a selected outcome must select from the ADMISSIBLE set", () => {
    expect(() =>
      validateSubstrateSelection({
        outcome: "selected",
        workloadClass: "batch",
        admissible: [],
        inadmissible: [],
        selected: { substrateId: "gpu-fleet-a", version: "1.0.0" },
        rationale: "x",
        after: AFTER,
      }),
    ).toThrow(/ADMISSIBLE/);
    const valid = validateSubstrateSelection({
      outcome: "selected",
      workloadClass: "batch",
      admissible: [
        {
          substrateId: "gpu-fleet-a",
          version: "1.0.0",
          adapterRef: "batch-substrate-adapter",
          resource: {
            cpuMilliCores: 1,
            memoryMiB: 1,
            estimatedDurationMs: 1,
            estimatedCostMicroUsd: "0",
          },
          isolation: "container",
          latencyClass: "batch",
        },
      ],
      inadmissible: [],
      selected: { substrateId: "gpu-fleet-a", version: "1.0.0" },
      rationale: "catalog order",
      after: AFTER,
    });
    expect(valid.outcome).toBe("selected");
  });

  test("THE ORDERING INVARIANT: selections before the upstream decisions are rejected", () => {
    for (const missing of [
      {
        policyInputsCaptured: false,
        capabilityResolutionCaptured: true,
        deterministicSufficiencyApplied: true,
      },
      {
        policyInputsCaptured: true,
        capabilityResolutionCaptured: false,
        deterministicSufficiencyApplied: true,
      },
      {
        policyInputsCaptured: true,
        capabilityResolutionCaptured: true,
        deterministicSufficiencyApplied: false,
      },
    ]) {
      expect(() =>
        validateSubstrateSelection({
          outcome: "no-substrate-required",
          workloadClass: "batch",
          admissible: [],
          inadmissible: [],
          selected: null,
          rationale: "x",
          after: missing,
        }),
      ).toThrow(/CSX-003 ordering/);
    }
  });

  test("the inadmissible reason vocabulary is closed", () => {
    expect([...SUBSTRATE_INADMISSIBLE_REASONS]).toEqual([
      "substrate-suspended",
      "workload-class-unsupported",
      "latency-class-mismatch",
      "isolation-below-policy",
      "cost-above-ceiling",
      "capability-unresolved",
    ]);
    expect(() =>
      validateSubstrateSelection({
        outcome: "none-admissible",
        workloadClass: "batch",
        admissible: [],
        inadmissible: [
          { substrateId: "x", version: "1.0.0", reason: "vendor-outage" as never, detail: "y" },
        ],
        selected: null,
        rationale: "x",
        after: AFTER,
      }),
    ).toThrow(/closed vocabulary/);
  });
});
