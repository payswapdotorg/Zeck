/**
 * Training execution-ledger adapter (sandbox module; WORK-030).
 *
 * Implements the sandbox module's REQUIRED `TrainingExecutionLedger`
 * port against the REAL executions module public service — the
 * WORK-012 `createSandboxExecutionLedgerAdapter` discipline applied to
 * the training axis:
 *
 *   - training step events flow through `recordStepEvent` (the
 *     canonical EventEnvelope ledger write path — the executions module
 *     alone owns sequencing, gaplessness, append-only enforcement and
 *     status preservation), using the EXISTING step-event vocabulary
 *     (WORK-030 adds no vocabulary; it produces events, owns none);
 *   - execution facts come from the tenant-guarded `getExecution` read.
 *
 * The sandbox module never touches the executions tables directly and
 * never moves execution status. Type + runtime coupling is to the
 * executions PUBLIC barrel only.
 */

import type { ExecutionService } from "../../executions/public";
import type {
  TrainingExecutionLedger,
  TrainingLedgerStepEvent,
  TrainingLedgerStepEventOutcome,
} from "../ports/training-ledger";

export function createTrainingExecutionLedgerAdapter(
  service: ExecutionService,
): TrainingExecutionLedger {
  return {
    async recordStepEvent(
      event: TrainingLedgerStepEvent,
      idempotencyKey: string,
    ): Promise<TrainingLedgerStepEventOutcome> {
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

    async getExecution(applicationId: string, executionId: string) {
      return service.getExecution(applicationId, executionId);
    },
  };
}
