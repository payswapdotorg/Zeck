/**
 * Policy agent-admission adapter (agents module; WORK-011).
 *
 * Implements the agents module's REQUIRED `AgentAdmission` port against
 * the REAL policy authority (the WORK-007 engine) — the seam-adapter
 * discipline of `policy-tool-admission` (WORK-010): the adapter maps the
 * agent's DECLARED dispatch facts onto `PolicyDispatchRequest` facts and
 * delegates; it holds no decision logic of its own.
 *
 * Decision semantics (the authority's, restated):
 *
 *   - no configured policy set at all → the session is DENIED (the
 *     platform-wide deny-by-default; "no default-allow exists anywhere");
 *   - per-fact restriction denials on requested tools/secrets/models are
 *     INTERSECTION semantics: a non-approved permission is absent from
 *     the effective set (the agent runs with what policy approved — it
 *     can never self-grant, discrimination M9);
 *   - the requested autonomy is CLAMPED to the effective policy ceiling
 *     (asking for less is always allowed; the clamp is the policy's
 *     designation of whether the human-approval gate engages).
 *
 * Every decision carries the authority's durable admission evidence
 * (effective policy set identity + restriction-set digest) onto the
 * session record.
 *
 * Type-only coupling depth: this adapter imports the policies module's
 * PUBLIC barrel (the authority surface). No policy semantics are
 * reimplemented here.
 */

import type { AutonomyMode, PolicyAuthority } from "../../policies/public";
import { AUTONOMY_MODES } from "../../policies/public";
import type { SessionPolicyEvidence } from "../domain/permissions";
import { toSessionPolicyEvidence } from "../domain/permissions";
import type {
  AgentAdmission,
  AgentAdmissionDecision,
  AgentAdmissionRequest,
} from "../ports/agent-admission";

/** Ladder position (tighter = lower index). */
function autonomyRank(mode: AutonomyMode): number {
  return AUTONOMY_MODES.indexOf(mode);
}

function tighter(a: AutonomyMode, b: AutonomyMode): AutonomyMode {
  return autonomyRank(a) <= autonomyRank(b) ? a : b;
}

export function createPolicyAgentAdmission(authority: PolicyAuthority): AgentAdmission {
  return {
    async admit(request: AgentAdmissionRequest): Promise<AgentAdmissionDecision> {
      const context = {
        tenantId: request.tenantId,
        applicationId: request.applicationId,
        executionId: request.executionId,
      };

      // 1. Baseline + autonomy designation: one evaluation carrying the
      //    requested autonomy. Deny-by-default when nothing is configured.
      const autonomyDecision = await authority.admitDispatch({
        context,
        facts: { autonomy: request.requestedAutonomy },
      });
      if (!autonomyDecision.allowed) {
        const kind = autonomyDecision.denial?.kind;
        if (kind === undefined || kind === "no-policy-set" || kind === "weakening") {
          // No configured set (or platform-level refusal): fail closed.
          return {
            allowed: false,
            reason:
              autonomyDecision.reason ??
              "agent session denied: no effective policy set is configured",
          };
        }
        // restriction: the requested autonomy exceeds the policy ceiling.
        // CLAMP to the effective ceiling (asking for less is always
        // allowed) and take the clean evidence of the clamped evaluation.
        const ceiling = autonomyDecision.effective?.autonomy?.maxAutonomy;
        if (ceiling === undefined) {
          return {
            allowed: false,
            reason:
              autonomyDecision.reason ??
              "agent session denied: the effective policy does not permit any autonomy",
          };
        }
        const clamped = tighter(request.requestedAutonomy, ceiling);
        const clampedDecision = await authority.admitDispatch({
          context,
          facts: { autonomy: clamped },
        });
        if (!clampedDecision.allowed || clampedDecision.evidence === undefined) {
          return {
            allowed: false,
            reason:
              clampedDecision.reason ??
              "agent session denied: autonomy could not be resolved under the effective policy",
          };
        }
        return permissionIntersection(authority, request, context, clamped, {
          policySetId: clampedDecision.evidence.policySetId,
          policySetVersion: clampedDecision.evidence.policySetVersion,
          policyContentHash: clampedDecision.evidence.policyContentHash,
          restrictionSetDigest: clampedDecision.evidence.restrictionSetDigest,
        });
      }
      if (autonomyDecision.evidence === undefined) {
        return {
          allowed: false,
          reason: "agent session denied: the effective policy set did not produce evidence",
        };
      }
      const evidence: SessionPolicyEvidence = toSessionPolicyEvidence(autonomyDecision.evidence);
      return permissionIntersection(
        authority,
        request,
        context,
        request.requestedAutonomy,
        evidence,
      );
    },
  };
}

/** Evaluate every requested permission fact; keep ONLY approved ones. */
async function permissionIntersection(
  authority: PolicyAuthority,
  request: AgentAdmissionRequest,
  context: {
    readonly tenantId: string;
    readonly applicationId: string;
    readonly executionId: string;
  },
  autonomy: AutonomyMode,
  evidence: SessionPolicyEvidence,
): Promise<AgentAdmissionDecision> {
  const approvedTools: string[] = [];
  for (const tool of request.requestedPermissions.tools) {
    const decision = await authority.admitDispatch({ context, facts: { tool } });
    if (decision.allowed) {
      approvedTools.push(tool);
    }
    // A restriction denial excludes the permission (intersection); the
    // agent runs with what the policy approved.
  }
  const approvedSecretRefs: string[] = [];
  for (const secretRef of request.requestedPermissions.secretRefs) {
    const decision = await authority.admitDispatch({ context, facts: { secretRef } });
    if (decision.allowed) {
      approvedSecretRefs.push(secretRef);
    }
  }
  const approvedModels: string[] = [];
  for (const model of request.requestedPermissions.models ?? []) {
    const decision = await authority.admitDispatch({ context, facts: { model } });
    if (decision.allowed) {
      approvedModels.push(model);
    }
  }
  return {
    allowed: true,
    effectivePermissions: {
      tools: approvedTools,
      secretRefs: approvedSecretRefs,
      models: approvedModels,
    },
    autonomy,
    evidence,
  };
}
