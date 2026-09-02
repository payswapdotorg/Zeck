/**
 * Shared real-PostgreSQL fixture for the training/batch/accelerator
 * suites (WORK-030).
 *
 * Seeds a tenant + application and wires the FULL governed training
 * fabric over the provider-neutral DatabasePort — the production
 * composition over the REAL authorities (the crash-recovery standard
 * of `longrunning-world.ts`, applied to the training axis):
 *
 *   * executions: SqlExecutionStore + SqlExecutionsIdempotency + the
 *     execution service, with the REAL policy authority behind the
 *     authorize seam — the canonical EventEnvelope ledger the training
 *     provenance rides (step events through
 *     `createTrainingExecutionLedgerAdapter`);
 *   * policies: the REAL authority (in-memory definitions + node
 *     hasher) behind the training admission seam
 *     (`createPolicyTrainingAdmission`);
 *   * capabilities: the REAL capability registry (in-memory catalog +
 *     platform seeds) + the REAL substrate registry
 *     (SqlSubstrateStore, migration 0017) — the ONE claim authority;
 *     the accelerator substrate is published through the REAL
 *     accelerators integration's operator path
 *     (`createAcceleratorOperator` — the substrate-federation
 *     discipline: the fabric declares NEUTRAL claims, the registry is
 *     the authority);
 *   * budgets: the REAL budgets service (SQL reservations, keyed
 *     idempotency) with configurable funding behind the training
 *     budget-authority seam (reserve BEFORE paid allocation, settle on
 *     completion, release on failure/cancellation);
 *   * training: SqlTrainingStore (migration 0025) + the governed
 *     training service with the REAL admission/substrate-catalog/
 *     capability-gate/ledger adapters;
 *   * accelerators: the REAL simulated accelerator fleet + runtime
 *     adapter behind the runtime registry, wrapped by a TEST-side
 *     output-materializing seam that publishes the run's output
 *     descriptor into the REAL artifacts service (content-addressed
 *     identity in the tenant namespace — the release-verification
 *     target is therefore a REAL artifact, not a fabricated digest);
 *   * verification: the REAL verification service (SQL store +
 *     deterministic evaluator bank + scripted model judge + the
 *     execution ledger/transition adapters + the artifact target
 *     resolver over the same artifacts service) behind
 *     `createVerificationTrainingGate` — the ONLY release authority;
 *   * the process-restart crash primitive: `boot(point)` re-boots the
 *     training service over the SURVIVING world (the SQL training
 *     store, the frozen executions module, the budgets service, the
 *     fleet's keyed idempotency ledger, the verification store all
 *     persist across a Zeck process death); a `point` arms ONE
 *     durable-boundary crash (a method on the training store, the
 *     executions service, the budgets service or the verification
 *     service, before/after its durable commit) that kills the booted
 *     process mid-flight.
 */

