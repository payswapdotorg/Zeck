/**
 * Tool invocation store port (tools module outbound; WORK-010).
 *
 * The durable evidence + idempotency surface of the governed tool runtime
 * (acceptance criterion 3): every invocation — admitted or denied — lands
 * as ONE durable row carrying the request (identity, fingerprint, input
 * digest, artifact refs), the outcome (normalized output + outcome class
 * from the tool-only vocabulary), timing, budget linkage, admission
 * evidence and the ledger sequence bindings.
 *
 * Idempotency contract (`spec/contracts.md` "Idempotency response rule"):
 * the row is keyed by `(application_id, invocation_key)` where
 * `invocation_key` is the caller's idempotency key. The first writer
 * claims the key; the same key + same request fingerprint replays the
 * SAME durable outcome; the same key + a different fingerprint fails
 * `IDEMPOTENCY_KEY_REUSED`; concurrent identical requests converge through
 * PostgreSQL uniqueness arbitration (the loser adopts the winner's
 * committed row). This mirrors the platform.idempotency_records contract
 * on the module's own journal — the invocation record IS the durable
 * outcome (the models dispatch-journal precedent: idempotent by its own
 * key).
 *
 * Lifecycle discipline (a journal, not a state machine):
 *   - `claimDispatching` inserts the durable intent AFTER all admissions
 *     passed (§14: intent persisted at the auditable execution boundary,
 *     before the adapter call); a concurrent/previous claim converges;
 *   - `recordDenied` inserts the journal-then-fail denial row;
 *   - `recordOutcome` finalizes a `dispatching` row EXACTLY ONCE (guarded
 *     first-writer-wins; the loser re-reads and returns the winner's
 *     committed outcome); terminal rows are immutable (migration 0005
 *     enforces this physically — the SQL adapter + in-memory fake mirror
 *     it);
 *   - there is NO delete and NO un-finalize.
 */

import type {
  ToolDenialClass,
  ToolFailureClass,
  ToolInvocationRecord,
  ToolInvocationStatus,
  ToolOutcomeClass,
  ToolPolicyEvidence,
} from "../domain/invocation";

export interface ClaimDispatchingInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly invocationKey: string;
  readonly requestFingerprint: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly capabilityId: string;
  readonly inputDigest: string;
  readonly inputArtifacts: readonly string[];
  readonly budgetOperationId: string | null;
  readonly policyEvidence: ToolPolicyEvidence | null;
  readonly capabilitySatisfaction: string | null;
  readonly requestedAt: string;
}

export interface RecordDeniedInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly invocationKey: string;
  readonly requestFingerprint: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly capabilityId: string;
  readonly inputDigest: string;
  readonly inputArtifacts: readonly string[];
  readonly denialClass: ToolDenialClass;
  readonly denialCode: string;
  readonly denialReason: string;
  readonly requestedAt: string;
}

export interface RecordOutcomeInput {
  readonly applicationId: string;
  readonly invocationKey: string;
  readonly status: "succeeded" | "tool-failed";
  readonly outcomeClass: ToolOutcomeClass;
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly outputArtifacts: readonly string[];
  readonly failureClass: ToolFailureClass | null;
  readonly failureMessage: string | null;
  readonly retryable: boolean;
  readonly usageMicroUsd: string | null;
  readonly dispatchedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

/** A ledger sequence observed for the invocation (bookkeeping update). */
export interface BindLedgerSequenceInput {
  readonly applicationId: string;
  readonly invocationKey: string;
  readonly phase: "requested" | "result";
  readonly sequence: number;
}

export type ClaimOutcome =
  | { readonly claimed: true; readonly record: ToolInvocationRecord }
  /** An existing row owns the key — converge on it (same fingerprint). */
  | { readonly claimed: false; readonly record: ToolInvocationRecord };

export interface ToolInvocationStore {
  /** Read the row owning (applicationId, invocationKey), if any. */
  findByKey(applicationId: string, invocationKey: string): Promise<ToolInvocationRecord | null>;

  /** Read one invocation by id (application-scoped). */
  findById(applicationId: string, invocationId: string): Promise<ToolInvocationRecord | null>;

  /** Durable-intent insert after admission; converges on an existing claim. */
  claimDispatching(input: ClaimDispatchingInput): Promise<ClaimOutcome>;

  /** Journal-then-fail denial insert; converges on an existing claim. */
  recordDenied(input: RecordDeniedInput): Promise<ClaimOutcome>;

  /**
   * Finalize a dispatching row exactly once (guarded). Returns the
   * committed terminal record — the winner's when two writers converge.
   */
  recordOutcome(input: RecordOutcomeInput): Promise<ToolInvocationRecord>;

  /**
   * Record the ledger sequence binding of one phase (best-effort,
   * idempotent, dispatching rows only — terminal rows never change; the
   * envelope stays findable on the ledger by reference.invocationId).
   */
  bindLedgerSequence(input: BindLedgerSequenceInput): Promise<void>;

  /** The execution's evidence timeline (TOL-002 downstream surface). */
  listByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly ToolInvocationRecord[]>;

  /** Durable status vocabulary check (adapter-side validation aid). */
  isKnownStatus(status: string): status is ToolInvocationStatus;
}
