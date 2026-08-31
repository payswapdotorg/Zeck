/**
 * In-memory verification store (verification module adapters; WORK-013).
 *
 * The unit-test implementation of the `VerificationStore` port — the same
 * contract the SQL adapter (migration 0007) implements durably. It
 * mirrors the physical invariants at the application level: append-only
 * results (no update/delete path exists), identity-keyed criteria,
 * unique-key idempotency arbitration and exactly-once human-answer
 * binding.
 */

import { PlatformError } from "../../../shared/errors";
import type { CandidateComparisonRecord } from "../domain/comparison";
import type { VerificationCriteria } from "../domain/criteria";
import type { HumanEvaluationRequestRecord } from "../domain/human";
import type { VerificationResultRecord } from "../domain/result";
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

function fingerprintOfCriteria(criteria: VerificationCriteria): string {
  return JSON.stringify([
    criteria.criterionId,
    criteria.version,
    criteria.kind,
    criteria.required,
    criteria.description,
    criteria.definition,
  ]);
}

export class InMemoryVerificationStore implements VerificationStore {
  private readonly criteria = new Map<string, VerificationCriteria>();
  private readonly evaluations = new Map<string, EvaluationJournalRecord>();
  private readonly evaluationKeys = new Map<string, string>();
  private readonly results = new Map<string, VerificationResultRecord>();
  private readonly humanRequests = new Map<string, HumanEvaluationRequestRecord>();
  private readonly humanRequestKeys = new Map<string, string>();
  private readonly comparisons = new Map<string, CandidateComparisonRecord>();
  private readonly comparisonKeys = new Map<string, string>();

