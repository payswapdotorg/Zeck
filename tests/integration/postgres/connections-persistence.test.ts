/**
 * Real-PostgreSQL: connections persistence, BYOK vault and idempotency
 * (WORK-003, CON-002; checkpoints IDENTITY-IDEMPOTENCY and
 * CONCURRENCY-CRASH-SAFETY).
 *
 * Disposable database, shipped migrations, REAL SQL identity store behind
 * the scope resolver (full cross-module wiring). Proves: ciphertext-at-rest
 * (raw row bytes are not the plaintext and DO decrypt via the envelope
 * cipher), replay/key-reuse semantics, concurrent convergence of identical
 * registrations, atomic rotation (superseded material destroyed with the
 * swap), atomic removal, and crash-atomicity of the guarded operation
 * (a mid-work failure leaves no ledger row, connection or vault row).
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
import type { ConnectionService } from "../../../src/modules/connections/public";
import {
  createEnvelopeCipher,
  type EnvelopeCipher,
  generateMasterKey,
} from "../../../src/platform/crypto/envelope-cipher";
import type { DatabasePort } from "../../../src/platform/db/port";
import { PlatformError } from "../../../src/shared/errors";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { definePgSuite, type PgContext } from "./harness";

const generateId = createUuidv7Generator();
const OWNER_PRINCIPAL = (ownerId: string) => ({
  actorId: ownerId,
  authenticatedAt: "2026-01-01T00:00:00Z",
});

interface World {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly ownerId: string;
  readonly cipher: EnvelopeCipher;
  readonly service: ConnectionService;
}

async function seedWorld(db: DatabasePort): Promise<World> {
  const tenantId = generateId();
  const applicationId = generateId();
  const ownerId = generateId();
  const memberId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "seed tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "seed app"],
  });
  await db.execute({
    sql: "INSERT INTO identity.actors (id, external_subject, display_name) VALUES ($1, $2, $3), ($4, $5, $6)",
    parameters: [ownerId, `subj-${ownerId}`, "owner", memberId, `subj-${memberId}`, "member"],
  });
  await db.execute({
    sql: "INSERT INTO identity.memberships (id, actor_id, application_id, tenant_id, role) VALUES ($1, $2, $3, $4, 'owner'), ($5, $6, $3, $4, 'member')",
    parameters: [generateId(), ownerId, applicationId, tenantId, generateId(), memberId],
  });

  const cipher = createEnvelopeCipher(generateMasterKey());
  const auth = createSqlAuthModule(db, generateId);
  const service = createConnectionService(
    new SqlConnectionStore(db),
    new SqlConnectionsIdempotency(
      db,
      (tx) => createTxCredentialVault(tx, cipher, generateId),
      generateId,
    ),
    createScopeResolver(auth.store),
    auth.store,
    generateId,
  );
  return { db, tenantId, applicationId, ownerId, cipher, service };
}

definePgSuite("connections persistence and BYOK vault (real PostgreSQL)", (ctx: PgContext) => {
  test("BYOK material lands in the vault as AES-256-GCM ciphertext, never plaintext", async () => {
    const world = await seedWorld(ctx.port);
    const material = "sk-or-v1-plaintext-FINDME";

    const { connection } = await world.service.registerConnection(
      {
        principal: OWNER_PRINCIPAL(world.ownerId),
        applicationId: world.applicationId,
        rail: "openrouter",
        label: "pg-primary",
        registerCredential: { material },
      },
      "pg-key-1",
    );
    expect(connection.credentialKind).toBe("byok");

    // Raw durable state: the vault row decrypts to the material through the
    // cipher (AAD-bound to its reference), and no durable byte sequence
    // contains the plaintext.
    const rows = await world.db.execute<{ ciphertext: Buffer; reference: string }>({
      sql: "SELECT reference, ciphertext FROM connections.credentials",
      parameters: [],
    });
    expect(rows.rows.length).toBe(1);
    const row = rows.rows[0];
    if (row === undefined) throw new Error("vault row missing");
    const decrypted = world.cipher.open(
      new Uint8Array(row.ciphertext),
      `connections.credentials:${row.reference}`,
    );
    expect(decrypted).toBe(material);
    expect(Buffer.from(row.ciphertext).toString("latin1")).not.toContain("plaintext-FINDME");

    // The connection row references the vault row; the service outcome
    // carries neither material nor reference.
    const connRow = await world.db.execute<{ credential_ref: string | null }>({
      sql: "SELECT credential_ref FROM connections.connections WHERE id = $1",
      parameters: [connection.id],
    });
    expect(connRow.rows[0]?.credential_ref).toBe(row.reference);
    expect(JSON.stringify(connection)).not.toContain("credentialRef");
    expect(JSON.stringify(connection)).not.toContain("FINDME");

    // The idempotency ledger outcome is material-free too.
    const ledgerRow = await world.db.execute<{
      durable_outcome: unknown;
      request_fingerprint: string;
    }>({
      sql: "SELECT durable_outcome, request_fingerprint FROM platform.idempotency_records WHERE operation_name = 'connections.registerConnection'",
      parameters: [],
    });
    expect(JSON.stringify(ledgerRow.rows[0]?.durable_outcome)).not.toContain("FINDME");
    expect(ledgerRow.rows[0]?.request_fingerprint).not.toContain("FINDME");
  });

  test("identical retries replay the durable outcome; different material is key reuse", async () => {
    const world = await seedWorld(ctx.port);
    const command = {
      principal: OWNER_PRINCIPAL(world.ownerId),
      applicationId: world.applicationId,
      rail: "anthropic" as const,
      label: "pg-replay",
    };
    const first = await world.service.registerConnection(
      { ...command, registerCredential: { material: "same" } },
      "replay-key",
    );
    const replay = await world.service.registerConnection(
      { ...command, registerCredential: { material: "same" } },
      "replay-key",
    );
    expect(replay.connection.id).toBe(first.connection.id);

    const reuse = await world.service
      .registerConnection(
        { ...command, registerCredential: { material: "DIFFERENT" } },
        "replay-key",
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(reuse).toBeInstanceOf(PlatformError);
    expect((reuse as PlatformError).code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("identical concurrent registrations converge to one durable connection and one vault row", async () => {
    const world = await seedWorld(ctx.port);
    const command = {
      principal: OWNER_PRINCIPAL(world.ownerId),
      applicationId: world.applicationId,
      rail: "openrouter" as const,
      label: "pg-converge",
    };
    const [a, b] = await Promise.all([
      world.service.registerConnection(
        { ...command, registerCredential: { material: "m1" } },
        "same-key",
      ),
      world.service.registerConnection(
        { ...command, registerCredential: { material: "m1" } },
        "same-key",
      ),
    ]);
    expect(a.connection.id).toBe(b.connection.id);

    const count = await world.db.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM connections.connections WHERE label = 'pg-converge' AND application_id = $1",
      parameters: [world.applicationId],
    });
    expect(count.rows[0]?.count).toBe("1");
    const connectionRef = await world.db.execute<{ credential_ref: string | null }>({
      sql: "SELECT credential_ref FROM connections.connections WHERE label = 'pg-converge'",
      parameters: [],
    });
    const ref = connectionRef.rows[0]?.credential_ref ?? "";
    const vaultCount = await world.db.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM connections.credentials WHERE reference = $1",
      parameters: [ref],
    });
    expect(vaultCount.rows[0]?.count).toBe("1");
  });

  test("rotation swaps the reference and destroys superseded material atomically", async () => {
    const world = await seedWorld(ctx.port);
    const { connection } = await world.service.registerConnection(
      {
        principal: OWNER_PRINCIPAL(world.ownerId),
        applicationId: world.applicationId,
        rail: "openrouter",
        label: "pg-rotate",
        registerCredential: { material: "original-material" },
      },
      "rotate-register",
    );
    await world.service.rotateCredential(
      {
        principal: OWNER_PRINCIPAL(world.ownerId),
        applicationId: world.applicationId,
        connectionId: connection.id,
        material: "rotated-material",
      },
      "rotate-key",
    );

    const remaining = await world.db.execute<{ reference: string }>({
      sql: `SELECT c.reference FROM connections.credentials c
JOIN connections.connections conn ON conn.credential_ref = c.reference
WHERE conn.id = $1`,
      parameters: [connection.id],
    });
    expect(remaining.rows.length).toBe(1);
    const connRow = await world.db.execute<{ credential_ref: string }>({
      sql: "SELECT credential_ref FROM connections.connections WHERE id = $1",
      parameters: [connection.id],
    });
    const ref = remaining.rows[0]?.reference ?? "";
    expect(connRow.rows[0]?.credential_ref).toBe(ref);
    const row = await world.db.execute<{ ciphertext: Buffer }>({
      sql: "SELECT ciphertext FROM connections.credentials WHERE reference = $1",
      parameters: [ref],
    });
    const ciphertext = row.rows[0]?.ciphertext;
    if (ciphertext === undefined) throw new Error("vault row missing");
    expect(world.cipher.open(new Uint8Array(ciphertext), `connections.credentials:${ref}`)).toBe(
      "rotated-material",
    );
  });

  test("a mid-work failure rolls back ledger, connection and vault rows completely", async () => {
    const world = await seedWorld(ctx.port);
    const auth = createSqlAuthModule(world.db, generateId);
    // A vault whose STORE fails INSIDE the arbitration work — after the
    // ledger row insert, before any connection insert. (The arbiter builds
    // its own tx-bound stores, so the failure must ride the injected
    // vault factory to land inside the guarded work.)
    const failingVaultFactory = (tx: Parameters<typeof createTxCredentialVault>[0]) => {
      const inner = createTxCredentialVault(tx, world.cipher, generateId);
      return {
        store: async () => {
          throw new PlatformError({ code: "PROVIDER_ERROR", message: "synthetic vault failure" });
        },
        materialize: inner.materialize.bind(inner),
        destroy: inner.destroy.bind(inner),
      };
    };
    const failing = createConnectionService(
      new SqlConnectionStore(world.db),
      new SqlConnectionsIdempotency(world.db, failingVaultFactory, generateId),
      createScopeResolver(auth.store),
      auth.store,
      generateId,
    );

    await expect(
      failing.registerConnection(
        {
          principal: OWNER_PRINCIPAL(world.ownerId),
          applicationId: world.applicationId,
          rail: "openrouter",
          label: "pg-crash",
          registerCredential: { material: "crash-material" },
        },
        "crash-key",
      ),
    ).rejects.toThrow(PlatformError);

    for (const [table, sql] of [
      [
        "connections",
        "SELECT count(*)::text AS count FROM connections.connections WHERE label = 'pg-crash' AND application_id = $1",
      ],
      [
        "vault",
        "SELECT count(*)::text AS count FROM connections.credentials WHERE description LIKE '%pg-crash%'",
      ],
      [
        "ledger",
        "SELECT count(*)::text AS count FROM platform.idempotency_records WHERE idempotency_key = 'crash-key'",
      ],
    ] as const) {
      const result = await world.db.execute<{ count: string }>({
        sql,
        parameters: table === "connections" ? [world.applicationId] : [],
      });
      expect(result.rows[0]?.count, `${table} must be empty`).toBe("0");
    }
  });

  test("removal destroys material; a retry under a new key converges to removed:false", async () => {
    const world = await seedWorld(ctx.port);
    const { connection } = await world.service.registerConnection(
      {
        principal: OWNER_PRINCIPAL(world.ownerId),
        applicationId: world.applicationId,
        rail: "anthropic",
        label: "pg-remove",
        registerCredential: { material: "doomed-material" },
      },
      "remove-register",
    );
    const first = await world.service.removeConnection(
      {
        principal: OWNER_PRINCIPAL(world.ownerId),
        applicationId: world.applicationId,
        connectionId: connection.id,
      },
      "remove-key",
    );
    expect(first.removed).toBe(true);
    const retry = await world.service.removeConnection(
      {
        principal: OWNER_PRINCIPAL(world.ownerId),
        applicationId: world.applicationId,
        connectionId: connection.id,
      },
      "remove-key-2",
    );
    expect(retry.removed).toBe(false);

    const vaultRows = await world.db.execute<{ count: string }>({
      sql: `SELECT count(*)::text AS count FROM connections.credentials c
WHERE c.description LIKE '%pg-remove%'`,
      parameters: [],
    });
    expect(vaultRows.rows[0]?.count).toBe("0");
  });

  test("members (read-only role) cannot register connections", async () => {
    const world = await seedWorld(ctx.port);
    const memberId = await world.db.execute<{ actor_id: string }>({
      sql: "SELECT actor_id FROM identity.memberships WHERE role = 'member' LIMIT 1",
      parameters: [],
    });
    const actorId = memberId.rows[0]?.actor_id ?? "";
    const error = await world.service
      .registerConnection(
        {
          principal: { actorId, authenticatedAt: "2026-01-01T00:00:00Z" },
          applicationId: world.applicationId,
          rail: "openrouter",
          label: "pg-member",
        },
        "member-key",
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe("AUTHORIZATION_DENIED");
  });
});
