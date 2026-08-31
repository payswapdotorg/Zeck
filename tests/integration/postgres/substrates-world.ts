/**
 * Shared real-PostgreSQL fixture for the substrate-federation suite
 * (WORK-031).
 *
 * Provisions a tenant + application, wires the REAL capability
 * registry (in-memory catalog with the platform seeds — the
 * WORK-002/010 test pattern) + the REAL substrate SQL store +
 * substrate registry, and the REAL planner over the REAL executions
 * service (the planning decision with the substrateSelection capture
 * rides the executions ledger).
 */

import { createHash } from "node:crypto";
import { createInMemoryCatalogStore } from "../../../src/modules/capabilities/adapters/in-memory-catalog-store";
import { SEED_CAPABILITY_FACTS } from "../../../src/modules/capabilities/adapters/seed-catalog";
import { SqlSubstrateStore } from "../../../src/modules/capabilities/adapters/sql-substrate-store";
import { createCapabilityRegistry } from "../../../src/modules/capabilities/application/capability-registry";
import { createSubstrateRegistry } from "../../../src/modules/capabilities/application/substrate-registry";
import type { CapabilityRegistry } from "../../../src/modules/capabilities/ports/capability-registry";
import type {
  ComputationalSubstrateInput,
  SubstrateRegistry,
} from "../../../src/modules/capabilities/public";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import { createNodeDigest } from "../../../src/modules/planning/adapters/node-digest";
import { createPlanningSinkAdapter } from "../../../src/modules/planning/adapters/planning-sink-adapter";
import { createSubstrateCatalogAdapter } from "../../../src/modules/planning/adapters/substrate-catalog-adapter";
import { createPlannerService, type PlanningOutcome } from "../../../src/modules/planning/public";
import {
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
} from "../../../src/modules/policies/public";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";

export const generateId = createUuidv7Generator();
export const ACTOR_ID = "00000000-0000-7000-8000-000000000051";

const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");

export interface InMemorySubstrateFederationWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly registry: CapabilityRegistry;
  readonly substrateRegistry: SubstrateRegistry;
  readonly executionService: ExecutionService;
  readonly executionId: string;
  readonly actor: () => { actorId: string; applicationId: string; tenantId: string };
  readonly substrateInput: () => ComputationalSubstrateInput;
  planWithSubstrate(workloadClass: string, kind?: string): Promise<PlanningOutcome>;
}

export async function seedSubstrateWorld(
  db: DatabasePort,
): Promise<InMemorySubstrateFederationWorld> {
  const tenantId = generateId();
  const applicationId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "substrates tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "substrates app"],
  });

  // Policies: the REAL authority (permissive baseline).
  const policyStore = new InMemoryPolicyStore();
  const authority = createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher });
  await authority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });

  // Executions: the REAL service (the ledger the planning decision rides).
  const executionService = createExecutionService({
    store: new SqlExecutionStore(db),
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: (
      await import("../../../src/modules/policies/public")
    ).createExecutionAuthorization(authority),
    generateId,
    now: () => new Date(),
  });

  // Capabilities: the REAL registry + the REAL substrate store.
  const registry = await createCapabilityRegistry({
    store: createInMemoryCatalogStore(),
    seed: [...SEED_CAPABILITY_FACTS],
  });
  const substrateRegistry = createSubstrateRegistry({
    store: new SqlSubstrateStore(db),
    registry,
    digest: sha256Hex,
    generateId,
    now: () => new Date(),
  });

  // The planner with the substrate catalog seam wired.
  const planner = createPlannerService({
    capabilityAuthority: {
      catalogRevision: "rev-1",
      async resolve(profile) {
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
    },
    policyInputs: {
      async effective() {
        return {
          outcome: "allow" as const,
          effective: {},
          policySetId: "default",
          policySetVersion: 1,
          policyContentHash: "hash-1",
          appliedScopes: ["platform"],
        };
      },
    },
    routeExplorer: {
      async explore() {
        return [
          {
            provider: "rail-a",
            model: "model-x",
            satisfies: ["text-generation"],
            expectedCostMicroUsd: "1000",
            expectedQuality: 0.92,
            expectedLatencyMs: 2000,
          },
        ];
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
    sink: createPlanningSinkAdapter(executionService),
    digest: createNodeDigest(),
    generateId,
    now: () => new Date(),
    substrateCatalog: createSubstrateCatalogAdapter(substrateRegistry as never),
  });

  const actor = () => ({ actorId: ACTOR_ID, applicationId, tenantId });

  const substrateInput = (): ComputationalSubstrateInput => ({
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
    description: null,
  });

  let planSeq = 0;
  const world: InMemorySubstrateFederationWorld = {
    db,
    tenantId,
    applicationId,
    registry,
    substrateRegistry: substrateRegistry as never,
    executionService,
    executionId: "",
    actor,
    substrateInput,
    async planWithSubstrate(workloadClass: string, kind = "generation") {
      planSeq += 1;
      const receipt = await executionService.createExecution(
        {
          applicationId,
          task:
            kind === "arithmetic"
              ? { kind, input: { expression: "2+2" } }
              : { kind, input: { text: "artifact-1" } },
        },
        `create-${planSeq}`,
        { actorId: ACTOR_ID, tenantId },
      );
      const executionId = receipt.executionId;
      // The world's executionId tracks the latest planned execution.
      (world as { executionId: string }).executionId = executionId;
      await executionService.transition(
        { actorId: ACTOR_ID, tenantId, applicationId, executionId, command: "authorize" },
        `authorize-${planSeq}`,
      );
      await executionService.transition(
        { actorId: ACTOR_ID, tenantId, applicationId, executionId, command: "plan" },
        `plan-${planSeq}`,
      );
      return planner.planExecution(
        {
          applicationId,
          executionId,
          tenantId,
          actorId: ACTOR_ID,
          task: {
            kind,
            input: kind === "arithmetic" ? { expression: "2+2" } : { text: "artifact-1" },
            workloadClass,
          },
        },
        `plan-exec-${planSeq}`,
      );
    },
  };
  return world;
}
