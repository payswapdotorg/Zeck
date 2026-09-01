/**
 * Public contract barrel of the `learning` module (WORK-014; WORK-022
 * adds the codebase-opportunity advisory surface).
 *
 * This file is the ONLY supported import surface for other modules and
 * for the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public
 * module rule"). Everything else under `src/modules/learning/` is private
 * to this module.
 *
 * WORK-014 introduces the OBSERVATIONAL learning substrate (LRN-001,
 * TOL-003, INT-006; `spec/architecture.md` §19, ADR-0005):
 *
 *  - `ExecutionOutcomeTelemetry`: the immutable closed-shape observation
 *    of ONE terminal execution (task class, context strategy,
 *    capabilities, plan/revision identity, routes, tools, environments,
 *    verification observations, cost, latency, outcome, subgraph
 *    identity, evidence refs, schema version) — physically bound to its
 *    source execution (migration 0009: FK + UNIQUE(execution_id), ONE
 *    authoritative observation per execution, converge-or-fail-closed
 *    idempotency);
 *  - versioned immutable `Scorecard`s computed from telemetry
 *    populations through the frozen `AGGREGATION_DEFINITIONS` registry
 *    (per-entry source executions + evidence refs; uncertainty
 *    preserved; no in-place mutation — every population snapshot is a
 *    NEW version);
 *  - `LearningSignal`: the non-authoritative, fully versioned projection
 *    of a scorecard entry that planning READS (the `LearningSignalSource`
 *    seam below; LEARNING SIGNAL ≠ AUTHORIZATION — the frozen §10
 *    invariant);
 *  - shadow evaluation: `evaluateShadowStrategy` scores a proposed
 *    strategy against the LATEST durable scorecard version (existing
 *    evidence) and appends an immutable `ShadowEvaluationRecord` —
 *    WITHOUT dispatching the proposed strategy, touching live routing,
 *    policy, budgets, capabilities or execution state (M7/M8: the
 *    evaluator's deps are store + digest + clock + id only — a live side
 *    effect is unrepresentable in its wiring);
 *  - user/human ratings as immutable learning evidence (never authority);
 *  - WORK-022 codebase-opportunity advisory analysis (DTR-005,
 *    HUM-001..003): customer-selected subgraphs -> normalized
 *    execution graphs -> advisory findings (deterministic-replacement
 *    CANDIDATES, honest confidence, observed-or-unknown cost/latency)
 *    -> selective human-evaluation prompts gated by the deterministic
 *    value-of-information rule -> evaluation ratings as immutable
 *    preference-only evidence -> the evidence-gated advisory ->
 *    candidate -> verified finding transitions (never 'promoted':
 *    promotion belongs to the external validation gate). The analyzer
 *    runs as part of a governed EXECUTION composed by the API layer
 *    through the executions authority's public contract ("Analysis is
 *    an Execution"); the learning module itself stays a pure
 *    observation island.
 *
 * THE NON-AUTHORITY BOUNDARY (LEARNING-NONAUTHORITY checkpoint): nothing
 * in this module authorizes, dispatches or mutates. There is no policy
 * seam, budget seam, capability seam, execution-transition seam or
 * provider adapter anywhere under `src/modules/learning/` (the
 * architecture test pins the import boundary; the discrimination
 * red-records prove mutated wirings are detected). Learned output alone
 * can NEVER authorize a forbidden route (M1): the planner consults
 * signals as recorded evidence while policy admissibility, the
 * deterministic-first preference and cheap-first selection stay
 * authoritative in `src/modules/planning/`.
 */

