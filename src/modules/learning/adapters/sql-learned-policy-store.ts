/**
 * SQL learned-policy store (learning module adapter; WORK-020).
 *
 * The durable implementation of the `LearnedPolicyStore` port over the
 * provider-neutral `DatabasePort` (migration
 * `0017_learned_planning_policies.sql`, reading the shared population
 * and scorecard history of migration 0009).
 *
 * The physical invariants live in the migration; this adapter maps
 * rows <-> domain records and converges idempotent operations exactly
 * like the WORK-014/WORK-017 SQL learning stores:
 *
 *  - `insertLearnedPolicy`: the (application, policy_version) UNIQUE
 *    arbitration surfaces as `IDEMPOTENCY_KEY_REUSED` (the
 *    version-arbitration signal the service converges on); a re-read
 *    of the same policyId converges (replay);
 *  - `insertLearnedPolicyEvaluation`: the evaluation_id PRIMARY KEY
 *    converges retried requests (replay);
 *  - `appendLearnedPolicyPublication`: the publication journal append —
 *    the same publication_id converges (replay); journal order
 *    (publication_seq) serializes concurrent publications;
 *  - `getActiveLearnedPolicyPublication`: the publication pointed to by
 *    the LATEST journal entry (single derived pointer);
 *  - every read is scope-filtered (application + tenant) —
 *    cross-tenant/cross-application rows are unreachable;
 *  - rows are immutable by trigger; the adapter has no update path.
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type {
  EvaluationScorecardLike,
  LearnedPlanningPolicy,
  LearnedPolicyEvaluation,
  LearnedPolicyPublication,
} from "../domain/learned-planning-policy";
import {
  LEARNED_POLICY_CLASS,
  LEARNED_POLICY_SCHEMA_VERSION,
} from "../domain/learned-planning-policy";
import type { ExecutionOutcomeTelemetry } from "../domain/telemetry";
import type {
  EvaluationAppendOutcome,
  LearnedPolicyScope,
  LearnedPolicyStore,
  PublicationAppendOutcome,
} from "../ports/learned-policy-store";
import {
  SCORECARD_COLUMNS,
  type ScorecardRow,
  TELEMETRY_COLUMNS,
  type TelemetryRow,
  toTelemetry,
} from "./sql-learning-store";

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

interface LearnedPolicyRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly policy_version: number;
  readonly analysis_version: number;
  readonly telemetry_schema_version: number;
  readonly population_fingerprint: string;
  readonly evaluation_window_from: Date | string | null;
  readonly evaluation_window_to: Date | string;
  readonly total_population: number;
  readonly preferences: LearnedPlanningPolicy["preferences"];
  readonly rollback_to_policy_version: number | null;
  readonly prior_policy_digest: string | null;
  readonly rollback_note: string;
  readonly generated_at: Date | string;
  readonly digest: string;
}

function toLearnedPolicy(row: LearnedPolicyRow): LearnedPlanningPolicy {
  return {
    policyClass: LEARNED_POLICY_CLASS,
    policyId: row.id,
    policyVersion: row.policy_version,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    analysisVersion: row.analysis_version,
    telemetrySchemaVersion: row.telemetry_schema_version,
    populationFingerprint: row.population_fingerprint,
    totalPopulation: row.total_population,
    evaluationWindowFrom:
      row.evaluation_window_from === null ? null : iso(row.evaluation_window_from),
    evaluationWindowTo: iso(row.evaluation_window_to),
    preferences: row.preferences,
    rollback: {
      rollbackToPolicyVersion: row.rollback_to_policy_version,
      priorPolicyDigest: row.prior_policy_digest,
      note: row.rollback_note,
    },
    generatedAt: iso(row.generated_at),
    digest: row.digest,
    policySchemaVersion: LEARNED_POLICY_SCHEMA_VERSION,
  };
}

const POLICY_COLUMNS = `id, application_id, tenant_id, policy_version, analysis_version,
    telemetry_schema_version, population_fingerprint, evaluation_window_from,
    evaluation_window_to, total_population, preferences, rollback_to_policy_version,
    prior_policy_digest, rollback_note, generated_at, digest`;

interface EvaluationRow {
  readonly evaluation_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly policy_id: string;
  readonly policy_version: number;
  readonly evaluation_class: string;
  readonly status: string;
  readonly verdict: string | null;
  readonly metrics: LearnedPolicyEvaluation["metrics"];
  readonly comparison: LearnedPolicyEvaluation["comparison"];
  readonly basis: LearnedPolicyEvaluation["basis"];
  readonly canary_binding: LearnedPolicyEvaluation["canaryBinding"];
  readonly evidence_refs: string[];
  readonly source_execution_ids: string[];
  readonly evaluated_at: Date | string;
  readonly schema_version: number;
}

function toEvaluation(row: EvaluationRow): LearnedPolicyEvaluation {
  return {
    evaluationId: row.evaluation_id,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    evaluationClass: row.evaluation_class as LearnedPolicyEvaluation["evaluationClass"],
    status: row.status as LearnedPolicyEvaluation["status"],
    verdict: row.verdict as LearnedPolicyEvaluation["verdict"],
    metrics: row.metrics,
    comparison: row.comparison,
    basis: row.basis,
    canaryBinding: row.canary_binding,
    evidenceRefs: row.evidence_refs ?? [],
    sourceExecutionIds: row.source_execution_ids ?? [],
    evaluatedAt: iso(row.evaluated_at),
    schemaVersion: row.schema_version,
  };
}

const EVALUATION_COLUMNS = `evaluation_id, application_id, tenant_id, policy_id, policy_version,
    evaluation_class, status, verdict, metrics, comparison, basis, canary_binding,
    evidence_refs, source_execution_ids, evaluated_at, schema_version`;

interface PublicationRow {
  readonly publication_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly policy_id: string;
  readonly policy_version: number;
  readonly publication_mode: string;
  readonly publication_reason: string;
  readonly evaluation_evidence: LearnedPolicyPublication["evaluationEvidence"];
  readonly published_at: Date | string;
  readonly published_by: string;
  readonly publication_schema_version: number;
}

function toPublication(row: PublicationRow): LearnedPolicyPublication {
  return {
    publicationId: row.publication_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    publicationMode: row.publication_mode as LearnedPolicyPublication["publicationMode"],
    publicationReason: row.publication_reason as LearnedPolicyPublication["publicationReason"],
    evaluationEvidence: row.evaluation_evidence ?? [],
    publishedAt: iso(row.published_at),
    publishedBy: row.published_by,
    publicationSchemaVersion: row.publication_schema_version,
  };
}

const PUBLICATION_COLUMNS = `publication_id, application_id, tenant_id, policy_id, policy_version,
    publication_mode, publication_reason, evaluation_evidence, published_at, published_by,
    publication_schema_version`;

export class SqlLearnedPolicyStore implements LearnedPolicyStore {
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

  async getLatestScorecard(scope: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly definitionId: string;
  }): Promise<EvaluationScorecardLike | null> {
    const result = await this.db.execute<ScorecardRow>({
      sql: `SELECT ${SCORECARD_COLUMNS}
            FROM learning.scorecards
            WHERE application_id = $1 AND tenant_id = $2 AND definition_id = $3
            ORDER BY scorecard_version DESC
            LIMIT 1`,
      parameters: [scope.applicationId, scope.tenantId, scope.definitionId],
    });
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      scorecardId: row.id,
      scorecardVersion: row.scorecard_version,
      definitionId: row.definition_id,
      definitionVersion: row.definition_version,
      telemetrySchemaVersion: row.telemetry_schema_version,
      populationFrom: row.population_from === null ? null : iso(row.population_from),
      populationTo: iso(row.population_to),
      entries: row.entries,
    };
  }

  async insertLearnedPolicy(policy: LearnedPlanningPolicy): Promise<{ replayed: boolean }> {
    try {
      // RETURNING yields the inserted row; ON CONFLICT (id) DO NOTHING
      // swallows the id-replay with ZERO returned rows (the replay
      // signal — a fresh insert always returns its id).
      const inserted = await this.db.execute<{ readonly id: string }>({
        sql: `INSERT INTO learning.learned_planning_policies
              (id, application_id, tenant_id, policy_version, analysis_version,
               telemetry_schema_version, population_fingerprint, evaluation_window_from,
               evaluation_window_to, total_population, preferences,
               rollback_to_policy_version, prior_policy_digest, rollback_note,
               generated_at, digest)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16)
              ON CONFLICT (id) DO NOTHING
              RETURNING id`,
        parameters: [
          policy.policyId,
          policy.applicationId,
          policy.tenantId,
          policy.policyVersion,
          policy.analysisVersion,
          policy.telemetrySchemaVersion,
          policy.populationFingerprint,
          policy.evaluationWindowFrom,
          policy.evaluationWindowTo,
          policy.totalPopulation,
          JSON.stringify(policy.preferences),
          policy.rollback.rollbackToPolicyVersion,
          policy.rollback.priorPolicyDigest,
          policy.rollback.note,
          policy.generatedAt,
          policy.digest,
        ],
      });
      if (inserted.rows.length > 0) {
        return { replayed: false };
      }
      return { replayed: true };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The (application, policy_version) arbitration: a concurrent
        // build landed this version first — the typed convergence
        // signal the service re-reads the durable winner on.
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "learned policy version already exists (version arbitration)",
          details: {
            applicationId: policy.applicationId,
            policyVersion: policy.policyVersion,
          },
          cause: error,
        });
      }
      throw error;
    }
  }

  async getLatestLearnedPolicy(scope: LearnedPolicyScope): Promise<LearnedPlanningPolicy | null> {
    const result = await this.db.execute<LearnedPolicyRow>({
      sql: `SELECT ${POLICY_COLUMNS}
            FROM learning.learned_planning_policies
            WHERE application_id = $1 AND tenant_id = $2
            ORDER BY policy_version DESC
            LIMIT 1`,
      parameters: [scope.applicationId, scope.tenantId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toLearnedPolicy(row);
  }

  async getLearnedPolicy(
    scope: LearnedPolicyScope,
    policyId: string,
  ): Promise<LearnedPlanningPolicy | null> {
    const result = await this.db.execute<LearnedPolicyRow>({
      sql: `SELECT ${POLICY_COLUMNS}
            FROM learning.learned_planning_policies
            WHERE application_id = $1 AND tenant_id = $2 AND id = $3`,
      parameters: [scope.applicationId, scope.tenantId, policyId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toLearnedPolicy(row);
  }

  async insertLearnedPolicyEvaluation(
    evaluation: LearnedPolicyEvaluation,
  ): Promise<EvaluationAppendOutcome> {
    try {
      const inserted = await this.db.execute<{ readonly evaluation_id: string }>({
        sql: `INSERT INTO learning.learned_policy_evaluations
              (evaluation_id, application_id, tenant_id, policy_id, policy_version,
               evaluation_class, status, verdict, metrics, comparison, basis,
               canary_binding, evidence_refs, source_execution_ids, evaluated_at, schema_version)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb,
                      $12::jsonb, $13::jsonb, $14::jsonb, $15, $16)
              ON CONFLICT (evaluation_id) DO NOTHING
              RETURNING evaluation_id`,
        parameters: [
          evaluation.evaluationId,
          evaluation.applicationId,
          evaluation.tenantId,
          evaluation.policyId,
          evaluation.policyVersion,
          evaluation.evaluationClass,
          evaluation.status,
          evaluation.verdict,
          evaluation.metrics === null ? null : JSON.stringify(evaluation.metrics),
          evaluation.comparison === null ? null : JSON.stringify(evaluation.comparison),
          JSON.stringify(evaluation.basis),
          evaluation.canaryBinding === null ? null : JSON.stringify(evaluation.canaryBinding),
          JSON.stringify([...evaluation.evidenceRefs]),
          JSON.stringify([...evaluation.sourceExecutionIds]),
          evaluation.evaluatedAt,
          evaluation.schemaVersion,
        ],
      });
      if (inserted.rows.length > 0) {
        return { evaluationId: evaluation.evaluationId, replayed: false };
      }
      return { evaluationId: evaluation.evaluationId, replayed: true };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A concurrent evaluation landed the same content-derived
        // identity first — converge on the durable record (replay).
        return { evaluationId: evaluation.evaluationId, replayed: true };
      }
      throw error;
    }
  }

  async getLearnedPolicyEvaluation(
    scope: LearnedPolicyScope,
    evaluationId: string,
  ): Promise<LearnedPolicyEvaluation | null> {
    const result = await this.db.execute<EvaluationRow>({
      sql: `SELECT ${EVALUATION_COLUMNS}
            FROM learning.learned_policy_evaluations
            WHERE application_id = $1 AND tenant_id = $2 AND evaluation_id = $3`,
      parameters: [scope.applicationId, scope.tenantId, evaluationId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toEvaluation(row);
  }

  async listLearnedPolicyEvaluations(
    scope: LearnedPolicyScope,
    policyId: string,
  ): Promise<readonly LearnedPolicyEvaluation[]> {
    const result = await this.db.execute<EvaluationRow>({
      sql: `SELECT ${EVALUATION_COLUMNS}
            FROM learning.learned_policy_evaluations
            WHERE application_id = $1 AND tenant_id = $2 AND policy_id = $3
            ORDER BY evaluated_at DESC`,
      parameters: [scope.applicationId, scope.tenantId, policyId],
    });
    return result.rows.map(toEvaluation);
  }

  async appendLearnedPolicyPublication(
    publication: LearnedPolicyPublication,
  ): Promise<PublicationAppendOutcome> {
    try {
      const inserted = await this.db.execute<{ readonly publication_id: string }>({
        sql: `INSERT INTO learning.learned_policy_publication_log
              (publication_id, application_id, tenant_id, policy_id, policy_version,
               publication_mode, publication_reason, evaluation_evidence, published_at,
               published_by, publication_schema_version)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
              ON CONFLICT (publication_id) DO NOTHING
              RETURNING publication_id`,
        parameters: [
          publication.publicationId,
          publication.applicationId,
          publication.tenantId,
          publication.policyId,
          publication.policyVersion,
          publication.publicationMode,
          publication.publicationReason,
          JSON.stringify([...publication.evaluationEvidence]),
          publication.publishedAt,
          publication.publishedBy,
          publication.publicationSchemaVersion,
        ],
      });
      if (inserted.rows.length > 0) {
        return { publicationId: publication.publicationId, replayed: false };
      }
      return { publicationId: publication.publicationId, replayed: true };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A concurrent publication landed the same content-derived
        // identity first — converge on the durable journal entry.
        return { publicationId: publication.publicationId, replayed: true };
      }
      throw error;
    }
  }

  async getActiveLearnedPolicyPublication(
    scope: LearnedPolicyScope,
  ): Promise<LearnedPolicyPublication | null> {
    const result = await this.db.execute<PublicationRow>({
      sql: `SELECT ${PUBLICATION_COLUMNS}
            FROM learning.learned_policy_publication_log
            WHERE application_id = $1 AND tenant_id = $2
            ORDER BY publication_seq DESC
            LIMIT 1`,
      parameters: [scope.applicationId, scope.tenantId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toPublication(row);
  }

  async listLearnedPolicyPublications(
    scope: LearnedPolicyScope,
  ): Promise<readonly LearnedPolicyPublication[]> {
    const result = await this.db.execute<PublicationRow>({
      sql: `SELECT ${PUBLICATION_COLUMNS}
            FROM learning.learned_policy_publication_log
            WHERE application_id = $1 AND tenant_id = $2
            ORDER BY publication_seq ASC`,
      parameters: [scope.applicationId, scope.tenantId],
    });
    return result.rows.map(toPublication);
  }
}
