/**
 * Training execution-ledger port (sandbox module outbound; WORK-030).
 *
 * The tie-in to the executions module's EventEnvelope ledger — the
 * SINGLE canonical execution event path for the training axis. The
 * training service NEVER writes the executions tables directly and
 * never moves execution status; ALL training provenance (admission,
 * denial, checkpoint emission, interruption, resume, completion) rides
 * the ledger as STEP EVENTS through the executions public
 * `recordStepEvent` seam, using the EXISTING step-event vocabulary
 * (the executions module remains the single event-vocabulary owner;
 * WORK-030 adds no vocabulary — it produces events, owns none):
 *
 *   - `sandbox-admitted` / `sandbox-denied` / `sandbox-completed`:
 *     the training workload IS a sandbox-axis admission (it executes
 *     in a governed compute/accelerator environment through the same
 *     admission chain discipline);
 *   - `checkpoint-recorded`: every emitted training checkpoint;
 *   - `interruption-requested`: the governed cancellation;
 *   - `resume-recorded` / `resume-denied`: the resume/re-admission
 *     outcomes (the WORK-028 long-running vocabulary — semantically
 *     exactly the training resume).
 *
 * Execution facts come from the tenant-guarded `getExecution` read.
 */

import type { ExecutionRecord, StepEventCommand } from "../../executions/public";

/** The training step-event commands (existing vocabulary, owned by executions). */
export type TrainingStepEventCommand = Extract<
  StepEventCommand,
  | "sandbox-admitted"
  | "sandbox-denied"
  | "sandbox-completed"
  | "checkpoint-recorded"
  | "interruption-requested"
  | "resume-recorded"
  | "resume-denied"
>;

export interface TrainingLedgerStepEvent {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: {
    readonly actorId: string;
    readonly tenantId: string;
  };
  readonly command: TrainingStepEventCommand;
  readonly cause?: string;
  readonly reference?: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface TrainingLedgerStepEventOutcome {
  readonly sequence: number;
  readonly type: string;
  readonly replayed: boolean;
}

export interface TrainingExecutionLedger {
  /**
   * Append ONE training step event on the canonical executions ledger
   * (idempotent per the supplied key; executions owns sequencing,
   * gaplessness, append-only enforcement and status preservation).
   */
  recordStepEvent(
    event: TrainingLedgerStepEvent,
    idempotencyKey: string,
  ): Promise<TrainingLedgerStepEventOutcome>;

  /** Tenant-guarded execution facts read (the parent execution). */
  getExecution(applicationId: string, executionId: string): Promise<ExecutionRecord | null>;
}
