/**
 * Real-PostgreSQL audit schema + immutability tests (WORK-059 / SEC-004;
 * MIGRATION-SAFETY + the DB-level append-only enforcement).
 *
 * Proves over the real database:
 *
 *  - migration 0031 shipped and applied (tracked in the runner's ledger);
 *  - the closed vocabularies are CHECK-bound (rows outside the action/
 *    actor/target/seam vocabularies are unrepresentable);
 *  - unbounded retention is CHECK-bound (a finite horizon is the only
 *    representable shape);
 *  - tenant scoping is FK-enforced (cross-tenant rows unrepresentable);
 *  - identity and chain-sequence uniqueness are enforced;
 *  - PHYSICAL APPEND-ONLY: UPDATE, DELETE and TRUNCATE are rejected by
 *    trigger; DELETE is legal only under the governed purge session
 *    gate (which the store sets exclusively inside its purge
 *    transaction);
 *  - a database converged at the PREVIOUS migration head (0030, the
 *    D-02/E1.1-converged authority) applies 0031 forward cleanly (no
 *    destructive migration; convergence on fresh + existing states).
 */

import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { describe, expect, test } from "vitest";
import { createAuditNodeDigest } from "../../../src/modules/audit/adapters/node-digest";
import { SqlAuditStore } from "../../../src/modules/audit/adapters/sql-audit-store";
import { createAuditService } from "../../../src/modules/audit/public";
import { loadMigrations, runMigrations } from "../../../src/platform/db/migrations/runner";
import type { DatabasePort, Query, QueryResult, Transaction } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { seedAuditWorld } from "./audit-world";
import { definePgSuite, dropDatabase, PG_TEST_URL } from "./harness";

const generateId = createUuidv7Generator();

const COLUMN_ORDER = [
  "id",
  "application_id",
  "tenant_id",
  "record_id",
  "chain_sequence",
  "action_kind",
  "actor_id",
  "actor_kind",
  "target_kind",
  "target_id",
  "seam",
  "source_record_id",
  "environment",
  "occurred_at",
  "recorded_at",
  "previous_record_digest",
  "record_digest",
  "payload",
] as const;

function columnIndexOf(column: string): number {
  return COLUMN_ORDER.indexOf(column as (typeof COLUMN_ORDER)[number]);
}

function literalOf(index: number, entry: unknown): string {
  if (index === 0) {
    return `'${randomUUID()}'::uuid`;
  }
  if (index === 13 || index === 14) {
    return "'2026-09-20T12:00:00.000Z'::timestamptz";
  }
  if (index === 17) {
    return "'{}'::jsonb";
  }
  if (entry === null) {
    return "NULL";
  }
  if (typeof entry === "number") {
    return String(entry);
  }
  return `'${String(entry)}'`;
}

function insertRowSql(column: string, value: string, base: readonly unknown[]): string {
  const columns = COLUMN_ORDER.join(", ");
  const values = base
    .map((entry, index) => (index === columnIndexOf(column) ? value : literalOf(index, entry)))
    .join(", ");
  return `INSERT INTO audit.audit_records (${columns}) VALUES (${values})`;
}

