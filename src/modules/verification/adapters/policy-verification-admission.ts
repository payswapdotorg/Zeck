/**
 * Policy verification-admission adapter (verification module; WORK-013).
 *
 * Implements the verification module's REQUIRED `VerificationAdmission`
 * port against the REAL policy authority (the WORK-007 engine): the
 * adapter maps each verification action onto `PolicyDispatchRequest`
 * facts and delegates — it holds no decision logic of its own (the
 * WORK-010/WORK-011 seam-adapter discipline).
 *
 * Fact mapping (provider-neutral, over the existing nine-dimension
 * restriction vocabulary — the policies module is NOT in this Work
 * Order's surfaces, so the adapter consumes its public contract only):
 *
 *   - `evaluate`            → baseline dispatch admission (fail-closed
 *                              with no configured policy set — there is
 *                              no default-allow anywhere);
 *   - `model-evaluation`    → the model judge is a MODEL DISPATCH:
 *                              provider/model facts are evaluated against
 *                              the providerModel dimension exactly like
 *                              every other model dispatch;
 *   - `human-evaluation`    → human escalation is a governed autonomy
 *                              decision (`spec/architecture.md` §16):
 *                              the adapter submits the autonomy fact for
 *                              the requested interaction and the
 *                              authority decides against the effective
 *                              autonomy ladder;
 *   - `compare-candidates`  → baseline admission; a model-judged
 *                              comparison criterion additionally admits
 *                              the judge dispatch through the
 *                              `model-evaluation` action at the
 *                              evaluator boundary.
 *
 * Every allow decision carries the authority's durable admission
 * evidence (effective policy set identity + restriction-set digest)
 * onto the verification records.
 */

import type { PolicyAdmissionEvidence, PolicyAuthority } from "../../policies/public";
import type { VerificationPolicyEvidence } from "../domain/result";
import type {
  VerificationAdmission,
  VerificationAdmissionDecision,
  VerificationAdmissionRequest,
} from "../ports/verification-admission";

export function createPolicyVerificationAdmission(
  authority: PolicyAuthority,
): VerificationAdmission {
  return {
    async admit(request: VerificationAdmissionRequest): Promise<VerificationAdmissionDecision> {
      const context = {
        tenantId: request.tenantId,
        applicationId: request.applicationId,
        executionId: request.executionId,
      };
      const toEvidence = (evidence: PolicyAdmissionEvidence): VerificationPolicyEvidence => ({
        policySetId: evidence.policySetId,
        policySetVersion: evidence.policySetVersion,
        policyContentHash: evidence.policyContentHash,
        restrictionSetDigest: evidence.restrictionSetDigest,
      });

      if (request.action === "model-evaluation") {
        // The judge dispatch is a model dispatch: provider/model
        // eligibility genuinely applies (provider-neutral rail strings).
        const decision = await authority.admitDispatch({
          context,
          facts: {
            ...(request.provider === undefined ? {} : { provider: request.provider }),
            ...(request.model === undefined ? {} : { model: request.model }),
          },
        });
        if (!decision.allowed) {
          return {
            allowed: false,
            reason:
              decision.reason ??
              decision.denial?.message ??
              "model-based evaluation dispatch denied by the effective policy",
          };
        }
        return {
          allowed: true,
          ...(decision.evidence === undefined ? {} : { evidence: toEvidence(decision.evidence) }),
        };
      }
      if (request.action === "human-evaluation") {
        // Human escalation is an autonomy-governed interaction: the
        // authority evaluates the autonomy fact against the effective
        // autonomy ladder (the agents-module approval-gate precedent).
        const decision = await authority.admitDispatch({
          context,
          facts: { autonomy: "gated" },
        });
        if (!decision.allowed) {
          return {
            allowed: false,
            reason:
              decision.reason ??
              decision.denial?.message ??
              "human evaluation is not permitted by the effective policy",
          };
        }
        return {
          allowed: true,
          ...(decision.evidence === undefined ? {} : { evidence: toEvidence(decision.evidence) }),
        };
      }
      // evaluate / compare-candidates: baseline dispatch admission —
      // fail-closed when no policy set is configured.
      const decision = await authority.admitDispatch({ context, facts: {} });
      if (!decision.allowed) {
        return {
          allowed: false,
          reason:
            decision.reason ??
            decision.denial?.message ??
            `${request.action} denied by the effective policy`,
        };
      }
      return {
        allowed: true,
        ...(decision.evidence === undefined ? {} : { evidence: toEvidence(decision.evidence) }),
      };
    },
  };
}
