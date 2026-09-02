/**
 * Budget media-admission adapter (deployments module; WORK-026).
 *
 * Implements the deployments module's `MediaBudgetAdmission` port
 * against the REAL budgets module authority (the WORK-004
 * `BudgetAuthority` — the same reserve/settle/release surface the
 * executions dispatch boundary, the realtime and messaging fabrics
 * consult). The media generation service consults this seam before
 * the PAID rail dispatch ONLY (media generation is ALWAYS paid — the
 * budget-before-paid-dispatch discipline is unconditional for the
 * media fabric, MOD-013's core); a missing/denied budget surfaces as
 * `BUDGET_EXCEEDED` BEFORE the rail dispatch, with zero side effects.
 *
 * The reserve's `operationId` is the STABLE per-job dispatch
 * discriminator (domain `mediaBudgetOperationId`) — a retried or
 * concurrent duplicate dispatch converges on the SAME reservation
 * (exactly one reservation per job's paid dispatch; the "uncontrolled
 * paid duplicate" defect is unrepresentable).
 *
 * Type + runtime coupling is to the budgets PUBLIC barrel only.
 */

import { PlatformError } from "../../../shared/errors";
import type { BudgetAuthority } from "../../budgets/public";
import type {
  MediaBudgetAdmission,
  MediaBudgetReservation,
  MediaBudgetReserveCommand,
} from "../ports/media-admission";

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
      message: `media paid dispatch denied by the budget authority: ${error.message}`,
      details: { operationId, cause: error.code },
    });
  }
  throw error;
}

export function createBudgetMediaAdmission(authority: BudgetAuthority): MediaBudgetAdmission {
  return {
    async reserve(command: MediaBudgetReserveCommand): Promise<MediaBudgetReservation> {
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
          `media-reserve:${command.operationId}`,
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
          `media-settle:${input.operationId}`,
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
          `media-release:${input.operationId}`,
        );
        return { reservationId: outcome.reservation.id, released: true };
      } catch (error) {
        mapBudgetError(error, input.operationId);
      }
    },
  };
}
