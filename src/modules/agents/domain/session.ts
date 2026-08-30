/**
 * Agent session domain (agents module domain; WORK-011, AGT-002/AGT-008/
 * ACP-006 + acceptance criterion 11).
 *
 * A session is ONE governed run of ONE immutable agent version inside ONE
 * parent execution. Its runtime identity is explicit and complete:
 *
 *   executionId + sessionId + agentId + agentVersionId
 *   + applicationId + tenantId
 *   + scoped permissions + scoped credentials + workspace identity
 *
 * Tenant/application scope is NEVER inferred from user-supplied runtime
 * fields — it is carried by the server-derived record and re-validated
 * at every boundary (the session is born from a tenant-guarded execution
 * read through the executions public service).
 *
 * The session lifecycle is SUBORDINATE to Execution — it is NOT an
 * execution state machine (discrimination M1/M19): session states are
 * agent-axis observations; execution status moves ONLY through the
 * executions module's public transition API (wait-human/resume for the
 * approval gate; agents never write execution status directly).
 *
 *   pending → running → completed
 *                ↘ waiting-approval → running
 *                ↘ failed / cancelled (terminal)
 *
 * `waiting-approval` mirrors the parent execution's WAITING_HUMAN state
 * while a policy-designated approval request is outstanding; the side
 * effect gated by that approval is impossible before the approval
 * decision (see approval.ts + the session service dispatch boundary).
 */

import type { AutonomyMode } from "../../policies/public";
import type { AgentDefinition } from "./agent-version";
import type { EffectivePermissions, SessionPolicyEvidence } from "./permissions";

export const SESSION_LIFECYCLE_STATUSES = [
  "pending",
  "running",
  "waiting-approval",
  "completed",
  "failed",
  "cancelled",
] as const;
export type SessionLifecycleStatus = (typeof SESSION_LIFECYCLE_STATUSES)[number];

export function isSessionLifecycleStatus(value: string): value is SessionLifecycleStatus {
  return (SESSION_LIFECYCLE_STATUSES as readonly string[]).includes(value);
}

/** Terminal session statuses (immutable rows from there on). */
export const TERMINAL_SESSION_STATUSES: readonly SessionLifecycleStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export function isTerminalSessionStatus(status: SessionLifecycleStatus): boolean {
  return TERMINAL_SESSION_STATUSES.includes(status);
}

/** Legal session-axis transitions (explicit; never an execution transition). */
export const SESSION_TRANSITIONS: Readonly<
  Record<SessionLifecycleStatus, readonly SessionLifecycleStatus[]>
> = {
  pending: ["running", "cancelled"],
  running: ["waiting-approval", "completed", "failed", "cancelled"],
  "waiting-approval": ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionSession(
  from: SessionLifecycleStatus,
  to: SessionLifecycleStatus,
): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

/** Does this action class require human approval under this definition? */
export function actionRequiresApproval(
  actionClass: string,
  definition: Readonly<Pick<AgentDefinition, "approvalRequiredActions">>,
): boolean {
  return definition.approvalRequiredActions.includes(actionClass);
}

/**
 * Does the EFFECTIVE policy autonomy engage the approval gate? Gates are
 * policy-designated: `none`/`gated` autonomy (the policy ladder) engages
 * human approval for approval-required actions; `sandboxed`/
 * `unconstrained` autonomy is the policy's explicit designation that the
 * action may run without an additional human gate.
 */
export function autonomyEngagesApprovalGate(autonomy: AutonomyMode): boolean {
  return autonomy === "none" || autonomy === "gated";
}

/** The complete durable session record. */
export interface AgentSessionRecord {
  /** Durable session identity (UUIDv7). */
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The parent execution (identity authority: executions module). */
  readonly executionId: string;
  readonly agentId: string;
  readonly agentVersionId: string;
  readonly workspaceId: string;
  /** Caller idempotency key (unique per application). */
  readonly sessionKey: string;
  readonly requestFingerprint: string;
  readonly status: SessionLifecycleStatus;
  /** One-way digest of the session input (provenance without retention). */
  readonly inputDigest: string;
  readonly inputArtifactRefs: readonly string[];
  /** Post-admission intersection ONLY (never the requested set). */
  readonly effectivePermissions: Readonly<EffectivePermissions>;
  readonly policyEvidence: Readonly<SessionPolicyEvidence>;
  /** The effective autonomy the policy granted this session. */
  readonly autonomy: AutonomyMode;
  readonly outputDigest: string | null;
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** Ledger sequence of the agent-session-started envelope. */
  readonly ledgerStartSequence: number | null;
  /** Ledger sequence of the terminal agent-session-completed envelope. */
  readonly ledgerEndSequence: number | null;
}

/**
 * Canonical session-request fingerprint input (deterministic, sorted —
 * the tools `toolRequestFingerprint` discipline): the same logical
 * create replays the same durable session; the same key with a
 * different fingerprint fails `IDEMPOTENCY_KEY_REUSED`.
 */
export function sessionRequestFingerprint(input: {
  readonly applicationId: string;
  readonly executionId: string;
  readonly agentId: string;
  readonly inputDigest: string;
  readonly inputArtifactRefs: readonly string[];
}): string {
  return JSON.stringify([
    "agents.create-session",
    input.applicationId,
    input.executionId,
    input.agentId,
    input.inputDigest,
    [...input.inputArtifactRefs].sort(),
  ]);
}
