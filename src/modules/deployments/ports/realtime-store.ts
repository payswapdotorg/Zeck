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
  appendEvent(input: RealtimeEventAppendInput): Promise<RealtimeEventAppendOutcome>;
  /** The channel journal of one session in append order. */
  listEvents(applicationId: string, sessionId: string): Promise<readonly RealtimeEventRecord[]>;
}
