/**
 * Shared real-PostgreSQL fixture for the D-05 worker-fabric suites
 * (WORK-046).
 *
 * Seeds the executions world (tenant + application + environment) and
 * wires the FULL governed fabric over the provider-neutral
 * DatabasePort — the production composition:
 *
 *   * executions: SqlExecutionStore + SqlExecutionsIdempotency + the
 *     execution service with the REAL policy authority behind the
 *     authorize seam, and the WORK-028 long-running service (the
 *     single lease system) behind the worker lease authority;
 *   * sandbox: the REAL admission/capability/budget/ledger adapters,
 *     the SQL store + environment catalog and a CONTROLLABLE provider
 *     double (configurable outcome, blocking, call recording) — the
 *     process/container substrates are protocol-tested separately;
 *   * the D-05 compute plane: the SQL compute-plane store, the
 *     executions-module start/lease/completion/status/recovery
 *     adapters, the sandbox-module work executor, the D-03
 *     correlation store session, the in-memory at-least-once queue
 *     transport and the durable dispatcher;
 *   * `createFabric(workerId)`: fresh fabric instances per test —
 *     two-worker races, crash/restart re-selection and stale fencing
 *     drive multiple instances against the same durable state.
 *
 * Executions are created with worker-executable tasks (`sandbox`
 * blocks) and driven through the REAL governed lifecycle (create →
 * authorize → plan → queue → dispatch) — the existing single write
 * path, untouched.
 */

import { createHash } from "node:crypto";
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
import type { ComputeEnvironmentSpec } from "../../../src/modules/sandbox/domain/environment";
import type {
  SandboxExecutionObservation,
  SandboxProvider,
  SandboxRuntimeSpec,
} from "../../../src/modules/sandbox/ports/sandbox-provider";
import { createSandboxProviderRegistry } from "../../../src/modules/sandbox/ports/sandbox-provider";
import { loadWorkerPolicy } from "../../../src/platform/compute/config";
import {
  type ConsumeReport,
  createExecutionWorkerFabric,
  type ExecutionWorkerFabric,
  type RecoveryReport,
} from "../../../src/platform/compute/fabric";
import { SqlComputeWorkerStore } from "../../../src/platform/compute/pg-store";
import type { WorkerFabricPolicy, WorkerLeaseAuthority } from "../../../src/platform/compute/port";
import type { DatabasePort } from "../../../src/platform/db/port";
import { QueueCorrelationStore } from "../../../src/platform/queue/correlation";
import { DurableDispatcher } from "../../../src/platform/queue/dispatcher";
import type { QueueRetryPolicy } from "../../../src/platform/queue/port";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { InMemoryQueueTransport } from "./queue-world";

export const generateId = createUuidv7Generator();
export const ACTOR_ID = "00000000-0000-7000-8000-0000000000aa";
export const WORKER_ACTOR_ID = "00000000-0000-7000-8000-0000000000ef";

export const TEST_RETRY_POLICY: QueueRetryPolicy = Object.freeze({
  maxPublishAttempts: 3,
  maxDeliveryAttempts: 3,
  maxReplays: 3,
  retryBackoffMs: 0,
});

/** The worker-fabric policy tuned for deterministic tests. */
export const TEST_WORKER_POLICY: WorkerFabricPolicy = Object.freeze({
  ...loadWorkerPolicy({}),
  leaseTtlMs: 2_000,
  heartbeatIntervalMs: 500,
  claimVisibilityMs: 2_000,
  workerStaleAfterMs: 1_500,
  maxDrainMs: 2_000,
  batchSize: 4,
});

export const CONTAINER_SPEC: ComputeEnvironmentSpec = {
  kind: "container",
  limits: { cpuMilliCores: 1000, memoryMiB: 256, executionTimeoutMs: 30_000 },
  network: { egress: "allowlist", allowedHosts: ["api.example.com"] },
  filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: { capabilityId: "container-runtime" },
  cost: { estimatedCostMicroUsd: "0" },
};

