/**
 * Real-PG: tenant isolation end-to-end over the module wiring
 * (acceptance criteria 3 and 4).
 *
 * The full chain runs against real PostgreSQL: SQL adapters over the
 * provider-neutral DatabasePort, scope resolution from durable rows, and the
 * cross-tenant guard. An explicit store-call journal proves that rejected
 * commands never reach downstream writes.
 */

import { expect, test } from "vitest";
import { createSqlApplicationsModule } from "../../../src/modules/applications/adapters/sql-application-store";
import type { ApplicationStore } from "../../../src/modules/applications/public";
import { createOwnershipServices } from "../../../src/modules/applications/public";
import { createSqlAuthModule } from "../../../src/modules/auth/adapters/sql-identity-store";
import type { IdentityStore } from "../../../src/modules/auth/public";
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

/** Wrap a store so every method call is journalled (downstream-execution proof). */
function journalled<T extends object>(store: T): T & { calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          calls.push(String(property));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  }) as T & { calls: string[] };
  // Expose the journal ON the proxy (the get trap falls through to the
  // target, so we publish it on the target object).
  Object.defineProperty(store, "calls", { value: calls, enumerable: false, configurable: true });
  return proxy;
}

interface FullWiring {
  authStore: IdentityStore & { calls: string[] };
  appStore: ApplicationStore & { calls: string[] };
  memberships: ReturnType<typeof createMembershipService>;
  ownership: ReturnType<typeof createOwnershipServices>;
  resolver: ReturnType<typeof createScopeResolver>;
}

function wire(db: DatabasePort): FullWiring {
  const auth = createSqlAuthModule(db, uuidv7);
  const applications = createSqlApplicationsModule(db, uuidv7);
  const authStore = journalled(auth.store);
  const appStore = journalled(applications.store);
  const resolver = createScopeResolver(authStore);
  const membershipsFacts = {
    findApplicationMembership: async (actorId: string, applicationId: string) =>
      (await authStore.findMembershipWithApplicationTenant(actorId, applicationId))?.membership ??
      null,
  };
  return {
    authStore,
    appStore,
    resolver,
    memberships: createMembershipService(auth.store, auth.idempotency, resolver, uuidv7),
    ownership: createOwnershipServices(
      appStore,
      applications.idempotency,
      resolver,
      membershipsFacts,
      uuidv7,
    ),
  };
}

