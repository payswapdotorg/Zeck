/**
 * Shared real-PostgreSQL fixture for the edge/embodied execution suites
 * (WORK-029, EDGE-001/002/003).
 *
 * Extends the house PG pattern (WORK-027 computer-use-world — the
 * freshest) with the governed edge fabric over the provider-neutral
 * DatabasePort (migration 0024):
 *
 *   * edge durable state: SqlEdgeStore (migration 0024 — devices /
 *     approvals / envelopes / commands / actuation events / sensor
 *     observations / reconciliations / operations, the state this Work
 *     Order owns);
 *   * the FROZEN executions module: SqlExecutionStore +
 *     SqlExecutionsIdempotency + the execution service (the single
 *     write path and the canonical EventEnvelope ledger the edge
 *     provenance rides through the integration's ExecutionLedger
 *     adapter; the human gate manifests on the lifecycle through the
 *     PUBLIC wait-human / resume transition commands ONLY);
 *   * policy admission: the REAL policies engine (WORK-007) behind the
 *     integration's policy-edge-admission adapter, with a default
 *     platform-allow document (tests publish restrictive v2 sets to
 *     deny edge tool facts, controller references and channels — the
 *     REAL-engine denial proofs);
 *   * capability admission: the REAL capabilities registry (WORK-005,
 *     in-memory catalog seeded with the platform seeds + the edge
 *     channel/telemetry claims) behind the integration's
 *     edge-capability-gate;
 *   * budget admission: the REAL budgets service (WORK-004 —
 *     SqlBudgetStore + SqlBudgetsIdempotency, a developer-funded wallet
 *     with granted credits) directly behind the BudgetAuthority seam —
 *     the budget-before-spend boundary is PHYSICAL in PostgreSQL;
 *   * the controller rail: the in-process simulated edge controller
 *     (the provider-honesty stance — no external edge/embodied
 *     controller exists in this environment; external substrate
 *     behavior is UNVERIFIED and recorded as such in
 *     docs/work-items/WORK-029.md). ONE world-level instance models the
 *     DURABLE external substrate: a real local controller OUTLIVES the
 *     Zeck process, so every booted process talks to the SAME
 *     controller state and its keyed external-effects journal;
 *   * the process-restart crash primitive: `boot(point)` re-boots the
 *     edge service over the SURVIVING world (the PG stores, the frozen
 *     executions module and the budgets service persist across a Zeck
 *     process death; the simulated controller is the durable
 *     substrate); a `point` arms ONE durable-boundary crash (a method
 *     on the edge store, the executions service, the budget authority
 *     or the controller, before/after its durable commit or external
 *     effect) that kills the booted process mid-flight.
 */

import { createHash } from "node:crypto";
import {
  createEdgeCapabilityGate,
  createEdgeExecutionLedgerAdapter,
  createEdgeService,
  createPolicyEdgeAdmission,
  createSimulatedEdgeController,
  type EdgeCommandRequest,
  type EdgeDeviceRegistrationRequest,
  type EdgeSafetyEnvelopeContent,
  type EdgeService,
  edgeCommandFingerprint,
  edgeEnvelopeFingerprint,
  type SimulatedEdgeController,
  SqlEdgeStore,
} from "../../../src/integrations/edge/public";
import {
  SqlBudgetStore,
  SqlBudgetsIdempotency,
} from "../../../src/modules/budgets/adapters/sql-budget-store";
import {
  type BudgetService,
  createBudgetService,
} from "../../../src/modules/budgets/application/budget-service";
import { createInMemoryCatalogStore } from "../../../src/modules/capabilities/adapters/in-memory-catalog-store";
import { SEED_CAPABILITY_FACTS } from "../../../src/modules/capabilities/adapters/seed-catalog";
import { createCapabilityRegistry } from "../../../src/modules/capabilities/application/capability-registry";
import type { CapabilityRegistry } from "../../../src/modules/capabilities/ports/capability-registry";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import {
  createExecutionAuthorization,
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
  type PolicyAuthority,
} from "../../../src/modules/policies/public";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** The simulated process death (never a typed service error). */
export class ProcessCrashError extends Error {
  constructor(point: string) {
    super(`simulated process crash at ${point}`);
    this.name = "ProcessCrashError";
  }
}

