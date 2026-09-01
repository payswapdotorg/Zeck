/**
 * Real-PostgreSQL public API proofs (WORK-015; the durable halves of
 * M1–M13, M26 — real HTTP surface over the REAL SQL authorities).
 *
 * Required-test mapping:
 *  - execution read/write scope through real SQL: creation, reads,
 *    events, verification, cancellation through the lifecycle;
 *  - IDEMPOTENCY (M11/M12): same key + fingerprint replays the same
 *    durable row (real unique-arbitration); same key + different
 *    fingerprint → 409;
 *  - concurrent creation converges on ONE durable execution (two
 *    concurrent POSTs with the same key);
 *  - cancellation authority (M26): cancel transitions through the real
 *    state machine; terminal executions reject cancel with 409;
 *  - agent inventory projection over the real registry (M16/M22);
 *  - tenant isolation (M1): cross-tenant reads/cancels are 404;
 *  - version/lifecycle reads: events, verification, results;
 *  - economic actions (WORK-032): POST/GET/events/outcome routes over
 *    the REAL economics SQL authority (migration 0014) with real
 *    idempotency, the scrubbed serializers, and cross-tenant 404s.
 */

import { expect, test } from "vitest";
import { authHeaders, otherTenantHeaders, seedApiPgWorld } from "./api-world";
import { definePgSuite } from "./harness";

