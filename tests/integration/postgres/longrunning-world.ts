/**
 * Shared real-PostgreSQL fixture for the long-running/resumable execution
 * suites (WORK-028).
 *
 * Extends the WORK-006 executions world with the WORK-028 long-running
 * fabric over the provider-neutral DatabasePort (migration 0022):
 *
 *   * checkpoints/leases/wake-ups/operations: SqlLongRunningExecutionStore
 *     (migration 0022 — the durable state this Work Order owns);
 *   * the FROZEN executions module: SqlExecutionStore +
 *     SqlExecutionsIdempotency + the execution service (the single write
 *     path and the canonical EventEnvelope ledger the long-running
 *     evidence rides);
 *   * policy re-admission: the REAL policies engine (WORK-007) behind the
 *     executions module's createPolicyResumeAdmission adapter, with a
 *     default platform-allow document (tests publish restrictive sets to
 *     deny — the REAL-engine denial proof);
 *   * resource re-admission: the REAL sandbox module (WORK-012) — the SQL
 *     environment catalog + the policy/capability admission chain — behind
 *     createExecutionResumeReadmission (tests register/suspend/retire
 *     compute environments);
 *   * budget: the REAL budgets service (WORK-004) with configurable
 *     funding behind the resume cost-bound seam;
 *   * the process-restart crash primitive: `boot(point)` re-boots the
 *     long-running service over the SURVIVING world (the PG store, the
 *     frozen executions module, the durable operation ledger persist
 *     across a Zeck process death); a `point` arms ONE durable-boundary
 *     crash (a method on the long-running store or the executions
 *     service, before/after its durable commit) that kills the booted
 *     process mid-flight.
 */

import { createHash } from "node:crypto";
import { expect } from "vitest";
import {
  SqlBudgetStore,
  SqlBudgetsIdempotency,
} from "../../../src/modules/budgets/adapters/sql-budget-store";
import type { BudgetService } from "../../../src/modules/budgets/application/budget-service";
import { createBudgetService } from "../../../src/modules/budgets/application/budget-service";
import { createPolicyResumeAdmission } from "../../../src/modules/executions/adapters/policy-resume-admission";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import { SqlLongRunningExecutionStore } from "../../../src/modules/executions/adapters/sql-long-running-store";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import {
  createLongRunningExecutionService,
  type LongRunningExecutionService,
} from "../../../src/modules/executions/application/long-running-service";
import type {
  CheckpointContents,
  ResumeFacts,
} from "../../../src/modules/executions/domain/checkpoint";
import {
  createExecutionAuthorization,
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
  type PolicyAuthority,
} from "../../../src/modules/policies/public";
import { createExecutionResumeReadmission } from "../../../src/modules/sandbox/adapters/execution-resume-readmission";
import { createPolicySandboxAdmission } from "../../../src/modules/sandbox/adapters/policy-sandbox-admission";
import { SqlSandboxStore } from "../../../src/modules/sandbox/adapters/sql-sandbox-store";
import { createEnvironmentCatalog } from "../../../src/modules/sandbox/application/environment-catalog";
import type { ComputeEnvironmentSpec } from "../../../src/modules/sandbox/domain/environment";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";
import {
  actorOf,
  type ExecutionsWorld,
  seedExecutionsWorld,
  transitionScope,
} from "./executions-world";

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** The neutral process compute-environment spec of the world. */
export const LONGRUNNING_SPEC: ComputeEnvironmentSpec = {
  kind: "process",
  limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
  network: { egress: "none", allowedHosts: [] },
  filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: { capabilityId: "process-sandbox" },
  cost: { estimatedCostMicroUsd: "0" },
};

/** The simulated process death (never a typed service error). */
export class ProcessCrashError extends Error {
  constructor(point: string) {
    super(`simulated process crash at ${point}`);
    this.name = "ProcessCrashError";
  }
}

