/**
 * Deterministic startup validation for the authoritative database
 * (WORK-043 / D-02, acceptance criteria 1–2).
 *
 * "Zeck can start against a managed PostgreSQL instance using
 * repository-defined configuration and the existing database port":
 * `startAuthoritativeDatabase` takes the validated connection
 * configuration (from the materialized `database-url` secret), builds
 * the pg `DatabasePort` adapter, and then proves, in order:
 *
 *  1. CONNECTIVITY — the endpoint answers (fail closed with a
 *     REDACTED `DatabaseUnavailableError`; a provider outage is
 *     never a silent success and never a fallback trigger);
 *  2. COMPATIBILITY — the server is PostgreSQL 16+ (the frozen
 *     schema's floor; older servers fail closed as
 *     `StartupValidationError`);
 *  3. MIGRATIONS — the shipped migrations apply exactly once,
 *     forward-only, advisory-lock serialized (the WORK-002 runner
 *     unchanged — determinism is a property of the runner, and the
 *     startup path re-proves it);
 *  4. CONVERGENCE — every shipped migration is recorded and the
 *     authoritative schemas the migrations define all exist (a
 *     wrong-database or permission-mangled state fails closed).
 *
 * Restart-safety: running startup twice applies migrations once and
 * skips them thereafter (the runner's exactly-once discipline); the
 * returned handle is fail-closed after `close()`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseConnectionConfig } from "./connection";
import { connectionEndpoint, parseConnectionConfig, redactConnectionString } from "./connection";
import { DatabaseUnavailableError, StartupValidationError } from "./errors";
import { applyShippedMigrations, loadMigrations, type MigrationFile } from "./migrations/runner";
import { PgDatabasePort } from "./pg-database-port";
import type { DatabasePort } from "./port";

/** The minimum supported PostgreSQL major version (frozen schema floor). */
export const MINIMUM_POSTGRES_MAJOR = 16;

export interface AuthoritativeDatabaseHandle {
  readonly port: DatabasePort;
  /** The applied/skipped migration counts of this startup run. */
  readonly migrations: { readonly applied: readonly string[]; readonly skipped: number };
  /** Redacted, non-secret endpoint identity (host/port/database only). */
  readonly endpoint: string;
  readonly serverVersion: string;
  close(): Promise<void>;
}

export interface StartupOptions {
  /** Connection pool overrides (bounded by `validatePoolConfig`). */
  readonly poolOverrides?: {
    max?: number;
    connectionTimeoutMillis?: number;
    idleTimeoutMillis?: number;
  };
  /**
   * Test seam: substitute the adapter construction (the discrimination
   * suite injects version-lying fakes to prove the compatibility
   * gate fails closed). Production callers omit it (the pg adapter
   * with repository-defined bounds is constructed here).
   */
  readonly portFactory?: (config: DatabaseConnectionConfig) => PgDatabasePort;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** The shipped migrations (the same source the runner ships). */
export function shippedMigrations(): readonly MigrationFile[] {
  return loadMigrations(MIGRATIONS_DIR);
}

/** Schemas the shipped migrations create (the compatibility surface). */
export function authoritativeSchemas(migrations: readonly MigrationFile[]): readonly string[] {
  const schemas = new Set<string>();
  const pattern = /CREATE SCHEMA (?:IF NOT EXISTS )?([a-z_]+)/g;
  for (const migration of migrations) {
    let match = pattern.exec(migration.sql);
    while (match !== null) {
      if (match[1] !== undefined) {
        schemas.add(match[1]);
      }
      match = pattern.exec(migration.sql);
    }
  }
  return [...schemas].sort();
}

interface SchemaNameRow {
  readonly schema_name: string;
}

/**
 * Verify the post-migration convergence: every shipped migration is
 * recorded and every authoritative schema exists.
 */
export async function verifySchemaConvergence(
  port: DatabasePort,
  migrations: readonly MigrationFile[],
): Promise<void> {
  interface VersionRow {
    readonly version: number;
  }
  const recorded = await port.execute<VersionRow>({
    sql: "SELECT version FROM platform.schema_migrations ORDER BY version",
  });
  const recordedVersions = new Set(recorded.rows.map((row) => row.version));
  const missing = migrations.filter((file) => !recordedVersions.has(file.version));
  if (missing.length > 0) {
    throw new StartupValidationError(
      `the authoritative schema is not converged: migrations not recorded on this database: ${missing
        .map((file) => `${file.version}_${file.name}`)
        .join(", ")}`,
    );
  }
  const expectedSchemas = authoritativeSchemas(migrations);
  const existing = await port.execute<SchemaNameRow>({
    sql: "SELECT schema_name FROM information_schema.schemata",
  });
  const existingSchemas = new Set(existing.rows.map((row) => row.schema_name));
  const absent = expectedSchemas.filter((schema) => !existingSchemas.has(schema));
  if (absent.length > 0) {
    throw new StartupValidationError(
      `the authoritative schemas are incomplete: missing ${absent.join(", ")}`,
    );
  }
}

/**
 * Start the authoritative database: validate compatibility, apply the
 * shipped migrations deterministically, prove convergence, and return
 * the fail-closed handle. This is the ONLY production startup path.
 */
export async function startAuthoritativeDatabase(
  url: string,
  options: StartupOptions = {},
): Promise<AuthoritativeDatabaseHandle> {
  const config: DatabaseConnectionConfig = parseConnectionConfig(url, options.poolOverrides ?? {});
  const adapter =
    options.portFactory !== undefined ? options.portFactory(config) : new PgDatabasePort(config);
  try {
    let ping: Awaited<ReturnType<PgDatabasePort["ping"]>>;
    try {
      ping = await adapter.ping();
    } catch (error) {
      throw new DatabaseUnavailableError(
        redactConnectionString(`startup failed: ${(error as Error).message}`),
      );
    }
    const major = Math.floor(ping.serverVersionNum / 10_000);
    if (Number.isNaN(major) || major < MINIMUM_POSTGRES_MAJOR) {
      throw new StartupValidationError(
        `the authoritative server is not PostgreSQL ${MINIMUM_POSTGRES_MAJOR}+ (reported version: ${ping.serverVersionNum})`,
      );
    }
    const migrations = shippedMigrations();
    const result = await applyShippedMigrations(adapter);
    if (result.applied.length + result.skipped !== migrations.length) {
      throw new StartupValidationError(
        `migration accounting mismatch: applied ${result.applied.length} + skipped ${result.skipped} != shipped ${migrations.length}`,
      );
    }
    await verifySchemaConvergence(adapter, migrations);
    let closed = false;
    return {
      port: adapter,
      migrations: {
        applied: result.applied.map((entry) => `${entry.version}_${entry.name}`),
        skipped: result.skipped,
      },
      endpoint: connectionEndpoint(config),
      serverVersion: ping.serverVersion,
      close: async () => {
        if (!closed) {
          closed = true;
          await adapter.close();
        }
      },
    };
  } catch (error) {
    await adapter.close();
    throw error;
  }
}
