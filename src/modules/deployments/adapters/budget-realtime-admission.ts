/**
 * Budget realtime-admission adapter (deployments module; WORK-024).
 *
 * Implements the deployments module's `RealtimeBudgetAdmission` port
 * against the REAL budgets module authority (the WORK-004
 * `BudgetAuthority` — the same reserve/settle/release surface the
 * executions dispatch boundary consults). The realtime session service
 * consults this seam before PAID dispatch only (hybrid/generative
 * routes — MOD-007: deterministic routes need no reservation); a
 * missing/denied budget surfaces as `BUDGET_EXCEEDED` BEFORE the rail
 * delivery and BEFORE the paid inference, with zero side effects.
 *
 * Type + runtime coupling is to the budgets PUBLIC barrel only.
 */

import { PlatformError } from "../../../shared/errors";
import type { BudgetAuthority } from "../../budgets/public";
import type {
  RealtimeBudgetAdmission,
  RealtimeBudgetReservation,
  RealtimeBudgetReserveCommand,
} from "../ports/realtime-admission";

function mapBudgetError(error: unknown, operationId: string): never {
  if (error instanceof PlatformError && error.code === "BUDGET_EXCEEDED") {
    throw error;
  }
  // The budgets authority fails closed with typed codes (funding mode
  // unset, wallet missing, exhausted limits…): every such failure is a
  // denied paid dispatch, never a silent bypass.
  if (error instanceof PlatformError) {
    throw new PlatformError({
      code: "BUDGET_EXCEEDED",
      message: `realtime paid dispatch denied by the budget authority: ${error.message}`,
      details: { operationId, cause: error.code },
    });
  }
  throw error;
}

export function createBudgetRealtimeAdmission(authority: BudgetAuthority): RealtimeBudgetAdmission {
  return {
    async reserve(command: RealtimeBudgetReserveCommand): Promise<RealtimeBudgetReservation> {
      try {
        const outcome = await authority.reserve(
          {
            actorId: command.actorId,
            applicationId: command.applicationId,
            tenantId: command.tenantId,
            executionId: command.executionId,
            operationId: command.operationId,
            ...(command.userId === undefined ? {} : { userId: command.userId }),
            amountMicroUsd: command.amountMicroUsd,
          },
          `realtime-reserve:${command.operationId}`,
        );
        return {
          reservationId: outcome.reservation.id,
          amountMicroUsd: outcome.reservation.amountMicroUsd,
          converged: outcome.converged,
        };
      } catch (error) {
        mapBudgetError(error, command.operationId);
      }
    },

    async settle(input) {
      try {
        const outcome = await authority.settle(
          {
            actorId: input.actorId,
            applicationId: input.applicationId,
            tenantId: input.tenantId,
            operationId: input.operationId,
            actualAmountMicroUsd: input.actualAmountMicroUsd,
          },
          `realtime-settle:${input.operationId}`,
        );
        return { reservationId: outcome.reservation.id, settled: true };
      } catch (error) {
        mapBudgetError(error, input.operationId);
      }
    },

    async release(input) {
      try {
        const outcome = await authority.release(
          {
            actorId: input.actorId,
            applicationId: input.applicationId,
            tenantId: input.tenantId,
            operationId: input.operationId,
          },
          `realtime-release:${input.operationId}`,
        );
        return { reservationId: outcome.reservation.id, released: true };
      } catch (error) {
        mapBudgetError(error, input.operationId);
      }
    },
  };
}
