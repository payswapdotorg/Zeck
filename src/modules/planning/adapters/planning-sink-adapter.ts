/**
 * Planning decision sink adapter (planning module adapter; WORK-009).
 *
 * Wraps the executions module's public `recordPlanningDecision` surface:
 * the append-only EventEnvelope ledger (the single write path) durably
 * records each validated planning decision while the execution is in a
 * planning phase. Idempotency, concurrency arbitration, tenant scope and
 * gapless sequencing are owned by the executions authority — the planner
 * hands over the record and surfaces the durable outcome. On an idempotent
 * REPLAY the adapter re-reads the durable envelope so callers always
 * receive the record AS PERSISTED (timestamps and digest included).
 */

import type { ExecutionService } from "../../executions/public";
import { PLANNING_DECISION_EVENT_TYPE } from "../../executions/public";
import type { PlanningDecisionRecord } from "../domain/decision";
import type {
  PlanningDecisionSink,
  PlanningSinkInput,
  PlanningSinkOutcome,
} from "../ports/planning-sink";

export function createPlanningSinkAdapter(service: ExecutionService): PlanningDecisionSink {
  return {
    async record(input: PlanningSinkInput): Promise<PlanningSinkOutcome> {
      const { decision, actorId, idempotencyKey } = input;
      const selectedPlanId =
        decision.candidates.find(
          (candidate) => candidate.strategyId === decision.selectedStrategyId,
        )?.plan.planId ?? "";
      const outcome = await service.recordPlanningDecision(
        {
          applicationId: decision.applicationId,
          executionId: decision.executionId,
          tenantId: decision.tenantId,
          actorId,
          decisionId: decision.decisionId,
          planId: selectedPlanId,
          ...(decision.replanOf === undefined ? {} : { replanOf: decision.replanOf }),
          payload: decision as unknown as Readonly<Record<string, unknown>>,
        },
        idempotencyKey,
      );
      if (outcome.replayed) {
        // Surface the DURABLE record as persisted (the caller's freshly
        // derived copy may differ in volatile fields like recordedAt).
        const events = await service.listEvents(decision.applicationId, decision.executionId);
        const envelope = events.find(
          (event) =>
            event.type === PLANNING_DECISION_EVENT_TYPE &&
            (event.reference as Record<string, unknown> | undefined)?.decisionId ===
              decision.decisionId,
        );
        if (envelope !== undefined) {
          const durable = envelope.payload as unknown as PlanningDecisionRecord;
          return {
            executionId: outcome.executionId,
            decisionId: durable.decisionId,
            sequence: outcome.sequence,
            replayed: true,
            durableRecord: durable,
          };
        }
      }
      return {
        executionId: outcome.executionId,
        decisionId: outcome.decisionId,
        sequence: outcome.sequence,
        replayed: outcome.replayed,
      };
    },
  };
}
