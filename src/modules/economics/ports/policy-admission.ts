/**
 * Economic policy admission port (economics module inbound seam; WORK-032).
 *
 * Policy remains THE hard authorization boundary (the work order's
 * architecture invariant): the bounded payment authorization can only be
 * minted AFTER this REQUIRED port allows the economic action. There is
 * NO default-allow implementation — a service cannot be constructed
 * without a policy admission authority (test fakes live under tests/;
 * the real adapter consuming the policies module's authority lives in
 * `adapters/policy-admission.ts`).
 *
 * A denial is journaled (journal-then-fail) and typed `POLICY_DENIED`:
 * no budget reservation, no authorization, no rail charge — zero external
 * side effects before the full chain.
 */

import type { EconomicActionRecord } from "../domain/economic-action";

/** Durable policy-admission provenance (the WORK-007 admission evidence shape). */
export interface EconomicAdmissionEvidence {
  readonly policySetId: string;
  readonly policySetVersion: number;
  readonly policyContentHash: string;
  readonly restrictionSetDigest: string;
}

export interface EconomicPolicyAdmissionInput {
  readonly action: EconomicActionRecord;
  readonly actorId: string;
}

export interface EconomicPolicyAdmissionDecision {
  readonly allowed: boolean;
  /** Machine-readable denial reason when not allowed. */
  readonly reason?: string;
  /** Effective-policy provenance for the decision (allow AND deny). */
  readonly evidence?: EconomicAdmissionEvidence;
}

export interface EconomicPolicyAdmissionPort {
  evaluate(input: EconomicPolicyAdmissionInput): Promise<EconomicPolicyAdmissionDecision>;
}
