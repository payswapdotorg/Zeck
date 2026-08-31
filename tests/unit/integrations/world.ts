/**
 * Shared in-memory fixture for the WORK-016 integration suites.
 *
 * Wires the REAL module surfaces (in-memory variants — the real
 * PostgreSQL variants live in tests/integration/postgres/):
 *  - executions: the REAL execution service over the in-memory store
 *    (policy-authorized creates, the real lifecycle, real idempotency
 *    arbitration);
 *  - agents: the REAL registry + the REAL session service over the
 *    in-memory agent store, with a scriptable admission seam (the REAL
 *    policy engine backs the PG worlds);
 *  - the integration: the REAL WorkflowOS submission service and BYOA
 *    interop over those authorities (the surface under test);
 *  - benchmarks: the REAL harness over the same wiring.
 */

import {
  type ByoaExternalAgent,
  type ByoaRegistrationOutcome,
  createByoaAgentProvider,
  createWorkflowOsIntegrationService,
  type IntegrationActor,
  registerByoaAgent,
  type WorkflowOsIntegrationService,
} from "../../../src/integrations/workflowos/public";
import {
  type AgentAdmission,
  type AgentAdmissionRequest,
  type AgentRegistry,
  createAgentExecutionLedgerAdapter,
  createAgentRegistry,
  createAgentSessionService,
  InMemoryAgentStore,
} from "../../../src/modules/agents/public";
import { createInMemoryExecutions } from "../executions/fakes";

export const APPLICATION_ID = "00000000-0000-7000-8000-0000000000b1";
export const TENANT_ID = "00000000-0000-7000-8000-0000000000a1";
export const OTHER_TENANT_ID = "00000000-0000-7000-8000-0000000000a2";
export const OTHER_APPLICATION_ID = "00000000-0000-7000-8000-0000000000b2";
export const ACTOR_ID = "00000000-0000-7000-8000-0000000000c1";

/** The scriptable policy admission seam (allow/deny per request). */
export class ScriptableAdmission implements AgentAdmission {
  public behavior: (request: AgentAdmissionRequest) => Promise<{
    allowed: boolean;
    reason?: string;
    effectivePermissions?: { tools: string[]; secretRefs: string[]; models: string[] };
    autonomy?: "none" | "gated" | "sandboxed" | "unconstrained";
  }> = async () => ({ allowed: false, reason: "not configured" });

  async admit(request: AgentAdmissionRequest) {
    const decision = await this.behavior(request);
    if (!decision.allowed) {
      return { allowed: false as const, reason: decision.reason ?? "denied" };
    }
    return {
      allowed: true as const,
      effectivePermissions: decision.effectivePermissions ?? {
        tools: request.requestedPermissions.tools,
        secretRefs: request.requestedPermissions.secretRefs,
        models: request.requestedPermissions.models ?? [],
      },
      autonomy: decision.autonomy ?? "gated",
      evidence: {
        policySetId: "bench-policy-set",
        policySetVersion: 1,
        policyContentHash: "hash-bench",
        restrictionSetDigest: "digest-bench",
      },
    };
  }
}

export interface IntegrationWorld {
  readonly executionsWorld: ReturnType<typeof createInMemoryExecutions>;
  readonly agentStore: InMemoryAgentStore;
  readonly registry: AgentRegistry;
  readonly admission: ScriptableAdmission;
  readonly sessions: ReturnType<typeof createAgentSessionService>;
  readonly workflowos: WorkflowOsIntegrationService;
  readonly actor: IntegrationActor;
  readonly otherTenantActor: IntegrationActor;
  /** Seed a governed execution in RUNNING state (session-ready). */
  readonly seedRunningExecution: (key: string) => Promise<string>;
  /** Register a BYOA agent through the canonical governed path. */
  readonly registerByoa: (slug: string, key: string) => Promise<ByoaRegistrationOutcome>;
}

export function seedIntegrationWorld(): IntegrationWorld {
  const executionsWorld = createInMemoryExecutions();
  executionsWorld.store.seedApplication(APPLICATION_ID, TENANT_ID);
  executionsWorld.store.seedApplication(OTHER_APPLICATION_ID, OTHER_TENANT_ID);

  const agentStore = new InMemoryAgentStore();
  const admission = new ScriptableAdmission();
  admission.behavior = async () => ({ allowed: true });
  // The REAL ledger adapter over the REAL executions service — sessions
  // bind to executions the authority actually owns (no parallel registry).
  const ledger = createAgentExecutionLedgerAdapter(executionsWorld.service);
  const registry = createAgentRegistry({
    store: agentStore,
    generateId: executionsWorld.generateId,
    now: () => new Date("2026-09-15T12:00:00Z"),
    hashDefinition: (canonicalJson: string) => `digest:${canonicalJson.length}`,
  });
  const sessions = createAgentSessionService({
    store: agentStore,
    admission,
    ledger,
    generateId: executionsWorld.generateId,
    now: () => new Date("2026-09-15T12:00:00Z"),
    hashValue: (value: string) => `digest:${value.length}`,
  });

  const workflowos = createWorkflowOsIntegrationService({
    executions: executionsWorld.service,
  });

  const actor: IntegrationActor = {
    actorId: ACTOR_ID,
    applicationId: APPLICATION_ID,
    tenantId: TENANT_ID,
  };
  const otherTenantActor: IntegrationActor = {
    actorId: ACTOR_ID,
    applicationId: OTHER_APPLICATION_ID,
    tenantId: OTHER_TENANT_ID,
  };

  const seedRunningExecution = async (key: string): Promise<string> => {
    const receipt = await executionsWorld.service.createExecution(
      {
        applicationId: APPLICATION_ID,
        task: { kind: "integration-seed", input: "seed" },
      },
      key,
      { actorId: ACTOR_ID, tenantId: TENANT_ID },
    );
    const executionId = receipt.executionId;
    for (const command of ["authorize", "plan", "queue", "start"] as const) {
      await executionsWorld.service.transition(
        {
          command,
          applicationId: APPLICATION_ID,
          executionId,
          actorId: ACTOR_ID,
          tenantId: TENANT_ID,
        },
        `${key}:${command}`,
      );
    }
    return executionId;
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
      { actorId: ACTOR_ID, applicationId: APPLICATION_ID, tenantId: TENANT_ID },
    );

  return {
    executionsWorld,
    agentStore,
    registry,
    admission,
    sessions,
    workflowos,
    actor,
    otherTenantActor,
    seedRunningExecution,
    registerByoa,
  };
}

/** A deterministic external agent fake implementing the neutral contract. */
export function stubExternalAgent(): ByoaExternalAgent {
  return {
    descriptor: { name: "unit-external-agent", version: "1.2.3" },
    async executeSession(_identity, task) {
      return {
        outcomeClass: "session-success",
        outputDigest: `stub:${task.inputDigest}`,
        output: { runtime: "stub" },
        failureReason: null,
      };
    },
  };
}

export { createByoaAgentProvider };
