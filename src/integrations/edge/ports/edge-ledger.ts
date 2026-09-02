/**
 * Edge execution-ledger port (edge integration outbound; WORK-029,
 * EDGE-003/AC-3 — the provenance seam).
 *
 * The tie-in to the executions module's EventEnvelope ledger — the
 * SINGLE canonical execution event path (the WORK-010/011/027
 * discipline). Edge evidence (device admission/denial, envelope
 * admission, command request/result/denial, sensor observations,
 * actuation confirmations/violations, reconciliations) rides the SAME
 * ledger as STEP EVENTS through the executions public
 * `recordStepEvent` seam, reusing the tools producer vocabulary
 * `tool-requested` / `tool-result` / `tool-denied` (the WORK-027
 * precedent): this integration owns NO ledger vocabulary and NEVER
 * writes the executions tables directly.
 *
 * The human-approval gate manifests on the executions lifecycle
 * through the PUBLIC transition command surface (`wait-human` /
 * `resume`) — the ONLY way this integration touches execution status
 * (the WORK-011 agents pattern, reused; there is no second execution
 * state machine anywhere in the edge fabric).
 */

import type { ExecutionRecord, StepEventCommand } from "../../../modules/executions/public";

/** The tools producer-vocabulary step events edge evidence rides. */
export type EdgeStepEventCommand = Extract<
  StepEventCommand,
  "tool-requested" | "tool-result" | "tool-denied"
>;

export interface EdgeLedgerStepEvent {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: {
    readonly actorId: string;
    readonly tenantId: string;
  };
  readonly command: EdgeStepEventCommand;
  readonly cause?: string;
  readonly reference?: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EdgeLedgerStepEventOutcome {
  readonly sequence: number;
  readonly type: string;
  readonly replayed: boolean;
}

export interface EdgeExecutionLedger {
  /**
   * Append ONE step event on the canonical executions ledger
   * (idempotent per the supplied key; executions owns sequencing,
   * gaplessness, append-only enforcement and status preservation).
   */
  recordStepEvent(
    event: EdgeLedgerStepEvent,
    idempotencyKey: string,
  ): Promise<EdgeLedgerStepEventOutcome>;

  /** Tenant-guarded execution facts read. */
  getExecution(applicationId: string, executionId: string): Promise<ExecutionRecord | null>;

  /**
   * Move the parent execution to WAITING_HUMAN for an outstanding edge
   * approval (the public transition command surface — the ONLY way
   * this integration touches execution status).
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
