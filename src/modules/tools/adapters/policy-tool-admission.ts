/**
 * Policy tool-admission adapter (tools module; WORK-010).
 *
 * Implements the tools module's REQUIRED `ToolAdmission` port against the
 * REAL policy authority (the WORK-007 engine): the adapter maps the tool
 * contract's DECLARED dispatch facts (tool identity, network hosts, secret
 * references) onto `PolicyDispatchRequest` facts and delegates — it holds
 * no decision logic of its own (the WORK-007 seam-adapter discipline).
 *
 * Every declared host and secret reference is evaluated as a dispatch fact
 * through `admitDispatch` (the same evaluation the models dispatch seam
 * uses); the tool identity itself is evaluated as the `tool` fact. ALL
 * facts must be allowed — one denial denies the invocation. Every decision
 * carries the authority's durable admission evidence (effective policy set
 * identity + restriction-set digest) onto the invocation record.
 *
 * Type-only coupling depth: this adapter imports the policies module's
 * PUBLIC barrel (the authority surface) — the same direction the models
 * dispatch seam uses via its own port. No policy semantics are
 * reimplemented here.
 */

import type { PolicyAdmissionEvidence, PolicyAuthority } from "../../policies/public";
import type { ToolPolicyEvidence } from "../domain/invocation";
import type {
  ToolAdmission,
  ToolAdmissionDecision,
  ToolAdmissionRequest,
} from "../ports/tool-admission";

/** Narrow the authority's evidence onto the tools evidence shape (structural). */
function toEvidence(evidence: PolicyAdmissionEvidence): ToolPolicyEvidence {
  return {
    policySetId: evidence.policySetId,
    policySetVersion: evidence.policySetVersion,
    policyContentHash: evidence.policyContentHash,
    restrictionSetDigest: evidence.restrictionSetDigest,
  };
}

export function createPolicyToolAdmission(authority: PolicyAuthority): ToolAdmission {
  return {
    async admit(request: ToolAdmissionRequest): Promise<ToolAdmissionDecision> {
      // The tool identity fact is always evaluated (TOL-001: tool
      // permissions are a policy dimension, architecture §16).
      const decisions: ToolAdmissionDecision[] = [];
      const base = await authority.admitDispatch({
        context: {
          tenantId: request.tenantId,
          applicationId: request.applicationId,
          executionId: request.executionId,
        },
        facts: { tool: request.toolId },
      });
      if (!base.allowed) {
        return {
          allowed: false,
          reason:
            base.reason ?? base.denial?.message ?? "tool dispatch denied by the effective policy",
        };
      }
      if (base.evidence !== undefined) {
        decisions.push({ allowed: true, evidence: toEvidence(base.evidence) });
      } else {
        decisions.push({ allowed: true });
      }

      // Each declared network host is an egress fact the effective policy
      // must permit (no hidden network access: undeclared hosts are not
      // dispatched, declared ones are admitted).
      for (const host of request.hosts) {
        const hostDecision = await authority.admitDispatch({
          context: {
            tenantId: request.tenantId,
            applicationId: request.applicationId,
            executionId: request.executionId,
          },
          facts: { tool: request.toolId, host },
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

      // Each declared secret reference is a secret-access fact (references
      // only — never values; materialization stays behind the connections
      // vault seam for the adapters that need it).
      for (const secretRef of request.secretRefs) {
        const secretDecision = await authority.admitDispatch({
          context: {
            tenantId: request.tenantId,
            applicationId: request.applicationId,
            executionId: request.executionId,
          },
          facts: { tool: request.toolId, secretRef },
        });
        if (!secretDecision.allowed) {
          return {
            allowed: false,
            reason:
              secretDecision.reason ??
              secretDecision.denial?.message ??
              `secret reference "${secretRef}" is not permitted by the effective policy`,
          };
        }
        if (secretDecision.evidence !== undefined) {
          decisions.push({ allowed: true, evidence: toEvidence(secretDecision.evidence) });
        }
      }

      // Every fact allowed: carry the FIRST decision's evidence (all
      // decisions in one resolution share the same effective-set identity).
      const withEvidence = decisions.find((decision) => "evidence" in decision);
      if (withEvidence !== undefined && "evidence" in withEvidence) {
        return { allowed: true, evidence: withEvidence.evidence };
      }
      return { allowed: true };
    },
  };
}
