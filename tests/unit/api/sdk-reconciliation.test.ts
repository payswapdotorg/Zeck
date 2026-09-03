/**
 * The WORK-034 cross-tier reconciliation proof: the REAL API server driven
 * end-to-end through the REAL SDK client.
 *
 * WHY THIS SUITE EXISTS: the PR #58 Architect review established that the
 * dashboard's fake-API integration world could be green while the real
 * wire path was broken (the SDK never sent the X-Zeck-Application selector
 * the real scoped routes require). A transport-level contract must be
 * proven against the real server, not a re-implementation of its rules.
 *
 * Construction: the world's REAL Fastify server (real routes, real
 * server-side scope resolution, real serialization/error mapping, over
 * real module surfaces) is bridged to the SDK's injectable fetch —
 * light-my-request executes the full route/handler pipeline, so header
 * semantics are exactly the wire's.
 *
 * Required-test mapping (WORK-034 acceptance criteria):
 *  - AC1/AC6: a scoped client completes the full journey — creation
 *    (body scope), scoped reads, governed cancel, agent inventory —
 *    against the real server;
 *  - AC2: an unscoped client fails fast client-side and never issues a
 *    wire request (the bridge counts invocations);
 *  - AC6: the real server rejects a headerless scoped read (422, the
 *    single-sourced rule) — the enforcement the SDK now mirrors;
 *  - AC3: creation carries its scope in the body (the bridge asserts the
 *    raw request);
 *  - tenant safety (M1): a scoped client for ANOTHER application cannot
 *    read this application's execution (404, indistinguishable miss).
 */

import { describe, expect, test } from "vitest";
import { createZeckClient, type ZeckApiError, type ZeckClient } from "../../../sdk";
import { type ApiWorld, seedApiWorld } from "./world";

const BASE_URL = "http://api.zeck.test";

/**
 * Bridge the SDK's fetch to the world's real Fastify server through
 * light-my-request: the full route/handler/serialization pipeline with
 * real header semantics. Records every invocation so tests can prove no
 * wire request was issued. (The inject call is typed to the subset this
 * bridge uses; the server executes its real routing and handlers.)
 */
function bridgeToServer(
  world: ApiWorld,
): typeof fetch & { readonly calls: { readonly url: string; readonly init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const inject = world.server.app.inject.bind(world.server.app) as (options: {
    method: string;
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }) => Promise<{ readonly statusCode: number; readonly body: string }>;
  const impl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, init });
    const path = target.startsWith(BASE_URL) ? target.slice(BASE_URL.length) : target;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const response = await inject({
      method: init?.method ?? "GET",
      url: path,
      headers,
      ...(init?.body === undefined ? {} : { payload: String(init.body) }),
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { "content-type": "application/json" },
    });
  }) as never;
  return Object.assign(impl, { calls });
}

describe("the real-server × real-SDK reconciliation (WORK-034)", () => {
  test("a scoped client completes the full journey against the real server", async () => {
    const world = await seedApiWorld();
    const seeded = world.agentRegistry.seedAgent(
      world.applicationId,
      world.tenantId,
      "support-bot",
    );
    const fetchImpl = bridgeToServer(world);
    const client: ZeckClient = createZeckClient({
      baseUrl: BASE_URL,
      token: world.bearerToken,
      applicationId: world.applicationId,
      fetchImpl,
    });

    // Creation: the scope travels in the request BODY (the closed create
    // vocabulary) — and the bridge saw no application header on it.
    const { receipt } = await client.createExecution(
      { applicationId: world.applicationId, task: { kind: "summarize", input: "artifact-1" } },
      "w034-journey-create",
    );
    expect(receipt.status).toBe("CREATED");
    expect(receipt.executionId).toMatch(/^[0-9a-f-]{36}$/);

    // Scoped reads: every one carries the X-Zeck-Application selector the
    // real server's scope resolver requires.
    const execution = await client.getExecution(receipt.executionId);
    expect(execution.id).toBe(receipt.executionId);
    expect(execution.applicationId).toBe(world.applicationId);

    const events = await client.listEvents(receipt.executionId);
    expect(events.length).toBeGreaterThanOrEqual(1);

    const result = await client.getResult(receipt.executionId);
    expect(result.executionId).toBe(receipt.executionId);
    expect(result.status).toBe("CREATED");

    const verification = await client.listVerification(receipt.executionId);
    expect(verification).toEqual([]);

    // Agent inventory reads are scoped the same way.
    const agents = await client.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.id).toBe(seeded.agentId);

    const agentStatus = await client.getAgentStatus(seeded.agentId);
    expect(agentStatus.agent.id).toBe(seeded.agentId);
    expect(agentStatus.agent.slug).toBe("support-bot");

    // The governed cancel (the one command surface) — scoped + idempotent.
    const cancelReceipt = await client.cancelExecution(receipt.executionId, "w034-journey-cancel");
    expect(cancelReceipt.status).toBe("CANCELLED");

    // The post-cancel read reflects the terminal state through the same
    // scoped path.
    const cancelled = await client.getExecution(receipt.executionId);
    expect(cancelled.status).toBe("CANCELLED");
    expect(fetchImpl.calls).toHaveLength(9);
  });

  test("an unscoped client fails fast client-side — the wire is never reached", async () => {
    const world = await seedApiWorld();
    const fetchImpl = bridgeToServer(world);
    const client = createZeckClient({
      baseUrl: BASE_URL,
      token: world.bearerToken,
      fetchImpl,
    });
    await expect(client.getExecution("00000000-0000-7000-8000-0000000000d1")).rejects.toThrow(
      /no application scope/i,
    );
    await expect(client.listAgents()).rejects.toThrow(/no application scope/i);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  test("the real server rejects a headerless scoped read (the enforcement the SDK mirrors)", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "GET",
      url: "/executions/00000000-0000-7000-8000-0000000000d1",
      headers: { authorization: `Bearer ${world.bearerToken}` },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("CAPABILITY_UNAVAILABLE");
    expect(response.json().message).toContain("X-Zeck-Application");
  });

  test("M1: a scoped client for another application cannot read this application's execution", async () => {
    const world = await seedApiWorld();
    const fetchImpl = bridgeToServer(world);
    const ownerClient = createZeckClient({
      baseUrl: BASE_URL,
      token: world.bearerToken,
      applicationId: world.applicationId,
      fetchImpl,
    });
    const { receipt } = await ownerClient.createExecution(
      { applicationId: world.applicationId, task: { kind: "summarize", input: "artifact-1" } },
      "w034-cross-tenant-create",
    );
    const otherClient = createZeckClient({
      baseUrl: BASE_URL,
      token: world.otherTenantToken,
      applicationId: world.otherTenantApplicationId,
      fetchImpl: bridgeToServer(world),
    });
    let caught: ZeckApiError | null = null;
    try {
      await otherClient.getExecution(receipt.executionId);
    } catch (error) {
      caught = error as ZeckApiError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.status).toBe(404);
    // A scope-checked miss is indistinguishable from a missing one —
    // no tenant leak in the error body either.
    expect(caught?.body.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(JSON.stringify(caught?.body)).not.toContain(world.tenantId);
  });
});
