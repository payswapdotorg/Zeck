/**
 * Policy edge-admission adapter (edge integration; WORK-029, EDGE-003).
 *
 * Implements the edge integration's REQUIRED `EdgePolicyAdmission` port
 * against the REAL policy authority (the WORK-007 engine) — the exact
 * discipline of `policy-tool-admission.ts` (WORK-010) and
 * `policy-computer-use-admission.ts` (WORK-027): the adapter maps the
 * governed edge operation's DECLARED dispatch facts (the edge tool fact,
 * the device's opaque controller reference, the actuator channels the
 * operation would drive) onto `PolicyDispatchRequest` facts and DELEGATES.
 * It holds no decision logic of its own; there is no default-allow path
 * (an unwired policy seam is a construction-time absence, not a bypass).
 *
 * The controller reference is evaluated as the egress fact (the external
 * controller IS the egress target of governed edge work — the same
 * network-restriction dimension every egressing seam consults); each
 * actuator channel is evaluated as a tool fact
 * (`edge-channel:<channel>`) so a restrictive set can deny a single
 * channel while allowing the rest.
 */

import type { PolicyAdmissionEvidence, PolicyAuthority } from "../../../modules/policies/public";
import type { EdgePolicyEvidence } from "../domain/edge";
import type {
  EdgePolicyAdmission,
  EdgePolicyAdmissionDecision,
  EdgePolicyAdmissionRequest,
} from "../ports/edge-admission";

/** Narrow the authority's evidence onto the edge evidence shape (structural). */
function toEvidence(evidence: PolicyAdmissionEvidence): EdgePolicyEvidence {
  return {
    policySetId: evidence.policySetId,
    policySetVersion: evidence.policySetVersion,
    policyContentHash: evidence.policyContentHash,
    restrictionSetDigest: evidence.restrictionSetDigest,
  };
}

export function createPolicyEdgeAdmission(authority: PolicyAuthority): EdgePolicyAdmission {
  return {
    async admit(
      request: EdgePolicyAdmissionRequest,
    ): Promise<EdgePolicyAdmissionDecision> {
      const context = {
        tenantId: request.tenantId,
        applicationId: request.applicationId,
        ...(request.executionId === null ? {} : { executionId: request.executionId }),
      };
      // The edge tool fact is always evaluated (edge permissions are a
      // policy dimension, exactly like tool identity).
      const base = await authority.admitDispatch({
        context,
        facts: { tool: request.toolFact },
      });
      if (!base.allowed) {
        return {
          allowed: false,
          reason:
            base.reason ??
            base.denial?.message ??
            "edge dispatch denied by the effective policy",
        };
      }
      const evidence = base.evidence !== undefined ? toEvidence(base.evidence) : undefined;

      // The device's opaque controller reference is the egress fact (the
      // network restriction dimension governs which controllers edge work
      // may target — vendor specifics never cross: the reference is opaque).
      const controllerDecision = await authority.admitDispatch({
        context,
        facts: { tool: request.toolFact, host: request.controllerRef },
      });
      if (!controllerDecision.allowed) {
        return {
          allowed: false,
          reason:
            controllerDecision.reason ??
            controllerDecision.denial?.message ??
            `edge controller reference "${request.controllerRef}" is not permitted by the effective policy`,
        };
      }

      // Each actuator channel the operation would drive is a tool fact —
      // a restrictive set can confine a single channel.
      for (const channel of request.channels) {
        const channelDecision = await authority.admitDispatch({
          context,
          facts: { tool: `edge-channel:${channel}` },
        });
        if (!channelDecision.allowed) {
          return {
            allowed: false,
            reason:
              channelDecision.reason ??
              channelDecision.denial?.message ??
              `actuator channel "${channel}" is not permitted by the effective policy`,
          };
        }
      }

      return { allowed: true, ...(evidence === undefined ? {} : { evidence }) };
    },
  };
}
