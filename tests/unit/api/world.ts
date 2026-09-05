/**
 * Shared in-memory fixture for the public API suites (WORK-015).
 *
 * Wires the REAL Fastify server over REAL module surfaces (in-memory
 * variants — the real-PostgreSQL variants live in
 * tests/integration/postgres/api-*.test.ts):
 *  - executions: the REAL execution service over the in-memory store
 *    (policy-authorized creates, real transitions);
 *  - agents: a recording FAKE registry (the read surface the routes
 *    project — mutation attempts are recorded and asserted absent);
 *  - auth: the REAL scope resolver over a fake identity store with
 *    seeded membership rows (server-side tenant derivation);
 *  - transport auth: a bearer-token map (the injectable credential
 *    seam).
 */

import type { FastifyRequest } from "fastify";
import { type ApiServer, createApiServer } from "../../../src/api";
import type {
  AgentRecord,
  AgentRegistry,
  AgentSelectionRecord,
  AgentVersionRecord,
} from "../../../src/modules/agents/public";
import type { IdentityStore, MembershipRecord } from "../../../src/modules/auth/public";
import { createScopeResolver, type ScopeResolver } from "../../../src/modules/auth/public";
import {
  createCapabilityRegistry,
  createInMemoryCatalogStore,
} from "../../../src/modules/capabilities/public";
import {
  createCapabilityEconomicAdmission,
  createEconomicActionService,
  createPolicyEconomicAdmission,
  type EconomicActionService,
  InMemoryEconomicStore,
  InMemoryEconomicsIdempotency,
} from "../../../src/modules/economics/public";
import type { ExecutionService } from "../../../src/modules/executions/application/execution-service";
import type { ExecutionCreateInput } from "../../../src/modules/executions/domain/execution";
import type { ExecutionAuthorizationPort } from "../../../src/modules/executions/ports/authorization";
import {
  createInMemoryOpportunityStore,
  createNodeDigest,
  createOpportunityAnalyzer,
  type InMemoryOpportunityStore,
  type OpportunityAnalyzer,
} from "../../../src/modules/learning/public";
import {
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
} from "../../../src/modules/policies/public";
import { PlatformError } from "../../../src/shared/errors";
import { createInMemoryExecutions } from "../executions/fakes";

export const ACTOR_ID = "00000000-0000-7000-8000-0000000000aa";
export const OTHER_TENANT_ACTOR_ID = "00000000-0000-7000-8000-0000000000cc";

export interface ApiWorld {
  readonly server: ApiServer;
  readonly applicationId: string;
  readonly otherTenantApplicationId: string;
  readonly tenantId: string;
  readonly otherTenantId: string;
  readonly executions: ExecutionService;
  readonly agentRegistry: FakeAgentRegistry;
  readonly economics: EconomicActionService;
  readonly codebaseAnalyzer: OpportunityAnalyzer;
  /** The analyzer's in-memory store (WORK-022 discrimination probes). */
  readonly opportunityStore: InMemoryOpportunityStore;
  /** The executions world's budget-authority fake call counts (M6 probes). */
  readonly budgetReserveCalls: () => number;
  readonly bearerToken: string;
  readonly otherTenantToken: string;
  readonly authenticateCalls: () => number;
}

/** The read-only agent registry the routes project (mutation-recording). */
export class FakeAgentRegistry implements AgentRegistry {
  readonly agents = new Map<string, AgentRecord>();
  readonly versions = new Map<string, AgentVersionRecord[]>();
  readonly selections = new Map<string, AgentSelectionRecord[]>();
  readonly mutationAttempts: string[] = [];

  private nextId = 0;

  private id(): string {
    this.nextId += 1;
    return `00000000-0000-7000-a000-${String(this.nextId).padStart(12, "0")}`;
  }

  seedAgent(
    applicationId: string,
    tenantId: string,
    slug: string,
  ): { agentId: string; versionId: string } {
    const agentId = this.id();
    const versionId = this.id();
    const now = "2026-09-15T12:00:00Z";
    this.agents.set(`${applicationId}:${agentId}`, {
      id: agentId,
      applicationId,
      tenantId,
      slug,
      name: `agent ${slug}`,
      description: null,
      status: "available",
      createdAt: now,
      updatedAt: now,
    });
    this.versions.set(`${applicationId}:${agentId}`, [
      {
        id: versionId,
        applicationId,
        tenantId,
        agentId,
        version: "1.0.0",
        definition: {
          instructions: "do the thing",
          requestedPermissions: { tools: [], network: "none", secrets: [] } as never,
          approvalRequiredActions: [],
          isolation: "process" as never,
          maxAutonomy: "supervised" as never,
          maxSessionDurationMs: 60000,
        },
        definitionDigest: `digest-${versionId.slice(-6)}`,
        validationState: "valid",
        validationNotes: null,
        createdAt: now,
      },
    ]);
    this.selections.set(`${applicationId}:${agentId}`, [
      {
        id: this.id(),
        applicationId,
        tenantId,
        agentId,
        selectedVersionId: versionId,
        kind: "initial",
        rollbackOf: null,
        selectedBy: "seeder",
        reason: null,
        selectedAt: now,
      },
    ]);
    return { agentId, versionId };
  }

