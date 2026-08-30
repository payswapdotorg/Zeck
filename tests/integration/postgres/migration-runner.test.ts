/**
 * Real-PG: migration runner guarantees (WORK-002).
 */

import { describe, expect, test } from "vitest";
import {
  checksumOf,
  loadMigrations,
  MigrationIntegrityError,
  runMigrations,
  splitStatements,
} from "../../../src/platform/db/migrations/runner";
import { definePgSuite } from "./harness";

definePgSuite("migration runner on real PostgreSQL", (ctx) => {
  test("shipped migration applied and tracked", async () => {
    const { port } = ctx;
    const tracked = await port.execute<{ version: number; name: string; checksum: string }>({
      sql: "SELECT version, name, checksum FROM platform.schema_migrations ORDER BY version",
    });
    expect(tracked.rows.map((row) => row.version)).toEqual([1]);
    expect(tracked.rows[0]?.name).toBe("identity_tenants");
    expect(tracked.rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test("re-running is a no-op (exactly-once)", async () => {
    const { port } = ctx;
    const result = await runMigrations(port, loadMigrations("src/platform/db/migrations"));
    expect(result.applied).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  test("a modified applied migration fails closed (checksum integrity)", async () => {
    const { port } = ctx;
    const files = loadMigrations("src/platform/db/migrations");
    // A realistic tamper: content changes, so the file's checksum changes
    // with it (the runner must catch exactly this case).
    const mutated = files.map((file) => {
      if (file.version !== 1) {
        return file;
      }
      const sql = `${file.sql}\n-- tampered\n`;
      return { ...file, sql, checksum: checksumOf(sql) };
    });
    await expect(runMigrations(port, mutated)).rejects.toBeInstanceOf(MigrationIntegrityError);
  });

  test("a renamed applied migration fails closed", async () => {
    const { port } = ctx;
    const files = loadMigrations("src/platform/db/migrations");
    const renamed = files.map((file) => (file.version === 1 ? { ...file, name: "renamed" } : file));
    await expect(runMigrations(port, renamed)).rejects.toBeInstanceOf(MigrationIntegrityError);
  });

  test("an unapplied version below the highest applied version fails closed (no reordering)", async () => {
    const { port } = ctx;
    const files = [
      ...loadMigrations("src/platform/db/migrations"),
      { version: 0, name: "bootstrap_backdated", sql: "SELECT 1", checksum: "x" },
    ];
    await expect(runMigrations(port, files)).rejects.toBeInstanceOf(MigrationIntegrityError);
  });

  test("a new forward migration applies atomically with its tracking row", async () => {
    const { port } = ctx;
    const files = [
      ...loadMigrations("src/platform/db/migrations"),
      {
        version: 2,
        name: "probe_forward",
        sql: "CREATE TABLE platform.probe_forward (id integer PRIMARY KEY)",
        checksum: "probe",
      },
    ];
    const result = await runMigrations(port, files);
    expect(result.applied).toEqual([{ version: 2, name: "probe_forward" }]);
    // Failing forward migration rolls back its tracking row.
    const failing = [
      ...files,
      { version: 3, name: "probe_failing", sql: "CREATE TABLE broken (", checksum: "probe3" },
    ];
    await expect(runMigrations(port, failing)).rejects.toThrow();
    const tracked = await port.execute<{ version: number }>({
      sql: "SELECT version FROM platform.schema_migrations ORDER BY version",
    });
    expect(tracked.rows.map((row) => row.version)).toEqual([1, 2]);
  });

  test("statement splitting strips comments and keeps statements", () => {
    const statements = splitStatements(
      "-- leading comment\nSELECT 1;\n/* block\ncomment */\nSELECT 2;\n",
    );
    expect(statements).toEqual(["SELECT 1", "SELECT 2"]);
  });
});

describe("loadMigrations file contract", () => {
  test("only canonical NNNN_name.sql files load, ordered", () => {
    const files = loadMigrations("src/platform/db/migrations");
    expect(files.map((file) => file.version)).toEqual(
      [...files.map((file) => file.version)].sort((a, b) => a - b),
    );
    for (const file of files) {
      expect(`${String(file.version).padStart(4, "0")}_${file.name}.sql`).toMatch(
        /^\d{4}_[a-z0-9_]+\.sql$/,
      );
    }
  });
});
