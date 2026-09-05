/**
 * deploy/migrate — the deterministic startup/migration operator for
 * the authoritative database (WORK-043 / D-02, acceptance criteria
 * 1–2).
 *
 * Runs the full repository-defined startup path against the
 * environment's managed PostgreSQL endpoint:
 *
 *   connectivity (fail closed, redacted) → PostgreSQL 16+ floor →
 *   shipped migrations (forward-only, exactly-once, advisory-lock
 *   serialized) → schema convergence check.
 *
 * URL resolution (repository-owned connection contract):
 *   - local: derived from ZECK_PG_ADMIN_URL by swapping the database
 *     name to the computed `zeck_local` (never a secret in argv).
 *   - provider environments: the materialized `database-url` secret
 *     (ZECK_DATABASE_URL) resolved through the environment-scoped
 *     secret store (the ZECK_SECRET_DATABASE_URL_REF reference must
 *     be materialized and environment-scoped — the env contract
 *     gate above enforces it).
 *
 * Usage:
 *   bun run deploy:migrate -- --environment local
 *   bun run deploy:migrate -- --environment staging
 */

import { redactConnectionString } from "../src/platform/db/connection";
import { startAuthoritativeDatabase } from "../src/platform/db/startup";
import { evaluateEnvironmentContract } from "../src/platform/deployment/env-contract";
import { namingConventionsOf } from "../src/platform/deployment/identity";
import { computeResourceNames } from "../src/platform/deployment/naming";
import {
  asSecretReference,
  createEnvSecretStore,
} from "../src/platform/secret-store/adapters/env-secret-store";
import { loadManifest, requireEnvironment } from "./lib";

function localDatabaseUrl(adminUrl: string, databaseName: string): string {
  const withoutDb = adminUrl.replace(/\/[^/]*$/, "");
  return `${withoutDb}/${databaseName}`;
}

async function resolveDatabaseUrl(environment: string): Promise<string> {
  if (environment === "local") {
    const adminUrl = process.env.ZECK_PG_ADMIN_URL;
    if (adminUrl === undefined || adminUrl.length === 0) {
      throw new Error("ZECK_PG_ADMIN_URL is required for local startup (see deploy/README.md)");
    }
    const manifest = loadManifest();
    const names = computeResourceNames(
      namingConventionsOf(manifest),
      "local",
      manifest.resources.local,
    );
    const databaseName = names.find((n) => n.kind === "pg-database")?.name ?? "zeck_local";
    return localDatabaseUrl(adminUrl, databaseName);
  }
  // Provider environment: resolve the materialized database-url
  // secret through the environment-scoped secret store.
  const secretStore = createEnvSecretStore({
    environment,
    env: process.env,
    materialization: { "database-url": "ZECK_DATABASE_URL" },
  });
  const secret = await secretStore.resolve(
    asSecretReference(`zeck-secret://${environment}/database-url`),
  );
  return secret.plaintext;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const environment = requireEnvironment(argv);
  const manifest = loadManifest();

  const contract = evaluateEnvironmentContract(manifest, environment, process.env);
  if (!contract.satisfied) {
    console.error(
      `error: the environment contract is not satisfied: ${contract.problems.join("; ")}`,
    );
    process.exit(2);
  }

  let url: string;
  try {
    url = await resolveDatabaseUrl(environment);
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exit(2);
  }

  try {
    const handle = await startAuthoritativeDatabase(url, { poolOverrides: { max: 4 } });
    const report = {
      tool: "deploy/migrate",
      environment,
      endpoint: handle.endpoint,
      serverVersion: handle.serverVersion.split(" (")[0] ?? "",
      migrations: {
        applied: handle.migrations.applied,
        appliedCount: handle.migrations.applied.length,
        skipped: handle.migrations.skipped,
        total: handle.migrations.applied.length + handle.migrations.skipped,
      },
      schemaConverged: true,
    };
    console.log(JSON.stringify(report, null, 2));
    await handle.close();
    process.exit(0);
  } catch (error) {
    // Fail closed with a REDACTED diagnostic (connection strings never
    // enter the report — startup already redacts; double-guard here).
    console.error(`error: ${redactConnectionString((error as Error).message)}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
});