import { createHash } from "node:crypto";
import { expect } from "vitest";
import {
  createAcceleratorOperator,
  createAcceleratorSubstrateRuntime,
  SimulatedAcceleratorFleet,
  type SimulatedAcceleratorFleetOptions,
} from "../../../src/integrations/accelerators/public";
import {
  type ArtifactService,
  createArtifactService,
  createInMemoryArtifactStore,
  createNodeDigestPort,
} from "../../../src/modules/artifacts/public";
import {
  SqlBudgetStore,
  SqlBudgetsIdempotency,
} from "../../../src/modules/budgets/adapters/sql-budget-store";
import type { BudgetService } from "../../../src/modules/budgets/application/budget-service";
import { createBudgetService } from "../../../src/modules/budgets/application/budget-service";
import { createInMemoryCatalogStore } from "../../../src/modules/capabilities/adapters/in-memory-catalog-store";
import { SEED_CAPABILITY_FACTS } from "../../../src/modules/capabilities/adapters/seed-catalog";
import { SqlSubstrateStore } from "../../../src/modules/capabilities/adapters/sql-substrate-store";
import { createCapabilityRegistry } from "../../../src/modules/capabilities/application/capability-registry";
import { createSubstrateRegistry } from "../../../src/modules/capabilities/application/substrate-registry";
import type { CapabilityRegistry } from "../../../src/modules/capabilities/ports/capability-registry";
import type { ComputationalSubstrateInput } from "../../../src/modules/capabilities/public";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import {
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
  type PolicyAuthority,
} from "../../../src/modules/policies/public";
import { createSandboxCapabilityGate } from "../../../src/modules/sandbox/adapters/capability-gate";
import { createPolicyTrainingAdmission } from "../../../src/modules/sandbox/adapters/policy-training-admission";
import { SqlTrainingStore } from "../../../src/modules/sandbox/adapters/sql-training-store";
import { createSubstrateCatalogAdapter } from "../../../src/modules/sandbox/adapters/substrate-catalog";
import { createTrainingExecutionLedgerAdapter } from "../../../src/modules/sandbox/adapters/training-execution-ledger";
import { createVerificationTrainingGate } from "../../../src/modules/sandbox/adapters/verification-training-gate";
import type { SandboxTask } from "../../../src/modules/sandbox/domain/sandbox";
import type { TrainingWorkloadSpec } from "../../../src/modules/sandbox/domain/workload";
import type { AcceleratorSubstrateRuntime } from "../../../src/modules/sandbox/ports/accelerator-substrate";
import {
  createAcceleratorRuntimeRegistry,
  createTrainingService,
  type TrainingService,
} from "../../../src/modules/sandbox/public";
import { createDeterministicEvaluatorBank } from "../../../src/modules/verification/adapters/deterministic-evaluators";
import {
  createExecutionLedgerAdapter,
  createExecutionTransitionAdapter,
} from "../../../src/modules/verification/adapters/execution-ledger";
import { createModelJudgeEvaluator } from "../../../src/modules/verification/adapters/model-judge-evaluator";
import { createPolicyVerificationAdmission } from "../../../src/modules/verification/adapters/policy-verification-admission";
import { SqlVerificationStore } from "../../../src/modules/verification/adapters/sql-verification-store";
import {
  createArtifactTargetResolver,
  createPlanRevisionResolver,
} from "../../../src/modules/verification/adapters/target-resolvers";
import {
  createVerificationService,
  type VerificationService,
} from "../../../src/modules/verification/application/verification-service";
import type { ModelJudgment } from "../../../src/modules/verification/ports/model-judge";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const TRA_ACTOR_ID = "00000000-0000-7000-8000-00000000aaa1";

/** The simulated process death (never a typed service error). */
export class ProcessCrashError extends Error {
  constructor(point: string) {
    super(`simulated process crash at ${point}`);
    this.name = "ProcessCrashError";
  }
}

/** One armed durable-boundary crash point (per booted process). */
export interface TrainingCrashPoint {
  readonly target: "store" | "executions" | "budgets" | "verification";
  readonly method: string;
  readonly when: "before" | "after";
  /** Fire on the Nth invocation within THIS process (default 1). */
  readonly occurrence?: number;
}

/**
 * The controllable world clock (lease expiry without wall-clock waits):
 * real wall time plus an advance-able offset, so cross-table timestamp
 * ordering witnesses stay meaningful while lease-lapse proofs can jump
 * the clock forward deterministically.
 */
export class TrainingClock {
  private offset = 0;
  now(): Date {
    return new Date(Date.now() + this.offset);
  }
  advance(ms: number): void {
    this.offset += ms;
  }
}

/**
 * Wrap one durable seam so the booted process dies at the planned point
 * (`before` = the durable commit did not happen; `after` = it did).
 */
