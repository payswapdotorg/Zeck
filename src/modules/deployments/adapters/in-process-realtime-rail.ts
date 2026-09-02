/**
 * In-process simulated realtime rail (deployments module adapter;
 * WORK-024, MOD-005/AC2 — the upstream-rail integration adapter).
 *
 * A REALTIME/TELEPHONY-STYLE upstream rail simulated fully in process:
 * it implements the provider-neutral `RealtimeRail` seam exactly like
 * a real carrier/web-transport adapter would (opaque channel session
 * references, monotonic epochs, turn delivery, human transfer, close)
 * and records every observable transport side effect for the test
 * suites' discrimination proofs (which deliveries happened, in what
 * order, with what frames).
 *
 * STABLE RAIL-LEVEL IDEMPOTENCY KEYS (the architect's crash-safety
 * correction for PR #46): every side-effect method converges on its
 * `(application, idempotencyKey)` — the FIRST call under a key performs
 * the upstream side effect and is remembered; ANY later call under the
 * SAME key returns the ORIGINAL acknowledgment with `replayed: true`
 * and records NO second side effect (the `deliveries` observable shows
 * exactly one entry per logical key). This is the in-memory twin of a
 * real provider's server-side idempotency-key semantics: the provider
 * survives a Zeck process crash, so the key ledger is deliberately kept
 * on the rail (which models the external world), not in the crashing
 * process. A REFUSAL (failure injection) is not a side effect and is
 * never cached under the key — a retry under the same key may succeed.
 *
 * PROVIDER-INTEGRATION HONESTY: this sandbox has NO external
 * realtime/telephony provider credentials and no guaranteed egress, so
 * no real provider call is made or claimed. All rail behavior verified
 * by this repository's tests is the SIMULATED in-process rail behind
 * the neutral seam; REAL external realtime/telephony provider
 * behavior (network transport, carrier signaling, actual audio
 * transfer) is explicitly UNVERIFIED and documented as such in
 * docs/work-items/WORK-024.md. Replacing this adapter with a real
 * vendor adapter requires no change to any core contract (the
 * seam is the boundary).
 */

import type {
  RealtimeRail,
  RealtimeRailDelivery,
  RealtimeRailDeliveryOutcome,
  RealtimeRailSession,
  RealtimeRailSessionRequest,
} from "../ports/realtime-rail";

/** One recorded transport side effect (the test observable). */
export interface SimulatedRailDeliveryRecord {
  readonly kind: "open" | "deliver" | "transfer" | "close";
  readonly applicationId: string;
  readonly sessionId: string | null;
  readonly channelSessionRef: string;
  readonly channelEpoch: number;
  readonly routeClass: string | null;
  /** The stable rail-level idempotency key that produced this effect. */
  readonly idempotencyKey: string;
  readonly responsePreview: string | null;
  readonly cause: string | null;
  readonly at: string;
}

/**
 * The stored canonical acknowledgment for one side-effect key (the
 * per-call `replayed` flag is NOT stored — it is derived on each call).
 */
type StoredRailOutcome = {
  readonly delivered: true;
  readonly deliveredAt: string;
  readonly railMetadata?: Readonly<Record<string, unknown>>;
};

/** One key-converged replay (the idempotency observable). */
export interface SimulatedRailReplayRecord {
  readonly kind: "open" | "deliver" | "transfer" | "close";
  readonly idempotencyKey: string;
  readonly at: string;
}

export interface InProcessRealtimeRailOptions {
  /** Deterministic session-reference allocator (defaults to an ordinal sequence). */
  readonly allocateRef?: () => string;
  readonly now?: () => Date;
  /** When set, every delivery fails with this reason (failure-injection tests). */
  readonly failDeliveries?: string;
}

