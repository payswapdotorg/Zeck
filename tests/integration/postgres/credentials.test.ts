/**
 * Real-PG: the credential lifecycle over the SQL adapter (DEP-011
 * acceptance criteria 1–3, 6 — the SQL-authoritative half).
 *
 * The REAL credential service over the REAL SQL credential store and the
 * REAL SQL idempotency ledger (platform.idempotency_records under the
 * `credentials.*` operation names), with migration 0033 applied by the
 * harness. Proves:
 *  - issuance persists durably and the show-once secret is captured only
 *    outside the ledger's durable outcome;
 *  - idempotent replay (same key + fingerprint) replays the metadata-only
 *    outcome and never re-shows the secret;
 *  - rotation retires the predecessor and inserts the successor under the
 *    ONE-ACTIVE-PER-IDENTITY partial unique index (the insert order rides
 *    the arbitration transaction);
 *  - revocation is immediate and idempotent (convergence);
 *  - the scope guards reject cross-tenant mutations before any write.
 *
 * Skips with an explicit reason when ZECK_PG_TEST_URL is unset (the
 * credentialed re-run is the Lead's — recorded honestly).
 */

import { expect, test } from "vitest";
import { createSqlAuthModule } from "../../../src/modules/auth/adapters/sql-identity-store";
import {
  createCredentialService,
  createScopeResolver,
  createSqlCredentialModule,
  InMemoryCredentialSecretStore,
} from "../../../src/modules/auth/public";
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