import type { ModuleDescriptor } from "../../shared/module";
import type {
  InMemoryCompositionStore,
  TelemetrySource,
} from "./adapters/in-memory-composition-store";
import { createInMemoryCompositionStore } from "./adapters/in-memory-composition-store";
import type { InMemoryLearningStore } from "./adapters/in-memory-learning-store";
import { createInMemoryLearningStore } from "./adapters/in-memory-learning-store";
import type { InMemoryOpportunityStore } from "./adapters/in-memory-opportunity-store";
import { createInMemoryOpportunityStore } from "./adapters/in-memory-opportunity-store";
import { createNodeDigest } from "./adapters/node-digest";
import { SqlCompositionStore } from "./adapters/sql-composition-store";
import { SqlLearningStore } from "./adapters/sql-learning-store";
import { SqlOpportunityStore } from "./adapters/sql-opportunity-store";
import type {
  ActivateRecommendationSetRequest,
  CompositionAdvisor,
  CompositionAdvisorDeps,
  ConsultRecommendationsRequest,
  GenerateRecommendationSetRequest,
} from "./application/composition-advisor";
import { createCompositionAdvisor } from "./application/composition-advisor";
import type {
  LearningService,
  LearningServiceDeps,
  RecordRatingInput,
  RecordTelemetryInput,
} from "./application/learning-service";
import { createLearningService } from "./application/learning-service";
import type {
  AdvanceFindingRequest,
  AnalyzeSubgraphRequest,
  ConsultOpportunitySignalsRequest,
  OpportunityAnalyzer,
  OpportunityAnalyzerDeps,
  OpportunitySignal,
  RecordEvaluationRatingInput,
} from "./application/opportunity-analyzer";
import { createOpportunityAnalyzer } from "./application/opportunity-analyzer";
import type {
  EvaluateShadowInput,
  ShadowEvaluator,
  ShadowEvaluatorDeps,
} from "./application/shadow-evaluator";
import { createShadowEvaluator } from "./application/shadow-evaluator";
import type {
  CompositionCheck,
  CompositionEdge,
  CompositionStep,
  CompositionUnsupportedReason,
  ToolComposition,
} from "./domain/composition";
import {
  COMPOSITION_SCHEMA_VERSION,
  COMPOSITION_UNSUPPORTED_REASONS,
  checkToolComposition,
  compositionToolRefs,
  edgeCompatible,
  linearCompositionOf,
} from "./domain/composition";
import type {
  CompositionRecommendation,
  CompositionRecommendationSet,
  CompositionRecommendationSignal,
  CompositionRecommendationStatus,
  OutcomeCount,
  PopulationContextKey,
  RecommendationConfidence,
  RecommendationSetActivation,
} from "./domain/composition-analysis";
import {
  analyzeToolSequences,
  COMPOSITION_ANALYSIS_VERSION,
  COMPOSITION_RECOMMENDATION_CLASS,
  COMPOSITION_RECOMMENDATION_SCHEMA_VERSION,
  COMPOSITION_RECOMMENDATION_STATUSES,
  canonicalContextKey,
  classifyRecommendationConfidence,
  MINIMUM_SEQUENCE_POPULATION,
  populationContextKeyOf,
  RECOMMENDATION_ACTIVATION_REASONS,
  recommendationSetDigestBasis,
  signalFromRecommendation,
  toolSequenceOf,
  validateCompositionRecommendation,
  validateCompositionRecommendationSet,
  validateRecommendationSetActivation,
} from "./domain/composition-analysis";
import type { EvaluationRatingRecord } from "./domain/evaluation-rating";
import {
  EVALUATION_RATING_ANSWERS,
  EVALUATION_RATING_SCHEMA_VERSION,
  evaluationRatingFingerprintBasis,
  isEvaluationRatingAnswer,
  validateEvaluationRating,
} from "./domain/evaluation-rating";
import type {
  ExecutionGraph,
  ExecutionGraphEdge,
  ExecutionGraphNode,
  ExecutionGraphNodeKind,
  NodeObservation,
  SelectedSubgraph,
  SourceProvenance,
} from "./domain/execution-graph";
import {
  buildExecutionGraph,
  EXECUTION_GRAPH_EDGE_RELATIONS,
  EXECUTION_GRAPH_NODE_KINDS,
  EXECUTION_GRAPH_SCHEMA_VERSION,
  isExecutionGraphNodeKind,
  validateExecutionGraph,
} from "./domain/execution-graph";
import type { FindingTransitionRecord } from "./domain/finding-transitions";
import {
  FINDING_TRANSITION_EVIDENCE_KINDS,
  FINDING_TRANSITION_SCHEMA_VERSION,
  FINDING_TRANSITION_TABLE,
  isFindingTransitionEvidenceKind,
  type VerifiedEquivalenceEvidence,
  validateFindingTransition,
  validateFindingTransitionRecord,
  validateVerifiedEquivalenceEvidence,
} from "./domain/finding-transitions";
import type {
  EvaluationPrompt,
  EvaluationQuestionKind,
  FrictionConfig,
} from "./domain/human-evaluation";
import {
  DEFAULT_FRICTION_CONFIG,
  DEFAULT_MAX_PROMPTS,
  DEFAULT_USER_FRICTION_THRESHOLD,
  decideEvaluationPrompts,
  EVALUATION_PROMPT_SCHEMA_VERSION,
  EVALUATION_QUESTION_KINDS,
  EVALUATION_QUESTIONS,
  EXPECTED_INFORMATION_GAIN,
  isEvaluationQuestionKind,
  questionKindForClass,
  validateEvaluationPrompt,
} from "./domain/human-evaluation";
import type {
  CostImpact,
  DeterministicEquivalence,
  DeterministicEquivalencePotential,
  FindingConfidenceLevel,
  FindingState,
  ImpactBasis,
  LatencyImpact,
  OpportunityAnalysis,
  OpportunityClass,
  OpportunityFinding,
} from "./domain/opportunity-analysis";
import {
  buildFindings,
  CACHEABLE_INPUT_RATIO,
  CONFIDENCE_HIGH_POPULATION,
  CONFIDENCE_LOW_POPULATION,
  CONFIDENCE_MEDIUM_POPULATION,
  CONSTANT_OUTPUT_CEILING,
  classifyFindingConfidence,
  DETERMINISTIC_EQUIVALENCE_POTENTIALS,
  detectOpportunities,
  FINDING_CONFIDENCE_LEVELS,
  FINDING_STATES,
  HIGH_ERROR_RATE,
  IMPACT_BASES,
  INSERTABLE_FINDING_STATES,
  isFindingConfidenceLevel,
  isFindingState,
  isOpportunityClass,
  LOW_ERROR_RATE,
  MINIMUM_DETERMINISTIC_POPULATION,
  OPPORTUNITY_ANALYSIS_SCHEMA_VERSION,
  OPPORTUNITY_ANALYSIS_VERSION,
  OPPORTUNITY_CLASSES,
  OPPORTUNITY_FINDING_SCHEMA_VERSION,
  opportunityAnalysisDigestBasis,
  validateOpportunityFinding,
} from "./domain/opportunity-analysis";
import type { UserRatingRecord } from "./domain/rating";
import {
  RATING_MAX,
  RATING_MIN,
  RATING_SCHEMA_VERSION,
  RATING_SOURCES,
  ratingFingerprintBasis,
  validateUserRating,
} from "./domain/rating";
import type {
  AggregationDefinition,
  Scorecard,
  ScorecardEntry,
  ScorecardSubjectKind,
  ScorecardUncertainty,
  UncertaintyLevel,
} from "./domain/scorecard";
import {
  AGGREGATION_DEFINITIONS,
  buildScorecard,
  findAggregationDefinition,
  isScorecardSubjectKind,
  SCORECARD_SUBJECT_KINDS,
  scorecardDigestBasis,
  UNCERTAINTY_LEVELS,
  validateScorecard,
} from "./domain/scorecard";
import type {
  ShadowComparison,
  ShadowEvaluationBasis,
  ShadowEvaluationRecord,
  ShadowEvaluationStatus,
  ShadowRecordClass,
  ShadowStrategyDescription,
  ShadowSubjectScore,
} from "./domain/shadow";
import {
  compareShadowScores,
  isShadowEvaluationStatus,
  SHADOW_EVALUATION_STATUSES,
  SHADOW_RECORD_CLASSES,
  SHADOW_SCHEMA_VERSION,
  scoreShadowSubjects,
  validateShadowEvaluationRecord,
} from "./domain/shadow";
import type { LearningSignal } from "./domain/signal";
import {
  LEARNING_SIGNAL_CLASS,
  LEARNING_SIGNAL_SCHEMA_VERSION,
  signalFromScorecardEntry,
  validateLearningSignal,
} from "./domain/signal";
import type {
  ExecutionOutcomeTelemetry,
  RouteObservation,
  SubgraphTelemetryObservation,
  TelemetryOutcome,
  VerificationObservation,
} from "./domain/telemetry";
import {
  isTelemetryOutcome,
  TELEMETRY_OUTCOMES,
  TELEMETRY_SCHEMA_VERSION,
  telemetryFingerprintBasis,
  validateExecutionTelemetry,
} from "./domain/telemetry";
import type {
  ToolFact,
  ToolFactCatalog,
  ToolFactField,
  ToolFactFieldType,
  ToolFactOrigin,
  ToolVersionRef,
} from "./domain/tool-facts";
import {
  findToolFact,
  TOOL_FACT_FIELD_TYPES,
  TOOL_FACT_ORIGINS,
  toolExistsInCatalog,
  validateToolFacts,
} from "./domain/tool-facts";
import type {
  ActivationAppendOutcome,
  CompositionStore,
  RecommendationSetScope,
} from "./ports/composition-store";
import type { DigestPort } from "./ports/digest";
import type {
  LearningStore,
  RatingIngestionOutcome,
  ScorecardScope,
  TelemetryIngestionOutcome,
  TelemetryQuery,
} from "./ports/learning-store";
import type {
  AnalysisInsertOutcome,
  FindingInsertOutcome,
  OpportunityScope,
  OpportunityStore,
  RatingInsertOutcome,
  TransitionAppendOutcome,
} from "./ports/opportunity-store";

