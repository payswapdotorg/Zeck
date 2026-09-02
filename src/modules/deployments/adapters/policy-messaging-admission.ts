/**
 * Policy messaging-admission adapter (deployments module; WORK-025).
 *
 * Implements the deployments module's REQUIRED
 * `MessagingPolicyAdmission` port against the REAL policies module
 * authority (the WORK-007 engine — the same authority the executions
 * `authorize`, models dispatch and realtime admission seams consult).
 * The messaging conversation service consults this seam BEFORE any
 * rail send (the external side effect) and BEFORE any paid inference
 * dispatch; a denial is journaled by the caller (journal-then-fail)
 * and typed `POLICY_DENIED` — zero side effects before the decision
 * (MOD-009's policy-before-send).
 *
 * The policy facts are the neutral dispatch dimensions the messaging
 * boundary knows: the rail capability id (the provider dimension),
 * the action (tool dimension: conversation-start / message-send /
 * human-escalation — human escalation is a POLICY-DESIGNATED action,
 * so the effective policy decides it) and the secret reference the
 * rail channel would materialize (the secrets dimension — a
 * reference, never a value). Type + runtime coupling is to the
 * policies PUBLIC barrel only.
 */

import type { PolicyAuthority } from "../../policies/public";
import type {
  MessagingPolicyAdmission,
  MessagingPolicyAdmissionDecision,
  MessagingPolicyAdmissionRequest,
} from "../ports/messaging-admission";

export function createPolicyMessagingAdmission(authority: PolicyAuthority): MessagingPolicyAdmission {
  return {
    async admit(request: MessagingPolicyAdmissionRequest): Promise<MessagingPolicyAdmissionDecision> {
      const result = await authority.admitDispatch({
        context: {
          tenantId: request.tenantId,
          applicationId: request.applicationId,
        },
        facts: {
          provider: request.railCapabilityId,
          tool: `messaging:${request.action}`,
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
          "messaging dispatch denied by the effective policy",
        ...(evidence === undefined ? {} : { evidence }),
      };
    },
  };
}
