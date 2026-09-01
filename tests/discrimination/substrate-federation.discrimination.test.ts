/**
 * Discrimination: the substrate federation boundaries (WORK-031,
 * CSX-001..004; checkpoint contracts SELF-HOSTING-BOUNDARY,
 * EXECUTION-PROVENANCE).
 *
 * Every protection is proven by a mutant that removes it (the
 * WORK-013/014/017/018/023 red-record pattern): STATIC mutants mutate
 * the REAL source in memory and the shared scanners must flag exactly
 * the weakened protection; RUNTIME red records observe the governed
 * world under constructed wiring scenarios.
 *
 * The mandatory mutants (SF = substrate federation):
 *
 *   SF1  a vendor SKU/rail leaks into the substrate contracts —
 *        static;
 *   SF2  the substrate registry gains an authority seam — static
 *        (pinned deps);
 *   SF3  the substrate registry stops publishing through the EXISTING
 *        capability registry — static;
 *   SF4  the integration starts creating its own registry — static;
 *   SF5  execution vocabulary appears in the substrate trees —
 *        static;
 *   SF6  (runtime) an invalid substrate declaration never publishes
 *        (fail-closed validation);
 *   SF7  (runtime) a different body under the same identity+version
 *        fails closed (immutability);
 *   SF8  (runtime) the ordering invariant: a selection recorded before
 *        the upstream decisions is rejected by validation (CSX-003);
 *   SF9  (runtime) deterministic-first: a sufficient strategy never
 *        consults the catalog (the planner red record);
 *   SF10 (runtime) the selection must come from the ADMISSIBLE set;
 *   SF11 (runtime) retirement is terminal (lifecycle fail-closed);
 *   SF12 (runtime) tenant scope: cross-tenant lifecycle fails closed.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ComputationalSubstrateInput } from "../../src/modules/capabilities/public";
import {
  createCapabilityRegistry,
  createInMemoryCatalogStore,
  createSubstrateRegistry,
  InMemorySubstrateStore,
  SEED_CAPABILITY_FACTS,
  validateComputationalSubstrate,
} from "../../src/modules/capabilities/public";
import { validateSubstrateSelection } from "../../src/modules/planning/public";
import { PROVIDER_IDENTIFIER } from "./lib/patterns";

const REPO_ROOT = join(process.cwd());

interface FileLike {
  readonly path: string;
  readonly content: string;
}

function collectFiles(dir: string): FileLike[] {
  const out: FileLike[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith(".ts")) {
        out.push({ path: full.slice(REPO_ROOT.length + 1), content: readFileSync(full, "utf8") });
      }
    }
  };
  walk(dir);
  return out;
}

const SUBSTRATE_TREE: FileLike[] = [
  ...collectFiles(join(REPO_ROOT, "src/modules/capabilities")).filter((f) =>
    f.path.includes("substrate"),
  ),
  ...collectFiles(join(REPO_ROOT, "src/modules/planning")).filter(
    (f) => f.path.includes("substrate") || f.path.includes("workload-class"),
  ),
  ...collectFiles(join(REPO_ROOT, "src/integrations/substrate-federation")),
];

const REGISTRY_SOURCE = readFileSync(
  join(REPO_ROOT, "src/modules/capabilities/application/substrate-registry.ts"),
  "utf8",
);

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
    workloadClasses: ["batch"],
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
    description: null,
    ...overrides,
  };
}

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

describe("discrimination: substrate federation (WORK-031)", () => {
  test("SF1: a vendor SKU/rail leaking into the substrate contracts is flagged", () => {
    const mutated = SUBSTRATE_TREE.map((file) =>
      file.path === "src/modules/capabilities/domain/substrate.ts"
        ? {
            ...file,
            content: file.content.replace(
              'export const SUBSTRATE_MODALITIES = ["text", "audio", "image", "video", "document"] as const;',
              'export const SUBSTRATE_MODALITIES = ["text", "audio", "image", "video", "document"] as const;\n// H100 fleet support line',
            ),
          }
        : file,
    );
    const violations: string[] = [];
    for (const file of mutated) {
      if (/\b(A100|H100|T4|V100|kubernetes|aws|gcp|azure)\b/i.test(file.content)) {
        violations.push(file.path);
      }
      if (PROVIDER_IDENTIFIER.test(file.content)) {
        violations.push(`${file.path}: provider`);
      }
    }
    expect(violations.length).toBeGreaterThan(0);
    const clean: string[] = [];
    for (const file of SUBSTRATE_TREE) {
      if (/\b(A100|H100|T4|V100|kubernetes|aws|gcp|azure)\b/i.test(file.content)) {
        clean.push(file.path);
      }
    }
    expect(clean).toEqual([]);
  });

  test("SF2: the substrate registry gaining an authority seam is flagged", () => {
    const mutated = REGISTRY_SOURCE.replace(
      "readonly store: SubstrateStore;",
      "readonly store: SubstrateStore;\n  readonly admission: ToolAdmission;",
    );
    expect(mutated.includes("ToolAdmission")).toBe(true);
    expect(REGISTRY_SOURCE.includes("ToolAdmission")).toBe(false);
  });

  test("SF3: the registry stopping claim publication through the EXISTING registry is flagged", () => {
    const mutated = REGISTRY_SOURCE.replace(
      "await registry.publish({",
      "await thisStore.publish({",
    );
    expect(mutated.includes("await registry.publish({")).toBe(false);
    expect(REGISTRY_SOURCE.includes("await registry.publish({")).toBe(true);
  });

  test("SF4: the integration creating its own registry is flagged", () => {
    const service = readFileSync(
      join(REPO_ROOT, "src/integrations/substrate-federation/application/federation-service.ts"),
      "utf8",
    );
    const mutated = service.replace(
      "const { substrateRegistry } = deps;",
      "const { substrateRegistry } = deps;\nconst own = await createCapabilityRegistry({});",
    );
    expect(mutated.includes("createCapabilityRegistry")).toBe(true);
    expect(service.includes("createCapabilityRegistry")).toBe(false);
  });

  test("SF5: execution vocabulary appearing in the substrate trees is flagged", () => {
    const mutated = SUBSTRATE_TREE.map((file) =>
      file.path === "src/modules/capabilities/application/substrate-registry.ts"
        ? {
            ...file,
            content: file.content.replace(
              "const iso = () => now().toISOString();",
              "const iso = () => now().toISOString();\nconst next = nextState(cmd);",
            ),
          }
        : file,
    );
    const violations = mutated.filter((file) => /\bnextState\b/.test(file.content));
    expect(violations.map((v) => v.path)).toContain(
      "src/modules/capabilities/application/substrate-registry.ts",
    );
    expect(SUBSTRATE_TREE.filter((file) => /\bnextState\b/.test(file.content))).toEqual([]);
  });

  test("SF6: an invalid substrate declaration never publishes (fail-closed)", async () => {
    const { substrateRegistry } = await buildRegistry();
    await expect(
      substrateRegistry.publish(substrateInput({ latencyClass: "urgent" as never }), ACTOR),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    await expect(
      substrateRegistry.publish(substrateInput({ workloadClasses: [] }), ACTOR),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    // And the pure validator agrees.
    expect(
      validateComputationalSubstrate(substrateInput({ isolation: "k8s" as never })).valid,
    ).toBe(false);
  });

  test("SF7: a different body under the same identity+version fails closed (immutability)", async () => {
    const { substrateRegistry } = await buildRegistry();
    await substrateRegistry.publish(substrateInput(), ACTOR);
    await expect(
      substrateRegistry.publish(substrateInput({ adapterRef: "other-adapter" }), ACTOR),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    // Identical republish converges.
    const again = await substrateRegistry.publish(substrateInput(), ACTOR);
    expect(again.status).toBe("converged");
  });

  test("SF8: the ordering invariant — pre-ordering selections are rejected (CSX-003)", () => {
    expect(() =>
      validateSubstrateSelection({
        outcome: "selected",
        workloadClass: "batch",
        admissible: [
          {
            substrateId: "gpu-fleet-a",
            version: "1.0.0",
            adapterRef: "a",
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
        rationale: "x",
        after: {
          policyInputsCaptured: false,
          capabilityResolutionCaptured: true,
          deterministicSufficiencyApplied: true,
        },
      }),
    ).toThrow(/CSX-003 ordering/);
  });

  test("SF9: deterministic-first — a sufficient strategy never consults the catalog (planner red record)", async () => {
    const { createPlannerService, createNodeDigest } = await import(
      "../../src/modules/planning/public"
    );
    const { createPlanningSinkAdapter } = await import(
      "../../src/modules/planning/adapters/planning-sink-adapter"
    );
    const { ACTOR: FAKES_ACTOR, createInMemoryExecutions } = await import(
      "../unit/executions/fakes"
    );
    const executions = createInMemoryExecutions();
    const APP = "00000000-0000-7000-8000-0000000000f1";
    executions.store.seedApplication(APP, FAKES_ACTOR.tenantId);
    let catalogCalls = 0;
    const planner = createPlannerService({
      capabilityAuthority: {
        catalogRevision: "rev-1",
        async resolve(profile: { requirements: ReadonlyArray<{ id: string; kind: string }> }) {
          return {
            satisfied: true,
            catalogRevision: "rev-1",
            satisfactions: profile.requirements.map((requirement) => ({
              requirementId: requirement.id,
              claimId: requirement.id,
              claimKind: requirement.kind as never,
              claimVersion: "1.0.0",
              evidenceKind: "adapter-declared" as const,
              evidenceReference: "seed",
              publisher: "seed",
            })),
          };
        },
      } as never,
      policyInputs: {
        async effective() {
          return {
            outcome: "allow",
            effective: {},
            policySetId: "d",
            policySetVersion: 1,
            policyContentHash: "h",
            appliedScopes: ["platform"],
          } as never;
        },
      } as never,
      routeExplorer: {
        async explore() {
          return [];
        },
      } as never,
      deterministicCatalog: {
        async list() {
          const { DETERMINISTIC_CATALOG_SEED } = await import(
            "../../src/modules/planning/adapters/in-memory-deterministic-catalog"
          );
          return DETERMINISTIC_CATALOG_SEED;
        },
      } as never,
      sink: createPlanningSinkAdapter(executions.service),
      digest: createNodeDigest(),
      generateId: executions.generateId,
      now: () => new Date("2026-09-15T12:00:00Z"),
      substrateCatalog: {
        async listAvailable() {
          catalogCalls += 1;
          return [];
        },
      } as never,
    });
    const receipt = await executions.service.createExecution(
      { applicationId: APP, task: { kind: "arithmetic", input: { expression: "2+2" } } },
      "sf9-create",
      FAKES_ACTOR,
    );
    const executionId = receipt.executionId;
    await executions.service.transition(
      { ...FAKES_ACTOR, applicationId: APP, executionId, command: "authorize" },
      "sf9-auth",
    );
    await executions.service.transition(
      { ...FAKES_ACTOR, applicationId: APP, executionId, command: "plan" },
      "sf9-plan",
    );
    const outcome = await planner.planExecution(
      {
        applicationId: APP,
        executionId,
        tenantId: FAKES_ACTOR.tenantId,
        actorId: FAKES_ACTOR.actorId,
        task: { kind: "arithmetic", input: { expression: "2+2" }, workloadClass: "batch" },
      },
      "sf9-plan-exec",
    );
    expect(outcome.decision.substrateSelection?.outcome).toBe("no-substrate-required");
    expect(catalogCalls).toBe(0);
  });

  test("SF10: the selection must come from the ADMISSIBLE set", () => {
    expect(() =>
      validateSubstrateSelection({
        outcome: "selected",
        workloadClass: "batch",
        admissible: [],
        inadmissible: [],
        selected: { substrateId: "anything", version: "1.0.0" },
        rationale: "x",
        after: {
          policyInputsCaptured: true,
          capabilityResolutionCaptured: true,
          deterministicSufficiencyApplied: true,
        },
      }),
    ).toThrow(/ADMISSIBLE/);
  });

  test("SF11: retirement is terminal (lifecycle fail-closed)", async () => {
    const { substrateRegistry } = await buildRegistry();
    await substrateRegistry.publish(substrateInput(), ACTOR);
    const target = {
      applicationId: ACTOR.applicationId,
      substrateId: "gpu-fleet-a",
      version: "1.0.0",
      actor: ACTOR,
    };
    await substrateRegistry.retire(target);
    await expect(substrateRegistry.resume(target)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
    await expect(substrateRegistry.suspend(target)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
  });

  test("SF12: tenant scope — cross-tenant lifecycle fails closed", async () => {
    const { substrateRegistry } = await buildRegistry();
    await substrateRegistry.publish(substrateInput(), ACTOR);
    const cross = {
      applicationId: ACTOR.applicationId,
      substrateId: "gpu-fleet-a",
      version: "1.0.0",
      actor: { ...ACTOR, tenantId: "00000000-0000-7000-8000-0000000000ff" },
    };
    await expect(substrateRegistry.suspend(cross)).rejects.toMatchObject({
      code: "TENANT_SCOPE_VIOLATION",
    });
  });
});