function crashableSeam<T extends object>(
  target: T,
  label: string,
  point: TrainingCrashPoint | null,
) {
  let fired = false;
  if (point === null || point.target !== label) {
    return { proxy: target, crashed: () => fired };
  }
  const seen = new Map<string, number>();
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (typeof prop !== "string") {
        return Reflect.get(t, prop, t);
      }
      const value = Reflect.get(t, prop, t);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        const invocations = (seen.get(prop) ?? 0) + 1;
        seen.set(prop, invocations);
        const matches = prop === point.method && (point.occurrence ?? 1) === invocations;
        const die = (phase: "before" | "after") => {
          if (matches && point.when === phase) {
            fired = true;
            throw new ProcessCrashError(`${label}.${prop}#${invocations}:${phase}`);
          }
        };
        die("before");
        const result = (value as (...a: unknown[]) => unknown).apply(t, args);
        if (result instanceof Promise) {
          return result.then((resolved) => {
            die("after");
            return resolved;
          });
        }
        die("after");
        return result;
      };
    },
  });
  return { proxy, crashed: () => fired };
}

/** The scripted model judge (the transport fake behind the judge port). */
export class ScriptedModelJudge {
  judgment: (request: unknown) => ModelJudgment;
  readonly requests: unknown[] = [];

  constructor() {
    this.judgment = () => ({
      criterionId: "",
      meetsCriteria: "unknown",
      rationale: "scripted",
      judgeIdentity: {},
    });
  }

  async judge(request: unknown): Promise<ModelJudgment> {
    this.requests.push(request);
    return this.judgment(request);
  }
}

/** The world's neutral GPU inventory (the simulated fabric's devices). */
export const TRA_GPU_INVENTORY = Array.from({ length: 8 }, () => ({
  deviceClass: "gpu",
  memoryMiB: 32_768,
  computeUnits: 100,
  fabricAttached: true,
}));

/** The canonical governed training workload spec of the world. */
export function trainingSpecOf(
  overrides: Partial<TrainingWorkloadSpec> = {},
): TrainingWorkloadSpec {
  return {
    workloadKind: "training",
    task: { command: "train", args: ["--epochs", "3"], publicEnv: {} },
    resource: {
      accelerator: {
        acceleratorClass: "gpu",
        deviceCount: 2,
        perDeviceMemoryMiB: 16_384,
        interconnect: "interconnect-fabric",
      },
      replicaCount: 1,
      cpuMilliCores: 2000,
      memoryMiB: 4096,
      estimatedDurationMs: 3_600_000,
      estimatedCostMicroUsd: "250000",
    },
    lineage: {
      datasetRefs: ["dataset:corpus-pg-1"],
      codeRefs: ["code:trainer-pg-1"],
      configRefs: ["config:hparams-pg-1"],
      checkpointRefs: [],
      parentOutputRefs: [],
    },
    checkpointIntervalSteps: 4,
    maxRetryAttempts: 2,
    ...overrides,
  };
}

export interface TrainingPgWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly clock: TrainingClock;
  readonly store: SqlTrainingStore;
  readonly executionService: ExecutionService;
  readonly budgets: BudgetService;
  readonly policyAuthority: PolicyAuthority;
  readonly capabilityRegistry: CapabilityRegistry;
  readonly artifacts: ArtifactService;
  readonly verificationService: VerificationService;
  readonly modelJudge: ScriptedModelJudge;
  readonly fleet: SimulatedAcceleratorFleet;
  readonly fabricId: string;
  /** Boot (or re-boot) the training service over the SURVIVING world. */
  readonly boot: (point?: TrainingCrashPoint | null) => {
    readonly service: TrainingService;
    readonly crashed: () => boolean;
  };
  readonly actor: () => { actorId: string; applicationId: string; tenantId: string };
  /** Drive one execution through the frozen lifecycle to RUNNING. */
  seedExecution(status?: string): Promise<string>;
  /** Fund the application's budget (the REAL budgets module). */
  fundApplication(amountMicroUsd?: string): Promise<void>;
  /** Declare the training release criteria (the REAL verification module). */
  declareReleaseCriteria(): Promise<void>;
}

