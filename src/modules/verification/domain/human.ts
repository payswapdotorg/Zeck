/**
 * Human/user evaluation (verification module domain; WORK-013, VER-003;
 * ADR-0009/ADR-0012).
 *
 * Human evaluation is an EXPLICIT, attributable, policy-authorized,
 * provenance-preserving evaluator path — never a customer-domain state
 * machine (the request/decision pair below is evaluator evidence bound
 * to the parent Execution, whose lifecycle stays the single authority):
 *
 *   - a REQUEST is created only when a `human-judged` criterion is
 *     required and unresolved (or the planner explicitly escalates),
 *     and only after policy admission allows human evaluation
 *     (M8: human evaluation bypassing policy is unrepresentable —
 *     the admission seam is REQUIRED on this path);
 *   - a DECISION is attributable (`decidedBy` actor identity — M19:
 *     stripped human identity is unrepresentable), bound to the request
 *     (one decision per request, exactly-once), carries its own
 *     evidence references, and becomes ONE immutable VerificationResult
 *     with evaluator kind `human`;
 *   - the pair is NOT an execution state machine: whether a request is
 *     answered is derivable from the durable answer binding — there is
 *     no second lifecycle vocabulary here, and the execution-side
 *     representation of human escalation (WAITING_HUMAN) belongs to the
 *     executions state machine through the existing `wait-human`/
 *     `resume` edges, driven by the planner/orchestrator boundary.
 */

import type { VerificationPolicyEvidence, VerificationTarget } from "./result";

export type HumanDecisionStatus = "PASS" | "FAIL" | "INCONCLUSIVE";

export const HUMAN_DECISION_STATUSES: readonly HumanDecisionStatus[] = [
  "PASS",
  "FAIL",
  "INCONCLUSIVE",
];

export function isHumanDecisionStatus(value: string): value is HumanDecisionStatus {
  return (HUMAN_DECISION_STATUSES as readonly string[]).includes(value);
}

/**
 * The durable human-evaluation request (append-only; the only legal
 * UPDATE is the exactly-once answer finalization — migration 0007).
 */
export interface HumanEvaluationRequestRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  /** Caller idempotency key (unique per application). */
  readonly requestKey: string;
  readonly requestFingerprint: string;
  readonly target: VerificationTarget;
  readonly criterionId: string;
  readonly criteriaVersion: number;
  /** The question the human answers (criteria-definition-derived). */
  readonly question: string;
  /** Minimum evidence references the human considers (privacy-minimized). */
  readonly evidence: readonly string[];
  readonly requestedBy: string;
  readonly policyEvidence?: VerificationPolicyEvidence;
  readonly requestedAt: string;
  /** Answer binding — set EXACTLY ONCE by the decision finalization. */
  readonly answeredByResultId?: string;
  readonly answeredBy?: string;
  readonly answeredAt?: string;
}

/**
 * The human/user decision (the input of `submitHumanDecision`). The
 * decision vocabulary is the verification status vocabulary — the human
 * answers the criteria question; identity and rationale are mandatory
 * for provenance.
 */
export interface HumanDecisionInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly requestId: string;
  /** WHO decided (attributable actor identity — mandatory). */
  readonly decidedBy: string;
  readonly decision: HumanDecisionStatus;
  readonly rationale: string;
  readonly evidenceRefs?: readonly string[];
  readonly confidence?: number;
}

export function validateHumanDecision(input: {
  applicationId?: unknown;
  tenantId?: unknown;
  executionId?: unknown;
  requestId?: unknown;
  decidedBy?: unknown;
  decision?: unknown;
  rationale?: unknown;
  confidence?: unknown;
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
  if (typeof input.requestId !== "string" || input.requestId.length === 0) {
    issues.push("requestId must be a non-empty string");
  }
  if (typeof input.decidedBy !== "string" || input.decidedBy.length === 0) {
    issues.push("decidedBy must be a non-empty string (attributable human identity)");
  }
  if (typeof input.decision !== "string" || !isHumanDecisionStatus(input.decision)) {
    issues.push("decision must be one of PASS|FAIL|INCONCLUSIVE");
  }
  if (typeof input.rationale !== "string" || input.rationale.length === 0) {
    issues.push("rationale must be a non-empty string (why the decision was reached)");
  }
  if (
    input.confidence !== undefined &&
    (typeof input.confidence !== "number" || input.confidence < 0 || input.confidence > 1)
  ) {
    issues.push("confidence must be a number in [0,1] when present");
  }
  return issues;
}
