/**
 * Unit: the credential lifecycle service (DEP-011 acceptance criteria
 * 1, 2, 3, 6) over the in-memory doubles — the REAL application service,
 * the REAL scope resolver, the REAL idempotency arbitration, the REAL
 * secret-store port over the in-memory test double.
 *
 * Required-test mapping:
 *  - issuance returns the secret EXACTLY ONCE; a replay of the same
 *    idempotency key returns the record with NO secret (the show-once
 *    contract; the ledger's durable outcome never contains material);
 *  - listing is metadata-only and tenant-filtered (foreign-tenant rows
 *    fail closed);
 *  - rotation issues a successor under the SAME credential identity,
 *    retires the predecessor (status/rotatedAt/supersededBy), and the
 *    successor secret is show-once;
 *  - revocation is immediate and idempotent (convergence, no error);
 *  - every mutation passes the scope-resolution guard: cross-tenant
 *    targets fail TENANT_SCOPE_VIOLATION, members (read-only) are denied
 *    writes, and a member CAN list;
 *  - the issuance gate fails CAPABILITY_UNAVAILABLE honestly when the
 *    deployment disables it;
 *  - the label/role contracts fail closed.
 */

import { describe, expect, test } from "vitest";
import {
  type CredentialService,
  createCredentialService,
  createScopeResolver,
  type IdentityStore,
  InMemoryCredentialIdempotency,
  InMemoryCredentialSecretStore,
  InMemoryCredentialStore,
  type MembershipRecord,
} from "../../src/modules/auth/public";
import { PlatformError } from "../../src/shared/errors";

const ACTOR = "00000000-0000-7000-8000-0000000000aa";
const MEMBER_ACTOR = "00000000-0000-7000-8000-0000000000ab";
const OTHER_TENANT_ACTOR = "00000000-0000-7000-8000-0000000000cc";
const APPLICATION = "00000000-0000-7000-8000-0000000000b1";
const TENANT = "00000000-0000-7000-8000-0000000000a1";
const OTHER_APPLICATION = "00000000-0000-7000-8000-0000000000dd";
const OTHER_TENANT = "00000000-0000-7000-8000-0000000000cc";

const MEMBERSHIPS: readonly {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly role: "owner" | "admin" | "member";
}[] = [
  { actorId: ACTOR, applicationId: APPLICATION, tenantId: TENANT, role: "owner" },
  { actorId: MEMBER_ACTOR, applicationId: APPLICATION, tenantId: TENANT, role: "member" },
  {
    actorId: OTHER_TENANT_ACTOR,
    applicationId: OTHER_APPLICATION,
    tenantId: OTHER_TENANT,
    role: "owner",
  },
];

function fakeIdentityStore(): IdentityStore {
  const rows = new Map(
    MEMBERSHIPS.map((m) => [
      `${m.actorId}:${m.applicationId}`,
      { membership: m as unknown as MembershipRecord, applicationTenantId: m.tenantId },
    ]),
  );
  const notImplemented = (name: string) => () => {
    throw new Error(`not implemented in fake: ${name}`);
  };
  return {
    provisionActor: notImplemented("provisionActor") as never,
    findActor: (async () => null) as never,
    findMembershipWithApplicationTenant: (async (actorId: string, applicationId: string) =>
      rows.get(`${actorId}:${applicationId}`) ?? null) as never,
    findTenantMembership: (async () => null) as never,
    listMemberships: (async () => []) as never,
    insertMembership: notImplemented("insertMembership") as never,
    updateMembershipRole: notImplemented("updateMembershipRole") as never,
    deleteMembership: notImplemented("deleteMembership") as never,
    lockApplicationMemberships: (async () => []) as never,
  };
}

interface World {
  readonly service: CredentialService;
  readonly store: InMemoryCredentialStore;
  readonly secrets: InMemoryCredentialSecretStore;
}

