/**
 * In-memory fakes of the executions module ports (unit-test infrastructure).
 *
 * Faithful to the durable contract the SQL adapter implements:
 *  - the execution row update port enforces the SAME coupling migration
 *    0004 enforces physically (sequence advances by exactly one, terminal
 *    rows immutable, rows never deleted);
 *  - the event ledger port enforces the gapless per-execution sequence and
 *    has NO update/delete surface at all (append-only by construction);
 *  - idempotency arbitration replays same-fingerprint outcomes and rejects
 *    same-key/different-fingerprint with `IDEMPOTENCY_KEY_REUSED`.
 *
 * True concurrency/locking cannot be simulated here (no interleaving
 * exists in a single-threaded store) — the real-PostgreSQL suites own
 * those proofs (WORK-002..004 precedent).
 */

import type { BudgetAuthority } from "../../../src/modules/budgets/public";
import {
  createExecutionService,
  type ExecutionService,
  type ExecutionServiceDeps,
} from "../../../src/modules/executions/application/execution-service";
import type { AppendEventInput, EventEnvelope } from "../../../src/modules/executions/domain/event";
import type {
  ExecutionCreateInput,
  ExecutionRecord,
} from "../../../src/modules/executions/domain/execution";
import { isTerminal } from "../../../src/modules/executions/domain/state-machine";
import type { VerificationResultRecord } from "../../../src/modules/executions/domain/verification";
import type {
  AuthorizationDecision,
  ExecutionAdmissionInput,
  ExecutionAuthorizationPort,
} from "../../../src/modules/executions/ports/authorization";
import type {
  ExecutionsIdempotencyPort,
  ExecutionsIdempotencyScope,
  ExecutionsTx,
} from "../../../src/modules/executions/ports/execution-idempotency";
import type {
  ApplicationTenantRow,
  ApplyTransitionInput,
  EnvironmentRow,
  ExecutionStore,
  InsertExecutionInput,
  InsertVerificationResultInput,
} from "../../../src/modules/executions/ports/execution-store";
import { PlatformError } from "../../../src/shared/errors";

export class InMemoryExecutionStore implements ExecutionStore {
  readonly executions = new Map<string, ExecutionRecord>();
  readonly events: EventEnvelope[] = [];
  readonly verificationResults = new Map<string, VerificationResultRecord>();
  readonly applications = new Map<string, ApplicationTenantRow>();
  readonly environments = new Map<string, EnvironmentRow>();

  seedApplication(applicationId: string, tenantId: string): void {
    this.applications.set(applicationId, { applicationId, tenantId });
  }

  seedEnvironment(environmentId: string, applicationId: string): void {
    this.environments.set(environmentId, { id: environmentId, applicationId });
  }

  async findApplication(applicationId: string): Promise<ApplicationTenantRow | null> {
    return this.applications.get(applicationId) ?? null;
  }

  async findEnvironment(environmentId: string): Promise<EnvironmentRow | null> {
    return this.environments.get(environmentId) ?? null;
  }

