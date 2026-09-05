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
 * PROVIDER probes (D-02/WORK-043): concerns with landed adapters
 * (relational-state, artifact-bytes) are probed for REAL when their
 * credential materialization is present; other concerns report the
 * secret-reference precondition state honestly (unprovisioned ⇒
 * unavailable with the provider's declared degraded mode). The
 * authoritative dependency being unattested makes the environment
 * DOWN (fail closed).
 *
 * Exit 0 = ready (or degraded with --allow-degraded); exit 1 = down /
 * not attested.
 */

import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Client } from "pg";
import { parseConnectionConfig, redactConnectionString } from "../src/platform/db/connection";
import { PgDatabasePort } from "../src/platform/db/pg-database-port";
import { shippedMigrations } from "../src/platform/db/startup";
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
import { createS3ObjectStore } from "../src/platform/object-store/s3-object-store";
import {
  createCloudflareQueuesTransport,
  loadCloudflareQueuesRuntimeConfig,
} from "../src/platform/queue/cloudflare-queues";
import {
  createCloudflareWorkflowsTransport,
  loadCloudflareWorkflowsRuntimeConfig,
} from "../src/platform/workflow/cloudflare-workflows";
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
  // PROVIDER probes (D-02, WORK-043): concerns with landed adapters
  // are probed for real when their credential materialization is
  // present; concerns whose adapters arrive with D-03+ keep the
  // honest secret-reference precondition state. Credentials absent ⇒
  // "unavailable" (nothing is attested — the authoritative relational
  // concern keeps the whole environment DOWN, fail closed).
  const contract = evaluateEnvironmentContract(manifest, environment, process.env);
  const expected = manifest.secretReferences[environment].length;
  const materialized = contract.materializedReferences.length;
  const referencesReady = expected > 0 && materialized === expected;

  const probes: DependencyProbeResult[] = [];
  for (const concern of expectedProbeConcerns(manifest, environment)) {
    if (concern === "relational-state") {
      probes.push(await probeProviderRelationalState(manifest, environment, contract));
    } else if (concern === "artifact-bytes") {
      probes.push(await probeProviderObjectStore(manifest, environment, contract));
    } else if (concern === "async-transport") {
      probes.push(await probeProviderAsyncTransport(manifest, environment, contract));
    } else if (concern === "durable-orchestration") {
      probes.push(await probeProviderDurableOrchestration(manifest, environment, contract));
    } else {
      probes.push({
        concern,
        status: referencesReady ? "degraded" : "unavailable",
        detail: referencesReady
          ? "secret references materialized; the D-04+ adapter for this concern is not landed (degraded by declared mode)"
          : `secret references not materialized (${materialized}/${expected}); environment not provisioned`,
      });
    }
  }
  return probes;
}

/**
 * The D-02 relational-state probe: when the materialized database-url
 * secret (ZECK_DATABASE_URL) and its reference binding exist, connect
 * through the production pg path and verify the PostgreSQL 16+ floor
 * and migration convergence (read-only). Without materialization the
 * concern reports unattested (unavailable — fail closed).
 */
async function probeProviderRelationalState(
  _manifest: ReturnType<typeof loadManifest>,
  _environment: EnvironmentId,
  contract: ReturnType<typeof evaluateEnvironmentContract>,
): Promise<DependencyProbeResult> {
  void _manifest;
  const referenceBound = contract.materializedReferences.some(
    (reference) => reference.variable === "ZECK_SECRET_DATABASE_URL_REF",
  );
  const url = process.env.ZECK_DATABASE_URL;
  if (!referenceBound || url === undefined || url.length === 0) {
    return {
      concern: "relational-state",
      status: "unavailable",
      detail: !referenceBound
        ? "ZECK_SECRET_DATABASE_URL_REF is not materialized (the environment-scoped reference binding is a precondition)"
        : "ZECK_DATABASE_URL is not set (the materialized database-url secret value is absent)",
    };
  }
  // Real probe through the production adapter path (redacted detail).
  try {
    const config = parseConnectionConfig(url, {
      max: 1,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 5000,
    });
    const adapter = new PgDatabasePort(config);
    try {
      const ping = await adapter.ping();
      const major = Math.floor(ping.serverVersionNum / 10_000);
      if (major < 16) {
        return {
          concern: "relational-state",
          status: "unavailable",
          detail: `managed server is not PostgreSQL 16+ (reported ${major})`,
        };
      }
      const shipped = shippedMigrations();
      const recorded = await adapter.execute<{ version: number }>({
        sql: "SELECT version FROM platform.schema_migrations ORDER BY version",
      });
      const recordedVersions = new Set(recorded.rows.map((row) => row.version));
      const missing = shipped.filter((file) => !recordedVersions.has(file.version));
      return {
        concern: "relational-state",
        status: missing.length === 0 ? "ready" : "unavailable",
        detail:
          missing.length === 0
            ? `managed postgres reachable (pg ${major}); all ${shipped.length} shipped migrations recorded`
            : `managed postgres reachable but schema not converged (${missing.length} shipped migrations unapplied; run deploy:migrate)`,
      };
    } finally {
      await adapter.close();
    }
  } catch (error) {
    return {
      concern: "relational-state",
      status: "unavailable",
      detail: redactConnectionString(
        `managed postgres unreachable: ${(error as Error).message.slice(0, 140)}`,
      ),
    };
  }
}

