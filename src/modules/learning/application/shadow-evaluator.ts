/**
 * The shadow evaluation service (learning module application; WORK-014 /
 * INT-006; ADR-0008/ADR-0009).
 *
 * SHADOW EVALUATION, BY CONSTRUCTION WITHOUT LIVE EFFECT (M7/M8):
 *
 * ```text
 *   proposed strategy description
 *     → evaluated against the LATEST durable scorecard version
 *       (existing evidence — immutable aggregates over past telemetry)
 *     → scored + honestly compared against an optional baseline
 *     → appended as an immutable shadow record (class 'shadow', M15)
 * ```
 *
 * The evaluator's dependencies are store + digest + id generator + clock
 * ONLY. It has NO policy seam, NO budget seam, NO capability seam, NO
 * execution seam, NO route explorer, NO dispatch adapter — a live side
 * effect is UNREPRESENTABLE in its wiring, not merely avoided (the
 * discrimination red-records instrument a full governed world and prove
 * zero authority/dispatch interactions; the architecture scanner proves
 * a mutated source that wires such a seam is detected).
 *
 * A shadow result NEVER changes live routing, live plans, policy,
 * budgets, capability admission or execution state: the record lands in
 * `learning.shadow_evaluations` and is returned to the caller as a
 * SIGNAL. Adoption of any learning-derived strategy re-enters the normal
 * governed planning path (policy admission → capability → deterministic
 * sufficiency → budget → dispatch authorization) — nothing here can
 * shortcut it (LRN-002 / §10 non-authority invariant).
 */

import { PlatformError } from "../../../shared/errors";
import { canonicalJson } from "../domain/canonical";
import type {
  ShadowEvaluationBasis,
  ShadowEvaluationRecord,
  ShadowStrategyDescription,
} from "../domain/shadow";
import {
  compareShadowScores,
  scoreShadowSubjects,
  validateShadowEvaluationRecord,
} from "../domain/shadow";
import { TELEMETRY_SCHEMA_VERSION } from "../domain/telemetry";
import type { DigestPort } from "../ports/digest";
import type { LearningStore } from "../ports/learning-store";

export interface ShadowEvaluatorDeps {
  readonly store: LearningStore;
  readonly digest: DigestPort;
  readonly generateId: () => string;
  readonly now: () => Date;
}

export interface ShadowStrategyInput {
  readonly strategyIdentity: string;
  readonly taskClass: string;
  readonly routeSubjects: readonly string[];
  readonly toolSubjects: readonly string[];
  readonly expectedCostMicroUsd?: string;
  readonly expectedQuality?: number;
  readonly expectedLatencyMs?: number;
}

export interface EvaluateShadowInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly proposed: ShadowStrategyInput;
  readonly baseline?: ShadowStrategyInput;
  /**
   * The aggregation definition the evaluation consults (route/tool
   * scorecards). Defaults to the route outcome definition.
   */
  readonly definitionId?: string;
  readonly requestedBy: string;
  readonly cause?: string;
}

export interface ShadowEvaluator {
  evaluateShadowStrategy(input: EvaluateShadowInput): Promise<ShadowEvaluationRecord>;
}

const DEFAULT_ROUTE_DEFINITION = "route-outcome-by-task-class";

function toStrategyDescription(
  input: ShadowStrategyInput,
  digest: DigestPort,
): ShadowStrategyDescription {
  const basis = {
    strategyIdentity: input.strategyIdentity,
    taskClass: input.taskClass,
    routeSubjects: [...input.routeSubjects],
    toolSubjects: [...input.toolSubjects],
    expectedCostMicroUsd: input.expectedCostMicroUsd ?? null,
    expectedQuality: input.expectedQuality ?? null,
    expectedLatencyMs: input.expectedLatencyMs ?? null,
  };
  const description: ShadowStrategyDescription = {
    strategyIdentity: input.strategyIdentity,
    descriptionDigest: digest.sha256Hex(canonicalJson(basis)),
    taskClass: input.taskClass,
    routeSubjects: [...input.routeSubjects],
    toolSubjects: [...input.toolSubjects],
    ...(input.expectedCostMicroUsd === undefined
      ? {}
      : { expectedCostMicroUsd: input.expectedCostMicroUsd }),
    ...(input.expectedQuality === undefined ? {} : { expectedQuality: input.expectedQuality }),
    ...(input.expectedLatencyMs === undefined
      ? {}
      : { expectedLatencyMs: input.expectedLatencyMs }),
  };
  return description;
}

