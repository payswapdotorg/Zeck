/**
 * The learning service (learning module application; WORK-014 / LRN-001,
 * TOL-003, INT-006; ADR-0005).
 *
 * The observational substrate of the learning axis:
 *
 *   1. `recordExecutionTelemetry` — the idempotent append of ONE
 *      authoritative observation per terminal execution (closed-shape
 *      validated — M10/M11/M12 are unrepresentable-as-absent; the
 *      fingerprint digests the canonical observation so retries
 *      converge and conflicting re-observations fail closed with
 *      `IDEMPOTENCY_KEY_REUSED`);
 *   2. `buildScorecard` — computes and persists the NEXT immutable
 *      scorecard version from the scope's telemetry population (pure
 *      aggregation in the domain; version monotonicity arbitrated by the
 *      store's UNIQUE (application, definition, version) constraint —
 *      concurrent builds converge via one typed retry);
 *   3. `consultSignals` — projects the LATEST scorecard version into
 *      validated, versioned, non-authoritative `LearningSignal`s for the
 *      planning READ seam (INT-006);
 *   4. `recordUserRating` — the idempotent append of a user/human rating
 *      datum (evidence, never authority — M16).
 *
 * LEARNING-NONAUTHORITY (the frozen §10 invariant): this service has NO
 * dependency that can authorize, dispatch or mutate anything — its deps
 * are store + digest + id generator + clock ONLY. There is no policy
 * seam, no budget seam, no capability seam, no execution seam and no
 * adapter/dispatch surface here or anywhere in this module (the
 * architecture test pins the import boundary; the discrimination
 * red-records prove a mutated wiring is detected).
 */

import { PlatformError } from "../../../shared/errors";
import { canonicalJson } from "../domain/canonical";
import type { UserRatingRecord } from "../domain/rating";
import { ratingFingerprintBasis, validateUserRating } from "../domain/rating";
import type { Scorecard } from "../domain/scorecard";
import {
  buildScorecard,
  findAggregationDefinition,
  scorecardDigestBasis,
} from "../domain/scorecard";
import type { LearningSignal } from "../domain/signal";
import { signalFromScorecardEntry, validateLearningSignal } from "../domain/signal";
import type { ExecutionOutcomeTelemetry } from "../domain/telemetry";
import { telemetryFingerprintBasis, validateExecutionTelemetry } from "../domain/telemetry";
import type { DigestPort } from "../ports/digest";
import type { LearningStore } from "../ports/learning-store";

export interface LearningServiceDeps {
  readonly store: LearningStore;
  readonly digest: DigestPort;
  readonly generateId: () => string;
  readonly now: () => Date;
}

/** The telemetry input (identity + timestamp are server-derived). */
export type RecordTelemetryInput = Omit<ExecutionOutcomeTelemetry, "telemetryId" | "recordedAt">;

/** The rating input (identity + timestamp are server-derived). */
export type RecordRatingInput = Omit<UserRatingRecord, "ratingId" | "recordedAt">;

export interface BuildScorecardRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly definitionId: string;
}

export interface ConsultSignalsRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly definitionId: string;
  /** Restrict signals to one task class (optional). */
  readonly taskClass?: string;
  /** Restrict signals to specific subject keys (optional). */
  readonly subjectKeys?: readonly string[];
}

export interface LearningService {
  recordExecutionTelemetry(input: RecordTelemetryInput): Promise<{
    telemetryId: string;
    executionId: string;
    replayed: boolean;
    fingerprint: string;
  }>;
  buildScorecard(request: BuildScorecardRequest): Promise<Scorecard>;
  consultSignals(request: ConsultSignalsRequest): Promise<readonly LearningSignal[]>;
  recordUserRating(input: RecordRatingInput): Promise<{
    ratingId: string;
    executionId: string;
    evaluatorId: string;
    ratingDimension: string;
    replayed: boolean;
    fingerprint: string;
  }>;
}

/** Maximum scorecard-version build attempts before typed failure. */
const SCORECARD_VERSION_ATTEMPTS = 3;

