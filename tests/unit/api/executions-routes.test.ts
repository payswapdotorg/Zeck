/**
 * Public API execution endpoint tests (WORK-015 / API-001, API-005;
 * M1–M3, M11–M13, M26) over the REAL Fastify server (fastify.inject —
 * real route/handler/serialization execution, no network).
 *
 * Required-test mapping:
 *  - execution creation through the authority (201 + receipt);
 *  - retrieval/events/verification/results (the read projections);
 *  - cancellation THROUGH the execution lifecycle (M26);
 *  - server-side scope derivation: the tenant is NEVER client-supplied
 *    (M1/M2/M3 — cross-tenant reads 404, tenant-mismatching body fields
 *    are rejected, unknown body keys rejected);
 *  - idempotency (M11/M12): same key + same fingerprint replays; same
 *    key + different fingerprint → 409 IDEMPOTENCY_KEY_REUSED;
 *  - the public error model (M25): canonical codes, no internals;
 *  - WORK-034: every scoped execution route REQUIRES the
 *    X-Zeck-Application selector (the single-sourced server-side rule).
 */

import { describe, expect, test } from "vitest";
import { authHeaders, createBody, otherTenantHeaders, seedApiWorld, seedExecution } from "./world";

describe("POST /executions (API-001)", () => {
  test("creates an execution through the authority and returns the receipt", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "POST",
      url: "/executions",
      headers: { ...authHeaders(world), "idempotency-key": "create-1" },
      payload: createBody(world),
    });
    expect(response.statusCode).toBe(201);
    const receipt = response.json();
    expect(receipt.executionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.status).toBe("CREATED");
    expect(receipt.replayed).toBe(false);
    expect(receipt.lastEventSequence).toBe(1);
  });

  test("M11/M12: same idempotency key + same request replays the durable outcome", async () => {
    const world = await seedApiWorld();
    const first = await world.server.app.inject({
      method: "POST",
      url: "/executions",
      headers: { ...authHeaders(world), "idempotency-key": "same-key" },
      payload: createBody(world),
    });
    const second = await world.server.app.inject({
      method: "POST",
      url: "/executions",
      headers: { ...authHeaders(world), "idempotency-key": "same-key" },
      payload: createBody(world),
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().executionId).toBe(first.json().executionId);
    expect(second.json().replayed).toBe(true);
  });

  test("M12: same idempotency key + different request → 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const world = await seedApiWorld();
    await world.server.app.inject({
      method: "POST",
      url: "/executions",
      headers: { ...authHeaders(world), "idempotency-key": "clash" },
      payload: createBody(world),
    });
    const conflicting = await world.server.app.inject({
      method: "POST",
      url: "/executions",
      headers: { ...authHeaders(world), "idempotency-key": "clash" },
      payload: createBody(world, { task: { kind: "other", input: "x" } }),
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("a missing idempotency key is rejected (idempotent POST contract)", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "POST",
      url: "/executions",
      headers: authHeaders(world),
      payload: createBody(world),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("CAPABILITY_UNAVAILABLE");
  });

  test("M2/M3: client-supplied tenant/provider keys are rejected (closed create contract)", async () => {
    const world = await seedApiWorld();
    for (const forbidden of ["tenantId", "provider", "model", "connectionId"]) {
      const response = await world.server.app.inject({
        method: "POST",
        url: "/executions",
        headers: { ...authHeaders(world), "idempotency-key": `reject-${forbidden}` },
        payload: createBody(world, { [forbidden]: "anything" }),
      });
      expect(response.statusCode, `key ${forbidden}`).toBe(422);
      expect(response.json().code).toBe("CAPABILITY_UNAVAILABLE");
      expect(response.json().message).toContain("unknown keys");
    }
  });

  test("M1: an unauthenticated request is rejected before any authority call", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "POST",
      url: "/executions",
      headers: { "idempotency-key": "no-auth", "x-zeck-application": world.applicationId },
      payload: createBody(world),
    });
    expect(response.statusCode).toBe(401);
  });

  test("a caller without membership for the application is denied (server-side scope)", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "POST",
      url: "/executions",
      headers: { ...authHeaders(world), "idempotency-key": "no-membership" },
      payload: createBody(world, { applicationId: "00000000-0000-7000-8000-0000000000ee" }),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("AUTHORIZATION_DENIED");
  });
});

describe("GET /executions/:id (API-005 policy-visible metadata)", () => {
  test("returns the execution record through the scope-checked read", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "seed-get-1");
    const response = await world.server.app.inject({
      method: "GET",
      url: `/executions/${executionId}`,
      headers: authHeaders(world),
    });
    expect(response.statusCode).toBe(200);
    const execution = response.json();
    expect(execution.id).toBe(executionId);
    expect(execution.status).toBe("CREATED");
    expect(execution.task).toEqual({ kind: "summarize", input: "artifact-1" });
  });

  test("M1: a cross-tenant execution lookup is denied (404 — no tenant leak)", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "seed-cross-1");
    const response = await world.server.app.inject({
      method: "GET",
      url: `/executions/${executionId}`,
      headers: otherTenantHeaders(world),
    });
    expect(response.statusCode).toBe(404);
    // The error body never discloses the execution's tenant.
    expect(JSON.stringify(response.json())).not.toContain(world.tenantId);
  });
});

