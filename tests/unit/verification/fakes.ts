/**
 * In-memory fakes of the verification module ports (unit-test
 * infrastructure).
 *
 * Faithful to the durable contracts:
 *  - the execution fake rides the REAL executions state-machine table
 *    (`nextState`/`canTransition` from the executions public barrel —
 *    the single legality oracle; the fake only stores status/sequences);
 *  - the ledger fake records step events append-only per execution with
 *    gapless sequences (the recordStepEvent contract);
 *  - the transitions fake delegates legality to the same table and
 *    enforces the pass-requires-PASS-results completion binding;
 *  - the admission fake is a configurable spy (allow/deny per action)
 *    so the policy-gate discrimination proofs can observe consultation
 *    order and denial fail-closed behavior.
 *
 * True concurrency/locking cannot be simulated here — the
 * real-PostgreSQL suites own those proofs (WORK-002..011 precedent).
 */

import type {
  ExecutionRecord,
  StepEventCommand,
  VerificationResultInput,
} from "../../../src/modules/executions/public";
import { canTransition, nextState } from "../../../src/modules/executions/public";
import { createDeterministicEvaluatorBank } from "../../../src/modules/verification/adapters/deterministic-evaluators";
import { InMemoryVerificationStore } from "../../../src/modules/verification/adapters/in-memory-verification-store";
import { createModelJudgeEvaluator } from "../../../src/modules/verification/adapters/model-judge-evaluator";
import type { VerificationService } from "../../../src/modules/verification/application/verification-service";
import { createVerificationService } from "../../../src/modules/verification/application/verification-service";
import type { VerificationCriteria } from "../../../src/modules/verification/domain/criteria";
import type { Evaluator } from "../../../src/modules/verification/domain/evaluator";
import type { ModelJudgment } from "../../../src/modules/verification/ports/model-judge";
import type {
  VerificationAdmission,
  VerificationAdmissionAction,
  VerificationAdmissionDecision,
} from "../../../src/modules/verification/ports/verification-admission";
import type {
  ExecutionPassInput,
  ExecutionTransitionInput,
  ExecutionTransitionOutcome,
  ExecutionTransitionPort,
  VerificationLedger,
  VerificationLedgerEvent,
  VerificationLedgerOutcome,
} from "../../../src/modules/verification/ports/verification-ledger";
import { PlatformError } from "../../../src/shared/errors";

export const TENANT_ID = "00000000-0000-7000-8000-0000000000b1";
export const APPLICATION_ID = "00000000-0000-7000-8000-0000000000a1";
export const ACTOR_ID = "00000000-0000-7000-8000-0000000000c1";

export interface FakeExecution {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  status: string;
  lastEventSequence: number;
  verificationRefs: string[];
}

export interface LedgerEvent {
  readonly sequence: number;
  readonly command: StepEventCommand;
  readonly type: string;
  readonly reference: Readonly<Record<string, unknown>>;
}

export class FakeVerificationLedger implements VerificationLedger {
  readonly executions = new Map<string, FakeExecution>();
  readonly events = new Map<string, LedgerEvent[]>();
  private readonly eventKeys = new Set<string>();

  seedExecution(id: string, status = "RUNNING"): FakeExecution {
    const execution: FakeExecution = {
      id,
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      status,
      lastEventSequence: 1,
      verificationRefs: [],
    };
    this.executions.set(id, execution);
    this.events.set(id, []);
    return execution;
  }

  async recordStepEvent(
    event: VerificationLedgerEvent,
    idempotencyKey: string,
  ): Promise<VerificationLedgerOutcome> {
    const execution = this.executions.get(event.executionId);
    if (execution === undefined) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "execution not found in this application",
      });
    }
    if (["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(execution.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `execution is terminal in ${execution.status}`,
      });
    }
    if (this.eventKeys.has(idempotencyKey)) {
      const events = this.events.get(event.executionId) ?? [];
      const existing = [...events]
        .reverse()
        .find((entry) => entry.type === `execution.${event.command}`);
      return {
        sequence: existing?.sequence ?? execution.lastEventSequence,
        type: `execution.${event.command}`,
        replayed: true,
      };
    }
    this.eventKeys.add(idempotencyKey);
    const sequence = execution.lastEventSequence + 1;
    execution.lastEventSequence = sequence;
    const events = this.events.get(event.executionId) ?? [];
    events.push({
      sequence,
      command: event.command,
      type: `execution.${event.command}`,
      reference: event.reference ?? {},
    });
    this.events.set(event.executionId, events);
    return { sequence, type: `execution.${event.command}`, replayed: false };
  }

  async getExecution(applicationId: string, executionId: string) {
    const execution = this.executions.get(executionId);
    if (execution === undefined || execution.applicationId !== applicationId) {
      return null;
    }
    const record: ExecutionRecord = {
      id: execution.id,
      applicationId: execution.applicationId,
      tenantId: execution.tenantId,
      environmentId: null,
      userId: ACTOR_ID,
      task: {},
      inputArtifactRefs: [],
      constraints: null,
      metadata: {},
      requestFingerprint: "fp",
      status: execution.status as ExecutionRecord["status"],
      lastEventSequence: execution.lastEventSequence,
      verificationRefs: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      terminalAt: null,
    };
    return record;
  }
}

