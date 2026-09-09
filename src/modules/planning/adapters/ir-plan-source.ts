/**
 * The planning-side IR derivation seam (planning module adapter;
 * WORK-049 — the module-side implementation of the platform
 * execution-ir plane's `PlanDerivationSeam` + constraint derivation).
 *
 * The planning module stays the intent-to-plan authority and the owner
 * of decision semantics; this adapter is a PURE, READ-ONLY converter:
 *
 *  - `toPlanSnapshot(plan)` — converts a governed `ExecutionPlan`
 *    (planning domain) into the platform plane's neutral
 *    `GovernedPlanSnapshot`. The snapshot carries the planning
 *    authority's own content-addressed `planId` VERBATIM — the platform
 *    derivation verifies the snapshot content digests to it (the
 *    anti-second-authority boundary: the IR can only represent an
 *    actual governed plan, and the conversion is lossless by
 *    construction — every semantic field is carried, nothing is
 *    re-derived or dropped);
 *  - `constraintsFromPlanningInputs(...)` — converts the planning
 *    decision's CAPTURED governing inputs (the effective policy
 *    restriction set + the capability resolution) into the platform
 *    plane's neutral constraint shapes, field-for-field. Policy
 *    semantics stay the policy module's; capability semantics stay the
 *    capability authority's — nothing is invented here, and the
 *    planning-captured anchors (policy set identity, catalog revision)
 *    ride along as the constraints' authority provenance.
 */

import type {
  BudgetConstraintPayload,
  LatencyConstraintPayload,
  OptimizationConstraint,
  PolicyConstraintPayload,
  QualityConstraintPayload,
  SideEffectConstraintPayload,
} from "../../../platform/execution-ir/constraints";
import type { GovernedPlanSnapshot } from "../../../platform/execution-ir/ir";
import type { CapabilityResolutionCapture, PolicyInputsCapture } from "../domain/decision";
import type { ExecutionPlan } from "../domain/plan";

/** The planning-side seam: governed plan → neutral IR snapshot. */
export function createIrPlanSource(): {
  toPlanSnapshot(plan: ExecutionPlan): GovernedPlanSnapshot;
} {
  return {
    toPlanSnapshot(plan) {
      return {
        planId: plan.planId,
        revision: plan.revision,
        strategyClass: plan.strategyClass,
        steps: plan.steps.map((step) => ({
          id: step.id,
          stepClass: step.stepClass,
          ...(step.capabilityId === undefined ? {} : { capabilityId: step.capabilityId }),
          ...(step.routeRef === undefined ? {} : { routeRef: step.routeRef }),
          ...(step.config === undefined ? {} : { config: step.config }),
          ...(step.verificationStrategy === undefined
            ? {}
            : { verificationStrategy: step.verificationStrategy }),
        })),
        edges: plan.edges.map((edge) => ({ from: edge.from, to: edge.to })),
      };
    },
  };
}

/**
 * Convert the planning decision's captured policy inputs into the
 * neutral constraint set (field-for-field mirrors; the authority
 * anchors ride along as provenance). Returns the constraints the
 * platform plane can validate and enforce — policy-sourced constraints
 * are HARD by construction.
 */
export function constraintsFromPolicyInputs(
  policyInputs: PolicyInputsCapture,
): readonly OptimizationConstraint[] {
  if (policyInputs.outcome !== "allow" || policyInputs.effective === undefined) {
    // A denied or unconstrained resolution has no effective restriction
    // set to mirror — the planner's own authority handles denial; this
    // seam never fabricates constraints.
    return [];
  }
  const restrictions = policyInputs.effective;
  const source = {
    authority: "policy" as const,
    ...(policyInputs.policySetId === undefined ? {} : { policySetId: policyInputs.policySetId }),
    ...(policyInputs.policySetVersion === undefined
      ? {}
      : { policySetVersion: policyInputs.policySetVersion }),
    ...(policyInputs.policyContentHash === undefined
      ? {}
      : { policyContentHash: policyInputs.policyContentHash }),
    ...(policyInputs.restrictionSetDigest === undefined
      ? {}
      : { restrictionSetDigest: policyInputs.restrictionSetDigest }),
  };
  const constraints: OptimizationConstraint[] = [];

  const eligibility: PolicyConstraintPayload = {
    ...(restrictions.providerModel === undefined
      ? {}
      : { providerModel: restrictions.providerModel }),
    ...(restrictions.tool === undefined ? {} : { tool: restrictions.tool }),
  };
  if (eligibility.providerModel !== undefined || eligibility.tool !== undefined) {
    constraints.push({
      constraintId: "policy-eligibility",
      kind: "policy",
      enforcement: "hard",
      source,
      payload: eligibility,
    });
  }
  if (restrictions.cost?.maxCostMicroUsd !== undefined) {
    const payload: BudgetConstraintPayload = { maxCostMicroUsd: restrictions.cost.maxCostMicroUsd };
    constraints.push({
      constraintId: "policy-cost-ceiling",
      kind: "budget",
      enforcement: "hard",
      source,
      payload,
    });
  }
  if (restrictions.quality?.minQuality !== undefined) {
    const payload: QualityConstraintPayload = { minQuality: restrictions.quality.minQuality };
    constraints.push({
      constraintId: "policy-quality-floor",
      kind: "quality",
      enforcement: "hard",
      source,
      payload,
    });
  }
  if (restrictions.latency?.maxLatencyMs !== undefined) {
    const payload: LatencyConstraintPayload = { maxLatencyMs: restrictions.latency.maxLatencyMs };
    constraints.push({
      constraintId: "policy-latency-ceiling",
      kind: "latency",
      enforcement: "hard",
      source,
      payload,
    });
  }
  const sideEffect: SideEffectConstraintPayload = {
    ...(restrictions.network === undefined ? {} : { network: restrictions.network }),
    ...(restrictions.secrets === undefined ? {} : { secrets: restrictions.secrets }),
    ...(restrictions.autonomy === undefined ? {} : { autonomy: restrictions.autonomy }),
    ...(restrictions.isolation === undefined ? {} : { isolation: restrictions.isolation }),
  };
  if (
    sideEffect.network !== undefined ||
    sideEffect.secrets !== undefined ||
    sideEffect.autonomy !== undefined ||
    sideEffect.isolation !== undefined
  ) {
    constraints.push({
      constraintId: "policy-side-effect",
      kind: "side-effect",
      enforcement: "hard",
      source,
      payload: sideEffect,
    });
  }
  return constraints;
}

/**
 * Convert the planning decision's capability-resolution capture into
 * the neutral capability constraint (exactly the satisfied/unmet ids
 * the capability authority produced at planning time; hard by
 * construction).
 */
export function capabilityConstraintFromResolution(
  resolution: CapabilityResolutionCapture,
): OptimizationConstraint {
  return {
    constraintId: "capability-satisfaction",
    kind: "capability",
    enforcement: "hard",
    source: { authority: "capability", catalogRevision: resolution.catalogRevision },
    payload: {
      satisfiedIds: [...resolution.satisfiedIds],
      unmetIds: [...resolution.unmetIds],
    },
  };
}
