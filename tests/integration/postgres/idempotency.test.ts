/**
 * Real-PG: idempotency and concurrency/crash safety
 * (acceptance criterion 5; checkpoint contracts IDENTITY-IDEMPOTENCY and
 * CONCURRENCY-CRASH-SAFETY).
 *
 * Proof targets (`spec/contracts.md` "Idempotency response rule"):
 *  - same (scope, operation, key, fingerprint) → same logical durable outcome;
 *  - same key + different fingerprint → IDEMPOTENCY_KEY_REUSED;
 *  - concurrent identical requests converge to ONE durable identity via
 *    PostgreSQL uniqueness/transactional arbitration;
 *  - a crashed mutation leaves no partial state (ledger + write are atomic)
 *    and the retry succeeds.
 */

import { Pool } from "pg";
import { expect, test } from "vitest";
import { createSqlApplicationsModule } from "../../../src/modules/applications/adapters/sql-application-store";
import { createOwnershipServices } from "../../../src/modules/applications/public";
import { createSqlAuthModule } from "../../../src/modules/auth/adapters/sql-identity-store";
import { createMembershipService, createScopeResolver } from "../../../src/modules/auth/public";
import type { DatabasePort } from "../../../src/platform/db/port";
import { PlatformError } from "../../../src/shared/errors";
import { uuidv7 } from "../../../src/shared/ids";
import { definePgSuite, type PgContext } from "./harness";

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

/** A second, independent DatabasePort over a fresh pool (parallel client). */
function independentPort(databaseUrl: string): { port: DatabasePort; end: () => Promise<void> } {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  return {
    port: {
      execute: (query) =>
        pool.connect().then(async (client) => {
          try {
            const result = await client.query(query.sql, query.parameters as unknown[]);
            return {
              rows: result.rows as never[],
              rowCount: result.rowCount ?? result.rows.length,
            };
          } finally {
            client.release();
          }
        }),
      transaction: (async (work) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const tx = {
            execute: async (query: { sql: string; parameters?: readonly unknown[] }) => {
              const result = await client.query(query.sql, query.parameters as unknown[]);
              return {
                rows: result.rows as never[],
                rowCount: result.rowCount ?? result.rows.length,
              };
            },
          };
          const value = await work(tx as never);
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      }) as DatabasePort["transaction"],
    },
    end: () => pool.end(),
  };
}

