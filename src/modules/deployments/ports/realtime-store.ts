/**
 * Realtime store port (deployments module outbound; WORK-024, MOD-006).
 *
 * The durable-state seam for realtime sessions and the append-only
 * realtime channel journal (migration 0018). The arbitration contract
 * (the WORK-011/012/017/023 discipline):
 *
 *   - session creation converges on (application, idempotency key)
 *     with fingerprint arbitration; the physical UNIQUE
 *     (application, channel_ref, epoch) arbitrates the rail's channel
 *     coordinates;
 *   - session mutations are GUARDED: the store takes the expected
 *     current status (and, for reattach, the expected current channel
 *     ref/epoch) and the physical single-row update arbitrates
 *     concurrent duplicates — first writer wins, duplicates converge
 *     on the committed row;
 *   - the channel journal is APPEND-ONLY, identity-ordered (event_seq)
 *     and the INBOUND IDEMPOTENCY LEDGER: claiming an inbound event
 *     (claimInboundEvent) converges on the physical UNIQUE
 *     (application, session, event_key) — the winner proceeds, a
 *     duplicate converges on the committed row (with the SAME body
 *     digest; a same-key/different-body claim fails closed);
 *   - the DURABLE, RECOVERABLE OPERATION STATE (the architect's
 *     crash-safety correction for PR #46): every governed rail-side
 *     effect operation owns ONE row in the operations ledger with a
 *     PENDING → COMPLETED|FAILED machine. `beginRealtimeOperation`
 *     converges on the physical UNIQUE (application, operation_key)
 *     and bumps `attempts` on re-claim; `completed`/`failed` are
 *     terminal-immutable (physical trigger); a crash between claim and
 *     completion leaves the row PENDING and a retry MUST resume it —
 *     the row is the discriminator between "fully completed" (replay
 *     the recorded outcome, no side effect) and "claimed but not
 *     completed" (resume with the stable rail idempotency key);
 *   - inbound freshness: an inbound claim whose (channel_ref, epoch)
 *     does not match the session's CURRENT coordinates fails closed
 *     (the stale-callback guard — physically enforced by the migration
 *     trigger);
 *   - every read is scope-filtered (application); tenant identity is
 *     carried on every row and never dropped.
 */

import type {
  RealtimeEventDirection,
  RealtimeEventKind,
  RealtimeEventRecord,
  RealtimeOperationCheckpoint,
  RealtimeOperationKind,
  RealtimeOperationRecord,
  RealtimeRouteClass,
  RealtimeSessionRecord,
  RealtimeSessionStatus,
} from "../domain/realtime";

