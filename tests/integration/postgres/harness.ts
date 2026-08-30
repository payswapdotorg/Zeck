/**
 * Real-PostgreSQL integration harness (WORK-002).
 *
 * `IMPLEMENTATION.md` §1: "Vitest + Testcontainers (or equivalent real
 * PostgreSQL...)". This harness runs the suites against a real PostgreSQL 16
 * server (started outside this repository) via a per-run disposable database:
 *
 *   ZECK_PG_TEST_URL=postgres://user:pass@host:port/postgres
 *
 * The URL must point at an ADMIN database (usually `postgres`); each test
 * file gets its own database `zeck_work002_test_<random>` with the shipped
 * migrations applied, dropped on teardown. Tests skip with an explicit reason
 * when the variable is unset (CI has no PostgreSQL service yet — see the
 * evidence file's known-limitations section; local verification output is
 * the recorded proof for this Work Order).
 *
 * The pg driver is test infrastructure: `src/` never imports it (the SDK
 * boundary table owns `pg` under `src/platform/db/`; the production adapter
 * arrives with the Work Order that owns that surface). This harness is the
 * reference implementation of the provider-neutral `DatabasePort` contract.
 */

import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { applyShippedMigrations } from "../../../src/platform/db/migrations/runner";
import type { DatabasePort, Query, QueryResult, Transaction } from "../../../src/platform/db/port";
import { defineSuite } from "./define-suite";

export const PG_TEST_URL = process.env.ZECK_PG_TEST_URL ?? "";

export interface PgContext {
  readonly port: DatabasePort;
  readonly databaseName: string;
  readonly adminUrl: string;
}

function mapResult<T>(result: { rows: T[]; rowCount: number | null }): QueryResult<T> {
  return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
}

class PgTransaction implements Transaction {
  constructor(private readonly client: PoolClient) {}

  async execute<T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>> {
    const result = await this.client.query(query.sql, query.parameters as unknown[]);
    return mapResult<T>(result as { rows: T[]; rowCount: number | null });
  }
}

class PgDatabasePort implements DatabasePort {
  constructor(private readonly pool: Pool) {}

  async execute<T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(query.sql, query.parameters as unknown[]);
      return mapResult<T>(result as { rows: T[]; rowCount: number | null });
    } finally {
      client.release();
    }
  }

  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
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
  }
}

async function createDatabase(adminUrl: string): Promise<string> {
  const name = `zeck_work002_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  return name;
}

export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  } finally {
    await admin.end();
  }
}

/**
 * Define a real-PG test suite: fresh database, shipped migrations applied,
 * disposable port; dropped afterwards. Skips when ZECK_PG_TEST_URL is unset.
 */
export function definePgSuite(name: string, register: (ctx: PgContext) => void): void {
  defineSuite<PgContext>(name, PG_TEST_URL, register, async (adminUrl) => {
    const databaseName = await createDatabase(adminUrl);
    const pool = new Pool({
      connectionString: `${adminUrl.replace(/\/[^/]*$/, "")}/${databaseName}`,
      max: 4,
    });
    const port = new PgDatabasePort(pool);
    const applied = await applyShippedMigrations(port);
    if (applied.applied.length === 0) {
      throw new Error("expected the shipped migration to apply on the fresh database");
    }
    return {
      context: { port, databaseName, adminUrl },
      cleanup: async () => {
        await pool.end();
        await dropDatabase(adminUrl, databaseName);
      },
    };
  });
}
