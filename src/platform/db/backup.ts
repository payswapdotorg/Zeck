/**
 * Logical backup and restore of the authoritative PostgreSQL state
 * (WORK-043 / D-02, acceptance criterion 8 — the engine behind the
 * executed restore drill).
 *
 * DESIGN (why a port-based logical backup):
 *
 * - The DDL authority is the SHIPPED MIGRATIONS, not a dump: restore
 *   re-applies the deterministic migration set to a fresh database
 *   and then restores only AUTHORITATIVE DATA. Schema recovery is
 *   exactly the repository-defined path every deployment already
 *   takes (`startup.ts`) — no binary pg_dump dependency, works
 *   identically against any PostgreSQL 16+ endpoint (managed Neon
 *   included).
 * - Everything crosses the provider-neutral `DatabasePort` — the
 *   same transactional contract the modules use, proving the port's
 *   completeness for recovery.
 * - The artifact is a JSON manifest with per-table sha256 content
 *   checksums and the migration history; restore VERIFIES itself:
 *   every table is re-read and re-hashed, the migration history must
 *   match the backup exactly, and any drift fails closed as
 *   `RestoreVerificationError`.
 * - Restore runs inside ONE transaction with
 *   `session_replication_role = replica`: FK and immutability
 *   triggers are disabled while the exact historical state is
 *   restored (write-once guards protect LIVE mutations, not
 *   recovery); sequences are re-seeded from the restored maxima so
 *   future inserts do not collide.
 * - No secrets: Zeck's authoritative state never contains secret
 *   plaintext (external materialization); the artifact is data, and
 *   its location is the operator's (disposable recovery resource).
 */
import { createHash } from "node:crypto";
import { RestoreVerificationError } from "./errors";
import type { DatabasePort } from "./port";

export interface BackupTable {
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly identityColumns: readonly string[];
  readonly storedGeneratedColumns: readonly string[];
  readonly rowCount: number;
  readonly contentChecksum: string;
  readonly rows: readonly Record<string, unknown>[];
}

export interface LogicalBackup {
  readonly format: "zeck-logical-backup";
  readonly version: 1;
  readonly createdAt: string;
  readonly migrationHistory: readonly {
    readonly version: number;
    readonly name: string;
    readonly checksum: string;
  }[];
  readonly tables: readonly BackupTable[];
}

export interface BackupSummary {
  readonly tableCount: number;
  readonly rowCount: number;
  readonly schemaCount: number;
}

/** Tables whose data is the migration runner's own bookkeeping. */
const RUNNER_OWNED_TABLES = new Set(["platform.schema_migrations"]);

interface CatalogTable {
  readonly schema: string;
  readonly table: string;
}

interface MigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: Date;
}

function sha256OfText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The bytea serialization tag (chosen to be collision-unlikely in jsonb data). */
const BYTEA_TAG = "__zeck_bytea_hex__";

/**
 * Serialize one cell value into the deterministic backup form.
 * Dates → ISO strings; bytea Buffers → tagged hex; jsonb objects
 * stay JSON; everything else passes through (pg already returns
 * text for bigint/numeric).
 */
export function serializeCell(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return { [BYTEA_TAG]: value.toString("hex") };
  }
  if (Array.isArray(value)) {
    return value.map(serializeCell);
  }
  return value;
}

/**
 * Deserialize a backup cell back into the driver-ready form: bytea
 * tags become Buffers; jsonb objects/arrays become JSON TEXT (pg
 * would otherwise serialize JS arrays as PostgreSQL array literals,
 * which is invalid JSON for jsonb columns).
 */
export function deserializeCell(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const tagged = record[BYTEA_TAG];
  if (typeof tagged === "string") {
    return Buffer.from(tagged, "hex");
  }
  // jsonb objects/arrays (nested structures intact) become JSON TEXT:
  // pg would otherwise serialize JS arrays as PostgreSQL array
  // literals, which is invalid JSON for jsonb columns.
  return JSON.stringify(value);
}

