/**
 * Sandbox store port (sandbox module outbound; WORK-012).
 *
 * The durable state surface of the sandbox axis: the environment catalog
 * (immutable specifications + a small lifecycle) and the sandbox
 * executions journal (idempotent admission rows, immutable runtime
 * metadata, guarded dispatch/finalize transitions).
 *
 * Arbitration contract (the WORK-004/006/010/011 durable-identity
 * discipline, restated):
 *
 *   - environments converge on UNIQUE (application_id, slug): concurrent
 *     duplicate registrations converge through unique-index arbitration;
 *     the specification is content-addressed (digest) and WRITE-ONCE —
 *     there is NO update/delete path for specification fields (the only
 *     mutation is the explicit lifecycle status through guarded
 *     transitions; retired is terminal-immutable);
 *   - sandbox executions converge on UNIQUE (application_id, sandbox_key):
 *     same key + same fingerprint replays the same durable outcome; same
 *     key + different fingerprint fails IDEMPOTENCY_KEY_REUSED (raised by
 *     the service, which owns the fingerprint); concurrent duplicates
 *     converge on the committed row;
 *   - `denied` rows are INSERT-ONLY terminal (journal-then-fail denials);
 *   - terminal rows (denied/completed/failed) are PHYSICALLY immutable
 *     (the SQL adapter's migration enforces it with triggers); the only
 *     legal updates are: admitted → ledger-sequence bookkeeping and the
 *     one-shot admitted → dispatching claim, then dispatching →
 *     completed/failed finalization;
 *   - `runtime_metadata` is IMMUTABLE on every update path (write-once
 *     admitted snapshot — the dispatched work is always the admitted
 *     work).
 */

import type {
  ComputeEnvironmentRecord,
  ComputeEnvironmentRegistrationInput,
  EnvironmentLifecycleStatus,
} from "../domain/environment";
import type { SandboxExecutionRecord, SandboxExecutionStatus } from "../domain/sandbox";

/** First-writer-wins arbitration outcome for unique-key inserts. */
export interface ClaimOutcome<T> {
  readonly claimed: boolean;
  readonly record: T;
}

export interface InsertEnvironmentInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly kind: string;
  readonly spec: Readonly<Record<string, unknown>>;
  readonly specDigest: string;
  readonly createdAt: string;
}

export interface UpdateEnvironmentStatusInput {
  readonly applicationId: string;
  readonly environmentId: string;
  readonly from: EnvironmentLifecycleStatus;
  readonly to: EnvironmentLifecycleStatus;
  readonly updatedAt: string;
}

export interface InsertSandboxInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly sandboxKey: string;
  readonly requestFingerprint: string;
  readonly environmentId: string;
  readonly kind: string;
  readonly status: SandboxExecutionStatus;
  readonly runtimeMetadata: Readonly<Record<string, unknown>>;
  readonly denialClass: string | null;
  readonly denialCode: string | null;
  readonly denialReason: string | null;
  readonly budgetOperationId: string | null;
  readonly createdAt: string;
}

export interface BindLedgerSequenceInput {
  readonly applicationId: string;
  readonly sandboxKey: string;
  readonly phase: "admitted" | "completed";
  readonly sequence: number;
}

export interface RecordOutcomeInput {
  readonly applicationId: string;
  readonly sandboxKey: string;
  readonly status: "completed" | "failed";
  readonly outcomeClass: string;
  readonly failureClass: string | null;
  readonly failureMessage: string | null;
  readonly retryable: boolean;
  readonly outputDigest: string | null;
  /** The bounded observation output (WORK-018 durable output evidence). */
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly usageMicroUsd: string | null;
  readonly dispatchedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly completedLedgerSequence: number | null;
}

export interface SandboxStore {
  // ---- environment catalog ----
  insertEnvironment(input: InsertEnvironmentInput): Promise<ClaimOutcome<ComputeEnvironmentRecord>>;
  findEnvironmentBySlug(
    applicationId: string,
    slug: string,
  ): Promise<ComputeEnvironmentRecord | null>;
  findEnvironment(
    applicationId: string,
    environmentId: string,
  ): Promise<ComputeEnvironmentRecord | null>;
  listEnvironments(applicationId: string): Promise<readonly ComputeEnvironmentRecord[]>;
  /** The ONLY environment mutation: one guarded lifecycle transition. */
  updateEnvironmentStatus(
    input: UpdateEnvironmentStatusInput,
  ): Promise<ClaimOutcome<ComputeEnvironmentRecord>>;

  // ---- sandbox executions ----
  insertSandbox(input: InsertSandboxInput): Promise<ClaimOutcome<SandboxExecutionRecord>>;
  findSandboxByKey(
    applicationId: string,
    sandboxKey: string,
  ): Promise<SandboxExecutionRecord | null>;
  findSandbox(applicationId: string, sandboxId: string): Promise<SandboxExecutionRecord | null>;
  listSandboxesByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly SandboxExecutionRecord[]>;
  /** Claim the one-shot admitted → dispatching transition (durable intent). */
  claimDispatching(
    applicationId: string,
    sandboxKey: string,
  ): Promise<ClaimOutcome<SandboxExecutionRecord>>;
  /** Bind a ledger sequence onto a NON-terminal row (bookkeeping only). */
  bindLedgerSequence(input: BindLedgerSequenceInput): Promise<SandboxExecutionRecord>;
  /** The one-shot dispatching → completed/failed finalization. */
  recordOutcome(input: RecordOutcomeInput): Promise<SandboxExecutionRecord>;
}

/** Re-exported for the catalog service (registration input convenience). */
export type { ComputeEnvironmentRegistrationInput };
