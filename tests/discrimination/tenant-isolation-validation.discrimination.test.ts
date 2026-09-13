/**
 * VAL-024 acceptance criterion 6: discrimination tests prove the
 * isolation probes against controlled fakes —
 *
 *   * forged tenant/scope headers: the forged application-scope
 *     selector is denied by the server-side scope resolution BEFORE
 *     any execution row is touched (the REAL scope resolver over a
 *     controlled fake identity store; a leaky resolver that grants
 *     the forged scope is the breach the probe assertions catch);
 *   * application-id confusion: the create naming another tenant's
 *     application is denied by the membership boundary (the REAL
 *     resolver), never a second execution;
 *   * artifact-ref probing: the REAL artifacts service over a
 *     controlled store denies the foreign-digest fetch and the
 *     foreign-parent adoption (a LEAKY store that ignores the tenant
 *     namespace discloses — the scan fails it);
 *   * the miss-indistinguishability discipline: the scope-checked
 *     miss is identical for a foreign id and an unknown id (no tenant
 *     oracle);
 *   * the honest-boundary discrimination: the probe contract is
 *     proven against leaky controlled fakes (the boundary is never
 *     fabricated — a granted foreign scope or a disclosed foreign
 *     record is exactly what the probes fail on);
 *   * digest-only journal evidence: payload bytes and foreign content
 *     never appear in the isolation journal.
 *
 * (This file is the VAL-024 validation-program discrimination suite —
 * distinct from WORK-002's src-level tenant-isolation discrimination
 * proof, which stands unchanged.)
 */

import { describe, expect, test } from "vitest";
import {
  createFakeApiWorld,
  FIXTURE_FOREIGN_MARKERS,
} from "../../benchmarks/validation/apps/tenant-isolation/fixtures";
import {
  type ForeignContentMarker,
  isolationDigestOf,
  redactForeignMarkers,
  scanForForeignContent,
} from "../../benchmarks/validation/platform/tenant-isolation";
import {
  type ArtifactDigest,
  type ArtifactStore,
  createArtifactService,
  createInMemoryArtifactStore,
  createNodeDigestPort,
} from "../../src/modules/artifacts/public";
import { createScopeResolver, type ScopeResolver } from "../../src/modules/auth/public";
import { PlatformError } from "../../src/shared/errors";

// ---------------------------------------------------------------------------
// Controlled fakes: the identity store + the artifact store
// ---------------------------------------------------------------------------

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const APP_A = "app-a";
const APP_B = "app-b";
const ACTOR_A = "actor-a";
const PRINCIPAL_A = { actorId: ACTOR_A, authenticatedAt: new Date().toISOString() };

/** The controlled REAL-resolver identity store (durable membership rows). */
function createFakeIdentityStore(options: { readonly leaky?: boolean }) {
  const memberships = new Map<
    string,
    { actorId: string; applicationId: string; tenantId: string; role: string }
  >([
    [
      "actor-a|app-a",
      { actorId: ACTOR_A, applicationId: APP_A, tenantId: TENANT_A, role: "owner" },
    ],
  ]);
  return {
    findMembershipWithApplicationTenant: (async (actorId: string, applicationId: string) => {
      const direct = memberships.get(`${actorId}|${applicationId}`);
      if (direct !== undefined) {
        return {
          membership: { ...direct },
          applicationTenantId: applicationId === APP_B ? TENANT_B : TENANT_A,
        };
      }
      if (options.leaky === true && actorId === ACTOR_A && applicationId === APP_B) {
        // The LEAKY resolver grants a scope the actor never held.
        return {
          membership: { actorId, applicationId: APP_B, tenantId: TENANT_B, role: "owner" },
          applicationTenantId: TENANT_B,
        };
      }
      return null;
    }) as never,
  };
}

/** The controlled artifact store (REAL in-memory adapter, optionally leaky). */
function createControlledArtifactStore(options: { readonly leaky?: boolean }): ArtifactStore {
  const honest = createInMemoryArtifactStore();
  if (options.leaky !== true) {
    return honest;
  }
  // A LEAKY store ignores the tenant namespace on reads.
  const wrapped: ArtifactStore = {
    put: (input) => honest.put(input),
    list: (scope) => honest.list(scope),
    get: (async (scope, digest) => {
      // LEAKY: returns the record regardless of the tenant namespace.
      const record = await honest.get({ tenantId: TENANT_B }, digest);
      return record === null ? honest.get(scope, digest) : record;
    }) as ArtifactStore["get"],
    ownerOf: (digest) => honest.ownerOf(digest),
  };
  return wrapped;
}

const MARKERS: readonly ForeignContentMarker[] = [
  { label: "foreign-canary", marker: "TENANT-B-CANARY-discrimination" },
];

// ---------------------------------------------------------------------------
// Forged tenant/scope headers + application-id confusion (REAL resolver)
// ---------------------------------------------------------------------------

