/**
 * Media verification-gate port (deployments module outbound; WORK-026,
 * MOD-013/AC5 — verification-before-completion).
 *
 * The completion boundary's verification consultee: when a job
 * declares `verificationMode: "required"`, the job CANNOT reach
 * `completed` until this gate reports the verification authority's
 * PASS verdict on the generated output artifact. The gate is the
 * REAL verification authority's contract (the verification module's
 * public service — declareCriteria/verifyTarget), NEVER a
 * re-implementation: the deployments module owns no evaluation
 * semantics, no criteria kinds, no evaluator selection.
 *
 * The boundary discipline (the Work Order's architecture invariants):
 *   - provider success is an OBSERVATION (the normalized
 *     provider-completed observation), never a verdict;
 *   - the deterministic postprocessing shape check (domain) rejects
 *     malformed outputs BEFORE this gate (the first boundary);
 *   - this gate is the SECOND boundary: the verification authority's
 *     criteria evaluation over the ADOPTED artifact target (criteria
 *     are declared to the authority; the job records only the
 *     criteria REFS);
 *   - a criteriaMet=false verdict FAILS the job (verification
 *     rejection — the output is never marked complete while the Work
 *     Order requires rejection);
 *   - the evaluation is idempotent by the stable job-scoped key
 *     (domain `mediaVerificationKey`): a crash-resume re-consults
 *     under the SAME key and converges on the recorded conclusion;
 *   - when the mode is `none`, this gate is not consulted (the
 *     deterministic shape check alone controls the boundary — the
 *     "where configured" wording of the invariant).
 */
import type { MediaCriteriaRef } from "../domain/media";

export interface MediaVerificationRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly actorId: string;
  readonly executionId: string;
  readonly jobId: string;
  /** The adopted generated-output artifact digest (the verification target). */
  readonly outputArtifactDigest: string;
  /** The declared criteria refs bound to this evaluation (the job's recorded refs). */
  readonly criteria: readonly MediaCriteriaRef[];
  /** Deterministic evidence facts (the postprocessing shape + digests). */
  readonly facts: Readonly<Record<string, unknown>>;
  /** Durable evidence references (the adoption record + observation refs). */
  readonly evidenceRefs: readonly string[];
}

export interface MediaVerificationOutcome {
  /** True only when the verification authority concluded every REQUIRED criterion PASSes. */
  readonly criteriaMet: boolean;
  /** The verification authority's evaluation identity (provenance). */
  readonly evaluationId: string;
  /** True when the gate converged on a previously recorded evaluation (idempotent replay). */
  readonly replayed: boolean;
}

export interface MediaVerificationGate {
  /**
   * Evaluate the generated output artifact against the declared
   * criteria — the verification authority's verifyTarget seam
   * (idempotent by the supplied stable key; INCONCLUSIVE is never
   * acceptance — the authority's own contract).
   */
  verify(request: MediaVerificationRequest, idempotencyKey: string): Promise<MediaVerificationOutcome>;
}