/**
 * The D-02 artifact-bytes probe: when the materialized R2 secrets
 * (access key id + secret access key), their reference bindings and
 * the ordinary object-store configuration (endpoint/bucket/region)
 * exist, HEAD the bucket through the S3 adapter. 200 = ready; 403 =
 * credentials rejected; 404 = bucket absent. Without materialization
 * the concern reports unattested (fail closed, honest).
 */
async function probeProviderObjectStore(
  manifest: ReturnType<typeof loadManifest>,
  environment: EnvironmentId,
  contract: ReturnType<typeof evaluateEnvironmentContract>,
): Promise<DependencyProbeResult> {
  const accessKeyBound = contract.materializedReferences.some(
    (reference) => reference.variable === "ZECK_SECRET_OBJECT_STORE_ACCESS_KEY_ID_REF",
  );
  const secretKeyBound = contract.materializedReferences.some(
    (reference) => reference.variable === "ZECK_SECRET_OBJECT_STORE_SECRET_ACCESS_KEY_REF",
  );
  const accessKeyId = process.env.ZECK_OBJECT_STORE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.ZECK_OBJECT_STORE_SECRET_ACCESS_KEY;
  const endpoint = process.env.ZECK_OBJECT_STORE_ENDPOINT;
  const bucket = process.env.ZECK_OBJECT_STORE_BUCKET;
  const region = process.env.ZECK_OBJECT_STORE_REGION ?? "auto";
  const notMaterialized =
    !accessKeyBound || !secretKeyBound
      ? "the object-store secret reference bindings are not materialized (ZECK_SECRET_OBJECT_STORE_*_REF)"
      : accessKeyId === undefined || accessKeyId.length === 0
        ? "ZECK_OBJECT_STORE_ACCESS_KEY_ID is not set (the materialized object-store-access-key-id secret value is absent)"
        : secretAccessKey === undefined || secretAccessKey.length === 0
          ? "ZECK_OBJECT_STORE_SECRET_ACCESS_KEY is not set (the materialized object-store-secret-access-key secret value is absent)"
          : endpoint === undefined || endpoint.length === 0
            ? "ZECK_OBJECT_STORE_ENDPOINT is not set (ordinary object-store configuration; see deploy/README.md)"
            : bucket === undefined || bucket.length === 0
              ? "ZECK_OBJECT_STORE_BUCKET is not set (ordinary object-store configuration; see deploy/README.md)"
              : null;
  if (notMaterialized !== null) {
    return { concern: "artifact-bytes", status: "unavailable", detail: notMaterialized };
  }
  // Cross-check the configured bucket against the manifest-computed
  // resource name for this environment (naming drift is a defect).
  const conventions = namingConventionsOf(manifest);
  const names = computeResourceNames(
    conventions,
    environment,
    manifest.resources[environment as keyof typeof manifest.resources] ?? [],
  );
  const expectedBucket = names.find((name) => name.kind === "r2-bucket")?.name;
  const bucketDrift =
    expectedBucket !== undefined && bucket !== undefined && expectedBucket !== bucket;
  try {
    const store = createS3ObjectStore({
      endpoint: endpoint ?? "",
      bucket: bucket ?? "",
      region,
      accessKeyId: accessKeyId ?? "",
      secretAccessKey: secretAccessKey ?? "",
    });
    const probe = await store.headBucket();
    if (probe.ok) {
      return {
        concern: "artifact-bytes",
        status: bucketDrift ? "unavailable" : "ready",
        detail: bucketDrift
          ? `bucket reachable but the configured bucket name drifts from the manifest-computed resource name (${bucket} != ${expectedBucket})`
          : `object-store bucket reachable (bucket: ${bucket})`,
      };
    }
    const reason =
      probe.status === 403
        ? "credentials rejected (403)"
        : probe.status === 404
          ? "bucket absent (404)"
          : `provider status ${probe.status}`;
    return { concern: "artifact-bytes", status: "unavailable", detail: reason };
  } catch (error) {
    return {
      concern: "artifact-bytes",
      status: "unavailable",
      detail: `object-store probe failed closed: ${(error as Error).message.slice(0, 140)}`,
    };
  }
}

/**
 * The D-03 async-transport probe: when the materialized queue-api-token
 * secret (ZECK_QUEUE_API_TOKEN), its reference binding, the ordinary
 * queue configuration (account id + queue id) and the DEDICATED
 * operator-owned probe queue id (ZECK_PROBE_QUEUE_ID) exist, execute the
 * REAL transport round trip (publish → pull → ack of exactly one
 * self-identifying probe message) through the Cloudflare Queues adapter
 * — on the probe queue only. The probe never targets the execution
 * queue: it cannot lease, acknowledge or discard genuine execution
 * deliveries. Without materialization the concern reports unattested
 * (unavailable — non-authoritative, so the environment degrades
 * explicitly instead of failing).
 */