  async registerAgent(): Promise<AgentRecord> {
    this.mutationAttempts.push("registerAgent");
    throw new Error("the public API surface never mutates agent authority (M14/M15)");
  }
  async publishVersion(): Promise<AgentVersionRecord> {
    this.mutationAttempts.push("publishVersion");
    throw new Error("the public API surface never mutates agent authority (M14/M15)");
  }
  async promote(): Promise<AgentSelectionRecord> {
    this.mutationAttempts.push("promote");
    throw new Error("the public API surface never mutates agent authority (M14/M15)");
  }
  async rollback(): Promise<AgentSelectionRecord> {
    this.mutationAttempts.push("rollback");
    throw new Error("the public API surface never mutates agent authority (M14/M15)");
  }
  async suspend(): Promise<AgentRecord> {
    this.mutationAttempts.push("suspend");
    throw new Error("the public API surface never mutates agent authority (M14/M15)");
  }
  async resume(): Promise<AgentRecord> {
    this.mutationAttempts.push("resume");
    throw new Error("the public API surface never mutates agent authority (M14/M15)");
  }
  async retire(): Promise<AgentRecord> {
    this.mutationAttempts.push("retire");
    throw new Error("the public API surface never mutates agent authority (M14/M15)");
  }
  async getAgent(applicationId: string, agentId: string): Promise<AgentRecord | null> {
    return this.agents.get(`${applicationId}:${agentId}`) ?? null;
  }
  async getAgentBySlug(applicationId: string, slug: string): Promise<AgentRecord | null> {
    for (const agent of this.agents.values()) {
      if (agent.applicationId === applicationId && agent.slug === slug) {
        return agent;
      }
    }
    return null;
  }
  async listVersions(
    applicationId: string,
    agentId: string,
  ): Promise<readonly AgentVersionRecord[]> {
    return this.versions.get(`${applicationId}:${agentId}`) ?? [];
  }
  async listSelections(
    applicationId: string,
    agentId: string,
  ): Promise<readonly AgentSelectionRecord[]> {
    return this.selections.get(`${applicationId}:${agentId}`) ?? [];
  }
  async currentSelection(
    applicationId: string,
    agentId: string,
  ): Promise<AgentSelectionRecord | null> {
    const list = this.selections.get(`${applicationId}:${agentId}`) ?? [];
    return list.length === 0 ? null : (list[list.length - 1] ?? null);
  }
}

function fakeIdentityStore(
  memberships: readonly {
    readonly actorId: string;
    readonly applicationId: string;
    readonly tenantId: string;
  }[],
): IdentityStore {
  const notImplemented = (name: string) => () => {
    throw new Error(`not implemented in fake: ${name}`);
  };
  const rows = new Map(
    memberships.map((m) => [
      `${m.actorId}:${m.applicationId}`,
      { membership: m as unknown as MembershipRecord, applicationTenantId: m.tenantId },
    ]),
  );
  return {
    provisionActor: notImplemented("provisionActor") as never,
    findActor: (async () => null) as never,
    findMembershipWithApplicationTenant: (async (actorId: string, applicationId: string) =>
      rows.get(`${actorId}:${applicationId}`) ?? null) as never,
    findTenantMembership: (async () => null) as never,
    listMemberships: (async () => []) as never,
    insertMembership: notImplemented("insertMembership") as never,
    updateMembershipRole: notImplemented("updateMembershipRole") as never,
    deleteMembership: notImplemented("deleteMembership") as never,
    lockApplicationMemberships: (async () => []) as never,
  };
}

let appCounter = 0;

export interface SeedApiWorldOptions {
  /** An executions admission seam override (WORK-022 discrimination: the deny-wiring for the policy-denial red records). */
  readonly executionAuthorization?: ExecutionAuthorizationPort;
}

