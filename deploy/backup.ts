/**
 * deploy/backup — create the logical backup artifact of the
 * authoritative PostgreSQL state (WORK-043 / D-02, acceptance
 * criterion 8: the backup half of the executed restore drill).
 *
 * The backup is PORT-BASED and DETERMINISTIC (see
 * src/platform/db/backup.ts): the shipped migrations remain the DDL
 * authority; the artifact carries the authoritative DATA with
 * per-table sha256 content checksums and the exact migration
 * history. The source database must be schema-converged with the
 * shipped migrations (fail closed otherwise — run deploy:migrate
 * first).
 *
 * URL resolution mirrors deploy/migrate (local: derived from
 * ZECK_PG_ADMIN_URL; provider: the materialized database-url secret
 * through the environment-scoped secret store). The artifact path is
 * an operator-controlled file (--out); the artifact itself is DATA,
 * never secrets (Zeck state never contains secret plaintext).
 *
 * Usage:
 *   bun run deploy:backup -- --environment local --out /tmp/zeck-backup.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogicalBackup } from "../src/platform/db/backup";
import { parseConnectionConfig, redactConnectionString } from "../src/platform/db/connection";
import { PgDatabasePort } from "../src/platform/db/pg-database-port";
import {
  authoritativeSchemas,
  shippedMigrations,
  verifySchemaConvergence,
} from "../src/platform/db/startup";
import { evaluateEnvironmentContract } from "../src/platform/deployment/env-contract";
import {
  asSecretReference,
  createEnvSecretStore,
} from "../src/platform/secret-store/adapters/env-secret-store";
import { loadManifest, requireEnvironment } from "./lib";

function argumentValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const environment = requireEnvironment(argv);
  const outPath = argumentValue(argv, "--out");
  if (outPath === undefined || outPath.length === 0) {
    console.error("error: --out <file> is required (the backup artifact path)");
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

  let url: string;
  if (environment === "local") {
    const adminUrl = process.env.ZECK_PG_ADMIN_URL;
    if (adminUrl === undefined || adminUrl.length === 0) {
      console.error("error: ZECK_PG_ADMIN_URL is required for local backup (see deploy/README.md)");
      process.exit(2);
    }
    url = `${adminUrl.replace(/\/[^/]*$/, "")}/zeck_local`;
  } else {
    const secretStore = createEnvSecretStore({
      environment,
      env: process.env,
      materialization: { "database-url": "ZECK_DATABASE_URL" },
    });
    url = (
      await secretStore.resolve(asSecretReference(`zeck-secret://${environment}/database-url`))
    ).plaintext;
  }

  const config = parseConnectionConfig(url, { max: 4 });
  const adapter = new PgDatabasePort(config);
  try {
    // The source must be schema-converged with the shipped set (a
    // lagging database is a deployment defect, not a backup input).
    const migrations = shippedMigrations();
    try {
      await verifySchemaConvergence(adapter, migrations);
    } catch (error) {
      console.error(`error: ${(error as Error).message} (run: bun run deploy:migrate first)`);
      process.exit(1);
    }
    const backup = await createLogicalBackup(adapter, authoritativeSchemas(migrations));
    const artifact = JSON.stringify(backup, null, 2);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, artifact, { encoding: "utf8" });
    const report = {
      tool: "deploy/backup",
      environment,
      source: { endpoint: `postgresql://${config.host}:${config.port}/${config.database}` },
      artifact: {
        path: outPath,
        bytes: artifact.length,
        format: backup.format,
        version: backup.version,
        tables: backup.tables.length,
        rows: backup.tables.reduce((total, table) => total + table.rowCount, 0),
        migrations: backup.migrationHistory.length,
      },
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(`error: ${redactConnectionString((error as Error).message)}`);
    process.exit(1);
  } finally {
    await adapter.close();
  }
}

main().catch((error: unknown) => {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
});
