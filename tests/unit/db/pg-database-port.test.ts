/**
 * Unit tests — the production pg `DatabasePort` adapter over a FAKE
 * pool (WORK-043 / D-02).
 *
 * Proves the port contract mechanics without a server: execute
 * releases the client; transaction wraps BEGIN/COMMIT and rolls back
 * on error with the ORIGINAL error propagating; a failing ROLLBACK
 * never masks the original failure; the closed adapter fails closed;
 * connect failures surface as typed `DatabaseUnavailableError`; and
 * the pool is constructed with the repository-defined bounds.
 */
import { describe, expect, test } from "vitest";
import { parseConnectionConfig } from "../../../src/platform/db/connection";
import { DatabaseUnavailableError } from "../../../src/platform/db/errors";
import { PgDatabasePort, type PoolLike } from "../../../src/platform/db/pg-database-port";

describe("PgDatabasePort (fake pool)", () => {
  const config = parseConnectionConfig("postgres://u:p@h/db", { max: 3 });

  test("execute runs the statement and releases the client", async () => {
    let released = 0;
    const pool: PoolLike = {
      connect: async () => ({
        query: async () => ({ rows: [{ n: 1 }], rowCount: 1 }),
        release: () => {
          released += 1;
        },
      }),
      end: async () => undefined,
      on: () => undefined,
    };
    const port = new PgDatabasePort(config, { createPool: () => pool });
    const result = await port.execute({ sql: "SELECT 1 AS n" });
    expect(result.rows).toEqual([{ n: 1 }]);
    expect(result.rowCount).toBe(1);
    expect(released).toBe(1);
  });

  test("transaction commits on success (BEGIN, work, COMMIT)", async () => {
    const statements: string[] = [];
    const pool: PoolLike = {
      connect: async () => ({
        query: async (sql: string) => {
          statements.push(sql);
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
      }),
      end: async () => undefined,
      on: () => undefined,
    };
    const port = new PgDatabasePort(config, { createPool: () => pool });
    const value = await port.transaction(async (tx) => {
      await tx.execute({ sql: "INSERT INTO t VALUES (1)" });
      return "committed";
    });
    expect(value).toBe("committed");
    expect(statements).toEqual(["BEGIN", "INSERT INTO t VALUES (1)", "COMMIT"]);
  });

  test("transaction rolls back on failure and the ORIGINAL error propagates", async () => {
    const statements: string[] = [];
    const pool: PoolLike = {
      connect: async () => ({
        query: async (sql: string) => {
          statements.push(sql);
          if (sql === "COMMIT") {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
      }),
      end: async () => undefined,
      on: () => undefined,
    };
    const port = new PgDatabasePort(config, { createPool: () => pool });
    await expect(
      port.transaction(async () => {
        throw new Error("business rule violation");
      }),
    ).rejects.toThrow("business rule violation");
    expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
  });

  test("a failing ROLLBACK never masks the original error", async () => {
    const pool: PoolLike = {
      connect: async () => ({
        query: async (sql: string) => {
          if (sql === "ROLLBACK") {
            throw new Error("connection was killed mid-rollback");
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
      }),
      end: async () => undefined,
      on: () => undefined,
    };
    const port = new PgDatabasePort(config, { createPool: () => pool });
    await expect(
      port.transaction(async () => {
        throw new Error("original operation failure");
      }),
    ).rejects.toThrow("original operation failure");
  });

  test("connect failures surface as DatabaseUnavailableError without credentials", async () => {
    const pool: PoolLike = {
      connect: async () => {
        throw new Error("ECONNREFUSED postgres://user:pass@h:5432/db");
      },
      end: async () => undefined,
      on: () => undefined,
    };
    const port = new PgDatabasePort(config, { createPool: () => pool });
    const error = await port.execute({ sql: "SELECT 1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseUnavailableError);
    const message = (error as Error).message;
    expect(message).toContain("unavailable");
    // The raw driver error text carried a URL with credentials — the
    // typed wrapper must not carry the credential part verbatim.
    expect(message).not.toContain("user:pass@");
  });

  test("a closed adapter fails closed for execute and transaction", async () => {
    const pool: PoolLike = {
      connect: async () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => undefined,
      }),
      end: async () => undefined,
      on: () => undefined,
    };
    const port = new PgDatabasePort(config, { createPool: () => pool });
    await port.close();
    await expect(port.execute({ sql: "SELECT 1" })).rejects.toThrow(DatabaseUnavailableError);
    await expect(port.transaction(async () => "x")).rejects.toThrow(DatabaseUnavailableError);
  });

  test("ping maps the server version row", async () => {
    const pool: PoolLike = {
      connect: async () => ({
        query: async () => ({
          rows: [{ version: "PostgreSQL 16.4", server_version_num: "160004" }],
          rowCount: 1,
        }),
        release: () => undefined,
      }),
      end: async () => undefined,
      on: () => undefined,
    };
    const port = new PgDatabasePort(config, { createPool: () => pool });
    const ping = await port.ping();
    expect(ping.serverVersionNum).toBe(160004);
    expect(ping.serverVersion).toBe("PostgreSQL 16.4");
  });

  test("the pool receives the repository-defined bounds and never the raw URL elsewhere", () => {
    let received: Record<string, unknown> | undefined;
    const pool: PoolLike = {
      connect: async () => {
        throw new Error("unused");
      },
      end: async () => undefined,
      on: () => undefined,
    };
    const bounded = parseConnectionConfig("postgres://u:p@h/db", {
      max: 5,
      connectionTimeoutMillis: 2500,
      idleTimeoutMillis: 10_000,
    });
    new PgDatabasePort(bounded, {
      createPool: (poolConfig) => {
        received = { ...poolConfig };
        return pool;
      },
    });
    expect(received?.max).toBe(5);
    expect(received?.connectionTimeoutMillis).toBe(2500);
    expect(received?.idleTimeoutMillis).toBe(10_000);
  });
});
