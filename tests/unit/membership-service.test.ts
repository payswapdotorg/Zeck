/**
 * Unit: membership service with an in-memory fake store and a fake
 * idempotency arbiter (authorization + guards, PG-free fast paths).
 */

import { describe, expect, test } from "vitest";
import type {
  IdempotencyPort,
  IdentityStore,
  MembershipRecord,
} from "../../src/modules/auth/public";
import { createMembershipService, createScopeResolver } from "../../src/modules/auth/public";
import type { PlatformError } from "../../src/shared/errors";

interface StoreState {
  actors: Set<string>;
  memberships: MembershipRecord[];
  deleted: string[];
}

function fakeStore(state: StoreState): IdentityStore {
  return {
    provisionActor: (async (input: { id: string; displayName: string }) => ({
      id: input.id,
      externalSubject: null,
      displayName: input.displayName,
      createdAt: "2026-01-01T00:00:00.000Z",
    })) as never,
    findActor: (async (id: string) => (state.actors.has(id) ? { id } : null)) as never,
    findMembershipWithApplicationTenant: (async (actorId: string, applicationId: string) => {
      const found = state.memberships.find(
        (m) => m.actorId === actorId && m.applicationId === applicationId,
      );
      return found ? { membership: found, applicationTenantId: found.tenantId } : null;
    }) as never,
    findTenantMembership: (async (actorId: string, tenantId: string) =>
      state.memberships.find(
        (m) => m.actorId === actorId && m.tenantId === tenantId && m.applicationId === null,
      ) ?? null) as never,
    listMemberships: (async (filter: { applicationId?: string; tenantId?: string }) =>
      state.memberships.filter(
        (m) =>
          (filter.applicationId === undefined || m.applicationId === filter.applicationId) &&
          (filter.tenantId === undefined || m.tenantId === filter.tenantId),
      )) as never,
    insertMembership: (async (input: {
      id: string;
      actorId: string;
      applicationId: string | null;
      tenantId: string;
      role: "owner" | "admin" | "member";
    }) => {
      const duplicate = state.memberships.find(
        (m) => m.actorId === input.actorId && m.applicationId === input.applicationId,
      );
      if (duplicate) {
        return null;
      }
      const record: MembershipRecord = {
        id: input.id,
        actorId: input.actorId,
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        role: input.role,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      state.memberships.push(record);
      return record;
    }) as never,
    updateMembershipRole: (async (membershipId: string, role: "owner" | "admin" | "member") => {
      const index = state.memberships.findIndex((m) => m.id === membershipId);
      if (index === -1) {
        return null;
      }
      const current = state.memberships[index];
      if (!current) {
        return null;
      }
      const updated = { ...current, role };
      state.memberships[index] = updated;
      return updated;
    }) as never,
    deleteMembership: (async (id: string) => {
      const index = state.memberships.findIndex((m) => m.id === id);
      if (index === -1) {
        return false;
      }
      state.memberships.splice(index, 1);
      state.deleted.push(id);
      return true;
    }) as never,
    countApplicationOwners: (async (applicationId: string) =>
      state.memberships.filter((m) => m.applicationId === applicationId && m.role === "owner")
        .length) as never,
  };
}

/** Fake arbiter: executes work once per key and replays the stored outcome. */
function fakeIdempotency(store: IdentityStore): IdempotencyPort & { executions: number } {
  const ledger = new Map<string, unknown>();
  return {
    executions: 0,
    arbitrate: (async (
      scope: { actorId: string; applicationId: string | null },
      operationName: string,
      key: string,
      _fingerprint: string,
      work: (store: IdentityStore) => Promise<unknown>,
    ) => {
      const ledgerKey = `${scope.actorId}|${scope.applicationId}|${operationName}|${key}`;
      if (ledger.has(ledgerKey)) {
        return { outcome: ledger.get(ledgerKey), replayed: true };
      }
      const outcome = await work(store);
      ledger.set(ledgerKey, outcome);
      return { outcome, replayed: false };
    }) as never,
  } as never;
}

function build(state: StoreState) {
  const store = fakeStore(state);
  const resolver = createScopeResolver(store);
  const service = createMembershipService(
    store,
    fakeIdempotency(store),
    resolver,
    (() => "id-gen") as never,
  );
  return { store, resolver, service };
}

const alice = { actorId: "alice", authenticatedAt: "2026-01-01T00:00:00.000Z" };
const bob = { actorId: "bob", authenticatedAt: "2026-01-01T00:00:00.000Z" };

function seededState(): StoreState {
  return {
    actors: new Set(["alice", "bob", "carol"]),
    memberships: [
      {
        id: "m-alice",
        actorId: "alice",
        applicationId: "app-1",
        tenantId: "tenant-1",
        role: "owner",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "m-bob",
        actorId: "bob",
        applicationId: "app-1",
        tenantId: "tenant-1",
        role: "member",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "m-foreign",
        actorId: "mallory",
        applicationId: "app-2",
        tenantId: "tenant-2",
        role: "owner",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    deleted: [],
  };
}

describe("addMember authorization", () => {
  test("member role cannot add; owner can, and the insert carries the DERIVED tenant", async () => {
    const state = seededState();
    const { service } = build(state);
    await expect(
      service.addMember(
        { principal: bob, applicationId: "app-1", actorId: "carol", role: "member" },
        "k1",
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });

    const added = await service.addMember(
      { principal: alice, applicationId: "app-1", actorId: "carol", role: "admin" },
      "k1",
    );
    expect(added.membership.tenantId).toBe("tenant-1");
    expect(added.membership.role).toBe("admin");
  });

  test("actor without any membership cannot act even for a foreign application id", async () => {
    const { service } = build(seededState());
    await expect(
      service.addMember(
        {
          principal: { actorId: "ghost", authenticatedAt: "" },
          applicationId: "app-1",
          actorId: "carol",
          role: "member",
        },
        "k1",
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
  });
});

describe("removeMember guards", () => {
  test("cross-application membership id is rejected as TENANT_SCOPE_VIOLATION and never deleted", async () => {
    const state = seededState();
    const { service } = build(state);
    await expect(
      service.removeMember(
        { principal: alice, applicationId: "app-1", membershipId: "m-foreign" },
        "k1",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    expect(state.deleted).toEqual([]);
    expect(state.memberships.find((m) => m.id === "m-foreign")).toBeDefined();
  });

  test("last owner cannot be removed (retention)", async () => {
    const state = seededState();
    const { service } = build(state);
    await expect(
      service.removeMember(
        { principal: alice, applicationId: "app-1", membershipId: "m-alice" },
        "k1",
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
  });

  test("owner removal succeeds when another owner exists", async () => {
    const state = seededState();
    state.memberships.push({
      id: "m-alice2",
      actorId: "bob",
      applicationId: "app-1",
      tenantId: "tenant-1",
      role: "owner",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const { service } = build(state);
    const result = await service.removeMember(
      { principal: alice, applicationId: "app-1", membershipId: "m-alice" },
      "k1",
    );
    expect(result.removed).toBe(true);
  });
});

describe("listMembers fail-closed filtering", () => {
  test("foreign-tenant rows that would appear in the filter are never returned", async () => {
    const state = seededState();
    state.memberships.push({
      id: "m-leak",
      actorId: "carol",
      applicationId: "app-1",
      tenantId: "tenant-2",
      role: "member",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const { service } = build(state);
    const members = await service.listMembers(alice, "app-1");
    // The impossible row (constraint-violating in real PG) is filtered, and
    // the list contains only tenant-1 rows.
    expect(members.every((m) => m.tenantId === "tenant-1")).toBe(true);
    expect(members.find((m) => m.id === "m-leak")).toBeUndefined();
  });
});

describe("error taxonomy use", () => {
  test("guards raise typed PlatformErrors from the canonical taxonomy only", async () => {
    const { service } = build(seededState());
    const codes = new Set<string>();
    for (const promise of [
      service
        .addMember(
          { principal: bob, applicationId: "app-1", actorId: "carol", role: "member" },
          "k",
        )
        .catch((e: PlatformError) => codes.add(e.code)),
      service
        .removeMember({ principal: alice, applicationId: "app-1", membershipId: "m-foreign" }, "k")
        .catch((e: PlatformError) => codes.add(e.code)),
    ]) {
      await promise;
    }
    expect(
      [...codes].every((code) =>
        ["AUTHORIZATION_DENIED", "TENANT_SCOPE_VIOLATION", "AUTHENTICATION_FAILED"].includes(code),
      ),
    ).toBe(true);
  });
});