  async insertExecution(input: InsertExecutionInput): Promise<ExecutionRecord> {
    if (this.executions.has(input.id)) {
      throw new PlatformError({ code: "PROVIDER_ERROR", message: "duplicate execution id" });
    }
    const row: ExecutionRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      environmentId: input.environmentId,
      userId: input.userId,
      status: "CREATED",
      task: input.task,
      inputArtifactRefs: input.inputArtifactRefs,
      constraints: input.constraints as ExecutionRecord["constraints"],
      metadata: input.metadata,
      requestFingerprint: input.requestFingerprint,
      lastEventSequence: 1,
      verificationRefs: [],
      createdAt: input.now,
      updatedAt: input.now,
      terminalAt: null,
    };
    this.executions.set(input.id, row);
    return row;
  }

  async lockExecution(applicationId: string, executionId: string): Promise<ExecutionRecord | null> {
    const row = this.executions.get(executionId);
    return row !== undefined && row.applicationId === applicationId ? row : null;
  }

  async updateExecutionForTransition(input: ApplyTransitionInput): Promise<ExecutionRecord> {
    const row = this.executions.get(input.executionId);
    if (row === undefined || row.applicationId !== input.applicationId) {
      throw new PlatformError({ code: "PROVIDER_ERROR", message: "execution row missing" });
    }
    if (isTerminal(row.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `execution is terminal in ${row.status}; no transitions leave a terminal state`,
        details: { from: row.status },
      });
    }
    if (input.nextSequence !== row.lastEventSequence + 1) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "execution writes must append exactly one event",
        details: { expected: row.lastEventSequence + 1, got: input.nextSequence },
      });
    }
    const terminal = isTerminal(input.nextStatus as ExecutionRecord["status"]);
    const updated: ExecutionRecord = {
      ...row,
      status: input.nextStatus as ExecutionRecord["status"],
      lastEventSequence: input.nextSequence,
      verificationRefs: input.verificationRefs,
      updatedAt: input.now,
      terminalAt: terminal ? input.now : null,
    };
    this.executions.set(input.executionId, updated);
    return updated;
  }

  async getExecution(applicationId: string, executionId: string): Promise<ExecutionRecord | null> {
    const row = this.executions.get(executionId);
    return row !== undefined && row.applicationId === applicationId ? row : null;
  }

  async appendEvent(input: AppendEventInput): Promise<EventEnvelope> {
    const last = this.events
      .filter((event) => event.executionId === input.executionId)
      .reduce((max, event) => Math.max(max, event.sequence), 0);
    if (input.sequence !== last + 1) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "event sequence must be gapless per execution",
        details: { expected: last + 1, got: input.sequence },
      });
    }
    const envelope: EventEnvelope = {
      eventId: input.eventId,
      executionId: input.executionId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      sequence: input.sequence,
      type: input.type,
      command: input.command,
      actor: { actorId: input.actor.actorId, tenantId: input.actor.tenantId },
      cause: input.cause ?? null,
      reference: input.reference ?? {},
      payload: input.payload,
      occurredAt: input.occurredAt,
      producerModule: "executions",
      schemaVersion: 1,
    };
    this.events.push(envelope);
    return envelope;
  }

  async listEvents(applicationId: string, executionId: string): Promise<readonly EventEnvelope[]> {
    return this.events.filter(
      (event) => event.applicationId === applicationId && event.executionId === executionId,
    );
  }

  async insertVerificationResult(
    input: InsertVerificationResultInput,
  ): Promise<VerificationResultRecord> {
    const record: VerificationResultRecord = {
      id: input.id,
      executionId: input.executionId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      criterionId: input.criterionId,
      strategy: input.strategy,
      status: input.status as VerificationResultRecord["status"],
      evidence: input.evidence,
      recordedBy: input.recordedBy,
      recordedAt: "2026-01-01T00:00:00.000Z",
    };
    this.verificationResults.set(input.id, record);
    return record;
  }

  async listVerificationResults(
    applicationId: string,
    executionId: string,
  ): Promise<readonly VerificationResultRecord[]> {
    return [...this.verificationResults.values()].filter(
      (row) => row.applicationId === applicationId && row.executionId === executionId,
    );
  }
}

/**
 * Idempotency fake implementing the durable arbitration contract
 * (application-scoped keys; replay; key-reuse rejection). Same-key calls
 * are SERIALIZED (promise-chain queue) exactly like the transactional
 * uniqueness arbitration serializes them on real PostgreSQL — the loser
 * waits for the winner and replays its committed outcome. Pass
 * `{ alwaysRunWork: true }` to simulate the CONVERGENCE GUARD REMOVED
 * mutant used by the discrimination suite (red record R1).
 */
export class InMemoryExecutionsIdempotency implements ExecutionsIdempotencyPort {
  private readonly records = new Map<string, { fingerprint: string; outcome: unknown }>();
  private readonly queues = new Map<string, Promise<unknown>>();

  /** Set by the wiring helper (the transaction-bound store is the fake itself). */
  store: ExecutionStore = new InMemoryExecutionStore();

  constructor(private readonly options: { readonly alwaysRunWork?: boolean } = {}) {}

