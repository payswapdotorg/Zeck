/**
 * Public API credential endpoint tests (DEP-011 acceptance criteria
 * 1–7) over the REAL Fastify server through the shared world (the REAL
 * credential authority over the in-memory stores — the same world the
 * machine-manifest reconciliation rides).
 *
 * Required-test mapping:
 *  - POST /credentials issues through the authority: 201 + the show-once
 *    secret + the metadata-only record;
 *  - idempotent replay returns the record with secret=null (the durable
 *    outcome never contains material);
 *  - GET /credentials lists metadata-only, scope-checked, with the honest
 *    issuance fact;
 *  - rotation and revocation through the authority, reflected in the list;
 *  - revocation idempotent convergence;
 *  - the scope guards: cross-tenant mutations fail TENANT_SCOPE_VIOLATION;
 *  - strict body-key rejection, mandatory Idempotency-Key, the
 *    X-Zeck-Application requirement on scoped reads;
 *  - SECRET-SAFETY PROBES (AC5): hostile secret material never crosses the
 *    serialization boundary — no response contains the secret except the
 *    first issue/rotate response, and no response/log line/shape carries
 *    the transport token.
 */

import { describe, expect, test } from "vitest";
import { authHeaders, otherTenantHeaders, seedApiWorld } from "./world";

describe("POST /credentials (issue — AC1)", () => {
  test("issues a scoped credential and returns the show-once secret with the metadata record", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "POST",
      url: "/credentials",
      headers: { ...authHeaders(world), "idempotency-key": "issue-1" },
      payload: {
        applicationId: world.applicationId,
        label: "ci integration",
        role: "member",
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.replayed).toBe(false);
    expect(body.secret).toMatch(/^zeck-test-secret-\d+$/);
    expect(body.credential.label).toBe("ci integration");
    expect(body.credential.role).toBe("member");
    expect(body.credential.status).toBe("active");
    expect(body.credential.id).toBe(body.credential.credentialId);
    expect(body.credential.permissions).toContain("applications:read");
    // The metadata record carries no secret-shaped field at all.
    expect(Object.keys(body.credential)).toEqual([
      "id",
      "credentialId",
      "applicationId",
      "label",
      "role",
      "status",
      "createdAt",
      "rotatedAt",
      "supersededBy",
      "permissions",
    ]);
  });

  test("a replay of the same idempotency key returns the record with NO secret", async () => {
    const world = await seedApiWorld();
    const payload = {
      applicationId: world.applicationId,
      label: "ci integration",
      role: "member",
    };
    const first = await world.server.app.inject({
      method: "POST",
      url: "/credentials",
      headers: { ...authHeaders(world), "idempotency-key": "same-key" },
      payload,
    });
    const replay = await world.server.app.inject({
      method: "POST",
      url: "/credentials",
      headers: { ...authHeaders(world), "idempotency-key": "same-key" },
      payload,
    });
    expect(replay.statusCode).toBe(201);
    const body = replay.json();
    expect(body.replayed).toBe(true);
    expect(body.secret).toBeNull();
    expect(body.credential.id).toBe(first.json().credential.id);
  });

  test("same key + different payload → 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const world = await seedApiWorld();
    await world.server.app.inject({
      method: "POST",
      url: "/credentials",
      headers: { ...authHeaders(world), "idempotency-key": "clash" },
      payload: { applicationId: world.applicationId, label: "one", role: "member" },
    });
    const conflicting = await world.server.app.inject({
      method: "POST",
      url: "/credentials",
      headers: { ...authHeaders(world), "idempotency-key": "clash" },
      payload: { applicationId: world.applicationId, label: "two", role: "member" },
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("a missing Idempotency-Key is rejected", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "POST",
      url: "/credentials",
      headers: authHeaders(world),
      payload: { applicationId: world.applicationId, label: "ci", role: "member" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("CAPABILITY_UNAVAILABLE");
  });

  test("unknown body keys are rejected fail-closed", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "POST",
      url: "/credentials",
      headers: { ...authHeaders(world), "idempotency-key": "unknown-keys" },
      payload: {
        applicationId: world.applicationId,
        label: "ci",
        role: "member",
        secret: "injected-by-client",
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("CAPABILITY_UNAVAILABLE");
  });

  test("a malformed role is rejected fail-closed", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "POST",
      url: "/credentials",
      headers: { ...authHeaders(world), "idempotency-key": "bad-role" },
      payload: { applicationId: world.applicationId, label: "ci", role: "superuser" },
    });
    expect(response.statusCode).toBe(422);
  });

  test("an unauthenticated caller is rejected (401)", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "POST",
      url: "/credentials",
      headers: {
        "content-type": "application/json",
        "x-zeck-application": world.applicationId,
        "idempotency-key": "no-auth",
      },
      payload: { applicationId: world.applicationId, label: "ci", role: "member" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /credentials (list — AC2)", () => {
  test("lists the scope's credentials metadata-only with the issuance fact", async () => {
    const world = await seedApiWorld();
    await world.server.app.inject({
      method: "POST",
      url: "/credentials",
      headers: { ...authHeaders(world), "idempotency-key": "issue-list" },
      payload: { applicationId: world.applicationId, label: "ci integration", role: "admin" },
    });
    const response = await world.server.app.inject({
      method: "GET",
      url: "/credentials",
      headers: authHeaders(world),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0].label).toBe("ci integration");
    expect(body.issuance.enabled).toBe(true);
    // AC5: the list response contains no secret material anywhere.
    const text = response.body;
    expect(text).not.toContain("zeck-test-secret");
  });

  test("a scoped read without the X-Zeck-Application header is rejected", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "GET",
      url: "/credentials",
      headers: { authorization: `Bearer ${world.bearerToken}` },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("CAPABILITY_UNAVAILABLE");
  });

  test("another tenant's application scope sees only its own credentials", async () => {
    const world = await seedApiWorld();
    await world.server.app.inject({
      method: "POST",
      url: "/credentials",
      headers: { ...authHeaders(world), "idempotency-key": "issue-mine" },
      payload: { applicationId: world.applicationId, label: "mine", role: "member" },
    });
    const other = await world.server.app.inject({
      method: "GET",
      url: "/credentials",
      headers: otherTenantHeaders(world),
    });
    expect(other.statusCode).toBe(200);
    expect(other.json().credentials).toHaveLength(0);
  });
});