function seedWorld(options: { readonly issuanceEnabled?: boolean } = {}): World {
  const store = new InMemoryCredentialStore();
  const secrets = new InMemoryCredentialSecretStore();
  const identityStore = fakeIdentityStore();
  let counter = 0;
  const service = createCredentialService({
    identityStore,
    credentialStore: store,
    idempotency: new InMemoryCredentialIdempotency(store),
    resolver: createScopeResolver(identityStore),
    generateId: () => `00000000-0000-7000-c000-${String(++counter).padStart(12, "0")}`,
    generateSecret: () => `zeck-unit-secret-${String(++counter).padStart(4, "0")}`,
    now: () => new Date("2026-09-15T12:00:00Z"),
    secretStore: secrets,
    issuanceEnabled: options.issuanceEnabled ?? true,
  });
  return { service, store, secrets };
}

const principalOf = (actorId: string) => ({ actorId, authenticatedAt: "2026-09-15T12:00:00Z" });

function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`expected PlatformError ${code}, resolved instead`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe(code);
    },
  );
}

describe("issue (AC1: show-once secret at creation)", () => {
  test("returns the secret exactly once with the metadata-only record", async () => {
    const world = seedWorld();
    const outcome = await world.service.issue(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        label: "ci integration",
        role: "member",
      },
      "key-1",
    );
    expect(outcome.replayed).toBe(false);
    expect(outcome.secret).toMatch(/^zeck-unit-secret-\d{4}$/);
    expect(outcome.record.label).toBe("ci integration");
    expect(outcome.record.role).toBe("member");
    expect(outcome.record.status).toBe("active");
    expect(outcome.record.id).toBe(outcome.record.credentialId);
    // The metadata-only record type carries no secret or secret reference.
    expect(Object.keys(outcome.record)).toEqual([
      "id",
      "credentialId",
      "applicationId",
      "tenantId",
      "label",
      "role",
      "status",
      "createdAt",
      "rotatedAt",
      "supersededBy",
    ]);
  });

  test("a replay of the same idempotency key returns the record with NO secret", async () => {
    const world = seedWorld();
    const command = {
      principal: principalOf(ACTOR),
      applicationId: APPLICATION,
      label: "ci integration",
      role: "member" as const,
    };
    const first = await world.service.issue(command, "same-key");
    const replay = await world.service.issue(command, "same-key");
    expect(replay.replayed).toBe(true);
    expect(replay.secret).toBeNull();
    expect(replay.record.id).toBe(first.record.id);
  });

  test("same key + different payload → IDEMPOTENCY_KEY_REUSED", async () => {
    const world = seedWorld();
    await world.service.issue(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        label: "one",
        role: "member",
      },
      "clash",
    );
    await expectCode(
      world.service.issue(
        {
          principal: principalOf(ACTOR),
          applicationId: APPLICATION,
          label: "two",
          role: "member",
        },
        "clash",
      ),
      "IDEMPOTENCY_KEY_REUSED",
    );
  });

  test("the stored secret material exists only in the secret store (never in a record)", async () => {
    const world = seedWorld();
    const outcome = await world.service.issue(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        label: "ci integration",
        role: "member",
      },
      "key-material",
    );
    const material = outcome.secret ?? "";
    const stored = world.secrets.materialOf(world.secrets.references()[0] ?? "");
    expect(stored).toBe(material);
    // No record the service can produce contains the material.
    const records = world.store.records();
    for (const record of records) {
      expect(JSON.stringify(record)).not.toContain(material);
    }
  });

  test("member role (read-only permission set) is denied issuance", async () => {
    const world = seedWorld();
    await expectCode(
      world.service.issue(
        {
          principal: principalOf(MEMBER_ACTOR),
          applicationId: APPLICATION,
          label: "member attempt",
          role: "member",
        },
        "key-member",
      ),
      "AUTHORIZATION_DENIED",
    );
  });

  test("the issuance gate fails CAPABILITY_UNAVAILABLE when disabled", async () => {
    const world = seedWorld({ issuanceEnabled: false });
    expect(world.service.issuanceEnabled()).toBe(false);
    await expectCode(
      world.service.issue(
        {
          principal: principalOf(ACTOR),
          applicationId: APPLICATION,
          label: "gated",
          role: "member",
        },
        "key-gate",
      ),
      "CAPABILITY_UNAVAILABLE",
    );
  });

  test("label and role contracts fail closed", async () => {
    const world = seedWorld();
    await expectCode(
      world.service.issue(
        { principal: principalOf(ACTOR), applicationId: APPLICATION, label: "", role: "member" },
        "key-label",
      ),
      "CAPABILITY_UNAVAILABLE",
    );
    await expectCode(
      world.service.issue(
        {
          principal: principalOf(ACTOR),
          applicationId: APPLICATION,
          label: "bad label!",
          role: "member",
        },
        "key-label-2",
      ),
      "CAPABILITY_UNAVAILABLE",
    );
    await expectCode(
      world.service.issue(
        {
          principal: principalOf(ACTOR),
          applicationId: APPLICATION,
          label: "ok",
          role: "superuser" as unknown as "member",
        },
        "key-role",
      ),
      "CAPABILITY_UNAVAILABLE",
    );
  });

  test("an actor without membership for the application is denied", async () => {
    const world = seedWorld();
    await expectCode(
      world.service.issue(
        {
          principal: principalOf(OTHER_TENANT_ACTOR),
          applicationId: APPLICATION,
          label: "foreign",
          role: "member",
        },
        "key-foreign",
      ),
      "AUTHORIZATION_DENIED",
    );
  });
});