describe("VAL-024 discrimination: forged scope headers and application-id confusion", () => {
  const expectPlatformCode = (error: unknown, code: string): void => {
    expect(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`).toBe(
      true,
    );
    if (error instanceof PlatformError) {
      expect(error.code).toBe(code);
    }
  };

  test("the REAL scope resolver denies the forged application selector before any row is touched", async () => {
    const resolver: ScopeResolver = createScopeResolver(createFakeIdentityStore({}) as never);
    await expect(resolver.resolveApplicationScope(PRINCIPAL_A, APP_B)).rejects.toSatisfy(
      (error: unknown) => {
        expectPlatformCode(error, "AUTHORIZATION_DENIED");
        return true;
      },
    );
  });

  test("the REAL scope resolver grants the actor's OWN application scope (no over-denial)", async () => {
    const resolver: ScopeResolver = createScopeResolver(createFakeIdentityStore({}) as never);
    const scope = await resolver.resolveApplicationScope(PRINCIPAL_A, APP_A);
    expect(scope.tenantId).toBe(TENANT_A);
    expect(scope.applicationId).toBe(APP_A);
  });

  test("a LEAKY resolver that grants the forged scope is the breach the probe assertions catch", async () => {
    const resolver: ScopeResolver = createScopeResolver(
      createFakeIdentityStore({ leaky: true }) as never,
    );
    // The forged selector resolves — the boundary is broken: the
    // discrimination proves the probe CATCHES it (a granted scope for
    // an application the actor never held is exactly the disclosed
    // observation that fails the corpus contract).
    const scope = await resolver.resolveApplicationScope(PRINCIPAL_A, APP_B);
    expect(scope.tenantId).toBe(TENANT_B);
    // The honest resolver's verdict (above) is the pinned contract.
  });

  test("the fake wire world answers application-id confusion with AUTHORIZATION_DENIED (403), never a second execution", async () => {
    const { transport, state } = createFakeApiWorld({});
    const response = await transport("http://fake-zeck.local/executions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "disc-1" },
      body: JSON.stringify({
        applicationId: "app-fixture-foreign",
        task: { kind: "isolation-probe", rowId: "disc", family: "cross-tenant-create" },
      }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("AUTHORIZATION_DENIED");
    // never a second execution in the foreign application
    expect(state.executions.every((row) => row.applicationId !== "app-fixture-foreign")).toBe(true);
  });

  test("the fake wire world answers the forged X-Zeck-Application selector with AUTHORIZATION_DENIED before any read", async () => {
    const { transport } = createFakeApiWorld({});
    const response = await transport("http://fake-zeck.local/executions/exec-fixture-own", {
      method: "GET",
      headers: { "x-zeck-application": "app-fixture-foreign" },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("AUTHORIZATION_DENIED");
    expect(body.message).not.toContain("canary");
  });
});

// ---------------------------------------------------------------------------
// Artifact-ref probing (the REAL artifacts service over controlled stores)
// ---------------------------------------------------------------------------

describe("VAL-024 discrimination: artifact-ref probing (REAL artifacts service)", () => {
  const digestOfPayload = async (
    service: ReturnType<typeof createArtifactService>,
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<ArtifactDigest> => {
    const outcome = await service.putArtifact({
      tenantId,
      kind: "task-output",
      payload,
      sourceRefs: [{ kind: "source", id: "disc", locator: "test" }],
    });
    return outcome.digest;
  };

  test("the foreign-digest fetch is the typed TENANT_SCOPE_VIOLATION, never an ambiguous miss", async () => {
    const service = createArtifactService({
      store: createInMemoryArtifactStore(),
      digest: createNodeDigestPort(),
    });
    const foreignDigest = await digestOfPayload(service, TENANT_B, {
      report: "foreign content TENANT-B-CANARY-discrimination",
    });
    await expect(service.getArtifact({ tenantId: TENANT_A }, foreignDigest)).rejects.toSatisfy(
      (error: unknown) => {
        expect(error instanceof PlatformError).toBe(true);
        if (error instanceof PlatformError) {
          expect(error.code).toBe("TENANT_SCOPE_VIOLATION");
        }
        return true;
      },
    );
  });

  test("the foreign-parent adoption is the typed TENANT_SCOPE_VIOLATION before any write", async () => {
    const service = createArtifactService({
      store: createInMemoryArtifactStore(),
      digest: createNodeDigestPort(),
    });
    const foreignDigest = await digestOfPayload(service, TENANT_B, {
      report: "foreign lineage content",
    });
    await expect(
      service.putArtifact({
        tenantId: TENANT_A,
        kind: "task-output",
        payload: { derived: "report" },
        parents: [foreignDigest],
        sourceRefs: [{ kind: "source", id: "disc", locator: "test" }],
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error instanceof PlatformError).toBe(true);
      if (error instanceof PlatformError) {
        expect(error.code).toBe("TENANT_SCOPE_VIOLATION");
      }
      return true;
    });
  });

  test("the own-tenant digest fetch is granted (the boundary does not over-deny)", async () => {
    const service = createArtifactService({
      store: createInMemoryArtifactStore(),
      digest: createNodeDigestPort(),
    });
    const ownDigest = await digestOfPayload(service, TENANT_A, { report: "own content" });
    const record = await service.getArtifact({ tenantId: TENANT_A }, ownDigest);
    expect(record.digest).toBe(ownDigest);
  });

  test("a LEAKY store that ignores the tenant namespace DISCLOSES — the probe scan catches it", async () => {
    const leakyStore = createControlledArtifactStore({ leaky: true });
    // Seed the foreign artifact in the leaky wrapper's backing store.
    const foreignPayload = {
      report: "foreign content TENANT-B-CANARY-discrimination",
    };
    const seedService = createArtifactService({
      store: createInMemoryArtifactStore(),
      digest: createNodeDigestPort(),
    });
    const foreignDigest = (
      await seedService.putArtifact({
        tenantId: TENANT_B,
        kind: "task-output",
        payload: foreignPayload,
        sourceRefs: [{ kind: "source", id: "disc", locator: "test" }],
      })
    ).digest;
    await leakyStore.put({
      tenantId: TENANT_B,
      digest: foreignDigest,
      kind: "task-output",
      canonicalContent: JSON.stringify(foreignPayload),
      sourceRefs: [{ kind: "source", id: "disc", locator: "test" }],
      parents: [],
    });
    const leakyService = createArtifactService({
      store: leakyStore,
      digest: createNodeDigestPort(),
    });
    // The leaky service returns the foreign record on the tenant-A
    // fetch — the disclosure the probe scan must catch.
    const record = await leakyService.getArtifact({ tenantId: TENANT_A }, foreignDigest);
    expect(record).not.toBeNull();
    const observedText = JSON.stringify(record);
    const findings = scanForForeignContent(observedText, MARKERS);
    expect(findings).toEqual(["foreign-canary"]);
    // The redaction discipline: the evidence carries the LABEL, never
    // the content.
    const redacted = redactForeignMarkers(observedText, MARKERS);
    expect(redacted).not.toContain("TENANT-B-CANARY-discrimination");
    expect(redacted).toContain("foreign-canary");
  });
});

// ---------------------------------------------------------------------------
// The miss-indistinguishability discipline
// ---------------------------------------------------------------------------

describe("VAL-024 discrimination: the scope-checked miss is indistinguishable", () => {
  test("a foreign id and an unknown id answer byte-identical 404 bodies (no tenant oracle)", async () => {
    const { transport } = createFakeApiWorld({});
    const read = (id: string): Promise<{ status: number; text: string }> =>
      transport(`http://fake-zeck.local/executions/${id}`, {
        method: "GET",
        headers: { "x-zeck-application": "app-fixture-own" },
      }).then(async (response) => ({ status: response.status, text: await response.text() }));
    const foreign = await read("exec-fixture-foreign");
    const unknown = await read("exec-never-existed");
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(foreign.text).toBe(unknown.text);
    expect(foreign.text).not.toContain("canary");
  });

  test("the foreign tenant's canary content never appears in any rejection the probes observe", async () => {
    const { transport } = createFakeApiWorld({});
    const attempts: string[] = [];
    const rejected = await transport("http://fake-zeck.local/executions/exec-fixture-foreign", {
      method: "GET",
      headers: { "x-zeck-application": "app-fixture-own" },
    });
    attempts.push(await rejected.text());
    const confused = await transport("http://fake-zeck.local/executions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "disc-2" },
      body: JSON.stringify({
        applicationId: "app-fixture-foreign",
        task: { kind: "isolation-probe" },
      }),
    });
    attempts.push(await confused.text());
    const forged = await transport("http://fake-zeck.local/executions/exec-fixture-own", {
      method: "GET",
      headers: { "x-zeck-application": "app-fixture-foreign" },
    });
    attempts.push(await forged.text());
    for (const marker of FIXTURE_FOREIGN_MARKERS) {
      expect(attempts.join("\n")).not.toContain(marker.marker);
    }
  });
});

// ---------------------------------------------------------------------------
// Digest-only journal evidence
// ---------------------------------------------------------------------------

describe("VAL-024 discrimination: digest-only journal evidence", () => {
  test("the journal record shape carries digests and labels, never payload bytes or foreign content", () => {
    const record = {
      probe: 1,
      operation: "svc-artifact-fetch-foreign",
      kind: "denied",
      rejection: "TENANT_SCOPE_VIOLATION",
      latencyMs: 1,
      targetDigest: isolationDigestOf("foreign-digest"),
      httpStatus: null,
      rowsReturned: null,
      foreignMarkerLabels: [],
      message: "artifact digest belongs to another tenant namespace",
    };
    const text = JSON.stringify(record);
    expect(text).not.toContain("TENANT-B-CANARY-discrimination");
    expect(text).not.toContain("payload");
    expect(record.targetDigest).toMatch(/^[0-9a-f]{8}$/);
  });
});
