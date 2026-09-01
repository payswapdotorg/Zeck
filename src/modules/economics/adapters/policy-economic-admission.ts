/**
 * Policy economic-admission adapter (economics module; WORK-032).
 *
 * Implements the economics module's REQUIRED `EconomicPolicyAdmissionPort`
 * against the REAL policy authority (the WORK-007 engine): policy remains
 * THE hard authorization boundary of the economic chain — the bounded
 * payment authorization can only be minted after this adapter's
 * delegation allows the action. The adapter holds NO decision logic of
 * its own (the WORK-013 verification seam-adapter discipline, applied to
 * economics).
 *
 * Fact mapping (provider-neutral, over the EXISTING nine-dimension
 * restriction vocabulary — the policies module is NOT in this Work
 * Order's surfaces, so the adapter consumes its public contract only):
 *
 *   - the recipient/seller of a machine-commerce action maps onto the
 *     egress `host` fact (a seller reference is the economic egress
 *     surface exactly like a network host);
 *   - the action's neutral rail preference maps onto the `provider` rail
 *     string (the policies vocabulary's provider fact is BY DESIGN a
 *     provider-neutral rail identifier, never an SDK type).
 *
 * Fail-closed with no configured policy set is inherited from the
 * authority (an application without a policy set denies — there is no
 * default-allow anywhere). Every decision (allow AND deny) carries the
 * authority's durable admission evidence onto the authorization record.
 */

import type { PolicyAuthority } from "../../policies/public";
import type { EconomicActionRecord } from "../domain/economic-action";
import type {
  EconomicAdmissionEvidence,
  EconomicPolicyAdmissionDecision,
  EconomicPolicyAdmissionInput,
  EconomicPolicyAdmissionPort,
} from "../ports/policy-admission";

const HOST_BEARING_RECIPIENT_KINDS = ["seller", "merchant", "provider"] as const;

export function createPolicyEconomicAdmission(
  authority: PolicyAuthority,
): EconomicPolicyAdmissionPort {
  return {
    async evaluate(input: EconomicPolicyAdmissionInput): Promise<EconomicPolicyAdmissionDecision> {
      const action: EconomicActionRecord = input.action;
      const decision = await authority.admitDispatch({
        context: {
          tenantId: action.tenantId,
          applicationId: action.applicationId,
          executionId: action.executionId,
        },
        facts: {
          ...(HOST_BEARING_RECIPIENT_KINDS.includes(
            action.recipient.kind as (typeof HOST_BEARING_RECIPIENT_KINDS)[number],
          )
            ? { host: action.recipient.id }
            : {}),
          ...(action.railPreference === null ? {} : { provider: action.railPreference }),
        },
      });
      if (!decision.allowed) {
        return {
          allowed: false,
          reason:
            decision.reason ??
            decision.denial?.message ??
            "economic action denied by the effective policy",
        };
      }
      const evidence: EconomicAdmissionEvidence | undefined =
        decision.evidence === undefined
          ? undefined
          : {
              policySetId: decision.evidence.policySetId,
              policySetVersion: decision.evidence.policySetVersion,
              policyContentHash: decision.evidence.policyContentHash,
              restrictionSetDigest: decision.evidence.restrictionSetDigest,
            };
      return {
        allowed: true,
        ...(evidence === undefined ? {} : { evidence }),
      };
    },
  };
}