export class FakeExecutionTransitions implements ExecutionTransitionPort {
  constructor(private readonly ledger: FakeVerificationLedger) {}

  private async apply(
    command: "verify" | "pass",
    input: ExecutionTransitionInput,
    verificationResults?: readonly VerificationResultInput[],
  ): Promise<ExecutionTransitionOutcome> {
    const execution = this.ledger.executions.get(input.executionId);
    if (execution === undefined) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "execution not found in this application",
      });
    }
    if (!canTransition(execution.status as never, command)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `illegal ${command} from ${execution.status}`,
      });
    }
    if (command === "pass") {
      const results = verificationResults ?? [];
      if (!results.some((result) => result.status === "PASS")) {
        throw new PlatformError({
          code: "VERIFICATION_FAILED",
          message: "completion requires at least one PASS verification result",
        });
      }
      execution.verificationRefs = results.map((_, index) => `vref-${index + 1}`);
    }
    const from = execution.status;
    const to = nextState(execution.status as never, command);
    if (to === null) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `no target for ${command} from ${execution.status}`,
      });
    }
    execution.status = to;
    const sequence = execution.lastEventSequence + 1;
    execution.lastEventSequence = sequence;
    return { from, to, sequence, replayed: false };
  }

  verify(
    input: ExecutionTransitionInput,
    _idempotencyKey: string,
  ): Promise<ExecutionTransitionOutcome> {
    return this.apply("verify", input);
  }

  pass(input: ExecutionPassInput, _idempotencyKey: string): Promise<ExecutionTransitionOutcome> {
    return this.apply("pass", input, input.verificationResults);
  }
}

export type AdmissionRule = (
  action: VerificationAdmissionAction,
) => VerificationAdmissionDecision | undefined;

export class FakeVerificationAdmission implements VerificationAdmission {
  readonly calls: VerificationAdmissionAction[] = [];
  rule: AdmissionRule = () => ({ allowed: true });

  async admit(request: {
    action: VerificationAdmissionAction;
  }): Promise<VerificationAdmissionDecision> {
    this.calls.push(request.action);
    const decision = this.rule(request.action);
    return decision ?? { allowed: true };
  }
}

/** A scripted model judge (records requests; returns configured judgments). */
export class FakeModelJudge {
  readonly requests: unknown[] = [];
  judgment: (request: unknown) => ModelJudgment;

  constructor(judgment: (request: unknown) => ModelJudgment) {
    this.judgment = judgment;
  }

  async judge(request: unknown): Promise<ModelJudgment> {
    this.requests.push(request);
    return this.judgment(request);
  }
}

export interface InMemoryVerificationWorld {
  readonly store: InMemoryVerificationStore;
  readonly admission: FakeVerificationAdmission;
  readonly ledger: FakeVerificationLedger;
  readonly transitions: FakeExecutionTransitions;
  readonly service: VerificationService;
  readonly modelJudge: FakeModelJudge;
  declare(
    criteria: Partial<VerificationCriteria> & { criterionId: string },
    overrides?: { required?: boolean },
  ): Promise<void>;
  actor(): { actorId: string; tenantId: string };
  seedExecution(status?: string): string;
}

export function createInMemoryVerificationWorld(options?: {
  evaluators?: readonly Evaluator[];
}): InMemoryVerificationWorld {
  const store = new InMemoryVerificationStore();
  const admission = new FakeVerificationAdmission();
  const ledger = new FakeVerificationLedger();
  const transitions = new FakeExecutionTransitions(ledger);
  const modelJudge = new FakeModelJudge(() => ({
    criterionId: "",
    meetsCriteria: "unknown",
    rationale: "",
    judgeIdentity: {},
  }));
  const evaluators = options?.evaluators ?? [
    ...createDeterministicEvaluatorBank(),
    createModelJudgeEvaluator({
      judge: async (request) => modelJudge.judge(request),
    }),
  ];
  const service = createVerificationService({
    store,
    admission,
    ledger,
    transitions,
    evaluators,
    generateId: (() => {
      let counter = 0;
      return () => {
        counter += 1;
        return `00000000-0000-7000-8000-${String(counter).padStart(12, "0")}`;
      };
    })(),
    now: () => new Date("2026-01-01T00:00:00Z"),
    hashInput: (text) => `hash-${text.length}-${text.slice(0, 24)}`,
  });
  return {
    store,
    admission,
    ledger,
    transitions,
    service,
    modelJudge,
    async declare(criteria, overrides) {
      await service.declareCriteria({
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        criteria: {
          criterionId: criteria.criterionId,
          version: criteria.version ?? 1,
          kind: criteria.kind ?? "invariant",
          required: overrides?.required ?? criteria.required ?? true,
          description: criteria.description ?? `criterion ${criteria.criterionId}`,
          definition: criteria.definition ?? { assertions: [] },
        },
      });
    },
    actor: () => ({ actorId: ACTOR_ID, tenantId: TENANT_ID }),
    seedExecution(status) {
      const suffix = Math.floor(Math.random() * 0xffffffffffff)
        .toString(16)
        .padStart(12, "0");
      const executionId = `00000000-0000-7000-8000-${suffix}`;
      ledger.seedExecution(executionId, status);
      return executionId;
    },
  };
}
