/**
 * Public API agent-inventory route tests (WORK-015; acceptance criterion
 * 7/8, M14/M15/M16/M22/M23).
 *
 * Required-test mapping:
 *  - the four read-only routes project the agent authority (M22: the
 *    projection EQUALS the authority's rows);
 *  - NO agent mutation endpoint exists (M15/M21: every mutating method
 *    of the registry fake records the attempt — the suite proves the
 *    routes never call any of them);
 *  - stale version data is never presented as authoritative (M23: the
 *    status view's active version comes from the CURRENT selection,
 *    not the newest version);
 *  - cross-tenant agent lookups are unreachable (404, no tenant leak);
 *  - WORK-034: every agent route REQUIRES the X-Zeck-Application
 *    selector (the single-sourced server-side rule).
 */

import { describe, expect, test } from "vitest";
import { authHeaders, otherTenantHeaders, seedApiWorld } from "./world";

describe("GET /agents (M16/M22 — read-only projection)", () => {
  test("projects the agent authority's inventory", async () => {
    const world = await seedApiWorld();
    const seeded = world.agentRegistry.seedAgent(
      world.applicationId,
      world.tenantId,
      "support-bot",
    );
    const response = await world.server.app.inject({
      method: "GET",
      url: "/agents",
      headers: authHeaders(world),
    });
    expect(response.statusCode).toBe(200);
    const agents = response.json();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: seeded.agentId,
      slug: "support-bot",
      status: "active",
      activeVersion: "1.0.0",
      activeVersionId: seeded.versionId,
    });
    // M22: the projection equals the authority's row.
    const authority = await world.agentRegistry.getAgent(world.applicationId, seeded.agentId);
    expect(agents[0].id).toBe(authority?.id);
    expect(agents[0].createdAt).toBe(authority?.createdAt);
  });

  test("the inventory view carries no credential/policy material (M14/M15)", async () => {
    const world = await seedApiWorld();
    world.agentRegistry.seedAgent(world.applicationId, world.tenantId, "support-bot");
    const response = await world.server.app.inject({
      method: "GET",
      url: "/agents",
      headers: authHeaders(world),
    });
    const body = JSON.stringify(response.json());
    for (const forbidden of ["credential", "secret", "apiKey", "password", "token"]) {
      expect(body.toLowerCase()).not.toContain(forbidden);
    }
  });

  test("cross-tenant inventory: the other application's agents are not listed", async () => {
    const world = await seedApiWorld();
    world.agentRegistry.seedAgent(world.applicationId, world.tenantId, "app-a-bot");
    const response = await world.server.app.inject({
      method: "GET",
      url: "/agents",
      headers: otherTenantHeaders(world),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});

describe("GET /agents/:id (M22 — the projection equals the authority)", () => {
  test("returns the agent summary with its current selection", async () => {
    const world = await seedApiWorld();
    const seeded = world.agentRegistry.seedAgent(world.applicationId, world.tenantId, "triage");
    const response = await world.server.app.inject({
      method: "GET",
      url: `/agents/${seeded.agentId}`,
      headers: authHeaders(world),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().slug).toBe("triage");
    expect(response.json().activeVersionId).toBe(seeded.versionId);
  });

  test("cross-tenant agent lookup is a 404 (no tenant leak)", async () => {
    const world = await seedApiWorld();
    const seeded = world.agentRegistry.seedAgent(world.applicationId, world.tenantId, "private");
    const response = await world.server.app.inject({
      method: "GET",
      url: `/agents/${seeded.agentId}`,
      headers: otherTenantHeaders(world),
    });
    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(response.json())).not.toContain(world.tenantId);
  });
});

describe("GET /agents/:id/versions (M23 — version lifecycle visibility)", () => {
  test("lists the immutable version artifacts with validation state", async () => {
    const world = await seedApiWorld();
    const seeded = world.agentRegistry.seedAgent(world.applicationId, world.tenantId, "helper");
    const response = await world.server.app.inject({
      method: "GET",
      url: `/agents/${seeded.agentId}/versions`,
      headers: authHeaders(world),
    });
    expect(response.statusCode).toBe(200);
    const versions = response.json();
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      id: seeded.versionId,
      version: "1.0.0",
      validationState: "validated",
    });
    // The definition body stays with the authority: only the digest crosses.
    expect(versions[0].definitionDigest).toMatch(/^digest-/);
    expect(JSON.stringify(versions[0])).not.toContain("instructions");
  });
});

