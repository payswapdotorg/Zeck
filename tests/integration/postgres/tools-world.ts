/**
 * Shared real-PostgreSQL fixture for the tools suites (WORK-010).
 *
 * Seeds a tenant + application and wires the FULL governed-tool fabric over
 * the provider-neutral DatabasePort — the production composition:
 *
 *   * executions: SqlExecutionStore + SqlExecutionsIdempotency + the
 *     execution service, with the REAL policy authority behind the
 *     authorize seam (createExecutionAuthorization);
 *   * policies: the REAL authority (in-memory definitions + node hasher)
 *     behind the tools admission seam (createPolicyToolAdmission);
 *   * capabilities: the REAL registry (in-memory catalog, seeded with the
 *     platform seeds + the built-in tool facts) behind the capability gate
 *     (createToolCapabilityGate);
 *   * budgets: the REAL budget service (SqlBudgetStore) with configurable
 *     funding behind the BudgetAuthority seam;
 *   * tools: SqlToolInvocationStore + the governed runtime with the
 *     executions ledger adapter (the canonical step-event path).
 */

import {
  SqlBudgetStore,
  SqlBudgetsIdempotency,
} from "../../../src/modules/budgets/adapters/sql-budget-store";
import {
  type BudgetService,
  createBudgetService,
} from "../../../src/modules/budgets/application/budget-service";
import { createInMemoryCatalogStore } from "../../../src/modules/capabilities/adapters/in-memory-catalog-store";
import { SEED_CAPABILITY_FACTS } from "../../../src/modules/capabilities/adapters/seed-catalog";
import { createCapabilityRegistry } from "../../../src/modules/capabilities/application/capability-registry";
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
import { SEED_BUILT_IN_TOOL_FACTS } from "../../../src/modules/tools/adapters/builtins";
import { createToolCapabilityGate } from "../../../src/modules/tools/adapters/capability-gate";
import { createExecutionLedgerAdapter } from "../../../src/modules/tools/adapters/execution-ledger";
import { createPolicyToolAdmission } from "../../../src/modules/tools/adapters/policy-tool-admission";
import { SqlToolInvocationStore } from "../../../src/modules/tools/adapters/sql-tool-store";
import {
  createToolRuntime,
  type ToolRuntime,
} from "../../../src/modules/tools/application/tool-runtime";
import type { ToolContract } from "../../../src/modules/tools/domain/tool";
import type { ToolAdapter } from "../../../src/modules/tools/ports/tool-adapter";
import type { DatabasePort } from "../../../src/platform/db/port";
import { PlatformError } from "../../../src/shared/errors";
import { createUuidv7Generator } from "../../../src/shared/ids";

export const generateId = createUuidv7Generator();
export const ACTOR_ID = "00000000-0000-7000-8000-0000000000aa";

export interface ToolsPgWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly executionService: ExecutionService;
  readonly budgets: BudgetService;
  readonly policyStore: InMemoryPolicyStore;
  readonly policyAuthority: PolicyAuthority;
  readonly runtime: ToolRuntime;
  readonly toolStore: SqlToolInvocationStore;
  readonly registerTool: (contract: ToolContract, adapter: ToolAdapter) => Promise<void>;
  /**
   * The registry map the runtime resolves from (WORK-018: the synthesis
   * world binds synthesized tools into THE single registry — exposed so
   * the runtime and the synthesis service share one admission surface).
   */
  readonly registeredTools: Map<string, { contract: ToolContract; adapter: ToolAdapter }>;
  seedExecution(status?: string): Promise<string>;
  actor(): { actorId: string; tenantId: string };
}

export async function seedToolsWorld(db: DatabasePort): Promise<ToolsPgWorld> {
  const tenantId = generateId();
  const applicationId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "tools tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "tools app"],
  });

  // Policies: the REAL authority behind BOTH seams. A BASELINE permissive
  // set is published so executions can authorize (deny-by-default otherwise);
  // tests publish v2 sets to restrict specific dimensions.
  const policyStore = new InMemoryPolicyStore();
  const authority = createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher });
  await authority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });

  // Executions: full SQL fabric, policy-gated authorize.
  const executionStore = new SqlExecutionStore(db);
  const executionService = createExecutionService({
    store: executionStore,
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: createExecutionAuthorization(authority),
    generateId,
    now: () => new Date(),
  });

  // Capabilities: the REAL registry with platform seeds + built-in tool facts.
  const capabilityRegistry = await createCapabilityRegistry({
    store: createInMemoryCatalogStore(),
    seed: [...SEED_CAPABILITY_FACTS, ...SEED_BUILT_IN_TOOL_FACTS],
  });

  // Budgets: the REAL service (funding configured by the caller).
  const budgets = createBudgetService({
    store: new SqlBudgetStore(db),
    idempotency: new SqlBudgetsIdempotency(db, (tx) => new SqlBudgetStore(tx), generateId),
    generateId,
    now: () => new Date(),
  });

  // Tools: the governed runtime over the durable store + the ledger adapter.
  const toolStore = new SqlToolInvocationStore(db);
  const registered = new Map<string, { contract: ToolContract; adapter: ToolAdapter }>();
  const runtime = createToolRuntime({
    registry: {
      async register() {
        throw new PlatformError({ code: "TOOL_ERROR", message: "world registry is test-managed" });
      },
      async resolve(toolId) {
        return registered.get(toolId) ?? null;
      },
      async listContracts() {
        return [...registered.values()].map((entry) => entry.contract);
      },
    },
    admission: createPolicyToolAdmission(authority),
    capabilities: createToolCapabilityGate(capabilityRegistry),
    budgetAuthority: budgets,
    store: toolStore,
    ledger: createExecutionLedgerAdapter(executionService),
    generateId,
    now: () => new Date(),
    hashInput: (input) => `digest:${JSON.stringify(input)}`,
  });

  const actor = () => ({ actorId: ACTOR_ID, tenantId });

  const world: ToolsPgWorld = {
    db,
    tenantId,
    applicationId,
    executionService,
    budgets,
    policyStore,
    policyAuthority: authority,
    runtime,
    toolStore,
    registeredTools: registered,
    registerTool: async (contract, adapter) => {
      registered.set(contract.toolId, { contract, adapter });
    },
    async seedExecution(status = "RUNNING") {
      const receipt = await executionService.createExecution(
        { applicationId, task: { kind: "summarize", input: "artifact-1" } },
        `create-${generateId()}`,
        actor(),
      );
      const executionId = receipt.executionId;
      if (status !== "CREATED") {
        await executionService.transition(
          { command: "authorize", ...actor(), applicationId, tenantId, executionId },
          `authorize-${generateId()}`,
        );
        if (["PLANNING", "QUEUED", "RUNNING", "WAITING_TOOL", "VERIFYING"].includes(status)) {
          await executionService.transition(
            { command: "plan", ...actor(), applicationId, tenantId, executionId },
            `plan-${generateId()}`,
          );
          await executionService.transition(
            { command: "queue", ...actor(), applicationId, tenantId, executionId },
            `queue-${generateId()}`,
          );
          await executionService.transition(
            { command: "start", ...actor(), applicationId, tenantId, executionId },
            `start-${generateId()}`,
          );
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
  world: ToolsPgWorld,
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
