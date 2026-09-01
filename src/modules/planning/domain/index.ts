/**
 * Planning module domain barrel (WORK-009 + WORK-017 composition seam +
 * WORK-020 learned-policy-consultation seam + WORK-022 opportunity-
 * consultation seam).
 */

export { canonicalJson, isCanonicalizable } from "./canonical";
export type {
  CompositionConsultation,
  ConsultedCompositionRecommendation,
} from "./composition-consultation";
export {
  buildCompositionConsultation,
  COMPOSITION_PREFERENCE_MINIMUM_POPULATION,
  CONSULTED_COMPOSITION_CLASS,
  CONSULTED_COMPOSITION_STATUSES,
  compositionAllowedByPolicy,
  compositionPreferredCandidateId,
  validateCompositionConsultation,
  validateConsultedCompositionRecommendation,
} from "./composition-consultation";
export type {
  CapabilityResolutionCapture,
  PlanningDecisionRecord,
  PolicyInputsCapture,
} from "./decision";
export {
  candidateById,
  canonicalDecisionForm,
  decisionRecordDigest,
  PLANNER_VERSION,
  validatePlanningDecision,
} from "./decision";
export type {
  ConsultedLearnedPolicy,
  ConsultedLearnedPolicyMode,
  ConsultedLearnedRouteMetric,
  ConsultedLearnedRoutePreference,
  LearnedPolicyConsultation,
} from "./learned-policy-consultation";
export {
  buildLearnedPolicyConsultation,
  CONSULTED_LEARNED_POLICY_CLASS,
  CONSULTED_LEARNED_POLICY_MODES,
  compareLearnedThenCheapFirst,
  LEARNED_PREFERENCE_MINIMUM_POPULATION,
  learnedOrderingSubjects,
  learnedPreferredCandidateId,
  splitRankedSubjectsByPolicy,
  validateConsultedLearnedPolicy,
  validateLearnedPolicyConsultation,
} from "./learned-policy-consultation";
export type {
  ConsultedLearningSignal,
  LearningConsultation,
} from "./learning-consultation";
export {
  buildLearningConsultation,
  CONSULTED_SIGNAL_CLASS,
  learningPreferredCandidateId,
  PREFERENCE_MINIMUM_POPULATION,
  validateConsultedSignal,
  validateLearningConsultation,
} from "./learning-consultation";
export type {
  ConsultedOpportunitySignal,
  OpportunityConsultation,
} from "./opportunity-consultation";
export {
  buildOpportunityConsultation,
  CONSULTED_OPPORTUNITY_CLASS,
  opportunityPreferredCandidateId,
  validateConsultedOpportunitySignal,
  validateOpportunityConsultation,
} from "./opportunity-consultation";
export type {
  BuildPlanInput,
  ExecutionPlan,
  PlanEdge,
  PlanStep,
  PlanStepClass,
  PlanStepRouteRef,
  StrategyClass,
} from "./plan";
export {
  buildPlan,
  canonicalPlanForm,
  GENERATIVE_STEP_CLASSES,
  isGenerativeStepClass,
  PLAN_STEP_CLASSES,
  STRATEGY_CLASSES,
} from "./plan";
export type {
  CandidateStrategy,
  InadmissibleReasonCode,
  RouteRationale,
  RouteRationaleCode,
  StrategySelection,
} from "./strategy";
export {
  compareCheapFirst,
  filterAdmissibility,
  routeAllowedByPolicy,
  selectStrategy,
} from "./strategy";
export type {
  ComputationType,
  OpportunityScore,
  SubgraphObservation,
} from "./subgraph-evidence";
export {
  COMPUTATION_TYPES,
  computationTypeOfStep,
  emitSubgraphEvidence,
} from "./subgraph-evidence";
export type {
  SubstrateCandidate,
  SubstrateInadmissibleReason,
  SubstrateRejection,
  SubstrateSelection,
} from "./substrate-selection";
export {
  isSubstrateInadmissibleReason,
  SUBSTRATE_INADMISSIBLE_REASONS,
  validateSubstrateSelection,
} from "./substrate-selection";
export type {
  DeterministicSufficiencyDecision,
  RequirementCoverage,
  SufficiencyInput,
  SufficiencyOutcome,
  SufficiencyReason,
  SufficiencyReasonCode,
} from "./sufficiency";
export { evaluateDeterministicSufficiency } from "./sufficiency";
export type {
  DeriveTaskProfileInput,
  OutputCharacteristics,
  TaskConstraintInput,
  TaskKind,
  TaskProfile,
  TaskRiskLevel,
} from "./task-profile";
export {
  deriveTaskProfile,
  TASK_KINDS,
  TASK_RISK_LEVELS,
} from "./task-profile";
export type { WorkloadClassProfile } from "./workload-class";
export {
  validateWorkloadClassProfile,
  WORKLOAD_CLASS_REQUIREMENTS,
  workloadClassProfileOf,
} from "./workload-class";