/** One armed durable-boundary crash point (per booted process). */
export interface LongRunningCrashPoint {
  readonly target: "store" | "executions";
  readonly method: string;
  readonly when: "before" | "after";
  /** Fire on the Nth invocation within THIS process (default 1). */
  readonly occurrence?: number;
}

/**
 * Wrap one durable seam so the booted process dies at the planned point
 * (`before` = the durable commit did not happen; `after` = the commit did).
 * The wrapper records the firing so a vacuous proof (a point the service
 * never reaches) fails its `crashed()` assertion.
 */
function crashableSeam<T extends object>(
  target: T,
  label: string,
  point: LongRunningCrashPoint | null,
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

export interface LongRunningPgWorld {
  readonly db: DatabasePort;
  readonly base: ExecutionsWorld;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly store: SqlLongRunningExecutionStore;
  readonly policyAuthority: PolicyAuthority;
  readonly budgets: BudgetService;
  readonly environmentCatalog: ReturnType<typeof createEnvironmentCatalog>;
  /** Boot (or re-boot) the long-running service over the SURVIVING world. */
  readonly boot: (point?: LongRunningCrashPoint | null) => {
    readonly service: LongRunningExecutionService;
    readonly executions: ExecutionService;
    readonly crashed: () => boolean;
  };
  readonly actor: () => ReturnType<typeof actorOf>;
  /** Drive one execution through the frozen lifecycle to RUNNING. */
  driveToRunning: (service: ExecutionService) => Promise<string>;
  /** Register a compute environment in the sandbox catalog. */
  registerEnvironment: (
    slug: string,
    spec?: ComputeEnvironmentSpec,
  ) => Promise<{ id: string; specDigest: string }>;
  /** Fund the application's budget (the REAL budgets module). */
  fundApplication: (amountMicroUsd?: string) => Promise<void>;
}

export async function seedLongRunningWorld(db: DatabasePort): Promise<LongRunningPgWorld> {
  const base = await seedExecutionsWorld(db);
  const generateId = createUuidv7Generator();
  const now = () => new Date();

  // The REAL policies engine behind BOTH the frozen authorize seam and
  // the resume re-admission seam. The default set is platform-allow;
  // tests publish restrictive v2 sets for the denial proofs.
  const authority = createPolicyAuthority({
    store: new InMemoryPolicyStore(),
    hasher: nodePolicyHasher,
  });
  await authority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });

  // The REAL budgets service (WORK-004) behind the resume cost-bound seam.
  const budgets = createBudgetService({
    store: new SqlBudgetStore(db),
    idempotency: new SqlBudgetsIdempotency(db, (tx) => new SqlBudgetStore(tx), generateId),
    generateId,
    now,
  });

  // The REAL sandbox module behind the resource re-admission seam: the
  // SQL environment catalog + the REAL policy sandbox-admission chain
  // (the WORK-012 seams the resource re-admission consults).
  const sandboxStore = new SqlSandboxStore(db);
  const environmentCatalog = createEnvironmentCatalog({
    store: sandboxStore,
    generateId,
    now,
    hashSpec: sha256Hex,
  });
  const sandboxAdmission = createPolicySandboxAdmission(authority);
  const resourceReadmission = createExecutionResumeReadmission(
    environmentCatalog,
    sandboxAdmission,
  );

  const store = new SqlLongRunningExecutionStore(db);

  const actor = () => actorOf(base);

  const boot = (point: LongRunningCrashPoint | null = null) => {
    // A NEW executions service instance over the SURVIVING SQL store +
    // key ledger (the process-local composition of the durable frozen
    // module), then the long-running service over it — both wrapped by
    // the injector.
    const executionsProcess = crashableSeam(
      createExecutionService({
        store: base.store,
        idempotency: new SqlExecutionsIdempotency(
          db,
          (tx) => new SqlExecutionStore(tx),
          generateId,
        ),
        authorization: createExecutionAuthorization(authority),
        generateId,
        now,
      }),
      "executions",
      point,
    );
    const storeProcess = crashableSeam(store, "store", point);
    const service = createLongRunningExecutionService({
      executions: executionsProcess.proxy as ExecutionService,
      store: storeProcess.proxy,
      resumePolicyReadmission: createPolicyResumeAdmission(authority),
      resourceReadmission,
      budgetAuthority: budgets,
      digest: sha256Hex,
      generateId,
      now,
    });
    return {
      service,
      executions: executionsProcess.proxy as ExecutionService,
      crashed: () => executionsProcess.crashed() || storeProcess.crashed(),
    };
  };

  const driveToRunning = async (executions: ExecutionService): Promise<string> => {
    const created = await executions.createExecution(
      { applicationId: base.applicationId, task: { kind: "summarize", input: "artifact-1" } },
      `create-${generateId()}`,
      actor(),
    );
    const executionId = created.executionId;
    const scope = transitionScope(base, executionId);
    await executions.transition({ ...scope, command: "authorize" }, `authorize-${executionId}`);
    await executions.transition({ ...scope, command: "plan" }, `plan-${executionId}`);
    await executions.transition({ ...scope, command: "queue" }, `queue-${executionId}`);
    await executions.transition({ ...scope, command: "start" }, `start-${executionId}`);
    return executionId;
  };

  const registerEnvironment = async (
    slug: string,
    spec: ComputeEnvironmentSpec = LONGRUNNING_SPEC,
  ) => {
    const record = await environmentCatalog.register(
      {
        applicationId: base.applicationId,
        tenantId: base.tenantId,
        slug,
        name: slug,
        spec,
      },
      `env-${slug}`,
      { actorId: actor().actorId, applicationId: base.applicationId, tenantId: base.tenantId },
    );
    return { id: record.id, specDigest: record.specDigest };
  };

  const fundApplication = async (amountMicroUsd = "100000000") => {
    const scope = { ...actor(), applicationId: base.applicationId };
    await budgets.configureFundingMode(
      { ...scope, fundingMode: "developer" },
      `fund-${base.applicationId}:mode`,
    );
    await budgets.grantCredits(
      { ...scope, ownerKind: "developer", amountMicroUsd },
      `fund-${base.applicationId}:credits`,
    );
  };

  return {
    db,
    base,
    tenantId: base.tenantId,
    applicationId: base.applicationId,
    store,
    policyAuthority: authority,
    budgets,
    environmentCatalog,
    boot,
    actor,
    driveToRunning,
    registerEnvironment,
    fundApplication,
  };
}

