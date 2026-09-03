/**
 * Verification training-gate adapter (sandbox module; WORK-030,
 * ACC-003).
 *
 * Implements the sandbox module's REQUIRED `TrainingVerificationGate`
 * port against the REAL verification module authority (WORK-013) — the
 * deployments module's `createVerificationMediaGate` discipline applied
 * to the training axis: compute completion NEVER implies model-release
 * verification. The adapter maps a completed workload's output onto the
 * verification authority's `verifyTarget` ARTIFACT target and delegates
 * the verdict; it holds no evaluation logic of its own (there is no
 * second verification authority — the deterministic evaluator bank,
 * the criteria binding and the fail-closed conclusion semantics all
 * live in the verification module).
 *
 * The verdict mapping: the verification authority's conclusion is PASS
 * only when every REQUIRED criterion is met by durable evidence; every
 * other outcome (FAIL, INCONCLUSIVE) is a NON-PASS here — the release
 * fails closed. The evaluation identity (durable evidence id) rides
 * back onto the workload's release binding.
 */

import type { VerificationService } from "../../verification/public";
import type {
  TrainingVerificationGate,
  TrainingVerificationRequest,
  TrainingVerificationVerdict,
} from "../ports/training-verification";

export function createVerificationTrainingGate(
  service: VerificationService,
): TrainingVerificationGate {
  return {
    async verify(
      request: TrainingVerificationRequest,
      idempotencyKey: string,
    ): Promise<TrainingVerificationVerdict> {
      const conclusion = await service.verifyTarget(
        {
          applicationId: request.applicationId,
          executionId: request.executionId,
          actor: {
            actorId: request.workloadId,
            tenantId: request.tenantId,
          },
          target: {
            kind: "artifact",
            ref: request.outputArtifactDigest,
            revision: request.outputArtifactDigest,
          },
          criteria: request.criteria.map((criterion) => ({
            criterionId: criterion.criterionId,
            version: criterion.version,
          })),
          evidence: {
            facts: {
              workloadId: request.workloadId,
              workloadKey: request.workloadKey,
              outputArtifactDigest: request.outputArtifactDigest,
            },
            evidenceRefs: [
              ...request.evidenceRefs,
              `training-output:${request.outputArtifactDigest}`,
            ],
          },
        },
        idempotencyKey,
      );
      const unmet = conclusion.requiredUnmet
        .map((criterion) => `${criterion.criterionId}(${criterion.reason})`)
        .join(", ");
      return {
        passed: conclusion.criteriaMet === true,
        evaluationId: conclusion.evaluationId,
        conclusion:
          conclusion.criteriaMet === true
            ? "pass"
            : unmet.length === 0
              ? "criteria not met"
              : `required criteria unmet: ${unmet}`,
      };
    },
  };
}
