/**
 * Training verification gate port (sandbox module outbound; WORK-030,
 * ACC-003 — the verification-before-release boundary).
 *
 * THE promotion authority seam for training outputs: compute completion
 * NEVER implies model-release verification (the Work Order's explicit
 * requirement). A completed training workload's output artifact may
 * only be marked a VERIFIED RELEASE through this gate — which
 * delegates to the VERIFICATION module's authority (the same
 * fail-closed promotion discipline the media-generation fabric rides:
 * "a candidate with NO validation evidence never promotes"). This
 * module holds NO second verification logic: the port is REQUIRED at
 * service construction for the release operation; there is no default
 * pass implementation anywhere in the sandbox module.
 */

import type { WorkloadLineageRefs } from "../domain/workload";

export interface TrainingVerificationRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly workloadId: string;
  readonly workloadKey: string;
  /** The output artifact's content digest (the verification target). */
  readonly outputArtifactDigest: string;
  /** The declared criteria the verification evaluates against. */
  readonly criteria: readonly { readonly criterionId: string; readonly version: number }[];
  /** The evidence refs the evaluation rides. */
  readonly evidenceRefs: readonly string[];
  readonly lineage: WorkloadLineageRefs;
}

export interface TrainingVerificationVerdict {
  readonly passed: boolean;
  /** The verification authority's evaluation identity (durable evidence). */
  readonly evaluationId: string;
  readonly conclusion: string;
}

export interface TrainingVerificationGate {
  /**
   * Evaluate a completed workload's output for release. Returns the
   * verdict; NEVER throws to force a pass — a FAIL or INCONCLUSIVE
   * verdict fails the release closed.
   */
  verify(
    request: TrainingVerificationRequest,
    idempotencyKey: string,
  ): Promise<TrainingVerificationVerdict>;
}
