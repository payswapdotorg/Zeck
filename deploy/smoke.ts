/**
 * deploy/smoke — the environment smoke check (WORK-042 Required
 * Verification: "idempotent bootstrap/teardown smoke tests", "exact-
 * revision deployment smoke verification").
 *
 * Attests, for an exact Git revision of this checkout:
 *  1. the deployment identity (deterministic, content-addressed);
 *  2. the environment contract (required variables; secret references
 *     valid and environment-scoped);
 *  3. dependency readiness against the REAL environment — control
 *     plane vs dependencies distinguished, the authoritative
 *     PostgreSQL dependency failing closed, non-authoritative
 *     dependencies degrading explicitly.
 *
 * LOCAL probes: the PostgreSQL server (via ZECK_PG_ADMIN_URL) and the
 * computed `zeck_local` database (created by bootstrap), the local
 * object-store root, and Redis when ZECK_LOCAL_REDIS_URL is set
 * (absent ⇒ the explicit coordination-degraded mode).
 *
 * PROVIDER probes: the secret-reference preconditions. Unprovisioned
 * provider resources report their dependency as unavailable with the
 * provider's degraded mode — an honest NOT-READY until D-02+ adapters
 * provision them; the authoritative dependency being unprovisioned
 * makes the environment DOWN (fail closed).
 *
 * Exit 0 = ready (or degraded with --allow-degraded); exit 1 = down /
 * not attested.
 */

import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Client } from "pg";
import { evaluateEnvironmentContract } from "../src/platform/deployment/env-contract";
import { deploymentIdentity, namingConventionsOf } from "../src/platform/deployment/identity";
import {
  computeResourceNames,
  type EnvironmentId,
  previewBranchSlug,
} from "../src/platform/deployment/naming";
import {
  type DependencyProbeResult,
  evaluateReadiness,
  expectedProbeConcerns,
} from "../src/platform/deployment/readiness";
import { gitRevision, hasFlag, loadManifest, optionalBranch, requireEnvironment } from "./lib";

const DEFAULT_DATA_ROOT = join(
  process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "/tmp", ".local", "share"),
  "zeck",
);

/** TCP reachability probe (host:port) with a hard timeout. */
function reachable(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ ok: boolean; detail?: string }> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    const finish = (ok: boolean, detail?: string): void => {
      socket.destroy();
      resolvePromise({ ok, detail });
    };
    socket.setTimeout(timeoutMs, () => finish(false, "connection timed out"));
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(false, (error as Error).message.slice(0, 120)));
  });
}

/** Parse host/port from a redis: URL. */
function redisEndpoint(url: string): { host: string; port: number } {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, port: Number(parsed.port || 6379) };
  } catch {
    return { host: "127.0.0.1", port: 6379 };
  }
}

