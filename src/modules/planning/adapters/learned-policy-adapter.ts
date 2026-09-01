/**
 * Learned-policy adapter (planning module adapter; WORK-020).
 *
 * Adapts the learning module's public `LearnedPolicySource` (the
 * non-authoritative projection of the ACTIVE learned-policy
 * publication) to the planning-owned `LearnedPolicySource` port.
 *
 * FAIL-CLOSED VALIDATION AT THE SEAM (three independent gates):
 *
 *  1. THE POLICIES-OWNED RESTRICTION-VOCABULARY BOUNDARY: the
 *     consulted record is scanned with
 *     `assertLearnedOutputFreeOfRestrictions` — a learned output
 *     carrying ANY policy restriction vocabulary (a prohibition
 *     field or dimension key, e.g. a smuggled `deniedProviders`)
 *     is REJECTED with `POLICY_DENIED` and can never reach the
 *     ordering input (LRN-002/AC-2: hard prohibitions are immutable
 *     to learning output — mechanically, at the consumer seam).
 *  2. THE PLANNING-SIDE ANCHOR VALIDATION: every consulted policy is
 *     validated with `validateConsultedLearnedPolicy` — the full
 *     versioning basis (policy id + version, publication id + mode +
 *     reason, digest, analysis/telemetry schema anchors, evaluation
 *     window) and the non-empty per-preference provenance must be
 *     present. An unversioned or unprovenanced record fails closed
 *     here and can NEVER reach a durable planning decision record.
 *  3. THE MODE GATE: the projection carries the publication mode —
 *     the planner decides ordering influence from it ('promoted'
 *     only); the adapter preserves it verbatim so a mutated mode can
 *     never be introduced here.
 *
 * This adapter only READS: the learned-policy source exposes exactly
 * one consult method; there is nothing here that could mutate
 * learning state, planning state or any authority.
 */

import type {
  ActiveLearnedPolicyView,
  LearnedPolicySource as LearningLearnedPolicySource,
} from "../../learning/public";
import { assertLearnedOutputFreeOfRestrictions } from "../../policies/public";
import type {
  ConsultedLearnedPolicy,
  ConsultedLearnedRoutePreference,
} from "../domain/learned-policy-consultation";
import { validateConsultedLearnedPolicy } from "../domain/learned-policy-consultation";
import type {
  LearnedPolicyQuery,
  LearnedPolicySource as PlanningLearnedPolicySource,
} from "../ports/learned-policy";

function toConsultedPolicy(view: ActiveLearnedPolicyView): ConsultedLearnedPolicy {
  const preferences: ConsultedLearnedRoutePreference[] = view.policy.preferences.map(
    (preference) => ({
      taskClass: preference.taskClass,
      ranked: preference.ranked.map((metric) => ({
        subjectKey: metric.subjectKey,
        population: metric.population,
        successCount: metric.successCount,
        successRate: metric.successRate,
        meanCostMicroUsd: metric.meanCostMicroUsd,
        meanLatencyMs: metric.meanLatencyMs,
        uncertaintyLevel: metric.uncertaintyLevel,
      })),
      confidenceLevel: preference.confidence.level,
      population: preference.population,
      windowFrom: preference.windowFrom,
      windowTo: preference.windowTo,
      evidenceRefs: [...preference.evidenceRefs],
      sourceExecutionIds: [...preference.sourceExecutionIds],
    }),
  );
  const consulted: ConsultedLearnedPolicy = {
    policyClass: view.policy.policyClass,
    policyId: view.policy.policyId,
    policyVersion: view.policy.policyVersion,
    publicationId: view.publication.publicationId,
    publicationMode: view.publication.publicationMode,
    publicationReason: view.publication.publicationReason,
    analysisVersion: view.policy.analysisVersion,
    telemetrySchemaVersion: view.policy.telemetrySchemaVersion,
    digest: view.policy.digest,
    evaluationWindowFrom: view.policy.evaluationWindowFrom,
    evaluationWindowTo: view.policy.evaluationWindowTo,
    preferences,
    publishedAt: view.publication.publishedAt,
  };
  // Gate 1: the policies-owned restriction-vocabulary boundary —
  // a learned output carrying policy vocabulary never crosses.
  assertLearnedOutputFreeOfRestrictions(consulted);
  // Gate 2: the planning-side anchor validation (versioning basis,
  // publication anchors, population floor, provenance).
  validateConsultedLearnedPolicy(consulted);
  return consulted;
}

export function createLearnedPolicyAdapter(
  source: LearningLearnedPolicySource,
): PlanningLearnedPolicySource {
  return {
    async consult(query: LearnedPolicyQuery) {
      const view = await source.consult({
        applicationId: query.applicationId,
        tenantId: query.tenantId,
        ...(query.taskClass === undefined ? {} : { taskClass: query.taskClass }),
      });
      if (view === null) {
        return null;
      }
      // Fail closed on any unversioned/malformed or restriction-
      // carrying learned output — the validation throws before
      // anything is returned to the planner.
      return toConsultedPolicy(view);
    },
  };
}