  async arbitrate<T>(
    scope: ExecutionsIdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (tx: ExecutionsTx) => Promise<T>,
  ): Promise<{ outcome: T; replayed: boolean }> {
    const key = `${scope.applicationId}|${operationName}|${idempotencyKey}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(
      key,
      previous.then(() => gate),
    );
    await previous.catch(() => {});
    try {
      const existing = this.records.get(key);
      if (existing !== undefined && !this.options.alwaysRunWork) {
        if (existing.fingerprint !== requestFingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "idempotency key was already used with a different request fingerprint",
            details: { operationName },
          });
        }
        return { outcome: existing.outcome as T, replayed: true };
      }
      const outcome = await work({ store: this.store });
      this.records.set(key, { fingerprint: requestFingerprint, outcome });
      return { outcome, replayed: false };
    } finally {
      release();
    }
  }
}

export const allowAllAuthorization: ExecutionAuthorizationPort = {
  async evaluate(_input: ExecutionAdmissionInput): Promise<AuthorizationDecision> {
    return { allowed: true };
  },
};

export function denyAllAuthorization(reason: string): ExecutionAuthorizationPort {
  return {
    async evaluate(_input: ExecutionAdmissionInput): Promise<AuthorizationDecision> {
      return { allowed: false, reason };
    },
  };
}

/** Budget-authority fake recording reserve consultations (WORK-004 seam). */
export class FakeBudgetAuthority {
  readonly reserveCalls: Array<Record<string, unknown>> = [];
  private counter = 0;

  readonly impl: BudgetAuthority = {
    reserve: async (command: Parameters<BudgetAuthority["reserve"]>[0], _key: string) => {
      this.reserveCalls.push(command as unknown as Record<string, unknown>);
      this.counter += 1;
      return {
        reservation: {
          id: `reservation-${this.counter}`,
          applicationId: command.applicationId as string,
          tenantId: command.tenantId as string,
          executionId: command.executionId as string,
          operationId: command.operationId as string,
          userId: String(command.userId ?? ""),
          fundingMode: "developer",
          sourceKind: "developer",
          walletId: "wallet-1",
          amountMicroUsd: String(command.amountMicroUsd),
          status: "active",
          settledAmountMicroUsd: null,
          monthKey: "2026-09",
          createdAt: "2026-09-01T00:00:00.000Z",
          finalizedAt: null,
        },
        converged: false,
        replayed: false,
      };
    },
    settle: async () => {
      throw new Error("settle is not exercised by executions unit tests");
    },
    release: async () => {
      throw new Error("release is not exercised by executions unit tests");
    },
  };
}

export interface InMemoryExecutionsWorld {
  readonly store: InMemoryExecutionStore;
  readonly idempotency: InMemoryExecutionsIdempotency;
  readonly service: ExecutionService;
  readonly budgets: FakeBudgetAuthority;
  readonly generateId: () => string;
}

export function createInMemoryExecutions(
  options: {
    readonly authorization?: ExecutionAuthorizationPort;
    readonly budgetAuthority?: BudgetAuthority;
    readonly idempotency?: InMemoryExecutionsIdempotency;
    readonly store?: InMemoryExecutionStore;
  } = {},
): InMemoryExecutionsWorld {
  const store = options.store ?? new InMemoryExecutionStore();
  const idempotency = options.idempotency ?? new InMemoryExecutionsIdempotency();
  idempotency.store = store;
  const budgets = new FakeBudgetAuthority();
  let n = 0;
  const generateId = () => {
    n += 1;
    return `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
  };
  const deps: ExecutionServiceDeps = {
    store,
    idempotency,
    authorization: options.authorization ?? allowAllAuthorization,
    budgetAuthority: options.budgetAuthority ?? budgets.impl,
    generateId,
    now: () => new Date("2026-09-15T12:00:00Z"),
  };
  return { store, idempotency, service: createExecutionService(deps), budgets, generateId };
}

export const ACTOR = {
  actorId: "00000000-0000-7000-8000-0000000000aa",
  tenantId: "00000000-0000-7000-8000-0000000000bb",
};

export const OTHER_TENANT_ACTOR = {
  actorId: "00000000-0000-7000-8000-0000000000cc",
  tenantId: "00000000-0000-7000-8000-0000000000dd",
};

export function baseCreateInput(applicationId: string): ExecutionCreateInput {
  return { applicationId, task: { kind: "summarize", input: "artifact-1" } };
}

export function transitionScope(applicationId: string, executionId: string) {
  return { ...ACTOR, applicationId, executionId };
}