describe("POST /credentials/:credentialId/rotate (AC3)", () => {
  test("issues the show-once successor and retires the predecessor, reflected in the list", async () => {
    const world = await seedApiWorld();
    const issued = (
      await world.server.app.inject({
        method: "POST",
        url: "/credentials",
        headers: { ...authHeaders(world), "idempotency-key": "issue-rot" },
        payload: { applicationId: world.applicationId, label: "ci integration", role: "member" },
      })
    ).json();
    const rotated = await world.server.app.inject({
      method: "POST",
      url: `/credentials/${issued.credential.credentialId}/rotate`,
      headers: { ...authHeaders(world), "idempotency-key": "rotate-1" },
      payload: {},
    });
    expect(rotated.statusCode).toBe(200);
    const body = rotated.json();
    expect(body.replayed).toBe(false);
    expect(body.secret).toMatch(/^zeck-test-secret-\d+$/);
    expect(body.secret).not.toBe(issued.secret);
    expect(body.credential.credentialId).toBe(issued.credential.credentialId);
    expect(body.credential.id).not.toBe(issued.credential.id);

    // Both rotation outcomes are reflected in the list.
    const list = await world.server.app.inject({
      method: "GET",
      url: "/credentials",
      headers: authHeaders(world),
    });
    const credentials = list.json().credentials as {
      id: string;
      status: string;
      rotatedAt: string | null;
      supersededBy: string | null;
    }[];
    const predecessor = credentials.find((row) => row.id === issued.credential.id);
    const successor = credentials.find((row) => row.id === body.credential.id);
    expect(predecessor?.status).toBe("retired");
    expect(predecessor?.supersededBy).toBe(body.credential.id);
    expect(predecessor?.rotatedAt).not.toBeNull();
    expect(successor?.status).toBe("active");
  });

  test("a rotation replay returns the successor with NO secret", async () => {
    const world = await seedApiWorld();
    const issued = (
      await world.server.app.inject({
        method: "POST",
        url: "/credentials",
        headers: { ...authHeaders(world), "idempotency-key": "issue-rot-2" },
        payload: { applicationId: world.applicationId, label: "ci", role: "member" },
      })
    ).json();
    const url = `/credentials/${issued.credential.credentialId}/rotate`;
    await world.server.app.inject({
      method: "POST",
      url,
      headers: { ...authHeaders(world), "idempotency-key": "rotate-once" },
      payload: {},
    });
    const replay = await world.server.app.inject({
      method: "POST",
      url,
      headers: { ...authHeaders(world), "idempotency-key": "rotate-once" },
      payload: {},
    });
    expect(replay.statusCode).toBe(200);
    const body = replay.json();
    expect(body.replayed).toBe(true);
    expect(body.secret).toBeNull();
  });

  test("cross-tenant rotation fails TENANT_SCOPE_VIOLATION (AC6)", async () => {
    const world = await seedApiWorld();
    const issued = (
      await world.server.app.inject({
        method: "POST",
        url: "/credentials",
        headers: { ...authHeaders(world), "idempotency-key": "issue-cross" },
        payload: { applicationId: world.applicationId, label: "mine", role: "member" },
      })
    ).json();
    const response = await world.server.app.inject({
      method: "POST",
      url: `/credentials/${issued.credential.credentialId}/rotate`,
      headers: { ...otherTenantHeaders(world), "idempotency-key": "rotate-cross" },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("TENANT_SCOPE_VIOLATION");
  });

  test("unknown body keys on the mutation routes are rejected", async () => {
    const world = await seedApiWorld();
    const issued = (
      await world.server.app.inject({
        method: "POST",
        url: "/credentials",
        headers: { ...authHeaders(world), "idempotency-key": "issue-keys" },
        payload: { applicationId: world.applicationId, label: "ci", role: "member" },
      })
    ).json();
    const response = await world.server.app.inject({
      method: "POST",
      url: `/credentials/${issued.credential.credentialId}/rotate`,
      headers: { ...authHeaders(world), "idempotency-key": "rotate-keys" },
      payload: { label: "sneaky relabel" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("CAPABILITY_UNAVAILABLE");
  });
});

describe("POST /credentials/:credentialId/revoke (AC3, AC6)", () => {
  test("revokes immediately; a second revoke with a NEW key converges", async () => {
    const world = await seedApiWorld();
    const issued = (
      await world.server.app.inject({
        method: "POST",
        url: "/credentials",
        headers: { ...authHeaders(world), "idempotency-key": "issue-rev" },
        payload: { applicationId: world.applicationId, label: "ci", role: "member" },
      })
    ).json();
    const first = await world.server.app.inject({
      method: "POST",
      url: `/credentials/${issued.credential.credentialId}/revoke`,
      headers: { ...authHeaders(world), "idempotency-key": "revoke-1" },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().credential.status).toBe("revoked");
    const second = await world.server.app.inject({
      method: "POST",
      url: `/credentials/${issued.credential.credentialId}/revoke`,
      headers: { ...authHeaders(world), "idempotency-key": "revoke-2" },
      payload: {},
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().credential.status).toBe("revoked");
    expect(second.json().credential.id).toBe(first.json().credential.id);

    const list = await world.server.app.inject({
      method: "GET",
      url: "/credentials",
      headers: authHeaders(world),
    });
    expect(
      (list.json().credentials as { status: string }[]).every((row) => row.status === "revoked"),
    ).toBe(true);
  });

  test("cross-tenant revocation fails TENANT_SCOPE_VIOLATION (AC6)", async () => {
    const world = await seedApiWorld();
    const issued = (
      await world.server.app.inject({
        method: "POST",
        url: "/credentials",
        headers: { ...authHeaders(world), "idempotency-key": "issue-cross-rev" },
        payload: { applicationId: world.applicationId, label: "mine", role: "member" },
      })
    ).json();
    const response = await world.server.app.inject({
      method: "POST",
      url: `/credentials/${issued.credential.credentialId}/revoke`,
      headers: { ...otherTenantHeaders(world), "idempotency-key": "revoke-cross" },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("TENANT_SCOPE_VIOLATION");
  });
});

describe("secret-safety probes over every new route response (AC5)", () => {
  test("the secret appears on exactly one response: the creating one", async () => {
    const world = await seedApiWorld();
    const issue = await world.server.app.inject({
      method: "POST",
      url: "/credentials",
      headers: { ...authHeaders(world), "idempotency-key": "probe-issue" },
      payload: { applicationId: world.applicationId, label: "probe", role: "member" },
    });
    const secret = issue.json().secret as string;

    // Every OTHER route/response of the surface carries no secret material.
    const replay = await world.server.app.inject({
      method: "POST",
      url: "/credentials",
      headers: { ...authHeaders(world), "idempotency-key": "probe-issue" },
      payload: { applicationId: world.applicationId, label: "probe", role: "member" },
    });
    expect(replay.body).not.toContain(secret);
    const list = await world.server.app.inject({
      method: "GET",
      url: "/credentials",
      headers: authHeaders(world),
    });
    expect(list.body).not.toContain(secret);
    const credentialId = issue.json().credential.credentialId as string;
    const rotate = await world.server.app.inject({
      method: "POST",
      url: `/credentials/${credentialId}/rotate`,
      headers: { ...authHeaders(world), "idempotency-key": "probe-rotate" },
      payload: {},
    });
    const rotatedSecret = rotate.json().secret as string;
    expect(rotate.body).not.toContain(secret);
    const rotateReplay = await world.server.app.inject({
      method: "POST",
      url: `/credentials/${credentialId}/rotate`,
      headers: { ...authHeaders(world), "idempotency-key": "probe-rotate" },
      payload: {},
    });
    expect(rotateReplay.body).not.toContain(rotatedSecret);
    const revoke = await world.server.app.inject({
      method: "POST",
      url: `/credentials/${credentialId}/revoke`,
      headers: { ...authHeaders(world), "idempotency-key": "probe-revoke" },
      payload: {},
    });
    expect(revoke.body).not.toContain(rotatedSecret);
    expect(revoke.body).not.toContain(secret);
  });

  test("the transport token never crosses any response", async () => {
    const world = await seedApiWorld();
    for (const probe of [
      { method: "GET" as const, url: "/credentials", payload: undefined },
      {
        method: "POST" as const,
        url: "/credentials",
        payload: { applicationId: world.applicationId, label: "token probe", role: "member" },
      },
    ]) {
      const response = await world.server.app.inject({
        method: probe.method,
        url: probe.url,
        headers: { ...authHeaders(world), "idempotency-key": "token-probe" },
        ...(probe.payload === undefined ? {} : { payload: probe.payload }),
      });
      expect(response.body).not.toContain(world.bearerToken);
    }
  });

  test("a hostile secret-shaped payload key is rejected (and never echoed)", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "POST",
      url: "/credentials",
      headers: { ...authHeaders(world), "idempotency-key": "hostile" },
      payload: {
        applicationId: world.applicationId,
        label: "hostile",
        role: "member",
        api_key: "sk-hostile-should-never-cross-1234567890",
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).not.toContain("sk-hostile-should-never-cross-1234567890");
  });
});
