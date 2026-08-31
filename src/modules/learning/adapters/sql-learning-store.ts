/**
 * SQL learning store (learning module adapter; WORK-014).
 *
 * The durable implementation of the `LearningStore` port over the
 * provider-neutral `DatabasePort` (migration `0009_learning.sql`).
 *
 * The physical invariants live in the migration; this adapter maps rows
 * <-> domain records and converges idempotent operations exactly like
 * the WORK-005/WORK-010/WORK-013 SQL stores:
 *
 *  - `ingestTelemetry`: INSERT ... ON CONFLICT (execution_id) DO NOTHING
 *    then re-read — the unique index arbitrates concurrent duplicates
 *    (M11 duplicate-ingestion convergence); the durable fingerprint
 *    decides replay (same) vs `IDEMPOTENCY_KEY_REUSED` (different);
 *  - `insertScorecard`: a taken (application, definition, version)
 *    triple surfaces as `IDEMPOTENCY_KEY_REUSED` (the version-
 *    arbitration signal the service converges on); PostgreSQL unique
 *    violations are detected through the driver error code;
 *  - every read is scope-filtered (application + tenant) — cross-tenant
 *    rows are unreachable (M12);
 *  - rows are immutable by trigger; the adapter has no update path.
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type { UserRatingRecord } from "../domain/rating";
import type { Scorecard, ScorecardEntry } from "../domain/scorecard";
import type { ShadowEvaluationRecord, ShadowStrategyDescription } from "../domain/shadow";
import type { ExecutionOutcomeTelemetry } from "../domain/telemetry";
import type {
  LearningStore,
  RatingIngestionOutcome,
  ScorecardScope,
  TelemetryIngestionOutcome,
  TelemetryQuery,
} from "../ports/learning-store";

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

interface TelemetryRow {
  readonly id: string;
  readonly execution_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly task_class: string;
  readonly task_profile_digest: string | null;
  readonly context_strategy: string | null;
  readonly capabilities: string[];
  readonly plan_id: string;
  readonly plan_revision: number;
  readonly strategy_class: string | null;
  readonly routes: { provider: string; model: string }[];
  readonly tools: string[];
  readonly environments: string[];
  readonly verification: Record<string, unknown>;
  readonly cost_micro_usd: string | bigint;
  readonly latency_ms: string | number;
  readonly outcome: string;
  readonly evidence_refs: string[];
  readonly subgraphs: Record<string, unknown>[];
  readonly recorded_at: Date | string;
  readonly schema_version: number;
  readonly fingerprint: string;
}

function toTelemetry(row: TelemetryRow): ExecutionOutcomeTelemetry {
  const verification = row.verification as unknown as ExecutionOutcomeTelemetry["verification"];
  return {
    telemetryId: row.id,
    executionId: row.execution_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    taskClass: row.task_class,
    ...(row.task_profile_digest === null ? {} : { taskProfileDigest: row.task_profile_digest }),
    ...(row.context_strategy === null ? {} : { contextStrategy: row.context_strategy }),
    capabilities: row.capabilities,
    planId: row.plan_id,
    planRevision: row.plan_revision,
    ...(row.strategy_class === null ? {} : { strategyClass: row.strategy_class }),
    routes: row.routes,
    tools: row.tools,
    environments: row.environments,
    verification,
    costMicroUsd: String(row.cost_micro_usd),
    latencyMs: Number(row.latency_ms),
    outcome: row.outcome as ExecutionOutcomeTelemetry["outcome"],
    recordedAt: iso(row.recorded_at),
    evidenceRefs: row.evidence_refs,
    subgraphs: row.subgraphs as unknown as ExecutionOutcomeTelemetry["subgraphs"],
    schemaVersion: row.schema_version,
  };
}

const TELEMETRY_COLUMNS = `id, execution_id, application_id, tenant_id, task_class, task_profile_digest,
    context_strategy, capabilities, plan_id, plan_revision, strategy_class, routes, tools,
    environments, verification, cost_micro_usd, latency_ms, outcome, evidence_refs, subgraphs,
    recorded_at, schema_version, fingerprint`;

interface ScorecardRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly definition_id: string;
  readonly definition_version: number;
  readonly scorecard_version: number;
  readonly telemetry_schema_version: number;
  readonly population_from: Date | string | null;
  readonly population_to: Date | string;
  readonly total_population: number;
  readonly entries: ScorecardEntry[];
  readonly computed_at: Date | string;
  readonly digest: string;
}

function toScorecard(row: ScorecardRow): Scorecard {
  return {
    scorecardId: row.id,
    definitionId: row.definition_id,
    definitionVersion: row.definition_version,
    scorecardVersion: row.scorecard_version,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    telemetrySchemaVersion: row.telemetry_schema_version,
    populationFrom: row.population_from === null ? null : iso(row.population_from),
    populationTo: iso(row.population_to),
    totalPopulation: row.total_population,
    entries: row.entries,
    computedAt: iso(row.computed_at),
    digest: row.digest,
  };
}

const SCORECARD_COLUMNS = `id, application_id, tenant_id, definition_id, definition_version,
    scorecard_version, telemetry_schema_version, population_from, population_to,
    total_population, entries, computed_at, digest`;

interface ShadowRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly record_class: string;
  readonly proposed: ShadowStrategyDescription;
  readonly baseline: ShadowStrategyDescription | null;
  readonly evaluation_basis: ShadowEvaluationRecord["evaluationBasis"];
  readonly proposed_scores: ShadowEvaluationRecord["proposedScores"];
  readonly baseline_scores: ShadowEvaluationRecord["baselineScores"];
  readonly comparison: ShadowEvaluationRecord["comparison"];
  readonly status: string;
  readonly evidence_refs: string[];
  readonly source_execution_ids: string[];
  readonly requested_by: string;
  readonly cause: string | null;
  readonly recorded_at: Date | string;
  readonly schema_version: number;
}

function toShadow(row: ShadowRow): ShadowEvaluationRecord {
  return {
    shadowId: row.id,
    recordClass: "shadow",
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    proposed: row.proposed,
    ...(row.baseline === null ? {} : { baseline: row.baseline }),
    evaluationBasis: row.evaluation_basis,
    proposedScores: row.proposed_scores,
    baselineScores: row.baseline_scores,
    ...(row.comparison === null ? {} : { comparison: row.comparison }),
    status: row.status as ShadowEvaluationRecord["status"],
    evidenceRefs: row.evidence_refs,
    sourceExecutionIds: row.source_execution_ids,
    requestedBy: row.requested_by,
    ...(row.cause === null ? {} : { cause: row.cause }),
    recordedAt: iso(row.recorded_at),
    schemaVersion: row.schema_version,
  };
}

const SHADOW_COLUMNS = `id, application_id, tenant_id, record_class, proposed, baseline,
    evaluation_basis, proposed_scores, baseline_scores, comparison, status, evidence_refs,
    source_execution_ids, requested_by, cause, recorded_at, schema_version`;

interface RatingRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly target_artifact_ref: string | null;
  readonly evaluator_id: string;
  readonly rating_dimension: string;
  readonly rating: number;
  readonly confidence: string | number | null;
  readonly rationale: string | null;
  readonly provenance: UserRatingRecord["provenance"];
  readonly evidence_refs: string[];
  readonly recorded_at: Date | string;
  readonly schema_version: number;
  readonly fingerprint: string;
}

function toRating(row: RatingRow): UserRatingRecord {
  const confidence = row.confidence === null ? undefined : Number(row.confidence);
  return {
    ratingId: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    ...(row.target_artifact_ref === null ? {} : { targetArtifactRef: row.target_artifact_ref }),
    evaluatorId: row.evaluator_id,
    ratingDimension: row.rating_dimension,
    rating: row.rating,
    ...(confidence === undefined ? {} : { confidence }),
    ...(row.rationale === null ? {} : { rationale: row.rationale }),
    provenance: row.provenance,
    evidenceRefs: row.evidence_refs,
    recordedAt: iso(row.recorded_at),
    schemaVersion: row.schema_version,
  };
}

const RATING_COLUMNS = `id, application_id, tenant_id, execution_id, target_artifact_ref,
    evaluator_id, rating_dimension, rating, confidence, rationale, provenance, evidence_refs,
    recorded_at, schema_version, fingerprint`;

export class SqlLearningStore implements LearningStore {
  constructor(private readonly db: DatabasePort) {}

  async ingestTelemetry(
    datum: ExecutionOutcomeTelemetry,
    fingerprint: string,
  ): Promise<TelemetryIngestionOutcome> {
    await this.db.execute({
      sql: `INSERT INTO learning.execution_telemetry
            (id, execution_id, application_id, tenant_id, task_class, task_profile_digest,
             context_strategy, capabilities, plan_id, plan_revision, strategy_class, routes,
             tools, environments, verification, cost_micro_usd, latency_ms, outcome,
             evidence_refs, subgraphs, recorded_at, schema_version, fingerprint)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb, $13::jsonb,
                    $14::jsonb, $15::jsonb, $16, $17, $18, $19::jsonb, $20::jsonb, $21, $22, $23)
            ON CONFLICT (execution_id) DO NOTHING`,
      parameters: [
        datum.telemetryId,
        datum.executionId,
        datum.applicationId,
        datum.tenantId,
        datum.taskClass,
        datum.taskProfileDigest ?? null,
        datum.contextStrategy ?? null,
        JSON.stringify([...datum.capabilities]),
        datum.planId,
        datum.planRevision,
        datum.strategyClass ?? null,
        JSON.stringify(
          datum.routes.map((route) => ({ provider: route.provider, model: route.model })),
        ),
        JSON.stringify([...datum.tools]),
        JSON.stringify([...datum.environments]),
        JSON.stringify(datum.verification),
        datum.costMicroUsd,
        datum.latencyMs,
        datum.outcome,
        JSON.stringify([...datum.evidenceRefs]),
        JSON.stringify(
          datum.subgraphs.map((subgraph) => ({
            subgraphId: subgraph.subgraphId,
            stepPath: [...subgraph.stepPath],
            computationType: subgraph.computationType,
          })),
        ),
        datum.recordedAt,
        datum.schemaVersion,
        fingerprint,
      ],
    });

    // Re-read the authoritative row (the unique index arbitrated any
    // concurrent duplicate — both writers now converge on this row).
    const result = await this.db.execute<TelemetryRow>({
      sql: `SELECT ${TELEMETRY_COLUMNS}
            FROM learning.execution_telemetry
            WHERE application_id = $1 AND execution_id = $2`,
      parameters: [datum.applicationId, datum.executionId],
    });
    const row = result.rows[0];
    if (row === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "telemetry insert did not converge on a durable row",
        details: { executionId: datum.executionId },
      });
    }
    if (row.fingerprint !== fingerprint) {
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message:
          "the source execution already has an authoritative observation with a different fingerprint (one observation per execution never forks)",
        details: { executionId: datum.executionId },
      });
    }
    return {
      telemetryId: row.id,
      executionId: row.execution_id,
      replayed: row.id !== datum.telemetryId,
      fingerprint: row.fingerprint,
    };
  }

  async listTelemetry(query: TelemetryQuery): Promise<readonly ExecutionOutcomeTelemetry[]> {
    const result = await this.db.execute<TelemetryRow>({
      sql: `SELECT ${TELEMETRY_COLUMNS}
            FROM learning.execution_telemetry
            WHERE application_id = $1 AND tenant_id = $2
              AND ($3::timestamptz IS NULL OR recorded_at >= $3::timestamptz)
              AND recorded_at <= $4::timestamptz
            ORDER BY recorded_at ASC, id ASC`,
      parameters: [query.applicationId, query.tenantId, query.recordedFrom, query.recordedTo],
    });
    return result.rows.map(toTelemetry);
  }

  async insertScorecard(scorecard: Scorecard): Promise<void> {
    try {
      await this.db.execute({
        sql: `INSERT INTO learning.scorecards
              (id, application_id, tenant_id, definition_id, definition_version, scorecard_version,
               telemetry_schema_version, population_from, population_to, total_population,
               entries, computed_at, digest)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)`,
        parameters: [
          scorecard.scorecardId,
          scorecard.applicationId,
          scorecard.tenantId,
          scorecard.definitionId,
          scorecard.definitionVersion,
          scorecard.scorecardVersion,
          scorecard.telemetrySchemaVersion,
          scorecard.populationFrom,
          scorecard.populationTo,
          scorecard.totalPopulation,
          JSON.stringify(scorecard.entries),
          scorecard.computedAt,
          scorecard.digest,
        ],
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The (application, definition, version) version arbitration:
        // a concurrent build landed this version — the typed signal the
        // service converges on.
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "the scorecard version is already taken (append-only versioning arbitration)",
          details: {
            applicationId: scorecard.applicationId,
            definitionId: scorecard.definitionId,
            scorecardVersion: scorecard.scorecardVersion,
          },
          cause: error,
        });
      }
      throw error;
    }
  }

  async getLatestScorecard(scope: ScorecardScope): Promise<Scorecard | null> {
    const result = await this.db.execute<ScorecardRow>({
      sql: `SELECT ${SCORECARD_COLUMNS}
            FROM learning.scorecards
            WHERE application_id = $1 AND tenant_id = $2 AND definition_id = $3
            ORDER BY scorecard_version DESC
            LIMIT 1`,
      parameters: [scope.applicationId, scope.tenantId, scope.definitionId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toScorecard(row);
  }

  async getScorecard(scope: ScorecardScope, scorecardId: string): Promise<Scorecard | null> {
    const result = await this.db.execute<ScorecardRow>({
      sql: `SELECT ${SCORECARD_COLUMNS}
            FROM learning.scorecards
            WHERE application_id = $1 AND tenant_id = $2 AND definition_id = $3 AND id = $4`,
      parameters: [scope.applicationId, scope.tenantId, scope.definitionId, scorecardId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toScorecard(row);
  }

  async insertShadowEvaluation(record: ShadowEvaluationRecord): Promise<void> {
    try {
      await this.db.execute({
        sql: `INSERT INTO learning.shadow_evaluations
              (id, application_id, tenant_id, record_class, proposed, baseline, evaluation_basis,
               proposed_scores, baseline_scores, comparison, status, evidence_refs,
               source_execution_ids, requested_by, cause, recorded_at, schema_version)
              VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
                      $10::jsonb, $11, $12::jsonb, $13::jsonb, $14, $15, $16, $17)`,
        parameters: [
          record.shadowId,
          record.applicationId,
          record.tenantId,
          record.recordClass,
          JSON.stringify(record.proposed),
          record.baseline === undefined ? null : JSON.stringify(record.baseline),
          JSON.stringify(record.evaluationBasis),
          JSON.stringify(record.proposedScores),
          JSON.stringify(record.baselineScores),
          record.comparison === undefined ? null : JSON.stringify(record.comparison),
          record.status,
          JSON.stringify([...record.evidenceRefs]),
          JSON.stringify([...record.sourceExecutionIds]),
          record.requestedBy,
          record.cause ?? null,
          record.recordedAt,
          record.schemaVersion,
        ],
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "shadow id must be unique (append-only)",
          details: { shadowId: record.shadowId },
          cause: error,
        });
      }
      throw error;
    }
  }

  async listShadowEvaluations(scope: {
    readonly applicationId: string;
    readonly tenantId: string;
  }): Promise<readonly ShadowEvaluationRecord[]> {
    const result = await this.db.execute<ShadowRow>({
      sql: `SELECT ${SHADOW_COLUMNS}
            FROM learning.shadow_evaluations
            WHERE application_id = $1 AND tenant_id = $2
            ORDER BY recorded_at DESC, id DESC`,
      parameters: [scope.applicationId, scope.tenantId],
    });
    return result.rows.map(toShadow);
  }

  async insertUserRating(
    rating: UserRatingRecord,
    fingerprint: string,
  ): Promise<RatingIngestionOutcome> {
    await this.db.execute({
      sql: `INSERT INTO learning.user_ratings
            (id, application_id, tenant_id, execution_id, target_artifact_ref, evaluator_id,
             rating_dimension, rating, confidence, rationale, provenance, evidence_refs,
             recorded_at, schema_version, fingerprint)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15)
            ON CONFLICT (execution_id, evaluator_id, rating_dimension) DO NOTHING`,
      parameters: [
        rating.ratingId,
        rating.applicationId,
        rating.tenantId,
        rating.executionId,
        rating.targetArtifactRef ?? null,
        rating.evaluatorId,
        rating.ratingDimension,
        rating.rating,
        rating.confidence ?? null,
        rating.rationale ?? null,
        JSON.stringify(rating.provenance),
        JSON.stringify([...rating.evidenceRefs]),
        rating.recordedAt,
        rating.schemaVersion,
        fingerprint,
      ],
    });
    const result = await this.db.execute<RatingRow>({
      sql: `SELECT ${RATING_COLUMNS}
            FROM learning.user_ratings
            WHERE application_id = $1 AND execution_id = $2 AND evaluator_id = $3
              AND rating_dimension = $4`,
      parameters: [
        rating.applicationId,
        rating.executionId,
        rating.evaluatorId,
        rating.ratingDimension,
      ],
    });
    const row = result.rows[0];
    if (row === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "rating insert did not converge on a durable row",
      });
    }
    if (row.fingerprint !== fingerprint) {
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message:
          "this (execution, evaluator, dimension) already has a rating with a different fingerprint (immutable evidence never forks)",
        details: { executionId: rating.executionId, evaluatorId: rating.evaluatorId },
      });
    }
    return {
      ratingId: row.id,
      executionId: row.execution_id,
      evaluatorId: row.evaluator_id,
      ratingDimension: row.rating_dimension,
      replayed: row.id !== rating.ratingId,
      fingerprint: row.fingerprint,
    };
  }

  async listUserRatings(scope: {
    readonly applicationId: string;
    readonly tenantId: string;
  }): Promise<readonly UserRatingRecord[]> {
    const result = await this.db.execute<RatingRow>({
      sql: `SELECT ${RATING_COLUMNS}
            FROM learning.user_ratings
            WHERE application_id = $1 AND tenant_id = $2
            ORDER BY recorded_at DESC, id DESC`,
      parameters: [scope.applicationId, scope.tenantId],
    });
    return result.rows.map(toRating);
  }
}
