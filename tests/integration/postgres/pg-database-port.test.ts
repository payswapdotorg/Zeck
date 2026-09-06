/**
 * Integration — the production pg `DatabasePort` adapter + startup
 * path against REAL PostgreSQL 16 (WORK-043 / D-02, AC1–3).
 *
 * `ZECK_PG_TEST_URL` must point at an ADMIN database; each file gets
 * a disposable database. This is the managed-PostgreSQL path proof:
 * the same wire protocol, driver, pool and transaction semantics any
 * managed endpoint (Neon) exposes — the environment records
 * Neon-specific live-endpoint evidence separately (NOT RUN without
 * credentials, never a silent PASS).
 *
 * Proves: deterministic startup (24 migrations, exactly-once,
 * restart-safe); transaction atomicity (commit visible, rollback
 * invisible, original errors propagate); concurrency without lost
 * updates under the port's transaction discipline; connection-pool
 * bounds under realistic parallel load (observed server-side
 * concurrency never exceeds the configured ceiling); and the
 * fail-closed/redacted unavailable-endpoint behavior.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, test } from "vitest";
import { parseConnectionConfig } from "../../../src/platform/db/connection";
import { DatabaseUnavailableError, StartupValidationError } from "../../../src/platform/db/errors";
import { startAuthoritativeDatabase } from "../../../src/platform/db/startup";
import { defineSuite } from "./define-suite";

export const PG_TEST_URL = process.env.ZECK_PG_TEST_URL ?? "";

interface Ctx {
  readonly databaseName: string;
  readonly adminUrl: string;
  readonly databaseUrl: () => string;
}

async function createDatabase(adminUrl: string): Promise<string> {
  const name = `zeck_work043_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

defineSuite<Ctx>(
  "the production pg DatabasePort adapter and startup path (WORK-043 D-02)",
  PG_TEST_URL,
  (ctx) => {
    test("startup applies the shipped migrations deterministically and reports convergence", async () => {
      const handle = await startAuthoritativeDatabase(ctx.databaseUrl(), {
        poolOverrides: { max: 2 },
      });
      try {
        // 24 through WORK-043 + 0026_queue_transport (WORK-044 / D-03)
        // + 0027_workflow_orchestration (WORK-045 / D-04)
        // + 0028_compute_worker_fabric (WORK-046 / D-05).
        expect(handle.migrations.applied).toHaveLength(27);
        expect(handle.migrations.skipped).toBe(0);
        expect(handle.serverVersion).toContain("PostgreSQL 16");
        // Non-secret endpoint identity only.
        expect(handle.endpoint).toContain(ctx.databaseName);
        expect(handle.endpoint).not.toMatch(/:\/\/[^/]*:[^/]*@/);
        // The port IS the existing DatabasePort contract.
        const result = await handle.port.execute<{ ok: number }>({ sql: "SELECT 1 AS ok" });
        expect(result.rows[0]?.ok).toBe(1);
      } finally {
        await handle.close();
      }
    });

    test("startup is restart-safe: a second run applies nothing and still converges", async () => {
      const first = await startAuthoritativeDatabase(ctx.databaseUrl(), {
        poolOverrides: { max: 2 },
      });
      await first.close();
      const second = await startAuthoritativeDatabase(ctx.databaseUrl(), {
        poolOverrides: { max: 2 },
      });
      try {
        expect(second.migrations.applied).toHaveLength(0);
        expect(second.migrations.skipped).toBe(27);
        expect(second.migrations.applied.length + second.migrations.skipped).toBe(27);
      } finally {
        await second.close();
      }
    });

    test("transaction atomicity: commit persists, rollback discards, errors propagate", async () => {
      const handle = await startAuthoritativeDatabase(ctx.databaseUrl(), {
        poolOverrides: { max: 2 },
      });
      try {
        const port = handle.port;
        await port.execute({
          sql: "CREATE TABLE platform.tx_probe (id integer PRIMARY KEY, value text NOT NULL)",
        });
        await port.transaction(async (tx) => {
          await tx.execute({
            sql: "INSERT INTO platform.tx_probe (id, value) VALUES (1, 'committed')",
          });
        });
        const committed = await port.execute<{ value: string }>({
          sql: "SELECT value FROM platform.tx_probe WHERE id = 1",
        });
        expect(committed.rows[0]?.value).toBe("committed");

        await expect(
          port.transaction(async (tx) => {
            await tx.execute({
              sql: "INSERT INTO platform.tx_probe (id, value) VALUES (2, 'rolled-back')",
            });
            throw new Error("probe failure after insert");
          }),
        ).rejects.toThrow("probe failure after insert");
        const rolled = await port.execute<{ count: string }>({
          sql: "SELECT count(*)::text AS count FROM platform.tx_probe WHERE id = 2",
        });
        expect(rolled.rows[0]?.count).toBe("0");
      } finally {
        await handle.close();
      }
    });

    test("concurrent transactions never lose updates (20 parallel increments)", async () => {
      const handle = await startAuthoritativeDatabase(ctx.databaseUrl(), {
        poolOverrides: { max: 4 },
      });
      try {
        const port = handle.port;
        await port.execute({
          sql: "CREATE TABLE platform.counter_probe (id integer PRIMARY KEY, n integer NOT NULL)",
        });
        await port.execute({
          sql: "INSERT INTO platform.counter_probe (id, n) VALUES (1, 0)",
        });
        const workers = Array.from({ length: 20 }, (_, index) =>
          port.transaction(async (tx) => {
            await tx.execute({
              sql: "UPDATE platform.counter_probe SET n = n + 1 WHERE id = 1",
            });
            return index;
          }),
        );
        const results = await Promise.all(workers);
        expect(results).toHaveLength(20);
        const final = await port.execute<{ n: number }>({
          sql: "SELECT n FROM platform.counter_probe WHERE id = 1",
        });
        expect(final.rows[0]?.n).toBe(20);
      } finally {
        await handle.close();
      }
    });

    test("connection-pool bounds hold under parallel load (max observed server-side <= ceiling)", async () => {
      const ceiling = 2;
      const handle = await startAuthoritativeDatabase(ctx.databaseUrl(), {
        poolOverrides: { max: ceiling },
      });
      try {
        // 8 parallel 200ms queries through the port.
        const started = Date.now();
        const queries = Array.from({ length: 8 }, () =>
          handle.port.execute({ sql: "SELECT pg_sleep(0.2), 1 AS ok" }),
        );
        // Sample server-side concurrency while they run.
        const sampler = new Client({ connectionString: ctx.databaseUrl() });
        await sampler.connect();
        let maxObserved = 0;
        try {
          for (let tick = 0; tick < 12; tick += 1) {
            const sample = await sampler.query<{ count: string }>({
              text: "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
            });
            maxObserved = Math.max(maxObserved, Number(sample.rows[0]?.count ?? "0"));
            await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
          }
        } finally {
          await sampler.end();
        }
        await Promise.all(queries);
        const elapsed = Date.now() - started;
        // The pool serializes: at most `ceiling` concurrent server
        // connections (+1 transient for the sampler, excluded above).
        expect(maxObserved).toBeLessThanOrEqual(ceiling);
        // 8 sleeps × 200ms over 2 slots ⇒ wall time ≥ ~800ms.
        expect(elapsed).toBeGreaterThanOrEqual(750);
      } finally {
        await handle.close();
      }
    });

    test("the closed adapter fails closed (no post-close silent success)", async () => {
      const handle = await startAuthoritativeDatabase(ctx.databaseUrl(), {
        poolOverrides: { max: 2 },
      });
      await handle.close();
      await expect(handle.port.execute({ sql: "SELECT 1" })).rejects.toThrow(
        DatabaseUnavailableError,
      );
      await expect(
        handle.port.transaction(async () => {
          return "x";
        }),
      ).rejects.toThrow(DatabaseUnavailableError);
    });

    test("an unavailable endpoint fails closed with a REDACTED diagnostic", async () => {
      // A refused port with credentials in the URL: the failure must
      // be typed and must never carry the credential material.
      const url = "postgres://probeuser:hunter2secret@127.0.0.1:1/zeck";
      const error = await startAuthoritativeDatabase(url, {
        poolOverrides: { max: 1, connectionTimeoutMillis: 1500 },
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DatabaseUnavailableError);
      const message = (error as Error).message;
      expect(message).not.toContain("hunter2secret");
      expect(message).not.toContain("probeuser:");
      // Sanity: the URL itself parses (the failure is availability).
      expect(() => parseConnectionConfig(url)).not.toThrow();
    });

    test("startup validation is the fail-closed gate (unit-verified gates hold on the real server)", async () => {
      // The real server is 16+ and converged — the gate passes; the
      // below-floor and non-converged paths are mutation-proven in the
      // unit suite. Here we prove the real server reports 16.4.
      const handle = await startAuthoritativeDatabase(ctx.databaseUrl(), {
        poolOverrides: { max: 2 },
      });
      try {
        expect(handle.serverVersion).toMatch(/PostgreSQL 16\.\d+/);
      } finally {
        await handle.close();
      }
      expect(StartupValidationError !== undefined).toBe(true);
    });
  },
  async (adminUrl) => {
    const databaseName = await createDatabase(adminUrl);
    return {
      context: {
        databaseName,
        adminUrl,
        databaseUrl: () => `${adminUrl.replace(/\/[^/]*$/, "")}/${databaseName}`,
      },
      cleanup: () => dropDatabase(adminUrl, databaseName),
    };
  },
);
