/**
 * deploy/bootstrap — deterministic, idempotent resource convergence
 * (WORK-042: "Make provider resource lifecycle operations idempotent
 * or create-or-converge").
 *
 * LOCAL: converges the disposable local resource set against the real
 * environment — the PostgreSQL database `zeck_local` (create-or-skip,
 * never duplicated), the local object-store root directory, and the
 * Redis reachability check when ZECK_LOCAL_REDIS_URL is set. Running
 * bootstrap twice converges to the same state (proof in the
 * integration tests).
 *
 * PREVIEW/STAGING/PRODUCTION: emits the deterministic provisioning
 * plan — the exact resource set with computed names and ownership
 * labels, the secret-reference preconditions, and the classification
 * of each operation. Executing provider mutations is D-02+ adapter
 * work; the plan marks `executable` ONLY when every secret reference
 * is materialized with a valid environment-scoped reference URI (fail
 * closed: no half-provisioned, half-credentialed state).
 *
 * Usage:
 *   bun run deploy:bootstrap -- --environment local
 *   bun run deploy:bootstrap -- --environment staging
 *   bun run deploy:bootstrap -- --environment preview --branch work/WORK-042-x
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { evaluateEnvironmentContract } from "../src/platform/deployment/env-contract";
import { namingConventionsOf } from "../src/platform/deployment/identity";
import { computeResourceNames, previewBranchSlug } from "../src/platform/deployment/naming";
import { loadManifest, optionalBranch, requireEnvironment } from "./lib";

const DEFAULT_DATA_ROOT = join(
  process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "/tmp", ".local", "share"),
  "zeck",
);

interface Operation {
  readonly resource: string;
  readonly kind: string;
  readonly name: string;
  readonly action: string;
  readonly idempotent: boolean;
}

async function convergeLocalPostgres(databaseName: string): Promise<Operation> {
  const adminUrl = process.env.ZECK_PG_ADMIN_URL;
  if (adminUrl === undefined || adminUrl.length === 0) {
    throw new Error(
      "ZECK_PG_ADMIN_URL is required for local bootstrap (the local PostgreSQL admin connection; see deploy/README.md)",
    );
  }
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const existing = await client.query<{ exists: boolean }>({
      text: "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      values: [databaseName],
    });
    const exists = existing.rows[0]?.exists === true;
    if (!exists) {
      // Identifier is computed by the naming module (never interpolated
      // from user input); the guard still refuses anything but the
      // computed local name.
      if (databaseName !== "zeck_local") {
        throw new Error(`refusing to create a non-computed database name: ${databaseName}`);
      }
      await client.query(`CREATE DATABASE ${databaseName}`);
    }
    return {
      resource: "postgres",
      kind: "pg-database",
      name: databaseName,
      action: exists ? "already-present (converged)" : "created",
      idempotent: true,
    };
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const environment = requireEnvironment(argv);
  const branch = optionalBranch(argv);
  const manifest = loadManifest();
  const conventions = namingConventionsOf(manifest);

  const environmentRecord = manifest.environments.find((e) => e.id === environment);
  if (environmentRecord === undefined) {
    throw new Error(`unknown environment: ${environment}`);
  }
  const contract = evaluateEnvironmentContract(manifest, environment, process.env);
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
    const operations: Operation[] = [];
    // 1. PostgreSQL database (create-or-converge).
    const pgName = names.find((n) => n.kind === "pg-database")?.name ?? "zeck_local";
    operations.push(await convergeLocalPostgres(pgName));
    // 2. Local object-store root.
    const dataRoot = process.env.ZECK_LOCAL_DATA_ROOT ?? DEFAULT_DATA_ROOT;
    const objectStore = names.find((n) => n.kind === "local-object-store");
    if (objectStore !== undefined) {
      mkdirSync(join(dataRoot, objectStore.name), { recursive: true });
      operations.push({
        resource: objectStore.id ?? "object-store",
        kind: objectStore.kind,
        name: join(dataRoot, objectStore.name),
        action: "converged (create-or-skip)",
        idempotent: true,
      });
    }
    // 3. Redis reachability (informational at bootstrap; smoke gates it).
    const redisUrl = process.env.ZECK_LOCAL_REDIS_URL;
    operations.push({
      resource: "redis",
      kind: "local-redis",
      name: redisUrl ?? "not-configured (ZECK_LOCAL_REDIS_URL absent)",
      action: redisUrl === undefined ? "absent (coordination-degraded at smoke)" : "declared",
      idempotent: true,
    });
    const report = {
      tool: "deploy/bootstrap",
      environment,
      environmentClass: environmentRecord.environmentClass,
      operations,
      environmentContract: {
        satisfied: contract.satisfied,
        problems: contract.problems,
      },
      secretReferences: {
        materialized: contract.materializedReferences.length,
        expected: manifest.secretReferences[environment].length,
      },
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  // Provider environments: the deterministic provisioning plan.
  const expectedRefs = manifest.secretReferences[environment].map(
    (reference) => reference.variable,
  );
  const materialized = new Set(contract.materializedReferences.map((m) => m.variable));
  const missingReferences = expectedRefs.filter((variable) => !materialized.has(variable));
  const plan = {
    tool: "deploy/bootstrap",
    environment,
    environmentClass: environmentRecord.environmentClass,
    ...(slug === undefined ? {} : { previewBranch: branch ?? "", previewSlug: slug }),
    operations: names.map<Operation>((resource) => ({
      resource: resource.id ?? "-",
      kind: resource.kind,
      name: resource.name,
      action: "plan-only (provider adapter execution arrives with D-02+; see deploy/README.md)",
      idempotent: true,
    })),
    labels: names[0]?.labels ?? {},
    preconditions: {
      secretReferences: manifest.secretReferences[environment].map((reference) => ({
        variable: reference.variable,
        reference: `zeck-secret://${environment}/${reference.name}`,
        materialized: materialized.has(reference.variable),
      })),
      environmentContractSatisfied: contract.satisfied,
      problems: contract.problems,
    },
    executable: contract.satisfied && missingReferences.length === 0,
  };
  console.log(JSON.stringify(plan, null, 2));
  // Bootstrap for provider environments never mutates anything (plan
  // only); a non-executable plan is a fail-closed signal, not an error.
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
});
