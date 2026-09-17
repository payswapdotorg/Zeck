/**
 * Public API identity endpoint tests (DEP-001 AC2) over the REAL
 * Fastify server (fastify.inject — real route/handler execution, no
 * network).
 *
 * Required-test mapping:
 *  - BOUND: with the deployment identity seam bound, GET /identity
 *    answers 200 with the runtime identity document (status "bound",
 *    the exact revision, the manifest digest, the topology digest and
 *    the provider topology projection);
 *  - UNBOUND: without the seam, the route still registers and answers
 *    the honest fail-closed 503 `unbound` state — never a fabricated
 *    identity (the route table stays identical across compositions);
 *  - UNATTESTABLE: a seam that fails answers the fail-closed 503
 *    `unattestable` state with no internals leaked;
 *  - SECRET-FREE: the response is scrubbed (secret-shaped keys never
 *    cross the wire).
 */

import { afterEach, describe, expect, test } from "vitest";
import { type ApiServer, createApiServer } from "../../../src/api";
import type { RuntimeIdentityWire } from "../../../src/api/routes/identity";
import {
  fakeAgentRegistry,
  fakeAuthenticate,
  fakeCodebaseAnalyzer,
  fakeEconomicsService,
  fakeExecutionsService,
  fakeScopeResolver,
} from "../../architecture/lib/public-surface-fakes";

const servers: ApiServer[] = [];

function identityServer(deploymentIdentity?: () => Promise<RuntimeIdentityWire | null>): ApiServer {
  const server = createApiServer({
    executions: fakeExecutionsService(),
    agents: fakeAgentRegistry(),
    economics: fakeEconomicsService(),
    scopeResolver: fakeScopeResolver(),
    authenticate: fakeAuthenticate(),
    listAgentIdsOfApplication: async () => [],
    codebaseAnalyzer: fakeCodebaseAnalyzer(),
    dependencyReadiness: async () => [],
    ...(deploymentIdentity === undefined ? {} : { deploymentIdentity }),
  });
  servers.push(server);
  return server;
}

function boundDocument(): RuntimeIdentityWire {
  return {
    schemaVersion: 1,
    runtimeIdentityId: "e".repeat(64),
    identity: {
      schemaVersion: 1,
      identityId: "f".repeat(64),
      gitRevision: "a".repeat(40),
      environment: "staging",
      manifestDigest: "1".repeat(64),
      resourceDigest: "2".repeat(64),
    },
    topologyDigest: "3".repeat(64),
    providerTopology: [
      {
        concern: "relational-state",
        provider: "neon",
        authorityRole: "authoritative",
        substitutionTarget: "managed PostgreSQL provider",
        tierClass: "provider-free-tier",
        tierName: "Neon Free",
      },
    ],
  };
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await server.app.close();
    }
  }
});

describe("GET /identity (DEP-001 AC2)", () => {
  test("bound: answers 200 with the runtime identity document", async () => {
    const server = identityServer(async () => boundDocument());
    const response = await server.app.inject({ method: "GET", url: "/identity" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.status).toBe("bound");
    expect(body.runtimeIdentityId).toBe("e".repeat(64));
    const identity = body.identity as Record<string, unknown>;
    expect(identity.gitRevision).toBe("a".repeat(40));
    expect(identity.manifestDigest).toBe("1".repeat(64));
    const topology = body.providerTopology as Record<string, unknown>[];
    expect(topology).toHaveLength(1);
    expect(topology[0]?.concern).toBe("relational-state");
    expect(topology[0]?.tierClass).toBe("provider-free-tier");
  });

  test("unbound: the honest fail-closed 503, never a fabricated identity", async () => {
    const server = identityServer();
    const response = await server.app.inject({ method: "GET", url: "/identity" });
    expect(response.statusCode).toBe(503);
    const body = response.json() as Record<string, unknown>;
    expect(body.status).toBe("unbound");
    expect(body.reason).toContain("deployment identity seam is not bound");
    expect(body.gitRevision).toBeUndefined();
    expect(body.runtimeIdentityId).toBeUndefined();
  });

  test("a seam returning null answers the fail-closed unbound state", async () => {
    const server = identityServer(async () => null);
    const response = await server.app.inject({ method: "GET", url: "/identity" });
    expect(response.statusCode).toBe(503);
    const body = response.json() as Record<string, unknown>;
    expect(body.status).toBe("unbound");
    expect(body.reason).toContain("returned no document");
  });

  test("a failing seam answers the fail-closed unattestable state with no internals", async () => {
    const server = identityServer(async () => {
      throw new Error("internal: connection to manifest store at postgres://user:pw@host failed");
    });
    const response = await server.app.inject({ method: "GET", url: "/identity" });
    expect(response.statusCode).toBe(503);
    const body = response.json() as Record<string, unknown>;
    expect(body.status).toBe("unattestable");
    expect(response.body).not.toContain("postgres://user:pw@host");
    expect(response.body).not.toContain("internal:");
  });

  test("the response is scrubbed: secret-shaped values never cross the wire", async () => {
    const tainted = boundDocument() as unknown as Record<string, unknown>;
    tainted.apiKey = "supersecretvalue123456";
    const server = identityServer(async () => tainted as unknown as RuntimeIdentityWire);
    const response = await server.app.inject({ method: "GET", url: "/identity" });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("supersecretvalue123456");
    const body = response.json() as Record<string, unknown>;
    expect(body.apiKey).toBe("[redacted]");
  });

  test("the route is part of the public route table in every composition", async () => {
    for (const server of [identityServer(), identityServer(async () => boundDocument())]) {
      const routes = server.routes.map((route) => `${route.method} ${route.url}`);
      expect(routes).toContain("GET /identity");
    }
  });
});