export async function seedApiWorld(options: SeedApiWorldOptions = {}): Promise<ApiWorld> {
  appCounter += 1;
  const tenantId = `00000000-0000-7000-8000-00000000a${String(appCounter).padStart(3, "0")}`;
  const applicationId = `00000000-0000-7000-8000-00000000b${String(appCounter).padStart(3, "0")}`;
  const otherTenantId = "00000000-0000-7000-8000-0000000000cc";
  const otherTenantApplicationId = "00000000-0000-7000-8000-0000000000dd";
  const bearerToken = `zeck-token-${appCounter}`;
  const otherTenantToken = `zeck-token-other-${appCounter}`;

  const scopeResolver: ScopeResolver = createScopeResolver(
    fakeIdentityStore([
      { actorId: ACTOR_ID, applicationId, tenantId },
      {
        actorId: OTHER_TENANT_ACTOR_ID,
        applicationId: otherTenantApplicationId,
        tenantId: otherTenantId,
      },
    ]),
  );

  let authenticateCalls = 0;
  const tokens = new Map<string, string>([
    [bearerToken, ACTOR_ID],
    [otherTenantToken, OTHER_TENANT_ACTOR_ID],
  ]);
  const authenticate = async (request: FastifyRequest) => {
    authenticateCalls += 1;
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw new PlatformError({
        code: "AUTHENTICATION_FAILED",
        message: "missing bearer credential (expected: Authorization: Bearer <token>)",
      });
    }
    const token = header.slice("Bearer ".length).trim();
    const actorId = tokens.get(token);
    if (actorId === undefined) {
      throw new PlatformError({ code: "AUTHENTICATION_FAILED", message: "invalid credential" });
    }
    return { actorId, authenticatedAt: new Date().toISOString() };
  };

  const executionsWorld = createInMemoryExecutions({
    ...(options.executionAuthorization === undefined
      ? {}
      : { authorization: options.executionAuthorization }),
  });
  executionsWorld.store.seedApplication(applicationId, tenantId);
  executionsWorld.store.seedApplication(otherTenantApplicationId, otherTenantId);
  const executions = executionsWorld.service;

  // Economics: the REAL economic-action service over the in-memory store
  // (the authority the routes delegate to). The admission seams are REAL:
  // policy delegates to the REAL in-memory policy authority (default
  // platform policy, as in the executions world), capabilities to the REAL
  // registry over an in-memory catalog; the budgets seam is the world's
  // recording fake (the API surface creates intents and reads outcomes —
  // reserve/settle stay exercised by the economics suites' own worlds).
  const policyAuthority = createPolicyAuthority({
    store: new InMemoryPolicyStore(),
    hasher: nodePolicyHasher,
  });
  await policyAuthority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });
  const capabilityRegistry = await createCapabilityRegistry({
    store: createInMemoryCatalogStore(),
  });
  const economicStore = new InMemoryEconomicStore();
  const economics = createEconomicActionService({
    store: economicStore,
    idempotency: new InMemoryEconomicsIdempotency(economicStore),
    policy: createPolicyEconomicAdmission(policyAuthority),
    capabilities: createCapabilityEconomicAdmission(capabilityRegistry),
    budget: executionsWorld.budgets.impl,
    executions,
    generateId: executionsWorld.generateId,
    now: () => new Date(),
  });

  const agentRegistry = new FakeAgentRegistry();

  // The codebase-opportunity ADVISORY analyzer (WORK-022): the REAL
  // learning-module analyzer over the in-memory opportunity store
  // (advisory evidence only — never an authority).
  let analyzeCounter = 0;
  const opportunityStore = createInMemoryOpportunityStore();
  const codebaseAnalyzer = createOpportunityAnalyzer({
    store: opportunityStore,
    digest: createNodeDigest(),
    generateId: () => `00000000-0000-7000-b000-${String(++analyzeCounter).padStart(12, "0")}`,
    now: () => new Date(),
  });

  const server = createApiServer({
    executions,
    agents: agentRegistry,
    economics,
    codebaseAnalyzer,
    scopeResolver,
    authenticate,
    dependencyReadiness: async () => [],
    listAgentIdsOfApplication: async (appId) =>
      [...agentRegistry.agents.values()]
        .filter((agent) => agent.applicationId === appId)
        .map((agent) => agent.id),
  });

  return {
    server,
    applicationId,
    otherTenantApplicationId,
    tenantId,
    otherTenantId,
    executions,
    agentRegistry,
    economics,
    codebaseAnalyzer,
    opportunityStore,
    budgetReserveCalls: () => executionsWorld.budgets.reserveCalls.length,
    bearerToken,
    otherTenantToken,
    authenticateCalls: () => authenticateCalls,
  };
}

/** Standard create-request body for the world's application. */
export function createBody(
  world: ApiWorld,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    applicationId: world.applicationId,
    task: { kind: "summarize", input: "artifact-1" },
    ...over,
  };
}

/** The standard headers (auth + application scope). */
export function authHeaders(world: ApiWorld): Record<string, string> {
  return {
    authorization: `Bearer ${world.bearerToken}`,
    "content-type": "application/json",
    "x-zeck-application": world.applicationId,
  };
}

/** The other tenant's headers (the cross-tenant caller). */
export function otherTenantHeaders(world: ApiWorld): Record<string, string> {
  return {
    authorization: `Bearer ${world.otherTenantToken}`,
    "content-type": "application/json",
    "x-zeck-application": world.otherTenantApplicationId,
  };
}

/** A helper creating a valid execution directly through the service. */
export async function seedExecution(world: ApiWorld, key: string): Promise<string> {
  const input: ExecutionCreateInput = {
    applicationId: world.applicationId,
    task: { kind: "summarize", input: "artifact-1" },
  };
  const receipt = await world.executions.createExecution(input, key, {
    actorId: ACTOR_ID,
    tenantId: world.tenantId,
  });
  return receipt.executionId;
}
