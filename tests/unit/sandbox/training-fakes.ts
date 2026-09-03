/**
 * In-memory fakes of the training/accelerator port family (unit-test
 * infrastructure, WORK-030 — the WORK-012 sandbox fakes discipline
 * applied to the training axis).
 *
 *  - `FakeTrainingAdmission`: a scriptable policy seam (the REAL policy
 *    engine backs it in the real-PG suites; here tests decide
 *    allow/deny deterministically) with the request log;
 *  - `FakeSubstrateCatalog`: a scriptable provider-neutral selection
 *    seam (returns a fixed claim-evidence selection or null — the
 *    CAPABILITY_UNAVAILABLE proof);
 *  - `FakeTrainingCapabilities`: a scriptable capability-resolution seam;
 *  - `FakeTrainingBudget`: the budgets-authority model with the ORDER
 *    LOG (the budget-before-paid-allocation witness), operation-keyed
 *    convergence and a fail-closed reserve switch;
 *  - `FakeTrainingLedger`: an in-memory EventEnvelope ledger faithful
 *    to the executions recordStepEvent contract (idempotent per key,
 *    append-only) plus a scriptable execution registry;
 *  - `FakeTrainingVerification`: the verification-gate model (verdict
 *    configurable, keyed-idempotent);
 *  - the SIMULATED accelerator substrate: the real accelerators
 *    integration fleet + runtime adapter behind the sandbox module's
 *    provider-neutral port (the substitution discrimination swaps a
 *    second fleet behind the SAME contract).
 *
 * True concurrency/locking cannot be simulated here — the real-PostgreSQL
 * suites own those proofs (the standing precedent).
 */

import { createHash } from "node:crypto";
import type { ExecutionRecord, ExecutionStatus } from "../../../src/modules/executions/public";
import type { SubstrateSelection } from "../../../src/modules/sandbox/ports/accelerator-substrate";
import type {
  TrainingAdmissionDecision,
  TrainingAdmissionRequest,
} from "../../../src/modules/sandbox/ports/training-admission";
import type {
  TrainingLedgerStepEvent,
  TrainingLedgerStepEventOutcome,
} from "../../../src/modules/sandbox/ports/training-ledger";
import type {
  TrainingVerificationRequest,
  TrainingVerificationVerdict,
} from "../../../src/modules/sandbox/ports/training-verification";
import type { AcceleratorResourceRequest } from "../../../src/modules/sandbox/public";
import { PlatformError } from "../../../src/shared/errors";

export const TR_APPLICATION_ID = "00000000-0000-7000-8000-0000000000b1";
export const TR_TENANT_ID = "00000000-0000-7000-8000-0000000000a1";
export const TR_OTHER_TENANT_ID = "00000000-0000-7000-8000-0000000000a2";
export const TR_OTHER_APPLICATION_ID = "00000000-0000-7000-8000-0000000000b2";
export const TR_ACTOR_ID = "00000000-0000-7000-8000-0000000000c1";
export const TR_EXECUTION_ID = "00000000-0000-7000-8000-0000000000e1";
export const TR_OTHER_TENANT_EXECUTION_ID = "00000000-0000-7000-8000-0000000000e2";

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** The neutral substrate selection evidence the fake catalog returns. */
export function substrateSelectionOf(
  substrateId: string,
  adapterRef: string,
  overrides: Partial<SubstrateSelection> = {},
): SubstrateSelection {
  return {
    substrateId,
    version: "1.2.0",
    adapterRef,
    digest: sha256Hex(`substrate:${substrateId}`),
    executionCapabilityId: "accelerator-gpu",
    resource: {
      cpuMilliCores: 16_000,
      memoryMiB: 65_536,
      estimatedDurationMs: 3_600_000,
      estimatedCostMicroUsd: "1000",
    },
    isolation: "container",
    ...overrides,
  };
}

export class FakeTrainingAdmission {
  readonly requests: TrainingAdmissionRequest[] = [];
  private denyReason: string | null = null;

  deny(reason = "fixture policy denial"): void {
    this.denyReason = reason;
  }

  allow(): void {
    this.denyReason = null;
  }

  readonly admit = async (
    request: TrainingAdmissionRequest,
  ): Promise<TrainingAdmissionDecision> => {
    this.requests.push(request);
    if (this.denyReason !== null) {
      return { allowed: false, reason: this.denyReason };
    }
    return {
      allowed: true,
      evidence: {
        policySetId: "ps-training-1",
        policySetVersion: 1,
        policyContentHash: "hash-tr1",
        restrictionSetDigest: "digest-tr1",
      },
    };
  };
}

