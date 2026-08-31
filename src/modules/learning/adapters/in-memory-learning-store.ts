/**
 * In-memory learning store (learning module adapter; WORK-014).
 *
 * The reference implementation of the `LearningStore` port: mirrors the
 * EXACT durable semantics of the SQL store (migration 0009) so unit
 * tests prove the same invariants the real-PostgreSQL suites prove
 * physically:
 *
 *  - ONE authoritative observation per source execution (map keyed by
 *    execution id): same fingerprint converges, different fingerprint
 *    fails closed with `IDEMPOTENCY_KEY_REUSED`;
 *  - scorecards are append-only BY VERSION with UNIQUE
 *    (application, definition, version) arbitration — a taken version
 *    fails with `IDEMPOTENCY_KEY_REUSED` (the service's convergence
 *    signal); rows are never mutated or deleted (M9);
 *  - ratings: durable identity (execution, evaluator, dimension) with
 *    the same converge/fail-closed semantics;
 *  - every read is scope-filtered (application + tenant) — cross-tenant
 *    reads return nothing (M12);
 *  - shadow records append immutably with unique shadow ids.
 */

import { PlatformError } from "../../../shared/errors";
import type { UserRatingRecord } from "../domain/rating";
import type { Scorecard } from "../domain/scorecard";
import type { ShadowEvaluationRecord } from "../domain/shadow";
import type { ExecutionOutcomeTelemetry } from "../domain/telemetry";
import type {
  LearningStore,
  RatingIngestionOutcome,
  ScorecardScope,
  TelemetryIngestionOutcome,
  TelemetryQuery,
} from "../ports/learning-store";

interface TelemetryRow {
  readonly datum: ExecutionOutcomeTelemetry;
  readonly fingerprint: string;
}

interface RatingRow {
  readonly rating: UserRatingRecord;
  readonly fingerprint: string;
}

export interface InMemoryLearningStore extends LearningStore {
  /** Test/inspection helper: the durable telemetry count. */
  readonly telemetryCount: () => number;
  /** Test/inspection helper: the durable scorecard count. */
  readonly scorecardCount: () => number;
}

