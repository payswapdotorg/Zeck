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
import type { InMemoryLearningStore } from "./adapters/in-memory-learning-store";
import { createInMemoryLearningStore } from "./adapters/in-memory-learning-store";
import { createNodeDigest } from "./adapters/node-digest";
import { SqlLearningStore } from "./adapters/sql-learning-store";
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
import type { DigestPort } from "./ports/digest";
import type {
  LearningStore,
  RatingIngestionOutcome,
  ScorecardScope,
  TelemetryIngestionOutcome,
  TelemetryQuery,
} from "./ports/learning-store";

export const moduleDescriptor: ModuleDescriptor = { id: "learning" };

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
// ratings) + closed-shape validation.
// Ports: the durable store seam + the digest seam.
// Adapters: in-memory store (reference semantics), node digest
// (crypto confinement), SQL store (migration 0009).
export type {
  AggregationDefinition,
  DigestPort,
  EvaluateShadowInput,
  ExecutionOutcomeTelemetry,
  InMemoryLearningStore,
  LearningService,
  LearningServiceDeps,
  LearningSignal,
  LearningStore,
  RatingIngestionOutcome,
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
  UncertaintyLevel,
  UserRatingRecord,
  VerificationObservation,
};
export {
  AGGREGATION_DEFINITIONS,
  buildScorecard,
  compareShadowScores,
  createInMemoryLearningStore,
  createLearningService,
  createNodeDigest,
  createShadowEvaluator,
  findAggregationDefinition,
  isScorecardSubjectKind,
  isShadowEvaluationStatus,
  isTelemetryOutcome,
  LEARNING_SIGNAL_CLASS,
  LEARNING_SIGNAL_SCHEMA_VERSION,
  RATING_MAX,
  RATING_MIN,
  RATING_SCHEMA_VERSION,
  RATING_SOURCES,
  ratingFingerprintBasis,
  SCORECARD_SUBJECT_KINDS,
  SHADOW_EVALUATION_STATUSES,
  SHADOW_RECORD_CLASSES,
  SHADOW_SCHEMA_VERSION,
  SqlLearningStore,
  scorecardDigestBasis,
  scoreShadowSubjects,
  signalFromScorecardEntry,
  TELEMETRY_OUTCOMES,
  TELEMETRY_SCHEMA_VERSION,
  telemetryFingerprintBasis,
  UNCERTAINTY_LEVELS,
  validateExecutionTelemetry,
  validateLearningSignal,
  validateScorecard,
  validateShadowEvaluationRecord,
  validateUserRating,
};
