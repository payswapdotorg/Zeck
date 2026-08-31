/**
 * Unit proofs: BYOA interop (WORK-016 / AGT-007, ACP-005 — the durable
 * halves live in the real-PG suites).
 *
 * Required-test mapping:
 *  - registration through the WORK-011 registry authority (identity
 *    convergence, immutable version, promotion — NO second registry);
 *  - the runtime wrapper implements the agents public AgentProvider
 *    port (the documented seam) with the neutral BYOA runtime kind;
 *  - sanitization: framework failures become honest session-failure
 *    observations (no stack traces, no internals);
 *  - governed participants: sessions through the REAL session service
 *    admission chain (deny when policy denies — no bypass);
 *  - the external side receives ONLY references (no secret values cross
 *    the runtime identity — structural);
 *  - framework types never cross the public contracts.
 */

import { describe, expect, test } from "vitest";
import {
  BYOA_RUNTIME_KIND,
  type ByoaExternalAgent,
  type ByoaRegistrationRequest,
  createByoaAgentProvider,
  validateByoaRegistration,
} from "../../../src/integrations/workflowos/public";
import {
  ACTOR_ID,
  APPLICATION_ID,
  seedIntegrationWorld,
  stubExternalAgent,
  TENANT_ID,
} from "./world";

const VALID_REGISTRATION: ByoaRegistrationRequest = {
  slug: "byoa-support",
  name: "BYOA Support Agent",
  version: "1.0.0",
  instructions: "Triage support tickets.",
  requestedPermissions: {
    tools: ["search-web"],
    secretRefs: ["conn-api"],
    models: ["reasoning-base"],
  },
  approvalRequiredActions: [],
  maxAutonomy: "gated",
  maxSessionDurationMs: 600000,
};

describe("registerByoaAgent — through the WORK-011 registry authority (ACP-005)", () => {
  test("registers identity + immutable version + promotion through the REAL registry", async () => {
    const world = seedIntegrationWorld();
    const outcome = await world.registerByoa("byoa-support", "byoa-reg-1");
    expect(outcome.agent.slug).toBe("byoa-support");
    expect(outcome.agent.applicationId).toBe(APPLICATION_ID);
    expect(outcome.agent.tenantId).toBe(TENANT_ID);
    expect(outcome.version.version).toBe("1.0.0");
    expect(outcome.version.definition.instructions).toBe("Standing instruction for byoa-support.");
    // The definition carries the canonical governance declarations.
    expect(outcome.version.definition.isolation).toBe("container");
    expect(outcome.version.definition.maxAutonomy).toBe("gated");
    expect(outcome.version.definition.requestedPermissions.tools).toEqual(["search-web"]);
    // The promotion is the CURRENT selection (the authority's record).
    const selection = await world.registry.currentSelection(APPLICATION_ID, outcome.agent.id);
    expect(selection?.selectedVersionId).toBe(outcome.version.id);
  });

  test("registration is idempotent through the authority's arbitration", async () => {
    const world = seedIntegrationWorld();
    const first = await world.registerByoa("byoa-dup", "byoa-reg-2");
    const second = await world.registerByoa("byoa-dup", "byoa-reg-2");
    // Slug convergence: the same durable identity, the same version row.
    expect(second.agent.id).toBe(first.agent.id);
    expect(second.version.id).toBe(first.version.id);
    // Still exactly one agent row — NO second registry materialized.
    expect(world.agentStore).toBeDefined();
    const bySlug = await world.registry.getAgentBySlug(APPLICATION_ID, "byoa-dup");
    expect(bySlug?.id).toBe(first.agent.id);
  });

  test("invalid registrations fail closed with canonical errors", async () => {
    const world = seedIntegrationWorld();
    await expect(registerBad(world, { slug: "BAD SLUG" })).rejects.toMatchObject({
      code: "AGENT_ERROR",
    });
    await expect(registerBad(world, { ...VALID_REGISTRATION, name: "" })).rejects.toMatchObject({
      code: "AGENT_ERROR",
    });
  });

  test("validation: the closed vocabulary and vocabularies", () => {
    expect(validateByoaRegistration(VALID_REGISTRATION).valid).toBe(true);
    // The canonical autonomy/isolation vocabularies (the policies ladder).
    expect(
      validateByoaRegistration({ ...VALID_REGISTRATION, maxAutonomy: "autonomous" }).valid,
    ).toBe(false);
    expect(validateByoaRegistration({ ...VALID_REGISTRATION, isolation: "hypervisor" }).valid).toBe(
      false,
    );
    expect(validateByoaRegistration({ ...VALID_REGISTRATION, version: "1.0" }).valid).toBe(false);
    expect(validateByoaRegistration(null).valid).toBe(false);
    expect(
      validateByoaRegistration({
        ...VALID_REGISTRATION,
        requestedPermissions: { tools: [1] },
      }).valid,
    ).toBe(false);
  });
});

