/**
 * The learning store port (learning module outbound; WORK-014).
 *
 * The durable boundary of the learning axis (migration 0009):
 *
 *  - `ingestTelemetry` — the idempotency-anchor append of an execution
 *    outcome observation. Durable identity is `(execution_id)` — ONE
 *    authoritative observation per source execution. The same fingerprint
 *    converges (replayed); a different fingerprint for the same execution
 *    fails closed with `IDEMPOTENCY_KEY_REUSED` (the learning datum of
 *    one execution never silently forks). Concurrent duplicates converge
 *    through the unique-index arbitration (`spec/contracts.md`
 *    "Idempotency response rule");
 *  - `listTelemetry` — the population read for scorecard building
 *    (scope-bound: application + tenant; optional window);
 *  - `insertScorecard` — the append of a NEW immutable scorecard
 *    version (there is no update path — M9). Version arbitration is
 *    UNIQUE (application, definition, version): a concurrent build that
 *    lands the same version fails and is retried/converged by the caller;
 *  - `getLatestScorecard` / `getScorecard` — versioned reads;
 *  - `insertShadowEvaluation` — the append of a shadow record (immutable,
 *    class 'shadow' — M15);
 *  - `insertUserRating` — the idempotency-anchor append of a rating
 *    (durable identity: execution + evaluator + dimension; convergence
 *    and `IDEMPOTENCY_KEY_REUSED` on fingerprint conflict);
 *  - `listShadowEvaluations` / `listUserRatings` — scoped reads.
 *
 * Every read/write is tenant-scoped: the caller supplies the scope and
 * the store NEVER returns rows outside it (M12 — enforced physically by
 * the composite FKs and the scoped queries of migration 0009).
 *
 * The port is provider-neutral: no SQL, no driver types.
 */

import type { UserRatingRecord } from "../domain/rating";
import type { Scorecard } from "../domain/scorecard";
import type { ShadowEvaluationRecord } from "../domain/shadow";
import type { ExecutionOutcomeTelemetry } from "../domain/telemetry";

export interface TelemetryIngestionOutcome {
  readonly telemetryId: string;
  readonly executionId: string;
  /** True when a previous durable observation was replayed. */
  readonly replayed: boolean;
  /** The durable request fingerprint of the authoritative observation. */
  readonly fingerprint: string;
}

export interface ScorecardScope {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly definitionId: string;
}

export interface TelemetryQuery {
  readonly applicationId: string;
  readonly tenantId: string;
  /** Inclusive lower bound on recordedAt (RFC 3339), null = unbounded. */
  readonly recordedFrom: string | null;
  /** Inclusive upper bound on recordedAt (RFC 3339). */
  readonly recordedTo: string;
}

export interface RatingIngestionOutcome {
  readonly ratingId: string;
  readonly executionId: string;
  readonly evaluatorId: string;
  readonly ratingDimension: string;
  readonly replayed: boolean;
  readonly fingerprint: string;
}

export interface LearningStore {
  /**
   * Append ONE authoritative observation per source execution.
   * Same (execution, fingerprint) converges; same execution + different
   * fingerprint fails closed (`IDEMPOTENCY_KEY_REUSED`).
   */
  ingestTelemetry(
    datum: ExecutionOutcomeTelemetry,
    fingerprint: string,
  ): Promise<TelemetryIngestionOutcome>;

  /** Read the telemetry population of a scope (window-filtered). */
  listTelemetry(query: TelemetryQuery): Promise<readonly ExecutionOutcomeTelemetry[]>;

  /**
   * Append a NEW immutable scorecard version. The version must be the
   * next version for (application, definition); a taken version fails
   * with a typed error (the service converges by re-reading).
   */
  insertScorecard(scorecard: Scorecard): Promise<void>;

  /** The latest scorecard version of a scope, or null when none exists. */
  getLatestScorecard(scope: ScorecardScope): Promise<Scorecard | null>;

  /** A specific scorecard by id within the scope, or null. */
  getScorecard(scope: ScorecardScope, scorecardId: string): Promise<Scorecard | null>;

  /** Append an immutable shadow evaluation record. */
  insertShadowEvaluation(record: ShadowEvaluationRecord): Promise<void>;

  /** Scoped shadow-evaluation reads (newest first). */
  listShadowEvaluations(scope: {
    readonly applicationId: string;
    readonly tenantId: string;
  }): Promise<readonly ShadowEvaluationRecord[]>;

  /**
   * Append a rating with per-(execution, evaluator, dimension) durable
   * identity. Same fingerprint converges; different fingerprint for the
   * same identity fails closed (`IDEMPOTENCY_KEY_REUSED`).
   */
  insertUserRating(rating: UserRatingRecord, fingerprint: string): Promise<RatingIngestionOutcome>;

  /** Scoped rating reads (newest first). */
  listUserRatings(scope: {
    readonly applicationId: string;
    readonly tenantId: string;
  }): Promise<readonly UserRatingRecord[]>;
}
