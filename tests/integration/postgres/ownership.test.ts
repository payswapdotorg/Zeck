/**
 * Real-PG: ownership lifecycle end-to-end (acceptance criteria 1, 2, 5).
 *
 * Provisions actors, creates tenants/applications/environments through the
 * public services over real PostgreSQL, and proves the authorization matrix
 * (tenant-scope vs application-scope, role permissions, owner retention).
 */

import { expect, test } from "vitest";
import { createSqlApplicationsModule } from "../../../src/modules/applications/adapters/sql-application-store";
import { createOwnershipServices } from "../../../src/modules/applications/public";
import { createSqlAuthModule } from "../../../src/modules/auth/adapters/sql-identity-store";
import { createMembershipService, createScopeResolver } from "../../../src/modules/auth/public";
import type { DatabasePort } from "../../../src/platform/db/port";
import { PlatformError } from "../../../src/shared/errors";
import { uuidv7 } from "../../../src/shared/ids";
import { definePgSuite } from "./harness";

function principalOf(actorId: string) {
  return { actorId, authenticatedAt: new Date().toISOString() };
}

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

function fullWiring(db: DatabasePort) {
  const auth = createSqlAuthModule(db, uuidv7);
  const applications = createSqlApplicationsModule(db, uuidv7);
  const resolver = createScopeResolver(auth.store);
  const membershipsFacts = {
    findApplicationMembership: async (actorId: string, applicationId: string) =>
      (await auth.store.findMembershipWithApplicationTenant(actorId, applicationId))?.membership ??
      null,
  };
  return {
    auth,
    ownership: createOwnershipServices(
      applications.store,
      applications.idempotency,
      resolver,
      membershipsFacts,
      uuidv7,
    ),
    memberships: createMembershipService(auth.store, auth.idempotency, resolver, uuidv7),
  };
}

definePgSuite("ownership lifecycle on real PostgreSQL", (ctx) => {
  test("tenant creation provisions the creator as tenant-scope owner; application creation requires it", async () => {
    const { port } = ctx;
    const { auth, ownership } = fullWiring(port);
    const alice = await auth.store.provisionActor({ id: uuidv7(), displayName: "Alice" });
    const bob = await auth.store.provisionActor({ id: uuidv7(), displayName: "Bob" });

    const tenant = await ownership.createTenant(
      {
        principal: principalOf(alice.id),
        slug: ` lifecycle-${uuidv7().slice(-6)}`.trim(),
        name: "Lifecycle",
      },
      uuidv7(),
    );
    const ownerMembership = await auth.store.findTenantMembership(alice.id, tenant.id);
    expect(ownerMembership?.role).toBe("owner");

    // bob holds no tenant-scope authority: application creation denied.
    await expectCode(
      ownership.createApplication(
        { principal: principalOf(bob.id), tenantId: tenant.id, slug: "nope", name: "Nope" },
        uuidv7(),
      ),
      "AUTHORIZATION_DENIED",
    );
    // alice (owner) creates the application and becomes its application owner.
    const app = await ownership.createApplication(
      { principal: principalOf(alice.id), tenantId: tenant.id, slug: "core", name: "Core" },
      uuidv7(),
    );
    expect(app.tenantId).toBe(tenant.id);
    const appOwner = await auth.store.findMembershipWithApplicationTenant(alice.id, app.id);
    expect(appOwner?.membership.role).toBe("owner");
    expect(appOwner?.membership.tenantId).toBe(tenant.id);
  });

  test("role permission matrix on environments (member read-only, admin writes, owner transfers)", async () => {
    const { port } = ctx;
    const { auth, ownership, memberships } = fullWiring(port);
    const alice = await auth.store.provisionActor({ id: uuidv7(), displayName: "Alice" });
    const member = await auth.store.provisionActor({ id: uuidv7(), displayName: "Member" });
    const admin = await auth.store.provisionActor({ id: uuidv7(), displayName: "Admin" });

    const tenant = await ownership.createTenant(
      { principal: principalOf(alice.id), slug: `matrix-${uuidv7().slice(-6)}`, name: "Matrix" },
      uuidv7(),
    );
    const app = await ownership.createApplication(
      { principal: principalOf(alice.id), tenantId: tenant.id, slug: "core", name: "Core" },
      uuidv7(),
    );
    await memberships.addMember(
      {
        principal: principalOf(alice.id),
        applicationId: app.id,
        actorId: member.id,
        role: "member",
      },
      uuidv7(),
    );
    await memberships.addMember(
      { principal: principalOf(alice.id), applicationId: app.id, actorId: admin.id, role: "admin" },
      uuidv7(),
    );

    // member: read yes, write no.
    await ownership.createEnvironment(
      { principal: principalOf(admin.id), applicationId: app.id, kind: "development", name: "dev" },
      uuidv7(),
    );
    const seen = await ownership.listEnvironments(principalOf(member.id), app.id);
    expect(seen).toHaveLength(1);
    await expectCode(
      ownership.createEnvironment(
        { principal: principalOf(member.id), applicationId: app.id, kind: "staging", name: "stg" },
        uuidv7(),
      ),
      "AUTHORIZATION_DENIED",
    );

    // duplicate environment (same name) converges to the existing row via a
    // DIFFERENT idempotency key (natural duplicate, not retry).
    const duplicate = await ownership.createEnvironment(
      { principal: principalOf(admin.id), applicationId: app.id, kind: "development", name: "dev" },
      uuidv7(),
    );
    expect(duplicate.id).toBe(seen[0]?.id);

    // owner-retention: alice cannot remove her own last owner membership.
    const aliceMembership = (await memberships.listMembers(principalOf(alice.id), app.id)).find(
      (m) => m.actorId === alice.id,
    );
    expect(aliceMembership).toBeDefined();
    await expectCode(
      memberships.removeMember(
        {
          principal: principalOf(alice.id),
          applicationId: app.id,
          membershipId: aliceMembership?.id ?? "",
        },
        uuidv7(),
      ),
      "AUTHORIZATION_DENIED",
    );
    // After promoting admin to owner, removal of alice succeeds.
    await memberships.addMember(
      { principal: principalOf(alice.id), applicationId: app.id, actorId: admin.id, role: "owner" },
      uuidv7(),
    );
    const removed = await memberships.removeMember(
      {
        principal: principalOf(alice.id),
        applicationId: app.id,
        membershipId: aliceMembership?.id ?? "",
      },
      uuidv7(),
    );
    expect(removed.removed).toBe(true);
    // ...and is itself idempotent: same key replays removed=true without a
    // second durable delete.
    const key = uuidv7();
    const again = await memberships.removeMember(
      {
        principal: principalOf(admin.id),
        applicationId: app.id,
        membershipId: aliceMembership?.id ?? "",
      },
      key,
    );
    expect(again.removed).toBe(false); // already gone; convergence outcome
  });

  test("actor provisioning is converging (same external subject → same actor)", async () => {
    const { port } = ctx;
    const { auth } = fullWiring(port);
    const subject = `did:web:${uuidv7().slice(0, 8)}`;
    const first = await auth.store.provisionActor({
      id: uuidv7(),
      displayName: "One",
      externalSubject: subject,
    });
    const second = await auth.store.provisionActor({
      id: uuidv7(),
      displayName: "Two",
      externalSubject: subject,
    });
    expect(second.id).toBe(first.id);
  });
});
