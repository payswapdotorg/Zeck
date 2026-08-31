/**
 * Execution ledger adapter (sandbox module; WORK-012).
 *
 * Implements the sandbox module's REQUIRED `SandboxExecutionLedger` port
 * against the REAL executions module public service — the WORK-010/011
 * adapter discipline, applied to sandbox executions:
 *
 *   - sandbox step events flow through `recordStepEvent` (the canonical
 *     EventEnvelope ledger write path — the executions module alone owns
 *     sequencing, gaplessness, append-only enforcement and status
 *     preservation);
 *   - execution facts come from the tenant-guarded `getExecution` read.
 *
 * The sandbox module never touches the executions tables directly and
 * never moves execution status (no wait-human/resume transitions belong
 * to the sandbox axis — those are the agents approval gates). Type +
 * runtime coupling is to the executions PUBLIC barrel only.
 */

import type { ExecutionService } from "../../executions/public";
import type {
  LedgerStepEvent,
  LedgerStepEventOutcome,
  SandboxExecutionLedger,
} from "../ports/sandbox-ledger";

export function createSandboxExecutionLedgerAdapter(
  service: ExecutionService,
): SandboxExecutionLedger {
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

    async getExecution(applicationId: string, executionId: string) {
      return service.getExecution(applicationId, executionId);
    },
  };
}
