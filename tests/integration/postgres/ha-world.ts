/**
 * Real-PostgreSQL HA failover world (WORK-057 / D-08).
 *
 * Builds the REAL topology under test — a disposable local
 * PostgreSQL PRIMARY (initdb'd, migrated through the production
 * startup path) plus a REAL STANDBY bootstrapped by the operator
 * machinery (`deploy/ha.ts`: pg_backup_start → copy → pg_backup_stop
 * → standby.signal → streaming) — and seeds REAL governed work
 * through the full worker-fabric composition (the worker-world
 * precedent with DETERMINISTIC identity, so the post-failover
 * control plane rebuilds over the PROMOTED authority against the
 * SAME tenant/application and converges the ORIGINAL in-flight
 * work).
 *
 * Gating: the world requires local PostgreSQL server binaries
 * (`ZECK_HA_POSTGRES_BIN` or PATH). Without them the suites skip
 * with an explicit reason — a simulated topology is never an
 * option (honesty over silence, the WORK-002 harness convention).
 */

import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  bootstrapStandbyFromPrimary,
  type LocalHaServer,
  type PostgresBinaries,
  resolvePostgresBinaries,
  startLocalPostgresServer,
} from "../../../deploy/ha";
import {
  SqlBudgetStore,
  SqlBudgetsIdempotency,
} from "../../../src/modules/budgets/adapters/sql-budget-store";
import { createBudgetService } from "../../../src/modules/budgets/application/budget-service";
import {
  createInMemoryCatalogStore,
  SEED_CAPABILITY_FACTS,
} from "../../../src/modules/capabilities/adapters/index";
import { createCapabilityRegistry } from "../../../src/modules/capabilities/application/index";
import { createPolicyResumeAdmission } from "../../../src/modules/executions/adapters/policy-resume-admission";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import { SqlLongRunningExecutionStore } from "../../../src/modules/executions/adapters/sql-long-running-store";
import {
  createExecutionStatusReader,
  createRecoverableExecutionSource,
  createWorkerCompletionEffect,
  createWorkerDispatchStartEffect,
  createWorkerLeaseAuthority,
  envelopeSessionOf,
} from "../../../src/modules/executions/adapters/worker-fabric";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import { createLongRunningExecutionService } from "../../../src/modules/executions/application/long-running-service";
import {
  createExecutionAuthorization,
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
  type PolicyAuthority,
} from "../../../src/modules/policies/public";
import { createSandboxCapabilityGate } from "../../../src/modules/sandbox/adapters/capability-gate";
import { createSandboxExecutionLedgerAdapter } from "../../../src/modules/sandbox/adapters/execution-ledger";
import { createExecutionResumeReadmission } from "../../../src/modules/sandbox/adapters/execution-resume-readmission";
import { createPolicySandboxAdmission } from "../../../src/modules/sandbox/adapters/policy-sandbox-admission";
import { SqlSandboxStore } from "../../../src/modules/sandbox/adapters/sql-sandbox-store";
import {
  createSandboxWorkExecutor,
  workerSandboxKey,
} from "../../../src/modules/sandbox/adapters/worker-executor";
import { createEnvironmentCatalog } from "../../../src/modules/sandbox/application/environment-catalog";
import {
  createSandboxService,
  type SandboxService,
} from "../../../src/modules/sandbox/application/sandbox-service";
import { createSandboxProviderRegistry } from "../../../src/modules/sandbox/ports/sandbox-provider";
import {
  createExecutionWorkerFabric,
  type ExecutionWorkerFabric,
} from "../../../src/platform/compute/fabric";
import { SqlComputeWorkerStore } from "../../../src/platform/compute/pg-store";
import type { WorkerFabricPolicy } from "../../../src/platform/compute/port";
import type { DatabasePort } from "../../../src/platform/db/port";
import { startAuthoritativeDatabase } from "../../../src/platform/db/startup";
import { QueueCorrelationStore } from "../../../src/platform/queue/correlation";
import { DurableDispatcher } from "../../../src/platform/queue/dispatcher";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { InMemoryQueueTransport } from "./queue-world";
import {
  CONTAINER_SPEC,
  ControllableSandboxProvider,
  TEST_RETRY_POLICY,
  TEST_WORKER_POLICY,
} from "./worker-world";

export const generateId = createUuidv7Generator();
export const HA_ACTOR_ID = "00000000-0000-7000-8000-0000000000aa";
export const HA_WORKER_ACTOR_ID = "00000000-0000-7000-8000-0000000000ef";
export const HA_APPLICATION_NAME = "ha-failover-application";

/** Honest gating: real server binaries or an explicit skip. */
export function resolveHaBinaries(): PostgresBinaries | null {
  try {
    return resolvePostgresBinaries(process.env);
  } catch {
    return null;
  }
}

