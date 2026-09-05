/**
 * Shared real-PostgreSQL fixture for the D-04 orchestration suites
 * (WORK-045).
 *
 * Seeds the executions world (tenant + application + environment) and
 * executions driven through the REAL governed lifecycle into each
 * waiting state (create → authorize → plan → queue → start → wait-* —
 * the existing single write path, untouched), then wires the full
 * D-04 fabric:
 *
 *  - the SQL correlation store over the real DatabasePort;
 *  - an in-memory `WorkflowOrchestrationPort` double (instance store,
 *    signal/termination recording, start/signal failure injection,
 *    provider-observed status forcing, call-order record);
 *  - the orchestration coordinator;
 *  - the governed effect = the executions module workflow-effect
 *    adapter over the REAL execution service;
 *  - the candidate source = the executions module
 *    orchestration-source adapter over the real table.
 *
 * The provider-neutral port contract is the only seam the double
 * implements — the production adapter (Cloudflare Workflows REST)
 * is verified separately over the documented protocol.
 */

import { createOrchestrationSource } from "../../../src/modules/executions/adapters/orchestration-source";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import { createOrchestrationResolutionEffect } from "../../../src/modules/executions/adapters/workflow-effect";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import type { DatabasePort } from "../../../src/platform/db/port";
import { WorkflowCorrelationStore } from "../../../src/platform/workflow/correlation";
import { createOrchestrationCoordinator } from "../../../src/platform/workflow/engine";
import {
  type InstanceObservation,
  type InstanceReceipt,
  type OrchestrationWait,
  type SignalInstanceInput,
  type StartInstanceInput,
  type TerminateInstanceInput,
  type WorkflowOrchestrationPort,
  type WorkflowProviderLimits,
  WorkflowTransportError,
} from "../../../src/platform/workflow/port";
import { createUuidv7Generator } from "../../../src/shared/ids";

export const generateId = createUuidv7Generator();
export const ACTOR_ID = "00000000-0000-7000-8000-0000000000aa";
export const ORCHESTRATOR_ACTOR_ID = "00000000-0000-7000-8000-0000000000ed";
export const HUMAN_APPROVER_ID = "human-approver-01";

export const TEST_POLICY = Object.freeze({
  maxStartAttempts: 3,
  maxSignalAttempts: 3,
  maxEffectAttempts: 3,
  maxReplacements: 3,
  retryBackoffMs: 0,
});

export const TEST_BOUNDS = Object.freeze({
  maxPayloadBytes: 4096,
  maxRetainedNotifications: 32,
});

/** One provider-side call as recorded by the double (in order). */
export interface WorkflowCallEvent {
  readonly kind: "start" | "describe" | "signal" | "terminate";
  readonly at: number;
  readonly detail: string;
}

/**
 * The in-memory orchestration double.
 *
 * Semantics deliberately mirror the provider engine's model:
 * instances are created (accepting the caller's instance id hint),
 * observed (status vocabulary incl. forced outcomes), signaled
 * (events recorded) and terminated. Start/signal failures are
 * injectable as TYPED transport errors (transient/permanent); every
 * call is recorded in order (the correlation-before-reliance proof
 * reads this).
 */
export class InMemoryWorkflowTransport implements WorkflowOrchestrationPort {
  private readonly instances = new Map<
    string,
    { params: unknown; status: string; events: string[]; terminated: boolean }
  >();
  private readonly events: WorkflowCallEvent[] = [];
  private counter = 0;
  private startFailures: { count: number; error: Error }[] = [];
  private signalFailures = 0;
  private forcedStatus: { readonly instanceId: string; readonly status: string } | null = null;

  async startInstance(input: StartInstanceInput): Promise<InstanceReceipt> {
    this.events.push({ kind: "start", at: ++this.counter, detail: input.instanceHint });
    const failure = this.startFailures[0];
    if (failure !== undefined && failure.count > 0) {
      failure.count -= 1;
      if (failure.count === 0) {
        this.startFailures.shift();
      }
      throw failure.error;
    }
    this.instances.set(input.instanceHint, {
      params: input.params,
      status: "active",
      events: [],
      terminated: false,
    });
    return { instanceId: input.instanceHint };
  }

  async describeInstance(instanceId: string): Promise<InstanceObservation> {
    this.events.push({ kind: "describe", at: ++this.counter, detail: instanceId });
    if (this.forcedStatus !== null && this.forcedStatus.instanceId === instanceId) {
      return { status: this.forcedStatus.status as InstanceObservation["status"], detail: null };
    }
    const instance = this.instances.get(instanceId);
    if (instance === undefined) {
      throw new WorkflowTransportError(
        `workflow instance describe rejected (http 404, provider code 7002: No such instance)`,
        "permanent",
        { status: 404, providerCode: "7002" },
      );
    }
    return { status: instance.status as InstanceObservation["status"], detail: null };
  }

  async signalInstance(input: SignalInstanceInput): Promise<void> {
    this.events.push({
      kind: "signal",
      at: ++this.counter,
      detail: `${input.instanceId}:${input.eventType}`,
    });
    if (this.signalFailures > 0) {
      this.signalFailures -= 1;
      throw new WorkflowTransportError("injected signal outage (transient)", "transient");
    }
    const instance = this.instances.get(input.instanceId);
    instance?.events.push(input.eventType);
  }

