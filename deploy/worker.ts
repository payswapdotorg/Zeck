/**
 * deploy/worker — the D-05 execution-worker operator surface + the
 * worker process entry (WORK-046).
 *
 * Commands (all fail closed; the durable authority is always
 * PostgreSQL; the queue/runner are transport/substrate only):
 *
 *   run        — THE WORKER SERVICE PROCESS: register, then the
 *                bounded loop (consume → recover → heartbeat) until
 *                SIGTERM/SIGINT, then graceful drain (bounded by
 *                ZECK_WORKER_MAX_DRAIN_MS; straggler claims are
 *                abandoned recoverable — never lost, never
 *                duplicated). Independently runnable and deployable
 *                from the request-facing control plane.
 *   run-once   — one bounded iteration (consume + recover) — the
 *                smoke/verification path (exact-revision evidence).
 *   inspect    — the read-only worker-plane snapshot (registrations,
 *                live claims, quotas, recoverable candidates) + the
 *                exact Git revision.
 *   sweep      — one stale-worker/stale-claim sweep (offline sweep +
 *                abandon; no re-drive).
 *   recover    — the full recovery scan (sweep + re-drive of
 *                recoverable executions from the authority).
 *   compact    — bounded terminal-claim compaction (retention).
 *   quota      — set a per-compute-environment concurrent-claim quota.
 *   runner     — the governed customer-runner registration lifecycle
 *                (register/activate/suspend/revoke/list) — attributable,
 *                revocable, NON-AUTHORITATIVE executor metadata.
 *
 * Composition root: this tool wires the pieces the frozen dependency
 * rules keep separate — the DatabasePort from the materialized
 * database-url secret, the queue transport from the materialized
 * queue-api-token secret + ordinary configuration, the executions
 * module's governed start/lease/completion/recovery seams, the sandbox
 * module's admission + work executor, and the container runtime
 * client from the materialized container-runner-token secret.
 * Secrets resolve from the environment immediately before the
 * authorized adapter call; they never appear in output, errors or
 * logs.
 *
 * The D-05 worker composition note (documented in deploy/README.md):
 * the policies module's durable store does not exist yet (future
 * scope); the worker seeds the repository baseline policy set (the
 * same platform-scope baseline the governed admission chain consumes)
 * at boot through the REAL policy authority behind the sandbox
 * admission seam — policy admission is REAL and fail-closed, never
 * bypassed.
 *
 * Usage:
 *   bun run deploy:worker -- run        [--environment local] [--application-id <uuid>]
 *   bun run deploy:worker -- run-once   [--environment local] [--application-id <uuid>]
 *   bun run deploy:worker -- inspect    [--environment local]
 *   bun run deploy:worker -- sweep      [--environment local]
 *   bun run deploy:worker -- recover    [--environment local]
 *   bun run deploy:worker -- compact    [--environment local] [--limit 100]
 *   bun run deploy:worker -- quota      [--environment local] --compute-environment-id <uuid> --max 8
 *   bun run deploy:worker -- runner register --environment local --application-id <uuid> \
 *        --tenant-id <uuid> --endpoint-url https://... --token-secret-ref zeck-secret://local/runner-x \
 *        --registered-by operator
 *   bun run deploy:worker -- runner activate|suspend|revoke --environment local --runner-id <uuid> [--reason ...]
 *   bun run deploy:worker -- runner list --environment local
 */