export function createInMemoryLearningStore(): InMemoryLearningStore {
  const telemetryByExecution = new Map<string, TelemetryRow>();
  const scorecards = new Map<string, Scorecard[]>();
  const shadowRecords: ShadowEvaluationRecord[] = [];
  const ratingsByIdentity = new Map<string, RatingRow>();

  const scorecardsOf = (applicationId: string, definitionId: string): Scorecard[] => {
    const key = `${applicationId}\u0000${definitionId}`;
    let list = scorecards.get(key);
    if (list === undefined) {
      list = [];
      scorecards.set(key, list);
    }
    return list;
  };

  const ratingKey = (executionId: string, evaluatorId: string, dimension: string): string =>
    `${executionId}\u0000${evaluatorId}\u0000${dimension}`;

  return {
    telemetryCount: () => telemetryByExecution.size,
    scorecardCount: () => [...scorecards.values()].reduce((sum, list) => sum + list.length, 0),

    async ingestTelemetry(
      datum: ExecutionOutcomeTelemetry,
      fingerprint: string,
    ): Promise<TelemetryIngestionOutcome> {
      const existing = telemetryByExecution.get(datum.executionId);
      if (existing !== undefined) {
        if (existing.fingerprint === fingerprint) {
          return {
            telemetryId: existing.datum.telemetryId,
            executionId: existing.datum.executionId,
            replayed: true,
            fingerprint: existing.fingerprint,
          };
        }
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message:
            "the source execution already has an authoritative observation with a different fingerprint (one observation per execution never forks)",
          details: { executionId: datum.executionId },
        });
      }
      telemetryByExecution.set(datum.executionId, { datum, fingerprint });
      return {
        telemetryId: datum.telemetryId,
        executionId: datum.executionId,
        replayed: false,
        fingerprint,
      };
    },

    async listTelemetry(query: TelemetryQuery): Promise<readonly ExecutionOutcomeTelemetry[]> {
      return [...telemetryByExecution.values()]
        .map((row) => row.datum)
        .filter(
          (datum) =>
            datum.applicationId === query.applicationId && datum.tenantId === query.tenantId,
        )
        .filter((datum) => {
          if (query.recordedFrom !== null && datum.recordedAt < query.recordedFrom) {
            return false;
          }
          return datum.recordedAt <= query.recordedTo;
        })
        .sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0));
    },

    async insertScorecard(scorecard: Scorecard): Promise<void> {
      const list = scorecardsOf(scorecard.applicationId, scorecard.definitionId);
      if (list.some((existing) => existing.scorecardVersion === scorecard.scorecardVersion)) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "the scorecard version is already taken (append-only versioning arbitration)",
          details: {
            applicationId: scorecard.applicationId,
            definitionId: scorecard.definitionId,
            scorecardVersion: scorecard.scorecardVersion,
          },
        });
      }
      if (list.some((existing) => existing.scorecardId === scorecard.scorecardId)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "scorecard id must be unique",
        });
      }
      list.push(scorecard);
      list.sort((a, b) => a.scorecardVersion - b.scorecardVersion);
    },

    async getLatestScorecard(scope: ScorecardScope): Promise<Scorecard | null> {
      const list = scorecardsOf(scope.applicationId, scope.definitionId).filter(
        (card) => card.tenantId === scope.tenantId,
      );
      return list.length === 0 ? null : (list[list.length - 1] ?? null);
    },

    async getScorecard(scope: ScorecardScope, scorecardId: string): Promise<Scorecard | null> {
      return (
        scorecardsOf(scope.applicationId, scope.definitionId).find(
          (card) => card.tenantId === scope.tenantId && card.scorecardId === scorecardId,
        ) ?? null
      );
    },

    async insertShadowEvaluation(record: ShadowEvaluationRecord): Promise<void> {
      if (shadowRecords.some((existing) => existing.shadowId === record.shadowId)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "shadow id must be unique (append-only)",
        });
      }
      shadowRecords.push(record);
    },

    async listShadowEvaluations(scope): Promise<readonly ShadowEvaluationRecord[]> {
      return shadowRecords
        .filter(
          (record) =>
            record.applicationId === scope.applicationId && record.tenantId === scope.tenantId,
        )
        .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0));
    },

    async insertUserRating(
      rating: UserRatingRecord,
      fingerprint: string,
    ): Promise<RatingIngestionOutcome> {
      const key = ratingKey(rating.executionId, rating.evaluatorId, rating.ratingDimension);
      const existing = ratingsByIdentity.get(key);
      if (existing !== undefined) {
        if (existing.fingerprint === fingerprint) {
          return {
            ratingId: existing.rating.ratingId,
            executionId: existing.rating.executionId,
            evaluatorId: existing.rating.evaluatorId,
            ratingDimension: existing.rating.ratingDimension,
            replayed: true,
            fingerprint: existing.fingerprint,
          };
        }
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message:
            "this (execution, evaluator, dimension) already has a rating with a different fingerprint (immutable evidence never forks)",
          details: { executionId: rating.executionId, evaluatorId: rating.evaluatorId },
        });
      }
      ratingsByIdentity.set(key, { rating, fingerprint });
      return {
        ratingId: rating.ratingId,
        executionId: rating.executionId,
        evaluatorId: rating.evaluatorId,
        ratingDimension: rating.ratingDimension,
        replayed: false,
        fingerprint,
      };
    },

    async listUserRatings(scope): Promise<readonly UserRatingRecord[]> {
      return [...ratingsByIdentity.values()]
        .map((row) => row.rating)
        .filter(
          (rating) =>
            rating.applicationId === scope.applicationId && rating.tenantId === scope.tenantId,
        )
        .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0));
    },
  };
}
