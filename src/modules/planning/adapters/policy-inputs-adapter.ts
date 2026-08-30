/**
 * Policy inputs adapter (planning module adapter; WORK-009).
 *
 * Wraps the WORK-007 policy authority's public surface: the planner
 * consumes the RESOLVED effective restrictions (scope-precedence fold +
 * monotonic tightening happen inside the authority — never re-implemented
 * here) and captures the policy-set identity provenance for the durable
 * planning decision.
 */

import type { PolicyAuthority, PolicyRequestContext, RestrictionSet } from "../../policies/public";
import { resolvePolicy } from "../../policies/public";
import type { PlanningPolicyInputs, ResolvedPolicyInputs } from "../ports/policy-inputs";

export function createPolicyInputsAdapter(authority: PolicyAuthority): PlanningPolicyInputs {
  return {
    async effective(context: PolicyRequestContext): Promise<ResolvedPolicyInputs> {
      const record = await authority.current();
      if (record === null) {
        // No configured policy set: the planner plans under an EMPTY
        // restriction set (the executions/dispatch admission seams stay
        // fail-closed independently — planning captures inputs, it never
        // grants permissions).
        return { outcome: "allow", effective: {} };
      }
      const resolution = resolvePolicy(record.set, context);
      if (resolution.outcome === "deny") {
        return {
          outcome: "deny",
          denial: resolution.denial as unknown as Readonly<Record<string, unknown>>,
          policySetId: record.set.id,
          policySetVersion: record.set.version,
          policyContentHash: record.contentHash,
        };
      }
      const effective: RestrictionSet = resolution.effective;
      return {
        outcome: "allow",
        effective,
        policySetId: record.set.id,
        policySetVersion: record.set.version,
        policyContentHash: record.contentHash,
        appliedScopes: resolution.applied.map((scope) => scope.scope),
      };
    },
  };
}
