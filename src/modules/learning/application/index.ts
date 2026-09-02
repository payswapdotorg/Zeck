/**
 * `learning` application layer (WORK-014/WORK-020): the observational
 * substrate services — telemetry ingestion, scorecard building, signal
 * consultation, rating recording, the side-effect-free shadow evaluator
 * and the WORK-020 learned planning-policy lifecycle service
 * (generation → shadow/canary evaluation → explicit publication →
 * deterministic rollback; the non-authority quartet of deps).
 */
export type {
  ActivateRecommendationSetRequest,
  CompositionAdvisor,
  CompositionAdvisorDeps,
  ConsultRecommendationsRequest,
  GenerateRecommendationSetRequest,
} from "./composition-advisor";
export { createCompositionAdvisor } from "./composition-advisor";
export type {
  ApplyPromotionRequest,
  BeginRolloutRequest,
  ConcludeRolloutRequest,
  ConsultDeterministicizationRequest,
  DecisionRequest,
  DeterministicizationService,
  DeterministicizationServiceDeps,
  DeterministicizationSignal,
  DiscoverCandidatesRequest,
  ProposeCandidateRequest,
  RecordStageEvidenceRequest,
  RolloutDeltaProjection,
} from "./deterministicization-service";
export { createDeterministicizationService } from "./deterministicization-service";
export type {
  ActiveLearnedPolicyView,
  ConsultLearnedPolicyRequest,
  EvaluateLearnedPolicyRequest,
  GenerateLearnedPolicyRequest,
  LearnedPolicyService,
  LearnedPolicyServiceDeps,
  PublishLearnedPolicyRequest,
  RollbackLearnedPolicyRequest,
} from "./learned-policy-service";
export { createLearnedPolicyService } from "./learned-policy-service";
export type {
  BuildScorecardRequest,
  ConsultSignalsRequest,
  LearningService,
  LearningServiceDeps,
  RecordRatingInput,
  RecordTelemetryInput,
} from "./learning-service";
export { createLearningService } from "./learning-service";
export type {
  AdvanceFindingRequest,
  AnalyzeSubgraphRequest,
  ConsultOpportunitySignalsRequest,
  OpportunityAnalyzer,
  OpportunityAnalyzerDeps,
  OpportunitySignal,
  RecordEvaluationRatingInput,
} from "./opportunity-analyzer";
export { createOpportunityAnalyzer } from "./opportunity-analyzer";
export type {
  EvaluateShadowInput,
  ShadowEvaluator,
  ShadowEvaluatorDeps,
  ShadowStrategyInput,
} from "./shadow-evaluator";
export { createShadowEvaluator } from "./shadow-evaluator";
