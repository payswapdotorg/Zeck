/**
 * The composition auto-rebind binding for the realtime rails
 * (deployments module adapter; PPR-013 — PPR-010's
 * explicitly-deferred residual).
 *
 * THE POLICY (the work order's authoritative semantics): a
 * composition-level rail preference + bounded failover BEHIND THE SAME
 * PORT. The preference derives from the environment through the two
 * existing materialization gates —
 *
 *   - LiveKit set materializes    ⇒ PREFERRED (PPR-009's primary rail)
 *   - socket.io set materializes  ⇒ ALTERNATE (PPR-010's alternate rail)
 *   - NOTHING materializes        ⇒ EXACTLY today's simulated terminal
 *                                  fallback (the in-process rail, the
 *                                  same neutral seam — pinned both ways)
 *
 * — with ZERO new environment variables and ZERO manifest changes: the
 * preference is DERIVED from the existing rails' materializations
 * (readLiveKitRailMaterialization / readSocketIoRailMaterialization
 * through the two established bindings).
 *
 * THE BOUNDED FAILOVER: per `openSession` invocation, on a RETRYABLE
 * NORMALIZED failure (a `PlatformError` with `retryable: true` — the
 * neutral failure vocabulary both real rails normalize onto) from the
 * preferred rail, at most ONE re-bind (preferred → alternate) under
 * the SAME coordinates and the SAME stable rail-level idempotency key
 * — the substitution drill's proven convergence (exactly-once per
 * rail, the drill's own invariant, not cross-rail dedupe). The
 * alternate's answer returns through the SAME neutral shapes,
 * unmodified. NON-retryable failures (authentication, not-found, and
 * every other non-retryable normalized class) NEVER re-bind — an
 * authentication failure is not a capacity event, and masking it
 * would violate the honest-failure discipline. When the alternate is
 * itself unmaterialized there is NO failover: the simulated rail is
 * NEVER a failover target (substituting a fake for a dead real rail
 * would mask the capacity event the same way).
 *
 * NO MID-SESSION FLAPPING: a session lives on the rail that opened
 * it. `deliverTurn` / `transferCall` / `closeSession` route through a
 * per-session affinity record (the channelSessionRef the OPEN
 * returned → the rail that produced it); only `openSession` may
 * re-bind, and each new open starts at the standing preference (the
 * preferred rail may have recovered — the policy is per-invocation,
 * never sticky). Honest boundary: the affinity record is in-memory
 * per binding instance — a frame for a ref this process never opened
 * (post-crash recovery of a session the previous process re-bound)
 * routes to the STANDING PREFERRED rail and fails neutrally there if
 * the preferred never saw that ref; the durable cross-rail ledger
 * that would close this boundary is PPR-009's recorded residual,
 * unchanged by this order.
 *
 * THE FROZEN-SEAM GUARANTEE: the session service, the port, and the
 * admission ordering (POLICY → CAPABILITY → BUDGET → SECRET MEDIATION
 * → adapter) are UNTOUCHED. The session service still calls ONE
 * `RealtimeRail`; this composition IS one, behind the same shapes.
 * The serving rail's own `railCapabilityId` is the honest disclosure:
 * the composed rail's descriptor names the rail that served the most
 * recent successful open (the standing preferred before any open),
 * and the binding-level observability (`servedBy`, `rebinds`) carries
 * the per-session truth in the same neutral vocabulary — no port
 * shape changed.
 */

import { PlatformError } from "../../../shared/errors";
import type {
  RealtimeRail,
  RealtimeRailDelivery,
  RealtimeRailDeliveryOutcome,
  RealtimeRailDescriptor,
  RealtimeRailSession,
  RealtimeRailSessionRequest,
} from "../ports/realtime-rail";
import type {
  LiveKitRailIdempotencyLedger,
  LiveKitRealtimeRailOptions,
} from "./livekit-realtime-rail";
import { bindEnvironmentRealtimeRail } from "./livekit-realtime-rail-binding";
import type {
  SocketIoRailIdempotencyLedger,
  SocketIoRealtimeRailOptions,
} from "./socketio-realtime-rail";
import { bindEnvironmentSocketIoRail } from "./socketio-realtime-rail-binding";

/** The materialized real rails the rebind policy knows, in bind order. */
export type RealtimeRebindRailKind = "livekit" | "socketio";

/** One bounded re-bind attempt, in the neutral vocabulary only. */
export interface RealtimeRailRebindEvent {
  /** The stable rail-level idempotency key of the re-bound open. */
  readonly idempotencyKey: string;
  /** The preferred rail's own neutral capability id. */
  readonly fromRailCapabilityId: string;
  /** The alternate rail's own neutral capability id. */
  readonly toRailCapabilityId: string;
  /** The preferred rail's neutral retryable failure reason (never a vendor string). */
  readonly reason: string;
}

