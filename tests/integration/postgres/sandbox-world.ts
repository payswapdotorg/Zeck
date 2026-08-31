/**
 * Shared real-PostgreSQL fixture for the sandbox suites (WORK-012).
 *
 * Seeds a tenant + application and wires the FULL governed sandbox fabric
 * over the provider-neutral DatabasePort — the production composition:
 *
 *   * executions: SqlExecutionStore + SqlExecutionsIdempotency + the
 *     execution service, with the REAL policy authority behind the
 *     authorize seam (createExecutionAuthorization) — the ledger the
 *     sandbox evidence rides (step events);
 *   * policies: the REAL authority (in-memory definitions + node hasher)
 *     behind the sandbox admission seam (createPolicySandboxAdmission)
 *     and the executions authorize seam;
 *   * capabilities: the REAL registry (in-memory catalog, seeded with the
 *     platform seeds + a container-runtime claim) behind the capability
 *     gate (createSandboxCapabilityGate);
 *   * budgets: the REAL budget service with configurable funding behind
 *     the BudgetAuthority seam (costed environments reserve/settle);
 *   * sandbox: SqlSandboxStore + the environment catalog + the sandbox
 *     service with the REAL admission/capability/ledger adapters and a
 *     configurable provider registry (tests inject the process runtime,
 *     container fakes or nothing — the fail-closed substrate posture).
 */

import { createHash } from "node:crypto";
import {
  SqlBudgetStore,
  SqlBudgetsIdempotency,
} from "../../../src/modules/budgets/adapters/sql-budget-store";
import type { BudgetService } from "../../../src/modules/budgets/application/budget-service";
import { createBudgetService } from "../../../src/modules/budgets/application/budget-service";
import { createInMemoryCatalogStore } from "../../../src/modules/capabilities/adapters/in-memory-catalog-store";
import { SEED_CAPABILITY_FACTS } from "../../../src/modules/capabilities/adapters/seed-catalog";
import { createCapabilityRegistry } from "../../../src/modules/capabilities/application/capability-registry";
import type { CapabilityRegistry } from "../../../src/modules/capabilities/ports/capability-registry";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import {
  createExecutionAuthorization,
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
  type PolicyAuthority,
} from "../../../src/modules/policies/public";
import { createSandboxCapabilityGate } from "../../../src/modules/sandbox/adapters/capability-gate";
import { createSandboxExecutionLedgerAdapter } from "../../../src/modules/sandbox/adapters/execution-ledger";
import { InMemorySandboxStore } from "../../../src/modules/sandbox/adapters/in-memory-sandbox-store";
import { createPolicySandboxAdmission } from "../../../src/modules/sandbox/adapters/policy-sandbox-admission";
import { SqlSandboxStore } from "../../../src/modules/sandbox/adapters/sql-sandbox-store";
import type { EnvironmentCatalog } from "../../../src/modules/sandbox/application/environment-catalog";
import { createEnvironmentCatalog } from "../../../src/modules/sandbox/application/environment-catalog";
import type { SandboxService } from "../../../src/modules/sandbox/application/sandbox-service";
import { createSandboxService } from "../../../src/modules/sandbox/application/sandbox-service";
import type { ComputeEnvironmentSpec } from "../../../src/modules/sandbox/domain/environment";
import type { SandboxProvider } from "../../../src/modules/sandbox/ports/sandbox-provider";
import { createSandboxProviderRegistry } from "../../../src/modules/sandbox/ports/sandbox-provider";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";

export const generateId = createUuidv7Generator();
export const ACTOR_ID = "00000000-0000-7000-8000-0000000000d1";

export const PROCESS_SPEC: ComputeEnvironmentSpec = {
  kind: "process",
  limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
  network: { egress: "none", allowedHosts: [] },
  filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: { capabilityId: "process-sandbox" },
  cost: { estimatedCostMicroUsd: "0" },
};