describe("GET /agents/:id/status (M23 — promotion/rollback status)", () => {
  test("the active version follows the CURRENT selection, not the newest version (M23)", async () => {
    const world = await seedApiWorld();
    const seeded = world.agentRegistry.seedAgent(world.applicationId, world.tenantId, "picker");

    // A second version is published but NOT selected: the authority's
    // current selection still names v1. The status view must report v1
    // as active (a stale/misleading newer version is not authoritative).
    const authorityVersions = await world.agentRegistry.listVersions(
      world.applicationId,
      seeded.agentId,
    );
    const now = "2026-09-15T13:00:00Z";
    world.agentRegistry.versions.set(`${world.applicationId}:${seeded.agentId}`, [
      ...(authorityVersions ?? []),
      {
        id: "00000000-0000-7000-a000-000000000099",
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        agentId: seeded.agentId,
        version: "2.0.0",
        definition: authorityVersions?.[0]?.definition ?? ({} as never),
        definitionDigest: "digest-new",
        validationState: "valid",
        validationNotes: null,
        createdAt: now,
      },
    ]);

    const response = await world.server.app.inject({
      method: "GET",
      url: `/agents/${seeded.agentId}/status`,
      headers: authHeaders(world),
    });
    expect(response.statusCode).toBe(200);
    const status = response.json();
    expect(status.agent.activeVersion).toBe("1.0.0");
    expect(status.availableVersions).toHaveLength(2);
    expect(status.latestSelection.selectedVersionId).toBe(seeded.versionId);
    expect(status.activeVersion?.version).toBe("1.0.0");
  });
});

describe("M15/M21 — the public surface exposes NO agent mutation route", () => {
  test("exercising every agent route never calls a mutating registry method", async () => {
    const world = await seedApiWorld();
    const seeded = world.agentRegistry.seedAgent(world.applicationId, world.tenantId, "immutable");
    const urls = [
      "/agents",
      `/agents/${seeded.agentId}`,
      `/agents/${seeded.agentId}/versions`,
      `/agents/${seeded.agentId}/status`,
    ];
    for (const url of urls) {
      await world.server.app.inject({ method: "GET", url, headers: authHeaders(world) });
    }
    // The fake registry records every mutation attempt.
    expect(world.agentRegistry.mutationAttempts).toEqual([]);

    // And the route table itself carries no mutating agent verb.
    const agentRoutes = world.server.routes.filter((route) => route.url.startsWith("/agents"));
    expect(agentRoutes.every((route) => route.method === "GET")).toBe(true);
  });

  test("no route exists for agent identity/version/credential/policy mutation (M21)", () => {
    // Static surface check: the full route table carries ONLY the four
    // read-only agent routes + the execution routes.
    return seedApiWorld().then((world) => {
      const mutatingPatterns = [
        "/agents/:id/register",
        "/agents/:id/versions",
        "/agents/:id/promote",
        "/agents/:id/rollback",
        "/agents/:id/suspend",
        "/agents/:id/credentials",
        "/policies",
        "/budgets",
        "/capabilities",
        "/executions/:id/pass",
        "/executions/:id/authorize",
        "/executions/:id/plan",
      ];
      const urls = world.server.routes.map((route) => `${route.method} ${route.url}`);
      for (const pattern of mutatingPatterns) {
        const post = urls.find((entry) => entry === `POST ${pattern}`);
        expect(post, `mutating route POST ${pattern} must not exist`).toBeUndefined();
      }
      // /agents/:id/versions exists ONLY as GET.
      const versionRoutes = urls.filter((entry) => entry.endsWith("/versions"));
      expect(versionRoutes).toEqual(["GET /agents/:id/versions"]);
    });
  });
});

describe("the application-scope selector (WORK-034)", () => {
  test("agent inventory reads reject a request without the X-Zeck-Application header", async () => {
    const world = await seedApiWorld();
    world.agentRegistry.seedAgent(world.applicationId, world.tenantId, "support-bot");
    for (const url of ["/agents", "/agents/00000000-0000-7000-a000-000000000001/status"]) {
      const response = await world.server.app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${world.bearerToken}` },
      });
      expect(response.statusCode, `GET ${url}`).toBe(422);
      expect(response.json().code).toBe("CAPABILITY_UNAVAILABLE");
      expect(response.json().message).toContain("X-Zeck-Application");
    }
  });
});
