/**
 * Policy computer-use-admission adapter (tools module; WORK-027).
 *
 * Implements the tools module's REQUIRED `ComputerUsePolicyAdmission`
 * port against the REAL policy authority (the WORK-007 engine) — the
 * exact discipline of `policy-tool-admission.ts` (WORK-010): the adapter
 * maps the computer-use session's DECLARED dispatch facts (the tool
 * fact, the egress hosts, the mediated secret reference) onto
 * `PolicyDispatchRequest` facts and DELEGATES. It holds no decision
 * logic of its own; there is no default-allow path (an unwired policy
 * seam is a construction-time absence, not a bypass).
 *
 * Every declared host and secret reference is evaluated as a dispatch
 * fact through `admitDispatch` (the same evaluation every other tool
 * seam uses); the tool fact is the computer-use tool descriptor (e.g.
 * `computer-use:session`, `computer-use:action:navigate`). ALL facts
 * must be allowed — one denial denies the session/action/escalation
 * BEFORE any environment interaction (the security-ordering proof).
 */

import type { PolicyAdmissionEvidence, PolicyAuthority } from "../../policies/public";
import type { ComputerUsePolicyEvidence } from "../domain/computer-use";
import type {
  ComputerUsePolicyAdmission,
  ComputerUsePolicyAdmissionDecision,
  ComputerUsePolicyAdmissionRequest,
} from "../ports/computer-use-admission";

/** Narrow the authority's evidence onto the tools evidence shape (structural). */
function toEvidence(evidence: PolicyAdmissionEvidence): ComputerUsePolicyEvidence {
  return {
    policySetId: evidence.policySetId,
    policySetVersion: evidence.policySetVersion,
    policyContentHash: evidence.policyContentHash,
    restrictionSetDigest: evidence.restrictionSetDigest,
  };
}

export function createPolicyComputerUseAdmission(
  authority: PolicyAuthority,
): ComputerUsePolicyAdmission {
  return {
    async admit(
      request: ComputerUsePolicyAdmissionRequest,
    ): Promise<ComputerUsePolicyAdmissionDecision> {
      // The computer-use tool fact is always evaluated (computer-use
      // permissions are a policy dimension, exactly like tool identity).
      const base = await authority.admitDispatch({
        context: {
          tenantId: request.tenantId,
          applicationId: request.applicationId,
          executionId: request.executionId,
        },
        facts: { tool: request.toolFact },
      });
      if (!base.allowed) {
        return {
          allowed: false,
          reason:
            base.reason ??
            base.denial?.message ??
            "computer-use dispatch denied by the effective policy",
        };
      }
      const decisions: ComputerUsePolicyAdmissionDecision[] = [];
      if (base.evidence !== undefined) {
        decisions.push({ allowed: true, evidence: toEvidence(base.evidence) });
      } else {
        decisions.push({ allowed: true });
      }

      // Each declared network host is an egress fact the effective policy
      // must permit (no hidden network access: undeclared hosts are never
      // dispatched, declared ones are admitted here).
      for (const host of request.hosts) {
        const hostDecision = await authority.admitDispatch({
          context: {
            tenantId: request.tenantId,
            applicationId: request.applicationId,
            executionId: request.executionId,
          },
          facts: { tool: request.toolFact, host },
        });
        if (!hostDecision.allowed) {
          return {
            allowed: false,
            reason:
              hostDecision.reason ??
              hostDecision.denial?.message ??
              `network host "${host}" is not permitted by the effective policy`,
          };
        }
        if (hostDecision.evidence !== undefined) {
          decisions.push({ allowed: true, evidence: toEvidence(hostDecision.evidence) });
        }
      }

      // The mediated secret reference is a secret-access fact (references
      // only — raw secret values never cross this seam; materialization
      // stays behind the connections vault).
      if (request.secretRef !== null) {
        const secretDecision = await authority.admitDispatch({
          context: {
            tenantId: request.tenantId,
            applicationId: request.applicationId,
            executionId: request.executionId,
          },
          facts: { tool: request.toolFact, secretRef: request.secretRef },
        });
        if (!secretDecision.allowed) {
          return {
            allowed: false,
            reason:
              secretDecision.reason ??
              secretDecision.denial?.message ??
              `secret reference "${request.secretRef}" is not permitted by the effective policy`,
          };
        }
        if (secretDecision.evidence !== undefined) {
          decisions.push({ allowed: true, evidence: toEvidence(secretDecision.evidence) });
        }
      }

      // Every fact allowed: carry the FIRST decision's evidence (all
      // decisions in one resolution share the effective-set identity).
      const withEvidence = decisions.find((decision) => "evidence" in decision);
      if (withEvidence !== undefined && "evidence" in withEvidence) {
        return { allowed: true, evidence: withEvidence.evidence };
      }
      return { allowed: true };
    },
  };
}
