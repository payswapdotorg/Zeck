/**
 * Shared real-PostgreSQL fixture for the public API suites (WORK-015).
 *
 * Wires the REAL Fastify server over the REAL SQL fabric:
 *  - executions: SqlExecutionStore + SqlExecutionsIdempotency + the
 *    execution service (the authority the routes delegate to);
 *  - agents: the REAL agent registry over SqlAgentStore + the REAL
 *    policy admission (the inventory the routes project);
 *  - auth: the REAL scope resolver over a real membership row (server-
 *    side tenant derivation from durable state);
 *  - transport auth: a bearer-token map (the injectable seam).
 *
 * Every request goes through fastify.inject — REAL route/handler/
 * serialization execution. Real HTTP semantics without sockets.
 */

import { createHash } from "node:crypto";
import { type ApiServer, createApiServer } from "../../../src/api";
import { SqlAgentStore } from "../../../src/modules/agents/adapters/sql-agent-store";
import {
  type AgentRegistry,
  createAgentRegistry,
} from "../../../src/modules/agents/application/agent-registry";
import { createScopeResolver, type ScopeResolver } from "../../../src/modules/auth/public";
import type { BudgetAuthority } from "../../../src/modules/budgets/public";
import {
  createCapabilityRegistry,
  createInMemoryCatalogStore,
} from "../../../src/modules/capabilities/public";
import {
  createCapabilityEconomicAdmission,
  createEconomicActionService,
  createPolicyEconomicAdmission,
  createSqlEconomicsModule,
  type EconomicActionService,
} from "../../../src/modules/economics/public";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import {
  createNodeDigest,
  createOpportunityAnalyzer,
  type OpportunityAnalyzer,
  SqlOpportunityStore,
} from "../../../src/modules/learning/public";
import {
  createExecutionAuthorization,
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
  type PolicyAuthority,
} from "../../../src/modules/policies/public";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";

let actorCounter = 0;

export interface ApiPgWorld {
  readonly server: ApiServer;
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly otherTenantId: string;
  readonly otherApplicationId: string;
  readonly executions: ExecutionService;
  readonly agents: AgentRegistry;
  readonly economics: EconomicActionService;
  readonly codebaseAnalyzer: OpportunityAnalyzer;
  /** The REAL policy authority behind the executions authorize seam (WORK-022 denial probes). */
  readonly policyAuthority: PolicyAuthority;
  readonly bearerToken: string;
  readonly otherBearerToken: string;
  readonly actorId: string;
  readonly seedExecution: (key: string) => Promise<string>;
  readonly seedAgent: (slug: string) => Promise<{ agentId: string; versionId: string }>;
}

