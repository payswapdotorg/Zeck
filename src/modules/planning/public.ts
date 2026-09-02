/**
 * Public contract barrel of the `planning` module (WORK-009).
 *
 * This file is the ONLY supported import surface for other modules and
 * for the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public
 * module rule"). Everything else under `src/modules/planning/` is private
 * to this module.
 *
 * WORK-009 introduces the deterministic-first execution planner
 * (INT-001/INT-003/INT-004; ACR-001/ADR-0007, ACR-002/ADR-0011/ADR-0012):
 *  - structured `TaskProfile` derivation from task input, constraints,
 *    output characteristics, risk and quality targets;
 *  - immutable typed execution-plan DAGs over the frozen architecture
 *    step classes — zero-model plans are first-class;
 *  - capability resolution BEFORE provider/model selection (the WORK-005
 *    authority through an adapter), the explicit deterministic-sufficiency
 *    decision, candidate strategies across deterministic/hybrid/
 *    generative/cascade/bounded-evaluation classes with cheap-first
 *    selection and hard policy admissibility (forbidden providers never
 *    win regardless of price);
 *  - subgraph-level evidence for later deterministicization discovery
 *    (DTR-001/DTR-004) — evidence only, never learning authority;
 *  - durable planning decisions appended through the executions ledger
 *    (`PlanningDecisionSink` → executions `recordPlanningDecision`), the
 *    single write path — idempotent, concurrency-arbitrated, tenant-scoped.
 *
 * The public surface is provider-independent by construction: provider
 * and model identifiers cross ONLY as opaque neutral strings inside route
 * references (exactly like the policy restriction vocabulary), never as
 * SDK types or adapter handles.
 */