export const PROCESS_SPEC: ComputeEnvironmentSpec = {
  kind: "process",
  limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
  network: { egress: "none", allowedHosts: [] },
  filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: { capabilityId: "process-sandbox" },
  cost: { estimatedCostMicroUsd: "0" },
};

/** The worker-executable task contract (the `sandbox` block). */
export const SANDBOX_TASK = (command: string): Readonly<Record<string, unknown>> => ({
  kind: "worker-fabric-test",
  sandbox: {
    environmentId: "RESOLVED_AT_REGISTER",
    command,
    args: ["--mode", "batch"],
    publicEnv: { MODE: "batch" },
  },
});

/** One provider call as recorded by the double. */
export interface ProviderCallEvent {
  readonly at: number;
  readonly sandboxId: string;
  readonly command: string;
  readonly signalAborted: boolean;
}

/**
 * The controllable sandbox provider double: every dispatch is
 * recorded; the observation is configurable; the execution can BLOCK
 * until the test releases it (cooperative-interruption and drain
 * proofs); the double honors the AbortSignal by recording it.
 */
export class ControllableSandboxProvider implements SandboxProvider {
  readonly runtimeKind = "container" as const;
  private readonly events: ProviderCallEvent[] = [];
  private counter = 0;
  private outcome: SandboxExecutionObservation = {
    outcomeClass: "sandbox-success",
    outputDigest: "a".repeat(64),
    output: { exitCode: 0, stdout: "ok", stderr: "", durationMs: 12 },
    usageMicroUsd: "0",
    failure: null,
  };
  private blockedCount = 0;
  private blockedResolvers: (() => void)[] = [];

  async execute(spec: SandboxRuntimeSpec): Promise<SandboxExecutionObservation> {
    this.events.push({
      at: ++this.counter,
      sandboxId: spec.sandboxId,
      command: spec.task.command,
      signalAborted: false,
    });
    if (this.blockedCount > 0) {
      this.blockedCount -= 1;
      await new Promise<void>((resolve) => {
        this.blockedResolvers.push(resolve);
      });
    }
    return this.outcome;
  }

  /** Configure the next observations' outcome. */
  setOutcome(outcome: SandboxExecutionObservation): void {
    this.outcome = outcome;
  }

  /** Make the NEXT N executions block until released. */
  blockNext(count: number): void {
    this.blockedCount += count;
  }

  /** Make the NEXT N executions block for a bounded duration (ms). */
  blockNextFor(count: number, ms: number): void {
    for (let i = 0; i < count; i += 1) {
      this.blockedCount += 1;
      setTimeout(() => {
        if (this.blockedCount > 0) {
          this.blockedCount -= 1;
        }
        this.releaseOne();
      }, ms);
    }
  }

  /** Release ONE blocked execution (if any). */
  releaseOne(): void {
    const resolve = this.blockedResolvers.shift();
    resolve?.();
  }

  /** Release all blocked executions. */
  releaseBlocked(): void {
    const resolvers = this.blockedResolvers;
    this.blockedResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }

  /** The ordered dispatch record. */
  callLog(): readonly ProviderCallEvent[] {
    return this.events;
  }

  /** How many dispatches reached the provider. */
  dispatchCount(): number {
    return this.events.length;
  }
}

