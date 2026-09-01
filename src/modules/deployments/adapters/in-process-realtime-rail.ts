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
  readonly responsePreview: string | null;
  readonly cause: string | null;
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
  /** Fail the NEXT delivery once (failure-injection). */
  failNextDelivery(reason: string): void;
  /** How many sessions the rail opened. */
  readonly openedSessions: number;
} {
  const records: SimulatedRailDeliveryRecord[] = [];
  const now = options.now ?? (() => new Date());
  let ordinal = 0;
  let opened = 0;
  let failNext: string | null = null;
  const allocateRef =
    options.allocateRef ??
    () => {
      ordinal += 1;
      return `simrail-session-${ordinal}`;
    };

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
      opened += 1;
      const channelSessionRef =
        request.channelSessionRef === null ? allocateRef() : request.channelSessionRef;
      records.push({
        kind: "open",
        applicationId: request.applicationId,
        sessionId: null,
        channelSessionRef,
        channelEpoch: 1,
        routeClass: null,
        responsePreview: null,
        cause: null,
        at: now().toISOString(),
      });
      return {
        channelSessionRef,
        channelEpoch: 1,
        railMetadata: {
          simulated: true,
          channelKind: request.channelKind,
          sessionPolicy: { ...request.sessionPolicy },
        },
      };
    },
    async deliverTurn(delivery: RealtimeRailDelivery): Promise<RealtimeRailDeliveryOutcome> {
      if (failNext !== null) {
        return fail(failNext);
      }
      records.push({
        kind: "deliver",
        applicationId: delivery.applicationId,
        sessionId: delivery.sessionId,
        channelSessionRef: delivery.channelSessionRef,
        channelEpoch: delivery.channelEpoch,
        routeClass: delivery.routeClass,
        responsePreview: delivery.responsePreview,
        cause: delivery.cause,
        at: now().toISOString(),
      });
      return {
        delivered: true,
        deliveredAt: now().toISOString(),
        railMetadata: { simulated: true, routeClass: delivery.routeClass },
      };
    },
    async transferCall(delivery: RealtimeRailDelivery): Promise<RealtimeRailDeliveryOutcome> {
      if (failNext !== null) {
        return fail(failNext);
      }
      records.push({
        kind: "transfer",
        applicationId: delivery.applicationId,
        sessionId: delivery.sessionId,
        channelSessionRef: delivery.channelSessionRef,
        channelEpoch: delivery.channelEpoch,
        routeClass: delivery.routeClass,
        responsePreview: delivery.responsePreview,
        cause: delivery.cause,
        at: now().toISOString(),
      });
      return { delivered: true, deliveredAt: now().toISOString() };
    },
    async closeSession(reference: {
      readonly applicationId: string;
      readonly sessionId: string;
      readonly channelSessionRef: string;
      readonly channelEpoch: number;
      readonly cause: string | null;
    }): Promise<RealtimeRailDeliveryOutcome> {
      if (failNext !== null) {
        return fail(failNext);
      }
      records.push({
        kind: "close",
        applicationId: reference.applicationId,
        sessionId: reference.sessionId,
        channelSessionRef: reference.channelSessionRef,
        channelEpoch: reference.channelEpoch,
        routeClass: null,
        responsePreview: null,
        cause: reference.cause,
        at: now().toISOString(),
      });
      return { delivered: true, deliveredAt: now().toISOString() };
    },
  };

  return {
    ...rail,
    get deliveries() {
      return records;
    },
    get openedSessions() {
      return opened;
    },
    failNextDelivery(reason: string) {
      failNext = reason;
    },
  };
}
