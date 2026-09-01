/**
 * Runner fleet store port (sandbox module outbound; WORK-019, ENV-003).
 *
 * The durable state surface of the customer-runner fleet: runner identity
 * (registration, authorization, health, connection), the assignment journal
 * (idempotent per assignment key, EXCLUSIVELY leased per runner) and the
 * append-only assignment evidence trail (provenance, reconnect history).
 *
 * Arbitration contract (the WORK-004/006/012 durable-identity discipline,
 * restated for the fleet axis):
 *
 *   - runners converge on UNIQUE (application_id, slug): concurrent
 *     duplicate registrations converge through unique-index arbitration;
 *     the identity core (environment, version, capabilities, token
 *     fingerprint) is WRITE-ONCE — there is no update path for it (a
 *     changed runner is a NEW registration; revocation is the only
 *     identity-affecting mutation and it is terminal);
 *   - assignments converge on UNIQUE (application_id, assignment_key):
 *     same key + same fingerprint replays the same durable outcome; same
 *     key + different fingerprint fails IDEMPOTENCY_KEY_REUSED (raised by
 *     the service, which owns the fingerprint); concurrent duplicates
 *     converge on the committed row;
 *   - at most ONE ACTIVE assignment (assigned | dispatched) exists per
 *     runner — physically enforced by a partial unique index (M19: no
 *     split-brain runner ownership); the assignment insert is additionally
 *     guarded by the runner's authorization + health + heartbeat freshness
 *     IN THE SAME STATEMENT (M20: a dead runner is never assigned);
 *   - terminal assignment rows (completed | failed | released | expired)
 *     are PHYSICALLY immutable; the only legal updates are the guarded
 *     one-shot transitions (assigned → dispatched; assigned/dispatched →
 *     completed/failed/released/expired) and reconnect bookkeeping on
 *     NON-terminal rows;
 *   - assignment events are APPEND-ONLY with a per-assignment sequence:
 *     no update, no delete (M18 — provenance survives reconnects);
 *   - every read is application-scoped (cross-application reads return
 *     null — tenant isolation is the caller's typed rejection).
 */

import type {
  RunnerAssignmentProvenance,
  RunnerAssignmentRecord,
  RunnerConnectionStatus,
  RunnerHealthStatus,
  RunnerRecord,
  RunnerResultReport,
} from "../domain/runner";
import type { ClaimOutcome } from "./sandbox-store";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface InsertRunnerInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly environmentId: string;
  readonly slug: string;
  readonly name: string;
  readonly runnerVersion: string;
  readonly declaredCapabilities: readonly string[];
  readonly tokenFingerprint: string;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface AuthorizeRunnerInput {
  readonly applicationId: string;
  readonly runnerId: string;
  readonly actorId: string;
  readonly authorizedAt: string;
}

export interface RevokeRunnerInput {
  readonly applicationId: string;
  readonly runnerId: string;
  readonly reason: string;
  readonly revokedAt: string;
}

export interface ObserveRunnerHealthInput {
  readonly applicationId: string;
  readonly runnerId: string;
  readonly health: RunnerHealthStatus;
  readonly heartbeatAt: string;
}

export interface ObserveRunnerConnectionInput {
  readonly applicationId: string;
  readonly runnerId: string;
  readonly connection: RunnerConnectionStatus;
  readonly observedAt: string;
}

export interface InsertRunnerAssignmentInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly sandboxId: string;
  readonly environmentId: string;
  readonly runnerId: string;
  readonly assignmentKey: string;
  readonly requestFingerprint: string;
  readonly requiredCapabilities: readonly string[];
  readonly lease: {
    readonly leasedAt: string;
    readonly leaseExpiresAt: string;
    readonly leaseDurationMs: number;
  };
  readonly provenance: RunnerAssignmentProvenance;
  readonly createdAt: string;
  /**
   * The heartbeat-freshness cutoff: the assignment insert is refused (0
   * rows) unless the runner is authorized, explicitly healthy and its
   * heartbeat is at or after this instant (M20 — the physical health race
   * guard, evaluated in the same statement as the insert).
   */
  readonly heartbeatCutoff: string;
}

export type RunnerAssignmentEventName =
  | "assigned"
  | "dispatched"
  | "reconnected"
  | "reported"
  | "completed"
  | "failed"
  | "released"
  | "expired"
  | "revoked";