describe("list (AC2: metadata-only, scope-honoring)", () => {
  test("lists the application's credentials; a member (read-only) may list", async () => {
    const world = seedWorld();
    await world.service.issue(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        label: "first",
        role: "admin",
      },
      "key-a",
    );
    await world.service.issue(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        label: "second",
        role: "member",
      },
      "key-b",
    );
    const mine = await world.service.list(principalOf(MEMBER_ACTOR), APPLICATION);
    expect(mine.map((record) => record.label)).toEqual(["first", "second"]);
    for (const record of mine) {
      expect(record.tenantId).toBe(TENANT);
      expect(JSON.stringify(record)).not.toContain("secret");
    }
  });
});

describe("rotate (AC3: successor under the same identity; predecessor retired)", () => {
  test("issues a show-once successor and retires the predecessor", async () => {
    const world = seedWorld();
    const issued = await world.service.issue(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        label: "ci integration",
        role: "member",
      },
      "key-issue",
    );
    const rotated = await world.service.rotate(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        credentialId: issued.record.credentialId,
      },
      "key-rotate",
    );
    expect(rotated.replayed).toBe(false);
    expect(rotated.secret).toMatch(/^zeck-unit-secret-\d{4}$/);
    expect(rotated.secret).not.toBe(issued.secret);
    expect(rotated.record.credentialId).toBe(issued.record.credentialId);
    expect(rotated.record.id).not.toBe(issued.record.id);
    expect(rotated.record.status).toBe("active");

    // The list reflects BOTH the rotation outcome and the lineage.
    const list = await world.service.list(principalOf(ACTOR), APPLICATION);
    const predecessor = list.find((row) => row.id === issued.record.id);
    const successor = list.find((row) => row.id === rotated.record.id);
    expect(predecessor?.status).toBe("retired");
    expect(predecessor?.rotatedAt).not.toBeNull();
    expect(predecessor?.supersededBy).toBe(rotated.record.id);
    expect(successor?.status).toBe("active");
  });

  test("a rotation replay returns the successor with NO secret", async () => {
    const world = seedWorld();
    const issued = await world.service.issue(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        label: "ci integration",
        role: "member",
      },
      "key-issue",
    );
    const command = {
      principal: principalOf(ACTOR),
      applicationId: APPLICATION,
      credentialId: issued.record.credentialId,
    };
    await world.service.rotate(command, "key-rotate");
    const replay = await world.service.rotate(command, "key-rotate");
    expect(replay.replayed).toBe(true);
    expect(replay.secret).toBeNull();
  });

  test("a revoked credential cannot rotate", async () => {
    const world = seedWorld();
    const issued = await world.service.issue(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        label: "ci integration",
        role: "member",
      },
      "key-issue",
    );
    await world.service.revoke(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        credentialId: issued.record.credentialId,
      },
      "key-revoke",
    );
    await expectCode(
      world.service.rotate(
        {
          principal: principalOf(ACTOR),
          applicationId: APPLICATION,
          credentialId: issued.record.credentialId,
        },
        "key-rotate",
      ),
      "INVALID_STATE_TRANSITION",
    );
  });

  test("cross-tenant rotation is rejected with TENANT_SCOPE_VIOLATION (AC6)", async () => {
    const world = seedWorld();
    const issued = await world.service.issue(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        label: "ci integration",
        role: "member",
      },
      "key-issue",
    );
    // The other-tenant actor targets OUR credential identity.
    await expectCode(
      world.service.rotate(
        {
          principal: principalOf(OTHER_TENANT_ACTOR),
          applicationId: OTHER_APPLICATION,
          credentialId: issued.record.credentialId,
        },
        "key-cross",
      ),
      "TENANT_SCOPE_VIOLATION",
    );
  });
});