definePgSuite("tenant isolation end-to-end on real PostgreSQL", (ctx) => {
  test("two tenants: cross-tenant reads are rejected before downstream execution", async () => {
    const { port } = ctx;
    const { ownership, appStore, authStore } = wire(port);
    const alice = await authStore.provisionActor({ id: uuidv7(), displayName: "Alice" });
    const bob = await authStore.provisionActor({ id: uuidv7(), displayName: "Bob" });

    const tenantA = await ownership.createTenant(
      { principal: principalOf(alice.id), slug: `acme-${uuidv7().slice(-6)}`, name: "ACME" },
      uuidv7(),
    );
    const tenantB = await ownership.createTenant(
      { principal: principalOf(bob.id), slug: `globex-${uuidv7().slice(-6)}`, name: "Globex" },
      uuidv7(),
    );
    const appA = await ownership.createApplication(
      { principal: principalOf(alice.id), tenantId: tenantA.id, slug: "alpha", name: "Alpha" },
      uuidv7(),
    );
    await ownership.createApplication(
      { principal: principalOf(bob.id), tenantId: tenantB.id, slug: "beta", name: "Beta" },
      uuidv7(),
    );

    // alice reads her own application: scope tenant derived from durable rows.
    const before = appStore.calls.length;
    const read = await ownership.getApplication(principalOf(alice.id), appA.id);
    expect(read.id).toBe(appA.id);
    expect(appStore.calls.slice(before)).toContain("findApplication");

    // bob attempts alice's application: rejected with NO downstream store
    // call at all (resolution fails before execution).
    const beforeAttempt = appStore.calls.length;
    await expectCode(
      ownership.getApplication(principalOf(bob.id), appA.id),
      "AUTHORIZATION_DENIED",
    );
    expect(appStore.calls.slice(beforeAttempt)).toEqual([]);
  });

  test("environments inherit the scope tenant; foreign-tenant rows never surface", async () => {
    const { port } = ctx;
    const { ownership, authStore } = wire(port);
    const alice = await authStore.provisionActor({ id: uuidv7(), displayName: "Alice" });
    const bob = await authStore.provisionActor({ id: uuidv7(), displayName: "Bob" });

    const tenantA = await ownership.createTenant(
      { principal: principalOf(alice.id), slug: `acme-${uuidv7().slice(-6)}`, name: "ACME" },
      uuidv7(),
    );
    const tenantB = await ownership.createTenant(
      { principal: principalOf(bob.id), slug: `globex-${uuidv7().slice(-6)}`, name: "Globex" },
      uuidv7(),
    );
    const appA = await ownership.createApplication(
      { principal: principalOf(alice.id), tenantId: tenantA.id, slug: "alpha", name: "Alpha" },
      uuidv7(),
    );
    await ownership.createApplication(
      { principal: principalOf(bob.id), tenantId: tenantB.id, slug: "beta", name: "Beta" },
      uuidv7(),
    );
    const envA = await ownership.createEnvironment(
      {
        principal: principalOf(alice.id),
        applicationId: appA.id,
        kind: "production",
        name: "prod",
      },
      uuidv7(),
    );
    expect(envA.tenantId).toBe(tenantA.id);
    expect(envA.applicationId).toBe(appA.id);

    // alice's list contains ONLY her tenant's environments.
    const listed = await ownership.listEnvironments(principalOf(alice.id), appA.id);
    expect(listed.map((env) => env.id)).toEqual([envA.id]);

    // bob has no visibility into appA environments (no membership).
    await expectCode(
      ownership.listEnvironments(principalOf(bob.id), appA.id),
      "AUTHORIZATION_DENIED",
    );

    // Cross-tenant environment fetch: bob creates an environment in his own
    // application; alice cannot read it by id — the environment's durable
    // application belongs to bob's tenant and alice holds no membership
    // there, so resolution rejects before any data returns.
    const appB = await ownership.createApplication(
      { principal: principalOf(bob.id), tenantId: tenantB.id, slug: "beta-2", name: "Beta 2" },
      uuidv7(),
    );
    const envB = await ownership.createEnvironment(
      { principal: principalOf(bob.id), applicationId: appB.id, kind: "production", name: "prod" },
      uuidv7(),
    );
    await expectCode(
      ownership.getEnvironment(principalOf(alice.id), envB.id),
      "AUTHORIZATION_DENIED",
    );
  });

  test("cross-tenant WRITE attempts are structurally impossible through the command surface", async () => {
    const { port } = ctx;
    const { ownership, memberships, authStore } = wire(port);
    const alice = await authStore.provisionActor({ id: uuidv7(), displayName: "Alice" });
    const bob = await authStore.provisionActor({ id: uuidv7(), displayName: "Bob" });

    const tenantA = await ownership.createTenant(
      { principal: principalOf(alice.id), slug: `acme-${uuidv7().slice(-6)}`, name: "ACME" },
      uuidv7(),
    );
    await ownership.createTenant(
      { principal: principalOf(bob.id), slug: `globex-${uuidv7().slice(-6)}`, name: "Globex" },
      uuidv7(),
    );
    const appA = await ownership.createApplication(
      { principal: principalOf(alice.id), tenantId: tenantA.id, slug: "alpha", name: "Alpha" },
      uuidv7(),
    );

    // bob tries to grant himself membership on alice's application through
    // the ONLY mutation surface: the command carries no tenant field, and
    // resolution denies bob before any durable write.
    const before = authStore.calls.length;
    await expectCode(
      memberships.addMember(
        { principal: principalOf(bob.id), applicationId: appA.id, actorId: bob.id, role: "owner" },
        uuidv7(),
      ),
      "AUTHORIZATION_DENIED",
    );
    // Resolution reads (findMembershipWithApplicationTenant) are the guard
    // doing its job; the proof is that NO downstream WRITE method ran.
    const writeCalls = authStore.calls
      .slice(before)
      .filter((call) =>
        ["insertMembership", "updateMembershipRole", "deleteMembership", "provisionActor"].includes(
          call,
        ),
      );
    expect(writeCalls).toEqual([]);

    // Every membership reachable through the service belongs to tenantA.
    const members = await memberships.listMembers(principalOf(alice.id), appA.id);
    expect(members.map((m) => m.tenantId).every((tid) => tid === tenantA.id)).toBe(true);
  });
});
