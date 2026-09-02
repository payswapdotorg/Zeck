/**
 * The learned-policy READ seam port (planning module outbound; WORK-020).
 *
 * The planning-owned projection of the learning module's public
 * `LearnedPolicySource` (the ACTIVE publication's policy view). The
 * adapter (adapters/learned-policy-adapter.ts) validates every
 * consulted record fail-closed at the seam — including the policies
 * module's restriction-vocabulary boundary scan — before anything
 * reaches the planner.
 *
 * READ ONLY: the source exposes exactly one consult method; there is
 * nothing here that could mutate learning state, planning state or
 * any authority.
 */

import type { ConsultedLearnedPolicy } from "../domain/learned-policy-consultation";

export interface LearnedPolicyQuery {
  readonly applicationId: string;
  readonly tenantId: string;
  /** The task class to consult preferences for (optional). */
  readonly taskClass?: string;
}

export interface LearnedPolicySource {
  /**
   * The consulted (validated, policy-vocabulary-scanned) projection of
   * the ACTIVE learned-policy publication, or null when no
   * publication exists (no published learned optimization — the
   * planner then behaves exactly like the un-wired baseline).
   */
  consult(query: LearnedPolicyQuery): Promise<ConsultedLearnedPolicy | null>;
}

export type { ConsultedLearnedPolicy };
