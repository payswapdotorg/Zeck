/**
 * Execution ledger adapter (edge integration; WORK-029, EDGE-003 — the
 * provenance seam).
 *
 * Implements the edge integration's REQUIRED `EdgeExecutionLedger` port
 * against the REAL executions module public service — the exact
 * discipline of the tools module's `execution-ledger.ts` (WORK-010):
 *
 *   - step events flow through `recordStepEvent` (the canonical
 *     EventEnvelope ledger write path — the executions module alone owns
 *     sequencing, gaplessness, append-only enforcement and status
 *     preservation), with the TOOLS producer vocabulary
 *     tool-requested / tool-result / tool-denied ONLY (this integration
 *     owns no ledger vocabulary);
 *   - execution facts come from the tenant-guarded `getExecution` read;
 *   - the human gate manifests on the executions lifecycle through the
 *     PUBLIC transition command surface (`wait-human` / `resume`) — the
 *     ONLY way this integration touches execution status (the WORK-011
 *     agent-approval pattern, reused; there is no second execution state
 *     machine anywhere in the edge fabric).
 *
 * The edge integration never touches the executions tables directly.
 * Type + runtime coupling is to the executions PUBLIC barrel only.
 */

import type { ExecutionRecord, ExecutionService } from "../../../modules/executions/public";
import type {
  EdgeExecutionLedger,
  EdgeLedgerStepEvent,
  EdgeLedgerStepEventOutcome,
} from "../ports/edge-ledger";

export function createEdgeExecutionLedgerAdapter(service: ExecutionService): EdgeExecutionLedger {
  return {
    async recordStepEvent(
      event: EdgeLedgerStepEvent,
      idempotencyKey: string,
    ): Promise<EdgeLedgerStepEventOutcome> {
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

    async waitHuman(
      input: {
        readonly applicationId: string;
        readonly tenantId: string;
        readonly actorId: string;
        readonly executionId: string;
        readonly reason: string;
        readonly reference?: Readonly<Record<string, unknown>>;
      },
      idempotencyKey: string,
    ): Promise<{ readonly sequence: number; readonly replayed: boolean }> {
      void input.reference; // the public transition surface carries `reason` only
      const outcome = await service.transition(
        {
          actorId: input.actorId,
          applicationId: input.applicationId,
          tenantId: input.tenantId,
          executionId: input.executionId,
          command: "wait-human",
          reason: input.reason,
        },
        idempotencyKey,
      );
      return { sequence: outcome.applied.sequence, replayed: outcome.replayed };
    },

    async resume(
      input: {
        readonly applicationId: string;
        readonly tenantId: string;
        readonly actorId: string;
        readonly executionId: string;
        readonly reason: string;
        readonly reference?: Readonly<Record<string, unknown>>;
      },
      idempotencyKey: string,
    ): Promise<{ readonly sequence: number; readonly replayed: boolean }> {
      void input.reference; // the public transition surface carries `reason` only
      const outcome = await service.transition(
        {
          actorId: input.actorId,
          applicationId: input.applicationId,
          tenantId: input.tenantId,
          executionId: input.executionId,
          command: "resume",
          reason: input.reason,
        },
        idempotencyKey,
      );
      return { sequence: outcome.applied.sequence, replayed: outcome.replayed };
    },
  };
}