interface ColumnInfo {
  readonly column: string;
  readonly isIdentity: boolean;
  readonly isStoredGenerated: boolean;
}

async function tableColumns(
  port: DatabasePort,
  table: CatalogTable,
): Promise<readonly ColumnInfo[]> {
  interface Row {
    readonly column_name: string;
    readonly is_identity: string;
    readonly is_generated: string;
  }
  const result = await port.execute<Row>({
    sql: `SELECT column_name, is_identity, is_generated
FROM information_schema.columns
WHERE table_schema = $1 AND table_name = $2
ORDER BY ordinal_position`,
    parameters: [table.schema, table.table],
  });
  return result.rows.map((row) => ({
    column: row.column_name,
    isIdentity: row.is_identity === "YES",
    isStoredGenerated: row.is_generated === "ALWAYS",
  }));
}

async function primaryKeyOf(port: DatabasePort, table: CatalogTable): Promise<readonly string[]> {
  interface Row {
    readonly attname: string;
  }
  const result = await port.execute<Row>({
    sql: `SELECT a.attname
FROM pg_index i
JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
WHERE i.indrelid = ($1 || '.' || $2)::regclass AND i.indisprimary
ORDER BY a.attnum`,
    parameters: [table.schema, table.table],
  });
  return result.rows.map((row) => row.attname);
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new RestoreVerificationError(`refusing to quote non-conformant identifier: ${name}`);
  }
  return `"${name}"`;
}

/**
 * Create a full logical backup of the authoritative state through
 * the port. Tables are enumerated from the catalog (ordered
 * deterministically), rows are ordered by primary key, and every
 * table carries a sha256 content checksum.
 */
export async function createLogicalBackup(
  port: DatabasePort,
  schemas: readonly string[],
): Promise<LogicalBackup> {
  interface TableRow {
    readonly table_schema: string;
    readonly table_name: string;
  }
  const tablesResult = await port.execute<TableRow>({
    sql: `SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema = ANY($1::text[]) AND table_type = 'BASE TABLE'
ORDER BY table_schema, table_name`,
    parameters: [schemas],
  });
  const catalogTables: CatalogTable[] = tablesResult.rows
    .map((row) => ({ schema: row.table_schema, table: row.table_name }))
    .filter((table) => !RUNNER_OWNED_TABLES.has(`${table.schema}.${table.table}`));

  const history = await port.execute<MigrationRow>({
    sql: "SELECT version, name, checksum, applied_at FROM platform.schema_migrations ORDER BY version",
  });

  const backupTables: BackupTable[] = [];
  for (const table of catalogTables) {
    const columns = await tableColumns(port, table);
    const insertable = columns.filter((column) => !column.isStoredGenerated);
    const primaryKey = await primaryKeyOf(port, table);
    const orderColumns =
      primaryKey.length > 0 ? primaryKey : insertable.map((column) => column.column);
    const selectList = insertable.map((column) => quoteIdent(column.column)).join(", ");
    const orderBy = orderColumns.map((column) => quoteIdent(column)).join(", ");
    const rows = await port.execute({
      sql: `SELECT ${selectList} FROM ${quoteIdent(table.schema)}.${quoteIdent(table.table)} ORDER BY ${orderBy}`,
    });
    const serializedRows = rows.rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const column of insertable) {
        out[column.column] = serializeCell((row as Record<string, unknown>)[column.column]);
      }
      return out;
    });
    backupTables.push({
      schema: table.schema,
      table: table.table,
      columns: insertable.map((column) => column.column),
      identityColumns: columns.filter((column) => column.isIdentity).map((column) => column.column),
      storedGeneratedColumns: columns
        .filter((column) => column.isStoredGenerated)
        .map((column) => column.column),
      rowCount: serializedRows.length,
      contentChecksum: sha256OfText(JSON.stringify(serializedRows)),
      rows: serializedRows,
    });
  }

  return {
    format: "zeck-logical-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    migrationHistory: history.rows.map((row) => ({
      version: row.version,
      name: row.name,
      checksum: row.checksum,
    })),
    tables: backupTables,
  };
}

