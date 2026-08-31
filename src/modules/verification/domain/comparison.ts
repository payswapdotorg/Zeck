/**
 * Candidate comparison (verification module domain; WORK-013, VER-004;
 * ADR-0011 property 5 / ADR-0012).
 *
 * Candidate comparison is EXPLICIT and gated: an evaluator never
 * silently chooses whichever candidate it likes. A comparison
 *
 *   - is initiated ONLY by the planner, with a recorded decision
 *     reference (the planner-authorization gate — M16: comparison
 *     bypassing the planner is rejected before any evaluation);
 *   - is policy-admitted (the REQUIRED admission seam — same as every
 *     verification action);
 *   - evaluates EVERY candidate against the SAME declared criteria,
 *     preserving candidate identity end-to-end (candidate ids ride the
 *     durable record and the per-candidate results);
 *   - persists its evaluation evidence (per-candidate results +
 *     rationale) as immutable comparison evidence;
 *   - selects a winner ONLY when the criteria decisively establish one;
 *     unresolved uncertainty yields INCONCLUSIVE — never a forced
 *     winner, never a coerced PASS (M22 discipline);
 *   - stays compatible with deterministic-first planning: deterministic
 *     criteria decide deterministically; only genuinely semantic
 *     criteria route to judged evaluation.
 */

import type { EvaluatorIdentity, VerificationPolicyEvidence, VerificationStatus } from "./result";

/** A candidate under comparison: identity + the evidence assessed. */
export interface ComparisonCandidate {
  readonly candidateId: string;
  readonly evidenceRefs: readonly string[];
  readonly facts: Readonly<Record<string, unknown>>;
}

/** The planner authorization that gates every comparison (VER-004). */
export interface PlannerAuthorization {
  readonly initiator: "planner";
  /** The planner's durable decision reference (decision id / rationale ref). */
  readonly decisionRef: string;
  readonly reason: string;
}

export function validatePlannerAuthorization(value: {
  initiator?: unknown;
  decisionRef?: unknown;
  reason?: unknown;
}): readonly string[] {
  const issues: string[] = [];
  if (value.initiator !== "planner") {
    issues.push('initiator must be "planner" (candidate comparison is planner-gated)');
  }
  if (typeof value.decisionRef !== "string" || value.decisionRef.length === 0) {
    issues.push("decisionRef must be a non-empty string (the planner decision reference)");
  }
  if (typeof value.reason !== "string" || value.reason.length === 0) {
    issues.push("reason must be a non-empty string");
  }
  return issues;
}

/**
 * The durable comparison record (append-only, immutable): candidate
 * identity, the criteria identity, per-candidate statuses, the outcome
 * and — only when the criteria decided — the winner.
 */
export interface CandidateComparisonRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  /** Caller idempotency key (unique per application). */
  readonly comparisonKey: string;
  readonly requestFingerprint: string;
  readonly criterionId: string;
  readonly criteriaVersion: number;
  readonly candidates: readonly ComparisonCandidate[];
  /**
   * PASS — the criteria decisively select `winner`;
   * FAIL — the evidence demonstrates NO candidate meets the criteria;
   * INCONCLUSIVE — uncertainty unresolved (no winner, never forced).
   */
  readonly status: VerificationStatus;
  readonly winner?: string;
  readonly perCandidate: readonly {
    readonly candidateId: string;
    readonly status: VerificationStatus;
    readonly observations: readonly string[];
  }[];
  readonly rationale: readonly string[];
  readonly evaluator: EvaluatorIdentity;
  readonly plannerAuthorization: PlannerAuthorization;
  readonly policyEvidence?: VerificationPolicyEvidence;
  readonly comparedAt: string;
}

export function validateComparison(input: {
  applicationId?: unknown;
  tenantId?: unknown;
  executionId?: unknown;
  criterionId?: unknown;
  criteriaVersion?: unknown;
  candidates?: unknown;
  plannerAuthorization?: unknown;
}): readonly string[] {
  const issues: string[] = [];
  if (typeof input.applicationId !== "string" || input.applicationId.length === 0) {
    issues.push("applicationId must be a non-empty string");
  }
  if (typeof input.tenantId !== "string" || input.tenantId.length === 0) {
    issues.push("tenantId must be a non-empty string");
  }
  if (typeof input.executionId !== "string" || input.executionId.length === 0) {
    issues.push("executionId must be a non-empty string");
  }
  if (typeof input.criterionId !== "string" || input.criterionId.length === 0) {
    issues.push("criterionId must be a non-empty string (declared criteria gate every comparison)");
  }
  if (
    typeof input.criteriaVersion !== "number" ||
    !Number.isInteger(input.criteriaVersion) ||
    input.criteriaVersion < 1
  ) {
    issues.push("criteriaVersion must be a positive integer");
  }
  if (
    !Array.isArray(input.candidates) ||
    input.candidates.length < 2 ||
    input.candidates.some(
      (candidate) =>
        typeof (candidate as ComparisonCandidate)?.candidateId !== "string" ||
        (candidate as ComparisonCandidate).candidateId.length === 0,
    )
  ) {
    issues.push("candidates must be an array of at least two identified candidates");
  }
  if (input.plannerAuthorization === null || typeof input.plannerAuthorization !== "object") {
    issues.push("plannerAuthorization is required (planner-gated comparison)");
  }
  return issues;
}
