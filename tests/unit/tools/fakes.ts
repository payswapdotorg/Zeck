/**
 * In-memory fakes of the tools module ports (unit-test infrastructure).
 *
 * Faithful to the durable contract the SQL adapter implements over
 * migration 0005:
 *  - the invocation row is the request-idempotency anchor: one row per
 *    (application, invocationKey); same key + different fingerprint fails
 *    IDEMPOTENCY_KEY_REUSED; concurrent identical claims converge (the
 *    promise-queue serialization stands in for the unique-index
 *    arbitration);
 *  - terminal rows are immutable and rows are never deleted;
 *  - the outcome recording is guarded (dispatching -> terminal exactly
 *    once; a second writer converges on the committed outcome);
 *  - the ledger-sequence binding touches dispatching rows only.
 *
 * True concurrency/locking cannot be simulated here - the real-PostgreSQL
 * suites own those proofs (WORK-002..006 precedent).
 */

import type {
  ToolInvocationRecord,
  ToolInvocationStatus,
} from "../../../src/modules/tools/domain/invocation";
import { TOOL_INVOCATION_STATUSES } from "../../../src/modules/tools/domain/invocation";
import type {
  BindLedgerSequenceInput,
  ClaimDispatchingInput,
  ClaimOutcome,
  RecordDeniedInput,
  RecordOutcomeInput,
  ToolInvocationStore,
} from "../../../src/modules/tools/ports/tool-invocation-store";
import { PlatformError } from "../../../src/shared/errors";

export class InMemoryToolInvocationStore implements ToolInvocationStore {
  readonly records = new Map<string, ToolInvocationRecord>();
  /** Per-key serialization (stands in for the unique-index arbitration). */
  private readonly queues = new Map<string, Promise<unknown>>();

  private queue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.queues.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private keyOf(applicationId: string, invocationKey: string): string {
    return `${applicationId}|${invocationKey}`;
  }

  async findByKey(
    applicationId: string,
    invocationKey: string,
  ): Promise<ToolInvocationRecord | null> {
    for (const record of this.records.values()) {
      if (record.applicationId === applicationId && record.invocationKey === invocationKey) {
        return record;
      }
    }
    return null;
  }

  async findById(
    applicationId: string,
    invocationId: string,
  ): Promise<ToolInvocationRecord | null> {
    const record = this.records.get(invocationId);
    return record !== undefined && record.applicationId === applicationId ? record : null;
  }