  async declareCriteria(input: DeclareCriteriaScopeInput): Promise<DeclareCriteriaOutcome> {
    const criteria = input.criteria;
    const key = `${input.applicationId}|${criteria.criterionId}|${criteria.version}`;
    const existing = this.criteria.get(key);
    if (existing !== undefined) {
      if (fingerprintOfCriteria(existing) !== fingerprintOfCriteria(criteria)) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: `criterion ${criteria.criterionId}@${criteria.version} is already declared with a different definition (criteria are immutable; declare a new version)`,
        });
      }
      return { criteria: existing, converged: true };
    }
    this.criteria.set(key, criteria);
    return { criteria, converged: false };
  }

  async findCriteria(
    applicationId: string,
    criterionId: string,
    version: number,
  ): Promise<VerificationCriteria | null> {
    return this.criteria.get(`${applicationId}|${criterionId}|${version}`) ?? null;
  }

  async claimEvaluation(input: ClaimEvaluationInput): Promise<ClaimEvaluationOutcome> {
    const existingId = this.evaluationKeys.get(`${input.applicationId}|${input.evaluationKey}`);
    if (existingId !== undefined) {
      const existing = this.evaluations.get(existingId);
      if (existing !== undefined) {
        return { record: existing, existing: true };
      }
    }
    const record: EvaluationJournalRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      executionId: input.executionId,
      evaluationKey: input.evaluationKey,
      requestFingerprint: input.requestFingerprint,
      targetKind: input.targetKind,
      targetRef: input.targetRef,
      targetRevision: input.targetRevision,
      status: "evaluating",
      denialReason: null,
      criteria: input.criteria,
      conclusion: null,
      policyEvidence: input.policyEvidence,
      requestedAt: input.now,
      concludedAt: null,
      ledgerRequestedSequence: null,
    };
    this.evaluations.set(input.id, record);
    this.evaluationKeys.set(`${input.applicationId}|${input.evaluationKey}`, input.id);
    return { record, existing: false };
  }

  async findEvaluationByKey(
    applicationId: string,
    evaluationKey: string,
  ): Promise<EvaluationJournalRecord | null> {
    const id = this.evaluationKeys.get(`${applicationId}|${evaluationKey}`);
    return id === undefined ? null : (this.evaluations.get(id) ?? null);
  }

  async completeEvaluation(input: CompleteEvaluationInput): Promise<EvaluationJournalRecord> {
    const record = this.evaluations.get(input.evaluationId);
    if (record === undefined || record.applicationId !== input.applicationId) {
      throw new PlatformError({
        code: "VERIFICATION_FAILED",
        message: "evaluation journal row not found",
      });
    }
    const updated: EvaluationJournalRecord = {
      ...record,
      status: "concluded",
      conclusion: input.conclusion,
      concludedAt: input.now,
    };
    this.evaluations.set(input.evaluationId, updated);
    return updated;
  }

  async denyEvaluation(input: DenyEvaluationInput): Promise<EvaluationJournalRecord> {
    const record = this.evaluations.get(input.evaluationId);
    if (record === undefined || record.applicationId !== input.applicationId) {
      throw new PlatformError({
        code: "VERIFICATION_FAILED",
        message: "evaluation journal row not found",
      });
    }
    const updated: EvaluationJournalRecord = {
      ...record,
      status: "denied",
      denialReason: input.reason,
      concludedAt: input.now,
    };
    this.evaluations.set(input.evaluationId, updated);
    return updated;
  }

  async bindLedgerSequence(input: BindLedgerSequenceInput): Promise<void> {
    const record = this.evaluations.get(input.evaluationId);
    if (record === undefined || record.applicationId !== input.applicationId) {
      return;
    }
    this.evaluations.set(input.evaluationId, {
      ...record,
      ledgerRequestedSequence: input.ledgerRequestedSequence,
    });
  }

  async insertResult(input: InsertVerificationResultInput): Promise<VerificationResultRecord> {
    const existing = this.results.get(input.result.id);
    if (existing !== undefined) {
      return existing;
    }
    this.results.set(input.result.id, input.result);
    return input.result;
  }

  async getResult(
    applicationId: string,
    resultId: string,
  ): Promise<VerificationResultRecord | null> {
    const result = this.results.get(resultId);
    return result !== undefined && result.applicationId === applicationId ? result : null;
  }

  async listResults(
    applicationId: string,
    executionId: string,
  ): Promise<readonly VerificationResultRecord[]> {
    return [...this.results.values()]
      .filter(
        (result) => result.applicationId === applicationId && result.executionId === executionId,
      )
      .sort((a, b) =>
        a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : a.id < b.id ? -1 : 1,
      );
  }

  async insertHumanRequest(input: InsertHumanRequestInput): Promise<HumanEvaluationRequestRecord> {
    const existingId = this.humanRequestKeys.get(
      `${input.request.applicationId}|${input.request.requestKey}`,
    );
    if (existingId !== undefined) {
      const existing = this.humanRequests.get(existingId);
      if (existing !== undefined) {
        if (existing.requestFingerprint !== input.request.requestFingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "human evaluation request key was already used with a different fingerprint",
          });
        }
        return existing;
      }
    }
    this.humanRequests.set(input.request.id, input.request);
    this.humanRequestKeys.set(
      `${input.request.applicationId}|${input.request.requestKey}`,
      input.request.id,
    );
    return input.request;
  }

  async findHumanRequest(
    applicationId: string,
    requestId: string,
  ): Promise<HumanEvaluationRequestRecord | null> {
    const request = this.humanRequests.get(requestId);
    return request !== undefined && request.applicationId === applicationId ? request : null;
  }

  async findHumanRequestByKey(
    applicationId: string,
    requestKey: string,
  ): Promise<HumanEvaluationRequestRecord | null> {
    const id = this.humanRequestKeys.get(`${applicationId}|${requestKey}`);
    return id === undefined ? null : (this.humanRequests.get(id) ?? null);
  }

  async answerHumanRequest(input: AnswerHumanRequestInput): Promise<AnswerHumanRequestOutcome> {
    const request = this.humanRequests.get(input.requestId);
    if (request === undefined || request.applicationId !== input.applicationId) {
      return { status: "missing" };
    }
    if (request.answeredByResultId !== undefined) {
      if (request.answeredByResultId === input.resultId) {
        return { status: "answered", request };
      }
      return { status: "conflict", request };
    }
    const updated: HumanEvaluationRequestRecord = {
      ...request,
      answeredByResultId: input.resultId,
      answeredBy: input.decidedBy,
      answeredAt: input.now,
    };
    this.humanRequests.set(input.requestId, updated);
    return { status: "answered", request: updated };
  }

  async insertComparison(input: InsertComparisonInput): Promise<CandidateComparisonRecord> {
    const existingId = this.comparisonKeys.get(
      `${input.comparison.applicationId}|${input.comparison.comparisonKey}`,
    );
    if (existingId !== undefined) {
      const existing = this.comparisons.get(existingId);
      if (existing !== undefined) {
        return existing;
      }
    }
    this.comparisons.set(input.comparison.id, input.comparison);
    this.comparisonKeys.set(
      `${input.comparison.applicationId}|${input.comparison.comparisonKey}`,
      input.comparison.id,
    );
    return input.comparison;
  }

  async findComparisonByKey(
    applicationId: string,
    comparisonKey: string,
  ): Promise<CandidateComparisonRecord | null> {
    const id = this.comparisonKeys.get(`${applicationId}|${comparisonKey}`);
    return id === undefined ? null : (this.comparisons.get(id) ?? null);
  }
}