import type { ModuleDescriptor } from "../../shared/module";
import { createCapabilityAuthorityAdapter } from "./adapters/capability-authority-adapter";
import { createCompositionRecommendationsAdapter } from "./adapters/composition-recommendations-adapter";
import { publishDeterministicCapabilityFacts } from "./adapters/deterministic-capability-publisher";
import {
  createInMemoryDeterministicCatalog,
  DETERMINISTIC_CATALOG_SEED,
} from "./adapters/in-memory-deterministic-catalog";
import { createLearnedPolicyAdapter } from "./adapters/learned-policy-adapter";
import type { LearningSignalsAdapterOptions } from "./adapters/learning-signals-adapter";
import { createLearningSignalsAdapter } from "./adapters/learning-signals-adapter";
import { createNodeDigest } from "./adapters/node-digest";
import { createOpportunitySignalsAdapter } from "./adapters/opportunity-signals-adapter";
import { createPlanningSinkAdapter } from "./adapters/planning-sink-adapter";
import { createPolicyInputsAdapter } from "./adapters/policy-inputs-adapter";
import { createRouteTableExplorer } from "./adapters/route-table-explorer";
import { createSubstrateCatalogAdapter } from "./adapters/substrate-catalog-adapter";
import type {
  PlanExecutionInput,
  PlannerService,
  PlannerServiceDeps,
  PlanningOutcome,
} from "./application/planner";
import { createPlannerService } from "./application/planner";
import type {
  BuildPlanInput,
  CandidateStrategy,
  CapabilityResolutionCapture,
  CompositionConsultation,
  ComputationType,
  ConsultedCompositionRecommendation,
  ConsultedLearnedPolicy,
  ConsultedLearnedPolicyMode,
  ConsultedLearnedRouteMetric,
  ConsultedLearnedRoutePreference,
  ConsultedLearningSignal,
  ConsultedOpportunitySignal,
  DeterministicSufficiencyDecision,
  ExecutionPlan,
  InadmissibleReasonCode,
  LearnedPolicyConsultation,
  LearningConsultation,
  OpportunityConsultation,
  OpportunityScore,
  OutputCharacteristics,
  PlanEdge,
  PlanningDecisionRecord,
  PlanStep,
  PlanStepClass,
  PlanStepRouteRef,
  PolicyInputsCapture,
  RequirementCoverage,
  RouteRationale,
  RouteRationaleCode,
  StrategyClass,
  StrategySelection,
  SubgraphObservation,
  SubstrateCandidate,
  SubstrateInadmissibleReason,
  SubstrateRejection,
  SubstrateSelection,
  SufficiencyInput,
  SufficiencyOutcome,
  SufficiencyReason,
  SufficiencyReasonCode,
  TaskConstraintInput,
  TaskKind,
  TaskProfile,
  TaskRiskLevel,
  WorkloadClassProfile,
} from "./domain";
import {
  buildCompositionConsultation,
  buildLearnedPolicyConsultation,
  buildLearningConsultation,
  buildOpportunityConsultation,
  buildPlan,
  COMPOSITION_PREFERENCE_MINIMUM_POPULATION,
  CONSULTED_COMPOSITION_CLASS,
  CONSULTED_COMPOSITION_STATUSES,
  CONSULTED_LEARNED_POLICY_CLASS,
  CONSULTED_LEARNED_POLICY_MODES,
  CONSULTED_OPPORTUNITY_CLASS,
  CONSULTED_SIGNAL_CLASS,
  canonicalDecisionForm,
  canonicalPlanForm,
  compareCheapFirst,
  compositionAllowedByPolicy,
  compositionPreferredCandidateId,
  computationTypeOfStep,
  decisionRecordDigest,
  deriveTaskProfile,
  emitSubgraphEvidence,
  evaluateDeterministicSufficiency,
  filterAdmissibility,
  isGenerativeStepClass,
  isSubstrateInadmissibleReason,
  LEARNED_PREFERENCE_MINIMUM_POPULATION,
  learnedOrderingSubjects,
  learnedPreferredCandidateId,
  learningPreferredCandidateId,
  opportunityPreferredCandidateId,
  PLAN_STEP_CLASSES,
  PLANNER_VERSION,
  PREFERENCE_MINIMUM_POPULATION,
  routeAllowedByPolicy,
  STRATEGY_CLASSES,
  SUBSTRATE_INADMISSIBLE_REASONS,
  selectStrategy,
  TASK_KINDS,
  TASK_RISK_LEVELS,
  validateCompositionConsultation,
  validateConsultedCompositionRecommendation,
  validateConsultedLearnedPolicy,
  validateConsultedOpportunitySignal,
  validateConsultedSignal,
  validateLearnedPolicyConsultation,
  validateLearningConsultation,
  validateOpportunityConsultation,
  validatePlanningDecision,
  validateSubstrateSelection,
  validateWorkloadClassProfile,
  WORKLOAD_CLASS_REQUIREMENTS,
  workloadClassProfileOf,
} from "./domain";
import type {
  CompositionRecommendationQuery,
  CompositionRecommendations,
  DeterministicCapabilityCatalog,
  DeterministicCatalogEntry,
  LearnedPolicyQuery,
  LearnedPolicySource,
  LearningSignalQuery,
  LearningSignals,
  ModelRouteCandidate,
  ModelRouteExplorer,
  OpportunitySignalQuery,
  OpportunitySignals,
  PlanningCapabilityAuthority,
  PlanningDecisionSink,
  PlanningPolicyInputs,
  PlanningSinkInput,
  PlanningSinkOutcome,
  ResolvedPolicyInputs,
  SubstrateCatalog,
  SubstrateCatalogEntry,
} from "./ports";

export const moduleDescriptor: ModuleDescriptor = { id: "planning" };