export interface WorkerFabricWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly environmentId: string;
  readonly service: ExecutionService;
  readonly sandboxService: SandboxService;
  readonly policyAuthority: PolicyAuthority;
  readonly provider: ControllableSandboxProvider;
  readonly store: SqlComputeWorkerStore;
  readonly lease: WorkerLeaseAuthority;
  readonly transport: InMemoryQueueTransport;
  readonly dispatcher: DurableDispatcher;
  readonly correlation: QueueCorrelationStore;
  readonly containerEnvironmentId: string;
  readonly processEnvironmentId: string;
  readonly policy: WorkerFabricPolicy;
  /** A worker-executable task bound to the registered container environment. */
  taskFor: (command: string) => Readonly<Record<string, unknown>>;
  /** Create + drive one execution through the REAL lifecycle to QUEUED + dispatch. */
  createDispatchedExecution: (
    suffix: string,
    task?: Readonly<Record<string, unknown>>,
  ) => Promise<string>;
  /** A fresh fabric with its own worker identity (tests drive 1..N). */
  createFabric: (options?: {
    readonly workerId?: string;
    readonly declaredConcurrency?: number;
    readonly kind?: "first-party" | "customer-runner";
    readonly runnerId?: string;
    readonly policy?: Partial<WorkerFabricPolicy>;
    readonly sleep?: (ms: number) => Promise<void>;
  }) => Promise<ExecutionWorkerFabric>;
  /** The ledger events of one execution (provenance proofs). */
  eventsOf: (executionId: string) => Promise<readonly { readonly kind: string }[]>;
  /** The live claim of one execution (or null). */
  liveClaimOf: (
    executionId: string,
  ) => Promise<import("../../../src/platform/compute/port").WorkerClaimRecord | null>;
  scopeOf: (executionId: string) => {
    readonly actorId: string;
    readonly applicationId: string;
    readonly tenantId: string;
    readonly executionId: string;
  };
}

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export interface WorkerFabricWorldOptions {
  /**
   * Replace the container-kind substrate. The controllable provider
   * double is the default (the process/container substrates are
   * protocol-tested separately); the external-run-identity regression
   * (worker-external-run-identity.test.ts) wires the REAL
   * `ContainerSandboxProvider` + the REAL container runtime client
   * over a real in-process HTTP runner here.
   */
  readonly containerProvider?: SandboxProvider;
}