/** The composed rail + the policy's observability surface. */
export interface RealtimeRailRebindComposition {
  /** The composition BEHIND the port — the session service's one rail. */
  readonly rail: RealtimeRail;
  /** The bounded re-bind attempts performed so far (at most one per open). */
  readonly rebinds: () => readonly RealtimeRailRebindEvent[];
  /** The rail capability id that opened one channelSessionRef (null when unknown). */
  readonly servedBy: (channelSessionRef: string) => string | null;
}

/** A retryable NORMALIZED failure: the only re-bind trigger. */
function isRetryableNormalizedFailure(error: unknown): error is PlatformError {
  return error instanceof PlatformError && error.retryable;
}

/**
 * Surface the ALTERNATE's normalized failure when both rails fail:
 * the alternate's code/message/retryability pass through unchanged
 * (it is the final serving attempt — the composed answer), with the
 * preferred's failure retained as the cause. Nothing is masked; the
 * neutral vocabulary is preserved exactly.
 */
function chainedAlternateFailure(alternateError: unknown, preferredError: unknown): unknown {
  if (!(alternateError instanceof PlatformError)) {
    return alternateError;
  }
  return new PlatformError({
    code: alternateError.code,
    message: alternateError.message,
    retryable: alternateError.retryable,
    ...(alternateError.details === undefined ? {} : { details: alternateError.details }),
    cause: preferredError,
  });
}

/**
 * Compose the bounded auto-rebind policy over the port contract.
 *
 * `preferred` is the standing preference every `openSession` starts
 * from; `alternate` (null when unmaterialized) is the ONE bounded
 * re-bind target. Port-level stubs are legitimate subjects for this
 * factory in tests — the POLICY codes against the port contract, and
 * the rails' own realism is proven by their conformance subjects.
 */
export function createRealtimeRailRebindComposition(options: {
  readonly preferred: RealtimeRail;
  /** The alternate for the ONE bounded re-bind (null ⇒ no re-bind possible). */
  readonly alternate: RealtimeRail | null;
}): RealtimeRailRebindComposition {
  const preferred = options.preferred;
  const alternate = options.alternate;
  /** Session affinity: the ref an open returned → the rail that opened it. */
  const sessionRails = new Map<string, RealtimeRail>();
  const rebindLog: RealtimeRailRebindEvent[] = [];
  /** The rail that served the most recent successful open (the descriptor's truth). */
  let serving = preferred;

  function railFor(channelSessionRef: string): RealtimeRail {
    // Known refs follow the rail that opened them (no mid-session
    // flapping); unknown refs follow the STANDING preferred rail —
    // the composition's declared binding, deterministic from the
    // environment (the in-memory-affinity boundary recorded above).
    return sessionRails.get(channelSessionRef) ?? preferred;
  }

  const rail: RealtimeRail = {
    get descriptor(): RealtimeRailDescriptor {
      return serving.descriptor;
    },
    async openSession(request: RealtimeRailSessionRequest): Promise<RealtimeRailSession> {
      try {
        const session = await preferred.openSession(request);
        serving = preferred;
        sessionRails.set(session.channelSessionRef, preferred);
        return session;
      } catch (preferredError) {
        if (alternate === null || !isRetryableNormalizedFailure(preferredError)) {
          // NON-retryable normalized failures, non-normalized escapes,
          // and the no-alternate case NEVER re-bind: the preferred's
          // own answer is the composed answer.
          throw preferredError;
        }
        // The ONE bounded re-bind: the SAME request object — the same
        // coordinates, the same stable idempotency key — against the
        // alternate (the drilled convergence: exactly-once per rail).
        rebindLog.push({
          idempotencyKey: request.idempotencyKey,
          fromRailCapabilityId: preferred.descriptor.railCapabilityId,
          toRailCapabilityId: alternate.descriptor.railCapabilityId,
          reason: preferredError.message,
        });
        try {
          const session = await alternate.openSession(request);
          serving = alternate;
          sessionRails.set(session.channelSessionRef, alternate);
          return session;
        } catch (alternateError) {
          throw chainedAlternateFailure(alternateError, preferredError);
        }
      }
    },
    async deliverTurn(delivery: RealtimeRailDelivery): Promise<RealtimeRailDeliveryOutcome> {
      return railFor(delivery.channelSessionRef).deliverTurn(delivery);
    },
    async transferCall(delivery: RealtimeRailDelivery): Promise<RealtimeRailDeliveryOutcome> {
      return railFor(delivery.channelSessionRef).transferCall(delivery);
    },
    async closeSession(reference: {
      readonly applicationId: string;
      readonly sessionId: string;
      readonly channelSessionRef: string;
      readonly channelEpoch: number;
      readonly idempotencyKey: string;
      readonly cause: string | null;
    }): Promise<RealtimeRailDeliveryOutcome> {
      return railFor(reference.channelSessionRef).closeSession(reference);
    },
  };

  return {
    rail,
    rebinds: () => [...rebindLog],
    servedBy: (channelSessionRef: string) =>
      sessionRails.get(channelSessionRef)?.descriptor.railCapabilityId ?? null,
  };
}

