/**
 * Execution ledger port (tools module outbound; WORK-010, TOL-001/TOL-002).
 *
 * The tie-in to the executions module's EventEnvelope ledger — the SINGLE
 * canonical execution event path. Tool invocations are recorded as
 * execution step events (`execution.tool-requested`,
 * `execution.tool-result`, `execution.tool-denied`) THROUGH the executions
 * public service; the tools module never writes the executions tables
 * directly (physically module-private; architecturally the executions
 * module alone owns the ledger write path).
 *
 * This port is REQUIRED at runtime construction: a governed tool runtime
 * that cannot bind its evidence to the parent execution's ledger is not
 * constructible — "bypass the canonical execution event path" is
 * unrepresentable, not merely discouraged. There is no no-op
 * implementation in this module.
 */

import type { ExecutionRecord, StepEventCommand } from "../../executions/public";

export interface LedgerStepEvent {
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

export interface LedgerStepEventOutcome {
  readonly sequence: number;
  readonly type: string;
  readonly replayed: boolean;
}

export interface ExecutionLedger {
  /**
   * Append ONE step event on the canonical executions ledger
   * (idempotent per the runtime-supplied idempotency key; the executions
   * service owns sequencing, gaplessness and append-only enforcement).
   */
  recordStepEvent(event: LedgerStepEvent, idempotencyKey: string): Promise<LedgerStepEventOutcome>;

  /**
   * Tenant-guarded execution facts read (the runtime's identity/tenant
   * resolution input — the parent execution the invocation binds to).
   */
  getExecution(applicationId: string, executionId: string): Promise<ExecutionRecord | null>;
}
