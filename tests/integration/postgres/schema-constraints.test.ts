/**
 * Real-PG: durable tenant-isolation constraints (acceptance criterion 2).
 *
 * These tests prove the SCHEMA itself makes cross-tenant ownership ambiguity
 * unrepresentable: composite foreign keys and partial unique indexes reject
 * inconsistent rows regardless of application-code bugs.
 */

import { expect, test } from "vitest";
import { uuidv7 } from "../../../src/shared/ids";
import { definePgSuite } from "./harness";

definePgSuite("tenant-isolation schema constraints on real PostgreSQL", (ctx) => {
  const db = () => ctx.port;

  const seedTenant = async (slug: string): Promise<string> => {
    const id = uuidv7();
    await db().execute({
      sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
      parameters: [id, slug, `Tenant ${slug}`],
    });
    return id;
  };

  const seedApplication = async (tenantId: string, slug: string): Promise<string> => {
    const id = uuidv7();
    await db().execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [id, tenantId, slug, `App ${slug}`],
    });
    return id;
  };

  const seedActor = async (): Promise<string> => {
    const id = uuidv7();
    await db().execute({
      sql: "INSERT INTO identity.actors (id, display_name) VALUES ($1, $2)",
      parameters: [id, "Actor"],
    });
    return id;
  };

  test("an application id pairs with exactly one tenant (anti-ambiguity unique)", async () => {
    const tenantA = await seedTenant(`acme-${uuidv7().slice(-6)}`);
    const tenantB = await seedTenant(`globex-${uuidv7().slice(-6)}`);
    const appId = uuidv7();
    await db().execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [appId, tenantA, "duel", "Duel"],
    });
    // The SAME application id cannot be owned by a second tenant.
    await expect(
      db().execute({
        sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
        parameters: [appId, tenantB, "duel", "Duel"],
      }),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  test("a membership whose tenant disagrees with the application's tenant is rejected (composite FK)", async () => {
    const tenantA = await seedTenant(`acme-${uuidv7().slice(-6)}`);
    const tenantB = await seedTenant(`globex-${uuidv7().slice(-6)}`);
    const appId = await seedApplication(tenantA, "app-one");
    const actorId = await seedActor();
    // Correct tenant accepted first.
    await db().execute({
      sql: "INSERT INTO identity.memberships (id, actor_id, application_id, tenant_id, role) VALUES ($1, $2, $3, $4, 'owner')",
      parameters: [uuidv7(), actorId, appId, tenantA],
    });
    // A second actor claims the same application under tenant B: rejected.
    const otherActor = await seedActor();
    await expect(
      db().execute({
        sql: "INSERT INTO identity.memberships (id, actor_id, application_id, tenant_id, role) VALUES ($1, $2, $3, $4, 'member')",
        parameters: [uuidv7(), otherActor, appId, tenantB],
      }),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  test("an environment whose tenant disagrees with the application's tenant is rejected (composite FK)", async () => {
    const tenantA = await seedTenant(`acme-${uuidv7().slice(-6)}`);
    const tenantB = await seedTenant(`globex-${uuidv7().slice(-6)}`);
    const appId = await seedApplication(tenantA, "app-two");
    await expect(
      db().execute({
        sql: "INSERT INTO applications.environments (id, application_id, tenant_id, kind, name) VALUES ($1, $2, $3, 'production', 'prod')",
        parameters: [uuidv7(), appId, tenantB],
      }),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  test("tenant-scope membership is owner-only (scope shape CHECK)", async () => {
    const tenantId = await seedTenant(`initech-${uuidv7().slice(-6)}`);
    const actorId = await seedActor();
    await expect(
      db().execute({
        sql: "INSERT INTO identity.memberships (id, actor_id, application_id, tenant_id, role) VALUES ($1, $2, NULL, $3, 'member')",
        parameters: [uuidv7(), actorId, tenantId],
      }),
    ).rejects.toThrow(/violates check constraint "memberships_scope_shape"/i);
  });

  test("an application must keep an identifiable slug per tenant and unique (tenant, slug)", async () => {
    const tenantId = await seedTenant(`umbrella-${uuidv7().slice(-6)}`);
    await seedApplication(tenantId, "shared-slug");
    await expect(
      db().execute({
        sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
        parameters: [uuidv7(), tenantId, "shared-slug", "Duplicate"],
      }),
    ).rejects.toThrow(/duplicate key|unique/i);
    // Same slug in a DIFFERENT tenant is fine (tenant-scoped namespace).
    const otherTenant = await seedTenant(`wayne-${uuidv7().slice(-6)}`);
    await expect(
      db().execute({
        sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
        parameters: [uuidv7(), otherTenant, "shared-slug", "Namespaced"],
      }),
    ).resolves.toBeDefined();
  });

  test("idempotency ledger: application-scope keys are unique per application, actor-scope per actor", async () => {
    const tenantId = await seedTenant(`stonx-${uuidv7().slice(-6)}`);
    const appId = await seedApplication(tenantId, "ledgered");
    const actorA = await seedActor();
    const actorB = await seedActor();
    const insert = (applicationId: string | null, actorId: string, key: string) =>
      db().execute({
        sql: `INSERT INTO platform.idempotency_records
                (id, actor_id, application_id, operation_name, idempotency_key, request_fingerprint, durable_outcome)
              VALUES ($1, $2, $3, 'op', $4, 'fp', '"x"'::jsonb)`,
        parameters: [uuidv7(), actorId, applicationId, key],
      });

    await insert(appId, actorA, "key-1");
    // Same application scope + same key: rejected even for a DIFFERENT actor
    // (the contract's application-scoped arbitration).
    await expect(insert(appId, actorB, "key-1")).rejects.toThrow(/duplicate key|unique/i);
    // Different application scope: independent (NULL app scope is actor-keyed).
    await expect(insert(null, actorA, "key-1")).resolves.toBeDefined();
    // Same actor scope + same key: rejected.
    await expect(insert(null, actorA, "key-1")).rejects.toThrow(/duplicate key|unique/i);
    // Different actor, NULL app scope: independent.
    await expect(insert(null, actorB, "key-1")).resolves.toBeDefined();
  });
});
