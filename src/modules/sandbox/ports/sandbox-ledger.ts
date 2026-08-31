/**
 * Sandbox execution-ledger port (sandbox module outbound; WORK-012).
 *
 * The tie-in to the executions module's EventEnvelope ledger — the
 * SINGLE canonical execution event path (the WORK-010/011 precedent).
 * Sandbox admission, denial and completion evidence rides the executions
 * ledger as STEP EVENTS through the executions public `recordStepEvent`
 * seam — the same seam the merged event vocabulary explicitly reserves
 * for module extensions ("tools (WORK-010) … agents (WORK-011) extend it
 * through the same recordStepEvent seam"; WORK-012 extends it additively
 * with the sandbox commands).
 *
 * The sandbox module NEVER writes the executions tables directly
 * (discrimination M16-class: bypassing the canonical ledger is
 * unrepresentable): this port is REQUIRED at service construction — no
 * no-op implementation exists in this module. Execution facts come from
 * the tenant-guarded `getExecution` read; the sandbox module never moves
 * execution status (no approval-gate transitions belong to this axis).
 */

import type { ExecutionRecord, StepEventCommand } from "../../executions/public";

/** The sandbox step-event commands (vocabulary owned by executions). */
export type SandboxStepEventCommand = Extract<
  StepEventCommand,
  "sandbox-admitted" | "sandbox-denied" | "sandbox-completed"
>;

export interface LedgerStepEvent {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: {
    readonly actorId: string;
    readonly tenantId: string;
  };
  readonly command: SandboxStepEventCommand;
  readonly cause?: string;
  readonly reference?: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface LedgerStepEventOutcome {
  readonly sequence: number;
  readonly type: string;
  readonly replayed: boolean;
}

export interface SandboxExecutionLedger {
  /**
   * Append ONE sandbox step event on the canonical executions ledger
   * (idempotent per the supplied key; executions owns sequencing,
   * gaplessness, append-only enforcement and status preservation).
   */
  recordStepEvent(event: LedgerStepEvent, idempotencyKey: string): Promise<LedgerStepEventOutcome>;

  /**
   * Tenant-guarded execution facts read (the sandbox's identity/tenant
   * resolution input — the parent execution the sandbox binds to).
   */
  getExecution(applicationId: string, executionId: string): Promise<ExecutionRecord | null>;
}
