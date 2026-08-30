/**
 * SQL verification store (verification module adapters; WORK-013).
 *
 * The durable implementation of the `VerificationStore` port over the
 * provider-neutral `DatabasePort` (migration 0007). The physical
 * invariants live in the migration (append-only results, exactly-once
 * human answer binding, unique idempotency anchors, terminal-immutable
 * journal rows); this adapter maps rows <-> domain records and converges
 * idempotent operations (claim/complete/deny/answer) on the durable
 * rows — concurrent duplicates converge through the unique-index
 * arbitration exactly like the WORK-005/WORK-010 SQL stores.
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type {
  CandidateComparisonRecord,
  ComparisonCandidate,
  PlannerAuthorization,
} from "../domain/comparison";
import type { VerificationCriteria } from "../domain/criteria";
import type { HumanEvaluationRequestRecord } from "../domain/human";
import type {
  EvaluatorIdentity,
  VerificationPolicyEvidence,
  VerificationResultRecord,
  VerificationTarget,
} from "../domain/result";
import type {
  AnswerHumanRequestInput,
  AnswerHumanRequestOutcome,
  BindLedgerSequenceInput,
  ClaimEvaluationInput,
  ClaimEvaluationOutcome,
  CompleteEvaluationInput,
  DeclareCriteriaOutcome,
  DeclareCriteriaScopeInput,
  DenyEvaluationInput,
  EvaluationJournalRecord,
  InsertComparisonInput,
  InsertHumanRequestInput,
  InsertVerificationResultInput,
  VerificationStore,
} from "../ports/verification-store";

interface CriteriaRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly criterion_id: string;
  readonly version: number;
  readonly kind: string;
  readonly required: boolean;
  readonly description: string;
  readonly definition: Record<string, unknown>;
  readonly declared_at: string;
}

interface EvaluationRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly evaluation_key: string;
  readonly request_fingerprint: string;
  readonly target_kind: string;
  readonly target_ref: string;
  readonly target_revision: string | null;
  readonly status: string;
  readonly denial_reason: string | null;
  readonly criteria_set: {
    criterionId: string;
    version: number;
  }[];
  readonly conclusion: EvaluationJournalRecord["conclusion"];
  readonly policy_evidence: VerificationPolicyEvidence | null;
  readonly requested_at: string;
  readonly concluded_at: string | null;
  readonly ledger_requested_sequence: number | null;
}

interface ResultRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly evaluation_id: string;
  readonly target_kind: string;
  readonly target_ref: string;
  readonly target_revision: string | null;
  readonly criterion_id: string;
  readonly criteria_version: number;
  readonly evaluator_kind: string;
  readonly evaluator_id: string;
  readonly evaluator_version: string;
  readonly status: string;
  readonly confidence: string | null;
  readonly observations: string[];
  readonly evidence: string[];
  readonly policy_evidence: VerificationPolicyEvidence | null;
  readonly human_request_id: string | null;
  readonly recorded_by: string;
  readonly recorded_at: string;
}

interface HumanRequestRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly request_key: string;
  readonly request_fingerprint: string;
  readonly target_kind: string;
  readonly target_ref: string;
  readonly target_revision: string | null;
  readonly criterion_id: string;
  readonly criteria_version: number;
  readonly question: string;
  readonly evidence: string[];
  readonly requested_by: string;
  readonly policy_evidence: VerificationPolicyEvidence | null;
  readonly requested_at: string;
  readonly answered_by_result_id: string | null;
  readonly answered_by: string | null;
  readonly answered_at: string | null;
}

interface ComparisonRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly comparison_key: string;
  readonly request_fingerprint: string;
  readonly criterion_id: string;
  readonly criteria_version: number;
  readonly candidates: ComparisonCandidate[];
  readonly status: string;
  readonly winner: string | null;
  readonly per_candidate: CandidateComparisonRecord["perCandidate"];
  readonly rationale: string[];
  readonly evaluator_kind: string;
  readonly evaluator_id: string;
  readonly evaluator_version: string;
  readonly planner_authorization: PlannerAuthorization;
  readonly policy_evidence: VerificationPolicyEvidence | null;
  readonly compared_at: string;
}

function toCriteria(row: CriteriaRow): VerificationCriteria {
  return {
    criterionId: row.criterion_id,
    version: row.version,
    kind: row.kind as VerificationCriteria["kind"],
    required: row.required,
    description: row.description,
    definition: row.definition,
  };
}

function toEvaluation(row: EvaluationRow): EvaluationJournalRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    evaluationKey: row.evaluation_key,
    requestFingerprint: row.request_fingerprint,
    targetKind: row.target_kind,
    targetRef: row.target_ref,
    targetRevision: row.target_revision,
    status: row.status as EvaluationJournalRecord["status"],
    denialReason: row.denial_reason,
    criteria: row.criteria_set,
    conclusion: row.conclusion,
    policyEvidence: row.policy_evidence,
    requestedAt: row.requested_at,
    concludedAt: row.concluded_at,
    ledgerRequestedSequence: row.ledger_requested_sequence,
  };
}

function toResult(row: ResultRow): VerificationResultRecord {
  const evaluator: EvaluatorIdentity = {
    kind: row.evaluator_kind as EvaluatorIdentity["kind"],
    id: row.evaluator_id,
    version: row.evaluator_version,
  };
  const target: VerificationTarget = {
    kind: row.target_kind as VerificationTarget["kind"],
    ref: row.target_ref,
    ...(row.target_revision === null ? {} : { revision: row.target_revision }),
  };
  const confidence = row.confidence === null ? undefined : Number(row.confidence);
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    target,
    criterionId: row.criterion_id,
    criteriaVersion: row.criteria_version,
    evaluator,
    status: row.status as VerificationResultRecord["status"],
    ...(confidence === undefined ? {} : { confidence }),
    observations: row.observations,
    evidence: row.evidence,
    ...(row.policy_evidence === null
      ? {}
      : {
          policyEvidence:
            row.policy_evidence as unknown as VerificationResultRecord["policyEvidence"],
        }),
    provenance: {
      evaluationId: row.evaluation_id,
      actorId: row.recorded_by,
      ...(row.human_request_id === null ? {} : { humanRequestId: row.human_request_id }),
    },
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at,
  };
}

function toHumanRequest(row: HumanRequestRow): HumanEvaluationRequestRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    requestKey: row.request_key,
    requestFingerprint: row.request_fingerprint,
    target: {
      kind: row.target_kind as HumanEvaluationRequestRecord["target"]["kind"],
      ref: row.target_ref,
      ...(row.target_revision === null ? {} : { revision: row.target_revision }),
    },
    criterionId: row.criterion_id,
    criteriaVersion: row.criteria_version,
    question: row.question,
    evidence: row.evidence,
    requestedBy: row.requested_by,
    ...(row.policy_evidence === null ? {} : { policyEvidence: row.policy_evidence }),
    requestedAt: row.requested_at,
    ...(row.answered_by_result_id === null
      ? {}
      : {
          answeredByResultId: row.answered_by_result_id,
          answeredBy: row.answered_by ?? undefined,
          answeredAt: row.answered_at ?? undefined,
        }),
  };
}

function toComparison(row: ComparisonRow): CandidateComparisonRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    comparisonKey: row.comparison_key,
    requestFingerprint: row.request_fingerprint,
    criterionId: row.criterion_id,
    criteriaVersion: row.criteria_version,
    candidates: row.candidates,
    status: row.status as CandidateComparisonRecord["status"],
    ...(row.winner === null ? {} : { winner: row.winner }),
    perCandidate: row.per_candidate,
    rationale: row.rationale,
    evaluator: {
      kind: row.evaluator_kind as EvaluatorIdentity["kind"],
      id: row.evaluator_id,
      version: row.evaluator_version,
    },
    plannerAuthorization: row.planner_authorization,
    ...(row.policy_evidence === null ? {} : { policyEvidence: row.policy_evidence }),
    comparedAt: row.compared_at,
  };
}

export class SqlVerificationStore implements VerificationStore {
  constructor(private readonly db: DatabasePort) {}

  async declareCriteria(input: DeclareCriteriaScopeInput): Promise<DeclareCriteriaOutcome> {
    const criteria = input.criteria;
    const existing = await this.findCriteria(
      input.applicationId,
      criteria.criterionId,
      criteria.version,
    );
    if (existing !== null) {
      const same =
        existing.kind === criteria.kind &&
        existing.required === criteria.required &&
        existing.description === criteria.description &&
        JSON.stringify(existing.definition) === JSON.stringify(criteria.definition);
      if (!same) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: `criterion ${criteria.criterionId}@${criteria.version} is already declared with a different definition (criteria are immutable; declare a new version)`,
        });
      }
      return { criteria: existing, converged: true };
    }
    await this.db.execute({
      sql: `INSERT INTO verification.criteria
            (id, application_id, tenant_id, criterion_id, version, kind, required, description, definition)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      parameters: [
        crypto.randomUUID(),
        input.applicationId,
        input.tenantId,
        criteria.criterionId,
        criteria.version,
        criteria.kind,
        criteria.required,
        criteria.description,
        JSON.stringify(criteria.definition),
      ],
    });
    return { criteria, converged: false };
  }

  async findCriteria(
    applicationId: string,
    criterionId: string,
    version: number,
  ): Promise<VerificationCriteria | null> {
    const result = await this.db.execute<CriteriaRow>({
      sql: `SELECT id, application_id, tenant_id, criterion_id, version, kind, required, description, definition, declared_at
            FROM verification.criteria
            WHERE application_id = $1 AND criterion_id = $2 AND version = $3`,
      parameters: [applicationId, criterionId, version],
    });
    const row = result.rows[0];
    return row === undefined ? null : toCriteria(row);
  }

  async claimEvaluation(input: ClaimEvaluationInput): Promise<ClaimEvaluationOutcome> {
    const inserted = await this.db.execute<{ id: string }>({
      sql: `INSERT INTO verification.evaluations
            (id, application_id, tenant_id, execution_id, evaluation_key, request_fingerprint,
             target_kind, target_ref, target_revision, status, criteria_set, policy_evidence, requested_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'evaluating', $10::jsonb, $11::jsonb, $12)
            ON CONFLICT (application_id, evaluation_key) DO NOTHING
            RETURNING id`,
      parameters: [
        input.id,
        input.applicationId,
        input.tenantId,
        input.executionId,
        input.evaluationKey,
        input.requestFingerprint,
        input.targetKind,
        input.targetRef,
        input.targetRevision,
        JSON.stringify(input.criteria),
        input.policyEvidence === null ? null : JSON.stringify(input.policyEvidence),
        input.now,
      ],
    });
    // A concurrent twin won the insert: converge on the DURABLE row by
    // its key (never the caller's own proposed id).
    const row =
      inserted.rows.length > 0
        ? await this.selectEvaluation(input.applicationId, inserted.rows[0]?.id ?? input.id)
        : await this.findEvaluationRowByKey(input.applicationId, input.evaluationKey);
    if (row === null) {
      throw new PlatformError({
        code: "VERIFICATION_FAILED",
        message: "evaluation journal row disappeared after claim",
      });
    }
    return { record: toEvaluation(row), existing: inserted.rows.length === 0 };
  }

  private async findEvaluationRowByKey(
    applicationId: string,
    evaluationKey: string,
  ): Promise<EvaluationRow | null> {
    const result = await this.db.execute<EvaluationRow>({
      sql: `SELECT id, application_id, tenant_id, execution_id, evaluation_key, request_fingerprint,
                   target_kind, target_ref, target_revision, status, denial_reason, criteria_set,
                   conclusion, policy_evidence, requested_at, concluded_at, ledger_requested_sequence
            FROM verification.evaluations
            WHERE application_id = $1 AND evaluation_key = $2`,
      parameters: [applicationId, evaluationKey],
    });
    return result.rows[0] ?? null;
  }

  private async selectEvaluation(applicationId: string, id: string): Promise<EvaluationRow | null> {
    const result = await this.db.execute<EvaluationRow>({
      sql: `SELECT id, application_id, tenant_id, execution_id, evaluation_key, request_fingerprint,
                   target_kind, target_ref, target_revision, status, denial_reason, criteria_set,
                   conclusion, policy_evidence, requested_at, concluded_at, ledger_requested_sequence
            FROM verification.evaluations
            WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, id],
    });
    return result.rows[0] ?? null;
  }

  async findEvaluationByKey(
    applicationId: string,
    evaluationKey: string,
  ): Promise<EvaluationJournalRecord | null> {
    const result = await this.db.execute<EvaluationRow>({
      sql: `SELECT id, application_id, tenant_id, execution_id, evaluation_key, request_fingerprint,
                   target_kind, target_ref, target_revision, status, denial_reason, criteria_set,
                   conclusion, policy_evidence, requested_at, concluded_at, ledger_requested_sequence
            FROM verification.evaluations
            WHERE application_id = $1 AND evaluation_key = $2`,
      parameters: [applicationId, evaluationKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : toEvaluation(row);
  }

  async completeEvaluation(input: CompleteEvaluationInput): Promise<EvaluationJournalRecord> {
    const updated = await this.db.execute<EvaluationRow>({
      sql: `UPDATE verification.evaluations
            SET status = 'concluded', conclusion = $3::jsonb, concluded_at = $4
            WHERE application_id = $1 AND id = $2 AND status = 'evaluating'
            RETURNING id, application_id, tenant_id, execution_id, evaluation_key, request_fingerprint,
                      target_kind, target_ref, target_revision, status, denial_reason, criteria_set,
                      conclusion, policy_evidence, requested_at, concluded_at, ledger_requested_sequence`,
      parameters: [
        input.applicationId,
        input.evaluationId,
        JSON.stringify(input.conclusion),
        input.now,
      ],
    });
    if (updated.rows[0] !== undefined) {
      return toEvaluation(updated.rows[0]);
    }
    const row = await this.selectEvaluation(input.applicationId, input.evaluationId);
    if (row === null) {
      throw new PlatformError({
        code: "VERIFICATION_FAILED",
        message: "evaluation journal row not found",
      });
    }
    if (row.status === "concluded") {
      // Concurrent duplicate converged on the same durable conclusion.
      return toEvaluation(row);
    }
    throw new PlatformError({
      code: "IDEMPOTENCY_KEY_REUSED",
      message: `evaluation ${input.evaluationId} is terminal in ${row.status} and cannot be concluded again`,
    });
  }

  async denyEvaluation(input: DenyEvaluationInput): Promise<EvaluationJournalRecord> {
    const updated = await this.db.execute<EvaluationRow>({
      sql: `UPDATE verification.evaluations
            SET status = 'denied', denial_reason = $3, concluded_at = $4
            WHERE application_id = $1 AND id = $2 AND status = 'evaluating'
            RETURNING id, application_id, tenant_id, execution_id, evaluation_key, request_fingerprint,
                      target_kind, target_ref, target_revision, status, denial_reason, criteria_set,
                      conclusion, policy_evidence, requested_at, concluded_at, ledger_requested_sequence`,
      parameters: [input.applicationId, input.evaluationId, input.reason, input.now],
    });
    if (updated.rows[0] !== undefined) {
      return toEvaluation(updated.rows[0]);
    }
    const row = await this.selectEvaluation(input.applicationId, input.evaluationId);
    if (row === null) {
      throw new PlatformError({
        code: "VERIFICATION_FAILED",
        message: "evaluation journal row not found",
      });
    }
    if (row.status === "denied") {
      return toEvaluation(row);
    }
    throw new PlatformError({
      code: "IDEMPOTENCY_KEY_REUSED",
      message: `evaluation ${input.evaluationId} is terminal in ${row.status} and cannot be denied`,
    });
  }

  async bindLedgerSequence(input: BindLedgerSequenceInput): Promise<void> {
    // IS DISTINCT FROM: a concurrent twin already bound the SAME ledger
    // sequence (the intent event replays by key) — a no-op UPDATE would
    // trip the lifecycle trigger; zero affected rows is the convergence.
    await this.db.execute({
      sql: `UPDATE verification.evaluations
            SET ledger_requested_sequence = $3
            WHERE application_id = $1 AND id = $2 AND status = 'evaluating'
              AND ledger_requested_sequence IS DISTINCT FROM $3`,
      parameters: [input.applicationId, input.evaluationId, input.ledgerRequestedSequence],
    });
  }

  async insertResult(input: InsertVerificationResultInput): Promise<VerificationResultRecord> {
    const result = input.result;
    await this.db.execute({
      sql: `INSERT INTO verification.results
            (id, application_id, tenant_id, execution_id, evaluation_id, target_kind, target_ref,
             target_revision, criterion_id, criteria_version, evaluator_kind, evaluator_id,
             evaluator_version, status, confidence, observations, evidence, policy_evidence,
             human_request_id, recorded_by, recorded_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                    $16::jsonb, $17::jsonb, $18::jsonb, $19, $20, $21)
            ON CONFLICT (id) DO NOTHING`,
      parameters: [
        result.id,
        result.applicationId,
        result.tenantId,
        result.executionId,
        result.provenance.evaluationId,
        result.target.kind,
        result.target.ref,
        result.target.revision ?? null,
        result.criterionId,
        result.criteriaVersion,
        result.evaluator.kind,
        result.evaluator.id,
        result.evaluator.version,
        result.status,
        result.confidence ?? null,
        JSON.stringify(result.observations),
        JSON.stringify(result.evidence),
        result.policyEvidence === undefined ? null : JSON.stringify(result.policyEvidence),
        result.provenance.humanRequestId ?? null,
        result.recordedBy,
        result.recordedAt,
      ],
    });
    return result;
  }

  async getResult(
    applicationId: string,
    resultId: string,
  ): Promise<VerificationResultRecord | null> {
    const result = await this.db.execute<ResultRow>({
      sql: `SELECT id, application_id, tenant_id, execution_id, evaluation_id, target_kind, target_ref,
                  target_revision, criterion_id, criteria_version, evaluator_kind, evaluator_id,
                  evaluator_version, status, confidence, observations, evidence, policy_evidence,
                  human_request_id, recorded_by, recorded_at
            FROM verification.results
            WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, resultId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toResult(row);
  }

  async listResults(
    applicationId: string,
    executionId: string,
  ): Promise<readonly VerificationResultRecord[]> {
    const result = await this.db.execute<ResultRow>({
      sql: `SELECT id, application_id, tenant_id, execution_id, evaluation_id, target_kind, target_ref,
                  target_revision, criterion_id, criteria_version, evaluator_kind, evaluator_id,
                  evaluator_version, status, confidence, observations, evidence, policy_evidence,
                  human_request_id, recorded_by, recorded_at
            FROM verification.results
            WHERE application_id = $1 AND execution_id = $2
            ORDER BY recorded_at ASC, id ASC`,
      parameters: [applicationId, executionId],
    });
    return result.rows.map(toResult);
  }

  async insertHumanRequest(input: InsertHumanRequestInput): Promise<HumanEvaluationRequestRecord> {
    const request = input.request;
    const inserted = await this.db.execute<HumanRequestRow>({
      sql: `INSERT INTO verification.human_evaluation_requests
            (id, application_id, tenant_id, execution_id, request_key, request_fingerprint,
             target_kind, target_ref, target_revision, criterion_id, criteria_version, question,
             evidence, requested_by, policy_evidence, requested_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15::jsonb, $16)
            ON CONFLICT (application_id, request_key) DO NOTHING
            RETURNING id`,
      parameters: [
        request.id,
        request.applicationId,
        request.tenantId,
        request.executionId,
        request.requestKey,
        request.requestFingerprint,
        request.target.kind,
        request.target.ref,
        request.target.revision ?? null,
        request.criterionId,
        request.criteriaVersion,
        request.question,
        JSON.stringify(request.evidence),
        request.requestedBy,
        request.policyEvidence === undefined ? null : JSON.stringify(request.policyEvidence),
        request.requestedAt,
      ],
    });
    if (inserted.rows.length > 0) {
      return request;
    }
    const existing = await this.findHumanRequestByKey(request.applicationId, request.requestKey);
    if (existing === null) {
      throw new PlatformError({
        code: "VERIFICATION_FAILED",
        message: "human evaluation request row disappeared after insert",
      });
    }
    if (existing.requestFingerprint !== request.requestFingerprint) {
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "human evaluation request key was already used with a different fingerprint",
      });
    }
    return existing;
  }

  private async selectHumanRequest(
    applicationId: string,
    requestId: string,
  ): Promise<HumanRequestRow | null> {
    const result = await this.db.execute<HumanRequestRow>({
      sql: `SELECT id, application_id, tenant_id, execution_id, request_key, request_fingerprint,
                  target_kind, target_ref, target_revision, criterion_id, criteria_version, question,
                  evidence, requested_by, policy_evidence, requested_at,
                  answered_by_result_id, answered_by, answered_at
            FROM verification.human_evaluation_requests
            WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, requestId],
    });
    return result.rows[0] ?? null;
  }

  async findHumanRequest(
    applicationId: string,
    requestId: string,
  ): Promise<HumanEvaluationRequestRecord | null> {
    const row = await this.selectHumanRequest(applicationId, requestId);
    return row === null ? null : toHumanRequest(row);
  }

  async findHumanRequestByKey(
    applicationId: string,
    requestKey: string,
  ): Promise<HumanEvaluationRequestRecord | null> {
    const result = await this.db.execute<HumanRequestRow>({
      sql: `SELECT id, application_id, tenant_id, execution_id, request_key, request_fingerprint,
                  target_kind, target_ref, target_revision, criterion_id, criteria_version, question,
                  evidence, requested_by, policy_evidence, requested_at,
                  answered_by_result_id, answered_by, answered_at
            FROM verification.human_evaluation_requests
            WHERE application_id = $1 AND request_key = $2`,
      parameters: [applicationId, requestKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : toHumanRequest(row);
  }

  async answerHumanRequest(input: AnswerHumanRequestInput): Promise<AnswerHumanRequestOutcome> {
    const updated = await this.db.execute<HumanRequestRow>({
      sql: `UPDATE verification.human_evaluation_requests
            SET answered_by_result_id = $3, answered_by = $4, answered_at = $5
            WHERE application_id = $1 AND id = $2 AND answered_by_result_id IS NULL
            RETURNING id, application_id, tenant_id, execution_id, request_key, request_fingerprint,
                      target_kind, target_ref, target_revision, criterion_id, criteria_version, question,
                      evidence, requested_by, policy_evidence, requested_at,
                      answered_by_result_id, answered_by, answered_at`,
      parameters: [
        input.applicationId,
        input.requestId,
        input.resultId,
        input.decidedBy,
        input.now,
      ],
    });
    if (updated.rows[0] !== undefined) {
      return { status: "answered", request: toHumanRequest(updated.rows[0]) };
    }
    const row = await this.selectHumanRequest(input.applicationId, input.requestId);
    if (row === null) {
      return { status: "missing" };
    }
    const request = toHumanRequest(row);
    if (request.answeredByResultId === input.resultId) {
      return { status: "answered", request };
    }
    return { status: "conflict", request };
  }

  async insertComparison(input: InsertComparisonInput): Promise<CandidateComparisonRecord> {
    const comparison = input.comparison;
    const inserted = await this.db.execute<ComparisonRow>({
      sql: `INSERT INTO verification.comparisons
            (id, application_id, tenant_id, execution_id, comparison_key, request_fingerprint,
             criterion_id, criteria_version, candidates, status, winner, per_candidate, rationale,
             evaluator_kind, evaluator_id, evaluator_version, planner_authorization,
             policy_evidence, compared_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13::jsonb,
                    $14, $15, $16, $17::jsonb, $18::jsonb, $19)
            ON CONFLICT (application_id, comparison_key) DO NOTHING
            RETURNING id`,
      parameters: [
        comparison.id,
        comparison.applicationId,
        comparison.tenantId,
        comparison.executionId,
        comparison.comparisonKey,
        comparison.requestFingerprint,
        comparison.criterionId,
        comparison.criteriaVersion,
        JSON.stringify(comparison.candidates),
        comparison.status,
        comparison.winner ?? null,
        JSON.stringify(comparison.perCandidate),
        JSON.stringify(comparison.rationale),
        comparison.evaluator.kind,
        comparison.evaluator.id,
        comparison.evaluator.version,
        JSON.stringify(comparison.plannerAuthorization),
        comparison.policyEvidence === undefined ? null : JSON.stringify(comparison.policyEvidence),
        comparison.comparedAt,
      ],
    });
    if (inserted.rows.length > 0) {
      return comparison;
    }
    const existing = await this.findComparisonByKey(
      comparison.applicationId,
      comparison.comparisonKey,
    );
    if (existing === null) {
      throw new PlatformError({
        code: "VERIFICATION_FAILED",
        message: "comparison row disappeared after insert",
      });
    }
    return existing;
  }

  async findComparisonByKey(
    applicationId: string,
    comparisonKey: string,
  ): Promise<CandidateComparisonRecord | null> {
    const result = await this.db.execute<ComparisonRow>({
      sql: `SELECT id, application_id, tenant_id, execution_id, comparison_key, request_fingerprint,
                  criterion_id, criteria_version, candidates, status, winner, per_candidate, rationale,
                  evaluator_kind, evaluator_id, evaluator_version, planner_authorization,
                  policy_evidence, compared_at
            FROM verification.comparisons
            WHERE application_id = $1 AND comparison_key = $2`,
      parameters: [applicationId, comparisonKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : toComparison(row);
  }
}
