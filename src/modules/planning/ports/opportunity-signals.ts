/**
 * Opportunity signals port (planning module outbound; WORK-022 / DTR-005).
 *
 * The READ seam through which the planner consults the learning
 * module's codebase-opportunity advisory findings. Planning OWNS this
 * consumer-side contract (the WORK-007/WORK-009/WORK-014/WORK-017
 * consumer-owned-port precedent): implementations adapt the learning
 * module's public `OpportunitySignalSource` to this shape and MUST
 * validate every finding (analysis version + provenance basis —
 * M11/M12/M13) before it crosses the seam.
 *
 * This port can only ever RETURN evidence. There is no method that
 * could authorize a route, mutate a plan, mutate policy/budget/
 * capability state, dispatch anything or advance a finding — the
 * codebase-opportunity analysis is consultable, not commanding
 * (§17 of the Work Order: "recommendation ≠ planner decision ≠
 * authorization").
 */

import type { ConsultedOpportunitySignal } from "../domain/opportunity-consultation";

export interface OpportunitySignalQuery {
  readonly applicationId: string;
  readonly tenantId: string;
  /** Restrict to one repository (optional). */
  readonly repository?: string;
  /** Restrict to one opportunity class (optional). */
  readonly class?: string;
}

export interface OpportunitySignals {
  consult(query: OpportunitySignalQuery): Promise<readonly ConsultedOpportunitySignal[]>;
}
