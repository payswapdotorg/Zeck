/**
 * `learning` application layer (WORK-014): the observational substrate
 * services — telemetry ingestion, scorecard building, signal
 * consultation, rating recording and the side-effect-free shadow
 * evaluator.
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
