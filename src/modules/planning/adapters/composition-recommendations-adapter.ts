/**
 * Composition recommendations adapter (planning module adapter; WORK-017).
 *
 * Adapts the learning module's public `CompositionRecommendationSource`
 * (the non-authoritative projection of the ACTIVE recommendation set)
 * to the planning-owned `CompositionRecommendations` port.
 *
 * FAIL-CLOSED VALIDATION AT THE SEAM (M11/M12/M13/M26): every
 * recommendation is validated with the planning-side
 * `validateConsultedCompositionRecommendation` — the full versioning
 * basis (set id + version, analysis version, schema versions, the
 * evaluation window), the pinned tool versions and the non-empty
 * provenance must be present. An unversioned, unprovenanced or
 * unpinned recommendation fails closed here and can NEVER reach a
 * durable planning decision record.
 *
 * This adapter only READS: the recommendation source exposes exactly
 * one consult method; there is nothing here that could mutate
 * learning state, planning state or any authority.
 */

import type {
  CompositionRecommendationSignal,
  CompositionRecommendationSource,
} from "../../learning/public";
import type { ConsultedCompositionRecommendation } from "../domain/composition-consultation";
import { validateConsultedCompositionRecommendation } from "../domain/composition-consultation";
import type {
  CompositionRecommendationQuery,
  CompositionRecommendations,
} from "../ports/composition-recommendations";

function toConsultedRecommendation(
  recommendation: CompositionRecommendationSignal,
): ConsultedCompositionRecommendation {
  const consulted: ConsultedCompositionRecommendation = {
    recommendationClass: recommendation.recommendationClass,
    taskClass: recommendation.context.taskClass,
    contextCapabilities: [...recommendation.context.capabilities],
    contextStrategyClass: recommendation.context.strategyClass,
    toolVersions: recommendation.toolVersions.map((tool) => ({
      toolId: tool.toolId,
      version: tool.version,
    })),
    toolCapabilityIds: [...recommendation.toolCapabilityIds],
    status: recommendation.status,
    rank: recommendation.rank,
    confidenceLevel: recommendation.confidence.level,
    population: recommendation.population,
    successCount: recommendation.successCount,
    successRate: recommendation.successRate,
    meanCostMicroUsd: recommendation.meanCostMicroUsd,
    meanLatencyMs: recommendation.meanLatencyMs,
    setId: recommendation.setId,
    setVersion: recommendation.setVersion,
    analysisVersion: recommendation.analysisVersion,
    compositionSchemaVersion: recommendation.compositionSchemaVersion,
    recommendationSchemaVersion: recommendation.recommendationSchemaVersion,
    evaluationWindowFrom: recommendation.evaluationWindowFrom,
    evaluationWindowTo: recommendation.evaluationWindowTo,
    evidenceRefs: [...recommendation.evidenceRefs],
    sourceExecutionIds: [...recommendation.sourceExecutionIds],
  };
  validateConsultedCompositionRecommendation(consulted);
  return consulted;
}

export function createCompositionRecommendationsAdapter(
  source: CompositionRecommendationSource,
): CompositionRecommendations {
  return {
    async consult(
      query: CompositionRecommendationQuery,
    ): Promise<readonly ConsultedCompositionRecommendation[]> {
      const recommendations = await source.consult({
        applicationId: query.applicationId,
        tenantId: query.tenantId,
        taskClass: query.taskClass,
      });
      // Fail closed on any unversioned/malformed recommendation — the
      // validation throws before anything is returned to the planner.
      return recommendations.map(toConsultedRecommendation);
    },
  };
}
