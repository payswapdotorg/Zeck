/**
 * Execution store port (executions module outbound; WORK-006).
 *
 * The durable state authority surface. Exactly ONE production writer path
 * exists: `updateExecutionForTransition` — called only by the transition
 * service, always paired with `appendEvent` in the SAME transaction, with
 * `nextSequence = lastEventSequence + 1` re-derived from the LOCKED row.
 * Migration 0004 makes the coupling physical: an execution-row UPDATE that
 * does not append exactly one matching envelope is rejected by trigger.
 */

import type { EventEnvelope } from "../domain/event";
import type { ExecutionRecord } from "../domain/execution";
import type { VerificationResultRecord } from "../domain/verification";

export interface InsertExecutionInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly environmentId: string | null;
  readonly userId: string;
  readonly task: Readonly<Record<string, unknown>>;
  readonly inputArtifactRefs: readonly string[];
  readonly constraints: Readonly<Record<string, unknown>> | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly requestFingerprint: string;
  readonly now: string;
}

/** The ONLY legal execution-row mutation: one transition, one envelope. */
export interface ApplyTransitionInput {
  readonly executionId: string;
  readonly applicationId: string;
  readonly nextStatus: string;
  /** Must be exactly lastEventSequence + 1 of the locked row. */
  readonly nextSequence: number;
  /** Verification-result ids bound to a pass transition (else empty). */
  readonly verificationRefs: readonly string[];
  readonly now: string;
}

export interface ApplicationTenantRow {
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface EnvironmentRow {
  readonly id: string;
  readonly applicationId: string;
}

export interface InsertVerificationResultInput {
  readonly id: string;
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly criterionId: string;
  readonly strategy: string;
  readonly status: string;
  readonly evidence: readonly string[];
  readonly recordedBy: string;
}

export interface ExecutionStore {
  /** Application existence + tenant (for scope assertion at create). */
  findApplication(applicationId: string): Promise<ApplicationTenantRow | null>;
  /** Environment existence + owning application (composite-scope assertion). */
  findEnvironment(environmentId: string): Promise<EnvironmentRow | null>;

  /** Create the row (status CREATED, lastEventSequence 1 pending its event). */
  insertExecution(input: InsertExecutionInput): Promise<ExecutionRecord>;
  /**
   * Lock the execution row FOR UPDATE and return the CURRENT committed row —
   * transition legality and the next sequence are ALWAYS re-derived under
   * this lock (the WORK-002 lock-before-decide discipline). Returns null
   * when the execution does not exist for this application.
   */
  lockExecution(applicationId: string, executionId: string): Promise<ExecutionRecord | null>;
  /**
   * Apply one validated transition: set status/lastEventSequence (+terminal
   * timestamp, +verification binding) — AFTER appendEvent placed the
   * matching envelope in this transaction. This is the single write path.
   */
  updateExecutionForTransition(input: ApplyTransitionInput): Promise<ExecutionRecord>;
  getExecution(applicationId: string, executionId: string): Promise<ExecutionRecord | null>;

  /** Append one envelope (sequence must be max+1; append-only ledger). */
  appendEvent(input: import("../domain/event").AppendEventInput): Promise<EventEnvelope>;
  listEvents(applicationId: string, executionId: string): Promise<readonly EventEnvelope[]>;

  /** Append one durable verification result (append-only evidence). */
  insertVerificationResult(input: InsertVerificationResultInput): Promise<VerificationResultRecord>;
  listVerificationResults(
    applicationId: string,
    executionId: string,
  ): Promise<readonly VerificationResultRecord[]>;
}
