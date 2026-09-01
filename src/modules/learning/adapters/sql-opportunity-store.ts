/**
 * SQL opportunity store (learning module adapter; WORK-022).
 *
 * The durable implementation of the `OpportunityStore` port over the
 * provider-neutral `DatabasePort` (migration
 * `0016_opportunity_analysis.sql`).
 *
 * The physical invariants live in the migration; this adapter maps
 * rows <-> domain records and converges idempotent operations exactly
 * like the WORK-014/WORK-017 SQL learning stores:
 *
 *  - `insertAnalysis`: the UNIQUE (execution_id) arbitration — a
 *    same-fingerprint replay converges (replayed), a different
 *    fingerprint on the same analysis execution fails closed
 *    `IDEMPOTENCY_KEY_REUSED`;
 *  - `insertEvaluationRating`: the (finding_id, rater, question_kind)
 *    identity — same fingerprint converges, conflicts fail closed;
 *  - `appendFindingTransition`: the journal append + the state
 *    advance are ONE transaction — the state-guard trigger requires
 *    the journal row (evidence-gated, never silent), the insert guard
 *    keeps findings born advisory, the forward-only table keeps
 *    verified unreachable without equivalence evidence;
 *  - every read is scope-filtered (application + tenant) —
 *    cross-tenant/cross-application rows are unreachable (M1/M26);
 *  - rows are immutable by trigger; the adapter exposes no rewrite.
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type { EvaluationRatingRecord } from "../domain/evaluation-rating";
import type { ExecutionGraph } from "../domain/execution-graph";
import type { FindingTransitionRecord } from "../domain/finding-transitions";
import type { EvaluationPrompt } from "../domain/human-evaluation";
import type { OpportunityAnalysis, OpportunityFinding } from "../domain/opportunity-analysis";
import type { OpportunityScope, OpportunityStore } from "../ports/opportunity-store";

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

interface AnalysisRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly repository: string;
  readonly revision: string;
  readonly analysis_version: number;
  readonly execution_graph: ExecutionGraph;
  readonly friction_config: {
    readonly userFrictionThreshold: number;
    readonly maxPrompts: number;
  };
  readonly finding_count: number;
  readonly prompt_count: number;
  readonly digest: string;
  readonly fingerprint: string;
  readonly recorded_at: Date | string;
  readonly schema_version: number;
}

function toAnalysis(row: AnalysisRow): OpportunityAnalysis {
  return {
    analysisId: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    repository: row.repository,
    revision: row.revision,
    analysisVersion: row.analysis_version,
    graph: row.execution_graph,
    friction: {
      userFrictionThreshold: Number(row.friction_config.userFrictionThreshold),
      maxPrompts: row.friction_config.maxPrompts,
    },
    findingCount: row.finding_count,
    promptCount: row.prompt_count,
    digest: row.digest,
    recordedAt: iso(row.recorded_at),
    schemaVersion: row.schema_version,
  };
}

const ANALYSIS_COLUMNS = `id, application_id, tenant_id, execution_id, repository, revision,
    analysis_version, execution_graph, friction_config, finding_count, prompt_count,
    digest, fingerprint, recorded_at, schema_version`;

interface FindingRow {
  readonly id: string;
  readonly analysis_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly finding_class: string;
  readonly state: string;
  readonly target_node_ids: readonly string[];
  readonly reason_codes: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly provenance: OpportunityFinding["provenance"];
  readonly confidence: OpportunityFinding["confidence"];
  readonly cost_impact: OpportunityFinding["costImpact"];
  readonly latency_impact: OpportunityFinding["latencyImpact"];
  readonly deterministic_equivalence: OpportunityFinding["deterministicEquivalence"];
  readonly recommendation: OpportunityFinding["recommendation"];
  readonly recorded_at: Date | string;
  readonly schema_version: number;
}

function toFinding(row: FindingRow): OpportunityFinding {
  return {
    findingId: row.id,
    analysisId: row.analysis_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    class: row.finding_class as OpportunityFinding["class"],
    state: row.state as OpportunityFinding["state"],
    targetNodeIds: [...row.target_node_ids],
    reasonCodes: [...row.reason_codes],
    evidenceRefs: [...row.evidence_refs],
    provenance: row.provenance,
    confidence: row.confidence,
    costImpact: row.cost_impact,
    latencyImpact: row.latency_impact,
    deterministicEquivalence: row.deterministic_equivalence,
    recommendation: row.recommendation,
    recordedAt: iso(row.recorded_at),
    schemaVersion: row.schema_version,
  };
}

const FINDING_COLUMNS = `id, analysis_id, application_id, tenant_id, finding_class, state,
    target_node_ids, reason_codes, evidence_refs, provenance, confidence, cost_impact,
    latency_impact, deterministic_equivalence, recommendation, recorded_at, schema_version`;

interface PromptRow {
  readonly id: string;
  readonly analysis_id: string;
  readonly finding_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly question_kind: string;
  readonly question: string;
  readonly expected_information_gain: string | number;
  readonly user_friction_threshold: string | number;
  readonly basis: readonly string[];
  readonly emitted_at: Date | string;
  readonly schema_version: number;
}

function toPrompt(row: PromptRow): EvaluationPrompt {
  return {
    promptId: row.id,
    analysisId: row.analysis_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    findingId: row.finding_id,
    questionKind: row.question_kind as EvaluationPrompt["questionKind"],
    question: row.question,
    expectedInformationGain: Number(row.expected_information_gain),
    userFrictionThreshold: Number(row.user_friction_threshold),
    basis: [...row.basis],
    emittedAt: iso(row.emitted_at),
    schemaVersion: row.schema_version,
  };
}

const PROMPT_COLUMNS = `id, analysis_id, finding_id, application_id, tenant_id, question_kind,
    question, expected_information_gain, user_friction_threshold, basis, emitted_at,
    schema_version`;

interface RatingRow {
  readonly id: string;
  readonly analysis_id: string;
  readonly finding_id: string;
  readonly counterpart_finding_id: string | null;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly prompt_id: string | null;
  readonly rater: string;
  readonly question_kind: string;
  readonly answer: string;
  readonly confidence: string | number | null;
  readonly rationale: string | null;
  readonly source_revision: string;
  readonly context: EvaluationRatingRecord["context"];
  readonly evidence_refs: readonly string[];
  readonly provenance: EvaluationRatingRecord["provenance"];
  readonly recorded_at: Date | string;
  readonly schema_version: number;
}

function toRating(row: RatingRow): EvaluationRatingRecord {
  return {
    ratingId: row.id,
    analysisId: row.analysis_id,
    findingId: row.finding_id,
    counterpartFindingId: row.counterpart_finding_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    promptId: row.prompt_id,
    rater: row.rater,
    questionKind: row.question_kind as EvaluationRatingRecord["questionKind"],
    answer: row.answer as EvaluationRatingRecord["answer"],
    confidence: row.confidence === null ? undefined : Number(row.confidence),
    rationale: row.rationale ?? undefined,
    sourceRevision: row.source_revision,
    context: row.context,
    evidenceRefs: [...row.evidence_refs],
    provenance: row.provenance,
    recordedAt: iso(row.recorded_at),
    schemaVersion: row.schema_version,
  };
}

const RATING_COLUMNS = `id, analysis_id, finding_id, counterpart_finding_id, application_id,
    tenant_id, execution_id, prompt_id, rater, question_kind, answer, confidence, rationale,
    source_revision, context, evidence_refs, provenance, recorded_at, schema_version`;

interface TransitionRow {
  readonly id: string;
  readonly finding_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly from_state: string;
  readonly to_state: string;
  readonly evidence_kind: string;
  readonly evidence_refs: readonly string[];
  readonly verified_equivalence: FindingTransitionRecord["verifiedEquivalence"];
  readonly requested_by: string;
  readonly recorded_at: Date | string;
  readonly schema_version: number;
}

function toTransition(row: TransitionRow): FindingTransitionRecord {
  return {
    transitionId: row.id,
    findingId: row.finding_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    fromState: row.from_state as FindingTransitionRecord["fromState"],
    toState: row.to_state as FindingTransitionRecord["toState"],
    evidenceKind: row.evidence_kind as FindingTransitionRecord["evidenceKind"],
    evidenceRefs: [...row.evidence_refs],
    verifiedEquivalence: row.verified_equivalence,
    requestedBy: row.requested_by,
    recordedAt: iso(row.recorded_at),
    schemaVersion: row.schema_version,
  };
}

const TRANSITION_COLUMNS = `id, finding_id, application_id, tenant_id, from_state, to_state,
    evidence_kind, evidence_refs, verified_equivalence, requested_by, recorded_at,
    schema_version`;

export class SqlOpportunityStore implements OpportunityStore {
  constructor(private readonly db: DatabasePort) {}

  async insertAnalysis(
    analysis: OpportunityAnalysis,
    fingerprint: string,
  ): Promise<{ readonly analysisId: string; readonly replayed: boolean }> {
    const inserted = await this.db.execute<{ readonly id: string }>({
      sql: `INSERT INTO learning.opportunity_analyses
              (id, application_id, tenant_id, execution_id, repository, revision,
               analysis_version, execution_graph, friction_config, finding_count,
               prompt_count, digest, fingerprint, recorded_at, schema_version)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15)
              ON CONFLICT (execution_id) DO NOTHING
              RETURNING id`,
      parameters: [
        analysis.analysisId,
        analysis.applicationId,
        analysis.tenantId,
        analysis.executionId,
        analysis.repository,
        analysis.revision,
        analysis.analysisVersion,
        JSON.stringify(analysis.graph),
        JSON.stringify(analysis.friction),
        analysis.findingCount,
        analysis.promptCount,
        analysis.digest,
        fingerprint,
        analysis.recordedAt,
        analysis.schemaVersion,
      ],
    });
    if (inserted.rows.length > 0) {
      return { analysisId: analysis.analysisId, replayed: false };
    }
    // The execution binding already exists: same fingerprint converges
    // (replay); a different fingerprint on the same analysis execution
    // fails closed.
    const existing = await this.db.execute<{ readonly fingerprint: string }>({
      sql: `SELECT fingerprint FROM learning.opportunity_analyses
            WHERE application_id = $1 AND tenant_id = $2 AND execution_id = $3`,
      parameters: [analysis.applicationId, analysis.tenantId, analysis.executionId],
    });
    const row = existing.rows[0];
    if (row !== undefined && row.fingerprint === fingerprint) {
      return { analysisId: analysis.analysisId, replayed: true };
    }
    throw new PlatformError({
      code: "IDEMPOTENCY_KEY_REUSED",
      message:
        "the analysis execution already carries a DIFFERENT analysis (the execution binding is one authoritative analysis — conflicts fail closed)",
      details: { executionId: analysis.executionId },
    });
  }

  async getAnalysis(
    scope: OpportunityScope,
    analysisId: string,
  ): Promise<OpportunityAnalysis | null> {
    const result = await this.db.execute<AnalysisRow>({
      sql: `SELECT ${ANALYSIS_COLUMNS}
            FROM learning.opportunity_analyses
            WHERE application_id = $1 AND tenant_id = $2 AND id = $3`,
      parameters: [scope.applicationId, scope.tenantId, analysisId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toAnalysis(row);
  }

  async getAnalysisByExecution(
    scope: OpportunityScope,
    executionId: string,
  ): Promise<OpportunityAnalysis | null> {
    const result = await this.db.execute<AnalysisRow>({
      sql: `SELECT ${ANALYSIS_COLUMNS}
            FROM learning.opportunity_analyses
            WHERE application_id = $1 AND tenant_id = $2 AND execution_id = $3`,
      parameters: [scope.applicationId, scope.tenantId, executionId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toAnalysis(row);
  }

  async listAnalyses(scope: OpportunityScope): Promise<readonly OpportunityAnalysis[]> {
    const result = await this.db.execute<AnalysisRow>({
      sql: `SELECT ${ANALYSIS_COLUMNS}
            FROM learning.opportunity_analyses
            WHERE application_id = $1 AND tenant_id = $2
            ORDER BY recorded_at DESC, id DESC`,
      parameters: [scope.applicationId, scope.tenantId],
    });
    return result.rows.map(toAnalysis);
  }

  async insertFinding(finding: OpportunityFinding): Promise<{
    readonly findingId: string;
    readonly replayed: boolean;
  }> {
    const inserted = await this.db.execute<{ readonly id: string }>({
      sql: `INSERT INTO learning.opportunity_findings
              (id, analysis_id, application_id, tenant_id, finding_class, state,
               target_node_ids, reason_codes, evidence_refs, provenance, confidence,
               cost_impact, latency_impact, deterministic_equivalence, recommendation,
               recorded_at, schema_version)
              VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
                      $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16, $17)
              ON CONFLICT (id) DO NOTHING
              RETURNING id`,
      parameters: [
        finding.findingId,
        finding.analysisId,
        finding.applicationId,
        finding.tenantId,
        finding.class,
        finding.state,
        JSON.stringify([...finding.targetNodeIds]),
        JSON.stringify([...finding.reasonCodes]),
        JSON.stringify([...finding.evidenceRefs]),
        JSON.stringify(finding.provenance),
        JSON.stringify(finding.confidence),
        JSON.stringify(finding.costImpact),
        JSON.stringify(finding.latencyImpact),
        JSON.stringify(finding.deterministicEquivalence),
        JSON.stringify(finding.recommendation),
        finding.recordedAt,
        finding.schemaVersion,
      ],
    });
    return {
      findingId: finding.findingId,
      replayed: inserted.rows.length === 0,
    };
  }

  async getFinding(scope: OpportunityScope, findingId: string): Promise<OpportunityFinding | null> {
    const result = await this.db.execute<FindingRow>({
      sql: `SELECT ${FINDING_COLUMNS}
            FROM learning.opportunity_findings
            WHERE application_id = $1 AND tenant_id = $2 AND id = $3`,
      parameters: [scope.applicationId, scope.tenantId, findingId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toFinding(row);
  }

  async listFindings(
    scope: OpportunityScope,
    analysisId: string,
  ): Promise<readonly OpportunityFinding[]> {
    const result = await this.db.execute<FindingRow>({
      sql: `SELECT ${FINDING_COLUMNS}
            FROM learning.opportunity_findings
            WHERE application_id = $1 AND tenant_id = $2 AND analysis_id = $3
            ORDER BY recorded_at ASC, id ASC`,
      parameters: [scope.applicationId, scope.tenantId, analysisId],
    });
    return result.rows.map(toFinding);
  }

  async insertPrompt(prompt: EvaluationPrompt): Promise<{ readonly replayed: boolean }> {
    const inserted = await this.db.execute<{ readonly id: string }>({
      sql: `INSERT INTO learning.opportunity_prompts
              (id, analysis_id, finding_id, application_id, tenant_id, question_kind,
               question, expected_information_gain, user_friction_threshold, basis,
               emitted_at, schema_version)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
              ON CONFLICT (id) DO NOTHING
              RETURNING id`,
      parameters: [
        prompt.promptId,
        prompt.analysisId,
        prompt.findingId,
        prompt.applicationId,
        prompt.tenantId,
        prompt.questionKind,
        prompt.question,
        prompt.expectedInformationGain,
        prompt.userFrictionThreshold,
        JSON.stringify([...prompt.basis]),
        prompt.emittedAt,
        prompt.schemaVersion,
      ],
    });
    return { replayed: inserted.rows.length === 0 };
  }

  async listPrompts(
    scope: OpportunityScope,
    analysisId: string,
  ): Promise<readonly EvaluationPrompt[]> {
    const result = await this.db.execute<PromptRow>({
      sql: `SELECT ${PROMPT_COLUMNS}
            FROM learning.opportunity_prompts
            WHERE application_id = $1 AND tenant_id = $2 AND analysis_id = $3
            ORDER BY emitted_at ASC, id ASC`,
      parameters: [scope.applicationId, scope.tenantId, analysisId],
    });
    return result.rows.map(toPrompt);
  }

  async insertEvaluationRating(
    rating: EvaluationRatingRecord,
    fingerprint: string,
  ): Promise<{ readonly ratingId: string; readonly replayed: boolean }> {
    try {
      const inserted = await this.db.execute<{ readonly id: string }>({
        sql: `INSERT INTO learning.opportunity_ratings
                (id, analysis_id, finding_id, counterpart_finding_id, application_id,
                 tenant_id, execution_id, prompt_id, rater, question_kind, answer,
                 confidence, rationale, source_revision, context, evidence_refs,
                 provenance, recorded_at, schema_version, fingerprint)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                        $15::jsonb, $16::jsonb, $17::jsonb, $18, $19, $20)
                RETURNING id`,
        parameters: [
          rating.ratingId,
          rating.analysisId,
          rating.findingId,
          rating.counterpartFindingId,
          rating.applicationId,
          rating.tenantId,
          rating.executionId,
          rating.promptId,
          rating.rater,
          rating.questionKind,
          rating.answer,
          rating.confidence ?? null,
          rating.rationale ?? null,
          rating.sourceRevision,
          JSON.stringify(rating.context),
          JSON.stringify([...rating.evidenceRefs]),
          JSON.stringify(rating.provenance),
          rating.recordedAt,
          rating.schemaVersion,
          fingerprint,
        ],
      });
      return { ratingId: rating.ratingId, replayed: inserted.rows.length === 0 };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // The (finding, rater, question) identity exists: same
      // fingerprint converges (replay); a conflicting re-rating fails
      // closed — evidence never rewrites itself.
      const existing = await this.db.execute<{ readonly fingerprint: string }>({
        sql: `SELECT fingerprint FROM learning.opportunity_ratings
              WHERE application_id = $1 AND tenant_id = $2
                AND finding_id = $3 AND rater = $4 AND question_kind = $5`,
        parameters: [
          rating.applicationId,
          rating.tenantId,
          rating.findingId,
          rating.rater,
          rating.questionKind,
        ],
      });
      const row = existing.rows[0];
      if (row !== undefined && row.fingerprint === fingerprint) {
        return { ratingId: rating.ratingId, replayed: true };
      }
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message:
          "the rater already answered this question for this finding (immutable evidence — a conflicting re-rating fails closed)",
        details: { findingId: rating.findingId, rater: rating.rater },
        cause: error,
      });
    }
  }

  async listRatings(
    scope: OpportunityScope,
    analysisId: string,
  ): Promise<readonly EvaluationRatingRecord[]> {
    const result = await this.db.execute<RatingRow>({
      sql: `SELECT ${RATING_COLUMNS}
            FROM learning.opportunity_ratings
            WHERE application_id = $1 AND tenant_id = $2 AND analysis_id = $3
            ORDER BY recorded_at ASC, id ASC`,
      parameters: [scope.applicationId, scope.tenantId, analysisId],
    });
    return result.rows.map(toRating);
  }

  async appendFindingTransition(transition: FindingTransitionRecord): Promise<{
    readonly transitionId: string;
    readonly replayed: boolean;
  }> {
    // ONE transaction: the journal append + the guarded state advance
    // (the trigger requires the journal row — evidence-gated, never
    // silent; illegal edges fail closed with the physical vocabulary).
    return this.db.transaction(async (tx) => {
      try {
        const inserted = await tx.execute<{ readonly id: string }>({
          sql: `INSERT INTO learning.opportunity_finding_transitions
                  (id, finding_id, application_id, tenant_id, from_state, to_state,
                   evidence_kind, evidence_refs, verified_equivalence, requested_by,
                   recorded_at, schema_version)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)
                  ON CONFLICT (id) DO NOTHING
                  RETURNING id`,
          parameters: [
            transition.transitionId,
            transition.findingId,
            transition.applicationId,
            transition.tenantId,
            transition.fromState,
            transition.toState,
            transition.evidenceKind,
            JSON.stringify([...transition.evidenceRefs]),
            transition.verifiedEquivalence === null
              ? null
              : JSON.stringify(transition.verifiedEquivalence),
            transition.requestedBy,
            transition.recordedAt,
            transition.schemaVersion,
          ],
        });
        if (inserted.rows.length === 0) {
          return { transitionId: transition.transitionId, replayed: true };
        }
      } catch (error) {
        if (isUniqueViolation(error)) {
          return { transitionId: transition.transitionId, replayed: true };
        }
        throw error;
      }
      await tx.execute({
        sql: `UPDATE learning.opportunity_findings
              SET state = $1
              WHERE application_id = $2 AND tenant_id = $3 AND id = $4`,
        parameters: [
          transition.toState,
          transition.applicationId,
          transition.tenantId,
          transition.findingId,
        ],
      });
      return { transitionId: transition.transitionId, replayed: false };
    });
  }

  async listFindingTransitions(
    scope: OpportunityScope,
    findingId: string,
  ): Promise<readonly FindingTransitionRecord[]> {
    const result = await this.db.execute<TransitionRow>({
      sql: `SELECT ${TRANSITION_COLUMNS}
            FROM learning.opportunity_finding_transitions
            WHERE application_id = $1 AND tenant_id = $2 AND finding_id = $3
            ORDER BY recorded_at ASC, id ASC`,
      parameters: [scope.applicationId, scope.tenantId, findingId],
    });
    return result.rows.map(toTransition);
  }
}