export interface RestoreOutcome {
  readonly tables: readonly {
    readonly schema: string;
    readonly table: string;
    readonly rows: number;
  }[];
  readonly sequencesReseeded: number;
  readonly verification: readonly {
    readonly schema: string;
    readonly table: string;
    readonly rowCount: number;
    readonly checksum: string;
    readonly verified: boolean;
  }[];
}

const BATCH_ROWS = 200;

/**
 * Restore a logical backup into the CURRENT database state (the
 * caller applies the shipped migrations first —
 * `restoreAuthoritativeDatabase` composes the full procedure).
 *
 * Fail-closed guarantees:
 * - incompatible backup format/version ⇒ refuse;
 * - target migration history must EQUAL the backup's history;
 * - the whole data phase is ONE transaction (atomic);
 * - every restored table is re-read and re-hashed; any drift ⇒
 *   `RestoreVerificationError` and the transaction ABORTS (the
 *   database is left at the migration-only state, never
 *   half-restored).
 */
export async function restoreDataIntoCurrentState(
  port: DatabasePort,
  backup: LogicalBackup,
): Promise<RestoreOutcome> {
  if (backup.format !== "zeck-logical-backup" || backup.version !== 1) {
    throw new RestoreVerificationError(
      "the backup artifact is not a zeck-logical-backup v1 manifest (refusing to restore)",
    );
  }
  const history = await port.execute<{ version: number; name: string; checksum: string }>({
    sql: "SELECT version, name, checksum FROM platform.schema_migrations ORDER BY version",
  });
  const targetHistory = history.rows.map((row) => `${row.version}:${row.name}:${row.checksum}`);
  const backupHistory = backup.migrationHistory.map(
    (row) => `${row.version}:${row.name}:${row.checksum}`,
  );
  if (targetHistory.join("|") !== backupHistory.join("|")) {
    throw new RestoreVerificationError(
      `the target's migration history does not match the backup (backup has ${backupHistory.length} migrations, target has ${targetHistory.length}; a backup may only be restored onto the identical revision history)`,
    );
  }
  if (backup.tables.some((table) => table.table === "schema_migrations")) {
    throw new RestoreVerificationError(
      "the backup manifest must not carry migration-runner bookkeeping rows",
    );
  }

  const restored: { schema: string; table: string; rows: number }[] = [];
  const sequencesReseeded = await port.transaction(async (tx) => {
    // Restore-mode: disable FK/immutability triggers for the exact
    // historical state; the surrounding transaction keeps this
    // scoped to the restore session.
    await tx.execute({ sql: "SET LOCAL session_replication_role = replica" });
    for (const table of backup.tables) {
      if (table.columns.length === 0 || table.rowCount === 0) {
        restored.push({ schema: table.schema, table: table.table, rows: 0 });
        continue;
      }
      const columnList = table.columns.map((column) => quoteIdent(column)).join(", ");
      const overriding = table.identityColumns.length > 0 ? "OVERRIDING SYSTEM VALUE" : "";
      const statement = `INSERT INTO ${quoteIdent(table.schema)}.${quoteIdent(table.table)} (${columnList})${
        overriding.length > 0 ? ` ${overriding}` : ""
      } VALUES `;
      for (let offset = 0; offset < table.rows.length; offset += BATCH_ROWS) {
        const batch = table.rows.slice(offset, offset + BATCH_ROWS);
        const values: unknown[] = [];
        const tuples = batch
          .map((row) => {
            const tuple = table.columns.map((column) => {
              values.push(deserializeCell(row[column]));
              return `$${values.length}`;
            });
            return `(${tuple.join(", ")})`;
          })
          .join(", ");
        await tx.execute({ sql: `${statement}${tuples}`, parameters: values });
      }
      restored.push({ schema: table.schema, table: table.table, rows: table.rows.length });
    }
    // Re-seed sequences (serial + identity) from the restored maxima
    // so future inserts never collide with restored ids.
    let reseeded = 0;
    for (const table of backup.tables) {
      const sequenceColumns = await sequenceBackedColumns(tx, table.schema, table.table);
      for (const column of sequenceColumns) {
        await tx.execute({
          sql: `SELECT setval(
pg_get_serial_sequence(${quoteLiteral(`${table.schema}.${table.table}`)}, ${quoteLiteral(column)}),
GREATEST(COALESCE((SELECT MAX(${quoteIdent(column)}) FROM ${quoteIdent(table.schema)}.${quoteIdent(table.table)}), 0), 1),
(SELECT MAX(${quoteIdent(column)}) FROM ${quoteIdent(table.schema)}.${quoteIdent(table.table)}) IS NOT NULL)`,
        });
        reseeded += 1;
      }
    }
    return reseeded;
  });

  // Self-verification: re-read every table and re-hash.
  const verification: {
    schema: string;
    table: string;
    rowCount: number;
    checksum: string;
    verified: boolean;
  }[] = [];
  for (const table of backup.tables) {
    const insertableColumns = table.columns;
    const primaryKey = await primaryKeyOf(port, {
      schema: table.schema,
      table: table.table,
    });
    const orderColumns = primaryKey.length > 0 ? primaryKey : insertableColumns;
    const selectList =
      insertableColumns.length === 0 ? "*" : insertableColumns.map(quoteIdent).join(", ");
    const orderBy = orderColumns.map(quoteIdent).join(", ");
    const rows = await port.execute({
      sql: `SELECT ${selectList} FROM ${quoteIdent(table.schema)}.${quoteIdent(table.table)} ORDER BY ${orderBy}`,
    });
    const serializedRows = rows.rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const column of insertableColumns) {
        out[column] = serializeCell((row as Record<string, unknown>)[column]);
      }
      return out;
    });
    const checksum = sha256OfText(JSON.stringify(serializedRows));
    verification.push({
      schema: table.schema,
      table: table.table,
      rowCount: serializedRows.length,
      checksum,
      verified: checksum === table.contentChecksum && serializedRows.length === table.rowCount,
    });
  }
  const failed = verification.filter((entry) => !entry.verified);
  if (failed.length > 0) {
    throw new RestoreVerificationError(
      `restore verification failed for ${failed.length} table(s): ${failed
        .map((entry) => `${entry.schema}.${entry.table}`)
        .join(", ")} (row counts or content checksums do not match the backup)`,
    );
  }
  return { tables: restored, sequencesReseeded, verification };
}

