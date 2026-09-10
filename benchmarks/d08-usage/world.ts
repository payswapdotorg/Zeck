/**
 * benchmarks/d08-usage/world.ts — the D-08 gate-evidence campaign composition
 * root (measured-production-usage baseline).
 *
 * Composes the REAL delivered system the way the repository composes it:
 *
 *  - the authority: PostgreSQL `zeck_local` (the D-02 converged local
 *    database) through the real `PgDatabasePort`;
 *  - the public surface: the REAL Fastify API server (`createApiServer`)
 *    over the REAL SQL module authorities (executions, agents, economics,
 *    codebase analyzer, scope resolver), LISTENING ON A REAL PORT — all
 *    usage is driven through it with the REAL SDK client (`sdk/index.ts`);
 *  - the queue plane: the REAL Cloudflare-Queues transport adapter pointed
 *    at a LOCAL, protocol-faithful stand-in server
 *    (`tests/integration/queue/lib/fake-cloudflare-queues.ts` — the same
 *    server the D-03 integration suites use to prove the adapter's wire
 *    behavior). NOT Cloudflare: no provider credentials exist in this
 *    sandbox; this substitution is recorded in the evidence document;
 *  - the execution plane: the REAL worker SERVICE PROCESS
 *    (`bun deploy/worker.ts run --environment local --application-id …`)
 *    as its own OS process, consuming from the queue through the REAL
 *    adapter, claiming through the REAL compute plane, executing through
 *    the REAL process sandbox substrate (isolated child processes);
 *  - the observability plane: the REAL OTLP/HTTP-JSON exporter
 *    (`src/platform/observability/otlp.ts`) through the bounded telemetry
 *    sink, environment-bound, exporting to a local collector stub that
 *    records every received request;
 *  - the durable dispatcher: the REAL `DurableDispatcher` over the
 *    `QueueCorrelationStore` (PostgreSQL) publishing through the REAL
 *    queue transport.
 *
 * HONEST BOUNDARIES (also recorded in the evidence document):
 *  - the platform-side progression (authorize → plan → queue → dispatch)
 *    has NO HTTP surface at this revision; the campaign drives it through
 *    the executions authority's public service methods exactly the way
 *    `tests/integration` does (the composition-root role). All
 *    usage-facing reads and creates go through the real HTTP surface.
 *  - Redis is absent (coordination-degraded mode, per deploy:smoke).
 *  - the container substrate is absent (no runner credential): all
 *    governed executions execute on the PROCESS substrate.
 *  - no model/provider credentials exist: the model-economics plane is
 *    exercised through the durable planning-decision records, never a
 *    live model call.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createZeckClient, type ZeckClient } from "../../sdk";
import { type ApiServer, createApiServer } from "../../src/api";
import { SqlAgentStore } from "../../src/modules/agents/adapters/sql-agent-store";
import {
  type AgentRegistry,
  createAgentRegistry,
} from "../../src/modules/agents/application/agent-registry";
import { createScopeResolver, type ScopeResolver } from "../../src/modules/auth/public";
import {
  SqlBudgetStore,
  SqlBudgetsIdempotency,
} from "../../src/modules/budgets/adapters/sql-budget-store";
import { createBudgetService } from "../../src/modules/budgets/application/budget-service";
import {
  createCapabilityRegistry,
  createInMemoryCatalogStore,
} from "../../src/modules/capabilities/public";
import {
  createCapabilityEconomicAdmission,
  createEconomicActionService,
  createPolicyEconomicAdmission,
  createSqlEconomicsModule,
  type EconomicActionService,
} from "../../src/modules/economics/public";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../src/modules/executions/adapters/sql-execution-store";
import {
  createExecutionService,
  type ExecutionService,
} from "../../src/modules/executions/application/execution-service";
import {
  createNodeDigest,
  createOpportunityAnalyzer,
  SqlOpportunityStore,
} from "../../src/modules/learning/public";
import {
  createExecutionAuthorization,
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
  type PolicyAuthority,
} from "../../src/modules/policies/public";
import { SqlSandboxStore } from "../../src/modules/sandbox/adapters/sql-sandbox-store";
import { createEnvironmentCatalog } from "../../src/modules/sandbox/application/environment-catalog";
import type { ComputeEnvironmentSpec } from "../../src/modules/sandbox/domain/environment";
import { parseConnectionConfig } from "../../src/platform/db/connection";
import { PgDatabasePort } from "../../src/platform/db/pg-database-port";
import { createOtlpExporter } from "../../src/platform/observability/otlp";
import {
  BoundedTelemetrySink,
  bindSinkEnvironment,
} from "../../src/platform/observability/telemetry";
import { createCloudflareQueuesTransport } from "../../src/platform/queue/cloudflare-queues";
import { QueueCorrelationStore } from "../../src/platform/queue/correlation";
import { DurableDispatcher } from "../../src/platform/queue/dispatcher";
import { validateRetryPolicy } from "../../src/platform/queue/port";
import { createUuidv7Generator } from "../../src/shared/ids";

import {
  type FakeQueueServer,
  startFakeCloudflareQueues,
} from "../../tests/integration/queue/lib/fake-cloudflare-queues";

// ---------------------------------------------------------------------------
// Fixed campaign topology (deterministic, recorded in the evidence)
// ---------------------------------------------------------------------------

export const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const DATA_DIR = join(REPO_ROOT, "benchmarks/d08-usage/data");

export const API_PORT = 4100;
export const OTLP_PORT = 4102;
/** 32-hex Cloudflare-style queue ids (the adapter's pattern contract). */
export const EXECUTION_QUEUE_ID = "0d08cafe0000000000000000000000aa";
export const PROBE_QUEUE_ID = "0d08cafe0000000000000000000000bb";
export const QUEUE_ACCOUNT_ID = "0d08acc00000000000000000000000c1";
export const QUEUE_TOKEN = "d08-campaign-queue-token";
export const BEARER_TOKEN = "d08-campaign-bearer-token";
/** The campaign application's actor (the membership owner). */
export const CAMPAIGN_ACTOR_ID = "00000000-0000-7000-8000-000000000d08";