export async function seedTrainingWorld(
  db: DatabasePort,
  fleetOptions: Pick<SimulatedAcceleratorFleetOptions, "failRunsOf"> = {},
): Promise<TrainingPgWorld> {
  const generateId = createUuidv7Generator();
  const clock = new TrainingClock();
  const now = () => clock.now();
  const tenantId = generateId();
  const applicationId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "training tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "training app"],
  });

  // Policies: the REAL authority behind BOTH the executions authorize
  // seam and the training admission seam. A BASELINE permissive set is
  // published (deny-by-default otherwise); tests publish restricted v2
  // sets for the denial proofs.
  const policyStore = new InMemoryPolicyStore();
  const authority = createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher });
  await authority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });

  // Executions: full SQL fabric, policy-gated authorize — the canonical
  // ledger the training provenance rides.
  const executionService = createExecutionService({
    store: new SqlExecutionStore(db),
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: (
      await import("../../../src/modules/policies/public")
    ).createExecutionAuthorization(authority),
    generateId,
    now,
  });

  // Capabilities: the REAL registry + the REAL substrate store — the
  // ONE claim authority the accelerator substrate publishes through
  // (the accelerators integration's operator path).
  const capabilityRegistry = await createCapabilityRegistry({
    store: createInMemoryCatalogStore(),
    seed: [...SEED_CAPABILITY_FACTS],
  });
  const substrateRegistry = createSubstrateRegistry({
    store: new SqlSubstrateStore(db),
    registry: capabilityRegistry,
    digest: sha256Hex,
    generateId,
    now,
  });

  // The simulated accelerator fleet (the REAL accelerators integration
  // adapter — external-substrate behavior UNVERIFIED, in-tree declared).
  const fabricId = "pg-fabric";
  const fleet = new SimulatedAcceleratorFleet(fabricId, TRA_GPU_INVENTORY, {
    now,
    generateId,
    ...fleetOptions,
  });
  // The operator path publishes the fabric's NEUTRAL substrate claim
  // into the REAL registry (the substrate-federation discipline).
  const operator = createAcceleratorOperator(fleet, "gpu", {
    version: "1.0.0",
    estimatedCostMicroUsd: "1000",
  });
  const actor = () => ({ actorId: TRA_ACTOR_ID, applicationId, tenantId });
  for (const submission of await operator.listSubstrates(applicationId)) {
    await substrateRegistry.publish(submission.substrate as ComputationalSubstrateInput, {
      actorId: TRA_ACTOR_ID,
      applicationId,
      tenantId,
    });
  }

  // Budgets: the REAL service (funding configured by the caller).
  const budgets = createBudgetService({
    store: new SqlBudgetStore(db),
    idempotency: new SqlBudgetsIdempotency(db, (tx) => new SqlBudgetStore(tx), generateId),
    generateId,
    now,
  });

  // Artifacts: the REAL service (content-addressed identity) — the
  // release-verification target authority.
  const artifacts = createArtifactService({
    store: createInMemoryArtifactStore(),
    digest: createNodeDigestPort(),
  });

  // Verification: the REAL service over the SQL store, the REAL
  // deterministic evaluator bank + a scripted model judge, the REAL
  // execution ledger/transition adapters and the artifact target
  // resolver over the same artifacts service.
  const modelJudge = new ScriptedModelJudge();
  const verificationService = createVerificationService({
    store: new SqlVerificationStore(db),
    admission: createPolicyVerificationAdmission(authority),
    ledger: createExecutionLedgerAdapter(executionService),
    transitions: createExecutionTransitionAdapter(executionService),
    replanning: {
      onVerificationOutcome: async () => ({ decision: "replan", detail: "test boundary" }),
    },
    evaluators: [
      ...createDeterministicEvaluatorBank(),
      createModelJudgeEvaluator({
        judge: async (request) => modelJudge.judge(request),
      }),
    ],
    resolvers: {
      artifact: createArtifactTargetResolver(artifacts),
      "plan-revision": createPlanRevisionResolver(executionService),
    },
    generateId,
    now,
    hashInput: (text) => createNodeDigestPort().sha256Hex(`verification:${text}`),
  });

  const store = new SqlTrainingStore(db);

  /**
   * The TEST-side output-materializing runtime: wraps the REAL
   * accelerators runtime and publishes the run's output descriptor as
   * a REAL content-addressed artifact in the tenant namespace, so the
   * release-verification target resolves through the REAL artifacts
   * authority (the substrate→artifact handoff the composition root
   * owns in production; simulated here exactly like the substrate).
   */
  const materializingRuntime = (
    runtime: AcceleratorSubstrateRuntime,
  ): AcceleratorSubstrateRuntime => ({
    adapterRef: runtime.adapterRef,
    async allocate(request, allocationKey, context) {
      return runtime.allocate(request, allocationKey, context);
    },
    async release(allocationKey) {
      return runtime.release(allocationKey);
    },
    async run(spec, runKey) {
      const observation = await runtime.run(spec, runKey);
      if (observation.output === null) {
        return observation;
      }
      const put = await artifacts.putArtifact({
        tenantId,
        kind: "task-output",
        payload: {
          substrateContentDigest: observation.output.contentDigest,
          workloadKey: spec.workloadKey,
          attempt: spec.attempt,
          descriptor: observation.output.descriptor,
        },
        parents: [],
        sourceRefs: [
          ...(spec.lineageRefs.datasetRefs ?? []),
          ...(spec.lineageRefs.codeRefs ?? []),
          ...(spec.lineageRefs.configRefs ?? []),
        ].map((ref) => ({ kind: "source" as const, id: ref, locator: "training-lineage" })),
      });
      return {
        ...observation,
        output: { contentDigest: put.record.digest, descriptor: observation.output.descriptor },
      };
    },
  });

  const runtimes = createAcceleratorRuntimeRegistry();
  runtimes.register(materializingRuntime(createAcceleratorSubstrateRuntime(fleet)));

  const substrates = createSubstrateCatalogAdapter(substrateRegistry);
  const capabilities = createSandboxCapabilityGate(capabilityRegistry);
  const admission = createPolicyTrainingAdmission(authority, {
    substrateIsolation: "container",
  });

  const boot = (point: TrainingCrashPoint | null = null) => {
    // A NEW training service instance over the SURVIVING SQL store +
    // the frozen executions/budgets/verification authorities (the
    // process-local composition of the durable modules), wrapped by
    // the injector. The instance carries a FRESH worker identity
    // (the lease's mutual exclusion across processes: concurrent
    // processes driving the same workload contend — one owns the run,
    // the others fail closed typed).
    const storeProcess = crashableSeam(store, "store", point);
    const executionsProcess = crashableSeam(executionService, "executions", point);
    const budgetsProcess = crashableSeam(budgets, "budgets", point);
    const verificationProcess = crashableSeam(verificationService, "verification", point);
    const service = createTrainingService({
      store: storeProcess.proxy,
      admission,
      substrates,
      capabilities,
      budgetAuthority: budgetsProcess.proxy,
      ledger: createTrainingExecutionLedgerAdapter(executionsProcess.proxy),
      runtimes,
      verification: createVerificationTrainingGate(verificationProcess.proxy),
      digest: sha256Hex,
      generateId,
      now,
      leaseDurationMs: 60_000,
      workerInstanceId: generateId(),
    });
    return {
      service,
      crashed: () =>
        storeProcess.crashed() ||
        executionsProcess.crashed() ||
        budgetsProcess.crashed() ||
        verificationProcess.crashed(),
    };
  };

  const world: TrainingPgWorld = {
    db,
    tenantId,
    applicationId,
    clock,
    store,
    executionService,
    budgets,
    policyAuthority: authority,
    capabilityRegistry,
    artifacts,
    verificationService,
    modelJudge,
    fleet,
    fabricId,
    boot,
    actor,
    async seedExecution(status = "RUNNING") {
      const receipt = await executionService.createExecution(
        { applicationId, task: { kind: "run-program", input: "artifact-1" } },
        `create-${generateId()}`,
        { actorId: TRA_ACTOR_ID, tenantId },
      );
      const executionId = receipt.executionId;
      if (status !== "CREATED") {
        await executionService.transition(
          { command: "authorize", actorId: TRA_ACTOR_ID, applicationId, tenantId, executionId },
          `authorize-${generateId()}`,
        );
        if (status !== "AUTHORIZED") {
          await executionService.transition(
            { command: "plan", actorId: TRA_ACTOR_ID, applicationId, tenantId, executionId },
            `plan-${generateId()}`,
          );
          await executionService.transition(
            { command: "queue", actorId: TRA_ACTOR_ID, applicationId, tenantId, executionId },
            `queue-${generateId()}`,
          );
          if (status === "RUNNING") {
            await executionService.transition(
              { command: "start", actorId: TRA_ACTOR_ID, applicationId, tenantId, executionId },
              `start-${generateId()}`,
            );
          }
          if (status === "CANCELLED") {
            await executionService.transition(
              { command: "start", actorId: TRA_ACTOR_ID, applicationId, tenantId, executionId },
              `start-${generateId()}`,
            );
            await executionService.transition(
              { command: "cancel", actorId: TRA_ACTOR_ID, applicationId, tenantId, executionId },
              `cancel-${generateId()}`,
            );
          }
        }
      }
      return executionId;
    },
    async fundApplication(amountMicroUsd = "1000000000") {
      await budgets.configureFundingMode(
        { ...actor(), fundingMode: "developer" },
        `fund-${applicationId}:mode`,
      );
      await budgets.grantCredits(
        { ...actor(), ownerKind: "developer", amountMicroUsd },
        `fund-${applicationId}:credits`,
      );
    },
    async declareReleaseCriteria() {
      await verificationService.declareCriteria({
        applicationId,
        tenantId,
        criteria: {
          criterionId: "training-output-lineage",
          version: 1,
          kind: "schema",
          required: true,
          description: "the training output artifact carries its workload lineage facts",
          definition: {
            fields: [
              { name: "workloadId", type: "string", required: true },
              { name: "workloadKey", type: "string", required: true },
              { name: "outputArtifactDigest", type: "string", required: true },
            ],
          },
        },
      });
    },
  };
  return world;
}