definePgSuite("audit schema and immutability (real PostgreSQL)", (ctx) => {
  test("migration 0031 shipped, tracked, and the audit schema exists", async () => {
    const world = await seedAuditWorld(ctx.port);
    const tracked = await world.db.execute<{ version: number; name: string }>({
      sql: "SELECT version, name FROM platform.schema_migrations WHERE version = 31",
      parameters: [],
    });
    expect(tracked.rows[0]?.name).toBe("audit_compliance");
    const schemas = await world.db.execute<{ schema_name: string }>({
      sql: "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'audit'",
      parameters: [],
    });
    expect(schemas.rows).toHaveLength(1);
    const tables = await world.db.execute<{ table_name: string }>({
      sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'audit' ORDER BY table_name",
      parameters: [],
    });
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "audit_records",
      "chain_heads",
      "legal_holds",
      "retention_policies",
    ]);
  });

  test("closed vocabularies are CHECK-bound (outside rows unrepresentable)", async () => {
    const world = await seedAuditWorld(ctx.port);
    const base = [
      randomUUID(),
      world.applicationId,
      world.tenantId,
      "a".repeat(64),
      1,
      "execution.created",
      "actor-1",
      "service-principal",
      "execution",
      "e".repeat(64),
      "executions.create",
      null,
      "production",
      "2026-09-20T12:00:00.000Z",
      "2026-09-20T12:00:00.000Z",
      "0".repeat(64),
      "b".repeat(64),
      null,
    ];
    for (const [column, value] of [
      ["action_kind", "'budget.reserved'"],
      ["actor_kind", "'robot'"],
      ["target_kind", "'budget'"],
      ["seam", "'budgets.reserve'"],
    ] as const) {
      await expect(
        world.db.execute({ sql: insertRowSql(column, value, base), parameters: [] }),
      ).rejects.toThrow(/check constraint/i);
    }
  });

  test("identity/chain uniqueness is enforced (duplicate rows unrepresentable)", async () => {
    const world = await seedAuditWorld(ctx.port);
    await world.audit.record({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      environment: "production",
      actor: { actorId: "actor-1", actorKind: "service-principal" },
      action: { kind: "execution.created", command: "create", operationKey: "uniq-1" },
      target: { kind: "execution", id: randomUUID() },
      provenance: { seam: "executions.create", sourceRecordId: null },
      rationale: { why: "uniqueness probe" },
      occurredAt: "2026-09-20T12:00:00.000Z",
      actionDetail: { probe: "uniqueness" },
    });
    const rows = await world.db.execute<{ record_id: string; chain_sequence: string }>({
      sql: "SELECT record_id, chain_sequence FROM audit.audit_records WHERE application_id = $1",
      parameters: [world.applicationId],
    });
    const row = rows.rows[0];
    expect(row).toBeDefined();
    if (row === undefined) {
      return;
    }
    await expect(
      world.db.execute({
        sql: `INSERT INTO audit.audit_records
                    (id, application_id, tenant_id, record_id, chain_sequence, action_kind, actor_id,
                     actor_kind, target_kind, target_id, seam, source_record_id, environment,
                     occurred_at, recorded_at, previous_record_digest, record_digest, payload)
              VALUES ($1, $2, $3, $4, 1, 'execution.created', 'actor-1', 'service-principal',
                      'execution', 'e', 'executions.create', NULL, 'production',
                      now(), now(), $5, $6, '{}')`,
        parameters: [
          randomUUID(),
          world.applicationId,
          world.tenantId,
          row.record_id,
          "0".repeat(64),
          "b".repeat(64),
        ],
      }),
    ).rejects.toThrow(/unique constraint/i);
  });

  test("unbounded retention is unrepresentable (CHECK-bound horizon)", async () => {
    const world = await seedAuditWorld(ctx.port);
    for (const days of [0, -1, 3651, 99999]) {
      await expect(
        world.db.execute({
          sql: `INSERT INTO audit.retention_policies
                    (id, application_id, tenant_id, version, retention_days, reason, adopted_by)
              VALUES ($1, $2, $3, 1, $4, 'why', 'op')`,
          parameters: [randomUUID(), world.applicationId, world.tenantId, days],
        }),
      ).rejects.toThrow(/check constraint/i);
    }
  });

  test("tenant scoping is FK-enforced (cross-tenant rows unrepresentable)", async () => {
    const world = await seedAuditWorld(ctx.port);
    await expect(
      world.db.execute({
        sql: `INSERT INTO audit.chain_heads (application_id, tenant_id, last_sequence, last_digest)
              VALUES ($1, $2, 0, $3)`,
        parameters: [world.applicationId, randomUUID(), "0".repeat(64)],
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  test("UPDATE on audit records is rejected by trigger (append-only)", async () => {
    const world = await seedAuditWorld(ctx.port);
    await world.audit.record({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      environment: "production",
      actor: { actorId: "actor-1", actorKind: "service-principal" },
      action: { kind: "execution.created", command: "create", operationKey: "im-1" },
      target: { kind: "execution", id: randomUUID() },
      provenance: { seam: "executions.create", sourceRecordId: null },
      rationale: { why: "immutability probe" },
      occurredAt: "2026-09-20T12:00:00.000Z",
      actionDetail: { probe: "immutability" },
    });
    await expect(
      world.db.execute({
        sql: "UPDATE audit.audit_records SET environment = 'staging' WHERE application_id = $1",
        parameters: [world.applicationId],
      }),
    ).rejects.toThrow(/append-only/i);
  });

  test("DELETE without the governed session gate is rejected by trigger", async () => {
    const world = await seedAuditWorld(ctx.port);
    await world.audit.record({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      environment: "production",
      actor: { actorId: "actor-1", actorKind: "service-principal" },
      action: { kind: "execution.created", command: "create", operationKey: "gate-1" },
      target: { kind: "execution", id: randomUUID() },
      provenance: { seam: "executions.create", sourceRecordId: null },
      rationale: { why: "gate probe" },
      occurredAt: "2026-09-20T12:00:00.000Z",
      actionDetail: { probe: "gate" },
    });
    await expect(
      world.db.execute({
        sql: "DELETE FROM audit.audit_records WHERE application_id = $1",
        parameters: [world.applicationId],
      }),
    ).rejects.toThrow(/governed retention purge/i);
  });

  test("TRUNCATE is rejected by trigger (no bulk destruction path)", async () => {
    await expect(
      ctx.port.execute({ sql: "TRUNCATE audit.audit_records", parameters: [] }),
    ).rejects.toThrow(/append-only/i);
  });

  test("the governed session gate is transaction-local (auto-resets after commit)", async () => {
    const world = await seedAuditWorld(ctx.port);
    await world.db.execute({ sql: "BEGIN", parameters: [] });
    await world.db.execute({ sql: "SET LOCAL audit.governed_purge = 'governed'", parameters: [] });
    await world.db.execute({
      sql: "DELETE FROM audit.audit_records WHERE application_id = $1",
      parameters: [world.applicationId],
    });
    await world.db.execute({ sql: "COMMIT", parameters: [] });
    const gate = await world.db.execute<{ current_setting: string }>({
      sql: "SELECT COALESCE(current_setting('audit.governed_purge', true), '') AS current_setting",
      parameters: [],
    });
    expect(gate.rows[0]?.current_setting).toBe("");
  });
});

// --- migration convergence on a D-02/E1.1-converged (0030) authority -------

function poolPort(pool: Pool): DatabasePort {
  const map = <T>(rows: T[], rowCount: number | null): QueryResult<T> => ({
    rows,
    rowCount: rowCount ?? rows.length,
  });
  class PgTransaction implements Transaction {
    constructor(private readonly client: import("pg").PoolClient) {}
    async execute<T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>> {
      const result = await this.client.query(query.sql, query.parameters as unknown[]);
      return map<T>(result.rows as T[], result.rowCount);
    }
  }
  return {
    async execute<T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>> {
      const client = await pool.connect();
      try {
        const result = await client.query(query.sql, query.parameters as unknown[]);
        return map<T>(result.rows as T[], result.rowCount);
      } finally {
        client.release();
      }
    },
    async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(new PgTransaction(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

if (PG_TEST_URL) {
  describe("audit migration convergence on a 0030-converged database (real PostgreSQL)", () => {
    test("0031 applies forward cleanly on the existing authority (no destructive migration)", async () => {
      const databaseName = `zeck_work059_conv_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const admin = new Client({ connectionString: PG_TEST_URL });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${databaseName}`);
      await admin.end();
      const pool = new Pool({
        connectionString: `${PG_TEST_URL.replace(/\/[^/]*$/, "")}/${databaseName}`,
        max: 2,
      });
      pool.on("error", () => undefined);
      const port = poolPort(pool);
      try {
        // Converge at the PREVIOUS head (0030 — the D-02/E1.1
        // discipline base): everything except 0031.
        const shipped = loadMigrations("src/platform/db/migrations");
        const baseSet = shipped.filter((file) => file.version <= 30);
        const baseRun = await runMigrations(port, baseSet);
        expect(baseRun.applied.map((file) => file.version)).toContain(30);

        // The existing authority works: seed a tenant/application.
        const tenantId = generateId();
        const applicationId = generateId();
        await port.execute({
          sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, 'conv')",
          parameters: [tenantId, `t-${tenantId.slice(-6)}`],
        });
        await port.execute({
          sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, 'conv', 'conv')",
          parameters: [applicationId, tenantId],
        });

        // Apply the FULL shipped set: exactly 0031 applies forward.
        const forward = await runMigrations(port, shipped);
        expect(forward.applied).toEqual([{ version: 31, name: "audit_compliance" }]);
        expect(forward.skipped).toBe(shipped.length - 1);

        // The pre-existing authority rows are intact (no destructive
        // migration) and the audit plane works on the converged base.
        const applications = await port.execute<{ id: string }>({
          sql: "SELECT id FROM applications.applications WHERE id = $1",
          parameters: [applicationId],
        });
        expect(applications.rows).toHaveLength(1);

        const store = new SqlAuditStore(
          port,
          createAuditNodeDigest(),
          () => new Date("2026-09-20T12:00:00.000Z"),
        );
        const audit = createAuditService({ store, digest: createAuditNodeDigest() });
        const outcome = await audit.record({
          applicationId,
          tenantId,
          environment: "production",
          actor: { actorId: "actor-1", actorKind: "service-principal" },
          action: { kind: "execution.created", command: "create", operationKey: "conv-1" },
          target: { kind: "execution", id: randomUUID() },
          provenance: { seam: "executions.create", sourceRecordId: null },
          rationale: { why: "convergence probe" },
          occurredAt: "2026-09-20T12:00:00.000Z",
          actionDetail: { probe: "convergence" },
        });
        expect(outcome.replayed).toBe(false);
      } finally {
        await pool.end();
        await dropDatabase(PG_TEST_URL, databaseName);
      }
    }, 120_000);
  });
}
