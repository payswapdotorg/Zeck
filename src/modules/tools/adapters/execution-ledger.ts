/**
 * Execution ledger adapter (tools module; WORK-010).
 *
 * Implements the tools module's REQUIRED `ExecutionLedger` port against the
 * REAL executions module public service: step events flow through
 * `recordStepEvent` (the canonical EventEnvelope ledger write path — the
 * executions module alone owns sequencing, gaplessness, append-only
 * enforcement and status preservation), and execution facts come from the
 * tenant-guarded `getExecution` read. The tools module never touches the
 * executions tables directly.
 *
 * Type + runtime coupling is to the executions PUBLIC barrel only.
 */

import type { ExecutionRecord, ExecutionService } from "../../executions/public";
import type {
  ExecutionLedger,
  LedgerStepEvent,
  LedgerStepEventOutcome,
} from "../ports/execution-ledger";

export function createExecutionLedgerAdapter(service: ExecutionService): ExecutionLedger {
  return {
    async recordStepEvent(
      event: LedgerStepEvent,
      idempotencyKey: string,
    ): Promise<LedgerStepEventOutcome> {
      const outcome = await service.recordStepEvent(
        {
          executionId: event.executionId,
          applicationId: event.applicationId,
          actor: event.actor,
          command: event.command,
          ...(event.cause === undefined ? {} : { cause: event.cause }),
          ...(event.reference === undefined ? {} : { reference: event.reference }),
          payload: event.payload,
        },
        idempotencyKey,
      );
      return { sequence: outcome.sequence, type: outcome.type, replayed: outcome.replayed };
    },

    async getExecution(
      applicationId: string,
      executionId: string,
    ): Promise<ExecutionRecord | null> {
      return service.getExecution(applicationId, executionId);
    },
  };
}
