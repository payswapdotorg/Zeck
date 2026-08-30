/**
 * Real-PostgreSQL: connections tenant isolation at the schema level
 * (WORK-003; checkpoint TENANT-ISOLATION continuation).
 *
 * Proves the migration's anti-ambiguity encoding: a connection row whose
 * tenant disagrees with its application's owning tenant is UNREPRESENTABLE
 * (composite FK), and the service-level dispatch-facts guard rejects
 * cross-tenant connection ids before any dispatch can move.
 */

import { expect, test } from "vitest";
import { createSqlAuthModule } from "../../../src/modules/auth/adapters/sql-identity-store";
import { createScopeResolver } from "../../../src/modules/auth/application/scope-resolver";
import {
  SqlConnectionStore,
  SqlConnectionsIdempotency,
} from "../../../src/modules/connections/adapters/sql-connection-store";
import { createTxCredentialVault } from "../../../src/modules/connections/adapters/sql-credential-vault";
import { createConnectionService } from "../../../src/modules/connections/application/connection-service";
import {
  createEnvelopeCipher,
  generateMasterKey,
} from "../../../src/platform/crypto/envelope-cipher";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { definePgSuite, type PgContext } from "./harness";

const generateId = createUuidv7Generator();

async function seedTenantApp(
  db: DatabasePort,
  suffix: string,
): Promise<{ tenantId: string; applicationId: string; ownerId: string }> {
  const tenantId = generateId();
  const applicationId = generateId();
  const ownerId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${suffix}-${tenantId.slice(-6)}`, `tenant ${suffix}`],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [
      applicationId,
      tenantId,
      `a-${suffix}-${applicationId.slice(-6)}`,
      `app ${suffix}`,
    ],
  });
  await db.execute({
    sql: "INSERT INTO identity.actors (id, external_subject, display_name) VALUES ($1, $2, $3)",
    parameters: [ownerId, `subj-${ownerId}`, "owner"],
  });
  await db.execute({
    sql: "INSERT INTO identity.memberships (id, actor_id, application_id, tenant_id, role) VALUES ($1, $2, $3, $4, 'owner')",
    parameters: [generateId(), ownerId, applicationId, tenantId],
  });
  return { tenantId, applicationId, ownerId };
}

definePgSuite("connections tenant isolation (real PostgreSQL)", (ctx: PgContext) => {
  test("a connection row with a foreign tenant is unrepresentable (composite FK)", async () => {
    const a = await seedTenantApp(ctx.port, "a");
    const b = await seedTenantApp(ctx.port, "b");
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO connections.connections (id, application_id, tenant_id, rail, label, credential_kind)
VALUES ($1, $2, $3, 'openrouter', 'cross-tenant', 'platform')`,
        parameters: [generateId(), a.applicationId, b.tenantId],
      }),
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  test("connections of tenant A never surface in tenant B's reads or dispatch facts", async () => {
    const a = await seedTenantApp(ctx.port, "iso-a");
    const b = await seedTenantApp(ctx.port, "iso-b");
    const cipher = createEnvelopeCipher(generateMasterKey());
    const auth = createSqlAuthModule(ctx.port, generateId);
    const service = createConnectionService(
      new SqlConnectionStore(ctx.port),
      new SqlConnectionsIdempotency(
        ctx.port,
        (tx) => createTxCredentialVault(tx, cipher, generateId),
        generateId,
      ),
      createScopeResolver(auth.store),
      auth.store,
      generateId,
    );

    const createdA = await service.registerConnection(
      {
        principal: { actorId: a.ownerId, authenticatedAt: "2026-01-01T00:00:00Z" },
        applicationId: a.applicationId,
        rail: "openrouter",
        label: "a-connection",
      },
      "iso-key-a",
    );
    const createdB = await service.registerConnection(
      {
        principal: { actorId: b.ownerId, authenticatedAt: "2026-01-01T00:00:00Z" },
        applicationId: b.applicationId,
        rail: "anthropic",
        label: "b-connection",
      },
      "iso-key-b",
    );

    // Lists are tenant-scoped: each principal sees only its application.
    const listA = await service.listConnections(
      { actorId: a.ownerId, authenticatedAt: "2026-01-01T00:00:00Z" },
      a.applicationId,
    );
    expect(listA.map((row) => row.id)).toEqual([createdA.connection.id]);

    // Dispatch facts: tenant B's connection is invisible to tenant A's scope
    // (explicit TENANT_SCOPE_VIOLATION, never silent not-found).
    const factsError = await service
      .getConnectionForDispatch(
        { tenantId: a.tenantId, applicationId: a.applicationId },
        createdB.connection.id,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((factsError as { code: string }).code).toBe("TENANT_SCOPE_VIOLATION");

    // And same-tenant cross-application is equally rejected.
    const secondApp = await seedTenantApp(ctx.port, "iso-a2");
    const crossAppError = await service
      .getConnectionForDispatch(
        { tenantId: a.tenantId, applicationId: secondApp.applicationId },
        createdA.connection.id,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((crossAppError as { code: string }).code).toBe("TENANT_SCOPE_VIOLATION");
  });

  test("the vault is reachable only through references; ciphertext rows stay opaque", async () => {
    const world = await seedTenantApp(ctx.port, "vault");
    const cipher = createEnvelopeCipher(generateMasterKey());
    const auth = createSqlAuthModule(ctx.port, generateId);
    const service = createConnectionService(
      new SqlConnectionStore(ctx.port),
      new SqlConnectionsIdempotency(
        ctx.port,
        (tx) => createTxCredentialVault(tx, cipher, generateId),
        generateId,
      ),
      createScopeResolver(auth.store),
      auth.store,
      generateId,
    );
    await service.registerConnection(
      {
        principal: { actorId: world.ownerId, authenticatedAt: "2026-01-01T00:00:00Z" },
        applicationId: world.applicationId,
        rail: "openrouter",
        label: "byok-conn",
        registerCredential: { material: "sk-live-SECRET-zzz" },
      },
      "vault-key",
    );
    const raw = await ctx.port.execute<{ ciphertext: Buffer }>({
      sql: "SELECT ciphertext FROM connections.credentials",
      parameters: [],
    });
    expect(
      Buffer.from(raw.rows[0]?.ciphertext ?? Buffer.alloc(0)).toString("latin1"),
    ).not.toContain("SECRET");
  });
});