import { createHash } from "node:crypto";
import {
  SqlBudgetStore,
  SqlBudgetsIdempotency,
} from "../src/modules/budgets/adapters/sql-budget-store";
import { createBudgetService } from "../src/modules/budgets/application/budget-service";
import {
  createInMemoryCatalogStore,
  SEED_CAPABILITY_FACTS,
} from "../src/modules/capabilities/adapters/index";
import { createCapabilityRegistry } from "../src/modules/capabilities/application/index";
import { createPolicyResumeAdmission } from "../src/modules/executions/adapters/policy-resume-admission";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../src/modules/executions/adapters/sql-execution-store";
import { SqlLongRunningExecutionStore } from "../src/modules/executions/adapters/sql-long-running-store";
import {
  createExecutionStatusReader,
  createRecoverableExecutionSource,
  createWorkerCompletionEffect,
  createWorkerDispatchStartEffect,
  createWorkerLeaseAuthority,
  envelopeSessionOf,
} from "../src/modules/executions/adapters/worker-fabric";
import {
  createExecutionService,
  type ExecutionService,
} from "../src/modules/executions/application/execution-service";
import { createLongRunningExecutionService } from "../src/modules/executions/application/long-running-service";
import { isTerminal } from "../src/modules/executions/public";
import {
  createExecutionAuthorization,
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
} from "../src/modules/policies/public";
import { createSandboxCapabilityGate } from "../src/modules/sandbox/adapters/capability-gate";
import { ContainerSandboxProvider } from "../src/modules/sandbox/adapters/container-provider";
import { createSandboxExecutionLedgerAdapter } from "../src/modules/sandbox/adapters/execution-ledger";
import { createExecutionResumeReadmission } from "../src/modules/sandbox/adapters/execution-resume-readmission";
import { createPolicySandboxAdmission } from "../src/modules/sandbox/adapters/policy-sandbox-admission";
import { ProcessSandboxProvider } from "../src/modules/sandbox/adapters/process-provider";
import { SqlSandboxStore } from "../src/modules/sandbox/adapters/sql-sandbox-store";
import { createSandboxWorkExecutor } from "../src/modules/sandbox/adapters/worker-executor";
import { createEnvironmentCatalog } from "../src/modules/sandbox/application/environment-catalog";
import { createSandboxService } from "../src/modules/sandbox/application/sandbox-service";
import { createSandboxProviderRegistry } from "../src/modules/sandbox/ports/sandbox-provider";
import { loadWorkerPolicy } from "../src/platform/compute/config";
import {
  type ContainerRuntimeClientConfig,
  createContainerRuntimeClient,
} from "../src/platform/compute/container-runtime";
import {
  createExecutionWorkerFabric,
  type ExecutionWorkerFabric,
} from "../src/platform/compute/fabric";
import { SqlComputeWorkerStore } from "../src/platform/compute/pg-store";
import { parseConnectionConfig } from "../src/platform/db/connection";
import { PgDatabasePort } from "../src/platform/db/pg-database-port";
import type { EnvironmentId } from "../src/platform/deployment/naming";
import { loadTelemetryConfig } from "../src/platform/observability/config";
import { createOtlpExporter } from "../src/platform/observability/otlp";
import { BoundedTelemetrySink, bindSinkEnvironment } from "../src/platform/observability/telemetry";
import {
  createCloudflareQueuesTransport,
  loadCloudflareQueuesRuntimeConfig,
} from "../src/platform/queue/cloudflare-queues";
import { QueueCorrelationStore } from "../src/platform/queue/correlation";
import { validateRetryPolicy } from "../src/platform/queue/port";
import {
  asSecretReference,
  createEnvSecretStore,
  SecretResolutionError,
} from "../src/platform/secret-store/adapters/env-secret-store";
import { createUuidv7Generator } from "../src/shared/ids";
import { gitRevision, requireEnvironment } from "./lib";

const TOOL_WORKER_ACTOR_ID = "00000000-0000-7000-8000-0000000000ef";

function requireCommand(argv: readonly string[]): string {
  const command = argv[0] as string;
  const commands = ["run", "run-once", "inspect", "sweep", "recover", "compact", "quota", "runner"];
  if (!commands.includes(command)) {
    console.error(
      "error: command required: run | run-once | inspect | sweep | recover | compact [--limit N] | quota | runner",
    );
    process.exit(2);
  }
  return command;
}

function stringOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) {
    return undefined;
  }
  return argv[index + 1];
}

function numericOption(argv: readonly string[], name: string, fallback: number): number {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) {
    return fallback;
  }
  const value = Number.parseInt(argv[index + 1] ?? "", 10);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`error: ${name} must be a positive integer`);
    process.exit(2);
  }
  return value;
}

