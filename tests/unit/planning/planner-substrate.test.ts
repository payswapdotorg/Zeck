/**
 * Unit tests — the planner's substrate selection (WORK-031, CSX-003).
 *
 * Proves the planner-side integration with the REAL planner service:
 *
 *   - unwired catalog ⇒ zero substrate interaction, the decision
 *     omits the capture (CSX-004's extensibility posture);
 *   - a declared workload class + wired catalog ⇒ the selection is
 *     captured AFTER policy/capability/sufficiency (the ordering
 *     evidence) with admissible/inadmissible candidates;
 *   - DETERMINISTIC-FIRST: a deterministic-sufficient task records
 *     "no-substrate-required" and NEVER consults the catalog;
 *   - the selection never changes the selected strategy (evidence,
 *     never authority);
 *   - no admissible substrate ⇒ the honest "none-admissible" outcome;
 *   - an unknown workload class is ignored (the frozen vocabulary).
 */

import { describe, expect, test } from "vitest";
import { createPlanningSinkAdapter } from "../../../src/modules/planning/adapters/planning-sink-adapter";
import {
  createNodeDigest,
  createPlannerService,
  type ModelRouteCandidate,
  type PlanningCapabilityAuthority,
  type PlanningPolicyInputs,
  type ResolvedPolicyInputs,
  type SubstrateCatalog,
  type SubstrateCatalogEntry,
} from "../../../src/modules/planning/public";
import type { RestrictionSet } from "../../../src/modules/policies/public";
import { ACTOR, createInMemoryExecutions } from "../executions/fakes";

const APP_ID = "00000000-0000-7000-8000-0000000000f1";

const ROUTES: readonly ModelRouteCandidate[] = [
  {
    provider: "rail-a",
    model: "model-x",
    satisfies: ["text-generation"],
    expectedCostMicroUsd: "1000",
    expectedQuality: 0.92,
    expectedLatencyMs: 2000,
  },
];

function capabilityAuthority(): PlanningCapabilityAuthority {
  return {
    catalogRevision: "rev-1",
    async resolve(profile) {
      // Satisfy EXACTLY the profile's requirements (kind-faithful: the
      // requirement's kind is echoed by the claim kind).
      return {
        satisfied: true,
        catalogRevision: "rev-1",
        satisfactions: profile.requirements.map((requirement) => ({
          requirementId: requirement.id,
          claimId: requirement.id,
          claimKind: requirement.kind,
          claimVersion: "1.0.0",
          evidenceKind: "adapter-declared" as const,
          evidenceReference: "seed",
          publisher: "seed",
        })),
      };
    },
  };
}

function policyInputs(restrictions: RestrictionSet = {}): PlanningPolicyInputs {
  return {
    async effective(): Promise<ResolvedPolicyInputs> {
      return {
        outcome: "allow",
        effective: restrictions,
        policySetId: "default",
        policySetVersion: 1,
        policyContentHash: "hash-1",
        appliedScopes: ["platform"],
      };
    },
  };
}

function catalogEntry(overrides: Partial<SubstrateCatalogEntry> = {}): SubstrateCatalogEntry {
  return {
    substrateId: "gpu-fleet-a",
    version: "1.0.0",
    adapterRef: "batch-substrate-adapter",
    workloadClasses: ["batch", "training-evaluation"],
    latencyClass: "batch",
    isolation: "container",
    status: "available",
    resource: {
      cpuMilliCores: 4000,
      memoryMiB: 8192,
      estimatedDurationMs: 60_000,
      estimatedCostMicroUsd: "500",
    },
    executionCapabilityId: "batch-execution",
    ...overrides,
  };
}

function seam(entries: readonly SubstrateCatalogEntry[]): SubstrateCatalog & { calls: number } {
  return {
    calls: 0,
    async listAvailable() {
      this.calls += 1;
      return entries;
    },
  } as SubstrateCatalog & { calls: number };
}

interface World {
  readonly planner: ReturnType<typeof createPlannerService>;
  readonly executions: ReturnType<typeof createInMemoryExecutions>;
  readonly catalog?: SubstrateCatalog & { calls: number };
}

function buildWorld(
  options: {
    readonly entries?: readonly SubstrateCatalogEntry[];
    readonly policy?: RestrictionSet;
  } = {},
): World {
  const executions = createInMemoryExecutions();
  executions.store.seedApplication(APP_ID, ACTOR.tenantId);
  const catalog = options.entries === undefined ? undefined : seam(options.entries);
  const planner = createPlannerService({
    capabilityAuthority: capabilityAuthority(),
    policyInputs: policyInputs(options.policy),
    routeExplorer: {
      async explore() {
        return ROUTES;
      },
    },
    deterministicCatalog: {
      async list() {
        const { DETERMINISTIC_CATALOG_SEED } = await import(
          "../../../src/modules/planning/adapters/in-memory-deterministic-catalog"
        );
        return DETERMINISTIC_CATALOG_SEED;
      },
    },
    sink: createPlanningSinkAdapter(executions.service),
    digest: createNodeDigest(),
    generateId: executions.generateId,
    now: () => new Date("2026-09-15T12:00:00Z"),
    ...(catalog === undefined ? {} : { substrateCatalog: catalog }),
  });
  return { planner, executions, catalog };
}

