/**
 * Execution ledger + transition adapter (verification module; WORK-013).
 *
 * Implements the verification module's REQUIRED `VerificationLedger` and
 * `ExecutionTransitionPort` ports against the REAL executions module
 * public service:
 *
 *   - verification evidence flows through `recordStepEvent` (the
 *     canonical EventEnvelope ledger write path — the executions module
 *     alone owns sequencing, gaplessness, append-only enforcement and
 *     status preservation);
 *   - execution facts come from the tenant-guarded `getExecution` read;
 *   - the ONLY lifecycle transitions issued are `verify` (RUNNING →
 *     VERIFYING) and `pass` (VERIFYING → COMPLETED, bound to durable
 *     verification results) — both through the executions authority,
 *     which owns legality and the completion binding. The verification
 *     module never touches the executions tables directly and holds no
 *     transition logic of its own.
 *
 * Type + runtime coupling is to the executions PUBLIC barrel only.
 */

import type { ExecutionService } from "../../executions/public";
import type {
  ExecutionPassInput,
  ExecutionTransitionInput,
  ExecutionTransitionOutcome,
  ExecutionTransitionPort,
  VerificationLedger,
  VerificationLedgerEvent,
  VerificationLedgerOutcome,
} from "../ports/verification-ledger";

export function createExecutionLedgerAdapter(service: ExecutionService): VerificationLedger {
  return {
    async recordStepEvent(
      event: VerificationLedgerEvent,
      idempotencyKey: string,
    ): Promise<VerificationLedgerOutcome> {
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

export function createExecutionTransitionAdapter(
  service: ExecutionService,
): ExecutionTransitionPort {
  const outcomeOf = (outcome: {
    readonly applied: { readonly from: string; readonly to: string; readonly sequence: number };
    readonly replayed: boolean;
  }): ExecutionTransitionOutcome => ({
    from: outcome.applied.from,
    to: outcome.applied.to,
    sequence: outcome.applied.sequence,
    replayed: outcome.replayed,
  });

  return {
    async verify(
      input: ExecutionTransitionInput,
      idempotencyKey: string,
    ): Promise<ExecutionTransitionOutcome> {
      const outcome = await service.transition(
        {
          command: "verify",
          executionId: input.executionId,
          applicationId: input.applicationId,
          actorId: input.actor.actorId,
          tenantId: input.actor.tenantId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
        idempotencyKey,
      );
      return outcomeOf(outcome);
    },

    async pass(
      input: ExecutionPassInput,
      idempotencyKey: string,
    ): Promise<ExecutionTransitionOutcome> {
      const outcome = await service.transition(
        {
          command: "pass",
          executionId: input.executionId,
          applicationId: input.applicationId,
          actorId: input.actor.actorId,
          tenantId: input.actor.tenantId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          verificationResults: input.verificationResults,
        },
        idempotencyKey,
      );
      return outcomeOf(outcome);
    },
  };
}