export interface RealtimeSessionInsertInput {
  readonly sessionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deploymentId: string;
  readonly pinnedPlanId: string;
  readonly pinnedPlanVersion: number;
  readonly executionId: string;
  readonly channelKind: string;
  readonly channelSessionRef: string;
  readonly channelEpoch: number;
  readonly callerRef: string | null;
  readonly creationFingerprint: string;
  readonly createdBy: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export type RealtimeSessionInsertOutcome =
  | { readonly status: "created"; readonly sessionId: string }
  | { readonly status: "converged"; readonly sessionId: string };

export interface RealtimeEventAppendInput {
  readonly eventId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly deploymentId: string;
  readonly kind: RealtimeEventKind;
  readonly direction: RealtimeEventDirection;
  readonly eventKey: string;
  readonly channelSessionRef: string;
  readonly channelEpoch: number;
  readonly executionId: string | null;
  readonly ledgerSequence: number | null;
  readonly routeClass: RealtimeRouteClass | null;
  readonly cause: string | null;
  readonly payloadRef: string | null;
  readonly payloadPreview: string | null;
  readonly actorId: string;
  readonly bodyDigest: string;
  readonly createdAt: string;
}

export type RealtimeEventAppendOutcome =
  | { readonly status: "appended"; readonly event: RealtimeEventRecord }
  /** The same (session, event_key, body) already committed — replay. */
  | { readonly status: "converged"; readonly event: RealtimeEventRecord };

export interface RealtimeSessionMutation {
  readonly applicationId: string;
  readonly sessionId: string;
  /** The expected CURRENT status (the guard). */
  readonly expectedStatus: RealtimeSessionStatus;
  /** The target status (the guarded status move). */
  readonly toStatus: RealtimeSessionStatus;
  /** For reattach: the new channel coordinates + the expected current ones. */
  readonly expectedChannelRef: string | null;
  readonly expectedChannelEpoch: number | null;
  readonly toChannelRef: string | null;
  readonly toChannelEpoch: number | null;
  /** Closure timestamp for terminal moves. */
  readonly closedAt: string | null;
}

export type RealtimeSessionMutationOutcome =
  | { readonly status: "applied"; readonly session: RealtimeSessionRecord }
  | { readonly status: "converged"; readonly session: RealtimeSessionRecord };

/** Input of `beginRealtimeOperation` (the durable operation claim). */
export interface RealtimeOperationBeginInput {
  readonly operationId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /**
   * Provenance reference only (NO physical FK): a session-start
   * operation row is durably claimed BEFORE its session row exists —
   * that ordering is exactly the crash window this ledger closes.
   */
  readonly sessionId: string | null;
  readonly deploymentId: string;
  readonly executionId: string | null;
  readonly operationKind: RealtimeOperationKind;
  readonly operationKey: string;
  readonly createdAt: string;
}

export type RealtimeOperationBeginOutcome =
  /** This invocation claimed the operation (it owns the pending row). */
  | { readonly status: "begun"; readonly record: RealtimeOperationRecord }
  /** The operation row already exists (replay or crash-resume; attempts bumped). */
  | { readonly status: "existing"; readonly record: RealtimeOperationRecord };

export interface RealtimeStore {
  insertSession(input: RealtimeSessionInsertInput): Promise<RealtimeSessionInsertOutcome>;
  findSession(applicationId: string, sessionId: string): Promise<RealtimeSessionRecord | null>;
  /** The idempotent-replay fast path (the session-start key lookup). */
  findSessionByStartKey(
    applicationId: string,
    idempotencyKey: string,
  ): Promise<RealtimeSessionRecord | null>;
  /** Find the session currently holding a rail channel coordinate (reconnect resolution). */
  findSessionByChannel(
    applicationId: string,
    channelSessionRef: string,
    channelEpoch: number,
  ): Promise<RealtimeSessionRecord | null>;
  applyGuardedSessionMutation(
    input: RealtimeSessionMutation,
  ): Promise<RealtimeSessionMutationOutcome>;
  appendChannelEvent(input: RealtimeEventAppendInput): Promise<RealtimeEventAppendOutcome>;
  /** The channel journal of one session in append order. */
  listEvents(applicationId: string, sessionId: string): Promise<readonly RealtimeEventRecord[]>;

  // -- the durable, recoverable operation state (PR #46 correction) ------

  /**
   * Claim (or re-claim) one governed operation. Converges on the
   * physical UNIQUE (application, operation_key): the first invocation
   * inserts a PENDING row; every later invocation with the same key
   * returns the EXISTING row with `attempts` bumped — the caller MUST
   * distinguish `completed` (pure replay), `failed` (recorded failure
   * replay) and `pending` (crash-resume) before side effects.
   */
  beginRealtimeOperation(
    input: RealtimeOperationBeginInput,
  ): Promise<RealtimeOperationBeginOutcome>;
  /**
   * Persist the stage checkpoint (PENDING rows only; the
   * past-the-point-of-no-return facts a resume completes from).
   */
  recordRealtimeOperationCheckpoint(
    applicationId: string,
    operationKey: string,
    checkpoint: RealtimeOperationCheckpoint,
    updatedAt: string,
  ): Promise<RealtimeOperationRecord>;
  /**
   * PENDING → COMPLETED (the durable outcome now exists; idempotent
   * convergence when already completed; a failed operation cannot be
   * completed).
   */
  completeRealtimeOperation(
    applicationId: string,
    operationKey: string,
    completedAt: string,
  ): Promise<RealtimeOperationRecord>;
  /**
   * PENDING → FAILED with a bounded reason (a durably recorded terminal
   * failure outcome; idempotent convergence when already failed).
   */
  failRealtimeOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    failedAt: string,
  ): Promise<RealtimeOperationRecord>;
  /** The operation lookup by its stable key (the recovery discriminator). */
  findRealtimeOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<RealtimeOperationRecord | null>;
}
