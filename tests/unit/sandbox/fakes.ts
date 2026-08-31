/**
 * In-memory fakes of the sandbox module ports (unit-test infrastructure,
 * WORK-012 — the agents/tools `fakes.ts` discipline).
 *
 *  - `FakeSandboxAdmission`: a scriptable policy seam (the REAL policy
 *    engine backs it in the real-PG suites; here tests decide allow/deny
 *    deterministically);
 *  - `FakeCapabilityGate`: a scriptable capability seam;
 *  - `FakeExecutionLedger`: an in-memory EventEnvelope ledger faithful to
 *    the executions recordStepEvent contract (idempotent per key,
 *    append-only, terminal-execution rejection) plus a scriptable
 *    execution registry;
 *  - `RecordingSandboxProvider`: the SandboxProvider fake — records every
 *    runtime spec it receives and answers with a scripted observation.
 *
 * True concurrency/locking cannot be simulated here — the real-PostgreSQL
 * suites own those proofs (WORK-002..011 precedent).
 */

import type { ExecutionRecord, ExecutionStatus } from "../../../src/modules/executions/public";
import type {
  SandboxAdmission,
  SandboxAdmissionDecision,
  SandboxAdmissionRequest,
} from "../../../src/modules/sandbox/ports/sandbox-admission";
import type {
  LedgerStepEvent,
  LedgerStepEventOutcome,
} from "../../../src/modules/sandbox/ports/sandbox-ledger";
import type {
  SandboxExecutionObservation,
  SandboxProvider,
  SandboxRuntimeSpec,
} from "../../../src/modules/sandbox/ports/sandbox-provider";
import { PlatformError } from "../../../src/shared/errors";

export const APPLICATION_ID = "00000000-0000-7000-8000-0000000000b1";
export const TENANT_ID = "00000000-0000-7000-8000-0000000000a1";
export const OTHER_TENANT_ID = "00000000-0000-7000-8000-0000000000a2";
export const OTHER_APPLICATION_ID = "00000000-0000-7000-8000-0000000000b2";
export const ACTOR_ID = "00000000-0000-7000-8000-0000000000c1";

export interface LedgerEventEntry {
  readonly idempotencyKey: string;
  readonly event: LedgerStepEvent;
  readonly sequence: number;
}

export class FakeExecutionLedger {
  readonly events: LedgerEventEntry[] = [];
  /** executionId -> record (the tenant-guarded executions read). */
  readonly executions = new Map<string, ExecutionRecord>();
  private readonly sequences = new Map<string, number>();

  seedExecution(executionId: string, status: ExecutionStatus, tenantId = TENANT_ID): void {
    this.executions.set(executionId, {
      id: executionId,
      applicationId: APPLICATION_ID,
      tenantId,
      environmentId: "00000000-0000-7000-8000-0000000000e1",
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
    event: LedgerStepEvent,
    idempotencyKey: string,
  ): Promise<LedgerStepEventOutcome> {
    const existing = this.events.find((entry) => entry.idempotencyKey === idempotencyKey);
    if (existing !== undefined) {
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

  eventsOf(executionId: string): readonly LedgerEventEntry[] {
    return this.events.filter((entry) => entry.event.executionId === executionId);
  }
}

export class FakeSandboxAdmission implements SandboxAdmission {
  /** The requests the seam received (assertion surface). */
  readonly requests: SandboxAdmissionRequest[] = [];
  private script: ((request: SandboxAdmissionRequest) => SandboxAdmissionDecision) | null = null;
  private defaultDecision: SandboxAdmissionDecision = {
    allowed: true,
    evidence: {
      policySetId: "default",
      policySetVersion: 1,
      policyContentHash: "hash-1",
      restrictionSetDigest: "digest-1",
    },
  };

  decide(decision: SandboxAdmissionDecision): void {
    this.script = () => decision;
  }

  decideFor(predicate: (request: SandboxAdmissionRequest) => SandboxAdmissionDecision): void {
    this.script = predicate;
  }

  async admit(request: SandboxAdmissionRequest): Promise<SandboxAdmissionDecision> {
    this.requests.push(request);
    return this.script === null ? this.defaultDecision : this.script(request);
  }
}

export class FakeCapabilityGate {
  readonly profiles: unknown[] = [];
  private satisfied = true;
  private unmetReason: "unknown-capability" | "version-unavailable" | "invalid-requirement" =
    "unknown-capability";

  setSatisfied(
    satisfied: boolean,
    reason:
      | "unknown-capability"
      | "version-unavailable"
      | "invalid-requirement" = "unknown-capability",
  ): void {
    this.satisfied = satisfied;
    this.unmetReason = reason;
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

export class RecordingSandboxProvider implements SandboxProvider {
  readonly specs: SandboxRuntimeSpec[] = [];
  constructor(
    readonly runtimeKind: SandboxRuntimeSpec["kind"],
    private readonly observation:
      | SandboxExecutionObservation
      | ((spec: SandboxRuntimeSpec) => SandboxExecutionObservation),
  ) {}

  async execute(spec: SandboxRuntimeSpec): Promise<SandboxExecutionObservation> {
    this.specs.push(spec);
    return typeof this.observation === "function" ? this.observation(spec) : this.observation;
  }
}

export const SUCCESS_OBSERVATION: SandboxExecutionObservation = {
  outcomeClass: "sandbox-success",
  outputDigest: "digest:done",
  output: { exitCode: 0, stdout: "ok" },
  usageMicroUsd: "0",
  failure: null,
};

export const FAILURE_OBSERVATION: SandboxExecutionObservation = {
  outcomeClass: "sandbox-failure",
  outputDigest: null,
  output: null,
  usageMicroUsd: null,
  failure: {
    failureClass: "sandbox-execution",
    message: "exit code 1",
    retryable: false,
  },
};
