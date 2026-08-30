/**
 * Forward-only SQL migration runner (WORK-002).
 *
 * `src/platform/db/migrations/README.md` pre-announced this runner: migrations
 * are SQL files under this directory, applied exactly once, never edited
 * after merge; corrections are new migrations.
 *
 * Guarantees:
 *  - Forward-only: there is no down/revert path.
 *  - Exactly-once: applied versions are recorded in `platform.schema_migrations`
 *    inside the same transaction as the migration itself.
 *  - Integrity: a tracked file whose checksum no longer matches the recorded
 *    value fails closed (migrations are immutable after merge).
 *  - Serialized: a PostgreSQL advisory lock serializes concurrent runners.
 *  - Order: versions apply in ascending order; gaps are allowed, reordering
 *    applied versions is not (an unapplied version below the highest applied
 *    version fails closed as a reordered history).
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabasePort } from "../port";

/** Applied-migration record as persisted in `platform.schema_migrations`. */
export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

/** A migration file loaded for application. */
export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export class MigrationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationIntegrityError";
  }
}

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/** Load `NNNN_name.sql` files from a directory, ordered by version. */
export function loadMigrations(directory: string): MigrationFile[] {
  const files = readdirSync(directory)
    .map((name): MigrationFile | null => {
      const match = MIGRATION_FILE_PATTERN.exec(name);
      if (match === null || match[1] === undefined || match[2] === undefined) {
        return null;
      }
      const sql = readFileSync(join(directory, name), "utf8");
      return {
        version: Number.parseInt(match[1], 10),
        name: match[2],
        sql,
        checksum: checksumOf(sql),
      } satisfies MigrationFile;
    })
    .filter((entry): entry is MigrationFile => entry !== null)
    .sort((a, b) => a.version - b.version);

  const versions = files.map((file) => file.version);
  if (new Set(versions).size !== versions.length) {
    throw new MigrationIntegrityError(`duplicate migration version under ${directory}`);
  }
  return files;
}

interface MigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: string;
}

/**
 * Split a migration file into executable statements.
 *
 * Statements are separated by `;` at end of line. Block comments (`-- ...`
 * line comments and `/* ... *\/` blocks) are stripped before splitting;
 * statement bodies must not contain `;` line endings inside strings — the
 * migration files in this directory are written to that rule (no functions,
 * no embedded `;` inside string literals at line end).
 */
export function splitStatements(sql: string): string[] {
  const withoutComments = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*--.*$/gm, " ");
  return withoutComments
    .split(/;\s*\n|;\s*$/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function ensureTrackingTable(exec: {
  execute(query: {
    readonly sql: string;
    readonly parameters?: readonly unknown[];
  }): Promise<unknown>;
}): Promise<void> {
  await exec.execute({ sql: "CREATE SCHEMA IF NOT EXISTS platform" });
  await exec.execute({
    sql: `CREATE TABLE IF NOT EXISTS platform.schema_migrations (
    version     integer PRIMARY KEY,
    name        text NOT NULL,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
)`,
  });
}

/** Advisory-lock key derived from a stable namespace string. */
function advisoryKey(namespace: string): [number, number] {
  const digest = createHash("sha256").update(namespace, "utf8").digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export interface RunMigrationsResult {
  readonly applied: readonly { readonly version: number; readonly name: string }[];
  readonly skipped: number;
}

/**
 * Apply every not-yet-applied migration (in order) inside the advisory-lock
 * serialization window. Each migration + its tracking row commit atomically;
 * a failing migration rolls back only itself and the run aborts.
 */
export async function runMigrations(
  db: DatabasePort,
  migrations: readonly MigrationFile[],
): Promise<RunMigrationsResult> {
  if (migrations.length === 0) {
    return { applied: [], skipped: 0 };
  }

  return db.transaction(async (tx) => {
    const [key1, key2] = advisoryKey("zeck:db-migrations");
    await tx.execute({
      sql: "SELECT pg_advisory_xact_lock($1, $2)",
      parameters: [key1, key2],
    });

    await ensureTrackingTable(tx);

    const existing = await tx.execute<MigrationRow>({
      sql: "SELECT version, name, checksum, applied_at FROM platform.schema_migrations ORDER BY version",
    });
    const appliedByVersion = new Map(existing.rows.map((row) => [row.version, row]));

    for (const file of migrations) {
      const recorded = appliedByVersion.get(file.version);
      if (recorded) {
        if (recorded.checksum !== file.checksum) {
          throw new MigrationIntegrityError(
            `migration ${file.version} (${recorded.name}) was modified after being applied: recorded checksum ${recorded.checksum} != file checksum ${file.checksum}`,
          );
        }
        if (recorded.name !== file.name) {
          throw new MigrationIntegrityError(
            `migration ${file.version} was renamed after being applied: recorded name ${recorded.name} != file name ${file.name}`,
          );
        }
        continue;
      }
      if (file.version <= Math.max(...appliedByVersion.keys(), 0)) {
        throw new MigrationIntegrityError(
          `migration ${file.version} (${file.name}) is below the highest applied version; migration history may not be reordered`,
        );
      }
    }

    const appliedNow: { version: number; name: string }[] = [];
    for (const file of migrations) {
      if (appliedByVersion.has(file.version)) {
        continue;
      }
      for (const statement of splitStatements(file.sql)) {
        await tx.execute({ sql: statement });
      }
      await tx.execute({
        sql: "INSERT INTO platform.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
        parameters: [file.version, file.name, file.checksum],
      });
      appliedNow.push({ version: file.version, name: file.name });
    }

    return { applied: appliedNow, skipped: migrations.length - appliedNow.length };
  });
}

/** Convenience: load and apply the migrations shipped in this directory. */
export async function applyShippedMigrations(db: DatabasePort): Promise<RunMigrationsResult> {
  const directory = dirname(fileURLToPath(import.meta.url));
  return runMigrations(db, loadMigrations(directory));
}
