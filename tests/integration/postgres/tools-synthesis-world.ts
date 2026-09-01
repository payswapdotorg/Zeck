/**
 * Shared real-PostgreSQL fixture for the tool-synthesis suite (WORK-018).
 *
 * Extends the WORK-010 tools world with the FULL governed synthesis
 * fabric — the production composition:
 *
 *   * the tools world (executions/policies/capabilities/budgets, the
 *     governed tool runtime, the durable invocation store) unchanged;
 *   * the sandbox fabric: SqlSandboxStore + the environment catalog +
 *     the sandbox service with the REAL policy admission
 *     (createPolicySandboxAdmission), the REAL capability gate
 *     (createSandboxCapabilityGate, process-sandbox seeded), the REAL
 *     executions ledger adapter and the REAL process provider — the
 *     same fabric the WORK-012 suites prove;
 *   * the synthesis service: SqlSynthesisStore (migration 0011) + the
 *     synthesis sandbox executor (wrapping the sandbox service; the
 *     runner is the REAL node runtime, `process.execPath`) + THE tool
 *     registry the runtime resolves from (single registry semantics)
 *     + the adapter factory.
 *
 * A process environment ("synthesis-runtime") is registered per world
 * so synthesized programs execute for real under the governed sandbox.
 */

import { createHash } from "node:crypto";
import { createSandboxCapabilityGate } from "../../../src/modules/sandbox/adapters/capability-gate";
import { createSandboxExecutionLedgerAdapter } from "../../../src/modules/sandbox/adapters/execution-ledger";
import { createPolicySandboxAdmission } from "../../../src/modules/sandbox/adapters/policy-sandbox-admission";
import { ProcessSandboxProvider } from "../../../src/modules/sandbox/adapters/process-provider";
import { SqlSandboxStore } from "../../../src/modules/sandbox/adapters/sql-sandbox-store";
import { createEnvironmentCatalog } from "../../../src/modules/sandbox/application/environment-catalog";
import { createSandboxService } from "../../../src/modules/sandbox/application/sandbox-service";
import type { ComputeEnvironmentSpec } from "../../../src/modules/sandbox/domain/environment";
import {
  createSandboxProviderRegistry,
  type EnvironmentCatalog,
  type SandboxService,
} from "../../../src/modules/sandbox/public";
import {
  createSynthesisSandboxExecutor,
  createSynthesizedAdapterFactory,
  SqlSynthesisStore,
} from "../../../src/modules/tools/adapters";
import {
  createSynthesisService,
  type SynthesisService,
  type ToolRegistry,
} from "../../../src/modules/tools/public";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { seedToolsWorld, type ToolsPgWorld } from "./tools-world";

export const synthGenerateId = createUuidv7Generator();

/** The synthesis compute environment: process class, closed network. */
export const SYNTHESIS_PROCESS_SPEC: ComputeEnvironmentSpec = {
  kind: "process",
  limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
  network: { egress: "none", allowedHosts: [] },
  filesystem: { workspace: "none", readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: { capabilityId: "process-sandbox" },
  cost: { estimatedCostMicroUsd: "0" },
};

export interface SynthesisPgWorld extends ToolsPgWorld {
  readonly sandboxService: SandboxService;
  readonly environmentCatalog: EnvironmentCatalog;
  readonly environmentId: string;
  readonly synthesis: SynthesisService;
  /** The single registry the runtime AND the synthesis service share. */
  readonly sharedRegistry: ToolRegistry;
}

export async function seedSynthesisWorld(db: DatabasePort): Promise<SynthesisPgWorld> {
  const toolsWorld = await seedToolsWorld(db);

  // ---- sandbox fabric (the WORK-012 production composition) ----------
  const sandboxStore = new SqlSandboxStore(db);
  const environmentCatalog = createEnvironmentCatalog({
    store: sandboxStore,
    generateId: synthGenerateId,
    now: () => new Date(),
    hashSpec: (canonical: string) => createHash("sha256").update(canonical).digest("hex"),
  });
  const providers = createSandboxProviderRegistry();
  providers.register(new ProcessSandboxProvider());
  const sandboxService = createSandboxService({
    store: sandboxStore,
    admission: createPolicySandboxAdmission(toolsWorld.policyAuthority),
    capabilities: createSandboxCapabilityGate(
      // The tools world's registry is not exported; rebuild the same
      // seeded registry (identical seeds — the WORK-012 pattern).
      await (
        await import("../../../src/modules/capabilities/application/capability-registry")
      ).createCapabilityRegistry({
        store: await (
          await import("../../../src/modules/capabilities/adapters/in-memory-catalog-store")
        ).createInMemoryCatalogStore(),
        seed: (await import("../../../src/modules/capabilities/adapters/seed-catalog"))
          .SEED_CAPABILITY_FACTS,
      }),
    ),
    budgetAuthority: undefined,
    ledger: createSandboxExecutionLedgerAdapter(toolsWorld.executionService),
    providers,
    generateId: synthGenerateId,
    now: () => new Date(),
  });

  const environment = await environmentCatalog.register(
    {
      applicationId: toolsWorld.applicationId,
      tenantId: toolsWorld.tenantId,
      slug: "synthesis-runtime",
      name: "Synthesis runtime",
      spec: SYNTHESIS_PROCESS_SPEC,
    },
    `synth-env-${toolsWorld.applicationId}`,
    {
      actorId: toolsWorld.actor().actorId,
      applicationId: toolsWorld.applicationId,
      tenantId: toolsWorld.tenantId,
    },
  );

  // ---- the synthesis fabric ------------------------------------------
  const synthesisStore = new SqlSynthesisStore(db);
  const executor = createSynthesisSandboxExecutor({
    service: sandboxService,
    catalog: environmentCatalog,
    options: {
      environmentId: environment.id,
      // The REAL node runtime (the sandbox spawns argv without PATH —
      // the absolute runner path is the honest wiring).
      runnerCommand: process.execPath,
    },
  });
  const adapterFactory = createSynthesizedAdapterFactory({
    sandbox: executor,
    store: synthesisStore,
    now: () => new Date(),
  });
  // THE single registry: binding lands exactly where the runtime
  // resolves tools from (the world's exposed registry map).
  const sharedRegistry: ToolRegistry = {
    async register(contract, adapter) {
      const existing = toolsWorld.registeredTools.get(contract.toolId);
      if (existing !== undefined) {
        if (existing.contract.version !== contract.version) {
          return {
            status: "rejected",
            reason: "a different version is already registered for this identity",
          };
        }
        return { status: "converged", toolId: contract.toolId, version: contract.version };
      }
      toolsWorld.registeredTools.set(contract.toolId, { contract, adapter });
      return { status: "registered", toolId: contract.toolId, version: contract.version };
    },
    async resolve(toolId) {
      return toolsWorld.registeredTools.get(toolId) ?? null;
    },
    async listContracts() {
      return [...toolsWorld.registeredTools.values()].map((entry) => entry.contract);
    },
  };
  const synthesis = createSynthesisService({
    store: synthesisStore,
    sandbox: executor,
    registry: sharedRegistry,
    adapterFactory,
    digest: (canonical: string) => createHash("sha256").update(canonical).digest("hex"),
    generateId: synthGenerateId,
    now: () => new Date(),
  });

  return {
    ...toolsWorld,
    sandboxService,
    environmentCatalog,
    environmentId: environment.id,
    synthesis,
    sharedRegistry,
  };
}