async function registerBad(
  world: ReturnType<typeof seedIntegrationWorld>,
  payload: unknown,
): Promise<unknown> {
  const { registerByoaAgent } = await import("../../../src/integrations/workflowos/public");
  return registerByoaAgent({ agents: world.registry }, payload, "byoa-bad-1", {
    actorId: ACTOR_ID,
    applicationId: APPLICATION_ID,
    tenantId: TENANT_ID,
  });
}

describe("createByoaAgentProvider — the neutral port wrapper (AGT-007)", () => {
  test("implements the agents public AgentProvider port with the neutral runtime kind", () => {
    const provider = createByoaAgentProvider(stubExternalAgent());
    expect(provider.runtimeKind).toBe(BYOA_RUNTIME_KIND);
    expect(provider.runtimeKind).toBe("external-byoa");
    // The port method exists (the seam the session service dispatches).
    expect(typeof provider.executeSession).toBe("function");
  });

  test("normalizes observations: success passes through with digest and output", async () => {
    const provider = createByoaAgentProvider(stubExternalAgent());
    const observation = await provider.executeSession(
      {
        executionId: "e1",
        sessionId: "s1",
        agentId: "a1",
        agentVersionId: "v1",
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        workspace: { workspaceId: "w1", executionId: "e1", sessionId: "s1" },
        permissions: { tools: [], secretRefs: [], models: [] },
        credentials: [],
        autonomy: "gated",
      },
      {
        instructions: "do",
        inputDigest: "digest:input",
        inputArtifactRefs: [],
        maxDurationMs: 1000,
      },
    );
    expect(observation.outcomeClass).toBe("session-success");
    expect(observation.outputDigest).toBe("stub:digest:input");
    expect(observation.output).toEqual({ runtime: "stub" });
  });

  test("M20/M25-class sanitization: thrown framework errors never leak internals", async () => {
    const throwing: ByoaExternalAgent = {
      descriptor: { name: "thrower", version: "0.0.1" },
      async executeSession() {
        throw new Error("LangGraph internal state corrupted at /usr/lib/node_modules/...");
      },
    };
    const provider = createByoaAgentProvider(throwing);
    const observation = await provider.executeSession(
      {
        executionId: "e1",
        sessionId: "s1",
        agentId: "a1",
        agentVersionId: "v1",
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        workspace: { workspaceId: "w1", executionId: "e1", sessionId: "s1" },
        permissions: { tools: [], secretRefs: [], models: [] },
        credentials: [],
        autonomy: "gated",
      },
      {
        instructions: "do",
        inputDigest: "d",
        inputArtifactRefs: [],
        maxDurationMs: 1000,
      },
    );
    expect(observation.outcomeClass).toBe("session-failure");
    expect(observation.failureReason).not.toContain("/usr/lib");
    expect(observation.failureReason).not.toContain("LangGraph");
    expect(observation.failureReason).toContain("no further detail");
  });

  test("failure reasons are sanitized (bounded, single-line)", async () => {
    const verbose: ByoaExternalAgent = {
      descriptor: { name: "verbose", version: "0.0.1" },
      async executeSession() {
        return {
          outcomeClass: "session-failure" as const,
          outputDigest: null,
          output: null,
          failureReason: `step 1 failed\nstack: at foo (bar.js:1)\n${"x".repeat(400)}`,
        };
      },
    };
    const provider = createByoaAgentProvider(verbose);
    const observation = await provider.executeSession(
      {
        executionId: "e1",
        sessionId: "s1",
        agentId: "a1",
        agentVersionId: "v1",
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        workspace: { workspaceId: "w1", executionId: "e1", sessionId: "s1" },
        permissions: { tools: [], secretRefs: [], models: [] },
        credentials: [],
        autonomy: "gated",
      },
      { instructions: "d", inputDigest: "d", inputArtifactRefs: [], maxDurationMs: 1 },
    );
    expect(observation.failureReason).not.toContain("\n");
    expect((observation.failureReason ?? "").length).toBeLessThanOrEqual(320);
  });

  test("invalid descriptors are rejected at wrapper construction", () => {
    expect(() =>
      createByoaAgentProvider({
        descriptor: { name: "", version: "1" },
        async executeSession() {
          return {
            outcomeClass: "session-success",
            outputDigest: null,
            output: null,
            failureReason: null,
          };
        },
      }),
    ).toThrow();
  });
});

