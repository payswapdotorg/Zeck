/**
 * Public API health endpoint tests (WORK-042 AC6) over the REAL
 * Fastify server (fastify.inject — real route/handler execution, no
 * network).
 *
 * Required-test mapping:
 *  - the control-plane/dependency distinction ON THE WIRE: the route
 *    answering IS the control-plane fact; dependencies arrive through
 *    the injected probe and are reported separately;
 *  - fail-closed authority: an authoritative dependency that is not
 *    ready ⇒ 503 + status "down";
 *  - explicit degradation: non-authoristic dependencies ⇒ 200 +
 *    status "degraded" with the degraded mode (never silently
 *    healthy, never silently down);
 *  - secret-free diagnostics: credential-shaped detail values are
 *    scrubbed before crossing the wire;
 *  - probe failure ⇒ fail-closed 503 with no internals.
 */

import { afterEach, describe, expect, test } from "vitest";
import { type ApiServer, createApiServer } from "../../../src/api";
import type { DependencyReadinessWire } from "../../../src/api/routes/health";
import {
  fakeAgentRegistry,
  fakeAuthenticate,
  fakeCodebaseAnalyzer,
  fakeEconomicsService,
  fakeExecutionsService,
  fakeScopeResolver,
} from "../../architecture/lib/public-surface-fakes";

const servers: ApiServer[] = [];

function healthServer(
  dependencyReadiness: () => Promise<readonly DependencyReadinessWire[]>,
): ApiServer {
  const server = createApiServer({
    executions: fakeExecutionsService(),
    agents: fakeAgentRegistry(),
    economics: fakeEconomicsService(),
    scopeResolver: fakeScopeResolver(),
    authenticate: fakeAuthenticate(),
    listAgentIdsOfApplication: async () => [],
    codebaseAnalyzer: fakeCodebaseAnalyzer(),
    dependencyReadiness,
  });
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await server?.app.close();
  }
});

describe("GET /health (WORK-042 AC6)", () => {
  test("ready dependencies ⇒ 200, control plane ready, dependencies listed", async () => {
    const server = healthServer(async () => [
      { name: "relational-state", authority: "authoritative", status: "ready" },
      { name: "ephemeral-coordination", authority: "non-authoritative", status: "ready" },
    ]);
    const response = await server.app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ready");
    expect(body.controlPlane).toBe("ready");
    expect(body.dependencies).toHaveLength(2);
  });

  test("the route answering IS the control-plane fact; no authentication is required", async () => {
    const server = healthServer(async () => []);
    const response = await server.app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().controlPlane).toBe("ready");
  });

  test("an authoritative dependency not ready ⇒ 503 + status down (fail closed)", async () => {
    const server = healthServer(async () => [
      { name: "relational-state", authority: "authoritative", status: "unavailable" },
      { name: "ephemeral-coordination", authority: "non-authoritative", status: "ready" },
    ]);
    const response = await server.app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("down");
    expect(body.controlPlane).toBe("ready"); // the plane itself is UP — the AUTHORITY is down
  });

  test("an authoritative dependency degraded ⇒ still 503 (authority must be ready)", async () => {
    const server = healthServer(async () => [
      { name: "relational-state", authority: "authoritative", status: "degraded" },
    ]);
    const response = await server.app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json().status).toBe("down");
  });

  test("non-authoritative degradation ⇒ 200 + status degraded + the degraded mode", async () => {
    const server = healthServer(async () => [
      { name: "relational-state", authority: "authoritative", status: "ready" },
      {
        name: "ephemeral-coordination",
        authority: "non-authoritative",
        status: "unavailable",
        degradedMode: "coordination-degraded",
      },
    ]);
    const response = await server.app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("degraded");
    expect(body.dependencies[1].degradedMode).toBe("coordination-degraded");
  });

  test("credential-shaped detail values are scrubbed before crossing the wire", async () => {
    const server = healthServer(async () => [
      {
        name: "relational-state",
        authority: "authoritative",
        status: "ready",
        detail: "connected via postgres://postgres:supersecret@127.0.0.1:55432/zeck_local",
      },
      {
        name: "ephemeral-coordination",
        authority: "non-authoritative",
        status: "degraded",
        detail: "token rejected: Bearer abcdefghijklmnopqrstuvwxyz012345",
      },
    ]);
    const response = await server.app.inject({ method: "GET", url: "/health" });
    const serialized = response.body;
    expect(serialized).not.toContain("supersecret");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(serialized).toContain("[redacted]");
  });

  test("a probe failure ⇒ fail-closed 503 with no internals leaked", async () => {
    const server = healthServer(async () => {
      throw new Error("internal diagnostics: postgres://postgres:supersecret@db/zeck");
    });
    const response = await server.app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("down");
    expect(body.dependencies).toEqual([]);
    expect(response.body).not.toContain("supersecret");
    expect(response.body).not.toContain("internal diagnostics");
  });

  test("the route is registered exactly once in the public route table", async () => {
    const server = healthServer(async () => []);
    const health = server.routes.filter((route) => route.url === "/health");
    expect(health).toEqual([{ method: "GET", url: "/health" }]);
  });
});