async function probeProviderAsyncTransport(
  _manifest: ReturnType<typeof loadManifest>,
  _environment: EnvironmentId,
  contract: ReturnType<typeof evaluateEnvironmentContract>,
): Promise<DependencyProbeResult> {
  void _manifest;
  void _environment;
  const tokenBound = contract.materializedReferences.some(
    (reference) => reference.variable === "ZECK_SECRET_QUEUE_API_TOKEN_REF",
  );
  const apiToken = process.env.ZECK_QUEUE_API_TOKEN;
  const accountId = process.env.ZECK_CLOUDFLARE_ACCOUNT_ID;
  const queueId = process.env.ZECK_QUEUE_ID;
  const probeQueueId = process.env.ZECK_PROBE_QUEUE_ID;
  const notMaterialized = !tokenBound
    ? "ZECK_SECRET_QUEUE_API_TOKEN_REF is not materialized (the environment-scoped reference binding is a precondition)"
    : apiToken === undefined || apiToken.length === 0
      ? "ZECK_QUEUE_API_TOKEN is not set (the materialized queue-api-token secret value is absent)"
      : accountId === undefined || accountId.length === 0
        ? "ZECK_CLOUDFLARE_ACCOUNT_ID is not set (provider-account metadata; see deploy/manifests/variables.json)"
        : queueId === undefined || queueId.length === 0
          ? "ZECK_QUEUE_ID is not set (the environment's queue resource id; see deploy/README.md)"
          : probeQueueId === undefined || probeQueueId.length === 0
            ? "ZECK_PROBE_QUEUE_ID is not set (the dedicated operator-owned probe queue; the transport probe never targets the execution queue — see deploy/README.md)"
            : null;
  if (notMaterialized !== null) {
    return { concern: "async-transport", status: "unavailable", detail: notMaterialized };
  }
  try {
    const transport = createCloudflareQueuesTransport({
      ...loadCloudflareQueuesRuntimeConfig(process.env),
      requestTimeoutMs: 15_000,
    });
    const probe = await transport.probe();
    return { concern: "async-transport", status: "ready", detail: probe.detail };
  } catch (error) {
    return {
      concern: "async-transport",
      status: "unavailable",
      detail: `queue transport probe failed closed: ${(error as Error).message.slice(0, 140)}`,
    };
  }
}

/**
 * The D-04 durable-orchestration probe: when the materialized
 * workflow-api-token secret (ZECK_WORKFLOW_API_TOKEN) and its
 * reference binding exist, run the REAL orchestration round trip
 * (create → observe → terminate) on the DEDICATED operator-owned
 * probe workflow — never the orchestration workflow. Without
 * materialization the concern reports unattested (unavailable —
 * fail closed; the declared orchestration-paused degradation keeps
 * it non-authoritative either way).
 */
async function probeProviderDurableOrchestration(
  _manifest: ReturnType<typeof loadManifest>,
  _environment: EnvironmentId,
  contract: ReturnType<typeof evaluateEnvironmentContract>,
): Promise<DependencyProbeResult> {
  void _manifest;
  void _environment;
  const tokenBound = contract.materializedReferences.some(
    (reference) => reference.variable === "ZECK_SECRET_WORKFLOW_API_TOKEN_REF",
  );
  const apiToken = process.env.ZECK_WORKFLOW_API_TOKEN;
  const accountId = process.env.ZECK_CLOUDFLARE_ACCOUNT_ID;
  const workflowName = process.env.ZECK_WORKFLOW_NAME;
  const probeName = process.env.ZECK_WORKFLOW_PROBE_NAME;
  const notMaterialized = !tokenBound
    ? "ZECK_SECRET_WORKFLOW_API_TOKEN_REF is not materialized (the environment-scoped reference binding is a precondition)"
    : apiToken === undefined || apiToken.length === 0
      ? "ZECK_WORKFLOW_API_TOKEN is not set (the materialized workflow-api-token secret value is absent)"
      : accountId === undefined || accountId.length === 0
        ? "ZECK_CLOUDFLARE_ACCOUNT_ID is not set (provider-account metadata; see deploy/manifests/variables.json)"
        : workflowName === undefined || workflowName.length === 0
          ? "ZECK_WORKFLOW_NAME is not set (the environment's deployed workflow name; see deploy/README.md)"
          : probeName === undefined || probeName.length === 0
            ? "ZECK_WORKFLOW_PROBE_NAME is not set (the dedicated operator-owned probe workflow; the orchestration probe never targets the orchestration workflow — see deploy/README.md)"
            : null;
  if (notMaterialized !== null) {
    return { concern: "durable-orchestration", status: "unavailable", detail: notMaterialized };
  }
  try {
    const transport = createCloudflareWorkflowsTransport({
      ...loadCloudflareWorkflowsRuntimeConfig(process.env),
      requestTimeoutMs: 15_000,
    });
    const probe = await transport.probe();
    return { concern: "durable-orchestration", status: "ready", detail: probe.detail };
  } catch (error) {
    return {
      concern: "durable-orchestration",
      status: "unavailable",
      detail: `workflow orchestration probe failed closed: ${(error as Error).message.slice(0, 140)}`,
    };
  }
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
