/**
 * Messaging execution-ledger port (deployments module outbound; WORK-025,
 * MOD-009 — the executions EventEnvelope is the SINGLE canonical
 * provenance path).
 *
 * The tie-in to the executions module's EventEnvelope ledger — the
 * same discipline as the realtime fabric's ledger port (WORK-024):
 * messaging conversation provenance (conversation start with identity
 * context, inbound-message-to-outbound-reply turns, delivery-status
 * evidence, human escalations, failures, significant actions,
 * conversation completion) rides the executions ledger as STEP EVENTS
 * through the executions public `recordStepEvent` seam using the
 * executions-owned agent-session vocabulary ("agent-session-started"
 * / "agent-action-recorded" / "agent-session-completed"). The semantic
 * detail (kind=message/escalation/delivery/failure, route class,
 * artifact references, channel coordinates) rides the payload and
 * reference fields.
 *
 * The deployments module NEVER writes the executions tables directly
 * (a second event authority is unrepresentable): this port is REQUIRED
 * at runtime construction — no no-op implementation exists in this
 * module. Execution identity is established through the executions
 * public create seam (idempotent by key — a retried conversation
 * start converges on the SAME execution identity, never a second
 * authoritative execution); the human-escalation wait/resume moves
 * execution status ONLY through the public transition-command surface.
 */

export interface MessagingLedgerIdentity {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly actorId: string;
}

/** The provenance evidence classes the messaging fabric records. */
export type MessagingEvidenceClass =
  | "conversation-started"
  | "message"
  | "delivery"
  | "escalation"
  | "failure"
  | "significant-action"
  | "conversation-completed";

export interface MessagingEvidenceInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly executionId: string;
  readonly evidenceClass: MessagingEvidenceClass;
  /** Bounded provenance cause. */
  readonly cause?: string;
  /**
   * Durable facts the evidence is bound to (conversation id, channel
   * coordinates, message/send keys, artifact refs, route class,
   * admission provenance).
   */
  readonly reference?: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface MessagingEvidenceOutcome {
  readonly sequence: number;
  readonly type: string;
  readonly replayed: boolean;
}

export interface MessagingExecutionOpenInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly environmentId: string;
  readonly task: Readonly<Record<string, unknown>>;
  readonly inputArtifactRefs?: readonly string[];
  readonly constraints?: Readonly<Record<string, unknown>>;
  readonly userId?: string;
}

export interface MessagingExecutionOpenOutcome {
  readonly executionId: string;
  readonly replayed: boolean;
  readonly status: string;
}

export interface MessagingExecutionLedger {
  /**
   * Establish the governed Execution a conversation maps to — the
   * executions public create seam, idempotent by the supplied key (a
   * retried conversation start converges on the SAME execution
   * identity; a second authoritative execution is unrepresentable).
   */
  openExecution(
    input: MessagingExecutionOpenInput,
    idempotencyKey: string,
  ): Promise<MessagingExecutionOpenOutcome>;

  /**
   * Append ONE messaging provenance record on the canonical executions
   * ledger (idempotent per the supplied key; executions owns
   * sequencing, gaplessness, append-only enforcement and status
   * preservation).
   */
  recordEvidence(
    input: MessagingEvidenceInput,
    idempotencyKey: string,
  ): Promise<MessagingEvidenceOutcome>;

  /** Tenant-guarded execution facts read. */
  readExecution(
    applicationId: string,
    executionId: string,
  ): Promise<{
    readonly id: string;
    readonly tenantId: string;
    readonly status: string;
  } | null>;

  /**
   * Move the conversation's execution to the human-escalation wait
   * state (the public transition-command surface — the ONLY way the
   * messaging fabric touches execution status; auditable on the
   * ledger; escalation is a GOVERNED Execution step).
   */
  awaitHuman(
    input: {
      readonly applicationId: string;
      readonly tenantId: string;
      readonly actorId: string;
      readonly executionId: string;
      readonly reason: string;
    },
    idempotencyKey: string,
  ): Promise<{ readonly sequence: number; readonly replayed: boolean }>;

  /** Resume the execution after the human interaction. */
  continueAfterHuman(
    input: {
      readonly applicationId: string;
      readonly tenantId: string;
      readonly actorId: string;
      readonly executionId: string;
      readonly reason: string;
    },
    idempotencyKey: string,
  ): Promise<{ readonly sequence: number; readonly replayed: boolean }>;
}
