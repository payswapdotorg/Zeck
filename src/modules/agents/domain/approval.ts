/**
 * Approval domain (agents module domain; WORK-011, AGT-006/ACP-004).
 *
 * Human approval is an EXECUTION/POLICY gate — never customer-domain
 * state (ADR-0002) and never a second authority. The governed flow:
 *
 *   gated action proposed
 *     ↓
 *   approval request persisted (durable, provenance-complete)
 *     ↓
 *   parent execution → WAITING_HUMAN (public transition; session →
 *   waiting-approval) — the SIDE EFFECT CANNOT DISPATCH in this state
 *     ↓
 *   human decision (approve/deny) with provenance
 *     ↓
 *   approved: execution resumes (public transition) and dispatch becomes
 *   possible; denied/revoked/expired: dispatch stays impossible
 *
 * Approval records carry the provenance sufficient to establish:
 * approver (who), requested action (what), timestamps (when), policy
 * basis + session/execution binding (why). An agent cannot fabricate an
 * approval: decisions are made through the governed service path only,
 * bound to the approving ACTOR, and dispatch re-validates the FULL
 * binding chain (session + execution + tenant + action class + status +
 * expiry) before any side effect.
 */

export const APPROVAL_STATUSES = ["pending", "approved", "denied", "revoked", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export function isApprovalStatus(value: string): value is ApprovalStatus {
  return (APPROVAL_STATUSES as readonly string[]).includes(value);
}

/** Decisions a human approver may record on a pending request. */
export const APPROVAL_DECISIONS = ["approved", "denied"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export function isApprovalDecision(value: string): value is ApprovalDecision {
  return (APPROVAL_DECISIONS as readonly string[]).includes(value);
}

/** Terminal approval statuses (the record is immutable from there on). */
export const TERMINAL_APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  "approved",
  "denied",
  "revoked",
  "expired",
];

export function isTerminalApprovalStatus(status: ApprovalStatus): boolean {
  return TERMINAL_APPROVAL_STATUSES.includes(status);
}

/** Does this approval record authorize dispatch of its gated action NOW? */
export function approvalAuthorizesDispatch(
  approval: { readonly status: ApprovalStatus; readonly expiresAt: string | null },
  now: string,
): boolean {
  if (approval.status !== "approved") {
    return false;
  }
  if (approval.expiresAt !== null && Date.parse(approval.expiresAt) <= Date.parse(now)) {
    return false;
  }
  return true;
}

/** The durable approval request + decision record. */
export interface AgentApprovalRecord {
  /** Durable approval identity (UUIDv7). */
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly sessionId: string;
  /** The action class this approval gates (e.g. "external-write"). */
  readonly actionClass: string;
  /** Structured descriptor of the requested action (never a secret). */
  readonly actionDescriptor: Readonly<Record<string, unknown>>;
  /** The policy basis recorded at gate engagement (the "why"). */
  readonly policyBasis: string;
  readonly status: ApprovalStatus;
  /** Caller idempotency key (unique per application). */
  readonly approvalKey: string;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  /** The approving human principal (the "who" of the decision). */
  readonly approverId: string | null;
  readonly decision: ApprovalDecision | null;
  readonly expiresAt: string | null;
  /** Ledger sequence of the wait-human transition envelope. */
  readonly ledgerWaitSequence: number | null;
}

/** Approval provenance sufficient to reconstruct who/what/when/why. */
export interface ApprovalProvenance {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly actionClass: string;
  readonly policyBasis: string;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly approverId: string | null;
  readonly decision: ApprovalDecision | null;
}

export function approvalProvenanceOf(approval: Readonly<AgentApprovalRecord>): ApprovalProvenance {
  return {
    approvalId: approval.id,
    sessionId: approval.sessionId,
    executionId: approval.executionId,
    actionClass: approval.actionClass,
    policyBasis: approval.policyBasis,
    requestedAt: approval.requestedAt,
    decidedAt: approval.decidedAt,
    approverId: approval.approverId,
    decision: approval.decision,
  };
}
