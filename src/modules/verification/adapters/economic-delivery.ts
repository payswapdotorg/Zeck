/**
 * Economic-delivery verification seam (verification module adapters;
 * WORK-032, ECO-006).
 *
 * SETTLEMENT IS NOT DELIVERY (`payment success != resource delivered !=
 * execution success` — ADR-0018). This seam is the verification module's
 * input half for economic actions:
 *
 *  - `createEconomicDeliveryResolver` — the fail-closed TARGET RESOLVER
 *    for the `economic-delivery` target kind: the ref is the economic
 *    action id; it resolves ONLY when the economics module's public
 *    delivery-evidence bundle exists in the caller's application scope
 *    (a cross-application/cross-tenant lookup returns null → not
 *    resolved → typed failure before any evaluation).
 *
 *  - `economicDeliveryFacts` — the pure facts projector from the
 *    economics module's delivery-evidence bundle into verification
 *    EVIDENCE FACTS: settlement and delivery are projected as SEPARATE
 *    facts (settlementStatus / deliveryCount / deliveryKinds / digests)
 *    so declared criteria make delivery — not settlement — load-bearing.
 *    A settled action with no delivery observations projects
 *    `deliveryCount: 0`, which FAILS a `deliveryCount >= 1` criterion:
 *    payment-success-as-verification is unrepresentable by construction.
 *
 * The verification module remains the DELIVERY AUTHORITY: this adapter
 * consumes the economics public seam (data in), holds no economics
 * write surface, and the verdict is produced by the registered
 * evaluators against DECLARED criteria — never here.
 */

import type { EconomicActionService, EconomicDeliveryEvidence } from "../../economics/public";
import type { TargetResolution, TargetResolver } from "../ports/target-resolvers";

/**
 * The consumed economics seam (structural): any object exposing the
 * economics module's public `deliveryEvidence(applicationId, id)` read —
 * the delivery-evidence bundle (correlated settlement + delivery
 * observations, reported as SEPARATE axes).
 */
export type EconomicDeliveryEvidenceSource = Pick<EconomicActionService, "deliveryEvidence">;

export function createEconomicDeliveryResolver(
  source: EconomicDeliveryEvidenceSource,
): TargetResolver {
  return {
    async resolveTarget(input): Promise<TargetResolution> {
      const bundle = await source.deliveryEvidence(input.applicationId, input.target.ref);
      if (bundle === null) {
        return {
          resolved: false,
          reason:
            "economic-delivery target does not resolve in this application (missing or owned by another application)",
        };
      }
      if (bundle.executionId !== input.executionId) {
        return {
          resolved: false,
          reason: `economic action ${bundle.economicActionId} is bound to execution ${bundle.executionId}, not ${input.executionId}`,
        };
      }
      return { resolved: true };
    },
  };
}

/**
 * Pure projection: the delivery-evidence bundle → verification facts.
 * Settlement and delivery stay SEPARATE axes (the settlement≠delivery
 * invariant made mechanical).
 */
export function economicDeliveryFacts(
  bundle: EconomicDeliveryEvidence,
): Readonly<Record<string, unknown>> {
  return {
    economicActionId: bundle.economicActionId,
    economicActionStatus: bundle.status,
    settlementStatus: bundle.settlement?.status ?? null,
    settledAmountMicroUsd: bundle.settlement?.settledAmountMicroUsd ?? null,
    settlementRailId: bundle.settlement?.railId ?? null,
    deliveryCount: bundle.deliveries.length,
    deliveryKinds: bundle.deliveries.map((delivery) => delivery.kind),
    deliveryDigests: bundle.deliveries.map((delivery) => delivery.digest),
  };
}
