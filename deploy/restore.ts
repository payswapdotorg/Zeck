/**
 * deploy/restore — execute the authoritative-state restore drill
 * (WORK-043 / D-02, acceptance criterion 8: restore must be
 * EXECUTED, never merely documented).
 *
 * The procedure (src/platform/db/backup.ts):
 *   1. create a FRESH disposable database on the admin endpoint
 *      (computed `zeck_restore_<random>` name, classification
 *      disposable — the recovery target must never be the live
 *      database);
 *   2. apply the shipped migrations deterministically (the DDL
 *      authority — the exact production startup path);
 *   3. restore the backup's authoritative DATA inside one
 *      transaction (replication-role restore mode; sequences
 *      re-seeded);
 *   4. VERIFY: re-read every table, re-hash, compare row counts and
 *      checksums; any drift fails closed (RestoreVerificationError)
 *      and the target is left at migration-only state;
 *   5. clean up the disposable recovery database (--drop) — the
 *      default keeps it for operator inspection (retention class:
 *      disposable recovery resource, see the evidence doc).
 *
 * Usage:
 *   bun run deploy:restore -- --environment local --from /tmp/zeck-backup.json [--drop]
 *
 * Provider environments: pass --admin-url (the managed PostgreSQL
 * admin URL materialized in the environment, e.g. a Neon primary
 * branch connection) — the tool creates the disposable target
 * database there. The operator's own credential materialization
 * applies; nothing enters argv.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import {
  backupSummary,
  type LogicalBackup,
  restoreDataIntoCurrentState,
} from "../src/platform/db/backup";
import { redactConnectionString } from "../src/platform/db/connection";
import { startAuthoritativeDatabase } from "../src/platform/db/startup";
import { evaluateEnvironmentContract } from "../src/platform/deployment/env-contract";
import { hasFlag, loadManifest, requireEnvironment } from "./lib";

function argumentValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name],
    );
    await client.query(`DROP DATABASE IF EXISTS ${name}`);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const environment = requireEnvironment(argv);
  const fromPath = argumentValue(argv, "--from");
  if (fromPath === undefined || fromPath.length === 0) {
    console.error("error: --from <file> is required (the backup artifact path)");
    process.exit(2);
  }
  const manifest = loadManifest();
  const contract = evaluateEnvironmentContract(manifest, environment, process.env);
  if (!contract.satisfied) {
    console.error(
      `error: the environment contract is not satisfied: ${contract.problems.join("; ")}`,
    );
    process.exit(2);
  }

  let adminUrl: string;
  if (environment === "local") {
    adminUrl = process.env.ZECK_PG_ADMIN_URL ?? "";
    if (adminUrl.length === 0) {
      console.error(
        "error: ZECK_PG_ADMIN_URL is required for local restore (see deploy/README.md)",
      );
      process.exit(2);
    }
  } else {
    // Provider restore requires the environment's materialized admin
    // connection (a managed primary/branch admin URL, credential-shaped
    // and operator-materialized — never a repository variable, never
    // argv). Fail closed when absent.
    adminUrl = process.env.ZECK_DATABASE_ADMIN_URL ?? "";
    if (adminUrl.length === 0) {
      console.error(
        "error: provider-environment restore requires ZECK_DATABASE_ADMIN_URL (credential-shaped, environment-only; the managed PostgreSQL admin connection; see deploy/README.md)",
      );
      process.exit(2);
    }
  }

  const backup = JSON.parse(readFileSync(fromPath, "utf8")) as LogicalBackup;
  if (backup.format !== "zeck-logical-backup" || backup.version !== 1) {
    console.error(
      "error: the artifact is not a zeck-logical-backup v1 manifest (refusing to restore)",
    );
    process.exit(2);
  }

  // 1. Fresh disposable recovery target (computed name, never argv).
  const targetName = `zeck_restore_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const creator = new Client({ connectionString: adminUrl });
  await creator.connect();
  try {
    await creator.query(`CREATE DATABASE ${targetName}`);
  } finally {
    await creator.end();
  }
  const targetUrl = `${adminUrl.replace(/\/[^/]*$/, "")}/${targetName}`;

  const report: Record<string, unknown> = {
    tool: "deploy/restore",
    environment,
    source: {
      artifact: fromPath,
      format: backup.format,
      summary: backupSummary(backup),
      migrationHistory: backup.migrationHistory.length,
    },
    target: { database: targetName, classification: "disposable-recovery" },
  };

  try {
    // 2-3. Deterministic DDL (the production startup path) + data restore.
    const handle = await startAuthoritativeDatabase(targetUrl, { poolOverrides: { max: 4 } });
    try {
      const outcome = await restoreDataIntoCurrentState(handle.port, backup);
      report.procedure = {
        migrationsApplied: handle.migrations.applied.length + handle.migrations.skipped,
        tablesRestored: outcome.tables.length,
        rowsRestored: outcome.tables.reduce((total, table) => total + table.rows, 0),
        sequencesReseeded: outcome.sequencesReseeded,
      };
      report.verification = {
        tables: outcome.verification.length,
        allTablesVerified: outcome.verification.every((entry) => entry.verified),
        method: "per-table re-read + sha256 content checksum + row count (deterministic)",
      };
      if (!outcome.verification.every((entry) => entry.verified)) {
        throw new Error("restore verification failed (see the verification table)");
      }
    } finally {
      await handle.close();
    }

    // 5. Cleanup of the disposable recovery resource.
    if (hasFlag(argv, "--drop")) {
      await dropDatabase(adminUrl, targetName);
      report.cleanup = { dropped: true, database: targetName };
    } else {
      report.cleanup = {
        dropped: false,
        note: "the disposable recovery database is retained for operator inspection (drop with --drop)",
      };
    }
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(`error: ${redactConnectionString((error as Error).message)}`);
    console.error(
      `note: the disposable recovery database ${targetName} was left in place for diagnosis`,
    );
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
});