/** Resolve the materialized database-url secret through the secret store. */
async function authoritativeDatabaseUrl(environment: string): Promise<string> {
  const store = createEnvSecretStore({ environment, env: process.env });
  try {
    const resolved = await store.resolve(
      asSecretReference(`zeck-secret://${environment}/database-url`),
    );
    return resolved.plaintext;
  } catch (error) {
    if (error instanceof SecretResolutionError) {
      console.error(`error: ${error.message}`);
    } else {
      console.error(`error: database-url resolution failed: ${(error as Error).message}`);
    }
    process.exit(1);
  }
}

async function withAuthoritativeDatabase<T>(
  environment: string,
  work: (db: PgDatabasePort) => Promise<T>,
): Promise<T> {
  const url = await authoritativeDatabaseUrl(environment);
  const config = parseConnectionConfig(url, {
    max: 8,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30_000,
  });
  const db = new PgDatabasePort(config);
  try {
    return await work(db);
  } finally {
    await db.close();
  }
}

/** Build the queue transport (fail closed with the exact variables). */
function queueTransportFromEnvironment() {
  try {
    const config = loadCloudflareQueuesRuntimeConfig(process.env);
    return createCloudflareQueuesTransport(config);
  } catch (error) {
    console.error(`error: queue transport configuration: ${(error as Error).message}`);
    process.exit(1);
  }
}

/** The container runtime client configuration when the runner is wired. */
function containerRuntimeConfig(): ContainerRuntimeClientConfig | null {
  const baseUrl = process.env.ZECK_CONTAINER_RUNNER_URL;
  const apiToken = process.env.ZECK_CONTAINER_RUNNER_API_TOKEN;
  if (
    (baseUrl === undefined || baseUrl.length === 0) &&
    (apiToken === undefined || apiToken.length === 0)
  ) {
    return null;
  }
  if (baseUrl === undefined || baseUrl.length === 0) {
    console.error(
      "error: ZECK_CONTAINER_RUNNER_URL is required when the container substrate is configured (ZECK_CONTAINER_RUNNER_API_TOKEN is set); container dispatch fails closed without the runner",
    );
    process.exit(1);
  }
  if (apiToken === undefined || apiToken.length === 0) {
    console.error(
      "error: ZECK_CONTAINER_RUNNER_API_TOKEN is required when the container substrate is configured (ZECK_CONTAINER_RUNNER_URL is set); the reference binding is ZECK_SECRET_CONTAINER_RUNNER_TOKEN_REF",
    );
    process.exit(1);
  }
  return {
    baseUrl,
    apiToken,
    ...(process.env.ZECK_CONTAINER_RUNNER_REQUEST_TIMEOUT_MS === undefined
      ? {}
      : {
          requestTimeoutMs: Number.parseInt(
            process.env.ZECK_CONTAINER_RUNNER_REQUEST_TIMEOUT_MS,
            10,
          ),
        }),
    ...(process.env.ZECK_CONTAINER_RUNNER_POLL_INTERVAL_MS === undefined
      ? {}
      : {
          pollIntervalMs: Number.parseInt(process.env.ZECK_CONTAINER_RUNNER_POLL_INTERVAL_MS, 10),
        }),
    ...(process.env.ZECK_CONTAINER_RUNNER_MAX_OUTPUT_BYTES === undefined
      ? {}
      : {
          maxOutputBytes: Number.parseInt(process.env.ZECK_CONTAINER_RUNNER_MAX_OUTPUT_BYTES, 10),
        }),
  };
}

/**
 * The D-06 worker telemetry composition: the bounded sink over the
 * OTLP exporter when ZECK_OTLP_ENDPOINT is configured (the bearer
 * token resolved through the environment-scoped secret store
 * immediately before export composition — never logged), else the
 * noop exporter (the declared logs-only degraded mode). The sink is
 * environment-bound; the fabric emits through the seam.
 */
async function workerTelemetrySink(environment: EnvironmentId): Promise<BoundedTelemetrySink> {
  const config = loadTelemetryConfig(process.env);
  let token: string | undefined;
  const reference = process.env.ZECK_SECRET_OTLP_AUTH_TOKEN_REF;
  if (reference !== undefined && reference.trim() !== "") {
    const store = createEnvSecretStore({ environment, env: process.env });
    const secret = await store.resolve(asSecretReference(reference));
    token = secret.plaintext;
  }
  const exporter =
    config.endpoint === null
      ? undefined
      : createOtlpExporter({
          endpoint: config.endpoint,
          token,
          requestTimeoutMs: config.requestTimeoutMs,
        });
  const sink = new BoundedTelemetrySink({
    exporter: exporter ?? { export: async () => ({ kind: "accepted", accepted: 0 }) },
  });
  return sink;
}

