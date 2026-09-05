/**
 * Production `DatabasePort` adapter over the `pg` driver
 * (WORK-043 / D-02 — the adapter the port header pre-announced).
 *
 * The `pg` package is pinned to this directory by the provider-SDK
 * boundary table (`tests/architecture/`); no other `src/` surface may
 * import a driver. The adapter implements the port contract exactly:
 *
 * - `execute` — one pooled client, one statement, released in
 *   `finally`;
 * - `transaction` — BEGIN / work / COMMIT with ROLLBACK on any
 *   failure, the connection always released. A failing ROLLBACK is
 *   secondary noise: the ORIGINAL error propagates (a broken
 *   connection cannot rollback anything).
 *
 * The pool is constructed with the repository-defined bounds from
 * `connection.ts` and the canonical error guard (a client socket
 * error surfacing outside a query is re-emitted on the pool; without
 * a listener that is an unhandled exception). Provider unavailability
 * fails closed as `DatabaseUnavailableError` with a REDACTED
 * diagnostic — connection strings never enter errors or logs.
 */
import { Pool, type PoolConfig } from "pg";
import { type DatabaseConnectionConfig, redactConnectionString } from "./connection";
import { DatabaseUnavailableError } from "./errors";
import type { DatabasePort, Query, QueryResult, Transaction } from "./port";

/** The structural pool surface the adapter needs (injectable for tests). */
export interface PoolLike {
  connect(): Promise<unknown>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): void;
}

export interface PgAdapterOptions {
  /**
   * The pg pool constructor for this adapter instance. Injected so
   * tests can substitute fakes; production callers pass `new Pool`.
   */
  readonly createPool: (config: PoolConfig) => PoolLike;
}

interface QueryRowsResult {
  readonly rows: unknown[];
  readonly rowCount: number | null;
}

interface ClientLike {
  query(sql: string, parameters?: readonly unknown[]): Promise<QueryRowsResult>;
  release(): void;
}

function mapResult<T>(result: QueryRowsResult): QueryResult<T> {
  return {
    rows: result.rows as readonly T[],
    rowCount: result.rowCount ?? result.rows.length,
  };
}

class PgTransaction implements Transaction {
  constructor(private readonly client: ClientLike) {}

  async execute<T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>> {
    const result = await this.client.query(query.sql, query.parameters as unknown[]);
    return mapResult<T>(result as QueryRowsResult);
  }
}

export class PgDatabasePort implements DatabasePort {
  private readonly pool: PoolLike;
  private closed = false;

  constructor(
    config: DatabaseConnectionConfig,
    options: PgAdapterOptions = { createPool: (c) => new Pool(c) },
  ) {
    this.pool = options.createPool({
      connectionString: config.url,
      max: config.pool.max,
      connectionTimeoutMillis: config.pool.connectionTimeoutMillis,
      idleTimeoutMillis: config.pool.idleTimeoutMillis,
      // Credential material never enters a pool-level diagnostic.
      application_name: "zeck-authoritative-db",
    });
    // The canonical pg pool guard: teardown-time transport noise must
    // not become an unhandled exception that fails an otherwise green
    // run (see the integration harness's identical rationale).
    this.pool.on("error", () => undefined);
  }

  async execute<T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>> {
    this.assertOpen();
    const client = await this.connect();
    try {
      const result = await client.query(query.sql, query.parameters as unknown[]);
      return mapResult<T>(result as QueryRowsResult);
    } finally {
      client.release();
    }
  }

  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    this.assertOpen();
    const client = await this.connect();
    try {
      await client.query("BEGIN");
      const result = await work(new PgTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // The connection is broken beyond rollback; the ORIGINAL error
        // is the operationally meaningful one. The rollback failure is
        // dropped deliberately — the release below returns the (dead)
        // client to the pool, which discards it on its next check.
        void rollbackError;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Liveness probe against the authoritative server. */
  async ping(): Promise<{ readonly serverVersion: string; readonly serverVersionNum: number }> {
    const result = await this.execute<{ version: string; server_version_num: string }>({
      sql: "SELECT version() AS version, current_setting('server_version_num') AS server_version_num",
    });
    const row = result.rows[0];
    if (row === undefined) {
      throw new DatabaseUnavailableError("the server returned no version information");
    }
    return {
      serverVersion: row.version,
      serverVersionNum: Number.parseInt(row.server_version_num, 10),
    };
  }

  /** Drain the pool. Subsequent operations fail closed. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.pool.end();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new DatabaseUnavailableError(
        "the authoritative database adapter is closed (startup failed or the process is shutting down)",
      );
    }
  }

  private async connect(): Promise<ClientLike> {
    try {
      const client = await this.pool.connect();
      return client as unknown as ClientLike;
    } catch (error) {
      // The driver error may EMBED the connection URL (credentials) —
      // redact before the typed failure surfaces anywhere.
      throw new DatabaseUnavailableError(
        `the authoritative PostgreSQL endpoint is unavailable: ${redactConnectionString(
          (error as Error).message,
        )}`,
      );
    }
  }
}

/** Build the production adapter from validated connection configuration. */
export function createPgDatabasePort(config: DatabaseConnectionConfig): PgDatabasePort {
  return new PgDatabasePort(config);
}