// ---------------------------------------------------------------------------
// Scenario helpers shared by the PG suites.
// ---------------------------------------------------------------------------

/** The canonical checkpoint contents of one execution. */
export function checkpointOf(
  executionId: string,
  overrides: Partial<CheckpointContents> = {},
): CheckpointContents {
  return {
    executionId,
    planId: "plan-1",
    planRevision: 3,
    contextArtifactRefs: ["artifact:ctx/1"],
    lastEventPosition: 5,
    resourceClass: "standard",
    environmentId: null,
    environmentSpecDigest: null,
    requiredCapabilities: ["cap-a"],
    maxCostMicroUsd: null,
    ...overrides,
  };
}

/** The resume facts of one checkpoint (the unchanged resume). */
export function factsOf(contents: CheckpointContents): ResumeFacts {
  return {
    planId: contents.planId,
    planRevision: contents.planRevision,
    resourceClass: contents.resourceClass,
    environmentId: contents.environmentId,
    environmentSpecDigest: contents.environmentSpecDigest,
    requiredCapabilities: contents.requiredCapabilities,
    maxCostMicroUsd: contents.maxCostMicroUsd,
  };
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

/** Query one row of a long-running extension table (proof assertions). */
export async function one<T = Record<string, unknown>>(
  db: DatabasePort,
  sql: string,
  parameters: readonly unknown[],
): Promise<T | null> {
  const result = await db.execute<T>({ sql, parameters });
  return result.rows.length > 0 ? (result.rows[0] as T) : null;
}
