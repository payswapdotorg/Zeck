/**
 * Shared real-PostgreSQL fixture for the agents suites (WORK-011).
 *
 * Seeds a tenant + application and wires the FULL governed agent fabric
 * over the provider-neutral DatabasePort — the production composition:
 *
 *   * executions: SqlExecutionStore + SqlExecutionsIdempotency + the
 *     execution service, with the REAL policy authority behind the
 *     authorize seam (createExecutionAuthorization) — the ledger the
 *     agent evidence rides (step events + wait-human/resume gates);
 *   * policies: the REAL authority (in-memory definitions + node hasher)
 *     behind the agents admission seam (createPolicyAgentAdmission) and
 *     the executions authorize seam;
 *   * agents: SqlAgentStore + the registry + the session service with
 *     the REAL admission adapter and the executions ledger adapter;
 *   * a configurable AgentProvider registration (tests inject fakes —
 *     local/customer-hosted/hosted runtimes ride the same seam).
 */

import { createHash } from "node:crypto";
import type { AgentRegistry } from "../../../src/modules/agents/application/agent-registry";
import type { AgentSessionService } from "../../../src/modules/agents/application/session-service";
import type { AgentDefinition } from "../../../src/modules/agents/domain/agent-version";
import type { AgentProvider } from "../../../src/modules/agents/ports/agent-provider";
import {
  createAgentExecutionLedgerAdapter,
  createAgentRegistry,
  createAgentSessionService,
  createPolicyAgentAdmission,
  SqlAgentStore,
} from "../../../src/modules/agents/public";
import {
  SqlBudgetStore,
  SqlBudgetsIdempotency,
} from "../../../src/modules/budgets/adapters/sql-budget-store";
import {
  type BudgetService,
  createBudgetService,
} from "../../../src/modules/budgets/application/budget-service";
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
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";

export const generateId = createUuidv7Generator();
export const ACTOR_ID = "00000000-0000-7000-8000-0000000000c1";
export const HUMAN_APPROVER_ID = "00000000-0000-7000-8000-0000000000c2";

export const BASELINE_DEFINITION: AgentDefinition = {
  instructions: "Triage the inbox and draft replies.",
  requestedPermissions: {
    tools: ["search-web"],
    secretRefs: ["conn-customer-api"],
  },
  approvalRequiredActions: ["external-send"],
  isolation: "container",
  maxAutonomy: "gated",
  maxSessionDurationMs: 600000,
};

export interface AgentsPgWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly executionService: ExecutionService;
  readonly budgets: BudgetService;
  readonly policyStore: InMemoryPolicyStore;
  readonly policyAuthority: PolicyAuthority;
  readonly registry: AgentRegistry;
  readonly service: AgentSessionService;
  readonly agentStore: SqlAgentStore;
  readonly registerProvider: (provider: AgentProvider) => void;
  readonly providerFor: (runtimeKind: string) => AgentProvider | null;
  /** Register the baseline agent + version and promote it (available). */
  registerBaselineAgent(slug?: string, definition?: AgentDefinition): Promise<string>;
  /** Seed an execution through the REAL executions service (RUNNING). */
  seedExecution(status?: string): Promise<string>;
  actor(): { actorId: string; applicationId: string; tenantId: string };
  human(): { actorId: string; applicationId: string; tenantId: string };
}

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export async function seedAgentsWorld(db: DatabasePort): Promise<AgentsPgWorld> {
  const tenantId = generateId();
  const applicationId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "agents tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "agents app"],
  });

  // Policies: the REAL authority behind BOTH seams. A baseline permissive
  // set is published so executions authorize (deny-by-default otherwise);
  // tests publish restricted v2 sets to tighten dimensions.
  const policyStore = new InMemoryPolicyStore();
  const authority = createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher });
  await authority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });

  // Executions: full SQL fabric, policy-gated authorize — the ledger the
  // agent evidence and approval gates ride.
  const executionService = createExecutionService({
    store: new SqlExecutionStore(db),
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: createExecutionAuthorization(authority),
    generateId,
    now: () => new Date(),
  });

  // Budgets: the REAL service (available for future wiring; the agents
  // module itself consults no budget authority — dispatch-level budgeting
  // stays at the tools/models seams).
  const budgets = createBudgetService({
    store: new SqlBudgetStore(db),
    idempotency: new SqlBudgetsIdempotency(db, (tx) => new SqlBudgetStore(tx), generateId),
    generateId,
    now: () => new Date(),
  });

  // Agents: the SQL store + registry + session service with the REAL
  // admission adapter (policy authority) and the REAL ledger adapter
  // (executions public service — step events + wait-human/resume).
  const agentStore = new SqlAgentStore(db);
  const registry = createAgentRegistry({
    store: agentStore,
    generateId,
    now: () => new Date(),
    hashDefinition: sha256Hex,
  });
  const service = createAgentSessionService({
    store: agentStore,
    admission: createPolicyAgentAdmission(authority),
    ledger: createAgentExecutionLedgerAdapter(executionService),
    generateId,
    now: () => new Date(),
    hashValue: sha256Hex,
  });

  const providers = new Map<string, AgentProvider>();

  const actor = () => ({ actorId: ACTOR_ID, applicationId, tenantId });
  const human = () => ({ actorId: HUMAN_APPROVER_ID, applicationId, tenantId });
  const executionActor = () => ({ actorId: ACTOR_ID, tenantId });

  const world: AgentsPgWorld = {
    db,
    tenantId,
    applicationId,
    executionService,
    budgets,
    policyStore,
    policyAuthority: authority,
    registry,
    service,
    agentStore,
    registerProvider: (provider) => {
      providers.set(provider.runtimeKind, provider);
    },
    providerFor: (runtimeKind) => providers.get(runtimeKind) ?? null,
    async registerBaselineAgent(slug = "triage", definition = BASELINE_DEFINITION) {
      const agent = await registry.registerAgent(
        { applicationId, tenantId, slug, name: "Triage Agent" },
        `register-${slug}`,
        actor(),
      );
      const version = await registry.publishVersion(
        { agentId: agent.id, version: "1.0.0", definition },
        `publish-${slug}`,
        actor(),
      );
      await registry.promote(
        { agentId: agent.id, targetVersionId: version.id },
        `promote-${slug}`,
        actor(),
      );
      return agent.id;
    },
    async seedExecution(status = "RUNNING") {
      const scope = executionActor();
      const receipt = await executionService.createExecution(
        { applicationId, task: { kind: "triage", input: "inbox-1" } },
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
    human,
  };
  return world;
}