/** The resolved binding kind of the environment rebind gate. */
export type RealtimeRailRebindBindingKind =
  | "livekit+socketio"
  | "livekit"
  | "socketio"
  | "simulated";

export interface RealtimeRailRebindEnvironmentBinding {
  /** The bound rail — the composed rebind policy, or exactly today's simulated one. */
  readonly rail: RealtimeRail;
  readonly binding: RealtimeRailRebindBindingKind;
  /** The preferred rail's server URL (non-secret); null when that gate is unmaterialized. */
  readonly liveKitUrl: string | null;
  /** The alternate rail's listen coordinate (non-secret); null when that gate is unmaterialized. */
  readonly socketIoUrl: string | null;
  /** Which pieces were absent across BOTH gates (never which values were present). */
  readonly missing: readonly string[];
  /** True when the bound rail is REAL (a materialized rail serves; false only for the terminal fallback). */
  readonly isRealRail: boolean;
  /** The materialized rails in bind order (empty when simulated). */
  readonly preference: readonly RealtimeRebindRailKind[];
  /** The policy's bounded re-bind attempts (empty forever when simulated). */
  readonly rebinds: () => readonly RealtimeRailRebindEvent[];
  /** The rail capability id that opened one channelSessionRef (null when unknown/simulated). */
  readonly servedBy: (channelSessionRef: string) => string | null;
}

/**
 * Bind the environment's realtime rail WITH the composition auto-rebind
 * policy: the two existing materialization gates compose into a
 * preference (LiveKit preferred, socket.io alternate — zero new
 * environment variables), the composed rail serves behind the same
 * port with the bounded failover semantics above, and when NOTHING
 * materializes the binding returns EXACTLY today's simulated terminal
 * fallback (the in-process rail behind the same neutral seam, no
 * policy in effect — `rebinds` is empty forever).
 */
export function bindEnvironmentRealtimeRailWithRebind(
  env: Readonly<Record<string, string | undefined>>,
  options: {
    /** The neutral channel kinds the real bindings serve. */
    readonly channelKinds?: readonly string[];
    /** The preferred (LiveKit) binding's adapter-side idempotency ledger. */
    readonly liveKitLedger?: LiveKitRailIdempotencyLedger;
    /** The alternate (socket.io) binding's adapter-side idempotency ledger. */
    readonly socketIoLedger?: SocketIoRailIdempotencyLedger;
    /** Extra adapter options passthrough (clock; tests). */
    readonly now?: LiveKitRealtimeRailOptions["now"] & SocketIoRealtimeRailOptions["now"];
  } = {},
): RealtimeRailRebindEnvironmentBinding {
  const liveKitBinding = bindEnvironmentRealtimeRail(env, {
    channelKinds: options.channelKinds,
    ledger: options.liveKitLedger,
    now: options.now,
  });
  const socketIoBinding = bindEnvironmentSocketIoRail(env, {
    channelKinds: options.channelKinds,
    ledger: options.socketIoLedger,
    now: options.now,
  });
  const preferredLiveKit = liveKitBinding.isRealRail;
  const alternateSocketIo = socketIoBinding.isRealRail;
  // The union of both gates' absent pieces (the variable names are
  // disjoint, so the concat cannot duplicate).
  const missing = [...liveKitBinding.missing, ...socketIoBinding.missing];

  if (!preferredLiveKit && !alternateSocketIo) {
    // NOTHING materializes ⇒ EXACTLY today's simulated terminal
    // fallback: the same in-process rail today's composition gate
    // returns, no policy in effect (pinned both ways by the unit
    // proofs — the existing gates' own pins and this binding's).
    return {
      rail: liveKitBinding.rail,
      binding: "simulated",
      liveKitUrl: null,
      socketIoUrl: null,
      missing,
      isRealRail: false,
      preference: [],
      rebinds: () => [],
      servedBy: () => null,
    };
  }

  const preference: RealtimeRebindRailKind[] = [];
  if (preferredLiveKit) {
    preference.push("livekit");
  }
  if (alternateSocketIo) {
    preference.push("socketio");
  }
  const composition = createRealtimeRailRebindComposition({
    preferred: preferredLiveKit ? liveKitBinding.rail : socketIoBinding.rail,
    // The alternate participates ONLY when it MATERIALIZED: the
    // unmaterialized socket.io binding's rail is the simulated fake,
    // and a fake is never a failover target.
    alternate: preferredLiveKit && alternateSocketIo ? socketIoBinding.rail : null,
  });
  return {
    rail: composition.rail,
    binding:
      preferredLiveKit && alternateSocketIo
        ? "livekit+socketio"
        : preferredLiveKit
          ? "livekit"
          : "socketio",
    liveKitUrl: liveKitBinding.liveKitUrl,
    socketIoUrl: socketIoBinding.socketIoUrl,
    missing,
    isRealRail: true,
    preference,
    rebinds: composition.rebinds,
    servedBy: composition.servedBy,
  };
}
