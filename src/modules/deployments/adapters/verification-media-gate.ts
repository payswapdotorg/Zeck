/**
 * Verification media-gate adapter (deployments module; WORK-026,
 * MOD-013/AC5 — verification-before-completion through the REAL
 * verification authority).
 *
 * Implements the deployments module's REQUIRED `MediaVerificationGate`
 * port against the REAL verification module public service (WORK-013:
 * the independent evidence authority over execution quality). The
 * media completion boundary consults this seam when a job declares
 * `verificationMode: "required"`: the ADOPTED generated-output
 * artifact is the verification TARGET (`verifyTarget` with target
 * kind "artifact" + the content-addressed digest ref), the job's
 * declared criteria refs are the binding, and the deterministic
 * postprocessing facts + adoption evidence refs are the evidence.
 *
 * The boundary discipline: provider success is an OBSERVATION, never
 * a verdict — the gate's `criteriaMet` (the authority's conclusion:
 * every REQUIRED criterion PASSes; INCONCLUSIVE is never acceptance)
 * controls whether the job may complete. A criteriaMet=false verdict
 * FAILS the job (the "unverified output cannot reach completed"
 * invariant). The evaluation is idempotent by the supplied stable key
 * — a crash-resume re-consults under the SAME key and converges on
 * the recorded conclusion.
 *
 * The deployments module owns NO evaluation semantics, criteria kinds
 * or evaluator selection (the verification authority's contract is
 * the whole of it). Type + runtime coupling is to the verification
 * PUBLIC barrel only.
 */

import { PlatformError } from "../../../shared/errors";
import type { VerificationService } from "../../verification/public";
import type {
  MediaVerificationGate,
  MediaVerificationOutcome,
  MediaVerificationRequest,
} from "../ports/media-verification";

export function createVerificationMediaGate(service: VerificationService): MediaVerificationGate {
  return {
    async verify(
      request: MediaVerificationRequest,
      idempotencyKey: string,
    ): Promise<MediaVerificationOutcome> {
      const conclusion = await service.verifyTarget(
        {
          applicationId: request.applicationId,
          executionId: request.executionId,
          actor: {
            actorId: request.actorId,
            tenantId: request.tenantId,
          },
          target: {
            kind: "artifact",
            ref: request.outputArtifactDigest,
          },
          criteria: request.criteria.map((ref) => ({
            criterionId: ref.criterionId,
            version: ref.version,
          })),
          evidence: {
            facts: request.facts,
            evidenceRefs: request.evidenceRefs,
          },
          cause: `media generation verification boundary (job ${request.jobId})`,
        },
        idempotencyKey,
      );
      if (conclusion.tenantId !== request.tenantId) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "media verification conclusion belongs to another tenant scope",
        });
      }
      return {
        criteriaMet: conclusion.criteriaMet,
        evaluationId: conclusion.evaluationId,
        replayed: conclusion.replayed,
      };
    },
  };
}