export function createLearningService(deps: LearningServiceDeps): LearningService {
  const digestOf = (value: unknown): string => deps.digest.sha256Hex(canonicalJson(value));

  return {
    async recordExecutionTelemetry(input) {
      const datum: ExecutionOutcomeTelemetry = {
        ...input,
        telemetryId: deps.generateId(),
        recordedAt: deps.now().toISOString(),
      };
      validateExecutionTelemetry(datum);
      const fingerprint = digestOf(telemetryFingerprintBasis(datum));
      return deps.store.ingestTelemetry(datum, fingerprint);
    },

    async buildScorecard(request) {
      const definition = findAggregationDefinition(request.definitionId);
      if (definition === undefined) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "unknown aggregation definition id",
          details: { definitionId: request.definitionId },
        });
      }
      const computedAt = deps.now().toISOString();
      const previous = await deps.store.getLatestScorecard({
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        definitionId: request.definitionId,
      });

      // Population window: each version is a CUMULATIVE snapshot of the
      // full immutable observation history up to `computedAt` (recorded
      // window bounds on the scorecard so consumers can always
      // reconstruct the exact evidence population behind every entry).
      // Rows are append-only and one-per-execution, so the population can
      // only grow — a request with no new observations is a typed no-op
      // error (no version churn without new evidence).
      const populationFrom = null;
      const populationTo = computedAt;
      const telemetry = await deps.store.listTelemetry({
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        recordedFrom: populationFrom,
        recordedTo: populationTo,
      });

      // Version 1 requires a non-empty population; later versions
      // require NEW observations since the previous snapshot (the
      // previous versions keep their historical populations — immutable
      // history, M9).
      if (telemetry.length === 0) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "no telemetry population in scope (a scorecard requires observed evidence — evidence over claims)",
          details: { applicationId: request.applicationId },
        });
      }
      if (previous !== null && telemetry.length <= previous.totalPopulation) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "no new telemetry since the previous scorecard version (no version churn without new evidence)",
          details: {
            previousVersion: previous.scorecardVersion,
            previousPopulation: previous.totalPopulation,
          },
        });
      }

      const nextVersion = (previous?.scorecardVersion ?? 0) + 1;
      let lastError: unknown;
      for (let attempt = 0; attempt < SCORECARD_VERSION_ATTEMPTS; attempt += 1) {
        const basis = buildScorecard({
          definitionId: request.definitionId,
          scorecardId: deps.generateId(),
          scorecardVersion: nextVersion,
          applicationId: request.applicationId,
          tenantId: request.tenantId,
          telemetry,
          populationFrom,
          populationTo,
          computedAt,
        });
        const scorecard: Scorecard = { ...basis, digest: digestOf(scorecardDigestBasis(basis)) };
        try {
          await deps.store.insertScorecard(scorecard);
          return scorecard;
        } catch (error) {
          lastError = error;
          if (error instanceof PlatformError && error.code === "IDEMPOTENCY_KEY_REUSED") {
            // A concurrent build landed this version first: converge by
            // re-reading and returning the durable winner.
            const winner = await deps.store.getLatestScorecard({
              applicationId: request.applicationId,
              tenantId: request.tenantId,
              definitionId: request.definitionId,
            });
            if (winner !== null && winner.scorecardVersion >= nextVersion) {
              return winner;
            }
            continue;
          }
          throw error;
        }
      }
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "scorecard version arbitration did not converge",
        details: { attempts: SCORECARD_VERSION_ATTEMPTS },
        cause: lastError,
      });
    },

    async consultSignals(request) {
      const scorecard = await deps.store.getLatestScorecard({
        applicationId: request.applicationId,
        tenantId: request.tenantId,
        definitionId: request.definitionId,
      });
      if (scorecard === null) {
        return [];
      }
      const signals: LearningSignal[] = [];
      for (const entry of scorecard.entries) {
        if (request.taskClass !== undefined && entry.taskClass !== request.taskClass) {
          continue;
        }
        if (request.subjectKeys !== undefined && !request.subjectKeys.includes(entry.subjectKey)) {
          continue;
        }
        const signal = signalFromScorecardEntry(entry, {
          scorecardId: scorecard.scorecardId,
          scorecardVersion: scorecard.scorecardVersion,
          definitionId: scorecard.definitionId,
          definitionVersion: scorecard.definitionVersion,
          telemetrySchemaVersion: scorecard.telemetrySchemaVersion,
          populationWindowFrom: scorecard.populationFrom,
          populationWindowTo: scorecard.populationTo,
        });
        validateLearningSignal(signal);
        signals.push(signal);
      }
      return signals;
    },

    async recordUserRating(input) {
      const rating: UserRatingRecord = {
        ...input,
        ratingId: deps.generateId(),
        recordedAt: deps.now().toISOString(),
      };
      validateUserRating(rating);
      const fingerprint = digestOf(ratingFingerprintBasis(rating));
      return deps.store.insertUserRating(rating, fingerprint);
    },
  };
}