export const CONTAINER_SPEC: ComputeEnvironmentSpec = {
  kind: "container",
  limits: { cpuMilliCores: 1000, memoryMiB: 256, executionTimeoutMs: 60_000 },
  network: { egress: "allowlist", allowedHosts: ["api.example.com"] },
  filesystem: {
    workspace: "ephemeral-writable",
    readOnlyArtifactRefs: ["artifact-input-1"],
  },
  secrets: { secretRefs: ["conn-customer-api"] },
  runtime: { capabilityId: "container-runtime" },
  cost: { estimatedCostMicroUsd: "0" },
};

export const NO_EXECUTION_SPEC: ComputeEnvironmentSpec = {
  kind: "no-execution",
  limits: null,
  network: { egress: "none", allowedHosts: [] },
  filesystem: { workspace: "none", readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: null,
  cost: { estimatedCostMicroUsd: "0" },
};

export const COSTED_PROCESS_SPEC: ComputeEnvironmentSpec = {
  ...PROCESS_SPEC,
  cost: { estimatedCostMicroUsd: "5000" },
};

export const BASELINE_TASK = {
  command: "python3",
  args: ["analyze.py", "--mode", "batch"],
  publicEnv: { MODE: "batch", LOG_LEVEL: "info" },
};

export interface SandboxPgWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly executionService: ExecutionService;
  readonly budgets: BudgetService;
  readonly policyStore: InMemoryPolicyStore;
  readonly policyAuthority: PolicyAuthority;
  readonly capabilityRegistry: CapabilityRegistry;
  readonly catalog: EnvironmentCatalog;
  readonly service: SandboxService;
  readonly sandboxStore: SqlSandboxStore;
  readonly providers: ReturnType<typeof createSandboxProviderRegistry>;
  readonly registerProvider: (provider: SandboxProvider) => void;
  registerEnvironment(slug: string, spec: ComputeEnvironmentSpec): Promise<string>;
  seedExecution(status?: string): Promise<string>;
  actor(): { actorId: string; applicationId: string; tenantId: string };
}

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export async function seedSandboxWorld(db: DatabasePort): Promise<SandboxPgWorld> {
  const tenantId = generateId();
  const applicationId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "sandbox tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "sandbox app"],
  });

  // Policies: the REAL authority behind BOTH seams. A BASELINE permissive
  // set is published so executions authorize (deny-by-default otherwise);
  // tests publish restricted v2 sets to tighten dimensions (e.g. the
  // container isolation floor).
  const policyStore = new InMemoryPolicyStore();
  const authority = createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher });
  await authority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });

  // Executions: full SQL fabric, policy-gated authorize — the ledger the
  // sandbox evidence rides.
  const executionService = createExecutionService({
    store: new SqlExecutionStore(db),
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: createExecutionAuthorization(authority),
    generateId,
    now: () => new Date(),
  });

  // Capabilities: the REAL registry with platform seeds + a
  // container-runtime claim (the process-sandbox seed ships in the
  // platform catalog; the container substrate claim is published here as
  // the composition wiring a container fleet would provide).
  const capabilityRegistry = await createCapabilityRegistry({
    store: createInMemoryCatalogStore(),
    seed: [...SEED_CAPABILITY_FACTS],
  });
  await capabilityRegistry.publish({
    claim: {
      id: "container-runtime",
      kind: "runtime",
      version: "1.0.0",
      attributes: { isolation: "container", networkEgress: true },
    },
    provenance: { publisher: "sandbox:world", publishedAt: new Date().toISOString() },
    evidence: { kind: "catalog-seeded", reference: "sandbox-world-container-runtime" },
  });

  // Budgets: the REAL service (funding configured by the caller).
  const budgets = createBudgetService({
    store: new SqlBudgetStore(db),
    idempotency: new SqlBudgetsIdempotency(db, (tx) => new SqlBudgetStore(tx), generateId),
    generateId,
    now: () => new Date(),
  });

  // Sandbox: the SQL store + catalog + service with the REAL admission
  // adapter (policy authority), the REAL capability gate and the REAL
  // ledger adapter (executions public service — step events).
  const sandboxStore = new SqlSandboxStore(db);
  const catalog = createEnvironmentCatalog({
    store: sandboxStore,
    generateId,
    now: () => new Date(),
    hashSpec: sha256Hex,
  });
  const providers = createSandboxProviderRegistry();
  const service = createSandboxService({
    store: sandboxStore,
    admission: createPolicySandboxAdmission(authority),
    capabilities: createSandboxCapabilityGate(capabilityRegistry),
    budgetAuthority: budgets,
    ledger: createSandboxExecutionLedgerAdapter(executionService),
    providers,
    generateId,
    now: () => new Date(),
  });

  const actor = () => ({ actorId: ACTOR_ID, applicationId, tenantId });
  const executionActor = () => ({ actorId: ACTOR_ID, tenantId });

  const world: SandboxPgWorld = {
    db,
    tenantId,
    applicationId,
    executionService,
    budgets,
    policyStore,
    policyAuthority: authority,
    capabilityRegistry,
    catalog,
    service,
    sandboxStore,
    providers,
    registerProvider: (provider) => {
      providers.register(provider);
    },
    async registerEnvironment(slug, spec) {
      const record = await catalog.register(
        { applicationId, tenantId, slug, name: slug, spec },
        `env-${slug}`,
        actor(),
      );
      return record.id;
    },
    async seedExecution(status = "RUNNING") {
      const scope = executionActor();
      const receipt = await executionService.createExecution(
        { applicationId, task: { kind: "run-program", input: "artifact-1" } },
        `create-${generateId()}`,
        scope,
      );
      const executionId = receipt.executionId;
      if (status !== "CREATED") {
        await executionService.transition(
          { command: "authorize", actorId: ACTOR_ID, applicationId, tenantId, executionId },
          `authorize-${generateId()}`,
        );
        if (status !== "AUTHORIZED") {
          await executionService.transition(
            { command: "plan", actorId: ACTOR_ID, applicationId, tenantId, executionId },
            `plan-${generateId()}`,
          );
          await executionService.transition(
            { command: "queue", actorId: ACTOR_ID, applicationId, tenantId, executionId },
            `queue-${generateId()}`,
          );
          if (status === "RUNNING") {
            await executionService.transition(
              { command: "start", actorId: ACTOR_ID, applicationId, tenantId, executionId },
              `start-${generateId()}`,
            );
          }
        }
      }
      return executionId;
    },
    actor,
  };
  return world;
}

/** Configure funded developer budgets for the world's application. */
export async function fundApplication(
  world: SandboxPgWorld,
  amountMicroUsd = "1000000",
): Promise<void> {
  const scope = { actorId: ACTOR_ID, applicationId: world.applicationId, tenantId: world.tenantId };
  await world.budgets.configureFundingMode(
    { ...scope, fundingMode: "developer" },
    `fund-${world.applicationId}:mode`,
  );
  await world.budgets.grantCredits(
    { ...scope, ownerKind: "developer", amountMicroUsd },
    `fund-${world.applicationId}:credits`,
  );
}

/** A provider fake that records specs and answers success. */
export class RecordingProvider implements SandboxProvider {
  readonly specs: unknown[] = [];
  constructor(
    readonly runtimeKind: SandboxProvider["runtimeKind"],
    private readonly observation: {
      readonly outcomeClass: "sandbox-success" | "sandbox-failure";
      readonly outputDigest: string | null;
      readonly output: Record<string, unknown> | null;
      readonly usageMicroUsd: string | null;
      readonly failure: { failureClass: string; message: string; retryable: boolean } | null;
    },
  ) {}

  async execute(spec: never) {
    this.specs.push(spec);
    return this.observation as never;
  }
}

export { InMemorySandboxStore };
