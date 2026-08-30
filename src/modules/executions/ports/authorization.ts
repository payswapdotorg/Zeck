/**
 * Execution authorization port (executions module inbound seam; WORK-006,
 * wired to the real engine in WORK-007).
 *
 * Policy admission precedes dispatch (`spec/architecture.md` §2.4): the
 * CREATED --authorize--> AUTHORIZED transition IS the admission seam — the
 * executions module consults this port BEFORE any state write of the
 * authorize transition and fails closed on denial.
 *
 * The policy ENGINE lives in `/policies` (WORK-007) and implements this
 * seam (`policies/adapters/execution-authorization.ts`), exactly how
 * `DispatchAdmission` was required (no default-allow implementation exists
 * in this module — a service cannot be constructed without an authorization
 * authority; test fakes live under tests/).
 *
 * WORK-007: a policy denial is typed `POLICY_DENIED` (the canonical code
 * for the policy authority's decision) and is recorded as DURABLE denial
 * evidence on the event ledger (`execution.policy-denied` envelope); an
 * allow carries `AdmissionEvidence` — the effective policy set version +
 * content hash + resolved restriction-set digest — which the authorize
 * envelope records (provenance-bound admission evidence).
 */

import type { ExecutionRecord } from "../domain/execution";

/** Facts the authorization authority evaluates (post scope resolution). */
export interface ExecutionAdmissionInput {
  readonly execution: ExecutionRecord;
  readonly actorId: string;
}

/**
 * Durable admission provenance (WORK-007 acceptance criterion 5): identity
 * of the effective policy the decision was produced under. Produced by the
 * policy authority; recorded by this module on the authorize envelope.
 */
export interface AdmissionEvidence {
  readonly policySetId: string;
  readonly policySetVersion: number;
  readonly policyContentHash: string;
  readonly restrictionSetDigest: string;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  /** Machine-readable denial reason when not allowed. */
  readonly reason?: string;
  /**
   * Effective-policy provenance for the decision (allow AND deny) — present
   * whenever the authority is the policy engine.
   */
  readonly evidence?: AdmissionEvidence;
}

export interface ExecutionAuthorizationPort {
  evaluate(input: ExecutionAdmissionInput): Promise<AuthorizationDecision>;
}
