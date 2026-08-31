/**
 * Composition recommendations port (planning module outbound; WORK-017).
 *
 * The planning-side READ seam of tool-composition learning: the
 * planner consults the ACTIVE recommendation set's ranked,
 * version-anchored composition recommendations for the task class —
 * as ADVISORY EVIDENCE.
 *
 * LEARNING RECOMMENDATION ≠ AUTHORIZATION (§6/§16): the seam is
 * consult-only. There is no method here that could publish a policy,
 * admit a capability, reserve a budget, record verification or
 * dispatch anything — the recommendation informs the recorded
 * consultation evidence ONLY; the live planning selection is computed
 * by the planner's governed pipeline and remains authoritative
 * (policy/capability/budget/verification gates are unchanged and
 * mandatory downstream).
 *
 * Fail-closed validation happens at the ADAPTER (the seam consumer
 * validates what it consumes — the M13/M26 discipline): an
 * unversioned or malformed recommendation never reaches the planner.
 */

import type { ConsultedCompositionRecommendation } from "../domain/composition-consultation";

export interface CompositionRecommendationQuery {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly taskClass?: string;
}

export interface CompositionRecommendations {
  /** Consult the active set's recommendations (validated, versioned). */
  consult(
    query: CompositionRecommendationQuery,
  ): Promise<readonly ConsultedCompositionRecommendation[]>;
}
