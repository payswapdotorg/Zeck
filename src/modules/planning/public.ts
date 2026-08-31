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
import type { LearningSignalsAdapterOptions } from "./adapters/learning-signals-adapter";
import { createLearningSignalsAdapter } from "./adapters/learning-signals-adapter";
import { createNodeDigest } from "./adapters/node-digest";
import { createPlanningSinkAdapter } from "./adapters/planning-sink-adapter";
import { createPolicyInputsAdapter } from "./adapters/policy-inputs-adapter";
import { createRouteTableExplorer } from "./adapters/route-table-explorer";
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
  ConsultedLearningSignal,
  DeterministicSufficiencyDecision,
  ExecutionPlan,
  InadmissibleReasonCode,
  LearningConsultation,
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
  SufficiencyInput,
  SufficiencyOutcome,
  SufficiencyReason,
  SufficiencyReasonCode,
  TaskConstraintInput,
  TaskKind,
  TaskProfile,
  TaskRiskLevel,
} from "./domain";
import {
  buildCompositionConsultation,
  buildLearningConsultation,
  buildPlan,
  COMPOSITION_PREFERENCE_MINIMUM_POPULATION,
  CONSULTED_COMPOSITION_CLASS,
  CONSULTED_COMPOSITION_STATUSES,
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
  learningPreferredCandidateId,
  PLAN_STEP_CLASSES,
  PLANNER_VERSION,
  PREFERENCE_MINIMUM_POPULATION,
  routeAllowedByPolicy,
  STRATEGY_CLASSES,
  selectStrategy,
  TASK_KINDS,
  TASK_RISK_LEVELS,
  validateCompositionConsultation,
  validateConsultedCompositionRecommendation,
  validateConsultedSignal,
  validateLearningConsultation,
  validatePlanningDecision,
} from "./domain";
import type {
  CompositionRecommendationQuery,
  CompositionRecommendations,
  DeterministicCapabilityCatalog,
  DeterministicCatalogEntry,
  LearningSignalQuery,
  LearningSignals,
  ModelRouteCandidate,
  ModelRouteExplorer,
  PlanningCapabilityAuthority,
  PlanningDecisionSink,
  PlanningPolicyInputs,
  PlanningSinkInput,
  PlanningSinkOutcome,
  ResolvedPolicyInputs,
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
  ConsultedLearningSignal,
  DeterministicCapabilityCatalog,
  DeterministicCatalogEntry,
  DeterministicSufficiencyDecision,
  ExecutionPlan,
  InadmissibleReasonCode,
  LearningConsultation,
  LearningSignalQuery,
  LearningSignals,
  LearningSignalsAdapterOptions,
  ModelRouteCandidate,
  ModelRouteExplorer,
  OpportunityScore,
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
  SufficiencyInput,
  SufficiencyOutcome,
  SufficiencyReason,
  SufficiencyReasonCode,
  TaskConstraintInput,
  TaskKind,
  TaskProfile,
  TaskRiskLevel,
};
// Application: the deterministic-first planner service.
// Domain: task profiling (INT-001), immutable typed plan DAGs (INT-003),
// deterministic sufficiency + strategies + selection (INT-004, ADR-0007),
// the durable decision record + subgraph evidence (DTR-001/DTR-004).
// Ports: the outbound seams (catalog, authority, policy, routes, sink, digest).
// Adapters: node digest + in-memory catalog + composition-fed route table.
export {
  buildCompositionConsultation,
  buildLearningConsultation,
  buildPlan,
  COMPOSITION_PREFERENCE_MINIMUM_POPULATION,
  CONSULTED_COMPOSITION_CLASS,
  CONSULTED_COMPOSITION_STATUSES,
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
  createLearningSignalsAdapter,
  createNodeDigest,
  createPlannerService,
  createPlanningSinkAdapter,
  createPolicyInputsAdapter,
  createRouteTableExplorer,
  DETERMINISTIC_CATALOG_SEED,
  decisionRecordDigest,
  deriveTaskProfile,
  emitSubgraphEvidence,
  evaluateDeterministicSufficiency,
  filterAdmissibility,
  isGenerativeStepClass,
  learningPreferredCandidateId,
  PLAN_STEP_CLASSES,
  PLANNER_VERSION,
  PREFERENCE_MINIMUM_POPULATION,
  publishDeterministicCapabilityFacts,
  routeAllowedByPolicy,
  STRATEGY_CLASSES,
  selectStrategy,
  TASK_KINDS,
  TASK_RISK_LEVELS,
  validateCompositionConsultation,
  validateConsultedCompositionRecommendation,
  validateConsultedSignal,
  validateLearningConsultation,
  validatePlanningDecision,
};
