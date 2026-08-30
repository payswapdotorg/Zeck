/**
 * Execution ledger adapter (agents module; WORK-011).
 *
 * Implements the agents module's REQUIRED `AgentExecutionLedger` port
 * against the REAL executions module public service — the WORK-010
 * `execution-ledger` adapter discipline, applied to agent sessions:
 *
 *   - agent step events flow through `recordStepEvent` (the canonical
 *     EventEnvelope ledger write path — the executions module alone owns
 *     sequencing, gaplessness, append-only enforcement and status
 *     preservation);
 *   - execution facts come from the tenant-guarded `getExecution` read;
 *   - approval gates move execution status ONLY through the public
 *     `transition` command surface (`wait-human` / `resume`).
 *
 * The agents module never touches the executions tables directly. Type +
 * runtime coupling is to the executions PUBLIC barrel only.
 */

import type { ExecutionService } from "../../executions/public";
import type { AgentExecutionLedger, LedgerStepEvent } from "../ports/agent-execution-ledger";

export function createAgentExecutionLedgerAdapter(service: ExecutionService): AgentExecutionLedger {
  return {
    async recordStepEvent(event: LedgerStepEvent, idempotencyKey: string) {
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

    async waitHuman(input, idempotencyKey) {
      const outcome = await service.transition(
        {
          command: "wait-human",
          actorId: input.actorId,
          applicationId: input.applicationId,
          tenantId: input.tenantId,
          executionId: input.executionId,
          reason: input.reason,
        },
        idempotencyKey,
      );
      return { sequence: outcome.applied.sequence, replayed: outcome.replayed };
    },

    async resume(input, idempotencyKey) {
      const outcome = await service.transition(
        {
          command: "resume",
          actorId: input.actorId,
          applicationId: input.applicationId,
          tenantId: input.tenantId,
          executionId: input.executionId,
          reason: input.reason,
        },
        idempotencyKey,
      );
      return { sequence: outcome.applied.sequence, replayed: outcome.replayed };
    },
  };
}
