/**
 * Agent execution-ledger port (agents module outbound; WORK-011,
 * AGT-008/ACP-006).
 *
 * The tie-in to the executions module's EventEnvelope ledger — the
 * SINGLE canonical execution event path (the WORK-010 `ExecutionLedger`
 * precedent). Agent session evidence (session start with inputs and
 * authorization context, significant actions, session completion with
 * outputs) rides the executions ledger as STEP EVENTS through the
 * executions public `recordStepEvent` seam — the same seam the merged
 * executions event vocabulary explicitly reserves for agents ("agents
 * (WORK-011) extend it through the same recordStepEvent seam").
 *
 * The agents module NEVER writes the executions tables directly
 * (discrimination M20: bypassing the canonical ledger is
 * unrepresentable): this port is REQUIRED at runtime construction — no
 * no-op implementation exists in this module. Execution facts come from
 * the tenant-guarded `getExecution` read; approval gates move execution
 * status ONLY through the public transition command surface
 * (`wait-human` / `resume`) exposed by the executions service.
 */

import type { ExecutionRecord, StepEventCommand } from "../../executions/public";

/** The agent step-event commands (vocabulary owned by executions). */
export type AgentStepEventCommand = Extract<
  StepEventCommand,
  "agent-session-started" | "agent-action-recorded" | "agent-session-completed"
>;

export interface LedgerStepEvent {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: {
    readonly actorId: string;
    readonly tenantId: string;
  };
  readonly command: AgentStepEventCommand;
  readonly cause?: string;
  readonly reference?: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface LedgerStepEventOutcome {
  readonly sequence: number;
  readonly type: string;
  readonly replayed: boolean;
}

export interface AgentExecutionLedger {
  /**
   * Append ONE agent step event on the canonical executions ledger
   * (idempotent per the supplied key; executions owns sequencing,
   * gaplessness, append-only enforcement and status preservation).
   */
  recordStepEvent(event: LedgerStepEvent, idempotencyKey: string): Promise<LedgerStepEventOutcome>;

  /**
   * Tenant-guarded execution facts read (the session's identity/tenant
   * resolution input — the parent execution the session binds to).
   */
  getExecution(applicationId: string, executionId: string): Promise<ExecutionRecord | null>;

  /**
   * Move the parent execution to WAITING_HUMAN for an outstanding
   * approval (the public transition command surface — the ONLY way
   * agents touch execution status).
   */
  waitHuman(
    input: {
      readonly applicationId: string;
      readonly tenantId: string;
      readonly actorId: string;
      readonly executionId: string;
      readonly reason: string;
      readonly reference?: Readonly<Record<string, unknown>>;
    },
    idempotencyKey: string,
  ): Promise<{ readonly sequence: number; readonly replayed: boolean }>;

  /**
   * Resume the parent execution from WAITING_HUMAN after an approval
   * decision (public transition command surface).
   */
  resume(
    input: {
      readonly applicationId: string;
      readonly tenantId: string;
      readonly actorId: string;
      readonly executionId: string;
      readonly reason: string;
      readonly reference?: Readonly<Record<string, unknown>>;
    },
    idempotencyKey: string,
  ): Promise<{ readonly sequence: number; readonly replayed: boolean }>;
}
