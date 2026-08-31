/**
 * Shared real-PostgreSQL fixture for the WORK-016 integration suites.
 *
 * Wires the FULL governed substrate over the provider-neutral
 * DatabasePort — the production composition:
 *
 *   * executions: SqlExecutionStore + SqlExecutionsIdempotency + the
 *     execution service with the REAL policy authority behind the
 *     authorize seam;
 *   * agents: SqlAgentStore + the registry + the session service with
 *     the REAL policy admission (createPolicyAgentAdmission) and the
 *     REAL executions ledger adapter;
 *   * the WORK-016 integration: the WorkflowOS submission service and
 *     the BYOA interop over those authorities (the surface under
 *     durable proof);
 *   * benchmarks: the REAL harness + strategies over the same SQL
 *     wiring (durable benchmark evidence: every referenced row is
 *     authoritative platform state).
 */

import { createHash } from "node:crypto";
import {
  type ByoaRegistrationOutcome,
  createByoaAgentProvider,
  createWorkflowOsIntegrationService,
  type IntegrationActor,
  registerByoaAgent,
  type WorkflowOsIntegrationService,
} from "../../../src/integrations/workflowos/public";
import type { AgentRegistry } from "../../../src/modules/agents/application/agent-registry";
import type { AgentSessionService } from "../../../src/modules/agents/application/session-service";
import {
  createAgentExecutionLedgerAdapter,
  createAgentRegistry,
  createAgentSessionService,
  createPolicyAgentAdmission,
  SqlAgentStore,
} from "../../../src/modules/agents/public";
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

const generateId = createUuidv7Generator();

export const INTEGRATION_ACTOR_ID = "00000000-0000-7000-8000-0000000000d1";

export interface IntegrationPgWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly otherTenantId: string;
  readonly otherApplicationId: string;
  readonly executions: ExecutionService;
  readonly registry: AgentRegistry;
  readonly sessions: AgentSessionService;
  readonly policyAuthority: PolicyAuthority;
  readonly workflowos: WorkflowOsIntegrationService;
  readonly actor: IntegrationActor;
  readonly otherTenantActor: IntegrationActor;
  /** Register a BYOA agent through the canonical governed path (SQL). */
  readonly registerByoa: (slug: string, key: string) => Promise<ByoaRegistrationOutcome>;
  /** Drive one execution through the canonical lifecycle to a durable PASS. */
  readonly completeExecution: (executionId: string, keyPrefix: string) => Promise<void>;
}

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export async function seedIntegrationPgWorld(db: DatabasePort): Promise<IntegrationPgWorld> {
  const tenantId = generateId();
  const applicationId = generateId();
  const otherTenantId = generateId();
  const otherApplicationId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "integration tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "integration app"],
  });
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [otherTenantId, `t-${otherTenantId.slice(-6)}`, "other integration tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [
      otherApplicationId,
      otherTenantId,
      `a-${otherApplicationId.slice(-6)}`,
      "other app",
    ],
  });

  // Policies: the REAL authority behind both admission seams (permissive
  // baseline — the SQL rows enforce scope; the policy engine gates).
  const policyStore = new InMemoryPolicyStore();
  const policyAuthority = createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher });
  await policyAuthority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });

  // Executions: the REAL SQL authority.
  const executions = createExecutionService({
    store: new SqlExecutionStore(db),
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: createExecutionAuthorization(policyAuthority),
    generateId,
    now: () => new Date(),
  });

  // Agents: the REAL SQL registry + session service (REAL admission).
  const agentStore = new SqlAgentStore(db);
  const registry = createAgentRegistry({
    store: agentStore,
    generateId,
    now: () => new Date(),
    hashDefinition: sha256Hex,
  });
  const sessions = createAgentSessionService({
    store: agentStore,
    admission: createPolicyAgentAdmission(policyAuthority),
    ledger: createAgentExecutionLedgerAdapter(executions),
    generateId,
    now: () => new Date(),
    hashValue: sha256Hex,
  });

  // The WORK-016 integration surface over the authorities.
  const workflowos = createWorkflowOsIntegrationService({ executions });

  const actor: IntegrationActor = {
    actorId: INTEGRATION_ACTOR_ID,
    applicationId,
    tenantId,
  };
  const otherTenantActor: IntegrationActor = {
    actorId: INTEGRATION_ACTOR_ID,
    applicationId: otherApplicationId,
    tenantId: otherTenantId,
  };

  const registerByoa = (slug: string, key: string): Promise<ByoaRegistrationOutcome> =>
    registerByoaAgent(
      { agents: registry },
      {
        slug,
        name: `BYOA ${slug}`,
        version: "1.0.0",
        instructions: `Standing instruction for ${slug}.`,
        requestedPermissions: { tools: ["search-web"], secretRefs: [], models: [] },
        approvalRequiredActions: [],
        maxAutonomy: "gated",
        maxSessionDurationMs: 600000,
      },
      key,
      { actorId: actor.actorId, applicationId, tenantId },
    );

  const completeExecution = async (executionId: string, keyPrefix: string): Promise<void> => {
    const transitionActor = { actorId: actor.actorId, tenantId };
    for (const command of ["authorize", "plan", "queue", "start", "verify"] as const) {
      await executions.transition(
        { command, applicationId, executionId, ...transitionActor },
        `${keyPrefix}:${command}`,
      );
    }
    await executions.transition(
      {
        command: "pass",
        applicationId,
        executionId,
        ...transitionActor,
        verificationResults: [
          {
            criterionId: "cites-sources",
            strategy: "rubric",
            status: "PASS",
            recordedBy: "pg-verifier-1",
            evidence: ["ev-1"],
          },
        ],
      },
      `${keyPrefix}:pass`,
    );
  };

  return {
    db,
    tenantId,
    applicationId,
    otherTenantId,
    otherApplicationId,
    executions,
    registry,
    sessions,
    policyAuthority,
    workflowos,
    actor,
    otherTenantActor,
    registerByoa,
    completeExecution,
  };
}

/** The deterministic BYOA external agent used by the PG suites. */
export function pgStubExternalAgent() {
  return {
    descriptor: { name: "pg-external-agent", version: "1.0.0" },
    async executeSession(_identity: unknown, task: { inputDigest: string }) {
      return {
        outcomeClass: "session-success" as const,
        outputDigest: `pg-stub:${task.inputDigest}`,
        output: { runtime: "pg-stub" },
        failureReason: null,
      };
    },
  };
}

export { createByoaAgentProvider, generateId };