describe("POST /executions/:id/cancel (M26 — through the lifecycle)", () => {
  test("cancels a non-terminal execution through the authority transition", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "seed-cancel-1");
    const response = await world.server.app.inject({
      method: "POST",
      url: `/executions/${executionId}/cancel`,
      headers: { ...authHeaders(world), "idempotency-key": `cancel-${executionId}` },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("CANCELLED");
    expect(response.json().executionId).toBe(executionId);
  });

  test("a terminal execution cannot be cancelled (lifecycle authority)", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "seed-cancel-2");
    await world.executions.transition(
      {
        command: "cancel",
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        executionId,
        actorId: "00000000-0000-7000-8000-0000000000aa",
      },
      `pre-cancel-${executionId}`,
    );
    const response = await world.server.app.inject({
      method: "POST",
      url: `/executions/${executionId}/cancel`,
      headers: { ...authHeaders(world), "idempotency-key": `cancel2-${executionId}` },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("INVALID_STATE_TRANSITION");
  });

  test("M1: cross-tenant cancellation is denied", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "seed-cancel-3");
    const response = await world.server.app.inject({
      method: "POST",
      url: `/executions/${executionId}/cancel`,
      headers: { ...otherTenantHeaders(world), "idempotency-key": `x-${executionId}` },
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /executions/:id/events + /verification + /results", () => {
  test("lists the execution's events as the public projection", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "seed-events-1");
    const response = await world.server.app.inject({
      method: "GET",
      url: `/executions/${executionId}/events`,
      headers: authHeaders(world),
    });
    expect(response.statusCode).toBe(200);
    const events = response.json();
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe("execution.created");
  });

  test("verification results project with the evaluator provenance", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "seed-verify-1");
    // Drive to COMPLETED with a durable verification result (the
    // completion binding — the real authority path).
    const actor = { actorId: "00000000-0000-7000-8000-0000000000aa", tenantId: world.tenantId };
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

    const verificationResponse = await world.server.app.inject({
      method: "GET",
      url: `/executions/${executionId}/verification`,
      headers: authHeaders(world),
    });
    expect(verificationResponse.statusCode).toBe(200);
    const results = verificationResponse.json();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("PASS");
    expect(results[0].criterionId).toBe("cites-sources");

    const resultResponse = await world.server.app.inject({
      method: "GET",
      url: `/executions/${executionId}/results`,
      headers: authHeaders(world),
    });
    expect(resultResponse.statusCode).toBe(200);
    const result = resultResponse.json();
    expect(result.executionId).toBe(executionId);
    expect(result.status).toBe("COMPLETED");
    expect(result.verification).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  test("a FAILED execution result carries an honest warning", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "seed-fail-1");
    const actor = { actorId: "00000000-0000-7000-8000-0000000000aa", tenantId: world.tenantId };
    for (const command of ["authorize", "plan", "queue", "start"] as const) {
      await world.executions.transition(
        { command, applicationId: world.applicationId, executionId, ...actor },
        `${command}-${executionId}`,
      );
    }
    await world.executions.transition(
      { command: "fail", applicationId: world.applicationId, executionId, ...actor },
      `fail-${executionId}`,
    );
    const response = await world.server.app.inject({
      method: "GET",
      url: `/executions/${executionId}/results`,
      headers: authHeaders(world),
    });
    const result = response.json();
    expect(result.status).toBe("FAILED");
    expect(result.warnings.some((warning: string) => warning.includes("failed"))).toBe(true);
  });
});

describe("the application-scope selector (WORK-034)", () => {
  test("execution reads reject a request without the X-Zeck-Application header", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "w034-no-header");
    for (const suffix of ["", "/results", "/events", "/verification"]) {
      const response = await world.server.app.inject({
        method: "GET",
        url: `/executions/${executionId}${suffix}`,
        headers: { authorization: `Bearer ${world.bearerToken}` },
      });
      expect(response.statusCode, `GET ${suffix}`).toBe(422);
      expect(response.json().code).toBe("CAPABILITY_UNAVAILABLE");
      expect(response.json().message).toContain("X-Zeck-Application");
    }
  });

  test("cancel rejects a request without the X-Zeck-Application header", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "w034-cancel-no-header");
    const response = await world.server.app.inject({
      method: "POST",
      url: `/executions/${executionId}/cancel`,
      headers: { authorization: `Bearer ${world.bearerToken}`, "idempotency-key": "w034-cancel-1" },
      payload: {},
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("CAPABILITY_UNAVAILABLE");
    expect(response.json().message).toContain("X-Zeck-Application");
  });

  test("a blank application selector is rejected like an absent one", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "w034-blank-header");
    const response = await world.server.app.inject({
      method: "GET",
      url: `/executions/${executionId}`,
      headers: { authorization: `Bearer ${world.bearerToken}`, "x-zeck-application": "" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("CAPABILITY_UNAVAILABLE");
  });
});