/** One armed durable-boundary crash point (per booted process). */
export interface EdgeCrashPoint {
  readonly target: "store" | "executions" | "budgets" | "controller";
  readonly method: string;
  readonly when: "before" | "after";
  /** Fire on the Nth invocation within THIS process (default 1). */
  readonly occurrence?: number;
}

/**
 * Wrap one durable/external seam so the booted process dies at the
 * planned point (`before` = the durable commit / external effect did
 * not happen; `after` = it did). The wrapper records the firing so a
 * vacuous proof (a point the service never reaches) fails its
 * `crashed()` assertion.
 */
function crashableSeam<T extends object>(target: T, label: string, point: EdgeCrashPoint | null) {
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

export interface EdgePgWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly otherTenantId: string;
  /** The owner actor of the world's application (membership-backed). */
  readonly actorId: string;
  readonly approverId: string;
  readonly store: SqlEdgeStore;
  readonly policyAuthority: PolicyAuthority;
  readonly capabilityRegistry: CapabilityRegistry;
  readonly budgets: BudgetService;
  /** The default booted process's service (the house default helpers use it). */
  readonly service: EdgeService;
  /** The world-level shared simulated controller (durable across process death). */
  readonly controller: SimulatedEdgeController;
  /** Boot (or re-boot) the edge service over the SURVIVING world. */
  readonly boot: (point?: EdgeCrashPoint | null) => {
    readonly service: EdgeService;
    readonly executions: ExecutionService;
    readonly controller: SimulatedEdgeController;
    readonly crashed: () => boolean;
  };
  readonly actor: () => { actorId: string; tenantId: string };
  readonly fundApplication: (amountMicroUsd?: string) => Promise<void>;
  readonly driveToRunning: (executions: ExecutionService) => Promise<string>;
  readonly register: (
    input?: Partial<EdgeDeviceRegistrationRequest>,
    idempotencyKey?: string,
  ) => Promise<string>;
  readonly deviceRegistration: (
    overrides?: Partial<EdgeDeviceRegistrationRequest>,
  ) => EdgeDeviceRegistrationRequest;
  readonly defaultEnvelopeContent: (
    overrides?: Partial<EdgeSafetyEnvelopeContent>,
  ) => EdgeSafetyEnvelopeContent;
  readonly approveEnvelope: (
    executionId: string,
    deviceId: string,
    content?: EdgeSafetyEnvelopeContent,
    options?: {
      readonly costCeilingMicroUsd?: string;
      readonly supersedesEnvelopeId?: string | null;
      readonly envelopeKey?: string;
      readonly approvalKey?: string;
      readonly service?: EdgeService;
    },
  ) => Promise<{ readonly approvalId: string; readonly envelopeId: string }>;
  readonly commandRequest: (
    executionId: string,
    deviceId: string,
    envelopeId: string,
    overrides?: Partial<EdgeCommandRequest>,
  ) => EdgeCommandRequest;
  readonly approveCommand: (request: EdgeCommandRequest, service?: EdgeService) => Promise<string>;
}

