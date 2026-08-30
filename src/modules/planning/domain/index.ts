/**
 * Planning module domain barrel (WORK-009).
 */

export { canonicalJson, isCanonicalizable } from "./canonical";
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