async function executionInPlanning(world: World, key: string): Promise<string> {
  const receipt = await world.executions.service.createExecution(
    { applicationId: APP_ID, task: { kind: "generation", input: { text: "artifact-1" } } },
    `create-${key}`,
    ACTOR,
  );
  const executionId = receipt.executionId;
  await world.executions.service.transition(
    { ...ACTOR, applicationId: APP_ID, executionId, command: "authorize" },
    `authorize-${key}`,
  );
  await world.executions.service.transition(
    { ...ACTOR, applicationId: APP_ID, executionId, command: "plan" },
    `plan-${key}`,
  );
  return executionId;
}

function planInput(
  executionId: string,
  key: string,
  workloadClass?: string,
  kind: "generation" | "arithmetic" = "generation",
) {
  return {
    applicationId: APP_ID,
    executionId,
    tenantId: ACTOR.tenantId,
    actorId: ACTOR.actorId,
    task: {
      kind,
      input: kind === "arithmetic" ? { expression: "2+2" } : { text: "artifact-1" },
      ...(workloadClass === undefined ? {} : { workloadClass }),
    },
    idempotencyKey: `plan-${key}`,
  };
}

describe("planner: the substrate selection (CSX-003)", () => {
  test("unwired catalog ⇒ zero substrate interaction; the decision omits the capture", async () => {
    const world = buildWorld();
    const executionId = await executionInPlanning(world, "unwired");
    const outcome = await world.planner.planExecution(
      planInput(executionId, "unwired", "batch"),
      "key-unwired",
    );
    expect(outcome.decision.substrateSelection).toBeUndefined();
  });

  test("a declared workload class + wired catalog ⇒ the selection is captured with ordering evidence", async () => {
    const world = buildWorld({ entries: [catalogEntry()] });
    const executionId = await executionInPlanning(world, "wired");
    const outcome = await world.planner.planExecution(
      planInput(executionId, "wired", "batch"),
      "key-wired",
    );
    const selection = outcome.decision.substrateSelection;
    expect(selection).toBeDefined();
    expect(selection?.outcome).toBe("selected");
    expect(selection?.selected?.substrateId).toBe("gpu-fleet-a");
    expect(selection?.admissible).toHaveLength(1);
    // The ordering evidence (CSX-003).
    expect(selection?.after).toEqual({
      policyInputsCaptured: true,
      capabilityResolutionCaptured: true,
      deterministicSufficiencyApplied: true,
    });
    // The catalog was consulted exactly once.
    expect(world.catalog?.calls).toBe(1);
    // The selection never changed the governed strategy.
    expect(outcome.decision.candidates.map((candidate) => candidate.strategyId)).toContain(
      outcome.decision.selectedStrategyId,
    );
  });

  test("DETERMINISTIC-FIRST: a sufficient task records no-substrate-required and never consults", async () => {
    // Arithmetic is deterministic-sufficient (the deterministic catalog
    // covers it): no substrate may be selected even with a wired catalog.
    const world = buildWorld({
      entries: [catalogEntry({ workloadClasses: ["interactive", "batch"] })],
    });
    const receipt = await world.executions.service.createExecution(
      { applicationId: APP_ID, task: { kind: "arithmetic", input: { expression: "2+2" } } },
      "create-det",
      ACTOR,
    );
    const executionId = receipt.executionId;
    await world.executions.service.transition(
      { ...ACTOR, applicationId: APP_ID, executionId, command: "authorize" },
      "authorize-det",
    );
    await world.executions.service.transition(
      { ...ACTOR, applicationId: APP_ID, executionId, command: "plan" },
      "plan-det",
    );
    const outcome = await world.planner.planExecution(
      planInput(executionId, "det", "batch", "arithmetic"),
      "key-det",
    );
    expect(outcome.decision.substrateSelection?.outcome).toBe("no-substrate-required");
    expect(world.catalog?.calls).toBe(0); // NEVER consulted.
  });

  test("no admissible substrate ⇒ the honest none-admissible outcome", async () => {
    const world = buildWorld({
      entries: [
        catalogEntry({
          substrateId: "costly",
          resource: {
            cpuMilliCores: 1,
            memoryMiB: 1,
            estimatedDurationMs: 1,
            estimatedCostMicroUsd: "900000",
          },
        }),
        catalogEntry({ substrateId: "weak-isolation", isolation: "process" }),
      ],
      policy: { isolation: { minIsolation: "container" }, cost: { maxCostMicroUsd: "100000" } },
    });
    const executionId = await executionInPlanning(world, "none");
    const outcome = await world.planner.planExecution(
      planInput(executionId, "none", "batch"),
      "key-none",
    );
    const selection = outcome.decision.substrateSelection;
    expect(selection?.outcome).toBe("none-admissible");
    expect(selection?.selected).toBeNull();
    // The typed rejection reasons.
    const reasons = selection?.inadmissible.map((rejection) => rejection.reason) ?? [];
    expect(reasons).toContain("cost-above-ceiling");
    expect(reasons).toContain("isolation-below-policy");
  });

  test("an unknown workload class is ignored (the frozen vocabulary)", async () => {
    const world = buildWorld({ entries: [catalogEntry()] });
    const executionId = await executionInPlanning(world, "unknown");
    const outcome = await world.planner.planExecution(
      planInput(executionId, "unknown", "metaverse"),
      "key-unknown",
    );
    expect(outcome.decision.substrateSelection).toBeUndefined();
    expect(world.catalog?.calls).toBe(0);
  });
});
