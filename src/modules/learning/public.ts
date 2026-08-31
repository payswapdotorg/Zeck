/**
 * Public contract barrel of the `learning` module (WORK-014).
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
 *  - user/human ratings as immutable learning evidence (never authority).
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
import { createNodeDigest } from "./adapters/node-digest";
import { SqlCompositionStore } from "./adapters/sql-composition-store";
import { SqlLearningStore } from "./adapters/sql-learning-store";
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
  ToolVersionRef,
} from "./domain/tool-facts";
import {
  findToolFact,
  TOOL_FACT_FIELD_TYPES,
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
  AggregationDefinition,
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
  ConsultRecommendationsRequest,
  DigestPort,
  EvaluateShadowInput,
  ExecutionOutcomeTelemetry,
  GenerateRecommendationSetRequest,
  InMemoryCompositionStore,
  InMemoryLearningStore,
  LearningService,
  LearningServiceDeps,
  LearningSignal,
  LearningStore,
  OutcomeCount,
  PopulationContextKey,
  RatingIngestionOutcome,
  RecommendationConfidence,
  RecommendationSetActivation,
  RecommendationSetScope,
  RecordRatingInput,
  RecordTelemetryInput,
  RouteObservation,
  Scorecard,
  ScorecardEntry,
  ScorecardScope,
  ScorecardSubjectKind,
  ScorecardUncertainty,
  ShadowComparison,
  ShadowEvaluationBasis,
  ShadowEvaluationRecord,
  ShadowEvaluationStatus,
  ShadowEvaluator,
  ShadowEvaluatorDeps,
  ShadowRecordClass,
  ShadowStrategyDescription,
  ShadowSubjectScore,
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
  ToolVersionRef,
  UncertaintyLevel,
  UserRatingRecord,
  VerificationObservation,
};
export {
  AGGREGATION_DEFINITIONS,
  analyzeToolSequences,
  buildScorecard,
  COMPOSITION_ANALYSIS_VERSION,
  COMPOSITION_RECOMMENDATION_CLASS,
  COMPOSITION_RECOMMENDATION_SCHEMA_VERSION,
  COMPOSITION_RECOMMENDATION_STATUSES,
  COMPOSITION_SCHEMA_VERSION,
  COMPOSITION_UNSUPPORTED_REASONS,
  canonicalContextKey,
  checkToolComposition,
  classifyRecommendationConfidence,
  compareShadowScores,
  compositionToolRefs,
  createCompositionAdvisor,
  createInMemoryCompositionStore,
  createInMemoryLearningStore,
  createLearningService,
  createNodeDigest,
  createShadowEvaluator,
  edgeCompatible,
  findAggregationDefinition,
  findToolFact,
  isScorecardSubjectKind,
  isShadowEvaluationStatus,
  isTelemetryOutcome,
  LEARNING_SIGNAL_CLASS,
  LEARNING_SIGNAL_SCHEMA_VERSION,
  linearCompositionOf,
  MINIMUM_SEQUENCE_POPULATION,
  populationContextKeyOf,
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
  scorecardDigestBasis,
  scoreShadowSubjects,
  signalFromRecommendation,
  signalFromScorecardEntry,
  TELEMETRY_OUTCOMES,
  TELEMETRY_SCHEMA_VERSION,
  TOOL_FACT_FIELD_TYPES,
  telemetryFingerprintBasis,
  toolExistsInCatalog,
  toolSequenceOf,
  UNCERTAINTY_LEVELS,
  validateCompositionRecommendation,
  validateCompositionRecommendationSet,
  validateExecutionTelemetry,
  validateLearningSignal,
  validateRecommendationSetActivation,
  validateScorecard,
  validateShadowEvaluationRecord,
  validateToolFacts,
  validateUserRating,
};