definePgSuite("idempotency and crash safety on real PostgreSQL", (ctx) => {
  test("retry with same key replays the same durable outcome; different fingerprint is rejected", async () => {
    const { port } = ctx;
    const auth = createSqlAuthModule(port, uuidv7);
    const applications = createSqlApplicationsModule(port, uuidv7);
    const resolver = createScopeResolver(auth.store);
    const membershipsFacts = {
      findApplicationMembership: async (actorId: string, applicationId: string) =>
        (await auth.store.findMembershipWithApplicationTenant(actorId, applicationId))
          ?.membership ?? null,
    };
    const ownership = createOwnershipServices(
      applications.store,
      applications.idempotency,
      resolver,
      membershipsFacts,
      uuidv7,
    );
    const memberships = createMembershipService(auth.store, auth.idempotency, resolver, uuidv7);

    const alice = await auth.store.provisionActor({ id: uuidv7(), displayName: "Alice" });
    const dave = await auth.store.provisionActor({ id: uuidv7(), displayName: "Dave" });
    const tenant = await ownership.createTenant(
      { principal: principalOf(alice.id), slug: `idem-${uuidv7().slice(-6)}`, name: "Idem" },
      uuidv7(),
    );
    const app = await ownership.createApplication(
      { principal: principalOf(alice.id), tenantId: tenant.id, slug: "core", name: "Core" },
      uuidv7(),
    );

    // Idempotent tenant creation: same key replays the SAME tenant.
    const key = uuidv7();
    const first = await ownership.createTenant(
      {
        principal: principalOf(alice.id),
        slug: `replay-${uuidv7().slice(-6)}`,
        name: "Replay",
      },
      key,
    );
    const replay = await ownership.createTenant(
      {
        principal: principalOf(alice.id),
        slug: `replay-${first.slug.slice(-6)}`,
        name: "Replay",
      },
      key,
    );
    expect(replay.id).toBe(first.id);

    // Membership mutation: same key, same payload → same membership (no duplicate).
    const memberKey = uuidv7();
    const added = await memberships.addMember(
      {
        principal: principalOf(alice.id),
        applicationId: app.id,
        actorId: dave.id,
        role: "member",
      },
      memberKey,
    );
    const addedAgain = await memberships.addMember(
      {
        principal: principalOf(alice.id),
        applicationId: app.id,
        actorId: dave.id,
        role: "member",
      },
      memberKey,
    );
    expect(addedAgain.membership.id).toBe(added.membership.id);
    const members = await memberships.listMembers(principalOf(alice.id), app.id);
    expect(members.filter((m) => m.actorId === dave.id)).toHaveLength(1);

    // Same key, DIFFERENT payload → IDEMPOTENCY_KEY_REUSED.
    await expectCode(
      memberships.addMember(
        {
          principal: principalOf(alice.id),
          applicationId: app.id,
          actorId: dave.id,
          role: "admin",
        },
        memberKey,
      ),
      "IDEMPOTENCY_KEY_REUSED",
    );

    // Ledger row count proves single durable identity per key.
    const ledger = await port.execute<{ operation_name: string; durable_outcome: unknown }>({
      sql: "SELECT operation_name, durable_outcome FROM platform.idempotency_records WHERE idempotency_key = $1",
      parameters: [memberKey],
    });
    expect(ledger.rows).toHaveLength(1);
  });

  test("concurrent identical requests converge to one durable identity (transactional arbitration)", async () => {
    const { port, databaseName, adminUrl } = ctx;
    const auth = createSqlAuthModule(port, uuidv7);
    const applications = createSqlApplicationsModule(port, uuidv7);
    const resolver = createScopeResolver(auth.store);
    const membershipsFacts = {
      findApplicationMembership: async (actorId: string, applicationId: string) =>
        (await auth.store.findMembershipWithApplicationTenant(actorId, applicationId))
          ?.membership ?? null,
    };
    const ownership = createOwnershipServices(
      applications.store,
      applications.idempotency,
      resolver,
      membershipsFacts,
      uuidv7,
    );

    const alice = await auth.store.provisionActor({ id: uuidv7(), displayName: "Alice" });
    const slug = `race-${uuidv7().slice(0, 8)}`;
    const key = uuidv7();

    const second = independentPort(`${adminUrl.replace(/\/[^/]*$/, "")}/${databaseName}`);
    try {
      const firstClient = ownership.createTenant(
        { principal: principalOf(alice.id), slug, name: "Race" },
        key,
      );
      const applications2 = createSqlApplicationsModule(second.port, uuidv7);
      const resolver2 = createScopeResolver(
        // A second wiring over the independent port (read-only facts suffice
        // for arbitration; creation is actor-scoped).
        {
          findMembershipWithApplicationTenant: async (actorId: string, applicationId: string) =>
            auth.store.findMembershipWithApplicationTenant(actorId, applicationId),
          findTenantMembership: async (actorId: string, tenantId: string) =>
            auth.store.findTenantMembership(actorId, tenantId),
        } as never,
      );
      const secondClient = createOwnershipServices(
        applications2.store,
        applications2.idempotency,
        resolver2,
        {
          findApplicationMembership: async () => null,
        },
        uuidv7,
      ).createTenant({ principal: principalOf(alice.id), slug, name: "Race" }, key);

      const [outcomeA, outcomeB] = await Promise.all([firstClient, secondClient]);
      // Both converge to the SAME durable tenant identity.
      expect(outcomeA.id).toBe(outcomeB.id);

      const rows = await port.execute<{ count: number }>({
        sql: "SELECT count(*)::int AS count FROM applications.tenants WHERE slug = $1",
        parameters: [slug],
      });
      expect(rows.rows[0]?.count).toBe(1);
    } finally {
      await second.end();
    }
  });

  test("crashed mutation leaves no partial state and retries cleanly (atomicity)", async () => {
    const { port } = ctx;
    const auth = createSqlAuthModule(port, uuidv7);
    const applications = createSqlApplicationsModule(port, uuidv7);
    const resolver = createScopeResolver(auth.store);
    const membershipsFacts = {
      findApplicationMembership: async (actorId: string, applicationId: string) =>
        (await auth.store.findMembershipWithApplicationTenant(actorId, applicationId))
          ?.membership ?? null,
    };
    const ownership = createOwnershipServices(
      applications.store,
      applications.idempotency,
      resolver,
      membershipsFacts,
      uuidv7,
    );

    const alice = await auth.store.provisionActor({ id: uuidv7(), displayName: "Alice" });
    const slug = `crash-${uuidv7().slice(0, 8)}`;
    const key = uuidv7();

    // Simulate a crash AFTER the ledger insert and the tenant insert by
    // racing a direct kill of the transaction: execute inside arbitrate's
    // transaction via a sabotaged executor that fails on the outcome UPDATE.
    let failOutcomeUpdate = false;
    const sabotaged: PgContext["port"] = {
      execute: (query: { sql: string; parameters?: readonly unknown[] }) => port.execute(query),
      transaction: ((work: Parameters<DatabasePort["transaction"]>[0]) =>
        port.transaction(async (tx) => {
          const wrapped = {
            execute: (query: { sql: string; parameters?: readonly unknown[] }) => {
              if (
                failOutcomeUpdate &&
                query.sql.startsWith("UPDATE platform.idempotency_records")
              ) {
                return Promise.reject(new Error("simulated crash before commit"));
              }
              return tx.execute(query);
            },
          };
          return work(wrapped as never);
        })) as DatabasePort["transaction"],
    };
    const applicationsCrash = createSqlApplicationsModule(sabotaged, uuidv7);
    const ownershipCrash = createOwnershipServices(
      applicationsCrash.store,
      applicationsCrash.idempotency,
      resolver,
      membershipsFacts,
      uuidv7,
    );

    failOutcomeUpdate = true;
    await expect(
      ownershipCrash.createTenant({ principal: principalOf(alice.id), slug, name: "Crash" }, key),
    ).rejects.toThrow("simulated crash");
    failOutcomeUpdate = false;

    // Nothing persisted: no tenant, no owner membership, no ledger row.
    const tenants = await port.execute<{ count: number }>({
      sql: "SELECT count(*)::int AS count FROM applications.tenants WHERE slug = $1",
      parameters: [slug],
    });
    expect(tenants.rows[0]?.count).toBe(0);
    const ledger = await port.execute<{ count: number }>({
      sql: "SELECT count(*)::int AS count FROM platform.idempotency_records WHERE idempotency_key = $1",
      parameters: [key],
    });
    expect(ledger.rows[0]?.count).toBe(0);

    // Clean retry with the same key succeeds and is durable.
    const retried = await ownership.createTenant(
      { principal: principalOf(alice.id), slug, name: "Crash" },
      key,
    );
    expect(retried.slug).toBe(slug);
    const ownerMembership = await auth.store.findTenantMembership(alice.id, retried.id);
    expect(ownerMembership?.role).toBe("owner");
  });
});