export async function seedWorkerFabricWorld(
  db: DatabasePort,
  options?: WorkerFabricWorldOptions,
): Promise<WorkerFabricWorld> {
  const tenantId = generateId();
  const applicationId = generateId();
  const environmentId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "worker tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "worker app"],
  });
  await db.execute({
    sql: "INSERT INTO applications.environments (id, application_id, tenant_id, kind, name) VALUES ($1, $2, $3, $4, $5)",
    parameters: [environmentId, applicationId, tenantId, "production", "prod"],
  });

  // Policies: the REAL authority behind BOTH admission seams.
  const policyStore = new InMemoryPolicyStore();
  const policyAuthority = createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher });
  await policyAuthority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });

  // Executions: the frozen service + the WORK-028 lease system.
  const executionService = createExecutionService({
    store: new SqlExecutionStore(db),
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: createExecutionAuthorization(policyAuthority),
    generateId,
    now: () => new Date(),
  });

  // Capabilities + budgets: the REAL authorities.
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
    provenance: { publisher: "worker:world", publishedAt: new Date().toISOString() },
    evidence: { kind: "catalog-seeded", reference: "worker-world-container-runtime" },
  });
  const budgets = createBudgetService({
    store: new SqlBudgetStore(db),
    idempotency: new SqlBudgetsIdempotency(db, (tx) => new SqlBudgetStore(tx), generateId),
    generateId,
    now: () => new Date(),
  });

  // Sandbox: the SQL store + catalog + service + the controllable provider.
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
  if (options?.containerProvider !== undefined) {
    // The explicit substrate replaces the container-kind entry (the
    // registry is keyed by runtime kind; the last registration wins).
    providers.register(options.containerProvider);
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

  const longRunning = createLongRunningExecutionService({
    executions: executionService,
    store: new SqlLongRunningExecutionStore(db),
    resumePolicyReadmission: createPolicyResumeAdmission(policyAuthority),
    resourceReadmission: createExecutionResumeReadmission(catalog, sandboxAdmission),
    digest: sha256Hex,
    generateId,
    now: () => new Date(),
  });

  // The compute plane.
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

  // Register the compute environments (container = the quota dimension
  // under test; process = the second environment for quota proofs).
  const actor = () => ({ actorId: ACTOR_ID, applicationId, tenantId });
  const containerEnvironment = await catalog.register(
    {
      applicationId,
      tenantId,
      slug: "worker-container",
      name: "worker container",
      spec: CONTAINER_SPEC,
    },
    "worker-container",
    actor(),
  );
  const processEnvironment = await catalog.register(
    { applicationId, tenantId, slug: "worker-process", name: "worker process", spec: PROCESS_SPEC },
    "worker-process",
    actor(),
  );

  const taskFor = (command: string): Readonly<Record<string, unknown>> => ({
    kind: "worker-fabric-test",
    sandbox: {
      environmentId: containerEnvironment.id,
      command,
      args: ["--mode", "batch"],
      publicEnv: { MODE: "batch" },
    },
  });

  const createDispatchedExecution = async (
    suffix: string,
    task?: Readonly<Record<string, unknown>>,
  ): Promise<string> => {
    const receipt = await executionService.createExecution(
      { applicationId, environmentId, task: task ?? taskFor(`cmd-${suffix}`) },
      `create-${suffix}`,
      { actorId: ACTOR_ID, tenantId },
    );
    const scope = { actorId: ACTOR_ID, applicationId, tenantId };
    const executionId = receipt.executionId;
    for (const [command, key] of [
      ["authorize", `auth-${suffix}`],
      ["plan", `plan-${suffix}`],
      ["queue", `queue-${suffix}`],
    ] as const) {
      await executionService.transition({ ...scope, executionId, command }, key);
    }
    await dispatcher.dispatchExecution({ executionId, applicationId, tenantId });
    return executionId;
  };

  const createFabric = async (options?: {
    readonly workerId?: string;
    readonly declaredConcurrency?: number;
    readonly kind?: "first-party" | "customer-runner";
    readonly runnerId?: string;
    readonly policy?: Partial<WorkerFabricPolicy>;
    readonly sleep?: (ms: number) => Promise<void>;
  }): Promise<ExecutionWorkerFabric> => {
    const fabricPolicy: WorkerFabricPolicy = { ...policy, ...(options?.policy ?? {}) };
    const workerId = options?.workerId ?? generateId();
    const fabric = createExecutionWorkerFabric(
      {
        workerActorId: WORKER_ACTOR_ID,
        store: new SqlComputeWorkerStore({
          db,
          maxClaimAttempts: fabricPolicy.maxClaimAttempts,
          defaultEnvironmentQuota: fabricPolicy.defaultEnvironmentQuota,
          claimRetentionMs: fabricPolicy.claimRetentionMs,
          generateId,
        }),
        startEffect: createWorkerDispatchStartEffect({
          service: executionService,
          workerActorId: WORKER_ACTOR_ID,
        }),
        lease,
        work: createSandboxWorkExecutor({
          service: sandboxService,
          leaseGuard: (applicationIdOf, executionId, claim) =>
            lease.guard(applicationIdOf, executionId, claim),
          workerActorId: WORKER_ACTOR_ID,
        }),
        completion: createWorkerCompletionEffect({ service: executionService, lease }),
        correlation: envelopeSessionOf(correlation),
        transport,
        retryPolicy: TEST_RETRY_POLICY,
        recoverySource: createRecoverableExecutionSource(db),
        statusReader: createExecutionStatusReader(executionService),
        policy: fabricPolicy,
        generateId,
        now: () => new Date(),
        ...(options?.sleep === undefined ? {} : { sleep: options.sleep }),
      },
      {
        workerId,
        applicationId,
        kind: options?.kind ?? "first-party",
        ...(options?.runnerId === undefined ? {} : { runnerId: options.runnerId }),
        declaredConcurrency: options?.declaredConcurrency ?? 4,
        metadata: { world: "worker-fabric" },
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

  const liveClaimOf = async (
    executionId: string,
  ): Promise<Awaited<ReturnType<typeof computeStore.getClaim>>> => {
    const claims = await computeStore.listClaimsByExecution(executionId);
    return claims.find((claim) => claim.status === "claimed") ?? null;
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
    lease,
    transport,
    dispatcher,
    correlation,
    containerEnvironmentId: containerEnvironment.id,
    processEnvironmentId: processEnvironment.id,
    policy,
    taskFor,
    createDispatchedExecution,
    createFabric,
    eventsOf,
    liveClaimOf,
    scopeOf: (executionId: string) => ({
      actorId: ACTOR_ID,
      applicationId,
      tenantId,
      executionId,
    }),
  };
}

/** Report shape aliases for test readability. */
export type { ConsumeReport, RecoveryReport };
export { workerSandboxKey };