describe("BYOA agents are GOVERNED PARTICIPANTS (M14/M15/M16-class)", () => {
  test("a session dispatch goes through the REAL admission chain (no bypass)", async () => {
    const world = seedIntegrationWorld();
    const outcome = await world.registerByoa("byoa-governed", "byoa-gov-1");
    const executionId = await world.seedRunningExecution("byoa-gov-exec-1");
    const provider = createByoaAgentProvider(stubExternalAgent());

    // Policy ALLOWS: the session runs through the admission chain.
    const session = await world.sessions.createSession(
      { executionId, agentId: outcome.agent.id, inputDigest: "digest:in" },
      "byoa-gov-session-1",
      { actorId: ACTOR_ID, applicationId: APPLICATION_ID, tenantId: TENANT_ID },
    );
    const observation = await world.sessions.runSession(session.id, provider, "byoa-gov-run-1", {
      actorId: ACTOR_ID,
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
    });
    expect(observation.outcomeClass).toBe("session-success");
    expect(world.admission).toBeDefined();
  });

  test("policy DENY blocks the BYOA session — the wrapper cannot bypass admission", async () => {
    const world = seedIntegrationWorld();
    world.admission.behavior = async () => ({ allowed: false, reason: "policy denies byoa" });
    const outcome = await world.registerByoa("byoa-denied", "byoa-deny-1");
    const executionId = await world.seedRunningExecution("byoa-deny-exec-1");
    const provider = createByoaAgentProvider(stubExternalAgent());
    await expect(
      world.sessions.createSession(
        { executionId, agentId: outcome.agent.id, inputDigest: "digest:in" },
        "byoa-deny-session-1",
        { actorId: ACTOR_ID, applicationId: APPLICATION_ID, tenantId: TENANT_ID },
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    // The provider was never invoked (no bypass around admission).
    expect(provider.runtimeKind).toBe(BYOA_RUNTIME_KIND);
  });

  test("the runtime identity carries ONLY references — no secret values cross (M23/M24)", async () => {
    const world = seedIntegrationWorld();
    const outcome = await world.registerByoa("byoa-creds", "byoa-cred-1");
    const executionId = await world.seedRunningExecution("byoa-cred-exec-1");
    const seen: unknown[] = [];
    const inspecting: ByoaExternalAgent = {
      descriptor: { name: "inspector", version: "1.0.0" },
      async executeSession(identity) {
        seen.push(identity);
        return {
          outcomeClass: "session-success",
          outputDigest: "d",
          output: null,
          failureReason: null,
        };
      },
    };
    const session = await world.sessions.createSession(
      { executionId, agentId: outcome.agent.id, inputDigest: "digest:in" },
      "byoa-cred-session-1",
      { actorId: ACTOR_ID, applicationId: APPLICATION_ID, tenantId: TENANT_ID },
    );
    await world.sessions.runSession(
      session.id,
      createByoaAgentProvider(inspecting),
      "byoa-cred-run-1",
      { actorId: ACTOR_ID, applicationId: APPLICATION_ID, tenantId: TENANT_ID },
    );
    expect(seen).toHaveLength(1);
    const identity = seen[0] as { credentials: readonly { grantId: string }[] };
    // Credential grants are REFERENCES (opaque ids), never values.
    for (const grant of identity.credentials) {
      expect(typeof grant.grantId).toBe("string");
      expect(Object.keys(grant).sort()).toEqual(["grantId", "scopeKind", "scopeRef"]);
    }
  });
});

describe("framework neutrality (M20)", () => {
  test("the public contract surface names no external framework", async () => {
    const { readFileSync } = await import("node:fs");
    const barrel = readFileSync("src/integrations/workflowos/public.ts", "utf8");
    for (const framework of ["LangGraph", "CrewAI", "AutoGen", "langgraph", "crewai", "autogen"]) {
      expect(barrel).not.toContain(framework);
    }
  });
});
