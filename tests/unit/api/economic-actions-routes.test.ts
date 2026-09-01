/**
 * Public API economic-action endpoint tests (WORK-032 / ECO-001, ECO-006,
 * ECO-007) over the REAL Fastify server (fastify.inject — real route/
 * handler/serialization execution, no network).
 *
 * Required-test mapping:
 *  - intent creation through the economics authority (201 + receipt);
 *  - the route contract is CLOSED: unknown keys rejected, malformed
 *    shapes rejected, credential-shaped body fields unrepresentable;
 *  - idempotency-key discipline: mandatory, replay, key reuse with a
 *    mutated material constraint -> 409 IDEMPOTENCY_KEY_REUSED, and the
 *    LENGTH bound tightened to 1..255 (the durable CHECK the key lives
 *    under — a 256-char key is rejected at the route, the runtime red
 *    record for the T1-flagged gap);
 *  - reads: GET /:id, /:id/events, /:id/outcome — scope-checked
 *    (cross-tenant/cross-application reads 404, never another tenant's
 *    data) and settlement/delivery serialized as SEPARATE axes;
 *  - NO authorization/charge/settlement/delivery mutation route exists
 *    on the public surface (those flow through the module's own seams);
 *  - secret safety: response projections never carry secret-shaped
 *    fields (metadata is scrubbed deeply).
 */

import { describe, expect, test } from "vitest";
import { authHeaders, otherTenantHeaders, seedApiWorld, seedExecution } from "./world";

function economicCreateBody(world: Awaited<ReturnType<typeof seedApiWorld>>) {
  return {
    applicationId: world.applicationId,
    executionId: "will-be-replaced",
    purpose: "purchase",
    recipient: { kind: "merchant", id: "merchant-42" },
    amount: { kind: "exact", microUsd: "125000" },
    currency: "usd",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    requiredCapabilities: [{ kind: "tool", name: "payment-processor" }],
  };
}