async function sequenceBackedColumns(
  tx: { execute(query: { sql: string; parameters?: readonly unknown[] }): Promise<unknown> },
  schema: string,
  table: string,
): Promise<readonly string[]> {
  // Sequences back BOTH serial columns (column_default LIKE
  // 'nextval(%') and GENERATED ALWAYS AS IDENTITY columns
  // (pg_attribute.attidentity) — both must be re-seeded after a
  // data restore.
  interface Row {
    readonly column_name: string;
  }
  const result = (await tx.execute({
    sql: `SELECT a.attname AS column_name
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
  AND (
    a.attidentity IN ('a', 'd')
    OR EXISTS (
      SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = $1 AND ic.table_name = $2
        AND ic.column_name = a.attname AND ic.column_default LIKE 'nextval(%'
    )
  )`,
    parameters: [schema, table],
  })) as { rows: Row[] };
  return result.rows.map((row) => row.column_name);
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A redacted, non-secret summary of a backup (for reports/evidence). */
export function backupSummary(backup: LogicalBackup): BackupSummary {
  const schemas = new Set(backup.tables.map((table) => table.schema));
  return {
    tableCount: backup.tables.length,
    rowCount: backup.tables.reduce((total, table) => total + table.rowCount, 0),
    schemaCount: schemas.size,
  };
}