export function createInProcessRealtimeRail(
  channelKinds: readonly string[] = ["web", "in-app", "telephony"],
  options: InProcessRealtimeRailOptions = {},
): RealtimeRail & {
  /** The recorded transport side effects, in order (the test observable). */
  readonly deliveries: readonly SimulatedRailDeliveryRecord[];
  /** The key-converged replays, in order (the idempotency observable). */
  readonly replays: readonly SimulatedRailReplayRecord[];
  /** Fail the NEXT delivery once (failure-injection). */
  failNextDelivery(reason: string): void;
  /** How many DISTINCT sessions the rail opened (per idempotency key). */
  readonly openedSessions: number;
} {
  const records: SimulatedRailDeliveryRecord[] = [];
  const replays: SimulatedRailReplayRecord[] = [];
  const now = options.now ?? (() => new Date());
  let ordinal = 0;
  let opened = 0;
  let failNext: string | null = null;
  const allocateRef =
    options.allocateRef ??
    (() => {
      ordinal += 1;
      return `simrail-session-${ordinal}`;
    });

  // The provider-side idempotency ledgers: key -> the original effect.
  const opensByKey = new Map<string, RealtimeRailSession>();
  const outcomesByKey = new Map<
    string,
    {
      readonly kind: "deliver" | "transfer" | "close";
      readonly outcome: StoredRailOutcome;
      readonly deliveredAt: string;
    }
  >();

  const fail = (reason: string): RealtimeRailDeliveryOutcome => {
    const injected = failNext;
    if (injected !== null) {
      failNext = null;
      return { delivered: false, reason: injected };
    }
    return { delivered: false, reason: options.failDeliveries ?? reason };
  };

  const rail: RealtimeRail = {
    descriptor: {
      railCapabilityId: "simulated-realtime-rail",
      channelKinds,
      transportClass: "realtime",
    },
    async openSession(request: RealtimeRailSessionRequest): Promise<RealtimeRailSession> {
      // Idempotent open: the SAME stable key converges on the SAME
      // channel coordinates (a crash between the rail open and the
      // durable session row can never produce a second channel).
      const key = `${request.applicationId}:${request.idempotencyKey}`;
      const existing = opensByKey.get(key);
      if (existing !== undefined) {
        replays.push({
          kind: "open",
          idempotencyKey: request.idempotencyKey,
          at: now().toISOString(),
        });
        return { ...existing, replayed: true };
      }
      opened += 1;
      const channelSessionRef =
        request.channelSessionRef === null ? allocateRef() : request.channelSessionRef;
      const session: RealtimeRailSession = {
        channelSessionRef,
        channelEpoch: 1,
        railMetadata: {
          simulated: true,
          channelKind: request.channelKind,
          sessionPolicy: { ...request.sessionPolicy },
        },
        replayed: false,
      };
      opensByKey.set(key, session);
      records.push({
        kind: "open",
        applicationId: request.applicationId,
        sessionId: null,
        channelSessionRef,
        channelEpoch: 1,
        routeClass: null,
        idempotencyKey: request.idempotencyKey,
        responsePreview: null,
        cause: null,
        at: now().toISOString(),
      });
      return session;
    },
    async deliverTurn(delivery: RealtimeRailDelivery): Promise<RealtimeRailDeliveryOutcome> {
      const key = `${delivery.applicationId}:${delivery.idempotencyKey}`;
      const existing = outcomesByKey.get(key);
      if (existing !== undefined && existing.kind === "deliver") {
        replays.push({
          kind: "deliver",
          idempotencyKey: delivery.idempotencyKey,
          at: now().toISOString(),
        });
        return { ...existing.outcome, replayed: true };
      }
      if (failNext !== null) {
        return fail(failNext);
      }
      const deliveredAt = now().toISOString();
      const outcome: StoredRailOutcome = {
        delivered: true,
        deliveredAt,
        railMetadata: { simulated: true, routeClass: delivery.routeClass },
      };
      outcomesByKey.set(key, { kind: "deliver", outcome, deliveredAt });
      records.push({
        kind: "deliver",
        applicationId: delivery.applicationId,
        sessionId: delivery.sessionId,
        channelSessionRef: delivery.channelSessionRef,
        channelEpoch: delivery.channelEpoch,
        routeClass: delivery.routeClass,
        idempotencyKey: delivery.idempotencyKey,
        responsePreview: delivery.responsePreview,
        cause: delivery.cause,
        at: deliveredAt,
      });
      return { ...outcome, replayed: false };
    },
    async transferCall(delivery: RealtimeRailDelivery): Promise<RealtimeRailDeliveryOutcome> {
      const key = `${delivery.applicationId}:${delivery.idempotencyKey}`;
      const existing = outcomesByKey.get(key);
      if (existing !== undefined && existing.kind === "transfer") {
        replays.push({
          kind: "transfer",
          idempotencyKey: delivery.idempotencyKey,
          at: now().toISOString(),
        });
        return { ...existing.outcome, replayed: true };
      }
      if (failNext !== null) {
        return fail(failNext);
      }
      const deliveredAt = now().toISOString();
      const outcome: StoredRailOutcome = {
        delivered: true,
        deliveredAt,
      };
      outcomesByKey.set(key, { kind: "transfer", outcome, deliveredAt });
      records.push({
        kind: "transfer",
        applicationId: delivery.applicationId,
        sessionId: delivery.sessionId,
        channelSessionRef: delivery.channelSessionRef,
        channelEpoch: delivery.channelEpoch,
        routeClass: delivery.routeClass,
        idempotencyKey: delivery.idempotencyKey,
        responsePreview: delivery.responsePreview,
        cause: delivery.cause,
        at: deliveredAt,
      });
      return { ...outcome, replayed: false };
    },
    async closeSession(reference: {
      readonly applicationId: string;
      readonly sessionId: string;
      readonly channelSessionRef: string;
      readonly channelEpoch: number;
      readonly idempotencyKey: string;
      readonly cause: string | null;
    }): Promise<RealtimeRailDeliveryOutcome> {
      const key = `${reference.applicationId}:${reference.idempotencyKey}`;
      const existing = outcomesByKey.get(key);
      if (existing !== undefined && existing.kind === "close") {
        replays.push({
          kind: "close",
          idempotencyKey: reference.idempotencyKey,
          at: now().toISOString(),
        });
        return { ...existing.outcome, replayed: true };
      }
      if (failNext !== null) {
        return fail(failNext);
      }
      const deliveredAt = now().toISOString();
      const outcome: StoredRailOutcome = {
        delivered: true,
        deliveredAt,
      };
      outcomesByKey.set(key, { kind: "close", outcome, deliveredAt });
      records.push({
        kind: "close",
        applicationId: reference.applicationId,
        sessionId: reference.sessionId,
        channelSessionRef: reference.channelSessionRef,
        channelEpoch: reference.channelEpoch,
        routeClass: null,
        idempotencyKey: reference.idempotencyKey,
        responsePreview: null,
        cause: reference.cause,
        at: deliveredAt,
      });
      return { ...outcome, replayed: false };
    },
  };

  return {
    ...rail,
    get deliveries() {
      return records;
    },
    get replays() {
      return replays;
    },
    get openedSessions() {
      return opened;
    },
    failNextDelivery(reason: string) {
      failNext = reason;
    },
  };
}
