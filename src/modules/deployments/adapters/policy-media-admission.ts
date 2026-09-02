/**
 * Policy media-admission adapter (deployments module; WORK-026).
 *
 * Implements the deployments module's REQUIRED `MediaPolicyAdmission`
 * port against the REAL policies module authority (the WORK-007
 * engine — the same authority the executions `authorize`, models
 * dispatch, realtime and messaging admission seams consult). The
 * media generation service consults this seam BEFORE the PAID rail
 * dispatch (the external side effect); a denial is journaled by the
 * caller (journal-then-fail) and typed `POLICY_DENIED` — zero paid
 * dispatches (MOD-013's policy-before-paid-dispatch).
 *
 * The policy facts are the neutral dispatch dimensions the media
 * boundary knows: the rail capability id (the provider dimension),
 * the action (tool dimension: job-submit / job-cancel /
 * variant-derive) and the secret reference the rail channel would
 * materialize (the secrets dimension — a reference, never a value).
 * Type + runtime coupling is to the policies PUBLIC barrel only.
 */

import type { PolicyAuthority } from "../../policies/public";
import type {
  MediaPolicyAdmission,
  MediaPolicyAdmissionDecision,
  MediaPolicyAdmissionRequest,
} from "../ports/media-admission";

export function createPolicyMediaAdmission(authority: PolicyAuthority): MediaPolicyAdmission {
  return {
    async admit(
      request: MediaPolicyAdmissionRequest,
    ): Promise<MediaPolicyAdmissionDecision> {
      const result = await authority.admitDispatch({
        context: {
          tenantId: request.tenantId,
          applicationId: request.applicationId,
        },
        facts: {
          provider: request.railCapabilityId,
          tool: `media:${request.action}`,
          ...(request.generationKind === null ? {} : { generationKind: request.generationKind }),
          ...(request.secretRef === null ? {} : { secretRef: request.secretRef }),
        },
      });
      const evidence =
        result.evidence === undefined
          ? undefined
          : {
              policySetId: result.evidence.policySetId,
              policySetVersion: result.evidence.policySetVersion,
              policyContentHash: result.evidence.policyContentHash,
              restrictionSetDigest: result.evidence.restrictionSetDigest,
            };
      if (result.allowed) {
        return { allowed: true, ...(evidence === undefined ? {} : { evidence }) };
      }
      return {
        allowed: false,
        reason:
          result.reason ??
          result.denial?.message ??
          "media generation dispatch denied by the effective policy",
        ...(evidence === undefined ? {} : { evidence }),
      };
    },
  };
}