/**
 * Run one operation in a DYING process: the armed crash point kills it
 * mid-flight (the promise's terminal state is irrelevant — the process is
 * gone; only the durable world matters).
 */
export async function diesDuring(
  run: () => Promise<unknown>,
  crashed: () => boolean,
): Promise<void> {
  await run().then(
    () => undefined,
    () => undefined,
  );
  expect(crashed()).toBe(true);
}

/** Query one row of a training extension table (proof assertions). */
export async function one<T = Record<string, unknown>>(
  db: DatabasePort,
  sql: string,
  parameters: readonly unknown[],
): Promise<T | null> {
  const result = await db.execute<T>({ sql, parameters });
  return result.rows.length > 0 ? (result.rows[0] as T) : null;
}

/** Count rows (proof assertions). Wraps a `SELECT 1 FROM …` probe. */
export async function countOf(
  db: DatabasePort,
  sql: string,
  parameters: readonly unknown[],
): Promise<number> {
  const result = await db.execute<{ n: number }>({
    sql: `SELECT COUNT(*)::int AS n FROM (${sql}) AS counted`,
    parameters,
  });
  return Number(result.rows[0]?.n ?? 0);
}

/** The canonical sandbox task (shared scenario shape). */
export const TRA_TASK: SandboxTask = { command: "train", args: ["--epochs", "3"], publicEnv: {} };