describe("POST /economic-actions (ECO-001)", () => {
  test("creates an economic intent through the authority and returns the receipt", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "exec-for-econ");
    const response = await world.server.app.inject({
      method: "POST",
      url: "/economic-actions",
      headers: { ...authHeaders(world), "idempotency-key": "econ-create-1" },
      payload: { ...economicCreateBody(world), executionId },
    });
    expect(response.statusCode).toBe(201);
    const receipt = response.json();
    expect(receipt.economicActionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.status).toBe("proposed");
    expect(receipt.replayed).toBe(false);
    expect(receipt.applicationId).toBe(world.applicationId);
  });

  test("the same key + same request replays the durable intent (ECO-007)", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "exec-econ-replay");
    const payload = { ...economicCreateBody(world), executionId };
    const first = await world.server.app.inject({
      method: "POST",
      url: "/economic-actions",
      headers: { ...authHeaders(world), "idempotency-key": "econ-replay" },
      payload,
    });
    const second = await world.server.app.inject({
      method: "POST",
      url: "/economic-actions",
      headers: { ...authHeaders(world), "idempotency-key": "econ-replay" },
      payload,
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().economicActionId).toBe(first.json().economicActionId);
    expect(second.json().replayed).toBe(true);
  });

  test("the same key + a MUTATED material constraint -> 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "exec-econ-clash");
    await world.server.app.inject({
      method: "POST",
      url: "/economic-actions",
      headers: { ...authHeaders(world), "idempotency-key": "econ-clash" },
      payload: { ...economicCreateBody(world), executionId },
    });
    const conflicting = await world.server.app.inject({
      method: "POST",
      url: "/economic-actions",
      headers: { ...authHeaders(world), "idempotency-key": "econ-clash" },
      payload: {
        ...economicCreateBody(world),
        executionId,
        amount: { kind: "exact", microUsd: "999999" },
      },
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("idempotency-key length is bounded to the durable CHECK: 255 ok, 256 rejected", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "exec-econ-len");
    // 255 characters: accepted (the migration-0014 CHECK bound).
    const ok = await world.server.app.inject({
      method: "POST",
      url: "/economic-actions",
      headers: { ...authHeaders(world), "idempotency-key": "k".repeat(255) },
      payload: { ...economicCreateBody(world), executionId },
    });
    expect(ok.statusCode).toBe(201);
    // 256 characters: rejected AT THE ROUTE (before any durable write).
    const tooLong = await world.server.app.inject({
      method: "POST",
      url: "/economic-actions",
      headers: { ...authHeaders(world), "idempotency-key": "k".repeat(256) },
      payload: { ...economicCreateBody(world), executionId },
    });
    expect(tooLong.statusCode).toBe(422); // CAPABILITY_UNAVAILABLE -> 422 (the canonical public error status)
    expect(tooLong.json().message).toContain("1..255");
    // Empty and missing keys are rejected too.
    const empty = await world.server.app.inject({
      method: "POST",
      url: "/economic-actions",
      headers: { ...authHeaders(world), "idempotency-key": "" },
      payload: { ...economicCreateBody(world), executionId },
    });
    expect(empty.statusCode).toBe(422);
    const missing = await world.server.app.inject({
      method: "POST",
      url: "/economic-actions",
      headers: authHeaders(world),
      payload: { ...economicCreateBody(world), executionId },
    });
    expect(missing.statusCode).toBe(422);
  });

  test("the create contract is CLOSED: unknown body keys are rejected", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "exec-econ-unknown");
    const response = await world.server.app.inject({
      method: "POST",
      url: "/economic-actions",
      headers: { ...authHeaders(world), "idempotency-key": "econ-unknown" },
      payload: {
        ...economicCreateBody(world),
        executionId,
        tenantId: world.tenantId, // client-supplied tenant is unrepresentable
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().message).toContain("unknown keys");
  });

  test("credential-shaped body fields are unrepresentable (recipient is kind+id only)", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "exec-econ-cred");
    const response = await world.server.app.inject({
      method: "POST",
      url: "/economic-actions",
      headers: { ...authHeaders(world), "idempotency-key": "econ-cred" },
      payload: {
        ...economicCreateBody(world),
        executionId,
        recipient: { kind: "merchant", id: "merchant-42", apiKey: "sk_live_123" },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().message).toContain("kind + id only");
  });

  test("a non-existent execution is rejected (provenance binding is physical)", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "POST",
      url: "/economic-actions",
      headers: { ...authHeaders(world), "idempotency-key": "econ-bad-exec" },
      payload: {
        ...economicCreateBody(world),
        executionId: "not-a-uuid-at-all",
      },
    });
    expect(response.statusCode).toBe(422);
  });
});