export async function seedApiPgWorld(db: DatabasePort): Promise<ApiPgWorld> {
  const generateId = createUuidv7Generator();
  const tenantId = generateId();
  const applicationId = generateId();
  const otherTenantId = generateId();
  const otherApplicationId = generateId();
  const bearerToken = `zeck-token-${generateId()}`;
  const otherBearerToken = `zeck-token-${generateId()}`;
  actorCounter += 1;
  const actorId = `00000000-0000-7000-8000-${String(actorCounter).padStart(4, "0")}${generateId().slice(-8)}`;

  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "api tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "api app"],
  });
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [otherTenantId, `t-${otherTenantId.slice(-6)}`, "other tenant"],
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
  // Real membership rows (the durable ownership the scope resolver reads).
  await db.execute({
    sql: `INSERT INTO identity.actors (id, display_name) VALUES ($1, $2)`,
    parameters: [actorId, "api actor"],
  });
  await db.execute({
    sql: `INSERT INTO identity.memberships (id, actor_id, application_id, tenant_id, role)
          VALUES ($1, $2, $3, $4, 'owner')`,
    parameters: [generateId(), actorId, applicationId, tenantId],
  });
  const otherActorId = generateId();
  await db.execute({
    sql: `INSERT INTO identity.actors (id, display_name) VALUES ($1, $2)`,
    parameters: [otherActorId, "other actor"],
  });
  await db.execute({
    sql: `INSERT INTO identity.memberships (id, actor_id, application_id, tenant_id, role)
          VALUES ($1, $2, $3, $4, 'owner')`,
    parameters: [generateId(), otherActorId, otherApplicationId, otherTenantId],
  });

  // The scope resolver over the REAL identity tables.
  const identityStore = {
    findMembershipWithApplicationTenant: (async (actorId: string, appId: string) => {
      const result = await db.execute<{
        membership_id: string;
        actor_id: string;
        application_id: string;
        tenant_id: string;
        role: string;
        created_at: Date;
        application_tenant_id: string;
      }>({
        sql: `SELECT m.id AS membership_id, m.actor_id, m.application_id, m.tenant_id, m.role,
                     m.created_at, a.tenant_id AS application_tenant_id
              FROM identity.memberships m
              JOIN applications.applications a ON a.id = m.application_id
              WHERE m.actor_id = $1 AND m.application_id = $2`,
        parameters: [actorId, appId],
      });
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        membership: {
          id: row.membership_id,
          actorId: row.actor_id,
          applicationId: row.application_id,
          tenantId: row.tenant_id,
          role: row.role,
          createdAt: row.created_at.toISOString(),
        },
        applicationTenantId: row.application_tenant_id,
      };
    }) as never,
  };
  const notImplemented = (name: string) => () => {
    throw new Error(`not implemented in api world: ${name}`);
  };
  const identityStoreFull = {
    provisionActor: notImplemented("provisionActor"),
    findActor: (async () => null) as never,
    findMembershipWithApplicationTenant: identityStore.findMembershipWithApplicationTenant,
    findTenantMembership: (async () => null) as never,
    listMemberships: (async () => []) as never,
    insertMembership: notImplemented("insertMembership"),
    updateMembershipRole: notImplemented("updateMembershipRole"),
    deleteMembership: notImplemented("deleteMembership"),
    lockApplicationMemberships: (async () => []) as never,
  };
  const scopeResolver: ScopeResolver = createScopeResolver(identityStoreFull);

  // Policies: the REAL authority behind the executions authorize seam.
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

  // Agents: the REAL registry over the SQL store.
  const agents = createAgentRegistry({
    store: new SqlAgentStore(db),
    generateId,
    now: () => new Date(),
    hashDefinition: (canonicalJson: string) =>
      createHash("sha256").update(canonicalJson, "utf8").digest("hex"),
  });

  // Economics: the REAL economic-action authority over the SQL fabric
  // (migration 0014) with REAL admission seams (the policy authority
  // above; the REAL capability registry over an in-memory catalog). The
  // budgets seam is a typed fail-closed stub: this world exercises the
  // economic-action API surface (intent creation + outcome reads); the
  // reserve/settle chain is proven against the REAL budgets authority in
  // the economics suites' own PostgreSQL worlds.
  const budgetStub = (operation: string): never => {
    throw new Error(`budget ${operation} is not exercised in the api world`);
  };
  const budgetSeam: BudgetAuthority = {
    reserve: async () => budgetStub("reserve"),
    settle: async () => budgetStub("settle"),
    release: async () => budgetStub("release"),
  };
  const capabilityRegistry = await createCapabilityRegistry({
    store: createInMemoryCatalogStore(),
  });
  const { store: economicStore, idempotency: economicIdempotency } = createSqlEconomicsModule(
    db,
    generateId,
  );
  const economics = createEconomicActionService({
    store: economicStore,
    idempotency: economicIdempotency,
    policy: createPolicyEconomicAdmission(policyAuthority),
    capabilities: createCapabilityEconomicAdmission(capabilityRegistry),
    budget: budgetSeam,
    executions,
    generateId,
    now: () => new Date(),
  });

  const tokens = new Map<string, string>([
    [bearerToken, actorId],
    [otherBearerToken, otherActorId],
  ]);
  const authenticate = async (request: { readonly headers: Record<string, unknown> }) => {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw Object.assign(new Error("missing bearer credential"), { statusCode: 401 });
    }
    const actorId = tokens.get(header.slice("Bearer ".length).trim());
    if (actorId === undefined) {
      throw Object.assign(new Error("invalid credential"), { statusCode: 401 });
    }
    return { actorId, authenticatedAt: new Date().toISOString() };
  };

  // The codebase-opportunity ADVISORY analyzer over the REAL SQL
  // opportunity store (migration 0016; WORK-022 — advisory evidence
  // only, never an authority).
  const codebaseAnalyzer = createOpportunityAnalyzer({
    store: new SqlOpportunityStore(db),
    digest: createNodeDigest(),
    generateId,
    now: () => new Date(),
  });

  const server = createApiServer({
    executions,
    agents,
    economics,
    codebaseAnalyzer,
    scopeResolver,
    authenticate,
    dependencyReadiness: async () => [],
    // The inventory enumeration seam over the real agents table.
    listAgentIdsOfApplication: async (appId) => {
      const result = await db.execute<{ id: string }>({
        sql: `SELECT id FROM agents.agents WHERE application_id = $1 ORDER BY created_at ASC`,
        parameters: [appId],
      });
      return result.rows.map((row) => row.id);
    },
  });

  const world: ApiPgWorld = {
    server,
    db,
    tenantId,
    applicationId,
    otherTenantId,
    otherApplicationId,
    executions,
    agents,
    economics,
    codebaseAnalyzer,
    policyAuthority,
    bearerToken,
    otherBearerToken,
    actorId,
    async seedExecution(key) {
      const receipt = await executions.createExecution(
        { applicationId, task: { kind: "summarize", input: "artifact-1" } },
        key,
        { actorId: actorId, tenantId },
      );
      return receipt.executionId;
    },
    async seedAgent(slug) {
      const record = await agents.registerAgent(
        {
          applicationId,
          tenantId,
          slug,
          name: `agent ${slug}`,
          description: "seeded agent",
        },
        `seed-agent-${slug}`,
        { actorId: actorId, applicationId, tenantId },
      );
      const version = await agents.publishVersion(
        {
          agentId: record.id,
          version: "1.0.0",
          definition: {
            instructions: "do the thing",
            requestedPermissions: {
              tools: [],
              secretRefs: [],
            },
            approvalRequiredActions: [],
            isolation: "process",
            maxAutonomy: "none",
            maxSessionDurationMs: 60000,
          },
        },
        `seed-version-${slug}`,
        { actorId: actorId, applicationId, tenantId },
      );
      await agents.promote(
        {
          agentId: record.id,
          targetVersionId: version.id,
          reason: "seed promotion",
        },
        `seed-promote-${slug}`,
        { actorId: actorId, applicationId, tenantId },
      );
      return { agentId: record.id, versionId: version.id };
    },
  };
  return world;
}

export function authHeaders(world: ApiPgWorld): Record<string, string> {
  return {
    authorization: `Bearer ${world.bearerToken}`,
    "content-type": "application/json",
    "x-zeck-application": world.applicationId,
  };
}

export function otherTenantHeaders(world: ApiPgWorld): Record<string, string> {
  return {
    authorization: `Bearer ${world.otherBearerToken}`,
    "content-type": "application/json",
    "x-zeck-application": world.otherApplicationId,
  };
}
