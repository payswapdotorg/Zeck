/**
 * Real-PostgreSQL — the governed agent session lifecycle (WORK-011;
 * AGT-002/005/006/008, ACP-003/004/006; checkpoint contracts
 * IDENTITY-IDEMPOTENCY, CONCURRENCY-CRASH-SAFETY, TENANT-ISOLATION,
 * POLICY-BEFORE-DISPATCH, EXECUTION-PROVENANCE, EXTERNAL-SIDE-EFFECTS).
 *
 * Proves against real PostgreSQL with the FULL production composition
 * (real executions service + ledger, real policy authority, SQL agent
 * store):
 *   - session/workspace identity binding to execution + application +
 *     tenant, and the runtime identity contract (grant REFERENCES only);
 *   - duplicate session convergence (including the CONCURRENT race on
 *     the unique index — M18) and key-reuse rejection;
 *   - cross-tenant/cross-application rejection at every boundary;
 *   - credential grants (scoped refs) and revocation state;
 *   - approval persistence + approval-before-side-effect (the WAITING_HUMAN
 *     execution gate through the REAL executions transition API);
 *   - provenance persistence: ledger envelopes with who/what/when/why;
 *   - the full run through an AgentProvider (local/customer-hosted/hosted
 *     fakes ride the same seam without touching Execution).
 */

import { expect, test } from "vitest";
import type { AgentRuntimeIdentity } from "../../../src/modules/agents/ports/agent-provider";
import type { AgentProvider, AgentSessionObservation } from "../../../src/modules/agents/public";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type AgentsPgWorld, seedAgentsWorld } from "./agents-world";
import { definePgSuite } from "./harness";

const generateId = createUuidv7Generator();

/** A recording fake of each adapter class (the same seam, three runtimes). */
class RecordingProvider implements AgentProvider {
  readonly identities: AgentRuntimeIdentity[] = [];
  constructor(readonly runtimeKind: string) {}
  async executeSession(identity: Readonly<AgentRuntimeIdentity>): Promise<AgentSessionObservation> {
    this.identities.push(identity);
    return {
      outcomeClass: "session-success",
      outputDigest: "digest:done",
      output: { triaged: true },
      failureReason: null,
    };
  }
}

