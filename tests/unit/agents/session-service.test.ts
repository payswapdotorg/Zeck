/**
 * Unit — the governed agent session service (WORK-011; AGT-002/005/006/008,
 * ACP-003/004/006 + acceptance criteria 1–11).
 *
 * The full governed lifecycle against the in-memory store + fakes:
 * the admission chain (policy REQUIRED, intersection semantics, autonomy
 * designation), execution binding and tenant guards, the runtime identity
 * contract (scoped permissions + grant REFERENCES only), the approval
 * gate (engage → WAITING_HUMAN → decide → resume; side effect impossible
 * before approval), credential revocation, evidence on the canonical
 * ledger with who/what/when/why provenance, and idempotency at every
 * boundary.
 *
 * Discrimination (mutant) proofs live in
 * tests/discrimination/agent-fabric.discrimination.test.ts; the physical
 * (real-PostgreSQL) halves live in tests/integration/postgres/agents-*.
 */

import { describe, expect, test } from "vitest";
import type { AgentDefinition } from "../../../src/modules/agents/public";
import {
  createAgentRegistry,
  createAgentSessionService,
  InMemoryAgentStore,
} from "../../../src/modules/agents/public";
import {
  ACTOR_ID,
  APPLICATION_ID,
  allowAll,
  FakeAgentAdmission,
  FakeExecutionLedger,
  OTHER_APPLICATION_ID,
  OTHER_TENANT_ID,
  RecordingAgentProvider,
  TENANT_ID,
} from "./fakes";

const generateId = (() => {
  let counter = 0;
  return () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
})();

let clock = 0;
const now = () => new Date(Date.parse("2026-01-01T00:00:00.000Z") + clock++ * 1000);
const hashValue = (value: string) => `digest:${value.length}:${value.slice(-8)}`;

const DEFINITION: AgentDefinition = {
  instructions: "Triage the inbox and draft replies.",
  requestedPermissions: {
    tools: ["search-web", "file-reader"],
    secretRefs: ["conn-customer-api"],
    models: ["reasoning-base"],
  },
  approvalRequiredActions: ["external-send"],
  isolation: "container",
  maxAutonomy: "gated",
  maxSessionDurationMs: 600000,
};

const UNGATED_DEFINITION: AgentDefinition = {
  ...DEFINITION,
  approvalRequiredActions: [],
  maxAutonomy: "unconstrained",
};

const EXECUTION_ID = "00000000-0000-7000-8000-0000000000e1";

const actor = () => ({ actorId: ACTOR_ID, applicationId: APPLICATION_ID, tenantId: TENANT_ID });

function makeWorld(options?: { definition?: AgentDefinition }) {
  const store = new InMemoryAgentStore();
  const admission = new FakeAgentAdmission();
  admission.behavior = async (request) => allowAll(request);
  const ledger = new FakeExecutionLedger();
  ledger.seedExecution(EXECUTION_ID, "RUNNING");
  const registry = createAgentRegistry({ store, generateId, now, hashDefinition: hashValue });
  const service = createAgentSessionService({
    store,
    admission,
    ledger,
    generateId,
    now,
    hashValue,
  });
  const definition = options?.definition ?? DEFINITION;
  const world = {
    store,
    admission,
    ledger,
    registry,
    service,
    definition,
    agentId: "",
    versionId: "",
    async setup() {
      const agent = await registry.registerAgent(
        { applicationId: APPLICATION_ID, tenantId: TENANT_ID, slug: "triage", name: "Triage" },
        "register",
        actor(),
      );
      const version = await registry.publishVersion(
        { agentId: agent.id, version: "1.0.0", definition },
        "publish",
        actor(),
      );
      await registry.promote(
        { agentId: agent.id, targetVersionId: version.id },
        "promote",
        actor(),
      );
      world.agentId = agent.id;
      world.versionId = version.id;
      return world;
    },
  };
  return world;
}