export async function seedEdgeWorld(db: DatabasePort): Promise<EdgePgWorld> {
  const generateId = createUuidv7Generator();
  const now = () => new Date();
  const tenantId = generateId();
  const applicationId = generateId();
  const otherTenantId = generateId();
  const actorId = generateId();
  const approverId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3), ($4, $5, $6)",
    parameters: [
      tenantId,
      `t-${tenantId.slice(-6)}`,
      "edge tenant",
      otherTenantId,
      `t-${otherTenantId.slice(-6)}`,
      "edge other tenant",
    ],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "edge app"],
  });
  await db.execute({
    sql: "INSERT INTO identity.actors (id, external_subject, display_name) VALUES ($1, $2, $3), ($4, $5, $6)",
    parameters: [
      actorId,
      `subj-${actorId}`,
      "edge owner",
      approverId,
      `subj-${approverId}`,
      "edge approver",
    ],
  });
  await db.execute({
    sql: "INSERT INTO identity.memberships (id, actor_id, application_id, tenant_id, role) VALUES ($1, $2, $3, $4, 'owner')",
    parameters: [generateId(), actorId, applicationId, tenantId],
  });

  // The REAL policies engine behind the executions authorize seam AND
  // the edge policy admission seam. The default set is platform-allow;
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

  // The REAL capabilities registry (WORK-005): platform seeds + the
  // edge channel/telemetry claims the capability gate resolves.
  const edgeClaims = ["edge-channel-locomotion", "edge-channel-manipulation", "edge-telemetry"].map(
    (id) => ({
      claim: { id, kind: "tool" as const, version: "1.0.0", attributes: { governed: true } },
      provenance: { publisher: "tests:edge-world", publishedAt: "2026-09-15T00:00:00Z" },
      evidence: { kind: "catalog-seeded" as const, reference: `edge-world:${id}` },
    }),
  );
  const capabilityRegistry = await createCapabilityRegistry({
    store: createInMemoryCatalogStore(),
    seed: [...SEED_CAPABILITY_FACTS, ...edgeClaims],
  });

  // The REAL budgets service (WORK-004) directly behind the
  // BudgetAuthority seam — reserve/settle/release are PHYSICAL wallet
  // operations in PG.
  const budgets = createBudgetService({
    store: new SqlBudgetStore(db),
    idempotency: new SqlBudgetsIdempotency(db, (tx) => new SqlBudgetStore(tx), generateId),
    generateId,
    now,
  });
  const fundApplication = async (amountMicroUsd = "100000000") => {
    const scope = { actorId, applicationId, tenantId };
    await budgets.configureFundingMode(
      { ...scope, fundingMode: "developer" },
      `edge-fund-${applicationId}:mode`,
    );
    await budgets.grantCredits(
      { ...scope, ownerKind: "developer", amountMicroUsd },
      `edge-fund-${applicationId}:credits`,
    );
  };
  await fundApplication();

  // The shared, surviving REAL authority adapters (none is re-created
  // by boot — the authorities survive the process death, exactly as a
  // restart would find them).
  const policyAdmission = createPolicyEdgeAdmission(authority);
  const capabilityGate = createEdgeCapabilityGate(capabilityRegistry);
  const store = new SqlEdgeStore(db);
  // The world-level simulated controller models the DURABLE external
  // substrate: a real local controller OUTLIVES the Zeck process, so
  // ONE world-level instance is shared by every booted process. The
  // keyed external-effects journal (envelope projections keyed by
  // envelope+status; command dispatches keyed by command id) converges
  // re-dispatches across process death — exactly one external effect
  // per stable key — which is the semantics the service's external key
  // discipline presumes (a real controller's idempotent submission
  // endpoints would deliver the same).
  const controller = createSimulatedEdgeController({
    controllerId: "controller-pg",
    now: () => now(),
    digest: sha256Hex,
  });

  const boot = (point: EdgeCrashPoint | null = null) => {
    // A NEW executions service over the SURVIVING SQL store + key
    // ledger (the process-local composition of the frozen module).
    const executionsProcess = crashableSeam(
      createExecutionService({
        store: new SqlExecutionStore(db),
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
    const budgetsProcess = crashableSeam(budgets, "budgets", point);
    const controllerProcess = crashableSeam(controller, "controller", point);
    const storeProcess = crashableSeam(new SqlEdgeStore(db), "store", point);
    const service = createEdgeService({
      policy: policyAdmission,
      capabilities: capabilityGate,
      budgetAuthority: budgetsProcess.proxy as BudgetService,
      store: storeProcess.proxy,
      ledger: createEdgeExecutionLedgerAdapter(executionsProcess.proxy as ExecutionService),
      controller: controllerProcess.proxy,
      generateId,
      now,
      digest: sha256Hex,
    });
    return {
      service,
      executions: executionsProcess.proxy as ExecutionService,
      controller: controllerProcess.proxy,
      crashed: () =>
        executionsProcess.crashed() ||
        budgetsProcess.crashed() ||
        controllerProcess.crashed() ||
        storeProcess.crashed(),
    };
  };

  const actor = () => ({ actorId, tenantId });

  const driveToRunning = async (executions: ExecutionService): Promise<string> => {
    const created = await executions.createExecution(
      { applicationId, task: { kind: "summarize", input: "artifact-1" } },
      `edge-create-${generateId()}`,
      actor(),
    );
    const executionId = created.executionId;
    const scope = { ...actor(), applicationId, executionId };
    await executions.transition(
      { ...scope, command: "authorize" },
      `edge-authorize-${executionId}`,
    );
    await executions.transition({ ...scope, command: "plan" }, `edge-plan-${executionId}`);
    await executions.transition({ ...scope, command: "queue" }, `edge-queue-${executionId}`);
    await executions.transition({ ...scope, command: "start" }, `edge-start-${executionId}`);
    return executionId;
  };

  const deviceRegistration = (
    overrides: Partial<EdgeDeviceRegistrationRequest> = {},
  ): EdgeDeviceRegistrationRequest => ({
    applicationId,
    actor: actor(),
    label: "cell-1 controller",
    workloadClasses: ["edge", "embodied", "realtime"],
    capabilityAtoms: ["edge-channel-locomotion", "edge-channel-manipulation", "edge-telemetry"],
    controllerRef: "controller-pg",
    ...overrides,
  });

  const register = async (
    input: Partial<EdgeDeviceRegistrationRequest> = {},
    idempotencyKey = `dk-${generateId()}`,
  ) => {
    const receipt = await boot().service.registerDevice(deviceRegistration(input), idempotencyKey);
    return receipt.deviceId;
  };

  const defaultEnvelopeContent = (
    overrides: Partial<EdgeSafetyEnvelopeContent> = {},
  ): EdgeSafetyEnvelopeContent => ({
    channels: ["locomotion", "manipulation"],
    magnitudeBounds: { locomotion: [-500, 500], manipulation: [-100, 100] },
    rateBoundsPerMinute: { locomotion: 600, manipulation: 600 },
    notBefore: new Date(now().getTime() - 60_000).toISOString(),
    notAfter: new Date(now().getTime() + 3_600_000).toISOString(),
    maxCommands: 10,
    disconnectedPolicy: "continue-within-envelope",
    ...overrides,
  });

  const approveEnvelope = async (
    executionId: string,
    deviceId: string,
    content: EdgeSafetyEnvelopeContent = defaultEnvelopeContent(),
    options: {
      readonly costCeilingMicroUsd?: string;
      readonly supersedesEnvelopeId?: string | null;
      readonly envelopeKey?: string;
      readonly approvalKey?: string;
      readonly service?: EdgeService;
    } = {},
  ) => {
    const svc = options.service ?? boot().service;
    const request = {
      applicationId,
      actor: actor(),
      executionId,
      deviceId,
      content,
      costCeilingMicroUsd: options.costCeilingMicroUsd ?? "1000000",
      approvalId: "pending",
      supersedesEnvelopeId: options.supersedesEnvelopeId ?? null,
    };
    // computed over the canonical shape WITHOUT the approval id (the
    // approval binds to the subject shape — see the domain note)
    const subjectFingerprint = edgeEnvelopeFingerprint(request);
    const approval = await svc.requestApproval(
      {
        applicationId,
        actor: actor(),
        executionId,
        deviceId,
        subjectKind: "envelope",
        subjectFingerprint,
        policyBasis: "edge policy set v1 (pg world)",
        expiresAt: new Date(now().getTime() + 3_600_000).toISOString(),
      },
      options.approvalKey ?? `ak-${generateId()}`,
    );
    await svc.decideApproval(
      {
        applicationId,
        actor: actor(),
        approvalId: approval.approvalId,
        approverId,
        decision: "approved",
        rationale: "operator-approved within test bounds",
      },
      `ad-${generateId()}`,
    );
    const envelope = await svc.admitEnvelope(
      { ...request, approvalId: approval.approvalId },
      options.envelopeKey ?? `ek-${generateId()}`,
    );
    return { approvalId: approval.approvalId, envelopeId: envelope.envelopeId };
  };

  const commandRequest = (
    executionId: string,
    deviceId: string,
    envelopeId: string,
    overrides: Partial<EdgeCommandRequest> = {},
  ): EdgeCommandRequest => ({
    applicationId,
    actor: actor(),
    executionId,
    deviceId,
    envelopeId,
    commandKind: "actuate",
    channel: "locomotion",
    magnitude: 100,
    payload: { profile: "pg-test-step" },
    notBefore: new Date(now().getTime() - 1_000).toISOString(),
    notAfter: new Date(now().getTime() + 300_000).toISOString(),
    estimatedMicroUsd: "0",
    approvalId: null,
    ...overrides,
  });

  const approveCommand = async (request: EdgeCommandRequest, service?: EdgeService) => {
    const svc = service ?? boot().service;
    const subjectFingerprint = edgeCommandFingerprint(request);
    const approval = await svc.requestApproval(
      {
        applicationId,
        actor: actor(),
        executionId: request.executionId,
        deviceId: request.deviceId,
        subjectKind: "command",
        subjectFingerprint,
        policyBasis: "edge policy set v1 (pg world)",
        expiresAt: new Date(now().getTime() + 3_600_000).toISOString(),
      },
      `ck-${generateId()}`,
    );
    await svc.decideApproval(
      {
        applicationId,
        actor: actor(),
        approvalId: approval.approvalId,
        approverId,
        decision: "approved",
        rationale: "operator-approved within test bounds",
      },
      `cd-${generateId()}`,
    );
    return approval.approvalId;
  };

  const defaultBooted = boot();

  const world: EdgePgWorld = {
    db,
    tenantId,
    applicationId,
    otherTenantId,
    actorId,
    approverId,
    store,
    policyAuthority: authority,
    capabilityRegistry,
    budgets,
    service: defaultBooted.service,
    controller,
    boot,
    actor,
    fundApplication,
    driveToRunning,
    register,
    deviceRegistration,
    defaultEnvelopeContent,
    approveEnvelope,
    commandRequest,
    approveCommand,
  };
  return world;
}

// ---------------------------------------------------------------------------
// Scenario helpers shared by the PG suites.
// ---------------------------------------------------------------------------

/**
 * Run one operation in a DYING process: the armed crash point kills it
 * mid-flight (the promise's terminal state is irrelevant — the process
 * is gone; only the durable world matters).
 */
export async function diesDuring(
  run: () => Promise<unknown>,
  crashed: () => boolean,
): Promise<void> {
  await run().then(
    () => undefined,
    () => undefined,
  );
  if (!crashed()) {
    throw new Error("the armed crash point never fired (a vacuous crash proof)");
  }
}

/** Query one row (proof assertions). */
export async function one<T = Record<string, unknown>>(
  db: DatabasePort,
  sql: string,
  parameters: readonly unknown[],
): Promise<T | null> {
  const result = await db.execute<T>({ sql, parameters });
  return result.rows.length > 0 ? (result.rows[0] as T) : null;
}

/** Query a count (proof assertions). */
export async function count(
  db: DatabasePort,
  sql: string,
  parameters: readonly unknown[] = [],
): Promise<number> {
  const row = await one<{ n: number }>(
    db,
    `SELECT COUNT(*)::int AS n FROM (${sql}) AS q`,
    parameters,
  );
  return row?.n ?? 0;
}

/** The tools producer-vocabulary step events of one execution. */
export async function eventsOf(
  db: DatabasePort,
  executionId: string,
): Promise<readonly { sequence: number; type: string }[]> {
  const result = await db.execute<{ sequence: number; type: string }>({
    sql: "SELECT sequence, type FROM executions.execution_events WHERE execution_id = $1 ORDER BY sequence",
    parameters: [executionId],
  });
  return result.rows;
}
