/**
 * Realtime execution-ledger port (deployments module outbound; WORK-024,
 * MOD-006 — the executions EventEnvelope is the SINGLE canonical
 * provenance path).
 *
 * The tie-in to the executions module's EventEnvelope ledger — the same
 * discipline as the agents module's execution-ledger port (WORK-011):
 * realtime session provenance (session start with identity context,
 * turns, interruptions, transfers, failures, significant actions,
 * session completion) rides the executions ledger as STEP EVENTS
 * through the executions public `recordStepEvent` seam using the
 * executions-owned agent-session vocabulary ("agent-session-started" /
 * "agent-action-recorded" / "agent-session-completed"). The semantic
 * detail (kind=turn/interruption/transfer/failure, route class,
 * artifact references, channel coordinates) rides the payload and
 * reference fields.
 *
 * The deployments module NEVER writes the executions tables directly
 * (a second event authority is unrepresentable): this port is REQUIRED
 * at runtime construction — no no-op implementation exists in this
 * module. Execution identity is established through the executions
 * public create seam (idempotent by key — a reconnect/retry converges
 * on the SAME execution identity, never a second authoritative
 * execution); the human-escalation wait/resume moves execution status
 * ONLY through the public transition-command surface.
 */

export interface RealtimeLedgerIdentity {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly actorId: string;
}

/** The provenance evidence classes the realtime fabric records. */
export type RealtimeEvidenceClass =
  | "session-started"
  | "turn"
  | "interruption"
  | "transfer"
  | "failure"
  | "significant-action"
  | "session-completed";

export interface RealtimeEvidenceInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly executionId: string;
  readonly evidenceClass: RealtimeEvidenceClass;
  /** Bounded provenance cause. */
  readonly cause?: string;
  /** Durable facts the evidence is bound to (session id, channel coords, artifact refs, route class, admission provenance). */
  readonly reference?: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RealtimeEvidenceOutcome {
  readonly sequence: number;
  readonly type: string;
  readonly replayed: boolean;
}

export interface RealtimeExecutionOpenInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly environmentId: string;
  readonly task: Readonly<Record<string, unknown>>;
  readonly inputArtifactRefs?: readonly string[];
  readonly constraints?: Readonly<Record<string, unknown>>;
  readonly userId?: string;
}

export interface RealtimeExecutionOpenOutcome {
  readonly executionId: string;
  readonly replayed: boolean;
  readonly status: string;
}

export interface RealtimeExecutionLedger {
  /**
   * Establish the governed Execution a realtime session maps to — the
   * executions public create seam, idempotent by the supplied key (a
   * retried/reconnected session start converges on the SAME execution
   * identity; a second authoritative execution is unrepresentable).
   */
  openExecution(
    input: RealtimeExecutionOpenInput,
    idempotencyKey: string,
  ): Promise<RealtimeExecutionOpenOutcome>;

  /**
   * Append ONE realtime provenance record on the canonical executions
   * ledger (idempotent per the supplied key; executions owns
   * sequencing, gaplessness, append-only enforcement and status
   * preservation).
   */
  recordEvidence(
    input: RealtimeEvidenceInput,
    idempotencyKey: string,
  ): Promise<RealtimeEvidenceOutcome>;

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
   * Move the session's execution to the human-escalation wait state
   * (the public transition-command surface — the ONLY way the realtime
   * fabric touches execution status; auditable on the ledger).
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

  /** Resume the execution after the human/transfer interaction. */
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