  claimDispatching(input: ClaimDispatchingInput): Promise<ClaimOutcome> {
    return this.queue(this.keyOf(input.applicationId, input.invocationKey), async () => {
      const existing = await this.findByKey(input.applicationId, input.invocationKey);
      if (existing !== null) {
        if (existing.requestFingerprint !== input.requestFingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "idempotency key was already used with a different request fingerprint",
            details: { invocationId: existing.id },
          });
        }
        return { claimed: false, record: existing };
      }
      const record: ToolInvocationRecord = {
        id: input.id,
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        executionId: input.executionId,
        invocationKey: input.invocationKey,
        requestFingerprint: input.requestFingerprint,
        toolId: input.toolId,
        toolVersion: input.toolVersion,
        capabilityId: input.capabilityId,
        status: "dispatching",
        outcomeClass: null,
        denialClass: null,
        denialCode: null,
        denialReason: null,
        failureClass: null,
        failureMessage: null,
        retryable: false,
        inputDigest: input.inputDigest,
        inputArtifacts: [...input.inputArtifacts],
        output: null,
        outputArtifacts: [],
        usageMicroUsd: null,
        budgetOperationId: input.budgetOperationId,
        policyEvidence: input.policyEvidence,
        capabilitySatisfaction: input.capabilitySatisfaction,
        requestedAt: input.requestedAt,
        dispatchedAt: null,
        completedAt: null,
        durationMs: null,
        ledgerRequestedSequence: null,
        ledgerResultSequence: null,
      };
      this.records.set(record.id, record);
      return { claimed: true, record };
    });
  }

  recordDenied(input: RecordDeniedInput): Promise<ClaimOutcome> {
    return this.queue(this.keyOf(input.applicationId, input.invocationKey), async () => {
      const existing = await this.findByKey(input.applicationId, input.invocationKey);
      if (existing !== null) {
        if (existing.requestFingerprint !== input.requestFingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "idempotency key was already used with a different request fingerprint",
            details: { invocationId: existing.id },
          });
        }
        return { claimed: false, record: existing };
      }
      const record: ToolInvocationRecord = {
        id: input.id,
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        executionId: input.executionId,
        invocationKey: input.invocationKey,
        requestFingerprint: input.requestFingerprint,
        toolId: input.toolId,
        toolVersion: input.toolVersion,
        capabilityId: input.capabilityId,
        status: "denied",
        outcomeClass: null,
        denialClass: input.denialClass,
        denialCode: input.denialCode,
        denialReason: input.denialReason,
        failureClass: null,
        failureMessage: null,
        retryable: false,
        inputDigest: input.inputDigest,
        inputArtifacts: [...input.inputArtifacts],
        output: null,
        outputArtifacts: [],
        usageMicroUsd: null,
        budgetOperationId: null,
        policyEvidence: null,
        capabilitySatisfaction: null,
        requestedAt: input.requestedAt,
        dispatchedAt: null,
        completedAt: null,
        durationMs: null,
        ledgerRequestedSequence: null,
        ledgerResultSequence: null,
      };
      this.records.set(record.id, record);
      return { claimed: true, record };
    });
  }

  async recordOutcome(input: RecordOutcomeInput): Promise<ToolInvocationRecord> {
    const existing = await this.findByKey(input.applicationId, input.invocationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "tool invocation row disappeared (rows are never deleted)",
      });
    }
    if (existing.status !== "dispatching") {
      // Guarded first-writer-wins: converge on the committed outcome.
      return existing;
    }
    const finalized: ToolInvocationRecord = {
      ...existing,
      status: input.status,
      outcomeClass: input.outcomeClass,
      output: input.output === null ? null : { ...input.output },
      outputArtifacts: [...input.outputArtifacts],
      failureClass: input.failureClass,
      failureMessage: input.failureMessage,
      retryable: input.retryable,
      usageMicroUsd: input.usageMicroUsd,
      dispatchedAt: input.dispatchedAt,
      completedAt: input.completedAt,
      durationMs: input.durationMs,
    };
    this.records.set(finalized.id, finalized);
    return finalized;
  }

  async bindLedgerSequence(input: BindLedgerSequenceInput): Promise<void> {
    const existing = await this.findByKey(input.applicationId, input.invocationKey);
    if (existing === null || existing.status !== "dispatching") {
      return;
    }
    const updated: ToolInvocationRecord =
      input.phase === "requested"
        ? { ...existing, ledgerRequestedSequence: input.sequence }
        : { ...existing, ledgerResultSequence: input.sequence };
    this.records.set(updated.id, updated);
  }

  async listByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly ToolInvocationRecord[]> {
    return [...this.records.values()]
      .filter(
        (record) => record.applicationId === applicationId && record.executionId === executionId,
      )
      .sort((a, b) =>
        a.requestedAt < b.requestedAt
          ? -1
          : a.requestedAt > b.requestedAt
            ? 1
            : a.id < b.id
              ? -1
              : 1,
      );
  }

  isKnownStatus(status: string): status is ToolInvocationStatus {
    return (TOOL_INVOCATION_STATUSES as readonly string[]).includes(status);
  }
}

// ---------------------------------------------------------------------------
// Admission / capability / budget fakes and the in-memory tools world
// ---------------------------------------------------------------------------

import type { BudgetAuthority } from "../../../src/modules/budgets/public";
import type {
  CapabilityResolution,
  TaskCapabilityProfile,
} from "../../../src/modules/capabilities/public";
import type { ExecutionService } from "../../../src/modules/executions/application/execution-service";
import { createExecutionService } from "../../../src/modules/executions/application/execution-service";
import type { ExecutionRecord } from "../../../src/modules/executions/domain/execution";
import { createExecutionLedgerAdapter } from "../../../src/modules/tools/adapters/execution-ledger";
import type { ToolRuntime } from "../../../src/modules/tools/application/tool-runtime";
import { createToolRuntime } from "../../../src/modules/tools/application/tool-runtime";
import type { ToolPolicyEvidence } from "../../../src/modules/tools/domain/invocation";
import type { ToolContract } from "../../../src/modules/tools/domain/tool";
import type { ToolAdapter } from "../../../src/modules/tools/ports/tool-adapter";
import type {
  ToolAdmission,
  ToolAdmissionRequest,
} from "../../../src/modules/tools/ports/tool-admission";
import type { ToolCapabilityResolution } from "../../../src/modules/tools/ports/tool-capability-gate";
import type { RegisteredTool, ToolRegistry } from "../../../src/modules/tools/ports/tool-registry";
import { InMemoryExecutionStore, InMemoryExecutionsIdempotency } from "../executions/fakes";

export const EVIDENCE: ToolPolicyEvidence = {
  policySetId: "set-1",
  policySetVersion: 3,
  policyContentHash: "hash-1",
  restrictionSetDigest: "digest-1",
};