definePgSuite("credential lifecycle on real PostgreSQL", (ctx) => {
  test("issue persists durably; replay returns metadata-only with no secret", async () => {
    const db = ctx.port;
    const auth = createSqlAuthModule(db, uuidv7);
    const credentialsModule = createSqlCredentialModule(db, uuidv7);
    const secrets = new InMemoryCredentialSecretStore();
    const resolver = createScopeResolver(auth.store);
    let counter = 0;
    const service = createCredentialService({
      identityStore: auth.store,
      credentialStore: credentialsModule.store,
      idempotency: credentialsModule.idempotency,
      resolver,
      generateId: uuidv7,
      generateSecret: () => `zeck-pg-secret-${String(++counter).padStart(4, "0")}`,
      now: () => new Date(),
      secretStore: secrets,
      issuanceEnabled: true,
    });

    // Provision durable ownership state (tenant -> application -> owner
    // membership), the same path the ownership PG suites use.
    const actor = await auth.store.provisionActor({ id: uuidv7(), displayName: "Owner" });
    const tenantId = uuidv7();
    const applicationId = uuidv7();
    await db.execute({
      sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
      parameters: [tenantId, `cred-${tenantId.slice(-8)}`, "Credentials Tenant"],
    });
    await db.execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [applicationId, tenantId, `app-${applicationId.slice(-8)}`, "Credentials App"],
    });
    await auth.store.insertMembership({
      id: uuidv7(),
      actorId: actor.id,
      applicationId,
      tenantId,
      role: "owner",
    });

    const command = {
      principal: principalOf(actor.id),
      applicationId,
      label: "pg integration",
      role: "member" as const,
    };
    const first = await service.issue(command, "pg-key-1");
    expect(first.replayed).toBe(false);
    expect(first.secret).toMatch(/^zeck-pg-secret-\d{4}$/);
    expect(first.record.status).toBe("active");
    expect(first.record.id).toBe(first.record.credentialId);

    const replay = await service.issue(command, "pg-key-1");
    expect(replay.replayed).toBe(true);
    expect(replay.secret).toBeNull();
    expect(replay.record.id).toBe(first.record.id);

    const list = await service.list(principalOf(actor.id), applicationId);
    expect(list).toHaveLength(1);
    expect(list[0]?.label).toBe("pg integration");
    expect(JSON.stringify(list)).not.toContain("zeck-pg-secret");
  });

  test("rotation retires the predecessor and inserts the successor (one active per identity)", async () => {
    const db = ctx.port;
    const auth = createSqlAuthModule(db, uuidv7);
    const credentialsModule = createSqlCredentialModule(db, uuidv7);
    const secrets = new InMemoryCredentialSecretStore();
    const resolver = createScopeResolver(auth.store);
    let counter = 0;
    const service = createCredentialService({
      identityStore: auth.store,
      credentialStore: credentialsModule.store,
      idempotency: credentialsModule.idempotency,
      resolver,
      generateId: uuidv7,
      generateSecret: () => `zeck-pg-secret-${String(++counter).padStart(4, "0")}`,
      now: () => new Date(),
      secretStore: secrets,
      issuanceEnabled: true,
    });

    const actor = await auth.store.provisionActor({ id: uuidv7(), displayName: "Owner" });
    const tenantId = uuidv7();
    const applicationId = uuidv7();
    await db.execute({
      sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
      parameters: [tenantId, `rot-${tenantId.slice(-8)}`, "Rotation Tenant"],
    });
    await db.execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [applicationId, tenantId, `app-${applicationId.slice(-8)}`, "Rotation App"],
    });
    await auth.store.insertMembership({
      id: uuidv7(),
      actorId: actor.id,
      applicationId,
      tenantId,
      role: "owner",
    });

    const issued = await service.issue(
      {
        principal: principalOf(actor.id),
        applicationId,
        label: "pg rotation",
        role: "member",
      },
      "pg-issue",
    );
    const rotated = await service.rotate(
      { principal: principalOf(actor.id), applicationId, credentialId: issued.record.credentialId },
      "pg-rotate",
    );
    expect(rotated.secret).toMatch(/^zeck-pg-secret-\d{4}$/);
    expect(rotated.secret).not.toBe(issued.secret);
    expect(rotated.record.credentialId).toBe(issued.record.credentialId);
    expect(rotated.record.id).not.toBe(issued.record.id);

    const list = await service.list(principalOf(actor.id), applicationId);
    const predecessor = list.find((row) => row.id === issued.record.id);
    const successor = list.find((row) => row.id === rotated.record.id);
    expect(predecessor?.status).toBe("retired");
    expect(predecessor?.supersededBy).toBe(rotated.record.id);
    expect(predecessor?.rotatedAt).not.toBeNull();
    expect(successor?.status).toBe("active");

    // Revocation converges on the identity's ACTIVE record.
    const revoked = await service.revoke(
      { principal: principalOf(actor.id), applicationId, credentialId: issued.record.credentialId },
      "pg-revoke",
    );
    expect(revoked.record.status).toBe("revoked");
    const again = await service.revoke(
      { principal: principalOf(actor.id), applicationId, credentialId: issued.record.credentialId },
      "pg-revoke-2",
    );
    expect(again.record.status).toBe("revoked");

    // The partial unique index: no identity carries two active rows.
    const duplicate = await db.execute<{ n: string }>({
      sql: `SELECT count(*)::text AS n FROM identity.application_credentials
            WHERE credential_id = $1 AND status = 'active'`,
      parameters: [issued.record.credentialId],
    });
    expect(duplicate.rows[0]?.n).toBe("0");
  });

  test("cross-tenant rotation is rejected before any write", async () => {
    const db = ctx.port;
    const auth = createSqlAuthModule(db, uuidv7);
    const credentialsModule = createSqlCredentialModule(db, uuidv7);
    const secrets = new InMemoryCredentialSecretStore();
    const resolver = createScopeResolver(auth.store);
    let counter = 0;
    const service = createCredentialService({
      identityStore: auth.store,
      credentialStore: credentialsModule.store,
      idempotency: credentialsModule.idempotency,
      resolver,
      generateId: uuidv7,
      generateSecret: () => `zeck-pg-secret-${String(++counter).padStart(4, "0")}`,
      now: () => new Date(),
      secretStore: secrets,
      issuanceEnabled: true,
    });

    const owner = await auth.store.provisionActor({ id: uuidv7(), displayName: "Owner" });
    const foreign = await auth.store.provisionActor({ id: uuidv7(), displayName: "Foreign" });
    const tenantId = uuidv7();
    const otherTenantId = uuidv7();
    const applicationId = uuidv7();
    const otherApplicationId = uuidv7();
    await db.execute({
      sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
      parameters: [tenantId, `iso-${tenantId.slice(-8)}`, "Isolation Tenant A"],
    });
    await db.execute({
      sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
      parameters: [otherTenantId, `iso-${otherTenantId.slice(-8)}`, "Isolation Tenant B"],
    });
    await db.execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [applicationId, tenantId, `app-${applicationId.slice(-8)}`, "App A"],
    });
    await db.execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [
        otherApplicationId,
        otherTenantId,
        `app-${otherApplicationId.slice(-8)}`,
        "App B",
      ],
    });
    await auth.store.insertMembership({
      id: uuidv7(),
      actorId: owner.id,
      applicationId,
      tenantId,
      role: "owner",
    });
    await auth.store.insertMembership({
      id: uuidv7(),
      actorId: foreign.id,
      applicationId: otherApplicationId,
      tenantId: otherTenantId,
      role: "owner",
    });

    const issued = await service.issue(
      { principal: principalOf(owner.id), applicationId, label: "isolated", role: "member" },
      "iso-issue",
    );
    await expectCode(
      service.rotate(
        {
          principal: principalOf(foreign.id),
          applicationId: otherApplicationId,
          credentialId: issued.record.credentialId,
        },
        "iso-rotate",
      ),
      "TENANT_SCOPE_VIOLATION",
    );
    // The target credential is untouched.
    const list = await service.list(principalOf(owner.id), applicationId);
    expect(list.find((row) => row.id === issued.record.id)?.status).toBe("active");
  });
});
