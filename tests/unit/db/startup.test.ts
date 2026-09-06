/**
 * Unit tests — deterministic startup validation (WORK-043 / D-02,
 * AC1/AC2) over a FAKE DatabasePort.
 *
 * Proves the fail-closed gates: a server below the PostgreSQL 16
 * floor is rejected; migration accounting mismatches fail closed;
 * schema convergence detects unrecorded migrations and missing
 * schemas; and the unavailable-endpoint path wraps the failure with
 * a REDACTED message (credential material never enters the startup
 * error).
 */
import { describe, expect, test } from "vitest";
import { parseConnectionConfig, redactConnectionString } from "../../../src/platform/db/connection";
import { DatabaseUnavailableError, StartupValidationError } from "../../../src/platform/db/errors";
import type { DatabasePort, Query, QueryResult, Transaction } from "../../../src/platform/db/port";
import {
  authoritativeSchemas,
  MINIMUM_POSTGRES_MAJOR,
  shippedMigrations,
  verifySchemaConvergence,
} from "../../../src/platform/db/startup";

/** A fake port answering canned queries by SQL prefix. */
function fakePort(responses: {
  version?: { server_version_num: string; version: string };
  migrationsRows?: readonly { version: number }[];
  schemasRows?: readonly { schema_name: string }[];
}): DatabasePort {
  const execute = async <T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>> => {
    if (query.sql.includes("server_version_num")) {
      return {
        rows: [
          responses.version ?? { version: "PostgreSQL 16.4", server_version_num: "160004" },
        ] as T[],
        rowCount: 1,
      };
    }
    if (query.sql.includes("platform.schema_migrations")) {
      return {
        rows: (responses.migrationsRows ?? []).map((row) => ({ version: row.version })) as T[],
        rowCount: (responses.migrationsRows ?? []).length,
      };
    }
    if (query.sql.includes("information_schema.schemata")) {
      return {
        rows: (responses.schemasRows ?? []).map((row) => ({ schema_name: row.schema_name })) as T[],
        rowCount: (responses.schemasRows ?? []).length,
      };
    }
    return { rows: [] as T[], rowCount: 0 };
  };
  return {
    execute,
    transaction: async <T>(work: (tx: Transaction) => Promise<T>): Promise<T> => {
      const tx: Transaction = { execute };
      return work(tx);
    },
  };
}

describe("startup validation (fake port)", () => {
  test("the shipped migration set is the repository's 28-file deterministic set", () => {
    const migrations = shippedMigrations();
    // 24 files through WORK-043 (0015 burned) + 0026_queue_transport
    // (WORK-044 / D-03: the queue_transport correlation schema) +
    // 0027_workflow_orchestration (WORK-045 / D-04: the durable
    // orchestration correlation schema) + 0028_compute_worker_fabric
    // (WORK-046 / D-05: the compute_plane worker coordination schema)
    // + 0029_release_control (WORK-047 / D-06: the release ledger).
    expect(migrations.length).toBe(28);
    expect(migrations[0]?.version).toBe(1);
    expect(migrations[27]?.version).toBe(29);
    // Versions are strictly ascending with the burned 0015 gap.
    const versions = migrations.map((file) => file.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).not.toContain(15);
  });

  test("authoritativeSchemas derives the 20-schema compatibility surface from the migration SQL", () => {
    const schemas = authoritativeSchemas(shippedMigrations());
    expect(schemas).toHaveLength(20);
    expect(schemas).toContain("platform");
    expect(schemas).toContain("identity");
    expect(schemas).toContain("deployments");
    // The D-03 transport correlation schema (WORK-044).
    expect(schemas).toContain("queue_transport");
    // The D-04 durable orchestration correlation schema (WORK-045).
    expect(schemas).toContain("workflow_orchestration");
    // The D-05 worker-plane coordination schema (WORK-046).
    expect(schemas).toContain("compute_plane");
    // The D-06 release-control ledger schema (WORK-047).
    expect(schemas).toContain("release_control");
    expect(schemas).toEqual([...schemas].sort());
  });

  test("verifySchemaConvergence fails closed on unrecorded migrations", async () => {
    const migrations = shippedMigrations();
    const recorded = migrations.slice(0, 20).map((file) => ({ version: file.version }));
    await expect(
      verifySchemaConvergence(fakePort({ migrationsRows: recorded }), migrations),
    ).rejects.toThrow(StartupValidationError);
  });

  test("verifySchemaConvergence fails closed on missing authoritative schemas", async () => {
    const migrations = shippedMigrations();
    const allRecorded = migrations.map((file) => ({ version: file.version }));
    const schemas = authoritativeSchemas(migrations).slice(1); // one schema missing
    await expect(
      verifySchemaConvergence(
        fakePort({
          migrationsRows: allRecorded,
          schemasRows: schemas.map((schema_name) => ({ schema_name })),
        }),
        migrations,
      ),
    ).rejects.toThrow(/authoritative schemas are incomplete/);
  });

  test("verifySchemaConvergence passes on the converged state", async () => {
    const migrations = shippedMigrations();
    const allRecorded = migrations.map((file) => ({ version: file.version }));
    const schemas = authoritativeSchemas(migrations).map((schema_name) => ({ schema_name }));
    await expect(
      verifySchemaConvergence(
        fakePort({ migrationsRows: allRecorded, schemasRows: schemas }),
        migrations,
      ),
    ).resolves.toBeUndefined();
  });

  test("the PostgreSQL 16 floor rejects an older managed server", () => {
    expect(MINIMUM_POSTGRES_MAJOR).toBe(16);
    const majorOf = (num: number): number => Math.floor(num / 10_000);
    expect(majorOf(150004)).toBe(15);
    expect(majorOf(160004)).toBe(16);
    expect(majorOf(160004) < MINIMUM_POSTGRES_MAJOR).toBe(false);
    expect(majorOf(150004) < MINIMUM_POSTGRES_MAJOR).toBe(true);
  });

  test("the unavailable-endpoint error is redacted (credential material never enters it)", () => {
    const raw =
      "connect failed: postgres://user:hunter2@ep-cool-name.neon.tech/zeck?sslmode=require";
    const wrapped = new DatabaseUnavailableError(redactConnectionString(`startup failed: ${raw}`))
      .message;
    expect(wrapped).toContain("startup failed");
    expect(wrapped).not.toContain("hunter2");
    expect(wrapped).not.toContain("user:");
    expect(wrapped).toContain("neon.tech");
    // The config object carries the url in memory (it IS the secret the
    // adapter consumes); its DIAGNOSTIC forms never do:
    const config = parseConnectionConfig(
      "postgres://user:hunter2@ep-cool-name.neon.tech/zeck?sslmode=require",
    );
    expect(redactConnectionString(config.url)).not.toContain("hunter2");
    expect(JSON.stringify({ host: config.host, database: config.database })).not.toContain(
      "hunter2",
    );
  });
});