/** Recording allow/deny admission fake (the seam the policy engine fills). */
export class FakeToolAdmission {
  readonly calls: ToolAdmissionRequest[] = [];
  private deny = false;
  private reason = "policy says no";

  denyWith(reason: string): void {
    this.deny = true;
    this.reason = reason;
  }

  readonly impl: ToolAdmission = {
    admit: async (request: ToolAdmissionRequest) => {
      this.calls.push(request);
      if (this.deny) {
        return { allowed: false, reason: this.reason };
      }
      return { allowed: true, evidence: EVIDENCE };
    },
  };
}

/** Recording capability gate fake: satisfiable or unmet per configuration. */
export class FakeCapabilityGate {
  readonly calls: TaskCapabilityProfile[] = [];
  private unmet = false;

  fail(): void {
    this.unmet = true;
  }

  readonly impl: ToolCapabilityResolution = {
    resolve: async (profile: TaskCapabilityProfile): Promise<CapabilityResolution> => {
      this.calls.push(profile);
      if (this.unmet) {
        return {
          satisfied: false,
          catalogRevision: "rev-1",
          unmet: profile.requirements.map((requirement) => ({
            requirementId: requirement.id,
            kind: requirement.kind,
            reason: "unknown-capability" as const,
            minVersion: requirement.minVersion ?? null,
          })),
        };
      }
      return {
        satisfied: true,
        catalogRevision: "rev-1",
        satisfactions: profile.requirements.map((requirement) => ({
          requirementId: requirement.id,
          claimId: requirement.id,
          claimKind: requirement.kind,
          claimVersion: requirement.minVersion ?? "1.0.0",
          evidenceKind: "adapter-declared" as const,
          evidenceReference: "catalog:ref",
          publisher: "test",
        })),
      };
    },
  };
}

/** Recording budget authority fake (reserve/settle/release + denial mode). */
export class FakeBudgetAuthority {
  readonly reserveCalls: Array<{ command: Record<string, unknown>; key: string }> = [];
  readonly settleCalls: Array<{ command: Record<string, unknown>; key: string }> = [];
  readonly releaseCalls: Array<{ command: Record<string, unknown>; key: string }> = [];
  private counter = 0;
  private denyReserve = false;
  private denyReason = "budget exceeded";

  denyReservations(reason = "budget exceeded"): void {
    this.denyReserve = true;
    this.denyReason = reason;
  }

  readonly impl: BudgetAuthority = {
    reserve: async (command: Parameters<BudgetAuthority["reserve"]>[0], key: string) => {
      this.reserveCalls.push({ command: command as unknown as Record<string, unknown>, key });
      this.counter += 1;
      if (this.denyReserve) {
        throw new PlatformError({ code: "BUDGET_EXCEEDED", message: this.denyReason });
      }
      return {
        reservation: {
          id: `reservation-${this.counter}`,
          applicationId: command.applicationId,
          tenantId: command.tenantId,
          executionId: command.executionId,
          operationId: command.operationId,
          userId: command.userId ?? "",
          fundingMode: "developer" as const,
          sourceKind: "developer" as const,
          walletId: "wallet-1",
          amountMicroUsd: command.amountMicroUsd,
          status: "active" as const,
          settledAmountMicroUsd: null,
          monthKey: "2026-09",
          createdAt: "2026-09-01T00:00:00.000Z",
          finalizedAt: null,
        },
        converged: false,
        replayed: false,
      };
    },
    settle: async (command: Parameters<BudgetAuthority["settle"]>[0], key: string) => {
      this.settleCalls.push({ command: command as unknown as Record<string, unknown>, key });
      return {
        reservation: {
          id: `reservation-${this.counter}`,
          applicationId: command.applicationId,
          tenantId: "",
          executionId: "",
          operationId: command.operationId,
          userId: "",
          fundingMode: "developer" as const,
          sourceKind: "developer" as const,
          walletId: "wallet-1",
          amountMicroUsd: "0",
          status: "settled" as const,
          settledAmountMicroUsd: command.actualAmountMicroUsd,
          monthKey: "2026-09",
          createdAt: "2026-09-01T00:00:00.000Z",
          finalizedAt: "2026-09-01T00:00:01.000Z",
        },
        converged: false,
        replayed: false,
      };
    },
    release: async (command: Parameters<BudgetAuthority["release"]>[0], key: string) => {
      this.releaseCalls.push({ command: command as unknown as Record<string, unknown>, key });
      return {
        reservation: {
          id: `reservation-${this.counter}`,
          applicationId: command.applicationId,
          tenantId: "",
          executionId: "",
          operationId: command.operationId,
          userId: "",
          fundingMode: "developer" as const,
          sourceKind: "developer" as const,
          walletId: "wallet-1",
          amountMicroUsd: "0",
          status: "released" as const,
          settledAmountMicroUsd: null,
          monthKey: "2026-09",
          createdAt: "2026-09-01T00:00:00.000Z",
          finalizedAt: "2026-09-01T00:00:01.000Z",
        },
        converged: false,
        replayed: false,
      };
    },
  };
}

