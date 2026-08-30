/**
 * Verification ledger + transition ports (verification module outbound;
 * WORK-013).
 *
 * The tie-in to the executions module — the SINGLE canonical execution
 * evidence path and the SINGLE execution state machine authority:
 *
 *   - verification evidence (requested/recorded/human/comparison step
 *     events) rides the executions module's EventEnvelope ledger through
 *     `recordStepEvent` — the verification module NEVER writes the
 *     executions tables directly (M13: writing around the canonical
 *     ledger is unrepresentable, not merely discouraged);
 *   - execution lifecycle transitions the verification path needs
 *     (`verify` RUNNING→VERIFYING, `pass` VERIFYING→COMPLETED) are
 *     issued THROUGH the executions service (the state-machine
 *     authority) — the verification module holds no transition table and
 *     no second state machine (M14);
 *   - execution facts (tenant binding, status) come from the
 *     tenant-guarded `getExecution` read.
 *
 * Both seams are REQUIRED at service construction — a verification
 * service that cannot bind its evidence to the parent execution's
 * ledger cannot be constructed. No no-op implementation exists here.
 */

import type {
  ExecutionRecord,
  StepEventCommand,
  VerificationResultInput,
} from "../../executions/public";

export interface VerificationLedgerEvent {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: {
    readonly actorId: string;
    readonly tenantId: string;
  };
  readonly command: StepEventCommand;
  readonly cause?: string;
  readonly reference?: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface VerificationLedgerOutcome {
  readonly sequence: number;
  readonly type: string;
  readonly replayed: boolean;
}

export interface VerificationLedger {
  /**
   * Append ONE step event on the canonical executions ledger (idempotent
   * per the runtime-supplied idempotency key; the executions service owns
   * sequencing, gaplessness, append-only enforcement and status
   * preservation).
   */
  recordStepEvent(
    event: VerificationLedgerEvent,
    idempotencyKey: string,
  ): Promise<VerificationLedgerOutcome>;

  /** Tenant-guarded execution facts read. */
  getExecution(applicationId: string, executionId: string): Promise<ExecutionRecord | null>;
}

export interface ExecutionTransitionInput {
  readonly executionId: string;
  readonly applicationId: string;
  readonly actor: {
    readonly actorId: string;
    readonly tenantId: string;
  };
  readonly reason?: string;
}

export interface ExecutionTransitionOutcome {
  readonly from: string;
  readonly to: string;
  readonly sequence: number;
  readonly replayed: boolean;
}

export interface ExecutionPassInput extends ExecutionTransitionInput {
  /**
   * The durable verification results binding the completion (at least
   * one PASS — the executions authority enforces the completion binding
   * physically; these inputs are derived from THIS module's durable
   * results, never fabricated).
   */
  readonly verificationResults: readonly VerificationResultInput[];
}

/**
 * The execution lifecycle commands the verification path may issue —
 * ONLY these. `replan`, `fail`, `wait-human` and every other transition
 * belong to the planner/orchestrator boundary (the verifier reports; the
 * planner decides).
 */
export interface ExecutionTransitionPort {
  /** RUNNING → VERIFYING (the verification step of the execution). */
  verify(
    input: ExecutionTransitionInput,
    idempotencyKey: string,
  ): Promise<ExecutionTransitionOutcome>;
  /** VERIFYING → COMPLETED, bound to at least one PASS verification result. */
  pass(input: ExecutionPassInput, idempotencyKey: string): Promise<ExecutionTransitionOutcome>;
}