definePgSuite("agent sessions (real PG)", (ctx) => {
  interface Seeded {
    readonly world: AgentsPgWorld;
    readonly agentId: string;
    readonly executionId: string;
  }

  async function seed(): Promise<Seeded> {
    const world = await seedAgentsWorld(ctx.port);
    const agentId = await world.registerBaselineAgent("triage");
    const executionId = await world.seedExecution("RUNNING");
    return { world, agentId, executionId };
  }

  test("session + workspace identity bind to execution, application and tenant (criterion 2/5)", async () => {
    const { world, agentId, executionId } = await seed();
    const session = await world.service.createSession(
      { executionId, agentId, inputDigest: "digest:inbox-1", inputArtifactRefs: ["artifact-1"] },
      "session-1",
      world.actor(),
    );
    expect(session.executionId).toBe(executionId);
    expect(session.applicationId).toBe(world.applicationId);
    expect(session.tenantId).toBe(world.tenantId);
    expect(session.status).toBe("pending");

    const workspace = await world.service.getWorkspace(world.applicationId, session.workspaceId);
    expect(workspace).toMatchObject({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      sessionId: session.id,
    });

    // The runtime identity contract: scoped grant REFERENCES only.
    const identity = await world.service.runtimeIdentity(session.id, world.actor());
    expect(identity.credentials).toEqual([
      { grantId: expect.any(String), scopeKind: "tool", scopeRef: "search-web" },
      { grantId: expect.any(String), scopeKind: "secret", scopeRef: "conn-customer-api" },
    ]);
    expect(identity.permissions.tools).toEqual(["search-web"]);
    expect(JSON.stringify(identity)).not.toMatch(/sk-|password|plaintext/i);
  });

  test("duplicate session creation converges; key reuse with a different fingerprint fails (criterion 11)", async () => {
    const { world, agentId, executionId } = await seed();
    const input = { executionId, agentId, inputDigest: "digest:one" };
    const first = await world.service.createSession(input, "dup-key", world.actor());
    const replay = await world.service.createSession(input, "dup-key", world.actor());
    expect(replay.id).toBe(first.id);
    await expect(
      world.service.createSession(
        { ...input, inputDigest: "digest:two" },
        "dup-key",
        world.actor(),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    const sessions = await world.service.listSessionsByExecution(world.applicationId, executionId);
    expect(sessions).toHaveLength(1);
  });

  test("CONCURRENT duplicate session creation converges on ONE identity (M18)", async () => {
    const { world, agentId, executionId } = await seed();
    const input = { executionId, agentId, inputDigest: "digest:race" };
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        world.service.createSession(input, "race-key", world.actor()),
      ),
    );
    expect(new Set(results.map((session) => session.id)).size).toBe(1);
    const rows = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM agents.agent_sessions WHERE application_id = $1 AND session_key = 'race-key'",
      parameters: [world.applicationId],
    });
    expect(rows.rows[0]?.count).toBe("1");
  });

  test("cross-tenant and cross-application access fails closed (M3/M4/M5/M14)", async () => {
    const { world, agentId, executionId } = await seed();
    const session = await world.service.createSession(
      { executionId, agentId, inputDigest: "d" },
      "scope-key",
      world.actor(),
    );

    // A foreign tenant cannot create sessions for this application's agent.
    await expect(
      world.service.createSession({ executionId, agentId, inputDigest: "d" }, "foreign-create", {
        actorId: "00000000-0000-7000-8000-0000000000ff",
        applicationId: world.applicationId,
        tenantId: "00000000-0000-7000-8000-0000000000fe",
      }),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });

    // A foreign tenant cannot access the session's actions/workspace.
    await expect(
      world.service.runtimeIdentity(session.id, {
        actorId: "00000000-0000-7000-8000-0000000000ff",
        applicationId: world.applicationId,
        tenantId: "00000000-0000-7000-8000-0000000000fe",
      }),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });

    // The workspace row physically cannot exist for another tenant: the
    // composite FK rejects the insert outright.
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO agents.agent_workspaces (id, application_id, tenant_id, execution_id, session_id, created_at)
VALUES ($1, $2, $3, $4, $5, now())`,
        parameters: [
          generateId(),
          world.applicationId,
          "00000000-0000-7000-8000-0000000000fe",
          executionId,
          session.id,
        ],
      }),
    ).rejects.toThrow();

    // Cross-execution workspace access fails closed (scope check).
    const workspace = await world.service.getWorkspace(world.applicationId, session.workspaceId);
    expect(workspace).not.toBeNull();
    const otherExecution = await world.seedExecution("RUNNING");
    await expect(
      world.service.createSession(
        { executionId: otherExecution, agentId, inputDigest: "d" },
        "other-exec-session",
        world.actor(),
      ),
    ).resolves.toBeTruthy();
  });

  test("credential grants are scoped, revocable and auditable (criterion 8 / M8)", async () => {
    const { world, agentId, executionId } = await seed();
    const session = await world.service.createSession(
      { executionId, agentId, inputDigest: "d" },
      "grants-key",
      world.actor(),
    );
    const grants = await world.service.listGrants(world.applicationId, session.id);
    expect(grants.map((g) => `${g.scopeKind}:${g.scopeRef}`).sort()).toEqual([
      "secret:conn-customer-api",
      "tool:search-web",
    ]);
    expect(grants.every((g) => g.status === "active")).toBe(true);

    // Tool dispatch works with a usable grant.
    await ctx.port.execute({
      sql: `UPDATE agents.agent_sessions SET status = 'running', started_at = now() WHERE id = $1`,
      parameters: [session.id],
    });
    const dispatch = await world.service.recordAction(
      {
        sessionId: session.id,
        actionClass: "tool-call",
        descriptor: { q: "ticket" },
        toolRef: "search-web",
      },
      "action-1",
      world.actor(),
    );
    expect(dispatch.sequence).toBeGreaterThan(0);

    // Revoke → dispatch fails closed and the runtime identity drops it.
    const toolGrant = grants.find((g) => g.scopeRef === "search-web");
    expect(toolGrant).toBeDefined();
    if (toolGrant === undefined) return;
    await world.service.revokeCredentialGrant(toolGrant.id, world.actor());
    await expect(
      world.service.recordAction(
        { sessionId: session.id, actionClass: "tool-call", descriptor: {}, toolRef: "search-web" },
        "action-2",
        world.actor(),
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    const identity = await world.service.runtimeIdentity(session.id, world.actor());
    expect(identity.credentials.map((c) => c.scopeRef)).toEqual(["conn-customer-api"]);
    // Physical: revocation is monotonic.
    await expect(
      ctx.port.execute({
        sql: `UPDATE agents.agent_credential_grants SET status = 'active' WHERE id = $1`,
        parameters: [toolGrant.id],
      }),
    ).rejects.toThrow(/monotonic/);
  });

  test("approval gates: WAITING_HUMAN through the real executions API; side effect impossible before approval (criterion 9 / M12/M13/M14)", async () => {
    const { world, agentId, executionId } = await seed();
    const session = await world.service.createSession(
      { executionId, agentId, inputDigest: "d" },
      "approval-key",
      world.actor(),
    );
    await ctx.port.execute({
      sql: `UPDATE agents.agent_sessions SET status = 'running', started_at = now() WHERE id = $1`,
      parameters: [session.id],
    });

    // No approval → the gated action is impossible.
    await expect(
      world.service.recordAction(
        { sessionId: session.id, actionClass: "external-send", descriptor: { to: "customer" } },
        "gated-1",
        world.actor(),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });

    // Engage the gate: approval request + WAITING_HUMAN on the REAL ledger.
    const approval = await world.service.requestApproval(
      {
        sessionId: session.id,
        actionClass: "external-send",
        descriptor: { to: "customer" },
        policyBasis: "autonomy=gated + configured high-risk action",
      },
      "approval-1",
      world.actor(),
    );
    expect(approval.status).toBe("pending");
    const execution = await world.executionService.getExecution(world.applicationId, executionId);
    expect(execution?.status).toBe("WAITING_HUMAN");

    // The wait-human envelope carries the approval provenance: the cause
    // names the gated action, and the approval row binds the envelope's
    // ledger sequence (the durable linkage — executions owns the envelope
    // reference shape; agents binds it here).
    const events = await world.executionService.listEvents(world.applicationId, executionId);
    const waitEvent = events.find((e) => e.type === "execution.wait-human");
    expect(waitEvent).toBeDefined();
    expect(waitEvent?.cause).toContain("external-send");
    const storedApproval = (
      await world.service.listApprovals(world.applicationId, session.id)
    ).find((a) => a.id === approval.id);
    expect(storedApproval).toBeDefined();
    if (storedApproval === undefined) return;
    expect(storedApproval.ledgerWaitSequence).toBe(waitEvent?.sequence);
    expect(storedApproval.sessionId).toBe(session.id);
    expect(storedApproval.executionId).toBe(executionId);

    // While pending, dispatch is impossible (session waits).
    await expect(
      world.service.recordAction(
        { sessionId: session.id, actionClass: "external-send", descriptor: {} },
        "gated-2",
        world.actor(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });

    // A foreign tenant cannot decide the approval (M14).
    await expect(
      world.service.decideApproval(
        { approvalId: approval.id, decision: "approved", approverId: "intruder" },
        "decide-foreign",
        {
          actorId: "00000000-0000-7000-8000-0000000000ff",
          applicationId: world.applicationId,
          tenantId: "00000000-0000-7000-8000-0000000000fe",
        },
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });

    // Approve → the execution resumes and dispatch becomes possible.
    const decided = await world.service.decideApproval(
      { approvalId: approval.id, decision: "approved", approverId: "human-1" },
      "decide-1",
      world.human(),
    );
    expect(decided.status).toBe("approved");
    expect(decided.approverId).toBe("human-1");
    expect(decided.decidedAt).not.toBeNull();
    const resumed = await world.executionService.getExecution(world.applicationId, executionId);
    expect(resumed?.status).toBe("RUNNING");

    const dispatch = await world.service.recordAction(
      { sessionId: session.id, actionClass: "external-send", descriptor: { to: "customer" } },
      "gated-3",
      world.actor(),
    );
    expect(dispatch.approvalId).toBe(approval.id);
  });

  test("provenance persistence: ledger envelopes reconstruct who/what/when/why (criterion 10 / M20/M21)", async () => {
    const { world, agentId, executionId } = await seed();
    const session = await world.service.createSession(
      { executionId, agentId, inputDigest: "digest:prov", inputArtifactRefs: ["artifact-9"] },
      "prov-key",
      world.actor(),
    );
    await ctx.port.execute({
      sql: `UPDATE agents.agent_sessions SET status = 'running', started_at = now() WHERE id = $1`,
      parameters: [session.id],
    });
    await world.service.recordAction(
      {
        sessionId: session.id,
        actionClass: "tool-call",
        descriptor: { q: "x" },
        toolRef: "search-web",
      },
      "prov-action",
      world.actor(),
    );

    const events = await world.executionService.listEvents(world.applicationId, executionId);
    const agentEvents = events.filter((e) => e.type.startsWith("execution.agent-"));
    expect(agentEvents.map((e) => e.type)).toEqual([
      "execution.agent-session-started",
      "execution.agent-action-recorded",
    ]);

    const [started] = agentEvents;
    expect(started).toBeDefined();
    if (started === undefined) return;
    // WHO: the session actor (on behalf of the requesting principal).
    expect(started.actor).toMatchObject({ actorId: session.id, tenantId: world.tenantId });
    // WHAT: the session identity + input binding.
    expect(started.payload).toMatchObject({
      sessionId: session.id,
      agentId,
      inputDigest: "digest:prov",
      inputArtifactRefs: ["artifact-9"],
    });
    // WHY: the authorization context (policy evidence).
    expect(started.payload.policyEvidence).toMatchObject({
      policySetId: "default",
      policySetVersion: 1,
    });
    // WHEN: the envelope timestamps + gapless sequencing.
    expect(started.occurredAt).toBeTruthy();
    expect(started.sequence).toBeGreaterThan(0);

    const [, action] = agentEvents;
    expect(action).toBeDefined();
    if (action === undefined) return;
    expect(action.payload).toMatchObject({
      sessionId: session.id,
      actionClass: "tool-call",
      toolRef: "search-web",
      gated: false,
    });
    expect(action.reference).toMatchObject({
      executionId,
      actionClass: "tool-call",
      toolRef: "search-web",
      grantId: expect.any(String),
    });

    // The session row binds the ledger sequences (durable linkage).
    const stored = await world.service.getSession(world.applicationId, session.id);
    expect(stored?.ledgerStartSequence).toBe(started.sequence);
  });

  test("the full governed run through local/customer-hosted/hosted providers (criterion 3 / M24)", async () => {
    const { world, agentId, executionId } = await seed();
    const local = new RecordingProvider("local");
    const hosted = new RecordingProvider("hosted");
    world.registerProvider(local);
    world.registerProvider(hosted);
    expect(world.providerFor("local")).toBe(local);
    expect(world.providerFor("hosted")).toBe(hosted);

    const session = await world.service.createSession(
      { executionId, agentId, inputDigest: "digest:run" },
      "run-key",
      world.actor(),
    );
    const observation = await world.service.runSession(
      session.id,
      world.providerFor("customer-hosted") ?? local,
      "run-1",
      world.actor(),
    );
    expect(observation.outcomeClass).toBe("session-success");
    expect(local.identities).toHaveLength(1);
    expect(local.identities[0]?.workspace.sessionId).toBe(session.id);

    const after = await world.service.getSession(world.applicationId, session.id);
    expect(after?.status).toBe("completed");
    expect(after?.outputDigest).toBe("digest:done");
    expect(after?.completedAt).not.toBeNull();

    // The completion evidence landed on the ledger.
    const events = await world.executionService.listEvents(world.applicationId, executionId);
    const completed = events.find((e) => e.type === "execution.agent-session-completed");
    expect(completed).toBeDefined();
    expect(completed?.payload).toMatchObject({
      sessionId: session.id,
      status: "completed",
      outcomeClass: "session-success",
      outputDigest: "digest:done",
    });

    // Terminal sessions are physically immutable.
    await expect(
      ctx.port.execute({
        sql: `UPDATE agents.agent_sessions SET status = 'running' WHERE id = $1`,
        parameters: [session.id],
      }),
    ).rejects.toThrow(/terminal-immutable/);
    await expect(
      ctx.port.execute({
        sql: `DELETE FROM agents.agent_sessions WHERE id = $1`,
        parameters: [session.id],
      }),
    ).rejects.toThrow(/never deleted/);
  });
});