async function probeLocal(
  manifest: ReturnType<typeof loadManifest>,
): Promise<readonly DependencyProbeResult[]> {
  const probes: DependencyProbeResult[] = [];
  const conventions = namingConventionsOf(manifest);
  const names = computeResourceNames(conventions, "local", manifest.resources.local);
  const databaseName = names.find((n) => n.kind === "pg-database")?.name ?? "zeck_local";
  const objectStoreName = names.find((n) => n.kind === "local-object-store")?.name ?? "";

  // The authoritative dependency: PostgreSQL.
  const adminUrl = process.env.ZECK_PG_ADMIN_URL;
  if (adminUrl === undefined || adminUrl.length === 0) {
    probes.push({
      concern: "relational-state",
      status: "unavailable",
      detail: "ZECK_PG_ADMIN_URL is not set; the local PostgreSQL authority cannot be probed",
    });
  } else {
    try {
      const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 4000 });
      await client.connect();
      try {
        const result = await client.query<{ exists: boolean }>({
          text: "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
          values: [databaseName],
        });
        const exists = result.rows[0]?.exists === true;
        probes.push({
          concern: "relational-state",
          status: exists ? "ready" : "unavailable",
          detail: exists
            ? `postgres reachable; ${databaseName} present`
            : `postgres reachable; ${databaseName} absent (run: bun run deploy:bootstrap -- --environment local)`,
        });
      } finally {
        await client.end();
      }
    } catch (error) {
      probes.push({
        concern: "relational-state",
        status: "unavailable",
        detail: `postgres unreachable: ${(error as Error).message.slice(0, 120)}`,
      });
    }
  }

  // The artifact-bytes dependency (local object store root).
  const dataRoot = process.env.ZECK_LOCAL_DATA_ROOT ?? DEFAULT_DATA_ROOT;
  const objectStorePath = join(dataRoot, objectStoreName);
  probes.push({
    concern: "artifact-bytes",
    status: existsSync(objectStorePath) ? "ready" : "unavailable",
    detail: existsSync(objectStorePath)
      ? `object-store root present: ${objectStoreName}`
      : `object-store root absent (run: bun run deploy:bootstrap -- --environment local)`,
  });

  // The coordination dependency (optional local Redis).
  const redisUrl = process.env.ZECK_LOCAL_REDIS_URL;
  if (redisUrl === undefined || redisUrl.length === 0) {
    probes.push({
      concern: "ephemeral-coordination",
      status: "degraded",
      detail:
        "ZECK_LOCAL_REDIS_URL is not set; the local coordination dependency is degraded by explicit choice",
    });
  } else {
    const { host, port } = redisEndpoint(redisUrl);
    const result = await reachable(host, port, 3000);
    probes.push({
      concern: "ephemeral-coordination",
      status: result.ok ? "ready" : "unavailable",
      detail: result.ok
        ? `redis reachable at ${host}:${port}`
        : `redis unreachable: ${result.detail}`,
    });
  }
  return probes;
}

async function probeProviderEnvironment(
  manifest: ReturnType<typeof loadManifest>,
  environment: EnvironmentId,
): Promise<readonly DependencyProbeResult[]> {
  // Provider environments without D-02+ adapters: the honest probe is
  // the secret-reference precondition state. Credentials materialized
  // ⇒ "degraded" (resources exist to be verified only by the future
  // adapter phase); credentials absent ⇒ "unavailable" (nothing is
  // attested — the authoritative relational concern keeps the whole
  // environment DOWN, fail closed).
  const contract = evaluateEnvironmentContract(manifest, environment, process.env);
  const expected = manifest.secretReferences[environment].length;
  const materialized = contract.materializedReferences.length;
  const referencesReady = expected > 0 && materialized === expected;
  return expectedProbeConcerns(manifest, environment).map((concern) => ({
    concern,
    status: referencesReady ? "degraded" : "unavailable",
    detail: referencesReady
      ? "secret references materialized; provider resource verification arrives with the D-02+ adapter phase"
      : `secret references not materialized (${materialized}/${expected}); environment not provisioned`,
  }));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const environment = requireEnvironment(argv);
  const branch = optionalBranch(argv);
  const allowDegraded = hasFlag(argv, "--allow-degraded");
  const manifest = loadManifest();
  const revision = gitRevision();

  const contract = evaluateEnvironmentContract(manifest, environment, process.env);
  const probes =
    environment === "local"
      ? await probeLocal(manifest)
      : await probeProviderEnvironment(manifest, environment);
  const slug =
    environment === "preview" && branch !== undefined
      ? previewBranchSlug(branch, namingConventionsOf(manifest).previewBranchSlugMaxLength)
      : undefined;

  // The control plane for the smoke tool is the tool itself executing
  // over a valid, loaded manifest set at an exact revision.
  const readiness = evaluateReadiness(manifest, { controlPlaneAvailable: true, probes });
  const identity = deploymentIdentity(manifest, revision, environment, slug);

  const report = {
    tool: "deploy/smoke",
    environment,
    gitRevision: revision,
    identity,
    environmentContract: {
      satisfied: contract.satisfied,
      problems: contract.problems,
    },
    readiness,
  };
  console.log(JSON.stringify(report, null, 2));

  const pass = readiness.overall === "ready" || (allowDegraded && readiness.overall === "degraded");
  process.exit(pass ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
});