export class FakeSubstrateCatalog {
  readonly requests: Array<{
    readonly workloadKind: string;
    readonly request: AcceleratorResourceRequest;
  }> = [];
  private selection: SubstrateSelection | null = null;

  offer(selection: SubstrateSelection | null): void {
    this.selection = selection;
  }

  readonly select = async (
    _applicationId: string,
    workloadKind: string,
    request: AcceleratorResourceRequest,
  ): Promise<SubstrateSelection | null> => {
    this.requests.push({ workloadKind, request });
    return this.selection;
  };
}

export class FakeTrainingCapabilities {
  readonly profiles: unknown[] = [];
  private satisfied = true;
  private unmetReason: "unknown-capability" | "version-unavailable" | "invalid-requirement" =
    "unknown-capability";

  setSatisfied(satisfied: boolean): void {
    this.satisfied = satisfied;
  }

  readonly resolve = async (profile: { requirements: readonly unknown[] }) => {
    this.profiles.push(profile);
    if (this.satisfied) {
      return {
        satisfied: true as const,
        catalogRevision: "rev-1",
        satisfactions: profile.requirements.map((requirement) => {
          const req = requirement as { id: string };
          return {
            requirementId: req.id,
            claimId: `${req.id}-claim`,
            claimKind: "runtime" as const,
            claimVersion: "1.0.0",
            evidenceKind: "catalog-seeded" as const,
            evidenceReference: "seed",
            publisher: "seed",
          };
        }),
      };
    }
    return {
      satisfied: false as const,
      catalogRevision: "rev-1",
      unmet: profile.requirements.map((requirement) => {
        const req = requirement as { id: string };
        return {
          requirementId: req.id,
          kind: "runtime" as const,
          reason: this.unmetReason,
          minVersion: null,
        };
      }),
    };
  };
}

/** The budgets-authority model: the ORDER LOG is the discrimination witness. */
export class FakeTrainingBudget {
  readonly log: string[] = [];
  readonly reserves: Array<Record<string, unknown>> = [];
  readonly settles: Array<Record<string, unknown>> = [];
  readonly releases: Array<Record<string, unknown>> = [];
  failReserve = false;
  private readonly reservedOperations = new Set<string>();
  private readonly settledOperations = new Set<string>();
  private readonly releasedOperations = new Set<string>();

  private reservationOf(command: { readonly operationId: string }): unknown {
    // A structurally-complete reservation record (cast once — the fake
    // models the authority's KEYED ledger, not its row shape).
    return {
      id: `resv-${command.operationId}`,
      applicationId: TR_APPLICATION_ID,
      tenantId: TR_TENANT_ID,
      executionId: TR_EXECUTION_ID,
      operationId: command.operationId,
      userId: "",
      fundingMode: "platform",
      sourceKind: "platform-credit",
      walletId: null,
      amountMicroUsd: "80000",
      status: "reserved",
      settledAmountMicroUsd: null,
      monthKey: "2026-09",
      createdAt: new Date().toISOString(),
      finalizedAt: null,
    };
  }

  async reserve(command: {
    readonly operationId: string;
    readonly amountMicroUsd: string;
  }): Promise<{
    readonly reservation: never;
    readonly converged: boolean;
    readonly replayed: boolean;
  }> {
    this.log.push(`budget-reserve:${command.operationId}`);
    if (this.reservedOperations.has(command.operationId)) {
      return {
        reservation: this.reservationOf(command) as never,
        converged: true,
        replayed: true,
      };
    }
    if (this.failReserve) {
      // NOTHING is recorded on a failed reserve — the fail-closed denial
      // leaves zero durable reservation activity (the physical witness
      // the budget-before-allocation discrimination inspects).
      throw new PlatformError({ code: "BUDGET_EXCEEDED", message: "fixture exhausted budget" });
    }
    this.reserves.push(command as unknown as Record<string, unknown>);
    this.reservedOperations.add(command.operationId);
    return {
      reservation: this.reservationOf(command) as never,
      converged: false,
      replayed: false,
    };
  }

  async settle(command: { readonly operationId: string }): Promise<{
    readonly reservation: never;
    readonly converged: boolean;
    readonly replayed: boolean;
  }> {
    this.log.push(`budget-settle:${command.operationId}`);
    const replayed = this.settledOperations.has(command.operationId);
    this.settledOperations.add(command.operationId);
    if (!replayed) {
      this.settles.push(command as unknown as Record<string, unknown>);
    }
    return {
      reservation: this.reservationOf(command) as never,
      converged: replayed,
      replayed,
    };
  }

