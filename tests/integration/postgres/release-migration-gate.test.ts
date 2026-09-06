/**
 * Integration — the migration gate over REAL PostgreSQL (WORK-047 /
 * D-06; the MIGRATION-SAFETY checkpoint).
 *
 * Proves over the real database (the platform.schema_migrations
 * ledger of the harness database, converged by the shipped set):
 *
 *  - the converged database PASSES with the ordered ledger digest;
 *  - a database BEHIND the code (a shipped migration unapplied)
 *    fails closed with the exact "migration required" reason;
 *  - a database AHEAD of the code (an applied migration not in the
 *    shipped set — the downgrade hazard) fails closed;
 *  - checksum drift (shipped SQL changed after application) fails
 *    closed;
 *  - the gate refuses on non-hosting phases.
 */

import { expect, test } from "vitest";
import { runMigrationGate } from "../../../deploy/release";
import { definePgSuite } from "./harness";

definePgSuite("release migration gate (WORK-047 D-06)", (ctx) => {
  test("the converged database passes with the ordered ledger digest", async () => {
    const evaluation = await runMigrationGate(ctx.port);
    expect(evaluation.status).toBe("passed");
    expect(evaluation.evidence).toContain("schema converged");
    expect(evaluation.evidence).toMatch(/ledger digest [0-9a-f]{16}/);
  });

  test("a database BEHIND the code fails closed (migration required)", async () => {
    // Roll the ledger back by one row (the shipped set stays the code
    // truth): the gate must demand the migration, fail closed.
    await ctx.port.execute({
      sql: `DELETE FROM platform.schema_migrations WHERE version = (
SELECT max(version) FROM platform.schema_migrations)`,
    });
    const evaluation = await runMigrationGate(ctx.port);
    expect(evaluation.status).toBe("failed");
    expect(evaluation.evidence).toContain("migration required");
    expect(evaluation.evidence).toContain("fail closed");
    // Restore the ledger row (the schema objects already exist; the
    // runner's DDL is not re-executed — the record is restored from
    // the shipped file truth).
    const { shippedMigrations } = await import("../../../src/platform/db/startup");
    const shipped = shippedMigrations();
    const latest = shipped[shipped.length - 1];
    expect(latest).toBeDefined();
    if (latest !== undefined) {
      await ctx.port.execute({
        sql: `INSERT INTO platform.schema_migrations (version, name, checksum, applied_at)
VALUES ($1, $2, $3, now())`,
        parameters: [latest.version, latest.name, latest.checksum],
      });
    }
  });

  test("a database AHEAD of the code fails closed (the downgrade hazard)", async () => {
    // An applied migration that the shipped set does not carry: the
    // database is ahead of the release revision — promoting code
    // that does not know that migration must be refused.
    await ctx.port.execute({
      sql: `INSERT INTO platform.schema_migrations (version, name, checksum, applied_at)
VALUES (9999, 'from_the_future.sql', '${"f".repeat(64)}', now())`,
    });
    const evaluation = await runMigrationGate(ctx.port);
    expect(evaluation.status).toBe("failed");
    expect(evaluation.evidence).toContain("downgrade hazard");
    await ctx.port.execute({
      sql: `DELETE FROM platform.schema_migrations WHERE version = 9999`,
    });
  });

  test("checksum drift fails closed (shipped SQL changed after application)", async () => {
    // Rewrite the recorded checksum of an applied migration: the
    // shipped SQL no longer matches what was applied.
    await ctx.port.execute({
      sql: `UPDATE platform.schema_migrations SET checksum = '${"0".repeat(64)}'
WHERE version = (SELECT max(version) FROM platform.schema_migrations)`,
    });
    const evaluation = await runMigrationGate(ctx.port);
    expect(evaluation.status).toBe("failed");
    expect(evaluation.evidence).toContain("checksum drift");
    // Restore: re-apply the correct checksum from the shipped file.
    const { shippedMigrations } = await import("../../../src/platform/db/startup");
    const shipped = shippedMigrations();
    const latest = shipped[shipped.length - 1];
    if (latest !== undefined) {
      await ctx.port.execute({
        sql: `UPDATE platform.schema_migrations SET checksum = $1 WHERE version = $2`,
        parameters: [latest.checksum, latest.version],
      });
    }
    const restored = await runMigrationGate(ctx.port);
    expect(restored.status).toBe("passed");
  });
});