describe("createSession — the admission chain (criteria 1/2/4/6)", () => {
  test("binds session+workspace identity to execution, application and tenant", async () => {
    const world = await makeWorld().setup();
    const session = await world.service.createSession(
      { executionId: EXECUTION_ID, agentId: world.agentId, inputDigest: "digest:input-1" },
      "session-key-1",
      actor(),
    );
    expect(session.executionId).toBe(EXECUTION_ID);
    expect(session.applicationId).toBe(APPLICATION_ID);
    expect(session.tenantId).toBe(TENANT_ID);
    expect(session.agentVersionId).toBe(world.versionId);
    expect(session.status).toBe("pending");

    const workspace = await world.service.getWorkspace(APPLICATION_ID, session.workspaceId);
    expect(workspace).toMatchObject({
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      executionId: EXECUTION_ID,
      sessionId: session.id,
    });
  });

  test("policy admission is REQUIRED — denial fails the session with POLICY_DENIED (M10)", async () => {
    const world = await makeWorld().setup();
    world.admission.behavior = async () => ({
      allowed: false,
      reason: "tools are not permitted by the effective policy",
    });
    await expect(
      world.service.createSession(
        { executionId: EXECUTION_ID, agentId: world.agentId, inputDigest: "d" },
        "session-key-denied",
        actor(),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(world.admission.requests).toHaveLength(1);
  });

  test("effective permissions are the INTERSECTION — the runtime never sees the requested superset (M9)", async () => {
    const world = await makeWorld().setup();
    world.admission.behavior = async (request) => ({
      allowed: true,
      effectivePermissions: {
        tools: request.requestedPermissions.tools.slice(0, 1),
        secretRefs: [],
        models: [],
      },
      autonomy: "gated",
      evidence: {
        policySetId: "default",
        policySetVersion: 1,
        policyContentHash: "hash",
        restrictionSetDigest: "digest",
      },
    });
    const session = await world.service.createSession(
      { executionId: EXECUTION_ID, agentId: world.agentId, inputDigest: "d" },
      "session-key-intersect",
      actor(),
    );
    expect(session.effectivePermissions.tools).toEqual(["search-web"]);
    expect(session.effectivePermissions.secretRefs).toEqual([]);
    // Grants exist ONLY for the effective refs.
    const grants = await world.service.listGrants(APPLICATION_ID, session.id);
    expect(grants.map((g) => `${g.scopeKind}:${g.scopeRef}`).sort()).toEqual(["tool:search-web"]);
  });

  test("the agent must be available; a suspended agent starts no sessions", async () => {
    const world = await makeWorld().setup();
    await world.registry.suspend(world.agentId, "k", actor());
    await expect(
      world.service.createSession(
        { executionId: EXECUTION_ID, agentId: world.agentId, inputDigest: "d" },
        "session-key-susp",
        actor(),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  test("execution binding: missing execution, cross-tenant execution and terminal execution fail closed (M5/M19)", async () => {
    const world = await makeWorld().setup();
    await expect(
      world.service.createSession(
        {
          executionId: "00000000-0000-7000-8000-0000000000d1",
          agentId: world.agentId,
          inputDigest: "d",
        },
        "k-missing",
        actor(),
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });

    world.ledger.seedExecution("00000000-0000-7000-8000-0000000000e2", "RUNNING", OTHER_TENANT_ID);
    await expect(
      world.service.createSession(
        {
          executionId: "00000000-0000-7000-8000-0000000000e2",
          agentId: world.agentId,
          inputDigest: "d",
        },
        "k-cross-tenant",
        actor(),
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });

    world.ledger.seedExecution("00000000-0000-7000-8000-0000000000e3", "COMPLETED");
    await expect(
      world.service.createSession(
        {
          executionId: "00000000-0000-7000-8000-0000000000e3",
          agentId: world.agentId,
          inputDigest: "d",
        },
        "k-terminal",
        actor(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("idempotent creation: same key replays, different fingerprint fails (criterion 11)", async () => {
    const world = await makeWorld().setup();
    const input = { executionId: EXECUTION_ID, agentId: world.agentId, inputDigest: "digest:one" };
    const first = await world.service.createSession(input, "same-key", actor());
    const replay = await world.service.createSession(input, "same-key", actor());
    expect(replay.id).toBe(first.id);
    await expect(
      world.service.createSession({ ...input, inputDigest: "digest:two" }, "same-key", actor()),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    // Exactly one session exists.
    const sessions = await world.service.listSessionsByExecution(APPLICATION_ID, EXECUTION_ID);
    expect(sessions).toHaveLength(1);
  });

  test("cross-tenant actor cannot create sessions for this application's agent", async () => {
    const world = await makeWorld().setup();
    await expect(
      world.service.createSession(
        { executionId: EXECUTION_ID, agentId: world.agentId, inputDigest: "d" },
        "k-foreign",
        { actorId: ACTOR_ID, applicationId: APPLICATION_ID, tenantId: OTHER_TENANT_ID },
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });
});

describe("runSession — the governed provider seam (criteria 3/8)", () => {
  test("the provider receives ONLY the governed identity: effective permissions, grant REFERENCES, workspace — no stores, no secrets (M7/M24)", async () => {
    const world = await makeWorld().setup();
    const session = await world.service.createSession(
      { executionId: EXECUTION_ID, agentId: world.agentId, inputDigest: "digest:input-1" },
      "run-key-1",
      actor(),
    );
    const provider = new RecordingAgentProvider("local");
    const observation = await world.service.runSession(session.id, provider, "run-key-1", actor());

    expect(observation.outcomeClass).toBe("session-success");
    expect(provider.identities).toHaveLength(1);
    const identity = provider.identities[0];
    expect(identity).toBeDefined();
    if (identity === undefined) return;
    expect(identity.sessionId).toBe(session.id);
    expect(identity.executionId).toBe(EXECUTION_ID);
    expect(identity.tenantId).toBe(TENANT_ID);
    expect(identity.workspace).toMatchObject({ sessionId: session.id, executionId: EXECUTION_ID });
    // Scoped grant REFERENCES only — never raw secret values.
    expect(identity.credentials).toEqual([
      { grantId: expect.any(String), scopeKind: "tool", scopeRef: "search-web" },
      { grantId: expect.any(String), scopeKind: "tool", scopeRef: "file-reader" },
      { grantId: expect.any(String), scopeKind: "secret", scopeRef: "conn-customer-api" },
      { grantId: expect.any(String), scopeKind: "model", scopeRef: "reasoning-base" },
    ]);
    const identityJson = JSON.stringify(identity);
    expect(identityJson).not.toContain("sk-");
    expect(identityJson).not.toContain("password");
    // The task carries the immutable instruction + input digest.
    expect(provider.tasks[0]?.instructions).toBe(DEFINITION.instructions);
    expect(provider.tasks[0]?.inputDigest).toBe("digest:input-1");
    // The session completed with the observation.
    const after = await world.service.getSession(APPLICATION_ID, session.id);
    expect(after?.status).toBe("completed");
    expect(after?.outputDigest).toBe("digest:done");
  });

  test("a failing provider observation fails the session (never a fake success)", async () => {
    const world = await makeWorld().setup();
    const session = await world.service.createSession(
      { executionId: EXECUTION_ID, agentId: world.agentId, inputDigest: "d" },
      "run-key-2",
      actor(),
    );
    const provider = new RecordingAgentProvider("hosted");
    provider.behavior = async () => ({
      outcomeClass: "session-failure",
      outputDigest: null,
      output: null,
      failureReason: "runtime exploded",
    });
    const observation = await world.service.runSession(session.id, provider, "rk", actor());
    expect(observation.outcomeClass).toBe("session-failure");
    const after = await world.service.getSession(APPLICATION_ID, session.id);
    expect(after?.status).toBe("failed");
    expect(after?.failureReason).toBe("runtime exploded");
  });

  test("terminal sessions cannot run again", async () => {
    const world = await makeWorld().setup();
    const session = await world.service.createSession(
      { executionId: EXECUTION_ID, agentId: world.agentId, inputDigest: "d" },
      "run-key-3",
      actor(),
    );
    const provider = new RecordingAgentProvider("local");
    await world.service.runSession(session.id, provider, "rk", actor());
    await expect(
      world.service.runSession(session.id, provider, "rk2", actor()),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });
});

describe("recordAction — the side-effect boundary (criteria 4/5/8/9)", () => {
  async function runningWorld(key = "action-key") {
    const world = await makeWorld().setup();
    const session = await world.service.createSession(
      { executionId: EXECUTION_ID, agentId: world.agentId, inputDigest: "d" },
      key,
      actor(),
    );
    // Start the session (pending -> running) without completing it: the
    // action boundary operates on a live running session.
    await world.store.transitionSession(APPLICATION_ID, session.id, "running", {
      startedAt: new Date().toISOString(),
    });
    return { world, session };
  }

  test("tool actions require the effective permission AND a usable grant (M11/M8)", async () => {
    const { world, session } = await runningWorld();
    // An approved tool with a usable grant dispatches through the boundary.
    const dispatch = await world.service.recordAction(
      {
        sessionId: session.id,
        actionClass: "tool-call",
        descriptor: { tool: "search-web", query: "ticket 42" },
        toolRef: "search-web",
      },
      "action-1",
      actor(),
    );
    expect(dispatch.approvalId).toBeNull();

    // A tool OUTSIDE the effective permissions fails closed — even though
    // a different tool of the session is approved (intersection only).
    await expect(
      world.service.recordAction(
        {
          sessionId: session.id,
          actionClass: "tool-call",
          descriptor: {},
          toolRef: "tool-not-granted",
        },
        "action-2",
        actor(),
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
  });

  test("revoked credentials stop dispatch immediately (M8)", async () => {
    const { world, session } = await runningWorld();
    // Revoke the search-web grant.
    const grants = await world.service.listGrants(APPLICATION_ID, session.id);
    const searchGrant = grants.find((g) => g.scopeRef === "search-web");
    expect(searchGrant).toBeDefined();
    await world.service.revokeCredentialGrant(searchGrant?.id ?? "", actor());
    await expect(
      world.service.recordAction(
        { sessionId: session.id, actionClass: "tool-call", descriptor: {}, toolRef: "search-web" },
        "action-revoked",
        actor(),
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    // The runtime identity no longer carries the revoked grant.
    const identity = await world.service.runtimeIdentity(session.id, actor());
    expect(identity.credentials.map((c) => c.scopeRef)).not.toContain("search-web");
  });

  test("gated actions dispatch ONLY with an approved approval (M12/M13)", async () => {
    const { world, session } = await runningWorld();

    // 1. No approval at all → side effect impossible.
    await expect(
      world.service.recordAction(
        { sessionId: session.id, actionClass: "external-send", descriptor: { to: "customer" } },
        "action-gated-1",
        actor(),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });

    // 2. Request the approval: the gate engages.
    const approval = await world.service.requestApproval(
      {
        sessionId: session.id,
        actionClass: "external-send",
        descriptor: { to: "customer" },
        policyBasis: "autonomy=gated + configured high-risk action",
      },
      "approval-1",
      actor(),
    );
    expect(approval.status).toBe("pending");
    // The execution moved to WAITING_HUMAN and the session waits.
    expect(
      world.ledger.transitions.some(
        (t) => t.command === "wait-human" && t.executionId === EXECUTION_ID,
      ),
    ).toBe(true);
    expect((await world.service.getSession(APPLICATION_ID, session.id))?.status).toBe(
      "waiting-approval",
    );

    // 3. While pending, the action is STILL impossible.
    await expect(
      world.service.recordAction(
        { sessionId: session.id, actionClass: "external-send", descriptor: { to: "customer" } },
        "action-gated-2",
        actor(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });

    // 4. Approve → the gate resolves and dispatch becomes possible.
    const decided = await world.service.decideApproval(
      { approvalId: approval.id, decision: "approved", approverId: "human-1" },
      "decide-1",
      actor(),
    );
    expect(decided.status).toBe("approved");
    expect(decided.approverId).toBe("human-1");
    expect(
      world.ledger.transitions.some(
        (t) => t.command === "resume" && t.executionId === EXECUTION_ID,
      ),
    ).toBe(true);
    expect((await world.service.getSession(APPLICATION_ID, session.id))?.status).toBe("running");

    const dispatch = await world.service.recordAction(
      { sessionId: session.id, actionClass: "external-send", descriptor: { to: "customer" } },
      "action-gated-3",
      actor(),
    );
    expect(dispatch.approvalId).toBe(approval.id);

    // 5. Revoking the approval blocks dispatch again.
    await world.service.revokeApproval(approval.id, actor());
    await expect(
      world.service.recordAction(
        { sessionId: session.id, actionClass: "external-send", descriptor: { to: "customer" } },
        "action-gated-4",
        actor(),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  test("expired approvals never authorize dispatch", async () => {
    const { world, session } = await runningWorld("exp-key");
    const approval = await world.service.requestApproval(
      {
        sessionId: session.id,
        actionClass: "external-send",
        descriptor: {},
        policyBasis: "gated",
        expiresAt: "2026-01-01T00:00:01.000Z",
      },
      "approval-exp",
      actor(),
    );
    await world.service.decideApproval(
      { approvalId: approval.id, decision: "approved", approverId: "human-1" },
      "decide-exp",
      actor(),
    );
    // now() has advanced past the expiry during the test.
    await expect(
      world.service.recordAction(
        { sessionId: session.id, actionClass: "external-send", descriptor: {} },
        "action-exp",
        actor(),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  test("approval gates engage only for policy-designated gated actions (agents cannot fabricate gates)", async () => {
    const world = await makeWorld({ definition: UNGATED_DEFINITION }).setup();
    const session = await world.service.createSession(
      { executionId: EXECUTION_ID, agentId: world.agentId, inputDigest: "d" },
      "ungated-key",
      actor(),
    );
    await world.store.transitionSession(APPLICATION_ID, session.id, "running", {});
    await expect(
      world.service.requestApproval(
        {
          sessionId: session.id,
          actionClass: "external-send",
          descriptor: {},
          policyBasis: "nope",
        },
        "fabricated-approval",
        actor(),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    // And the unGATED action dispatches freely:
    const dispatch = await world.service.recordAction(
      { sessionId: session.id, actionClass: "external-send", descriptor: {} },
      "ungated-action",
      actor(),
    );
    expect(dispatch.approvalId).toBeNull();
  });

  test("denial fails the session and resolves the execution gate", async () => {
    const { world, session } = await runningWorld("deny-key");
    const approval = await world.service.requestApproval(
      { sessionId: session.id, actionClass: "external-send", descriptor: {}, policyBasis: "gated" },
      "approval-deny",
      actor(),
    );
    await world.service.decideApproval(
      { approvalId: approval.id, decision: "denied", approverId: "human-2" },
      "decide-deny",
      actor(),
    );
    const after = await world.service.getSession(APPLICATION_ID, session.id);
    expect(after?.status).toBe("failed");
    expect(after?.failureReason).toContain("approval denied");
    expect(
      world.ledger.transitions.some(
        (t) => t.command === "resume" && t.executionId === EXECUTION_ID,
      ),
    ).toBe(true);
  });

  test("cross-tenant approval decisions fail closed (M14)", async () => {
    const { world, session } = await runningWorld("cross-key");
    const approval = await world.service.requestApproval(
      { sessionId: session.id, actionClass: "external-send", descriptor: {}, policyBasis: "gated" },
      "approval-cross",
      actor(),
    );
    await expect(
      world.service.decideApproval(
        { approvalId: approval.id, decision: "approved", approverId: "intruder" },
        "decide-cross",
        { actorId: ACTOR_ID, applicationId: APPLICATION_ID, tenantId: OTHER_TENANT_ID },
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    // The approval is still pending — no fabricated decision.
    const unchanged = await world.service.listApprovals(APPLICATION_ID, session.id);
    expect(unchanged[0]?.status).toBe("pending");
  });

  test("cross-application session access fails closed", async () => {
    const { world, session } = await runningWorld();
    await expect(
      world.service.recordAction(
        { sessionId: session.id, actionClass: "tool-call", descriptor: {} },
        "cross-app-action",
        { actorId: ACTOR_ID, applicationId: OTHER_APPLICATION_ID, tenantId: TENANT_ID },
      ),
    ).rejects.toMatchObject({ code: "AGENT_ERROR" });
  });
});

describe("session evidence on the canonical ledger (criteria 10/11)", () => {
  test("session start, actions and completion land as ledger envelopes with who/what/when/why (M20/M21)", async () => {
    const world = await makeWorld().setup();
    const session = await world.service.createSession(
      {
        executionId: EXECUTION_ID,
        agentId: world.agentId,
        inputDigest: "digest:input-1",
        inputArtifactRefs: ["artifact-1"],
      },
      "evidence-key",
      actor(),
    );
    await world.store.transitionSession(APPLICATION_ID, session.id, "running", {});
    await world.service.recordAction(
      { sessionId: session.id, actionClass: "read-only", descriptor: { what: "summary" } },
      "evidence-action",
      actor(),
    );
    // Complete the session and finalize through the store + ledger.
    await world.store.transitionSession(APPLICATION_ID, session.id, "completed", {
      completedAt: now().toISOString(),
      outputDigest: "digest:final",
    });
    const events = world.ledger.events.map((e) => e.event);
    const types = events.map((e) => e.command);
    expect(types).toContain("agent-session-started");
    expect(types).toContain("agent-action-recorded");

    const started = events.find((e) => e.command === "agent-session-started");
    expect(started).toBeDefined();
    if (started === undefined) return;
    // WHO: the session actor bound to the parent execution.
    expect(started.actor).toEqual({ actorId: session.id, tenantId: TENANT_ID });
    // WHAT: the payload carries the full session identity + input.
    expect(started.payload).toMatchObject({
      sessionId: session.id,
      agentId: world.agentId,
      agentVersionId: world.versionId,
      inputDigest: "digest:input-1",
    });
    // WHEN: the ledger's occurredAt (envelope sequencing) — recorded at append.
    // WHY: the cause + policy evidence.
    expect(started.cause).toBe("agent-session:agent-session-started");
    expect(started.payload.policyEvidence).toMatchObject({
      policySetId: "default",
      policySetVersion: 1,
    });

    const action = events.find((e) => e.command === "agent-action-recorded");
    expect(action).toBeDefined();
    if (action === undefined) return;
    expect(action.payload).toMatchObject({
      sessionId: session.id,
      actionClass: "read-only",
      gated: false,
    });
    expect(action.reference).toMatchObject({ executionId: EXECUTION_ID, actionClass: "read-only" });

    // The session row binds the ledger start sequence.
    const after = await world.service.getSession(APPLICATION_ID, session.id);
    expect(after?.ledgerStartSequence).not.toBeNull();
  });

  test("approval requests journal their wait-human transition with the approval reference", async () => {
    const world = await makeWorld().setup();
    const session = await world.service.createSession(
      { executionId: EXECUTION_ID, agentId: world.agentId, inputDigest: "d" },
      "approval-evidence-key",
      actor(),
    );
    await world.store.transitionSession(APPLICATION_ID, session.id, "running", {});
    const approval = await world.service.requestApproval(
      {
        sessionId: session.id,
        actionClass: "external-send",
        descriptor: { to: "x" },
        policyBasis: "gated",
      },
      "approval-ev",
      actor(),
    );
    const wait = world.ledger.transitions.find((t) => t.command === "wait-human");
    expect(wait).toBeDefined();
    if (wait === undefined) return;
    expect(wait.reference).toMatchObject({ approvalId: approval.id, sessionId: session.id });
    expect(wait.reason).toContain("external-send");
    // The approval row binds the ledger wait sequence.
    const approvals = await world.service.listApprovals(APPLICATION_ID, session.id);
    expect(approvals[0]?.ledgerWaitSequence).toBe(wait.sequence);
  });
});
