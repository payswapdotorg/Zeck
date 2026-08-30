/**
 * Unit: scope resolver and cross-tenant guard with an in-memory fake store
 * (acceptance criteria 3 and 4, PG-free fast paths).
 */

import { describe, expect, test } from "vitest";
import type { IdentityStore, MembershipRecord } from "../../src/modules/auth/public";
import { assertScopeCovers, createScopeResolver } from "../../src/modules/auth/public";
import { PlatformError } from "../../src/shared/errors";

const membership = (over: Partial<MembershipRecord>): MembershipRecord => ({
  id: "m1",
  actorId: "actor-1",
  applicationId: "app-1",
  tenantId: "tenant-1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

function fakeStore(over: {
  rows?: Map<string, { membership: MembershipRecord; applicationTenantId: string | null }>;
  tenantRows?: Map<string, MembershipRecord>;
}): IdentityStore {
  const notImplemented = (name: string) => () => {
    throw new Error(`not implemented in fake: ${name}`);
  };
  return {
    provisionActor: notImplemented("provisionActor") as never,
    findActor: (async () => null) as never,
    findMembershipWithApplicationTenant: (async (actorId: string, applicationId: string) =>
      over.rows?.get(`${actorId}:${applicationId}`) ?? null) as never,
    findTenantMembership: (async (actorId: string, tenantId: string) =>
      over.tenantRows?.get(`${actorId}:${tenantId}`) ?? null) as never,
    listMemberships: (async () => []) as never,
    insertMembership: notImplemented("insertMembership") as never,
    updateMembershipRole: notImplemented("updateMembershipRole") as never,
    deleteMembership: notImplemented("deleteMembership") as never,
    countApplicationOwners: (async () => 1) as never,
  };
}

const principal = { actorId: "actor-1", authenticatedAt: "2026-01-01T00:00:00.000Z" };

describe("resolveApplicationScope derives the tenant from durable ownership", () => {
  test("membership + application row yield a scope whose tenant is the APPLICATION's tenant", async () => {
    const store = fakeStore({
      rows: new Map([
        ["actor-1:app-1", { membership: membership({}), applicationTenantId: "tenant-1" }],
      ]),
    });
    const scope = await createScopeResolver(store).resolveApplicationScope(principal, "app-1");
    expect(scope).toEqual({
      tenantId: "tenant-1",
      applicationId: "app-1",
      origin: "application-membership",
    });
  });

  test("no membership → AUTHORIZATION_DENIED (no tenant leak)", async () => {
    const resolver = createScopeResolver(fakeStore({}));
    await expect(resolver.resolveApplicationScope(principal, "app-x")).rejects.toMatchObject({
      code: "AUTHORIZATION_DENIED",
    });
  });

  test("unauthenticated shape → AUTHENTICATION_FAILED", async () => {
    const resolver = createScopeResolver(fakeStore({}));
    await expect(
      resolver.resolveApplicationScope({ actorId: "", authenticatedAt: "" }, "app-1"),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  test("durable inconsistency (membership tenant ≠ application tenant) → TENANT_SCOPE_VIOLATION, never a usable scope", async () => {
    const store = fakeStore({
      rows: new Map([
        [
          "actor-1:app-1",
          { membership: membership({ tenantId: "tenant-2" }), applicationTenantId: "tenant-1" },
        ],
      ]),
    });
    await expect(
      createScopeResolver(store).resolveApplicationScope(principal, "app-1"),
    ).rejects.toMatchObject({
      code: "TENANT_SCOPE_VIOLATION",
    });
  });
});

describe("resolveTenantScope (tenant-level authority)", () => {
  test("tenant-scope owner membership qualifies", async () => {
    const store = fakeStore({
      tenantRows: new Map([
        [
          "actor-1:tenant-1",
          membership({ applicationId: null, tenantId: "tenant-1", role: "owner" }),
        ],
      ]),
    });
    const scope = await createScopeResolver(store).resolveTenantScope(principal, "tenant-1");
    expect(scope).toEqual({
      tenantId: "tenant-1",
      applicationId: null,
      origin: "tenant-membership",
    });
  });

  test("non-owner tenant membership and application memberships do not qualify", async () => {
    const store = fakeStore({
      tenantRows: new Map([
        ["actor-1:tenant-1", membership({ applicationId: null, role: "member" })],
      ]),
    });
    await expect(
      createScopeResolver(store).resolveTenantScope(principal, "tenant-1"),
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_DENIED",
    });
  });
});

describe("requirePermission", () => {
  const resolver = createScopeResolver(fakeStore({}));

  test("application scope: role permissions apply", () => {
    const appScope = {
      tenantId: "tenant-1",
      applicationId: "app-1",
      origin: "application-membership",
    } as const;
    expect(() =>
      resolver.requirePermission(appScope, membership({ role: "member" }), "applications:read"),
    ).not.toThrow();
    expect(() =>
      resolver.requirePermission(appScope, membership({ role: "member" }), "memberships:write"),
    ).toThrow(PlatformError);
  });

  test("membership must belong to the scope (target mismatch denied)", () => {
    const appScope = {
      tenantId: "tenant-1",
      applicationId: "app-1",
      origin: "application-membership",
    } as const;
    expect(() =>
      resolver.requirePermission(
        appScope,
        membership({ applicationId: "app-other", role: "owner" }),
        "memberships:write",
      ),
    ).toThrow(PlatformError);
  });

  test("tenant scope: owner carries everything", () => {
    const tenantScope = {
      tenantId: "tenant-1",
      applicationId: null,
      origin: "tenant-membership",
    } as const;
    for (const permission of ["tenant:write", "memberships:write"] as const) {
      expect(() =>
        resolver.requirePermission(
          tenantScope,
          membership({ applicationId: null, role: "owner" }),
          permission,
        ),
      ).not.toThrow();
    }
  });
});

describe("assertScopeCovers (cross-tenant guard)", () => {
  const scope = {
    tenantId: "tenant-1",
    applicationId: "app-1",
    origin: "application-membership",
  } as const;

  test("matching tenant passes", () => {
    expect(() =>
      assertScopeCovers(scope, "tenant-1", { kind: "application", id: "app-1" }),
    ).not.toThrow();
  });

  test("mismatching tenant throws TENANT_SCOPE_VIOLATION with target identity in details", () => {
    expect(() =>
      assertScopeCovers(scope, "tenant-2", { kind: "environment", id: "env-9" }),
    ).toThrow(PlatformError);
    try {
      assertScopeCovers(scope, "tenant-2", { kind: "environment", id: "env-9" });
    } catch (error) {
      expect((error as PlatformError).code).toBe("TENANT_SCOPE_VIOLATION");
      expect((error as PlatformError).details).toMatchObject({
        targetId: "env-9",
        scopeTenantId: "tenant-1",
        targetTenantId: "tenant-2",
      });
    }
  });
});
