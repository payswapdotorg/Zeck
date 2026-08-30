/**
 * Verification store port (verification module outbound; WORK-013).
 *
 * The durable evidence authority surface of the verification module.
 * Exactly like the WORK-005/WORK-010 store ports: the port is
 * provider-neutral; the SQL adapter (migration 0007) is the durable
 * implementation; the in-memory adapter serves unit tests.
 *
 * Physical invariants owned by migration 0007 (the store contract is
 * their application-level mirror):
 *
 *   - `results` are APPEND-ONLY and IMMUTABLE (no update/delete path
 *     exists on this port at all — M23 "result mutated after acceptance"
 *     is unrepresentable);
 *   - criteria declarations are append-only and identity-keyed
 *     (application, criterionId, version) — a redeclare converges only
 *     on an identical definition;
 *   - the evaluation journal is the IDEMPOTENCY authority: one durable
 *     row per (application, evaluation key); same key + different
 *     fingerprint is rejected by the caller (IDEMPOTENCY_KEY_REUSED);
 *     concurrent duplicates converge through the unique index;
 *   - human evaluation requests carry the exactly-once answer binding;
 *   - comparisons are append-only evidence.
 */

import type { CandidateComparisonRecord } from "../domain/comparison";
import type { VerificationCriteria } from "../domain/criteria";
import type { HumanEvaluationRequestRecord } from "../domain/human";
import type { VerificationPolicyEvidence, VerificationResultRecord } from "../domain/result";

// ---------------------------------------------------------------------------
// Criteria
// ---------------------------------------------------------------------------

export interface DeclareCriteriaOutcome {
  readonly criteria: VerificationCriteria;
  /** True when an identical declaration already existed (converged). */
  readonly converged: boolean;
}

export interface DeclareCriteriaScopeInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly criteria: VerificationCriteria;
}

// ---------------------------------------------------------------------------
// Evaluation journal
// ---------------------------------------------------------------------------

export type EvaluationJournalStatus = "denied" | "evaluating" | "concluded";

export interface EvaluationJournalRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly evaluationKey: string;
  readonly requestFingerprint: string;
  readonly targetKind: string;
  readonly targetRef: string;
  readonly targetRevision: string | null;
  readonly status: EvaluationJournalStatus;
  readonly denialReason: string | null;
  readonly criteria: readonly {
    readonly criterionId: string;
    readonly version: number;
  }[];
  readonly conclusion: {
    readonly criteriaMet: boolean;
    readonly requiredUnmet: readonly {
      readonly criterionId: string;
      readonly criteriaVersion: number;
      readonly status: string;
      readonly reason: string;
    }[];
    readonly replanningDecision?: { readonly decision: string; readonly detail?: string };
    readonly completed: boolean;
  } | null;
  readonly policyEvidence: VerificationPolicyEvidence | null;
  readonly requestedAt: string;
  readonly concludedAt: string | null;
  readonly ledgerRequestedSequence: number | null;
}

export interface ClaimEvaluationInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly evaluationKey: string;
  readonly requestFingerprint: string;
  readonly targetKind: string;
  readonly targetRef: string;
  readonly targetRevision: string | null;
  readonly criteria: readonly {
    readonly criterionId: string;
    readonly version: number;
  }[];
  readonly policyEvidence: VerificationPolicyEvidence | null;
  readonly now: string;
}

export interface ClaimEvaluationOutcome {
  readonly record: EvaluationJournalRecord;
  /** True when an existing row with the same key+fingerprint was found. */
  readonly existing: boolean;
}

export interface CompleteEvaluationInput {
  readonly applicationId: string;
  readonly evaluationId: string;
  readonly conclusion: EvaluationJournalRecord["conclusion"];
  readonly now: string;
}

export interface DenyEvaluationInput {
  readonly applicationId: string;
  readonly evaluationId: string;
  readonly reason: string;
  readonly now: string;
}

export interface BindLedgerSequenceInput {
  readonly applicationId: string;
  readonly evaluationId: string;
  readonly ledgerRequestedSequence: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface InsertVerificationResultInput {
  readonly result: VerificationResultRecord;
}

export interface InsertHumanRequestInput {
  readonly request: HumanEvaluationRequestRecord;
}

export interface AnswerHumanRequestInput {
  readonly applicationId: string;
  readonly requestId: string;
  readonly resultId: string;
  readonly decidedBy: string;
  readonly now: string;
}

export type AnswerHumanRequestOutcome =
  | { readonly status: "answered"; readonly request: HumanEvaluationRequestRecord }
  | {
      /** A different decision already answered this request (fail closed). */
      readonly status: "conflict";
      readonly request: HumanEvaluationRequestRecord;
    }
  | { readonly status: "missing" };

export interface InsertComparisonInput {
  readonly comparison: CandidateComparisonRecord;
}

export interface VerificationStore {
  // -- criteria (append-only, identity-keyed) --------------------------------
  declareCriteria(input: DeclareCriteriaScopeInput): Promise<DeclareCriteriaOutcome>;
  findCriteria(
    applicationId: string,
    criterionId: string,
    version: number,
  ): Promise<VerificationCriteria | null>;

  // -- evaluation journal (idempotency authority) ----------------------------
  claimEvaluation(input: ClaimEvaluationInput): Promise<ClaimEvaluationOutcome>;
  findEvaluationByKey(
    applicationId: string,
    evaluationKey: string,
  ): Promise<EvaluationJournalRecord | null>;
  completeEvaluation(input: CompleteEvaluationInput): Promise<EvaluationJournalRecord>;
  denyEvaluation(input: DenyEvaluationInput): Promise<EvaluationJournalRecord>;
  bindLedgerSequence(input: BindLedgerSequenceInput): Promise<void>;

  // -- results (append-only, immutable) --------------------------------------
  insertResult(input: InsertVerificationResultInput): Promise<VerificationResultRecord>;
  getResult(applicationId: string, resultId: string): Promise<VerificationResultRecord | null>;
  listResults(
    applicationId: string,
    executionId: string,
  ): Promise<readonly VerificationResultRecord[]>;

  // -- human evaluation (exactly-once answer binding) ------------------------
  insertHumanRequest(input: InsertHumanRequestInput): Promise<HumanEvaluationRequestRecord>;
  findHumanRequest(
    applicationId: string,
    requestId: string,
  ): Promise<HumanEvaluationRequestRecord | null>;
  findHumanRequestByKey(
    applicationId: string,
    requestKey: string,
  ): Promise<HumanEvaluationRequestRecord | null>;
  answerHumanRequest(input: AnswerHumanRequestInput): Promise<AnswerHumanRequestOutcome>;

  // -- comparisons (append-only) ---------------------------------------------
  insertComparison(input: InsertComparisonInput): Promise<CandidateComparisonRecord>;
  findComparisonByKey(
    applicationId: string,
    comparisonKey: string,
  ): Promise<CandidateComparisonRecord | null>;
}
