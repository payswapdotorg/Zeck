/**
 * Target resolver ports (verification module outbound; WORK-013).
 *
 * Verification CONSUMES existing identity and lineage — it never creates
 * a parallel artifact identity system. These OPTIONAL resolvers let the
 * service fail closed when a verification target does not resolve in the
 * caller's scope:
 *
 *   - artifact targets resolve through the artifacts module's public
 *     service (content-addressed identity, tenant scope);
 *   - plan-revision targets resolve through the executions ledger's
 *     recorded planning decisions (a plan revision is verifiable only if
 *     the planner durably recorded it for THIS execution — M12's stale
 *     verification discipline has its input half here: the revision must
 *     be the CURRENT recorded one for the target).
 *
 * Unresolvable targets are rejected before any evaluation — "wrong
 * artifact/plan verification accepted" (M11/M12 input half) is typed
 * failure, not a produced result.
 */

import type { VerificationTarget } from "../domain/result";

export type TargetResolution =
  | { readonly resolved: true; readonly revision?: string }
  | { readonly resolved: false; readonly reason: string };

export interface TargetResolverInput {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly executionId: string;
  readonly target: VerificationTarget;
}

export interface TargetResolver {
  /**
   * Resolve/validate one target in scope. Returns the authoritative
   * revision when the target identity carries one (artifact digest,
   * plan revision id).
   */
  resolveTarget(input: TargetResolverInput): Promise<TargetResolution>;
}