export const moduleDescriptor: ModuleDescriptor = { id: "learning" };

/**
 * The READ seam planning consumes for tool-composition
 * recommendations (WORK-017 / advisory evidence, never authority:
 * RECOMMENDATION ≠ AUTHORIZATION — the frozen §10 invariant).
 */
export interface CompositionRecommendationSource {
  consult(request: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly taskClass?: string;
  }): Promise<readonly CompositionRecommendationSignal[]>;
}

/**
 * Adapt the composition advisor into the recommendation READ seam (a
 * projection, never an authority: recommendations leave as validated
 * immutable evidence records).
 */
export function createCompositionRecommendationSource(
  advisor: CompositionAdvisor,
): CompositionRecommendationSource {
  return {
    async consult(request) {
      return advisor.consultRecommendations(request);
    },
  };
}

/** The READ seam planning consumes (implemented over `consultSignals`). */
export interface LearningSignalSource {
  consult(request: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly definitionId: string;
    readonly taskClass?: string;
    readonly subjectKeys?: readonly string[];
  }): Promise<readonly LearningSignal[]>;
}

/**
 * Adapt the learning service into the signal READ seam (a projection,
 * never an authority: signals leave as validated immutable evidence).
 */
export function createLearningSignalSource(service: LearningService): LearningSignalSource {
  return {
    async consult(request) {
      return service.consultSignals(request);
    },
  };
}