export const STANDARD_SPEC: ComputeEnvironmentSpec = {
  kind: "process",
  limits: {
    cpuMilliCores: 500,
    memoryMiB: 128,
    executionTimeoutMs: 30_000,
  },
  network: { egress: "none", allowedHosts: [] },
  filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: { capabilityId: "process-sandbox" },
  cost: { estimatedCostMicroUsd: "0" },
};

/** The retry plane: a short admitted wall-clock bound → retryable timeouts. */
export const RETRY_SPEC: ComputeEnvironmentSpec = {
  ...STANDARD_SPEC,
  limits: {
    cpuMilliCores: 500,
    memoryMiB: 128,
    executionTimeoutMs: 400,
  },
};

/** The budget plane: a COSTED environment (non-zero estimate → reserve/settle). */
export const COSTED_SPEC: ComputeEnvironmentSpec = {
  ...STANDARD_SPEC,
  cost: { estimatedCostMicroUsd: "1000" },
};

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export interface WorldIdentity {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly environmentId: string;
  readonly actorId: string;
  readonly bearerToken: string;
}

export interface CampaignWorld {
  readonly db: PgDatabasePort;
  readonly identity: WorldIdentity;
  readonly executions: ExecutionService;
  readonly policyAuthority: PolicyAuthority;
  readonly budgets: ReturnType<typeof createBudgetService>;
  readonly dispatcher: DurableDispatcher;
  readonly api: ApiServer;
  readonly apiBaseUrl: string;
  readonly client: ZeckClient;
  readonly fakeQueue: FakeQueueServer;
  readonly standardEnvironmentId: string;
  readonly retryEnvironmentId: string;
  readonly costedEnvironmentId: string;
  readonly worker: ChildProcess;
  readonly workerLogPath: string;
  readonly otlp: {
    readonly server: Server;
    readonly samples: { at: string; path: string; bytes: number; preview: string }[];
  };
  stop(): Promise<void>;
}

