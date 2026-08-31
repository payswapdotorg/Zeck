/**
 * Learning signals port (planning module outbound; WORK-014 / INT-006).
 *
 * The READ seam through which the planner consults learning signals.
 * Planning OWNS this consumer-side contract (the WORK-007/WORK-009
 * consumer-owned-port precedent): implementations adapt the learning
 * module's public signal source to this shape and MUST validate every
 * signal (versioned scorecard basis — M13) before it crosses the seam.
 *
 * This port can only ever RETURN evidence. There is no method that
 * could authorize a route, mutate a plan, mutate policy/budget/
 * capability state or dispatch anything — learning is consultable, not
 * commanding (§9 of the Work Order: "planning may READ learning
 * signals; the planner remains authoritative").
 */

import type { ConsultedLearningSignal } from "../domain/learning-consultation";

export interface LearningSignalQuery {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly taskClass: string;
  /** Route/tool subject keys to consult (e.g. "providerA/modelB"). */
  readonly subjectKeys: readonly string[];
}

export interface LearningSignals {
  consult(query: LearningSignalQuery): Promise<readonly ConsultedLearningSignal[]>;
}
