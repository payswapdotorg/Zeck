/**
 * Planning module ports barrel (WORK-009 + WORK-014 learning seam +
 * WORK-017 composition seam + WORK-020 learned-policy seam +
 * WORK-022 opportunity seam).
 */

export type { PlanningCapabilityAuthority } from "./capability-authority";
export type {
  CompositionRecommendationQuery,
  CompositionRecommendations,
} from "./composition-recommendations";
export type {
  CapabilityKindValue,
  DeterministicCapabilityCatalog,
  DeterministicCatalogEntry,
  QualityConfidence,
} from "./deterministic-catalog";
export type { DigestPort } from "./digest";
export type {
  LearnedPolicyQuery,
  LearnedPolicySource,
} from "./learned-policy";
export type { LearningSignalQuery, LearningSignals } from "./learning-signals";
export type { ModelRouteCandidate, ModelRouteExplorer } from "./model-routes";
export type { OpportunitySignalQuery, OpportunitySignals } from "./opportunity-signals";
export type {
  PlanningDecisionSink,
  PlanningSinkInput,
  PlanningSinkOutcome,
} from "./planning-sink";
export type { PlanningPolicyInputs, ResolvedPolicyInputs } from "./policy-inputs";
export type { SubstrateCatalog, SubstrateCatalogEntry } from "./substrate-catalog";