/** Read the persisted identity if the durable rows still exist, else re-seed. */
async function ensureIdentity(db: PgDatabasePort): Promise<WorldIdentity> {
  const worldFile = join(DATA_DIR, "world.json");
  try {
    const identity = JSON.parse(readFileSync(worldFile, "utf8")) as WorldIdentity;
    const found = await db.execute<{ id: string }>({
      sql: "SELECT id FROM applications.applications WHERE id = $1",
      parameters: [identity.applicationId],
    });
    if (found.rows[0] !== undefined) {
      return identity;
    }
  } catch {
    // No prior world (or unreadable) — seed fresh.
  }
  const generateId = createUuidv7Generator();
  const tenantId = generateId();
  const applicationId = generateId();
  const environmentId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "d08 campaign tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "d08 campaign app"],
  });
  await db.execute({
    sql: "INSERT INTO applications.environments (id, application_id, tenant_id, kind, name) VALUES ($1, $2, $3, $4, $5)",
    parameters: [environmentId, applicationId, tenantId, "production", "d08"],
  });
  await db.execute({
    sql: "INSERT INTO identity.actors (id, display_name) VALUES ($1, $2)",
    parameters: [CAMPAIGN_ACTOR_ID, "d08 campaign actor"],
  });
  await db.execute({
    sql: `INSERT INTO identity.memberships (id, actor_id, application_id, tenant_id, role)
          VALUES ($1, $2, $3, $4, 'owner')`,
    parameters: [generateId(), CAMPAIGN_ACTOR_ID, applicationId, tenantId],
  });
  const identity: WorldIdentity = {
    tenantId,
    applicationId,
    environmentId,
    actorId: CAMPAIGN_ACTOR_ID,
    bearerToken: BEARER_TOKEN,
  };
  writeFileSync(worldFile, `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
}

/** The OTLP/HTTP-JSON collector stub: records every received export request. */
function startOtlpStub(
  onSample: (sample: { at: string; path: string; bytes: number; preview: string }) => void,
): Server {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      onSample({
        at: new Date().toISOString(),
        path: request.url ?? "/",
        bytes: body.byteLength,
        preview: body.toString("utf8").slice(0, 400),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ partialSuccess: {} }));
    });
  });
  server.listen(OTLP_PORT, "127.0.0.1");
  return server;
}

/** Spawn the REAL worker service process (deploy/worker.ts run). */
function spawnWorker(
  identity: WorldIdentity,
  queueBaseUrl: string,
): { worker: ChildProcess; logPath: string } {
  const logPath = join(DATA_DIR, "worker.log");
  const workerEnv = {
    ...process.env,
    ZECK_ENVIRONMENT: "local",
    ZECK_DATABASE_URL: process.env.ZECK_DATABASE_URL ?? "",
    // The queue plane: the REAL adapter pointed at the local stand-in.
    ZECK_CLOUDFLARE_ACCOUNT_ID: QUEUE_ACCOUNT_ID,
    ZECK_QUEUE_ID: EXECUTION_QUEUE_ID,
    ZECK_PROBE_QUEUE_ID: PROBE_QUEUE_ID,
    ZECK_QUEUE_API_TOKEN: QUEUE_TOKEN,
    ZECK_QUEUE_API_BASE_URL: queueBaseUrl,
    // The observability plane: the REAL OTLP exporter → the local stub.
    ZECK_OTLP_ENDPOINT: `http://127.0.0.1:${OTLP_PORT}`,
    // Fabric policy tuned for the campaign (within the documented bounds).
    ZECK_WORKER_HEARTBEAT_INTERVAL_MS: "1000",
    ZECK_WORKER_MAX_IN_FLIGHT: "16",
    ZECK_WORKER_DEFAULT_ENV_QUOTA: "16",
    ZECK_WORKER_BATCH_SIZE: "8",
    ZECK_WORKER_LEASE_TTL_MS: "60000",
    ZECK_WORKER_CLAIM_VISIBILITY_MS: "30000",
  };
  const worker = spawn(
    "bun",
    [
      "deploy/worker.ts",
      "run",
      "--environment",
      "local",
      "--application-id",
      identity.applicationId,
    ],
    { cwd: REPO_ROOT, env: workerEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  worker.stdout?.on("data", (chunk: Buffer) => appendFileSync(logPath, chunk));
  worker.stderr?.on("data", (chunk: Buffer) => appendFileSync(logPath, chunk));
  return { worker, logPath };
}

export interface StartWorldOptions {
  /** Queue-depth sampling cadence (ms); 0 disables the sampler. */
  readonly queueSampleIntervalMs?: number;
}

export async function startWorld(options: StartWorldOptions = {}): Promise<CampaignWorld> {
  mkdirSync(DATA_DIR, { recursive: true });
  const databaseUrl = process.env.ZECK_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("ZECK_DATABASE_URL is required (the converged zeck_local database)");
  }
  const db = new PgDatabasePort(
    parseConnectionConfig(databaseUrl, {
      max: 8,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30_000,
    }),
  );
  const generateId = createUuidv7Generator();

  // The identity (tenant/application/environment/actor/membership).
  const identity = await ensureIdentity(db);
  const scope = {
    actorId: identity.actorId,
    applicationId: identity.applicationId,
    tenantId: identity.tenantId,
  };

  // Policies: the REAL authority behind the authorize seam (permissive
  // platform baseline; the policy-denied scenario publishes version 2).
  const policyStore = new InMemoryPolicyStore();
  const policyAuthority = createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher });
  await policyAuthority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });

  // Executions: the REAL SQL authority (the frozen single write path).
  const executions = createExecutionService({
    store: new SqlExecutionStore(db),
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: createExecutionAuthorization(policyAuthority),
    generateId,
    now: () => new Date(),
  });

  // Agents + economics (the API server's projected inventory).
  const agents: AgentRegistry = createAgentRegistry({
    store: new SqlAgentStore(db),
    generateId,
    now: () => new Date(),
    hashDefinition: (canonicalJson) => sha256Hex(canonicalJson),
  });
  const budgetSeam = {
    reserve: async () => {
      throw new Error("budget reserve is not exercised through the api surface");
    },
    settle: async () => {
      throw new Error("budget settle is not exercised through the api surface");
    },
    release: async () => {
      throw new Error("budget release is not exercised through the api surface");
    },
  };
  const capabilityRegistry = await createCapabilityRegistry({
    store: createInMemoryCatalogStore(),
  });
  const { store: economicStore, idempotency: economicIdempotency } = createSqlEconomicsModule(
    db,
    generateId,
  );
  const economics: EconomicActionService = createEconomicActionService({
    store: economicStore,
    idempotency: economicIdempotency,
    policy: createPolicyEconomicAdmission(policyAuthority),
    capabilities: createCapabilityEconomicAdmission(capabilityRegistry),
    budget: budgetSeam,
    executions,
    generateId,
    now: () => new Date(),
  });
  const codebaseAnalyzer = createOpportunityAnalyzer({
    store: new SqlOpportunityStore(db),
    digest: createNodeDigest(),
    generateId,
    now: () => new Date(),
  });

  // The scope resolver over the REAL identity tables.
  const identityStore = {
    findMembershipWithApplicationTenant: (async (actorId: string, appId: string) => {
      const result = await db.execute<{
        membership_id: string;
        actor_id: string;
        application_id: string;
        tenant_id: string;
        role: string;
        created_at: Date;
        application_tenant_id: string;
      }>({
        sql: `SELECT m.id AS membership_id, m.actor_id, m.application_id, m.tenant_id, m.role,
                     m.created_at, a.tenant_id AS application_tenant_id
              FROM identity.memberships m
              JOIN applications.applications a ON a.id = m.application_id
              WHERE m.actor_id = $1 AND m.application_id = $2`,
        parameters: [actorId, appId],
      });
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        membership: {
          id: row.membership_id,
          actorId: row.actor_id,
          applicationId: row.application_id,
          tenantId: row.tenant_id,
          role: row.role,
          createdAt: row.created_at.toISOString(),
        },
        applicationTenantId: row.application_tenant_id,
      };
    }) as never,
  };
  const notImplemented = (name: string) => () => {
    throw new Error(`not implemented in the d08 world: ${name}`);
  };
  const identityStoreFull = {
    provisionActor: notImplemented("provisionActor"),
    findActor: (async () => null) as never,
    findMembershipWithApplicationTenant: identityStore.findMembershipWithApplicationTenant,
    findTenantMembership: (async () => null) as never,
    listMemberships: (async () => []) as never,
    insertMembership: notImplemented("insertMembership"),
    updateMembershipRole: notImplemented("updateMembershipRole"),
    deleteMembership: notImplemented("deleteMembership"),
    lockApplicationMemberships: (async () => []) as never,
  };
  const scopeResolver: ScopeResolver = createScopeResolver(identityStoreFull);

  // Budgets: the REAL service over the SQL fabric (the campaign funds the
  // application's developer wallet; the WORKER's sandbox admission seam
  // reserves/settles/releases against the same durable budgets).
  const budgets = createBudgetService({
    store: new SqlBudgetStore(db),
    idempotency: new SqlBudgetsIdempotency(db, (tx) => new SqlBudgetStore(tx), generateId),
    generateId,
    now: () => new Date(),
  });

  // The sandbox compute-environment catalog (durable registrations the
  // worker's claim admission reads).
  const catalog = createEnvironmentCatalog({
    store: new SqlSandboxStore(db),
    generateId,
    now: () => new Date(),
    hashSpec: sha256Hex,
  });
  const findEnvironment = async (slug: string): Promise<string> => {
    const result = await db.execute<{ id: string }>({
      sql: "SELECT id FROM sandbox.compute_environments WHERE slug = $1 AND application_id = $2",
      parameters: [slug, identity.applicationId],
    });
    return result.rows[0]?.id ?? "";
  };
  const registerIfAbsent = async (slug: string, spec: ComputeEnvironmentSpec): Promise<string> => {
    const existing = await findEnvironment(slug);
    if (existing !== "") return existing;
    const record = await catalog.register(
      {
        applicationId: identity.applicationId,
        tenantId: identity.tenantId,
        slug,
        name: `d08 ${slug}`,
        spec,
      },
      `d08-register-${slug}`,
      scope,
    );
    return record.id;
  };
  const standardEnvironmentId = await registerIfAbsent("d08-standard", STANDARD_SPEC);
  const retryEnvironmentId = await registerIfAbsent("d08-retry", RETRY_SPEC);
  const costedEnvironmentId = await registerIfAbsent("d08-costed", COSTED_SPEC);

  // The queue plane: the local protocol-faithful stand-in + the REAL
  // transport adapter the dispatcher publishes through.
  const fakeQueue = await startFakeCloudflareQueues({
    accountId: QUEUE_ACCOUNT_ID,
    queueId: EXECUTION_QUEUE_ID,
    apiToken: QUEUE_TOKEN,
    probeQueueId: PROBE_QUEUE_ID,
  });
  const transport = createCloudflareQueuesTransport({
    apiBaseUrl: fakeQueue.baseUrl,
    accountId: QUEUE_ACCOUNT_ID,
    queueId: EXECUTION_QUEUE_ID,
    probeQueueId: PROBE_QUEUE_ID,
    apiToken: QUEUE_TOKEN,
    requestTimeoutMs: 5000,
  });
  const correlation = new QueueCorrelationStore(db);
  const dispatcher = new DurableDispatcher({
    store: correlation,
    transport,
    policy: validateRetryPolicy({
      maxPublishAttempts: 3,
      maxDeliveryAttempts: 3,
      maxReplays: 3,
      retryBackoffMs: 500,
    }),
    generateId,
    now: () => new Date(),
    sleep: async (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  });

  // The observability plane: REAL OTLP exporter → the local collector stub.
  const otlpSamples: { at: string; path: string; bytes: number; preview: string }[] = [];
  const otlp = startOtlpStub((sample) => {
    otlpSamples.push(sample);
    appendFileSync(join(DATA_DIR, "observability-samples.jsonl"), `${JSON.stringify(sample)}\n`);
  });
  const sink = new BoundedTelemetrySink({
    exporter: createOtlpExporter({
      endpoint: `http://127.0.0.1:${OTLP_PORT}`,
      requestTimeoutMs: 5000,
    }),
  });
  const telemetry = bindSinkEnvironment(sink, "local");

  // The dependency readiness probe (the smoke's honest local readings).
  const dependencyReadiness = async () => {
    let pgStatus: "ready" | "unavailable" = "ready";
    let detail = "postgres reachable; zeck_local present";
    try {
      await db.execute({ sql: "SELECT 1", parameters: [] });
    } catch {
      pgStatus = "unavailable";
      detail = "postgres unreachable";
    }
    return [
      {
        name: "relational-state",
        authority: "authoritative" as const,
        status: pgStatus,
        detail,
      },
      {
        name: "artifact-bytes",
        authority: "non-authoritative" as const,
        status: "ready" as const,
        detail: "object-store root present (local)",
      },
      {
        name: "ephemeral-coordination",
        authority: "non-authoritative" as const,
        status: "degraded" as const,
        degradedMode: "coordination-degraded",
        detail: "ZECK_LOCAL_REDIS_URL is not set; degraded by explicit choice",
      },
    ];
  };

  // The bearer-token transport-auth seam (the injectable boundary).
  const tokens = new Map<string, string>([[BEARER_TOKEN, identity.actorId]]);
  const authenticate = async (request: { readonly headers: Record<string, unknown> }) => {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw Object.assign(new Error("missing bearer credential"), { statusCode: 401 });
    }
    const actorId = tokens.get(header.slice("Bearer ".length).trim());
    if (actorId === undefined) {
      throw Object.assign(new Error("invalid credential"), { statusCode: 401 });
    }
    return { actorId, authenticatedAt: new Date().toISOString() };
  };

  // The public surface: the REAL API server, listening on a real port.
  const api = createApiServer({
    executions,
    agents,
    economics,
    codebaseAnalyzer,
    scopeResolver,
    authenticate,
    dependencyReadiness,
    listAgentIdsOfApplication: async (appId) => {
      const result = await db.execute<{ id: string }>({
        sql: "SELECT id FROM agents.agents WHERE application_id = $1 ORDER BY created_at ASC",
        parameters: [appId],
      });
      return result.rows.map((row) => row.id);
    },
    telemetry,
  });
  await api.app.listen({ port: API_PORT, host: "127.0.0.1" });
  const apiBaseUrl = `http://127.0.0.1:${API_PORT}`;

  // The REAL SDK client — every usage call goes through the HTTP surface.
  const client = createZeckClient({
    baseUrl: apiBaseUrl,
    token: BEARER_TOKEN,
    applicationId: identity.applicationId,
  });

  // The execution plane: the REAL worker service process.
  const { worker, logPath } = spawnWorker(identity, fakeQueue.baseUrl);

  // Queue-depth sampler (the environmental measurement of backlog).
  const sampleIntervalMs = options.queueSampleIntervalMs ?? 1000;
  const sampler =
    sampleIntervalMs > 0
      ? setInterval(() => {
          appendFileSync(
            join(DATA_DIR, "queue-depth.jsonl"),
            `${JSON.stringify({ at: new Date().toISOString(), pending: fakeQueue.pendingCount })}\n`,
          );
        }, sampleIntervalMs)
      : null;
  sampler?.unref?.();

  return {
    db,
    identity,
    executions,
    policyAuthority,
    budgets,
    dispatcher,
    api,
    apiBaseUrl,
    client,
    fakeQueue,
    standardEnvironmentId,
    retryEnvironmentId,
    costedEnvironmentId,
    worker,
    workerLogPath: logPath,
    otlp: { server: otlp, samples: otlpSamples },
    async stop() {
      if (sampler !== null) clearInterval(sampler);
      // The graceful drain: SIGTERM the worker and wait for its bounded drain.
      if (worker.exitCode === null) {
        worker.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const deadline = Date.now() + 30_000;
          const poll = setInterval(() => {
            if (worker.exitCode !== null || Date.now() > deadline) {
              clearInterval(poll);
              if (worker.exitCode === null) worker.kill("SIGKILL");
              resolve();
            }
          }, 250);
        });
      }
      try {
        await (sink as unknown as { flush?: () => Promise<unknown> }).flush?.();
      } catch {
        // The sink is bounded; a flush failure never blocks shutdown.
      }
      await new Promise<void>((resolve) => otlp.close(() => resolve()));
      await api.app.close();
      await fakeQueue.close();
      await db.close();
    },
  };
}