/**
 * The D-05 worker composition (the process's own composition root):
 * every governed authority REAL and fail-closed. The D-06 telemetry
 * seam is composed here (bounded, environment-bound, optional).
 */
async function composeWorker(
  db: PgDatabasePort,
  applicationId: string,
  environment: EnvironmentId,
): Promise<{
  fabric: ExecutionWorkerFabric;
  workerId: string;
  telemetry: BoundedTelemetrySink;
}> {
  const generateId = createUuidv7Generator();

  // Policies: the REAL authority behind BOTH admission seams, seeded
  // with the repository baseline set (documented composition note).
  const policyStore = new InMemoryPolicyStore();
  const authority = createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher });
  await authority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });

  // Executions: the frozen service (single write path) + the WORK-028
  // long-running extension (the single lease system).
  const executionStore = new SqlExecutionStore(db);
  const executionService: ExecutionService = createExecutionService({
    store: executionStore,
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: createExecutionAuthorization(authority),
    generateId,
    now: () => new Date(),
  });
  // Sandbox: the SQL store + catalog + service with REAL admission,
  // capability, ledger adapters and the provider registry (process
  // runtime always; the container runtime when the runner is wired).
  const sandboxStore = new SqlSandboxStore(db);
  const catalog = createEnvironmentCatalog({
    store: sandboxStore,
    generateId,
    now: () => new Date(),
    hashSpec: (canonical) => createHash("sha256").update(canonical, "utf8").digest("hex"),
  });
  const sandboxAdmission = createPolicySandboxAdmission(authority);

  const longRunning = createLongRunningExecutionService({
    executions: executionService,
    store: new SqlLongRunningExecutionStore(db),
    resumePolicyReadmission: createPolicyResumeAdmission(authority),
    resourceReadmission: createExecutionResumeReadmission(catalog, sandboxAdmission),
    digest: (input) => createHash("sha256").update(input, "utf8").digest("hex"),
    generateId,
    now: () => new Date(),
  });

  // Capabilities: the REAL registry (platform seeds + the
  // container-runtime claim the runner composition provides).
  const capabilityRegistry = await createCapabilityRegistry({
    store: createInMemoryCatalogStore(),
    seed: [...SEED_CAPABILITY_FACTS],
  });
  await capabilityRegistry.publish({
    claim: {
      id: "container-runtime",
      kind: "runtime",
      version: "1.0.0",
      attributes: { isolation: "container", networkEgress: true },
    },
    provenance: { publisher: "deploy/worker", publishedAt: new Date().toISOString() },
    evidence: { kind: "catalog-seeded", reference: "deploy-worker-container-runtime" },
  });

  // Budgets: the REAL service behind the sandbox budget seam.
  const budgets = createBudgetService({
    store: new SqlBudgetStore(db),
    idempotency: new SqlBudgetsIdempotency(db, (tx) => new SqlBudgetStore(tx), generateId),
    generateId,
    now: () => new Date(),
  });

  const providers = createSandboxProviderRegistry();
  providers.register(new ProcessSandboxProvider());
  const runtimeConfig = containerRuntimeConfig();
  if (runtimeConfig !== null) {
    providers.register(
      new ContainerSandboxProvider({ client: createContainerRuntimeClient(runtimeConfig) }),
    );
  }
  const sandboxService = createSandboxService({
    store: sandboxStore,
    admission: sandboxAdmission,
    capabilities: createSandboxCapabilityGate(capabilityRegistry),
    budgetAuthority: budgets,
    ledger: createSandboxExecutionLedgerAdapter(executionService),
    providers,
    generateId,
    now: () => new Date(),
  });

  // The compute plane: store, seams, fabric.
  const policy = loadWorkerPolicy(process.env);
  const store = new SqlComputeWorkerStore({
    db,
    maxClaimAttempts: policy.maxClaimAttempts,
    defaultEnvironmentQuota: policy.defaultEnvironmentQuota,
    claimRetentionMs: policy.claimRetentionMs,
    generateId,
  });
  const lease = createWorkerLeaseAuthority({ service: longRunning });
  const workerId = generateId();
  const telemetry = await workerTelemetrySink(environment);
  const fabric = createExecutionWorkerFabric(
    {
      workerActorId: TOOL_WORKER_ACTOR_ID,
      store,
      startEffect: createWorkerDispatchStartEffect({
        service: executionService,
        workerActorId: TOOL_WORKER_ACTOR_ID,
      }),
      lease,
      work: createSandboxWorkExecutor({
        service: sandboxService,
        leaseGuard: (applicationIdOf, executionId, claim) =>
          lease.guard(applicationIdOf, executionId, claim),
        workerActorId: TOOL_WORKER_ACTOR_ID,
      }),
      completion: createWorkerCompletionEffect({ service: executionService, lease }),
      correlation: envelopeSessionOf(new QueueCorrelationStore(db)),
      transport: queueTransportFromEnvironment(),
      retryPolicy: validateRetryPolicy({
        maxPublishAttempts: 3,
        maxDeliveryAttempts: 3,
        maxReplays: 3,
        retryBackoffMs: 500,
      }),
      recoverySource: createRecoverableExecutionSource(db),
      statusReader: createExecutionStatusReader(executionService),
      policy,
      generateId,
      now: () => new Date(),
      telemetry: bindSinkEnvironment(telemetry, environment),
    },
    {
      workerId,
      applicationId,
      kind: "first-party",
      declaredConcurrency: policy.maxInFlightPerWorker,
      metadata: {
        tool: "deploy/worker",
        composed: "d05-worker-fabric",
        telemetry: "d06-observability",
      },
    },
  );
  return { fabric, workerId, telemetry };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = requireCommand(argv);
  const environment = requireEnvironment(argv);
  const revision = gitRevision();

  if (command === "quota") {
    const computeEnvironmentId = stringOption(argv, "--compute-environment-id");
    const max = numericOption(argv, "--max", 8);
    if (computeEnvironmentId === undefined) {
      console.error("error: quota requires --compute-environment-id <uuid>");
      process.exit(2);
    }
    await withAuthoritativeDatabase(environment, async (db) => {
      const policy = loadWorkerPolicy(process.env);
      const store = new SqlComputeWorkerStore({
        db,
        maxClaimAttempts: policy.maxClaimAttempts,
        defaultEnvironmentQuota: policy.defaultEnvironmentQuota,
        claimRetentionMs: policy.claimRetentionMs,
        generateId: createUuidv7Generator(),
      });
      await store.setEnvironmentQuota(computeEnvironmentId, max);
      const quota = await store.getEnvironmentQuota(computeEnvironmentId);
      console.log(
        JSON.stringify(
          {
            tool: "deploy/worker",
            command,
            environment,
            gitRevision: revision,
            computeEnvironmentId,
            quota,
          },
          null,
          2,
        ),
      );
    });
    return;
  }

  if (command === "runner") {
    const subcommand = argv[argv.indexOf("runner") + 1];
    if (!["register", "activate", "suspend", "revoke", "list"].includes(subcommand ?? "")) {
      console.error("error: runner requires register | activate | suspend | revoke | list");
      process.exit(2);
    }
    await withAuthoritativeDatabase(environment, async (db) => {
      const policy = loadWorkerPolicy(process.env);
      const store = new SqlComputeWorkerStore({
        db,
        maxClaimAttempts: policy.maxClaimAttempts,
        defaultEnvironmentQuota: policy.defaultEnvironmentQuota,
        claimRetentionMs: policy.claimRetentionMs,
        generateId: createUuidv7Generator(),
      });
      const now = new Date().toISOString();
      if (subcommand === "register") {
        const runnerId = stringOption(argv, "--runner-id") ?? createUuidv7Generator()(); // one fresh identity
        const applicationId = stringOption(argv, "--application-id");
        const tenantId = stringOption(argv, "--tenant-id");
        const endpointUrl = stringOption(argv, "--endpoint-url");
        const tokenSecretRef = stringOption(argv, "--token-secret-ref");
        const registeredBy = stringOption(argv, "--registered-by");
        if (
          applicationId === undefined ||
          tenantId === undefined ||
          endpointUrl === undefined ||
          tokenSecretRef === undefined ||
          registeredBy === undefined
        ) {
          console.error(
            "error: runner register requires --application-id, --tenant-id, --endpoint-url, --token-secret-ref, --registered-by",
          );
          process.exit(2);
        }
        const record = await store.registerRunner(
          {
            runnerId,
            applicationId,
            tenantId,
            endpointUrl,
            tokenSecretRef,
            registeredBy,
          },
          now,
        );
        console.log(
          JSON.stringify(
            { tool: "deploy/worker", command, gitRevision: revision, runner: record },
            null,
            2,
          ),
        );
        return;
      }
      if (subcommand === "list") {
        const runners = await store.listRunners();
        const workers = await store.listWorkers();
        console.log(
          JSON.stringify(
            { tool: "deploy/worker", command, gitRevision: revision, runners, workers },
            null,
            2,
          ),
        );
        return;
      }
      const runnerId = stringOption(argv, "--runner-id");
      if (runnerId === undefined) {
        console.error("error: runner requires --runner-id");
        process.exit(2);
      }
      const status =
        subcommand === "activate" ? "active" : subcommand === "suspend" ? "suspended" : "revoked";
      const record = await store.transitionRunner(runnerId, status, {
        reason: stringOption(argv, "--reason") ?? `operator:${subcommand}`,
        actorId: TOOL_WORKER_ACTOR_ID,
        now,
      });
      console.log(
        JSON.stringify(
          { tool: "deploy/worker", command, gitRevision: revision, runner: record },
          null,
          2,
        ),
      );
    });
    return;
  }

  if (command === "inspect") {
    await withAuthoritativeDatabase(environment, async (db) => {
      const policy = loadWorkerPolicy(process.env);
      const store = new SqlComputeWorkerStore({
        db,
        maxClaimAttempts: policy.maxClaimAttempts,
        defaultEnvironmentQuota: policy.defaultEnvironmentQuota,
        claimRetentionMs: policy.claimRetentionMs,
        generateId: createUuidv7Generator(),
      });
      const workers = await store.listWorkers();
      const liveClaims = await store.listLiveClaims();
      const recoverable = await createRecoverableExecutionSource(db).listRecoverable({
        limit: 100,
      });
      const staleClaims = await store.listStaleClaims(policy.workerStaleAfterMs, 100);
      console.log(
        JSON.stringify(
          {
            tool: "deploy/worker",
            command,
            environment,
            gitRevision: revision,
            policy,
            workers,
            liveClaims,
            staleClaims,
            recoverable: recoverable.map((facts) => ({
              executionId: facts.executionId,
              applicationId: facts.applicationId,
            })),
          },
          null,
          2,
        ),
      );
    });
    return;
  }

  if (command === "compact") {
    const limit = numericOption(argv, "--limit", 100);
    await withAuthoritativeDatabase(environment, async (db) => {
      const policy = loadWorkerPolicy(process.env);
      const generateId = createUuidv7Generator();
      const store = new SqlComputeWorkerStore({
        db,
        maxClaimAttempts: policy.maxClaimAttempts,
        defaultEnvironmentQuota: policy.defaultEnvironmentQuota,
        claimRetentionMs: policy.claimRetentionMs,
        generateId,
      });
      // The terminal-execution seam: the executions AUTHORITY decides
      // terminality (the compute plane never reads the executions
      // tables — the module-adapter boundary).
      const executionService = createExecutionService({
        store: new SqlExecutionStore(db),
        idempotency: new SqlExecutionsIdempotency(
          db,
          (tx) => new SqlExecutionStore(tx),
          generateId,
        ),
        authorization: { evaluate: async () => ({ allowed: true }) },
        generateId,
        now: () => new Date(),
      });
      const report = await store.compactTerminalClaims(limit, async (executionId) => {
        const execution = await executionService.getExecution("compact-scan", executionId);
        return execution !== null && isTerminal(execution.status);
      });
      console.log(
        JSON.stringify({ tool: "deploy/worker", command, gitRevision: revision, report }, null, 2),
      );
    });
    return;
  }

  // run | run-once | sweep | recover: the worker composition.
  const applicationId = stringOption(argv, "--application-id");
  if (applicationId === undefined) {
    console.error(
      "error: the worker commands require --application-id <uuid> (the application whose executions this worker serves)",
    );
    process.exit(2);
  }
  await withAuthoritativeDatabase(environment, async (db) => {
    const { fabric, workerId, telemetry } = await composeWorker(db, applicationId, environment);
    await fabric.register();

    if (command === "run-once") {
      const consume = await fabric.consumeBatch();
      const recovery = await fabric.recover();
      await fabric.heartbeat();
      await telemetry.flush();
      const telemetryStats = telemetry.stats();
      console.log(
        JSON.stringify(
          {
            tool: "deploy/worker",
            command,
            environment,
            gitRevision: revision,
            workerId,
            consume,
            recovery,
            telemetry: telemetryStats,
          },
          null,
          2,
        ),
      );
      await fabric.stop("run-once-complete");
      return;
    }

    if (command === "sweep") {
      // One bounded sweep without re-drive: stale workers offline +
      // stale claims abandoned (typed, inspectable).
      const policy = loadWorkerPolicy(process.env);
      const store = new SqlComputeWorkerStore({
        db,
        maxClaimAttempts: policy.maxClaimAttempts,
        defaultEnvironmentQuota: policy.defaultEnvironmentQuota,
        claimRetentionMs: policy.claimRetentionMs,
        generateId: createUuidv7Generator(),
      });
      const swept = await store.sweepStaleWorkers(
        policy.workerStaleAfterMs,
        new Date().toISOString(),
      );
      const stale = await store.listStaleClaims(policy.workerStaleAfterMs, 100);
      let abandoned = 0;
      for (const claim of stale) {
        await store.abandonClaim(
          { claimId: claim.id, cause: "heartbeat-lost", detail: { sweptBy: workerId } },
          new Date().toISOString(),
        );
        abandoned += 1;
      }
      console.log(
        JSON.stringify(
          {
            tool: "deploy/worker",
            command,
            environment,
            gitRevision: revision,
            sweptWorkers: swept.length,
            abandonedClaims: abandoned,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (command === "recover") {
      const recovery = await fabric.recover();
      await telemetry.flush();
      console.log(
        JSON.stringify(
          {
            tool: "deploy/worker",
            command,
            environment,
            gitRevision: revision,
            workerId,
            recovery,
          },
          null,
          2,
        ),
      );
      await fabric.stop("recover-complete");
      return;
    }

    // run: the worker service process.
    console.log(
      JSON.stringify({
        tool: "deploy/worker",
        command,
        environment,
        gitRevision: revision,
        workerId,
        applicationId,
        startedAt: new Date().toISOString(),
        telemetry:
          "bounded sink composed (OTLP when ZECK_OTLP_ENDPOINT is configured; logs-only otherwise)",
        note: "worker service running; SIGTERM/SIGINT triggers the bounded graceful drain",
      }),
    );
    // The D-06 bounded flush cadence (time-based; the interval is
    // unref'd — it never holds the process open).
    const flushTimer = setInterval(() => {
      void telemetry.flush().catch(() => undefined);
    }, 5000);
    flushTimer.unref?.();
    const signal = AbortSignal.abort();
    void signal;
    const controller = new AbortController();
    const shutdown = (cause: string): void => {
      controller.abort();
      void cause;
    };
    process.once("SIGTERM", () => shutdown("sigterm"));
    process.once("SIGINT", () => shutdown("sigint"));
    await fabric.runForever(controller.signal);
    clearInterval(flushTimer);
    await telemetry.flush();
    console.log(
      JSON.stringify({
        tool: "deploy/worker",
        command: "run",
        workerId,
        stoppedAt: new Date().toISOString(),
        status: "drained",
      }),
    );
  });
}

await main().catch((error) => {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
});
