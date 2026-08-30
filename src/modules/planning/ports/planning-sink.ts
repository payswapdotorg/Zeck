/**
 * Planning decision sink port (planning module outbound; WORK-009).
 *
 * The DURABLE persistence seam for planning decisions: the executions
 * module's append-only EventEnvelope ledger (the single write path)
 * records each decision as a `planning.decision-recorded` envelope while
 * the execution is in a planning phase (PLANNING/REPLANNING). The planner
 * hands the validated record here; the executions authority owns
 * transactionality, gapless sequencing, tenant scope and idempotency
 * arbitration (concurrent duplicate planning converges to one envelope).
 */

import type { PlanningDecisionRecord } from "../domain/decision";

export interface PlanningSinkInput {
  readonly decision: PlanningDecisionRecord;
  readonly actorId: string;
  readonly idempotencyKey: string;
}

export interface PlanningSinkOutcome {
  readonly executionId: string;
  readonly decisionId: string;
  /** The ledger sequence the decision envelope landed on. */
  readonly sequence: number;
  /** True when idempotent arbitration replayed the durable decision. */
  readonly replayed: boolean;
  /** On replay: the durable record AS PERSISTED (volatile fields included). */
  readonly durableRecord?: PlanningDecisionRecord;
}

export interface PlanningDecisionSink {
  record(input: PlanningSinkInput): Promise<PlanningSinkOutcome>;
}
