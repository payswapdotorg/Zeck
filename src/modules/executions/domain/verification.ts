/**
 * Durable verification results (executions module domain; WORK-006).
 *
 * COMPLETED is produced ONLY by the VERIFYING --pass--> COMPLETED edge and
 * is BOUND to at least one durable verification result
 * (`spec/contracts.md`: "Every transition to COMPLETED is produced by
 * /verification and is bound to at least one durable verification result.
 * There is no provider-success or planner-success shortcut to completion.").
 *
 * WORK-006 owns the durable RECORD + the binding; the verification
 * authority (evaluators, quality gates, confidence semantics) is WORK-013.
 * The binding is enforced physically in migration 0004
 * (`executions_completion_requires_verification` CHECK +
 * `executions_verification_refs_durable` trigger) and in the transition
 * service (a `pass` without at least one PASS result fails
 * VERIFICATION_FAILED before any write).
 */

export type VerificationResultStatus = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface VerificationResultInput {
  readonly criterionId: string;
  readonly strategy: string;
  readonly status: VerificationResultStatus;
  /** Recorded evidence links (artifact ids, observations, references). */
  readonly evidence?: readonly string[];
  /** Who/what produced the result (verifier identity — WORK-013 seam). */
  readonly recordedBy: string;
}

export interface VerificationResultRecord extends VerificationResultInput {
  readonly id: string;
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly recordedAt: string;
}