  async terminateInstance(input: TerminateInstanceInput): Promise<void> {
    this.events.push({ kind: "terminate", at: ++this.counter, detail: input.instanceId });
    const instance = this.instances.get(input.instanceId);
    if (instance !== undefined) {
      instance.terminated = true;
      instance.status = "terminated";
    }
  }

  describeLimits(): WorkflowProviderLimits {
    return {
      documented: { inMemoryTestDouble: "true" },
      maxPayloadBytes: 1_048_576,
      supportsTermination: true,
    };
  }

  /** Inject N typed start failures. */
  failNextStarts(count: number, error: Error): void {
    this.startFailures.push({ count, error });
  }

  /** Inject one typed signal failure. */
  failNextSignal(): void {
    this.signalFailures += 1;
  }

  /** Force the provider-observed status of one instance (evidence injection). */
  forceObservedStatus(instanceId: string, status: string): void {
    this.forcedStatus = { instanceId, status };
  }

  /** The events delivered to one instance. */
  eventsOf(instanceId: string): readonly string[] {
    return this.instances.get(instanceId)?.events ?? [];
  }

  /** True iff the instance was terminated through the port. */
  wasTerminated(instanceId: string): boolean {
    return this.instances.get(instanceId)?.terminated === true;
  }

  /** The ordered call record (the correlation-before-reliance proof). */
  callLog(): readonly WorkflowCallEvent[] {
    return this.events;
  }

  /** Forget one instance (simulate provider-side removal/retention expiry). */
  forgetInstance(instanceId: string): void {
    this.instances.delete(instanceId);
  }
}

export interface WorkflowWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly environmentId: string;
  readonly service: ExecutionService;
  readonly store: WorkflowCorrelationStore;
  readonly transport: InMemoryWorkflowTransport;
  readonly coordinator: ReturnType<typeof createOrchestrationCoordinator>;
  /** Create + drive one execution through the REAL lifecycle into a wait state. */
  createWaitingExecution: (suffix: string, wait: "tool" | "user" | "human") => Promise<string>;
  /** The transition scope used by the lifecycle helper. */
  scopeOf: (executionId: string) => {
    readonly actorId: string;
    readonly applicationId: string;
    readonly tenantId: string;
    readonly executionId: string;
  };
  /** The live wait of one execution + kind (or null). */
  liveWait: (
    executionId: string,
    kind: "timer" | "callback" | "approval",
  ) => Promise<OrchestrationWait | null>;
  /** The current authoritative execution status. */
  statusOf: (executionId: string) => Promise<string>;
}

export async function seedWorkflowWorld(
  db: DatabasePort,
  options?: { readonly waitTimeoutMs?: number; readonly now?: () => Date },
): Promise<WorkflowWorld> {
  const now = options?.now ?? (() => new Date());
  const tenantId = generateId();
  const applicationId = generateId();
  const environmentId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "workflow tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "workflow app"],
  });
  await db.execute({
    sql: "INSERT INTO applications.environments (id, application_id, tenant_id, kind, name) VALUES ($1, $2, $3, $4, $5)",
    parameters: [environmentId, applicationId, tenantId, "production", "prod"],
  });

  const service = createExecutionService({
    store: new SqlExecutionStore(db),
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: { evaluate: async () => ({ allowed: true }) },
    generateId,
    now: () => new Date(),
  });

  const store = new WorkflowCorrelationStore(db);
  const transport = new InMemoryWorkflowTransport();
  const coordinator = createOrchestrationCoordinator({
    store,
    workflow: transport,
    effect: createOrchestrationResolutionEffect({
      service,
      orchestratorActorId: ORCHESTRATOR_ACTOR_ID,
    }),
    source: createOrchestrationSource({
      db,
      deadlines: { waitTimeoutMs: options?.waitTimeoutMs ?? 0 },
      now,
    }),
    policy: TEST_POLICY,
    bounds: TEST_BOUNDS,
    generateId,
    now,
    sleep: async () => undefined,
  });

  const createWaitingExecution = async (
    suffix: string,
    wait: "tool" | "user" | "human",
  ): Promise<string> => {
    const receipt = await service.createExecution(
      {
        applicationId,
        environmentId,
        task: { kind: "workflow-orchestration-test", input: suffix },
      },
      `create-${suffix}`,
      { actorId: ACTOR_ID, tenantId },
    );
    const scope = {
      actorId: ACTOR_ID,
      applicationId,
      tenantId,
      executionId: receipt.executionId,
    };
    for (const [command, key] of [
      ["authorize", `auth-${suffix}`],
      ["plan", `plan-${suffix}`],
      ["queue", `queue-${suffix}`],
      ["start", `start-${suffix}`],
      [`wait-${wait}`, `wait-${suffix}`],
    ] as const) {
      await service.transition({ ...scope, command }, key);
    }
    return receipt.executionId;
  };

  const scopeOf = (executionId: string) => ({
    actorId: ACTOR_ID,
    applicationId,
    tenantId,
    executionId,
  });

  const liveWait = (executionId: string, kind: "timer" | "callback" | "approval") =>
    store.findLiveWait(executionId, kind);

  const statusOf = async (executionId: string): Promise<string> => {
    const execution = await service.getExecution(applicationId, executionId);
    if (execution === null) {
      throw new Error(`execution ${executionId} vanished`);
    }
    return execution.status;
  };

  return {
    db,
    tenantId,
    applicationId,
    environmentId,
    service,
    store,
    transport,
    coordinator,
    createWaitingExecution,
    scopeOf,
    liveWait,
    statusOf,
  };
}