/**
 * The READ seam for codebase-opportunity findings (WORK-022; DTR-005
 * advisory evidence, never authority: FINDING ≠ AUTHORIZATION — the
 * frozen §10/§17 invariant). Planning or developer tooling may consult
 * the validated, version-anchored, provenance-pinned signals; there is
 * no method here that could change a plan, an authorization, a policy,
 * a budget or any state (the same shape as the two seams above).
 */
export interface OpportunitySignalSource {
  consult(request: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly repository?: string;
    readonly class?: string;
    readonly analysisId?: string;
  }): Promise<readonly OpportunitySignal[]>;
}

/**
 * Adapt the opportunity analyzer into the finding READ seam (a
 * projection, never an authority: findings leave as validated immutable
 * evidence records with their full provenance anchors).
 */
export function createOpportunitySignalSource(
  analyzer: OpportunityAnalyzer,
): OpportunitySignalSource {
  return {
    async consult(request) {
      return analyzer.consultOpportunitySignals(request);
    },
  };
}

// Application: the observational services.
// Domain: the observation model (telemetry, scorecards, signals, shadow,
// ratings) + the tool-composition learning model (facts, compositions,
// analysis, recommendation sets).
// Ports: the durable store seam + the composition store seam + the digest seam.
// Adapters: in-memory stores (reference semantics), node digest
// (crypto confinement), SQL stores (migrations 0009 + 0010).
export type {
  ActivateRecommendationSetRequest,
  ActivationAppendOutcome,
  AdvanceFindingRequest,
  AggregationDefinition,
  AnalysisInsertOutcome,
  AnalyzeSubgraphRequest,
  CompositionAdvisor,
  CompositionAdvisorDeps,
  CompositionCheck,
  CompositionEdge,
  CompositionRecommendation,
  CompositionRecommendationSet,
  CompositionRecommendationSignal,
  CompositionRecommendationStatus,
  CompositionStep,
  CompositionStore,
  CompositionUnsupportedReason,
  ConsultOpportunitySignalsRequest,
  ConsultRecommendationsRequest,
  CostImpact,
  DeterministicEquivalence,
  DeterministicEquivalencePotential,
  DigestPort,
  EvaluateShadowInput,
  EvaluationPrompt,
  EvaluationQuestionKind,
  EvaluationRatingRecord,
  ExecutionGraph,
  ExecutionGraphEdge,
  ExecutionGraphNode,
  ExecutionGraphNodeKind,
  ExecutionOutcomeTelemetry,
  FindingConfidenceLevel,
  FindingInsertOutcome,
  FindingState,
  FindingTransitionRecord,
  FrictionConfig,
  GenerateRecommendationSetRequest,
  ImpactBasis,
  InMemoryCompositionStore,
  InMemoryLearningStore,
  InMemoryOpportunityStore,
  LatencyImpact,
  LearningService,
  LearningServiceDeps,
  LearningSignal,
  LearningStore,
  NodeObservation,
  OpportunityAnalysis,
  OpportunityAnalyzer,
  OpportunityAnalyzerDeps,
  OpportunityClass,
  OpportunityFinding,
  OpportunityScope,
  OpportunitySignal,
  OpportunityStore,
  OutcomeCount,
  PopulationContextKey,
  RatingIngestionOutcome,
  RatingInsertOutcome,
  RecommendationConfidence,
  RecommendationSetActivation,
  RecommendationSetScope,
  RecordEvaluationRatingInput,
  RecordRatingInput,
  RecordTelemetryInput,
  RouteObservation,
  Scorecard,
  ScorecardEntry,
  ScorecardScope,
  ScorecardSubjectKind,
  ScorecardUncertainty,
  SelectedSubgraph,
  ShadowComparison,
  ShadowEvaluationBasis,
  ShadowEvaluationRecord,
  ShadowEvaluationStatus,
  ShadowEvaluator,
  ShadowEvaluatorDeps,
  ShadowRecordClass,
  ShadowStrategyDescription,
  ShadowSubjectScore,
  SourceProvenance,
  SubgraphTelemetryObservation,
  TelemetryIngestionOutcome,
  TelemetryOutcome,
  TelemetryQuery,
  TelemetrySource,
  ToolComposition,
  ToolFact,
  ToolFactCatalog,
  ToolFactField,
  ToolFactFieldType,
  ToolFactOrigin,
  ToolVersionRef,
  TransitionAppendOutcome,
  UncertaintyLevel,
  UserRatingRecord,
  VerificationObservation,
  VerifiedEquivalenceEvidence,
};
export {
  AGGREGATION_DEFINITIONS,
  analyzeToolSequences,
  buildExecutionGraph,
  buildFindings,
  buildScorecard,
  CACHEABLE_INPUT_RATIO,
  COMPOSITION_ANALYSIS_VERSION,
  COMPOSITION_RECOMMENDATION_CLASS,
  COMPOSITION_RECOMMENDATION_SCHEMA_VERSION,
  COMPOSITION_RECOMMENDATION_STATUSES,
  COMPOSITION_SCHEMA_VERSION,
  COMPOSITION_UNSUPPORTED_REASONS,
  CONFIDENCE_HIGH_POPULATION,
  CONFIDENCE_LOW_POPULATION,
  CONFIDENCE_MEDIUM_POPULATION,
  CONSTANT_OUTPUT_CEILING,
  canonicalContextKey,
  checkToolComposition,
  classifyFindingConfidence,
  classifyRecommendationConfidence,
  compareShadowScores,
  compositionToolRefs,
  createCompositionAdvisor,
  createInMemoryCompositionStore,
  createInMemoryLearningStore,
  createInMemoryOpportunityStore,
  createLearningService,
  createNodeDigest,
  createOpportunityAnalyzer,
  createShadowEvaluator,
  DEFAULT_FRICTION_CONFIG,
  DEFAULT_MAX_PROMPTS,
  DEFAULT_USER_FRICTION_THRESHOLD,
  DETERMINISTIC_EQUIVALENCE_POTENTIALS,
  decideEvaluationPrompts,
  detectOpportunities,
  EVALUATION_PROMPT_SCHEMA_VERSION,
  EVALUATION_QUESTION_KINDS,
  EVALUATION_QUESTIONS,
  EVALUATION_RATING_ANSWERS,
  EVALUATION_RATING_SCHEMA_VERSION,
  EXECUTION_GRAPH_EDGE_RELATIONS,
  EXECUTION_GRAPH_NODE_KINDS,
  EXECUTION_GRAPH_SCHEMA_VERSION,
  EXPECTED_INFORMATION_GAIN,
  edgeCompatible,
  evaluationRatingFingerprintBasis,
  FINDING_CONFIDENCE_LEVELS,
  FINDING_STATES,
  FINDING_TRANSITION_EVIDENCE_KINDS,
  FINDING_TRANSITION_SCHEMA_VERSION,
  FINDING_TRANSITION_TABLE,
  findAggregationDefinition,
  findToolFact,
  HIGH_ERROR_RATE,
  IMPACT_BASES,
  INSERTABLE_FINDING_STATES,
  isEvaluationQuestionKind,
  isEvaluationRatingAnswer,
  isExecutionGraphNodeKind,
  isFindingConfidenceLevel,
  isFindingState,
  isFindingTransitionEvidenceKind,
  isOpportunityClass,
  isScorecardSubjectKind,
  isShadowEvaluationStatus,
  isTelemetryOutcome,
  LEARNING_SIGNAL_CLASS,
  LEARNING_SIGNAL_SCHEMA_VERSION,
  LOW_ERROR_RATE,
  linearCompositionOf,
  MINIMUM_DETERMINISTIC_POPULATION,
  MINIMUM_SEQUENCE_POPULATION,
  OPPORTUNITY_ANALYSIS_SCHEMA_VERSION,
  OPPORTUNITY_ANALYSIS_VERSION,
  OPPORTUNITY_CLASSES,
  OPPORTUNITY_FINDING_SCHEMA_VERSION,
  opportunityAnalysisDigestBasis,
  populationContextKeyOf,
  questionKindForClass,
  RATING_MAX,
  RATING_MIN,
  RATING_SCHEMA_VERSION,
  RATING_SOURCES,
  RECOMMENDATION_ACTIVATION_REASONS,
  ratingFingerprintBasis,
  recommendationSetDigestBasis,
  SCORECARD_SUBJECT_KINDS,
  SHADOW_EVALUATION_STATUSES,
  SHADOW_RECORD_CLASSES,
  SHADOW_SCHEMA_VERSION,
  SqlCompositionStore,
  SqlLearningStore,
  SqlOpportunityStore,
  scorecardDigestBasis,
  scoreShadowSubjects,
  signalFromRecommendation,
  signalFromScorecardEntry,
  TELEMETRY_OUTCOMES,
  TELEMETRY_SCHEMA_VERSION,
  TOOL_FACT_FIELD_TYPES,
  TOOL_FACT_ORIGINS,
  telemetryFingerprintBasis,
  toolExistsInCatalog,
  toolSequenceOf,
  UNCERTAINTY_LEVELS,
  validateCompositionRecommendation,
  validateCompositionRecommendationSet,
  validateEvaluationPrompt,
  validateEvaluationRating,
  validateExecutionGraph,
  validateExecutionTelemetry,
  validateFindingTransition,
  validateFindingTransitionRecord,
  validateLearningSignal,
  validateOpportunityFinding,
  validateRecommendationSetActivation,
  validateScorecard,
  validateShadowEvaluationRecord,
  validateToolFacts,
  validateUserRating,
  validateVerifiedEquivalenceEvidence,
};