definePgSuite("public API over real PostgreSQL (executions)", (ctx) => {
  test("POST /executions creates through the real SQL authority", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const response = await world.server.app.inject({
      method: "POST",
      url: "/executions",
      headers: { ...authHeaders(world), "idempotency-key": "pg-create-1" },
      payload: {
        applicationId: world.applicationId,
        task: { kind: "summarize", input: "doc-1" },
      },
    });
    expect(response.statusCode).toBe(201);
    const receipt = response.json();
    expect(receipt.executionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.status).toBe("CREATED");
    const count = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*)::text AS count FROM executions.executions WHERE id = $1`,
      parameters: [receipt.executionId],
    });
    expect(count.rows[0]?.count).toBe("1");
  });

  test("M11: duplicate POST converges on ONE durable execution (real arbitration)", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const key = `pg-dup-${Date.now()}`;
    const send = () =>
      world.server.app.inject({
        method: "POST",
        url: "/executions",
        headers: { ...authHeaders(world), "idempotency-key": key },
        payload: {
          applicationId: world.applicationId,
          task: { kind: "summarize", input: "doc-1" },
        },
      });
    const [first, second] = await Promise.all([send(), send()]);
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(second.json().executionId).toBe(first.json().executionId);
    const count = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*)::text AS count FROM executions.executions WHERE id = $1`,
      parameters: [first.json().executionId],
    });
    expect(count.rows[0]?.count).toBe("1");
  });

  test("M12: same key + different fingerprint → 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const key = `pg-clash-${Date.now()}`;
    await world.server.app.inject({
      method: "POST",
      url: "/executions",
      headers: { ...authHeaders(world), "idempotency-key": key },
      payload: {
        applicationId: world.applicationId,
        task: { kind: "summarize", input: "doc-1" },
      },
    });
    const conflict = await world.server.app.inject({
      method: "POST",
      url: "/executions",
      headers: { ...authHeaders(world), "idempotency-key": key },
      payload: {
        applicationId: world.applicationId,
        task: { kind: "other", input: "different" },
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("GET /executions/:id reads the durable row through the scope-checked path", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const executionId = await world.seedExecution("pg-read-1");
    const response = await world.server.app.inject({
      method: "GET",
      url: `/executions/${executionId}`,
      headers: authHeaders(world),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(executionId);
    expect(response.json().status).toBe("CREATED");
  });

  test("M1: cross-tenant execution read is a 404 (real tenant isolation)", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const executionId = await world.seedExecution("pg-cross-1");
    const response = await world.server.app.inject({
      method: "GET",
      url: `/executions/${executionId}`,
      headers: otherTenantHeaders(world),
    });
    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(response.json())).not.toContain(world.tenantId);
  });

  test("M26: cancellation goes through the real lifecycle; terminal rejects with 409", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const executionId = await world.seedExecution("pg-cancel-1");
    const cancel = await world.server.app.inject({
      method: "POST",
      url: `/executions/${executionId}/cancel`,
      headers: { ...authHeaders(world), "idempotency-key": `cancel-${executionId}` },
      payload: {},
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe("CANCELLED");
    const row = await ctx.port.execute<{ status: string }>({
      sql: `SELECT status FROM executions.executions WHERE id = $1`,
      parameters: [executionId],
    });
    expect(row.rows[0]?.status).toBe("CANCELLED");

    const reCancel = await world.server.app.inject({
      method: "POST",
      url: `/executions/${executionId}/cancel`,
      headers: { ...authHeaders(world), "idempotency-key": `re-cancel-${executionId}` },
      payload: {},
    });
    expect(reCancel.statusCode).toBe(409);
    expect(reCancel.json().code).toBe("INVALID_STATE_TRANSITION");
  });

  test("M1: cross-tenant cancellation is a 404 (no lifecycle mutation)", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const executionId = await world.seedExecution("pg-cross-cancel-1");
    const response = await world.server.app.inject({
      method: "POST",
      url: `/executions/${executionId}/cancel`,
      headers: { ...otherTenantHeaders(world), "idempotency-key": `x-${executionId}` },
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    const row = await ctx.port.execute<{ status: string }>({
      sql: `SELECT status FROM executions.executions WHERE id = $1`,
      parameters: [executionId],
    });
    expect(row.rows[0]?.status).toBe("CREATED");
  });

  test("GET /executions/:id/events returns the real gapless ledger", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const executionId = await world.seedExecution("pg-events-1");
    const response = await world.server.app.inject({
      method: "GET",
      url: `/executions/${executionId}/events`,
      headers: authHeaders(world),
    });
    expect(response.statusCode).toBe(200);
    const events = response.json();
    expect(events.map((event: { sequence: number }) => event.sequence)).toEqual([1]);
    expect(events[0].type).toBe("execution.created");
  });

  test("the full lifecycle produces the verification read surface", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const executionId = await world.seedExecution("pg-verify-1");
    const actor = { actorId: world.actorId, tenantId: world.tenantId };
    for (const command of ["authorize", "plan", "queue", "start", "verify"] as const) {
      await world.executions.transition(
        { command, applicationId: world.applicationId, executionId, ...actor },
        `${command}-${executionId}`,
      );
    }
    await world.executions.transition(
      {
        command: "pass",
        applicationId: world.applicationId,
        executionId,
        ...actor,
        verificationResults: [
          {
            criterionId: "cites-sources",
            strategy: "rubric",
            status: "PASS",
            recordedBy: "verifier-1",
            evidence: ["ev-1"],
          },
        ],
      },
      `pass-${executionId}`,
    );
    const verification = await world.server.app.inject({
      method: "GET",
      url: `/executions/${executionId}/verification`,
      headers: authHeaders(world),
    });
    expect(verification.statusCode).toBe(200);
    expect(verification.json()[0].status).toBe("PASS");

    const result = await world.server.app.inject({
      method: "GET",
      url: `/executions/${executionId}/results`,
      headers: authHeaders(world),
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().status).toBe("COMPLETED");
    expect(result.json().verification).toHaveLength(1);
  });
});

definePgSuite("public API over real PostgreSQL (agents)", (ctx) => {
  test("the inventory route projects the real registry (M16/M22)", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const seeded = await world.seedAgent("support-bot");
    const response = await world.server.app.inject({
      method: "GET",
      url: "/agents",
      headers: authHeaders(world),
    });
    expect(response.statusCode).toBe(200);
    const agents = response.json();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(seeded.agentId);
    expect(agents[0].activeVersion).toBe("1.0.0");
    // The projection equals the authority row.
    const authority = await world.agents.getAgent(world.applicationId, seeded.agentId);
    expect(agents[0].createdAt).toBe(authority?.createdAt);
  });

  test("the status view follows the real current selection (M23)", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const seeded = await world.seedAgent("status-bot");
    const response = await world.server.app.inject({
      method: "GET",
      url: `/agents/${seeded.agentId}/status`,
      headers: authHeaders(world),
    });
    expect(response.statusCode).toBe(200);
    const status = response.json();
    expect(status.agent.activeVersionId).toBe(seeded.versionId);
    expect(status.latestSelection.kind).toBe("promotion");
    expect(status.activeVersion.version).toBe("1.0.0");
  });

  test("M1/M22: cross-tenant agent reads are 404 (real isolation)", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const seeded = await world.seedAgent("private-bot");
    const response = await world.server.app.inject({
      method: "GET",
      url: `/agents/${seeded.agentId}`,
      headers: otherTenantHeaders(world),
    });
    expect(response.statusCode).toBe(404);
    const inventory = await world.server.app.inject({
      method: "GET",
      url: "/agents",
      headers: otherTenantHeaders(world),
    });
    expect(inventory.json()).toEqual([]);
  });

  test("the version route lists the real immutable version artifacts", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const seeded = await world.seedAgent("versioned-bot");
    const response = await world.server.app.inject({
      method: "GET",
      url: `/agents/${seeded.agentId}/versions`,
      headers: authHeaders(world),
    });
    expect(response.statusCode).toBe(200);
    const versions = response.json();
    expect(versions).toHaveLength(1);
    expect(versions[0].id).toBe(seeded.versionId);
    expect(versions[0].definitionDigest).toMatch(/^[0-9a-f]{64}$/);
    // The definition body stays with the authority.
    expect(JSON.stringify(versions[0])).not.toContain("instructions");
  });

  test("no agent mutation happens through the API surface (M14/M15/M21)", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const seeded = await world.seedAgent("immutable-bot");
    for (const url of [
      "/agents",
      `/agents/${seeded.agentId}`,
      `/agents/${seeded.agentId}/versions`,
      `/agents/${seeded.agentId}/status`,
    ]) {
      await world.server.app.inject({ method: "GET", url, headers: authHeaders(world) });
    }
    // The registry's mutation surface is untouched: one agent, one
    // version, one selection (exactly the seeded state).
    const [agent] = [await world.agents.getAgent(world.applicationId, seeded.agentId)];
    expect(agent?.status).toBe("available");
    const versions = await world.agents.listVersions(world.applicationId, seeded.agentId);
    expect(versions).toHaveLength(1);
    const selections = await world.agents.listSelections(world.applicationId, seeded.agentId);
    expect(selections).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Economic actions (WORK-032): the public routes over the REAL economics
  // SQL authority (migration 0014) — create, scope-checked reads, the
  // append-only event ledger, the outcome axes, and real idempotency.
  // -------------------------------------------------------------------------

  test("POST /economic-actions creates intent through the real SQL authority; duplicate POST converges", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const executionId = await world.seedExecution("econ-api-exec-1");
    const payload = {
      applicationId: world.applicationId,
      executionId,
      purpose: "purchase",
      recipient: { kind: "merchant", id: "merchant-42" },
      amount: { kind: "range", minMicroUsd: "100000", maxMicroUsd: "200000" },
      currency: "usd",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      requiredCapabilities: [{ kind: "tool", name: "payment-processor" }],
      metadata: { orderRef: "ord-1", apiToken: "should-be-scrubbed" },
    };
    const send = () =>
      world.server.app.inject({
        method: "POST",
        url: "/economic-actions",
        headers: { ...authHeaders(world), "idempotency-key": "econ-api-create-1" },
        payload,
      });
    const first = await send();
    expect(first.statusCode).toBe(201);
    const receipt = first.json();
    expect(receipt.economicActionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.status).toBe("proposed");
    expect(receipt.executionId).toBe(executionId);
    expect(receipt.replayed).toBe(false);
    // The same key + same fingerprint replays the SAME durable action.
    const replay = await send();
    expect(replay.statusCode).toBe(201);
    expect(replay.json().economicActionId).toBe(receipt.economicActionId);
    expect(replay.json().replayed).toBe(true);
    const rows = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM economics.economic_actions WHERE id = $1",
      parameters: [receipt.economicActionId],
    });
    expect(rows.rows[0]?.count).toBe("1");
    // A mutated fingerprint under the same key fails closed with 409.
    const conflict = await world.server.app.inject({
      method: "POST",
      url: "/economic-actions",
      headers: { ...authHeaders(world), "idempotency-key": "econ-api-create-1" },
      payload: { ...payload, amount: { kind: "exact", microUsd: "125000" } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("IDEMPOTENCY_KEY_REUSED");

    // GET /economic-actions/:id: the durable record with SCRUBBED metadata
    // (secret-shaped keys never cross the wire).
    const read = await world.server.app.inject({
      method: "GET",
      url: `/economic-actions/${receipt.economicActionId}`,
      headers: authHeaders(world),
    });
    expect(read.statusCode).toBe(200);
    const action = read.json();
    expect(action.id).toBe(receipt.economicActionId);
    expect(action.status).toBe("proposed");
    expect(action.metadata.orderRef).toBe("ord-1");
    expect(action.metadata.apiToken).toBe("[redacted]");
    expect(JSON.stringify(action)).not.toContain("should-be-scrubbed");

    // GET /economic-actions/:id/events: the gapless per-action ledger.
    const events = await world.server.app.inject({
      method: "GET",
      url: `/economic-actions/${receipt.economicActionId}/events`,
      headers: authHeaders(world),
    });
    expect(events.statusCode).toBe(200);
    const ledger = events.json();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].sequence).toBe(1);
    expect(ledger[0].type).toBe("action.recorded");

    // GET /economic-actions/:id/outcome: settlement and delivery as the
    // SEPARATE axes (nothing settled, nothing delivered — intent only).
    const outcome = await world.server.app.inject({
      method: "GET",
      url: `/economic-actions/${receipt.economicActionId}/outcome`,
      headers: authHeaders(world),
    });
    expect(outcome.statusCode).toBe(200);
    expect(outcome.json().settlement).toBeNull();
    expect(outcome.json().deliveries).toEqual([]);
    expect(outcome.json().status).toBe("proposed");
  });

  test("M1: cross-tenant economic-action reads are 404 (no tenant leak)", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const executionId = await world.seedExecution("econ-api-exec-2");
    const created = await world.economics.createEconomicAction(
      {
        actorId: world.actorId,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        executionId,
        purpose: "purchase",
        recipient: { kind: "merchant", id: "merchant-42" },
        amount: { kind: "exact", microUsd: "125000" },
        currency: "usd",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        requiredCapabilities: [],
      },
      "econ-api-cross-1",
    );
    const response = await world.server.app.inject({
      method: "GET",
      url: `/economic-actions/${created.action.id}`,
      headers: otherTenantHeaders(world),
    });
    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(response.json())).not.toContain(world.tenantId);
  });
});
