/**
 * Policy realtime-admission adapter (deployments module; WORK-024).
 *
 * Implements the deployments module's REQUIRED
 * `RealtimePolicyAdmission` port against the REAL policies module
 * authority (the WORK-007 engine — the same authority the executions
 * `authorize` and models dispatch seams consult). The realtime session
 * service consults this seam BEFORE any rail delivery (the external
 * side effect) and BEFORE any paid inference dispatch; a denial is
 * journaled by the caller (journal-then-fail) and typed `POLICY_DENIED`
 * — zero side effects before the decision.
 *
 * The policy facts are the neutral dispatch dimensions the realtime
 * boundary knows: the rail capability id (the provider dimension), the
 * action (tool dimension: session-start / turn-dispatch /
 * human-transfer — human escalation is a POLICY-DESIGNATED action, so
 * the effective policy decides it) and the secret reference the rail
 * channel would materialize (the secrets dimension — a reference,
 * never a value). Type + runtime coupling is to the policies PUBLIC
 * barrel only.
 */

import type { PolicyAuthority } from "../../policies/public";
import type {
  RealtimePolicyAdmission,
  RealtimePolicyAdmissionDecision,
  RealtimePolicyAdmissionRequest,
} from "../ports/realtime-admission";

export function createPolicyRealtimeAdmission(authority: PolicyAuthority): RealtimePolicyAdmission {
  return {
    async admit(request: RealtimePolicyAdmissionRequest): Promise<RealtimePolicyAdmissionDecision> {
      const result = await authority.admitDispatch({
        context: {
          tenantId: request.tenantId,
          applicationId: request.applicationId,
        },
        facts: {
          provider: request.railCapabilityId,
          tool: `realtime:${request.action}`,
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
          "realtime dispatch denied by the effective policy",
        ...(evidence === undefined ? {} : { evidence }),
      };
    },
  };
}