export interface AppendRunnerAssignmentEventInput {
  readonly applicationId: string;
  readonly assignmentId: string;
  readonly runnerId: string;
  readonly executionId: string;
  readonly event: RunnerAssignmentEventName;
  readonly actorId: string;
  readonly cause: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

export interface ClaimRunnerDispatchInput {
  readonly applicationId: string;
  readonly assignmentId: string;
  readonly handoffNonce: string;
  readonly dispatchedAt: string;
}

export interface RecordRunnerResultInput {
  readonly applicationId: string;
  readonly assignmentId: string;
  readonly status: "completed" | "failed";
  readonly report: RunnerResultReport;
  readonly reportedAt: string;
}

export interface ReleaseRunnerAssignmentInput {
  readonly applicationId: string;
  readonly assignmentId: string;
  readonly from: "assigned" | "dispatched";
  readonly reason: string;
  readonly releasedAt: string;
}

export interface ExpireRunnerAssignmentInput {
  readonly applicationId: string;
  readonly assignmentId: string;
  readonly expiredAt: string;
}

export interface RecordRunnerReconnectInput {
  readonly applicationId: string;
  readonly assignmentId: string;
  readonly reconnectedAt: string;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** One append-only assignment evidence row (the provenance trail, M18). */
export interface RunnerAssignmentEventRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly assignmentId: string;
  readonly runnerId: string;
  readonly executionId: string;
  readonly sequence: number;
  readonly event: RunnerAssignmentEventName;
  readonly actorId: string;
  readonly cause: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

export interface RunnerStore {
  // ---- runner identity ----
  insertRunner(input: InsertRunnerInput): Promise<ClaimOutcome<RunnerRecord>>;
  findRunner(applicationId: string, runnerId: string): Promise<RunnerRecord | null>;
  findRunnerBySlug(applicationId: string, slug: string): Promise<RunnerRecord | null>;
  listRunners(applicationId: string): Promise<readonly RunnerRecord[]>;
  /** The ONLY trust mutation: the explicit untrusted → authorized grant. */
  authorizeRunner(input: AuthorizeRunnerInput): Promise<ClaimOutcome<RunnerRecord>>;
  /** Revocation (terminal; also the scope for releasing active assignments). */
  revokeRunner(input: RevokeRunnerInput): Promise<ClaimOutcome<RunnerRecord>>;
  /** Health observation (heartbeat). The mutable observation field. */
  observeRunnerHealth(input: ObserveRunnerHealthInput): Promise<RunnerRecord>;
  /** Connection observation (connected/disconnected/offline). */
  observeRunnerConnection(input: ObserveRunnerConnectionInput): Promise<RunnerRecord>;

  // ---- assignment journal ----
  /**
   * Idempotent, health-guarded, exclusive assignment insert. Converges on
   * (application_id, assignment_key); claims the runner's single active
   * slot; refuses (0 rows) when the runner is not authorized, not healthy
   * or heartbeat-stale at insert time. The returned record is NULL when
   * the insert was refused by the physical runner guards (the caller
   * derives the typed rejection from the CURRENT committed state).
   */
  insertRunnerAssignment(
    input: InsertRunnerAssignmentInput,
  ): Promise<ClaimOutcome<RunnerAssignmentRecord | null>>;
  findRunnerAssignment(
    applicationId: string,
    assignmentId: string,
  ): Promise<RunnerAssignmentRecord | null>;
  findRunnerAssignmentByKey(
    applicationId: string,
    assignmentKey: string,
  ): Promise<RunnerAssignmentRecord | null>;
  /** The runner's ACTIVE assignment (assigned | dispatched), if any. */
  findActiveAssignmentByRunner(
    applicationId: string,
    runnerId: string,
  ): Promise<RunnerAssignmentRecord | null>;
  listRunnerAssignmentsBySandbox(
    applicationId: string,
    sandboxId: string,
  ): Promise<readonly RunnerAssignmentRecord[]>;
  listRunnerAssignmentsByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly RunnerAssignmentRecord[]>;
  /** The one-shot assigned → dispatched claim (durable dispatch intent). */
  claimRunnerDispatch(
    input: ClaimRunnerDispatchInput,
  ): Promise<ClaimOutcome<RunnerAssignmentRecord>>;
  /** The one-shot dispatched → completed/failed finalization. */
  recordRunnerResult(input: RecordRunnerResultInput): Promise<ClaimOutcome<RunnerAssignmentRecord>>;
  /** The guarded release (assigned/dispatched → released). */
  releaseRunnerAssignment(
    input: ReleaseRunnerAssignmentInput,
  ): Promise<ClaimOutcome<RunnerAssignmentRecord>>;
  /** The guarded expiry (lease deadline passed; assigned/dispatched → expired). */
  expireRunnerAssignment(
    input: ExpireRunnerAssignmentInput,
  ): Promise<ClaimOutcome<RunnerAssignmentRecord>>;
  /**
   * Reconnect bookkeeping on a dispatched row (count + updatedAt only).
   * Claimed=false when the row converged elsewhere (terminalized or
   * reported) — the committed record replays, never a second count.
   */
  recordRunnerReconnect(
    input: RecordRunnerReconnectInput,
  ): Promise<ClaimOutcome<RunnerAssignmentRecord>>;

  // ---- append-only evidence ----
  appendRunnerAssignmentEvent(input: AppendRunnerAssignmentEventInput): Promise<void>;
  listRunnerAssignmentEvents(
    applicationId: string,
    assignmentId: string,
  ): Promise<readonly RunnerAssignmentEventRecord[]>;
}

export type { ClaimOutcome };
