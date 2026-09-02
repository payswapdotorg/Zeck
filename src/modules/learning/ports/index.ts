/**
 * `learning` ports layer (WORK-014/WORK-017) — outbound interfaces owned
 * by this module: the durable learning store, the composition store,
 * the digest seam.
 *
 * Ports are provider-neutral: no infrastructure clients, no provider
 * SDKs, no policy/budget/capability/execution seams (the shadow
 * evaluator, the learning service and the composition advisor have
 * NO authority deps by construction).
 */

export type {
  ActivationAppendOutcome,
  CompositionStore,
  RecommendationSetScope,
} from "./composition-store";
export { deterministicizationOperationKey, DETERMINISTICIZATION_OPERATION_KINDS } from "./deterministicization-store";
export type {
  CandidateInsertOutcome,
  CandidateTransitionOutcome,
  DecisionAppendOutcome,
  DeterministicizationOperationKind,
  DeterministicizationOperationRecord,
  DeterministicizationScope,
  DeterministicizationStore,
  OperationBeginInput,
  OperationBeginOutcome,
  RolloutConclusionInput,
  RolloutInsertOutcome,
  StageEvidenceInsertOutcome,
} from "./deterministicization-store";
export type { DigestPort } from "./digest";
export type {
  EvaluationAppendOutcome,
  LearnedPolicyScope,
  LearnedPolicyStore,
  PublicationAppendOutcome,
} from "./learned-policy-store";
export type {
  LearningStore,
  RatingIngestionOutcome,
  ScorecardScope,
  TelemetryIngestionOutcome,
  TelemetryQuery,
} from "./learning-store";
export type {
  AnalysisInsertOutcome,
  FindingInsertOutcome,
  OpportunityScope,
  OpportunityStore,
  RatingInsertOutcome,
  TransitionAppendOutcome,
} from "./opportunity-store";