describe("GET /economic-actions/:id (+events, +outcome) (ECO-006/ECO-007)", () => {
  async function seedAction(world: Awaited<ReturnType<typeof seedApiWorld>>, key: string) {
    const executionId = await seedExecution(world, `exec-${key}`);
    const response = await world.server.app.inject({
      method: "POST",
      url: "/economic-actions",
      headers: { ...authHeaders(world), "idempotency-key": key },
      payload: { ...economicCreateBody(world), executionId },
    });
    return { executionId, actionId: response.json().economicActionId as string };
  }

  test("the action read projects the durable intent record", async () => {
    const world = await seedApiWorld();
    const { actionId } = await seedAction(world, "econ-read-1");
    const response = await world.server.app.inject({
      method: "GET",
      url: `/economic-actions/${actionId}`,
      headers: authHeaders(world),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(actionId);
    expect(body.purpose).toBe("purchase");
    expect(body.recipient).toEqual({ kind: "merchant", id: "merchant-42" });
    expect(body.amount).toEqual({ kind: "exact", microUsd: "125000" });
    expect(body.status).toBe("proposed");
  });

  test("the events read projects the append-only provenance ledger", async () => {
    const world = await seedApiWorld();
    const { actionId } = await seedAction(world, "econ-read-2");
    const response = await world.server.app.inject({
      method: "GET",
      url: `/economic-actions/${actionId}/events`,
      headers: authHeaders(world),
    });
    expect(response.statusCode).toBe(200);
    const events = response.json() as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.type).toBe("action.recorded");
    expect(events[0]?.sequence).toBe(1);
  });

  test("the outcome read reports settlement and delivery as SEPARATE axes (no merged verdict)", async () => {
    const world = await seedApiWorld();
    const { actionId } = await seedAction(world, "econ-read-3");
    const response = await world.server.app.inject({
      method: "GET",
      url: `/economic-actions/${actionId}/outcome`,
      headers: authHeaders(world),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.economicActionId).toBe(actionId);
    expect(body.settlement).toBeNull(); // nothing charged yet
    expect(body.deliveries).toEqual([]); // ...and nothing delivered
    // The two axes exist independently on the projection.
    expect(Object.keys(body)).toEqual(expect.arrayContaining(["settlement", "deliveries"]));
  });

  test("cross-tenant reads are 404 (scope-checked miss — no tenant leak)", async () => {
    const world = await seedApiWorld();
    const { actionId } = await seedAction(world, "econ-read-4");
    const other = await world.server.app.inject({
      method: "GET",
      url: `/economic-actions/${actionId}`,
      // The other tenant resolves through ITS OWN application scope: the
      // world application's action is a scope-checked miss -> 404.
      headers: otherTenantHeaders(world),
    });
    expect(other.statusCode).toBe(404);
  });

  test("a missing action is 404", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "GET",
      url: "/economic-actions/11111111-1111-7000-8000-0000000000ff",
      headers: authHeaders(world),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("the public economic surface carries NO authority mutation route", () => {
  test("authorization/charge/settlement/delivery mutations are not routable", async () => {
    const world = await seedApiWorld();
    const routes = world.server.routes.map((route) => `${route.method} ${route.url}`);
    for (const forbidden of [
      "POST /economic-actions/:id/authorize",
      "POST /economic-actions/:id/charge",
      "POST /economic-actions/:id/settle",
      "POST /economic-actions/:id/delivery",
    ]) {
      expect(routes).not.toContain(forbidden);
    }
  });
});

describe("secret safety of the economic-action projections", () => {
  test("metadata with secret-shaped keys is scrubbed deeply on every projection", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "exec-econ-scrub");
    const response = await world.server.app.inject({
      method: "POST",
      url: "/economic-actions",
      headers: { ...authHeaders(world), "idempotency-key": "econ-scrub" },
      payload: {
        ...economicCreateBody(world),
        executionId,
        metadata: {
          note: "purchase of report generation",
          apiKey: "sk_live_9f8e7d6c",
          nested: { secretToken: "tok-123", safe: 1 },
        },
      },
    });
    expect(response.statusCode).toBe(201);
    const actionId = response.json().economicActionId as string;
    const read = await world.server.app.inject({
      method: "GET",
      url: `/economic-actions/${actionId}`,
      headers: authHeaders(world),
    });
    const body = JSON.stringify(read.json());
    expect(body).not.toContain("sk_live_9f8e7d6c");
    expect(body).not.toContain("tok-123");
    expect(read.json().metadata).toMatchObject({
      note: "purchase of report generation",
      apiKey: "[redacted]",
      nested: { secretToken: "[redacted]", safe: 1 },
    });
  });

  test("no projection response contains credential-shaped field names", async () => {
    const world = await seedApiWorld();
    const executionId = await seedExecution(world, "exec-econ-fields");
    const created = await world.server.app.inject({
      method: "POST",
      url: "/economic-actions",
      headers: { ...authHeaders(world), "idempotency-key": "econ-fields" },
      payload: { ...economicCreateBody(world), executionId },
    });
    const actionId = created.json().economicActionId as string;
    for (const url of [
      `/economic-actions/${actionId}`,
      `/economic-actions/${actionId}/events`,
      `/economic-actions/${actionId}/outcome`,
    ]) {
      const response = await world.server.app.inject({
        method: "GET",
        url,
        headers: authHeaders(world),
      });
      const body = (await response.json()) as unknown;
      for (const forbidden of [
        "cardNumber",
        "card",
        "apiKey",
        "api_key",
        "secret",
        "password",
        "credential",
        "privateKey",
        "stripeToken",
      ]) {
        expect(JSON.stringify(body).toLowerCase()).not.toContain(`"${forbidden.toLowerCase()}"`);
      }
    }
  });
});
