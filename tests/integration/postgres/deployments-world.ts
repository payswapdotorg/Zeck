/**
 * Shared real-PostgreSQL fixture for the deployment-fabric suite
 * (WORK-023).
 *
 * Provisions a tenant + application + environment through the
 * applications module's REAL SQL store, registers an agent + a valid
 * version + selection through the agents module's REAL registry, and
 * wires the deployment fabric over the provider-neutral DatabasePort:
 *
 *   * deployments: SqlDeploymentStore (migration 0012) + the
 *     deployment service with the REAL agents inventory adapter (the
 *     agents public registry) and the REAL SQL environment resolver
 *     (the executions-store read-only precedent);
 *   * modality adapters: provider-neutral test adapters registered
 *     into the REAL adapter registry (no vendor rails — the
 *     WORK-024/025/026 seam);
 *   * executions: the REAL execution service (the journal's execution
 *     provenance references real executions).
 */

import { createHash } from "node:crypto";
import { SqlAgentStore } from "../../../src/modules/agents/adapters/sql-agent-store";
import { createAgentRegistry, InMemoryAgentStore } from "../../../src/modules/agents/public";
import type {
  DeploymentPlanInput,
  DeploymentProfileInput,
  DeploymentService,
} from "../../../src/modules/deployments/public";
import {
  createAgentInventoryAdapter,
  createDeploymentService,
  createModalityAdapterRegistry,
  createSqlEnvironmentResolver,
  InMemoryDeploymentStore,
  SqlDeploymentStore,
} from "../../../src/modules/deployments/public";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import {
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
} from "../../../src/modules/policies/public";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";

export const generateId = createUuidv7Generator();
export const ACTOR_ID = "00000000-0000-7000-8000-0000000000f1";

const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");

const BASELINE_DEFINITION = {
  instructions: "Support triage agent",
  requestedPermissions: { tools: [], secretRefs: [] },
  approvalRequiredActions: [],
  isolation: "process",
  maxAutonomy: "supervised",
  maxSessionDurationMs: 3_600_000,
} as const;

export interface DeploymentPgWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly environmentId: string;
  readonly agentId: string;
  readonly agentVersion: string;
  readonly deploymentService: DeploymentService;
  readonly deploymentStore: SqlDeploymentStore;
  readonly executionService: ExecutionService;
  readonly actor: () => { actorId: string; applicationId: string; tenantId: string };
}

export async function seedDeploymentWorld(db: DatabasePort): Promise<DeploymentPgWorld> {
  const tenantId = generateId();
  const applicationId = generateId();
  const environmentId = generateId();

  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "deployments tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "deployments app"],
  });
  await db.execute({
    sql: "INSERT INTO applications.environments (id, application_id, tenant_id, kind, name) VALUES ($1, $2, $3, 'production', 'prod')",
    parameters: [environmentId, applicationId, tenantId],
  });

  // Executions: the REAL service (execution provenance references).
  const policyStore = new InMemoryPolicyStore();
  const authority = createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher });
  await authority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });
  const executionService = createExecutionService({
    store: new SqlExecutionStore(db),
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: (
      await import("../../../src/modules/policies/public")
    ).createExecutionAuthorization(authority),
    generateId,
    now: () => new Date(),
  });

  // Agents: the REAL registry with the SQL store.
  const agentStore = new SqlAgentStore(db);
  const registry = createAgentRegistry({
    store: agentStore,
    generateId,
    now: () => new Date(),
    hashDefinition: sha256Hex,
  });
  const actorScope = { actorId: ACTOR_ID, applicationId, tenantId };
  const agent = await registry.registerAgent(
    { applicationId, tenantId, slug: "support-voice", name: "Support Voice Agent" },
    "deploy-agent-register",
    actorScope,
  );
  const version = await registry.publishVersion(
    { agentId: agent.id, version: "1.0.0", definition: BASELINE_DEFINITION as never },
    "deploy-agent-publish",
    actorScope,
  );
  await registry.promote(
    { agentId: agent.id, targetVersionId: version.id },
    "deploy-agent-promote",
    actorScope,
  );

  // Deployments: the SQL store + the service with the REAL seams.
  const deploymentStore = new SqlDeploymentStore(db);
  const adapters = createModalityAdapterRegistry();
  adapters.register({
    descriptor: {
      adapterCapabilityId: "realtime-channel-adapter",
      channelKinds: ["web", "in-app"],
    },
    async checkBinding() {
      return { ok: true };
    },
    async describeBinding(binding) {
      return { channelKind: binding.channelKind, adapter: "realtime" };
    },
  });
  adapters.register({
    descriptor: { adapterCapabilityId: "telephony-channel-adapter", channelKinds: ["telephony"] },
    async checkBinding() {
      return { ok: true };
    },
    async describeBinding(binding) {
      return { channelKind: binding.channelKind, adapter: "telephony" };
    },
  });
  const deploymentService = createDeploymentService({
    store: deploymentStore,
    agentInventory: createAgentInventoryAdapter(registry),
    environmentResolver: createSqlEnvironmentResolver(db),
    adapters,
    digest: sha256Hex,
    generateId,
    now: () => new Date(),
  });

  const actor = () => ({ actorId: ACTOR_ID, applicationId, tenantId });

  return {
    db,
    tenantId,
    applicationId,
    environmentId,
    agentId: agent.id,
    agentVersion: "1.0.0",
    deploymentService,
    deploymentStore,
    executionService,
    actor,
  };
}

/** The neutral profile/plan bodies for the suite. */
export const PROFILE_BODY: DeploymentProfileInput = {
  profileId: "support-voice",
  modality: "realtime-voice",
  channelKinds: ["web", "telephony"],
  requiredCapabilities: ["realtime-conversation"],
  latencyClass: "realtime",
  resourceClass: "standard",
  sideEffectClass: "read-only",
  inputModalities: ["audio"],
  outputModalities: ["audio", "text"],
};

export function planBody(world: {
  readonly environmentId: string;
  readonly agentId: string;
}): DeploymentPlanInput {
  return {
    planId: "support-voice-plan",
    profileRef: { profileId: "support-voice", version: 1 },
    agentRef: { agentId: world.agentId, agentVersion: "1.0.0", agentKind: "zeck" },
    environmentId: world.environmentId,
    channelBindings: [
      { channelKind: "web", adapterCapabilityId: "realtime-channel-adapter" },
      { channelKind: "telephony", adapterCapabilityId: "telephony-channel-adapter" },
    ],
    sessionPolicy: { maxSessionDurationMs: 600_000, maxConcurrentSessions: 8 },
  };
}

export { InMemoryDeploymentStore };
