/**
 * SQL composition store (learning module adapter; WORK-017).
 *
 * The durable implementation of the `CompositionStore` port over the
 * provider-neutral `DatabasePort` (migration
 * `0010_learning_compositions.sql`).
 *
 * The physical invariants live in the migration; this adapter maps
 * rows <-> domain records and converges idempotent operations exactly
 * like the WORK-014 SQL learning store:
 *
 *  - `insertRecommendationSet`: the (application, set_version)
 *    UNIQUE arbitration surfaces as `IDEMPOTENCY_KEY_REUSED` (the
 *    version-arbitration signal the service converges on); a re-read
 *    of the same setId converges (replay);
 *  - `appendActivation`: the activation journal append — the same
 *    activation_id converges (replay); journal order (activation_seq)
 *    serializes concurrent activations;
 *  - `getActiveRecommendationSet`: the set pointed to by the LATEST
 *    journal entry (single derived pointer — §22);
 *  - every read is scope-filtered (application + tenant) —
 *    cross-tenant/cross-application rows are unreachable (M25);
 *  - rows are immutable by trigger; the adapter has no update path.
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type {
  CompositionRecommendationSet,
  RecommendationSetActivation,
} from "../domain/composition-analysis";
import type { ExecutionOutcomeTelemetry } from "../domain/telemetry";
import type {
  ActivationAppendOutcome,
  CompositionStore,
  RecommendationSetScope,
} from "../ports/composition-store";
import { TELEMETRY_COLUMNS, type TelemetryRow, toTelemetry } from "./sql-learning-store";

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

interface RecommendationSetRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly set_version: number;
  readonly analysis_version: number;
  readonly telemetry_schema_version: number;
  readonly population_fingerprint: string;
  readonly evaluation_window_from: Date | string | null;
  readonly evaluation_window_to: Date | string;
  readonly total_population: number;
  readonly recommendations: CompositionRecommendationSet["recommendations"];
  readonly generated_at: Date | string;
  readonly digest: string;
}

function toRecommendationSet(row: RecommendationSetRow): CompositionRecommendationSet {
  return {
    setId: row.id,
    setVersion: row.set_version,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    analysisVersion: row.analysis_version,
    telemetrySchemaVersion: row.telemetry_schema_version,
    populationFingerprint: row.population_fingerprint,
    evaluationWindowFrom:
      row.evaluation_window_from === null ? null : iso(row.evaluation_window_from),
    evaluationWindowTo: iso(row.evaluation_window_to),
    totalPopulation: row.total_population,
    recommendations: row.recommendations,
    generatedAt: iso(row.generated_at),
    digest: row.digest,
  };
}

const SET_COLUMNS = `id, application_id, tenant_id, set_version, analysis_version,
    telemetry_schema_version, population_fingerprint, evaluation_window_from,
    evaluation_window_to, total_population, recommendations, generated_at, digest`;

interface ActivationRow {
  readonly activation_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly set_id: string;
  readonly set_version: number;
  readonly activation_seq: string | number;
  readonly activated_at: Date | string;
  readonly activated_by: string;
  readonly reason: string;
}

function toActivation(row: ActivationRow): RecommendationSetActivation {
  return {
    activationId: row.activation_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    setId: row.set_id,
    setVersion: row.set_version,
    activatedAt: iso(row.activated_at),
    activatedBy: row.activated_by,
    reason: row.reason as RecommendationSetActivation["reason"],
  };
}

const ACTIVATION_COLUMNS = `activation_id, application_id, tenant_id, set_id, set_version,
    activation_seq, activated_at, activated_by, reason`;

export class SqlCompositionStore implements CompositionStore {
  constructor(private readonly db: DatabasePort) {}

  async listTelemetry(query: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly recordedFrom: string | null;
    readonly recordedTo: string;
  }): Promise<readonly ExecutionOutcomeTelemetry[]> {
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

  async insertRecommendationSet(set: CompositionRecommendationSet): Promise<{
    replayed: boolean;
  }> {
    try {
      // RETURNING yields the inserted row; ON CONFLICT (id) DO NOTHING
      // swallows the id-replay with ZERO returned rows (the replay
      // signal — a fresh insert always returns its id).
      const inserted = await this.db.execute<{ readonly id: string }>({
        sql: `INSERT INTO learning.composition_recommendation_sets
              (id, application_id, tenant_id, set_version, analysis_version,
               telemetry_schema_version, population_fingerprint, evaluation_window_from,
               evaluation_window_to, total_population, recommendations, generated_at, digest)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
              ON CONFLICT (id) DO NOTHING
              RETURNING id`,
        parameters: [
          set.setId,
          set.applicationId,
          set.tenantId,
          set.setVersion,
          set.analysisVersion,
          set.telemetrySchemaVersion,
          set.populationFingerprint,
          set.evaluationWindowFrom,
          set.evaluationWindowTo,
          set.totalPopulation,
          JSON.stringify(set.recommendations),
          set.generatedAt,
          set.digest,
        ],
      });
      if (inserted.rows.length > 0) {
        return { replayed: false };
      }
      return { replayed: true };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message:
            "the recommendation-set version is already taken (append-only versioning arbitration)",
          details: {
            applicationId: set.applicationId,
            setVersion: set.setVersion,
          },
          cause: error,
        });
      }
      throw error;
    }
  }

  async getLatestRecommendationSet(
    scope: RecommendationSetScope,
  ): Promise<CompositionRecommendationSet | null> {
    const result = await this.db.execute<RecommendationSetRow>({
      sql: `SELECT ${SET_COLUMNS}
            FROM learning.composition_recommendation_sets
            WHERE application_id = $1 AND tenant_id = $2
            ORDER BY set_version DESC
            LIMIT 1`,
      parameters: [scope.applicationId, scope.tenantId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toRecommendationSet(row);
  }

  async getRecommendationSet(
    scope: RecommendationSetScope,
    setId: string,
  ): Promise<CompositionRecommendationSet | null> {
    const result = await this.db.execute<RecommendationSetRow>({
      sql: `SELECT ${SET_COLUMNS}
            FROM learning.composition_recommendation_sets
            WHERE application_id = $1 AND tenant_id = $2 AND id = $3`,
      parameters: [scope.applicationId, scope.tenantId, setId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toRecommendationSet(row);
  }

  async appendActivation(
    activation: RecommendationSetActivation,
  ): Promise<ActivationAppendOutcome> {
    try {
      await this.db.execute({
        sql: `INSERT INTO learning.composition_activation_log
              (activation_id, application_id, tenant_id, set_id, set_version,
               activated_at, activated_by, reason)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
              ON CONFLICT (activation_id) DO NOTHING`,
        parameters: [
          activation.activationId,
          activation.applicationId,
          activation.tenantId,
          activation.setId,
          activation.setVersion,
          activation.activatedAt,
          activation.activatedBy,
          activation.reason,
        ],
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The same activation identity already landed — a replay.
        return { activationId: activation.activationId, replayed: true };
      }
      throw error;
    }
    const existing = await this.db.execute<{ readonly activation_id: string }>({
      sql: `SELECT activation_id FROM learning.composition_activation_log
            WHERE activation_id = $1`,
      parameters: [activation.activationId],
    });
    return {
      activationId: activation.activationId,
      replayed: existing.rows.length > 0,
    };
  }

  async getActiveRecommendationSet(
    scope: RecommendationSetScope,
  ): Promise<CompositionRecommendationSet | null> {
    // The LATEST journal entry per application is the single active
    // pointer (§22 — concurrent appends serialize by activation_seq).
    const latest = await this.db.execute<{ readonly set_id: string }>({
      sql: `SELECT set_id
            FROM learning.composition_activation_log
            WHERE application_id = $1 AND tenant_id = $2
            ORDER BY activation_seq DESC
            LIMIT 1`,
      parameters: [scope.applicationId, scope.tenantId],
    });
    const entry = latest.rows[0];
    if (entry === undefined) {
      return null;
    }
    return this.getRecommendationSet(scope, entry.set_id);
  }

  async listActivations(
    scope: RecommendationSetScope,
  ): Promise<readonly RecommendationSetActivation[]> {
    const result = await this.db.execute<ActivationRow>({
      sql: `SELECT ${ACTIVATION_COLUMNS}
            FROM learning.composition_activation_log
            WHERE application_id = $1 AND tenant_id = $2
            ORDER BY activation_seq ASC`,
      parameters: [scope.applicationId, scope.tenantId],
    });
    return result.rows.map(toActivation);
  }
}
