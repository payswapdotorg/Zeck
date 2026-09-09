/**
 * The executions-side IR binding seam (executions module adapter;
 * WORK-049 — the module-side implementation of the platform
 * execution-ir plane's `ExecutionBindingSeam`).
 *
 * The executions module stays the execution identity, lifecycle and
 * event-ledger authority; this adapter is a READ-ONLY projection of
 * the binding between an execution and its CURRENT governed plan: the
 * executions ledger is the durable plan-decision authority (the
 * planning decisions are appended as `planning.decision-recorded`
 * envelopes), so the current plan identity is read from the LATEST
 * such envelope's durable reference. No writes, no state machine, no
 * second authority: the projection speaks the platform seam type.
 */

import type { DatabasePort } from "../../../platform/db/port";
import type {
  ExecutionBindingSeam,
  ExecutionPlanBinding,
} from "../../../platform/execution-ir/seams";
import { PLANNING_DECISION_EVENT_TYPE } from "../domain/event";

interface ExecutionRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly status: string;
  readonly last_event_sequence: number;
}

interface EventRow {
  readonly reference: unknown;
}

/**
 * The executions seam: read-only execution → governed-plan binding
 * over the executions module's own tables (the platform never queries
 * them directly).
 */
export function createIrExecutionBinding(db: DatabasePort): ExecutionBindingSeam {
  return {
    async getPlanBinding(applicationId, executionId) {
      const execution = await db.execute<ExecutionRow>({
        sql: `SELECT id, application_id, tenant_id, status, last_event_sequence
                FROM executions.executions
               WHERE application_id = $1 AND id = $2`,
        parameters: [applicationId, executionId],
      });
      const row = execution.rows[0];
      if (row === undefined) {
        return null;
      }
      const latest = await db.execute<EventRow>({
        sql: `SELECT reference
                FROM executions.execution_events
               WHERE application_id = $1 AND execution_id = $2 AND type = $3
               ORDER BY sequence DESC
               LIMIT 1`,
        parameters: [applicationId, executionId, PLANNING_DECISION_EVENT_TYPE],
      });
      const reference = latest.rows[0]?.reference;
      let currentPlanId: string | null = null;
      let planningDecisionId: string | null = null;
      if (typeof reference === "object" && reference !== null && !Array.isArray(reference)) {
        const record = reference as Record<string, unknown>;
        if (typeof record.planId === "string") {
          currentPlanId = record.planId;
        }
        if (typeof record.decisionId === "string") {
          planningDecisionId = record.decisionId;
        }
      }
      const binding: ExecutionPlanBinding = {
        applicationId: row.application_id,
        executionId: row.id,
        tenantId: row.tenant_id,
        status: row.status,
        currentPlanId,
        planningDecisionId,
        lastEventSequence: row.last_event_sequence,
      };
      return binding;
    },
  };
}