export function createShadowEvaluator(deps: ShadowEvaluatorDeps): ShadowEvaluator {
  return {
    async evaluateShadowStrategy(input) {
      if (input.applicationId.length === 0 || input.tenantId.length === 0) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "shadow evaluation requires a non-empty tenant scope (M12)",
        });
      }
      const definitionId = input.definitionId ?? DEFAULT_ROUTE_DEFINITION;
      const scorecard = await deps.store.getLatestScorecard({
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        definitionId,
      });

      const recordedAt = deps.now().toISOString();
      const proposed = toStrategyDescription(input.proposed, deps.digest);
      const baseline =
        input.baseline === undefined
          ? undefined
          : toStrategyDescription(input.baseline, deps.digest);

      // No scorecard at all: honest insufficient-evidence shadow record
      // (the outcome itself is durable evidence of the attempt).
      if (scorecard === null) {
        const record: ShadowEvaluationRecord = {
          shadowId: deps.generateId(),
          recordClass: "shadow",
          applicationId: input.applicationId,
          tenantId: input.tenantId,
          proposed,
          ...(baseline === undefined ? {} : { baseline }),
          evaluationBasis: { kind: "none" },
          proposedScores: [],
          baselineScores: [],
          status: "insufficient-evidence",
          evidenceRefs: [],
          sourceExecutionIds: [],
          requestedBy: input.requestedBy,
          ...(input.cause === undefined ? {} : { cause: input.cause }),
          recordedAt,
          schemaVersion: 1,
        };
        validateShadowEvaluationRecord(record);
        await deps.store.insertShadowEvaluation(record);
        return record;
      }

      const basis: ShadowEvaluationBasis = {
        kind: "scorecard",
        scorecardId: scorecard.scorecardId,
        scorecardVersion: scorecard.scorecardVersion,
        definitionId: scorecard.definitionId,
        definitionVersion: scorecard.definitionVersion,
        telemetrySchemaVersion: scorecard.telemetrySchemaVersion,
        populationWindowFrom: scorecard.populationFrom,
        populationWindowTo: scorecard.populationTo,
      };

      // The evaluator understands only the current telemetry schema: an
      // older/unreadable schema is reported honestly, never guessed.
      if (scorecard.telemetrySchemaVersion !== TELEMETRY_SCHEMA_VERSION) {
        const record: ShadowEvaluationRecord = {
          shadowId: deps.generateId(),
          recordClass: "shadow",
          applicationId: input.applicationId,
          tenantId: input.tenantId,
          proposed,
          ...(baseline === undefined ? {} : { baseline }),
          evaluationBasis: basis,
          proposedScores: [],
          baselineScores: [],
          status: "incompatible-schema",
          evidenceRefs: [],
          sourceExecutionIds: [],
          requestedBy: input.requestedBy,
          ...(input.cause === undefined ? {} : { cause: input.cause }),
          recordedAt,
          schemaVersion: 1,
        };
        await deps.store.insertShadowEvaluation(record);
        return record;
      }

      const proposedScores = scoreShadowSubjects(proposed, scorecard);
      const baselineScores = baseline === undefined ? [] : scoreShadowSubjects(baseline, scorecard);
      const comparison =
        baseline === undefined ? undefined : compareShadowScores(proposedScores, baselineScores);

      let status: ShadowEvaluationRecord["status"] = "scored";
      if (proposedScores.length === 0) {
        status = "insufficient-evidence";
      } else if (baseline !== undefined && baselineScores.length === 0) {
        status = "no-baseline";
      }

      const matchedEntries = scorecard.entries.filter(
        (entry) =>
          (proposed.routeSubjects.includes(entry.subjectKey) ||
            proposed.toolSubjects.includes(entry.subjectKey) ||
            (baseline?.routeSubjects.includes(entry.subjectKey) ?? false) ||
            (baseline?.toolSubjects.includes(entry.subjectKey) ?? false)) &&
          (entry.taskClass === proposed.taskClass ||
            (baseline !== undefined && entry.taskClass === baseline.taskClass)),
      );
      const evidenceRefs = [
        ...new Set(matchedEntries.flatMap((entry) => entry.evidenceRefs)),
      ].sort();
      const sourceExecutionIds = [
        ...new Set(matchedEntries.flatMap((entry) => entry.sourceExecutionIds)),
      ].sort();

      const record: ShadowEvaluationRecord = {
        shadowId: deps.generateId(),
        recordClass: "shadow",
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        proposed,
        ...(baseline === undefined ? {} : { baseline }),
        evaluationBasis: basis,
        proposedScores,
        baselineScores,
        ...(comparison === undefined ? {} : { comparison }),
        status,
        evidenceRefs,
        sourceExecutionIds,
        requestedBy: input.requestedBy,
        ...(input.cause === undefined ? {} : { cause: input.cause }),
        recordedAt,
        schemaVersion: 1,
      };
      validateShadowEvaluationRecord(record);
      await deps.store.insertShadowEvaluation(record);
      return record;
    },
  };
}