export type {
  BuildPlanInput,
  CandidateStrategy,
  CapabilityResolutionCapture,
  CompositionConsultation,
  CompositionRecommendationQuery,
  CompositionRecommendations,
  ComputationType,
  ConsultedCompositionRecommendation,
  ConsultedLearnedPolicy,
  ConsultedLearnedPolicyMode,
  ConsultedLearnedRouteMetric,
  ConsultedLearnedRoutePreference,
  ConsultedLearningSignal,
  ConsultedOpportunitySignal,
  DeterministicCapabilityCatalog,
  DeterministicCatalogEntry,
  DeterministicSufficiencyDecision,
  ExecutionPlan,
  InadmissibleReasonCode,
  LearnedPolicyConsultation,
  LearnedPolicyQuery,
  LearnedPolicySource,
  LearningConsultation,
  LearningSignalQuery,
  LearningSignals,
  LearningSignalsAdapterOptions,
  ModelRouteCandidate,
  ModelRouteExplorer,
  OpportunityConsultation,
  OpportunityScore,
  OpportunitySignalQuery,
  OpportunitySignals,
  OutputCharacteristics,
  PlanEdge,
  PlanExecutionInput,
  PlannerService,
  PlannerServiceDeps,
  PlanningCapabilityAuthority,
  PlanningDecisionRecord,
  PlanningDecisionSink,
  PlanningOutcome,
  PlanningPolicyInputs,
  PlanningSinkInput,
  PlanningSinkOutcome,
  PlanStep,
  PlanStepClass,
  PlanStepRouteRef,
  PolicyInputsCapture,
  RequirementCoverage,
  ResolvedPolicyInputs,
  RouteRationale,
  RouteRationaleCode,
  StrategyClass,
  StrategySelection,
  SubgraphObservation,
  SubstrateCandidate,
  SubstrateCatalog,
  SubstrateCatalogEntry,
  SubstrateInadmissibleReason,
  SubstrateRejection,
  SubstrateSelection,
  SufficiencyInput,
  SufficiencyOutcome,
  SufficiencyReason,
  SufficiencyReasonCode,
  TaskConstraintInput,
  TaskKind,
  TaskProfile,
  TaskRiskLevel,
  WorkloadClassProfile,
};
// Application: the deterministic-first planner service.
// Domain: task profiling (INT-001), immutable typed plan DAGs (INT-003),
// deterministic sufficiency + strategies + selection (INT-004, ADR-0007),
// the durable decision record + subgraph evidence (DTR-001/DTR-004).
// Ports: the outbound seams (catalog, authority, policy, routes, sink, digest).
// Adapters: node digest + in-memory catalog + composition-fed route table.
export {
  buildCompositionConsultation,
  buildLearnedPolicyConsultation,
  buildLearningConsultation,
  buildOpportunityConsultation,
  buildPlan,
  COMPOSITION_PREFERENCE_MINIMUM_POPULATION,
  CONSULTED_COMPOSITION_CLASS,
  CONSULTED_COMPOSITION_STATUSES,
  CONSULTED_LEARNED_POLICY_CLASS,
  CONSULTED_LEARNED_POLICY_MODES,
  CONSULTED_OPPORTUNITY_CLASS,
  CONSULTED_SIGNAL_CLASS,
  canonicalDecisionForm,
  canonicalPlanForm,
  compareCheapFirst,
  compositionAllowedByPolicy,
  compositionPreferredCandidateId,
  computationTypeOfStep,
  createCapabilityAuthorityAdapter,
  createCompositionRecommendationsAdapter,
  createInMemoryDeterministicCatalog,
  createLearnedPolicyAdapter,
  createLearningSignalsAdapter,
  createNodeDigest,
  createOpportunitySignalsAdapter,
  createPlannerService,
  createPlanningSinkAdapter,
  createPolicyInputsAdapter,
  createRouteTableExplorer,
  createSubstrateCatalogAdapter,
  DETERMINISTIC_CATALOG_SEED,
  decisionRecordDigest,
  deriveTaskProfile,
  emitSubgraphEvidence,
  evaluateDeterministicSufficiency,
  filterAdmissibility,
  isGenerativeStepClass,
  isSubstrateInadmissibleReason,
  LEARNED_PREFERENCE_MINIMUM_POPULATION,
  learnedOrderingSubjects,
  learnedPreferredCandidateId,
  learningPreferredCandidateId,
  opportunityPreferredCandidateId,
  PLAN_STEP_CLASSES,
  PLANNER_VERSION,
  PREFERENCE_MINIMUM_POPULATION,
  publishDeterministicCapabilityFacts,
  routeAllowedByPolicy,
  STRATEGY_CLASSES,
  SUBSTRATE_INADMISSIBLE_REASONS,
  selectStrategy,
  TASK_KINDS,
  TASK_RISK_LEVELS,
  validateCompositionConsultation,
  validateConsultedCompositionRecommendation,
  validateConsultedLearnedPolicy,
  validateConsultedOpportunitySignal,
  validateConsultedSignal,
  validateLearnedPolicyConsultation,
  validateLearningConsultation,
  validateOpportunityConsultation,
  validatePlanningDecision,
  validateSubstrateSelection,
  validateWorkloadClassProfile,
  WORKLOAD_CLASS_REQUIREMENTS,
  workloadClassProfileOf,
};
