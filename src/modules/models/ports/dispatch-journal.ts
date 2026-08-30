/**
 * Dispatch journal port (models module outbound, CON-005 durable proof).
 *
 * Durable evidence of every dispatch attempt, following the
 * `IMPLEMENTATION.md` §14 sequence for external side effects: durable intent
 * FIRST (`recordIntent` — the attempt row exists before the adapter call),
 * then dispatch, then the observed outcome (`recordOutcome`). A crash
 * between intent and outcome leaves the row at `dispatching` — honest
 * evidence of an unknown external outcome that downstream accounting
 * (WORK-004+) must treat as unresolved, never silently as success.
 *
 * The journal is append-only evidence, NOT an authority: it cannot drive
 * execution state (that authority belongs to `/executions`) and the
 * `outcome_class` CHECK constraint (migration 0002) makes the provider-axis
 * durable outcome classes (`provider-success` / `provider-failure`)
 * physically distinct from the quality/verification axis.
 */

import type { DispatchStatus, ModelCallOutcome } from "../domain/outcome";

export interface DispatchIntentInput {
  readonly id: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly connectionId: string;
  readonly rail: string;
  readonly model: string;
  /** One-way hash of the normalized request — provenance without payload retention. */
  readonly requestHash: string;
}

export interface DispatchJournal {
  /** Persist durable intent BEFORE the adapter call (idempotent by attempt id). */
  recordIntent(input: DispatchIntentInput): Promise<void>;

  /** Record the observed provider-axis outcome for an attempt. */
  recordOutcome(
    attemptId: string,
    status: DispatchStatus,
    outcome: ModelCallOutcome,
  ): Promise<void>;

  /** Record an admission denial (durable policy evidence; no dispatch happened). */
  recordDenial(input: DispatchIntentInput, reason: string): Promise<void>;

  /** Read one attempt (verification/tests). */
  findAttempt(attemptId: string): Promise<JournalAttempt | null>;
}

export interface JournalAttempt {
  readonly id: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly connectionId: string;
  readonly rail: string;
  readonly model: string;
  readonly requestHash: string;
  readonly admitted: boolean;
  readonly status: DispatchStatus;
  readonly outcome: unknown;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}