  async release(command: { readonly operationId: string }): Promise<{
    readonly reservation: never;
    readonly converged: boolean;
    readonly replayed: boolean;
  }> {
    this.log.push(`budget-release:${command.operationId}`);
    const replayed = this.releasedOperations.has(command.operationId);
    this.releasedOperations.add(command.operationId);
    if (!replayed) {
      this.releases.push(command as unknown as Record<string, unknown>);
    }
    return {
      reservation: this.reservationOf(command) as never,
      converged: replayed,
      replayed,
    };
  }

  reservedOperations_(): readonly string[] {
    return [...this.reservedOperations];
  }
}

export interface TrainingLedgerEventEntry {
  readonly idempotencyKey: string;
  readonly event: TrainingLedgerStepEvent;
  readonly sequence: number;
}

export class FakeTrainingLedger {
  readonly events: TrainingLedgerEventEntry[] = [];
  readonly executions = new Map<string, ExecutionRecord>();
  private readonly sequences = new Map<string, number>();

  seedExecution(executionId: string, status: ExecutionStatus, tenantId = TR_TENANT_ID): void {
    this.executions.set(executionId, {
      id: executionId,
      applicationId: TR_APPLICATION_ID,
      tenantId,
      environmentId: "00000000-0000-7000-8000-0000000000ee",
      userId: null,
      task: { kind: "run-program", input: "artifact-1" },
      inputArtifactRefs: [],
      constraints: {},
      metadata: {},
      status,
      lastEventSequence: 0,
      verificationRefs: [],
      createdAt: new Date().toISOString(),
      terminalAt: null,
    } as unknown as ExecutionRecord);
  }

  async recordStepEvent(
    event: TrainingLedgerStepEvent,
    idempotencyKey: string,
  ): Promise<TrainingLedgerStepEventOutcome> {
    const existing = this.events.find((entry) => entry.idempotencyKey === idempotencyKey);
    if (existing !== undefined) {
      if (JSON.stringify(existing.event.payload) !== JSON.stringify(event.payload)) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "the ledger key was already used with a different payload",
        });
      }
      return { sequence: existing.sequence, type: `execution.${event.command}`, replayed: true };
    }
    const execution = this.executions.get(event.executionId);
    if (execution === undefined || execution.applicationId !== event.applicationId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "execution does not exist in this application",
      });
    }
    if (["FAILED", "CANCELLED", "EXPIRED", "COMPLETED"].includes(execution.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `execution is terminal (${execution.status})`,
      });
    }
    const perExecution = this.sequences.get(event.executionId) ?? 0;
    const sequence = perExecution + 1;
    this.sequences.set(event.executionId, sequence);
    this.events.push({ idempotencyKey, event, sequence });
    return { sequence, type: `execution.${event.command}`, replayed: false };
  }

  async getExecution(applicationId: string, executionId: string): Promise<ExecutionRecord | null> {
    const execution = this.executions.get(executionId);
    return execution !== undefined && execution.applicationId === applicationId ? execution : null;
  }

  eventsOf(executionId: string): readonly TrainingLedgerEventEntry[] {
    return this.events.filter((entry) => entry.event.executionId === executionId);
  }

  commandsOf(executionId: string): readonly string[] {
    return this.eventsOf(executionId).map((entry) => entry.event.command);
  }
}

export class FakeTrainingVerification {
  readonly requests: TrainingVerificationRequest[] = [];
  verdict: "pass" | "fail" = "pass";
  private seq = 0;
  private readonly byKey = new Map<string, { verdict: string; evaluationId: string }>();

  async verify(
    request: TrainingVerificationRequest,
    idempotencyKey: string,
  ): Promise<TrainingVerificationVerdict> {
    this.requests.push(request);
    const existing = this.byKey.get(idempotencyKey);
    if (existing !== undefined) {
      return {
        passed: existing.verdict === "pass",
        evaluationId: existing.evaluationId,
        conclusion: existing.verdict,
      };
    }
    this.seq += 1;
    const evaluationId = `eval-${this.seq}`;
    this.byKey.set(idempotencyKey, { verdict: this.verdict, evaluationId });
    return {
      passed: this.verdict === "pass",
      evaluationId,
      conclusion: this.verdict === "pass" ? "pass" : "required criteria unmet: fixture",
    };
  }
}
