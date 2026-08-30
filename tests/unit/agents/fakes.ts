/**
 * In-memory fakes of the agents module ports (unit-test infrastructure,
 * WORK-011 — the tools `fakes.ts` discipline).
 *
 *  - `FakeAgentAdmission`: a scriptable policy seam (the REAL policy
 *    engine backs it in the real-PG suites; here tests decide allow/deny
 *    and the effective permission intersection deterministically);
 *  - `FakeExecutionLedger`: an in-memory EventEnvelope ledger faithful to
 *    the executions recordStepEvent contract (idempotent per key,
 *    append-only, terminal-execution rejection) plus a scriptable
 *    execution registry and wait-human/resume transition journal;
 *  - `RecordingAgentProvider`: the AgentProvider fake — records every
 *    runtime identity + task it receives and answers with a scripted
 *    observation.
 *
 * True concurrency/locking cannot be simulated here — the real-PostgreSQL
 * suites own those proofs (WORK-002..010 precedent).
 */

import type {
  AgentAdmission,
  AgentAdmissionDecision,
  AgentAdmissionRequest,
} from "../../../src/modules/agents/ports/agent-admission";
import type {
  AgentExecutionLedger,
  LedgerStepEvent,
  LedgerStepEventOutcome,
} from "../../../src/modules/agents/ports/agent-execution-ledger";
import type {
  AgentProvider,
  AgentRuntimeIdentity,
  AgentSessionObservation,
  AgentSessionTask,
} from "../../../src/modules/agents/ports/agent-provider";
import type { ExecutionRecord, ExecutionStatus } from "../../../src/modules/executions/public";
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

export class FakeExecutionLedger implements AgentExecutionLedger {
  readonly events: LedgerEventEntry[] = [];
  readonly transitions: Array<{
    readonly command: "wait-human" | "resume";
    readonly executionId: string;
    readonly reason: string;
    readonly reference?: Readonly<Record<string, unknown>>;
    readonly sequence: number;
  }> = [];
  /** executionId -> record (the tenant-guarded executions read). */
  readonly executions = new Map<string, ExecutionRecord>();
  private nextSequence = 1;
  private readonly sequences = new Map<string, number>();
  private transitionFailures: Array<(command: string, executionId: string) => string | null> = [];

  seedExecution(executionId: string, status: ExecutionStatus, tenantId = TENANT_ID): void {
    this.executions.set(executionId, {
      id: executionId,
      applicationId: APPLICATION_ID,
      tenantId,
      environmentId: "00000000-0000-7000-8000-0000000000e1",
      userId: null,
      task: { kind: "summarize", input: "artifact-1" },
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

  /** Script a transition failure (e.g. wrong execution state). */
  failTransitionOn(predicate: (command: string, executionId: string) => string | null): void {
    this.transitionFailures.push(predicate);
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

  async waitHuman(
    input: Parameters<AgentExecutionLedger["waitHuman"]>[0],
    _idempotencyKey: string,
  ): Promise<{ readonly sequence: number; readonly replayed: boolean }> {
    const failure = this.transitionFailures
      .map((predicate) => predicate("wait-human", input.executionId))
      .find((message) => message !== null);
    if (failure !== undefined) {
      throw new PlatformError({ code: "INVALID_STATE_TRANSITION", message: failure });
    }
    const existing = this.transitions.find(
      (t) => t.command === "wait-human" && t.executionId === input.executionId,
    );
    if (existing !== undefined) {
      return { sequence: existing.sequence, replayed: true };
    }
    const sequence = this.nextSequence++;
    this.transitions.push({
      command: "wait-human",
      executionId: input.executionId,
      reason: input.reason,
      ...(input.reference === undefined ? {} : { reference: input.reference }),
      sequence,
    });
    return { sequence, replayed: false };
  }

  async resume(
    input: Parameters<AgentExecutionLedger["resume"]>[0],
    _idempotencyKey: string,
  ): Promise<{ readonly sequence: number; readonly replayed: boolean }> {
    const failure = this.transitionFailures
      .map((predicate) => predicate("resume", input.executionId))
      .find((message) => message !== null);
    if (failure !== undefined) {
      throw new PlatformError({ code: "INVALID_STATE_TRANSITION", message: failure });
    }
    const existing = this.transitions.find(
      (t) => t.command === "resume" && t.executionId === input.executionId,
    );
    if (existing !== undefined) {
      return { sequence: existing.sequence, replayed: true };
    }
    const sequence = this.nextSequence++;
    this.transitions.push({
      command: "resume",
      executionId: input.executionId,
      reason: input.reason,
      ...(input.reference === undefined ? {} : { reference: input.reference }),
      sequence,
    });
    return { sequence, replayed: false };
  }
}

export class FakeAgentAdmission implements AgentAdmission {
  readonly requests: AgentAdmissionRequest[] = [];
  behavior: (request: AgentAdmissionRequest) => Promise<AgentAdmissionDecision> = async () => ({
    allowed: true,
    effectivePermissions: { tools: [], secretRefs: [], models: [] },
    autonomy: "unconstrained",
    evidence: {
      policySetId: "default",
      policySetVersion: 1,
      policyContentHash: "hash-1",
      restrictionSetDigest: "digest-1",
    },
  });

  async admit(request: AgentAdmissionRequest): Promise<AgentAdmissionDecision> {
    this.requests.push(request);
    return this.behavior(request);
  }
}

export class RecordingAgentProvider implements AgentProvider {
  readonly runtimeKind: string;
  readonly identities: AgentRuntimeIdentity[] = [];
  readonly tasks: AgentSessionTask[] = [];
  behavior: (
    identity: AgentRuntimeIdentity,
    task: AgentSessionTask,
  ) => Promise<AgentSessionObservation> = async () => ({
    outcomeClass: "session-success",
    outputDigest: "digest:done",
    output: { done: true },
    failureReason: null,
  });

  constructor(runtimeKind: string) {
    this.runtimeKind = runtimeKind;
  }

  async executeSession(
    identity: Readonly<AgentRuntimeIdentity>,
    task: Readonly<AgentSessionTask>,
  ): Promise<AgentSessionObservation> {
    this.identities.push(identity);
    this.tasks.push(task);
    return this.behavior(identity, task);
  }
}

/** A baseline permissive admission decision for a requested set. */
export function allowAll(request: AgentAdmissionRequest): AgentAdmissionDecision {
  return {
    allowed: true,
    effectivePermissions: {
      tools: [...request.requestedPermissions.tools],
      secretRefs: [...request.requestedPermissions.secretRefs],
      models: [...(request.requestedPermissions.models ?? [])],
    },
    autonomy: request.requestedAutonomy,
    evidence: {
      policySetId: "default",
      policySetVersion: 1,
      policyContentHash: "hash-1",
      restrictionSetDigest: "digest-1",
    },
  };
}
