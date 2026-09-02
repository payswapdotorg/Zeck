/**
 * Realtime upstream rail port (deployments module outbound; WORK-024,
 * MOD-005 — the provider-neutral realtime/telephony upstream seam).
 *
 * THE replaceable upstream-infrastructure seam: a realtime rail adapter
 * TRANSPORTS neutral session/turn frames between the governed session
 * fabric and an upstream realtime infrastructure (web realtime media
 * channel or telephony-style carrier). The port's SHAPE keeps the core
 * contracts provider-neutral and non-authoritative:
 *
 *   - there is NO admission, authorization, budget, capability or
 *     execution-transition surface anywhere in the interface — no
 *     policy/budget/capability/execution handles cross this seam; the
 *     rail is handed only NEUTRAL coordinates (session identity refs,
 *     bounded previews, artifact references);
 *   - the rail is identified by a NEUTRAL rail capability id and the
 *     neutral channel kinds it serves — vendor identifiers NEVER cross
 *     this contract (a concrete vendor rail binds downstream in its
 *     own adapter, exactly like model rails);
 *   - RAW MEDIA never crosses this seam in either direction: inbound
 *     events arrive as bounded previews + artifact references; outbound
 *     deliveries carry bounded previews + artifact references (the
 *     work order's "raw media outside the execution ledger" rule — the
 *     media bytes live in the artifact/object-store plane, referenced
 *     by lineage);
 *   - credential materialization for a real rail happens INSIDE the
 *     adapter's own scope through the mediated connections vault —
 *     never through this port's shapes (references only).
 *
 * STABLE RAIL-LEVEL IDEMPOTENCY KEYS (the architect's crash-safety
 * correction for PR #46): every method that can perform an upstream
 * side effect (`openSession`, `deliverTurn`, `transferCall`,
 * `closeSession`) carries an `idempotencyKey` derived deterministically
 * from the durable session coordinates (domain/realtime.ts
 * `realtimeRail*Key`). The key's contract: re-issuing the SAME call
 * under the SAME key MUST converge — the rail performs the upstream
 * side effect EXACTLY ONCE and returns the ORIGINAL acknowledgment
 * with `replayed: true` (a real provider implements this with its
 * idempotency-key semantics; the shipped simulated rail implements it
 * with its in-memory key ledger). A crash between the durable claim and
 * the durable completion of an operation is recovered by REPLAYING the
 * call under the same key — no duplicate upstream side effect, ever.
 *
 * The shipped in-process simulated rail (adapters/in-process-realtime-rail.ts)
 * implements this seam for tests and local composition; REAL external
 * realtime/telephony provider behavior is explicitly UNVERIFIED in this
 * environment (no provider credentials, no guaranteed egress) and is
 * documented as such in docs/work-items/WORK-024.md.
 */

import type { RealtimeChannelKind, RealtimeRouteClass } from "../domain/realtime";

export interface RealtimeRailDescriptor {
  /** Provider-neutral rail identity (e.g. "simulated-realtime-rail"). */
  readonly railCapabilityId: string;
  /** The provider-neutral channel kinds this rail serves. */
  readonly channelKinds: readonly string[];
  /** The rail's declared transport class (realtime infrastructure only). */
  readonly transportClass: "realtime";
}

/** The neutral session-open request (identity refs + neutral policy). */
export interface RealtimeRailSessionRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deploymentId: string;
  readonly pinnedPlanId: string;
  readonly pinnedPlanVersion: number;
  readonly executionId: string;
  readonly channelKind: RealtimeChannelKind;
  /**
   * The STABLE rail-level idempotency key for this open (derived from
   * the session-start idempotency key): a retry/recovery re-opens under
   * the same key and converges on the SAME channel coordinates — a
   * crash between the rail open and the durable session row can never
   * produce a second upstream channel/session.
   */
  readonly idempotencyKey: string;
  /** The caller-supplied rail session reference to bind (when the rail pre-allocated one). */
  readonly channelSessionRef: string | null;
  readonly callerRef: string | null;
  /** The deployment plan's bounded session policy (duration/concurrency ceilings). */
  readonly sessionPolicy: {
    readonly maxSessionDurationMs: number;
    readonly maxConcurrentSessions: number;
  };
}

export interface RealtimeRailSession {
  readonly channelSessionRef: string;
  readonly channelEpoch: number;
  /** Neutral rail metadata for the binding (never credentials, never vendor ids). */
  readonly railMetadata: Readonly<Record<string, unknown>>;
  /** True when the rail converged on an existing key-bound session (idempotent open). */
  readonly replayed: boolean;
}

export interface RealtimeRailDelivery {
  readonly applicationId: string;
  readonly sessionId: string;
  readonly channelSessionRef: string;
  readonly channelEpoch: number;
  /** The turn's route class (the rail may adapt transport per class). */
  readonly routeClass: RealtimeRouteClass;
  /**
   * The STABLE rail-level idempotency key for this delivery (derived
   * from the inbound event key): a retry/recovery re-delivers under the
   * same key and converges — exactly one upstream delivery, ever.
   */
  readonly idempotencyKey: string;
  /** ARTIFACT REFERENCE of the response media (never the bytes). */
  readonly responseRef: string | null;
  /** Bounded text preview of the response (never raw media). */
  readonly responsePreview: string;
  /** Bounded delivery cause (provenance summary for the rail's record). */
  readonly cause: string | null;
}

export type RealtimeRailDeliveryOutcome =
  | {
      readonly delivered: true;
      readonly deliveredAt: string;
      /** True when the rail converged on the original delivery (idempotent replay). */
      readonly replayed: boolean;
      readonly railMetadata?: Readonly<Record<string, unknown>>;
    }
  | { readonly delivered: false; readonly reason: string };

export interface RealtimeRail {
  readonly descriptor: RealtimeRailDescriptor;
  /** Open (or bind) one channel session on the upstream rail (idempotent by key). */
  openSession(request: RealtimeRailSessionRequest): Promise<RealtimeRailSession>;
  /** Deliver one outbound turn frame to the caller (THE external side effect; idempotent by key). */
  deliverTurn(delivery: RealtimeRailDelivery): Promise<RealtimeRailDeliveryOutcome>;
  /** Transfer the live channel to a human destination (the escalation side effect; idempotent by key). */
  transferCall(delivery: RealtimeRailDelivery): Promise<RealtimeRailDeliveryOutcome>;
  /** Close the channel session on the upstream rail (idempotent by key). */
  closeSession(reference: {
    readonly applicationId: string;
    readonly sessionId: string;
    readonly channelSessionRef: string;
    readonly channelEpoch: number;
    /** The STABLE rail-level idempotency key for this close. */
    readonly idempotencyKey: string;
    readonly cause: string | null;
  }): Promise<RealtimeRailDeliveryOutcome>;
}

/**
 * The neutral inbound callback frame a rail emits into the session
 * fabric (webhook/transport callback shape — coordinates + bounded
 * payload + upstream event id when the rail supplies one).
 */
export interface RealtimeRailCallback {
  readonly applicationId: string;
  readonly sessionId: string | null;
  readonly channelSessionRef: string;
  readonly channelEpoch: number;
  readonly kind: "user-turn" | "interruption" | "caller-hangup";
  /** Upstream-supplied idempotency id, when the rail provides one. */
  readonly eventKey?: string;
  readonly payloadRef: string | null;
  readonly payloadPreview: string | null;
  readonly occurrenceOrdinal?: number;
}