/** Pick `count` free TCP ports in the drill range (refused = free). */
export async function pickFreePorts(count: number): Promise<number[]> {
  const picked: number[] = [];
  let candidate = 55610 + Math.floor(Math.random() * 60);
  while (picked.length < count) {
    candidate += 1;
    if (candidate > 55700) {
      candidate = 55610;
    }
    const client = new Client({
      connectionString: `postgres://postgres@127.0.0.1:${candidate}/postgres`,
      connectionTimeoutMillis: 400,
    });
    try {
      await client.connect();
      await client.end();
    } catch {
      picked.push(candidate);
    }
  }
  return picked;
}

export interface HaTopology {
  readonly primary: LocalHaServer;
  readonly standby: LocalHaServer;
  readonly authorityDatabase: string;
  readonly primaryAuthorityUrl: string;
  readonly standbyAuthorityUrl: string;
  /** SIGKILL the primary (the unplanned-loss form). */
  losePrimary(): Promise<Date>;
  terminate(): Promise<void>;
}

/** Build the disposable real topology: primary (migrated) + standby (streaming). */
export async function startHaTopology(
  binaries: PostgresBinaries,
  options: { readonly synchronousReplication?: boolean } = {},
): Promise<HaTopology> {
  const [primaryPort, standbyPort] = await pickFreePorts(2);
  const authorityDatabase = `zeck_ha_test_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const root = `/tmp/zeck-ha-test-${randomUUID().slice(0, 8)}`;
  const primary = await startLocalPostgresServer({
    dataDir: `${root}/primary`,
    port: primaryPort as number,
    binaries,
    label: "ha-test primary",
  });
  const adminClient = new Client({ connectionString: primary.adminUrl });
  await adminClient.connect();
  try {
    await adminClient.query(`CREATE DATABASE ${authorityDatabase}`);
  } finally {
    await adminClient.end();
  }
  const primaryAuthorityUrl = primary.urlFor(authorityDatabase);
  const handle = await startAuthoritativeDatabase(primaryAuthorityUrl, {
    poolOverrides: { max: 4 },
  });
  await handle.close();
  const standby = await bootstrapStandbyFromPrimary({
    primary,
    standbyDataDir: `${root}/standby`,
    standbyPort: standbyPort as number,
    binaries,
    applicationName: "zeck_ha_standby",
  });
  if (options.synchronousReplication === true) {
    // The synchronous path: commits on the primary wait for the
    // standby's flush (AVA-002: RPO 0 where configured).
    const syncClient = new Client({ connectionString: primary.adminUrl });
    await syncClient.connect();
    try {
      await syncClient.query("ALTER SYSTEM SET synchronous_standby_names = 'zeck_ha_standby'");
      await syncClient.query("SELECT pg_reload_conf()");
    } finally {
      await syncClient.end();
    }
  }
  return {
    primary,
    standby,
    authorityDatabase,
    primaryAuthorityUrl,
    standbyAuthorityUrl: standby.urlFor(authorityDatabase),
    losePrimary: async () => {
      await primary.terminate("kill");
      return new Date();
    },
    terminate: async () => {
      await standby.terminate("stop").catch(() => undefined);
      await primary.terminate("stop").catch(() => undefined);
      standby.dispose();
      primary.dispose();
    },
  };
}

/** The deterministic-identity governed-work world (worker-world composition). */
export interface HaWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly environmentId: string;
  readonly service: ExecutionService;
  readonly sandboxService: SandboxService;
  readonly policyAuthority: PolicyAuthority;
  readonly provider: ControllableSandboxProvider;
  readonly store: SqlComputeWorkerStore;
  readonly correlation: QueueCorrelationStore;
  readonly dispatcher: DurableDispatcher;
  readonly transport: InMemoryQueueTransport;
  readonly containerEnvironmentId: string;
  readonly taskFor: (command: string) => Readonly<Record<string, unknown>>;
  createDispatchedExecution: (suffix: string) => Promise<string>;
  createFabric: (options?: { readonly workerId?: string }) => Promise<ExecutionWorkerFabric>;
  eventsOf: (executionId: string) => Promise<readonly { readonly kind: string }[]>;
  scopeOf: (executionId: string) => {
    readonly actorId: string;
    readonly applicationId: string;
    readonly tenantId: string;
    readonly executionId: string;
  };
}

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Seed/compose the governed-work world over one authority endpoint with
 * a FIXED identity: post-failover the SAME identity rebuilds over the
 * promoted authority and its recovery scan converges the ORIGINAL
 * application's in-flight executions.
 */
export async function seedHaWorld(
  db: DatabasePort,
  identity: { readonly tenantId: string; readonly applicationId: string },
): Promise<HaWorld> {
  const { tenantId, applicationId } = identity;
  const existingTenant = await db.execute<{ count: string }>({
    sql: "SELECT count(*) AS count FROM applications.tenants WHERE id = $1",
    parameters: [tenantId],
  });
  if (Number(existingTenant.rows[0]?.count ?? 0) === 0) {
    await db.execute({
      sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
      parameters: [tenantId, `t-${tenantId.slice(-6)}`, "ha tenant"],
    });
    await db.execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [applicationId, tenantId, "ha-app", HA_APPLICATION_NAME],
    });
  }
  const environmentId = `00000000-0000-7000-8000-${tenantId.slice(-12).padStart(12, "0")}`;
  const envExists = await db.execute<{ count: string }>({
    sql: "SELECT count(*) AS count FROM applications.environments WHERE id = $1",
    parameters: [environmentId],
  });
  if (Number(envExists.rows[0]?.count ?? 0) === 0) {
    await db.execute({
      sql: "INSERT INTO applications.environments (id, application_id, tenant_id, kind, name) VALUES ($1, $2, $3, $4, $5)",
      parameters: [environmentId, applicationId, tenantId, "production", "prod"],
    });
  }

  const policyStore = new InMemoryPolicyStore();
  const policyAuthority = createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher });
  await policyAuthority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });

  const executionService = createExecutionService({
    store: new SqlExecutionStore(db),
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: createExecutionAuthorization(policyAuthority),
    generateId,
    now: () => new Date(),
  });

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
    provenance: { publisher: "ha:world", publishedAt: new Date().toISOString() },
    evidence: { kind: "catalog-seeded", reference: "ha-world-container-runtime" },
  });
  const budgets = createBudgetService({
    store: new SqlBudgetStore(db),
    idempotency: new SqlBudgetsIdempotency(db, (tx) => new SqlBudgetStore(tx), generateId),
    generateId,
    now: () => new Date(),
  });

  const sandboxStore = new SqlSandboxStore(db);
  const catalog = createEnvironmentCatalog({
    store: sandboxStore,
    generateId,
    now: () => new Date(),
    hashSpec: sha256Hex,
  });
  const sandboxAdmission = createPolicySandboxAdmission(policyAuthority);
  const provider = new ControllableSandboxProvider();
  const providers = createSandboxProviderRegistry();
  providers.register(provider);
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

  const longRunning = createLongRunningExecutionService({
    executions: executionService,
    store: new SqlLongRunningExecutionStore(db),
    resumePolicyReadmission: createPolicyResumeAdmission(policyAuthority),
    resourceReadmission: createExecutionResumeReadmission(catalog, sandboxAdmission),
    digest: sha256Hex,
    generateId,
    now: () => new Date(),
  });

  const policy: WorkerFabricPolicy = { ...TEST_WORKER_POLICY };
  const computeStore = new SqlComputeWorkerStore({
    db,
    maxClaimAttempts: policy.maxClaimAttempts,
    defaultEnvironmentQuota: policy.defaultEnvironmentQuota,
    claimRetentionMs: policy.claimRetentionMs,
    generateId,
  });
  const lease = createWorkerLeaseAuthority({ service: longRunning });
  const correlation = new QueueCorrelationStore(db);
  const transport = new InMemoryQueueTransport();
  const dispatcher = new DurableDispatcher({
    store: correlation,
    transport,
    policy: TEST_RETRY_POLICY,
    generateId,
    now: () => new Date(),
    sleep: async () => undefined,
  });

  const actor = () => ({ actorId: HA_ACTOR_ID, applicationId, tenantId });
  let containerEnvironmentId = "";
  const envRegistered = await db.execute<{ count: string }>({
    sql: "SELECT count(*) AS count FROM sandbox.compute_environments WHERE application_id = $1",
    parameters: [applicationId],
  });
  if (Number(envRegistered.rows[0]?.count ?? 0) > 0) {
    const found = await db.execute<{ id: string }>({
      sql: "SELECT id FROM sandbox.compute_environments WHERE application_id = $1 ORDER BY created_at LIMIT 1",
      parameters: [applicationId],
    });
    containerEnvironmentId = found.rows[0]?.id ?? "";
  } else {
    const containerEnvironment = await catalog.register(
      {
        applicationId,
        tenantId,
        slug: "ha-container",
        name: "ha container",
        spec: CONTAINER_SPEC,
      },
      "ha-container",
      actor(),
    );
    containerEnvironmentId = containerEnvironment.id;
  }

  const taskFor = (command: string): Readonly<Record<string, unknown>> => ({
    kind: "ha-failover-test",
    sandbox: {
      environmentId: containerEnvironmentId,
      command,
      args: ["--mode", "batch"],
      publicEnv: { MODE: "batch" },
    },
  });

  const createDispatchedExecution = async (suffix: string): Promise<string> => {
    const receipt = await executionService.createExecution(
      { applicationId, environmentId, task: taskFor(`cmd-${suffix}`) },
      `create-${suffix}-${tenantId.slice(-6)}`,
      { actorId: HA_ACTOR_ID, tenantId },
    );
    const scope = { actorId: HA_ACTOR_ID, applicationId, tenantId };
    const executionId = receipt.executionId;
    for (const [command, key] of [
      ["authorize", `auth-${suffix}-${tenantId.slice(-6)}`],
      ["plan", `plan-${suffix}-${tenantId.slice(-6)}`],
      ["queue", `queue-${suffix}-${tenantId.slice(-6)}`],
    ] as const) {
      await executionService.transition({ ...scope, executionId, command }, key);
    }
    await dispatcher.dispatchExecution({ executionId, applicationId, tenantId });
    return executionId;
  };

  const createFabric = async (options?: { readonly workerId?: string }) => {
    const workerId = options?.workerId ?? generateId();
    const fabric = createExecutionWorkerFabric(
      {
        workerActorId: HA_WORKER_ACTOR_ID,
        store: new SqlComputeWorkerStore({
          db,
          maxClaimAttempts: policy.maxClaimAttempts,
          defaultEnvironmentQuota: policy.defaultEnvironmentQuota,
          claimRetentionMs: policy.claimRetentionMs,
          generateId,
        }),
        startEffect: createWorkerDispatchStartEffect({
          service: executionService,
          workerActorId: HA_WORKER_ACTOR_ID,
        }),
        lease,
        work: createSandboxWorkExecutor({
          service: sandboxService,
          leaseGuard: (applicationIdOf, executionId, claim) =>
            lease.guard(applicationIdOf, executionId, claim),
          workerActorId: HA_WORKER_ACTOR_ID,
        }),
        completion: createWorkerCompletionEffect({ service: executionService, lease }),
        correlation: envelopeSessionOf(correlation),
        transport,
        retryPolicy: TEST_RETRY_POLICY,
        recoverySource: createRecoverableExecutionSource(db),
        statusReader: createExecutionStatusReader(executionService),
        policy,
        generateId,
        now: () => new Date(),
        sleep: async () => undefined,
      },
      {
        workerId,
        applicationId,
        kind: "first-party",
        declaredConcurrency: 4,
        metadata: { world: "ha-failover" },
      },
    );
    await fabric.register();
    return fabric;
  };

  const eventsOf = async (executionId: string): Promise<readonly { readonly kind: string }[]> => {
    const result = await db.execute<{ readonly kind: string }>({
      sql: "SELECT type AS kind FROM executions.execution_events WHERE execution_id = $1 ORDER BY sequence",
      parameters: [executionId],
    });
    return result.rows;
  };

  return {
    db,
    tenantId,
    applicationId,
    environmentId,
    service: executionService,
    sandboxService,
    policyAuthority,
    provider,
    store: computeStore,
    correlation,
    dispatcher,
    transport,
    containerEnvironmentId,
    taskFor,
    createDispatchedExecution,
    createFabric,
    eventsOf,
    scopeOf: (executionId: string) => ({
      actorId: HA_ACTOR_ID,
      applicationId,
      tenantId,
      executionId,
    }),
  };
}

/** The interrupted worker's durable state (the D-07 C-matrix convention). */
export async function interruptWorkerMidFlight(
  world: HaWorld,
  executionId: string,
): Promise<{ readonly claimId: string }> {
  await world.service.transition(
    { ...world.scopeOf(executionId), command: "start", reason: "queue-transport-delivery" },
    `queue-consume:execution-dispatch:${executionId}`,
  );
  const workerId = generateId();
  await world.store.registerWorker(
    {
      workerId,
      applicationId: world.applicationId,
      kind: "first-party",
      declaredConcurrency: 4,
    },
    new Date().toISOString(),
  );
  const claim = await world.store.acquireClaim(
    {
      workerId,
      executionId,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      environmentId: world.environmentId,
      computeEnvironmentId: world.containerEnvironmentId,
    },
    new Date().toISOString(),
  );
  if (claim.outcome !== "admitted") {
    throw new Error(`claim not admitted (${JSON.stringify(claim)})`);
  }
  const claimId = claim.claim.id;
  await world.db.execute({
    sql: `UPDATE compute_plane.worker_claims
SET last_heartbeat_at = now() - interval '10 minutes'
WHERE id = $1`,
    parameters: [claimId],
  });
  return { claimId };
}

export { workerSandboxKey };
