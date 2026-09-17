/**
 * deploy/teardown — disposable-resource removal (WORK-042 AC8:
 * "teardown/recreation of disposable preview resources without
 * corrupting authoritative application state").
 *
 * CLASSIFICATION GUARD (fail closed): teardown consults the
 * environment manifest, not the operator's intent. Persistent
 * environments (staging, production) are REFUSED — no flag, no
 * override, no force. Only disposable classes (local, preview) can be
 * torn down, and only their COMPUTED resource names are ever touched:
 * the local teardown drops exactly the computed `zeck_local` database
 * and removes exactly the computed local object-store directory under
 * the local data root. Authoritative application state is unreachable
 * by construction (no other database name, no other path).
 *
 * DEP-002: the guard extends to the PROVISIONED records — the
 * secret-reference scaffold and sandbox-account record set deploy/
 * provision converges under the local data root. Their removal rides
 * the same classification guard (deploy/provision
 * `teardownProvisionedRecords` re-checks it defensively): exactly the
 * computed `provisioned/<environment>[/<preview-slug>]` directory is
 * removed, and persistent environments are refused even if a caller
 * bypasses this tool's own guard.
 *
 * Preview teardown is plan-only for PROVIDER resources: the disposable
 * per-branch resource set is named deterministically for the
 * operator/provider adapters (D-02+); the repository never mutates
 * provider state in D-01. The preview PROVISIONED records (local
 * artifacts under the data root) are removed for real.
 *
 * Usage:
 *   bun run deploy:teardown -- --environment local
 *   bun run deploy:teardown -- --environment preview --branch work/WORK-042-x
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { namingConventionsOf } from "../src/platform/deployment/identity";
import { computeResourceNames, previewBranchSlug } from "../src/platform/deployment/naming";
import { loadManifest, optionalBranch, requireEnvironment } from "./lib";
import { teardownProvisionedRecords } from "./provision";

const DEFAULT_DATA_ROOT = join(
  process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "/tmp", ".local", "share"),
  "zeck",
);

async function dropLocalPostgres(databaseName: string): Promise<string> {
  const adminUrl = process.env.ZECK_PG_ADMIN_URL;
  if (adminUrl === undefined || adminUrl.length === 0) {
    throw new Error(
      "ZECK_PG_ADMIN_URL is required for local teardown (the local PostgreSQL admin connection; see deploy/README.md)",
    );
  }
  // The guard: only the computed local database name is ever dropped.
  if (databaseName !== "zeck_local") {
    throw new Error(`refusing to drop a non-computed database name: ${databaseName}`);
  }
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    return `dropped (if present): ${databaseName}`;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const environment = requireEnvironment(argv);
  const branch = optionalBranch(argv);
  const manifest = loadManifest();

  const environmentRecord = manifest.environments.find((e) => e.id === environment);
  if (environmentRecord === undefined) {
    throw new Error(`unknown environment: ${environment}`);
  }

  // THE CLASSIFICATION GUARD: the manifest is the authority; the
  // operator's command line is not.
  if (environmentRecord.teardownAllowed === false) {
    console.error(
      `error: teardown refused — environment "${environment}" is class "${environmentRecord.environmentClass}" (persistent; authoritative application state is protected by classification, not by operator intent)`,
    );
    process.exit(3);
  }

  const conventions = namingConventionsOf(manifest);
  const slug =
    environment === "preview" && branch !== undefined
      ? previewBranchSlug(branch, conventions.previewBranchSlugMaxLength)
      : undefined;
  const names = computeResourceNames(
    conventions,
    environment,
    manifest.resources[environment],
    slug,
  );

  if (environment === "local") {
    const operations: string[] = [];
    // 0. (DEP-002) the provisioned records FIRST: they are pure local
    // artifacts under the data root — their removal must not depend on
    // an external server being reachable. Classification-guarded,
    // computed-path-only (deploy/provision re-checks the guard).
    const dataRoot = process.env.ZECK_LOCAL_DATA_ROOT ?? DEFAULT_DATA_ROOT;
    const provisioned = teardownProvisionedRecords({
      dataRoot,
      environment,
      previewSlug: slug,
      environmentRecord,
    });
    operations.push(
      provisioned.removed
        ? `removed provisioned records: ${provisioned.directory}`
        : `already-absent provisioned records: ${provisioned.directory}`,
    );
    const pg = names.find((n) => n.kind === "pg-database");
    if (pg !== undefined) {
      operations.push(await dropLocalPostgres(pg.name));
    }
    const objectStore = names.find((n) => n.kind === "local-object-store");
    if (objectStore !== undefined) {
      const target = join(dataRoot, objectStore.name);
      if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
        operations.push(`removed: ${target}`);
      } else {
        operations.push(`already-absent: ${target}`);
      }
    }
    console.log(
      JSON.stringify(
        {
          tool: "deploy/teardown",
          environment,
          environmentClass: environmentRecord.environmentClass,
          operations,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  // Preview teardown: provider resources are plan-only (adapters D-02+);
  // the provisioned records are local artifacts and are removed for real.
  const provisioned = teardownProvisionedRecords({
    dataRoot: process.env.ZECK_LOCAL_DATA_ROOT ?? DEFAULT_DATA_ROOT,
    environment,
    previewSlug: slug,
    environmentRecord,
  });
  console.log(
    JSON.stringify(
      {
        tool: "deploy/teardown",
        environment,
        environmentClass: environmentRecord.environmentClass,
        ...(slug === undefined ? {} : { previewBranch: branch ?? "", previewSlug: slug }),
        operations: [
          ...names.map((resource) => ({
            resource: resource.id ?? "-",
            kind: resource.kind,
            name: resource.name,
            action:
              "plan-only (delete the disposable per-branch resource; provider adapter execution arrives with D-02+; preview data is synthetic and never promoted)",
          })),
          {
            resource: "provisioned-records",
            kind: "provisioned-artifact-set",
            name: provisioned.directory,
            action: provisioned.removed
              ? "removed (secret-reference scaffold + sandbox-account records converged by deploy/provision)"
              : "already-absent",
          },
        ],
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
});
