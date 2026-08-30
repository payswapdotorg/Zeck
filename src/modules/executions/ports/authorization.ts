/**
 * Execution authorization port (executions module inbound seam; WORK-006).
 *
 * Policy admission precedes dispatch (`spec/architecture.md` §2.4): the
 * CREATED --authorize--> AUTHORIZED transition IS the admission seam — the
 * executions module consults this port BEFORE any state write of the
 * authorize transition and fails closed on denial.
 *
 * The policy ENGINE is WORK-007 and is deliberately NOT built here: this is
 * the provider-neutral seam the future policies module implements, exactly
 * how `DispatchAdmission` was required (no default-allow implementation
 * exists in this module — a service cannot be constructed without an
 * authorization authority; test fakes live under tests/).
 */

import type { ExecutionRecord } from "../domain/execution";

/** Facts the authorization authority evaluates (post scope resolution). */
export interface ExecutionAdmissionInput {
  readonly execution: ExecutionRecord;
  readonly actorId: string;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  /** Machine-readable denial reason when not allowed. */
  readonly reason?: string;
}

export interface ExecutionAuthorizationPort {
  evaluate(input: ExecutionAdmissionInput): Promise<AuthorizationDecision>;
}