/** In-memory governed-tools world: real executions ledger, fake seams. */
export interface InMemoryToolsWorld {
  readonly executionStore: InMemoryExecutionStore;
  readonly executionService: ExecutionService;
  readonly toolStore: InMemoryToolInvocationStore;
  readonly admission: FakeToolAdmission;
  readonly capabilities: FakeCapabilityGate;
  readonly budgets: FakeBudgetAuthority;
  readonly runtime: ToolRuntime;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly actorId: string;
  registerTool(contract: ToolContract, adapter: ToolAdapter): Promise<void>;
  seedExecution(status?: ExecutionRecord["status"]): Promise<string>;
  actor(): { actorId: string; tenantId: string };
}

export interface ToolsWorldOptions {
  /** Pass `null` to construct the runtime with NO budget authority wired. */
  readonly budgetAuthority?: BudgetAuthority | null;
  readonly admission?: ToolAdmission;
  readonly capabilities?: ToolCapabilityResolution;
}

export function createInMemoryToolsWorld(options: ToolsWorldOptions = {}): InMemoryToolsWorld {
  const executionStore = new InMemoryExecutionStore();
  const idempotency = new InMemoryExecutionsIdempotency();
  idempotency.store = executionStore;
  let idCounter = 100;
  const generateId = () => {
    idCounter += 1;
    return `00000000-0000-7000-8000-${String(idCounter).padStart(12, "0")}`;
  };
  const executionService = createExecutionService({
    store: executionStore,
    idempotency,
    authorization: { evaluate: async () => ({ allowed: true }) },
    generateId,
    now: () => new Date("2026-09-15T12:00:00Z"),
  });
  const toolStore = new InMemoryToolInvocationStore();
  const admission = new FakeToolAdmission();
  const capabilities = new FakeCapabilityGate();
  const budgets = new FakeBudgetAuthority();
  const applicationId = "11111111-1111-7000-8000-000000000001";
  const tenantId = "00000000-0000-7000-8000-0000000000bb";
  const actorId = "00000000-0000-7000-8000-0000000000aa";
  executionStore.seedApplication(applicationId, tenantId);

  const registered = new Map<string, RegisteredTool>();
  const registry: ToolRegistry = {
    async register() {
      throw new Error("world registry is test-managed; use world.registerTool");
    },
    async resolve(toolId) {
      return registered.get(toolId) ?? null;
    },
    async listContracts() {
      return [...registered.values()].map((entry) => entry.contract);
    },
  };

  const runtime = createToolRuntime({
    registry,
    admission: options.admission ?? admission.impl,
    capabilities: options.capabilities ?? capabilities.impl,
    ...(options.budgetAuthority === null
      ? {}
      : { budgetAuthority: options.budgetAuthority ?? budgets.impl }),
    store: toolStore,
    ledger: createExecutionLedgerAdapter(executionService),
    generateId,
    now: () => new Date(),
    hashInput: (input) => `digest:${JSON.stringify(input)}`,
  });

  return {
    executionStore,
    executionService,
    toolStore,
    admission,
    capabilities,
    budgets,
    runtime,
    applicationId,
    tenantId,
    actorId,
    async registerTool(contract, adapter) {
      registered.set(contract.toolId, { contract, adapter });
    },
    async seedExecution(status: ExecutionRecord["status"] = "RUNNING") {
      const receipt = await executionService.createExecution(
        { applicationId, task: { kind: "summarize", input: "artifact-1" } },
        `create-${generateId()}`,
        { actorId, tenantId },
      );
      const executionId = receipt.executionId;
      if (status !== "CREATED") {
        await executionService.transition(
          { command: "authorize", actorId, applicationId, tenantId, executionId },
          `authorize-${generateId()}`,
        );
        if (status !== "AUTHORIZED") {
          await executionService.transition(
            { command: "plan", actorId, applicationId, tenantId, executionId },
            `plan-${generateId()}`,
          );
          if (status !== "PLANNING") {
            await executionService.transition(
              { command: "queue", actorId, applicationId, tenantId, executionId },
              `queue-${generateId()}`,
            );
            if (status !== "QUEUED") {
              await executionService.transition(
                { command: "start", actorId, applicationId, tenantId, executionId },
                `start-${generateId()}`,
              );
            }
          }
        }
      }
      return executionId;
    },
    actor() {
      return { actorId, tenantId };
    },
  };
}