describe("revoke (AC3: immediate and idempotent)", () => {
  test("revokes immediately and converges on repeat", async () => {
    const world = seedWorld();
    const issued = await world.service.issue(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        label: "ci integration",
        role: "member",
      },
      "key-issue",
    );
    const first = await world.service.revoke(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        credentialId: issued.record.credentialId,
      },
      "key-revoke-1",
    );
    expect(first.record.status).toBe("revoked");
    // A DIFFERENT idempotency key revoking the same (already-revoked)
    // credential converges — no error, the same durable fact.
    const second = await world.service.revoke(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        credentialId: issued.record.credentialId,
      },
      "key-revoke-2",
    );
    expect(second.record.status).toBe("revoked");
    expect(second.record.id).toBe(first.record.id);
    // The same key replays the outcome.
    const replay = await world.service.revoke(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        credentialId: issued.record.credentialId,
      },
      "key-revoke-2",
    );
    expect(replay.replayed).toBe(true);
  });

  test("revoking a rotated identity revokes its ACTIVE successor", async () => {
    const world = seedWorld();
    const issued = await world.service.issue(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        label: "ci integration",
        role: "member",
      },
      "key-issue",
    );
    const rotated = await world.service.rotate(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        credentialId: issued.record.credentialId,
      },
      "key-rotate",
    );
    await world.service.revoke(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        credentialId: issued.record.credentialId,
      },
      "key-revoke",
    );
    const list = await world.service.list(principalOf(ACTOR), APPLICATION);
    const successor = list.find((row) => row.id === rotated.record.id);
    expect(successor?.status).toBe("revoked");
  });

  test("cross-tenant revocation is rejected with TENANT_SCOPE_VIOLATION (AC6)", async () => {
    const world = seedWorld();
    const issued = await world.service.issue(
      {
        principal: principalOf(ACTOR),
        applicationId: APPLICATION,
        label: "ci integration",
        role: "member",
      },
      "key-issue",
    );
    await expectCode(
      world.service.revoke(
        {
          principal: principalOf(OTHER_TENANT_ACTOR),
          applicationId: OTHER_APPLICATION,
          credentialId: issued.record.credentialId,
        },
        "key-cross",
      ),
      "TENANT_SCOPE_VIOLATION",
    );
  });

  test("revoking an unknown identity fails honestly", async () => {
    const world = seedWorld();
    await expectCode(
      world.service.revoke(
        {
          principal: principalOf(ACTOR),
          applicationId: APPLICATION,
          credentialId: "00000000-0000-7000-8000-00000000ffff",
        },
        "key-unknown",
      ),
      "AUTHENTICATION_FAILED",
    );
  });
});
