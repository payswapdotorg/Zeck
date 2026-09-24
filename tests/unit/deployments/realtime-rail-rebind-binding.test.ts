/**
 * The composition auto-rebind policy's unit proofs (PPR-013
 * verification — PPR-010's explicitly-deferred residual).
 *
 * Port-level stubs are the legitimate subject for the POLICY proofs:
 * the policy codes against the `RealtimeRail` port contract, and the
 * rails' own realism is already proven by their conformance subjects
 * (simulated + livekit + socketio through ONE contract) and the
 * substitution drill. One proof additionally composes the REAL rails
 * (a dead preferred LiveKit endpoint + the REAL embedded socket.io
 * server) through the policy seam.
 *
 * No credential VALUES are committed: every fixture below is the
 * repository's synthetic style.
 */

import { describe, expect, test } from "vitest";
import {
  createEnvironmentLiveKitCredentialSource,
  createLiveKitRealtimeRail,
  LIVEKIT_RAIL_CAPABILITY_ID,
} from "../../../src/modules/deployments/adapters/livekit-realtime-rail";
import {
  bindEnvironmentRealtimeRail,
  LIVEKIT_RAIL_ENV_VARIABLES,
} from "../../../src/modules/deployments/adapters/livekit-realtime-rail-binding";
import {
  bindEnvironmentRealtimeRailWithRebind,
  createRealtimeRailRebindComposition,
  type RealtimeRailRebindEvent,
} from "../../../src/modules/deployments/adapters/realtime-rail-rebind-binding";
import {
  createEnvironmentSocketIoCredentialSource,
  createSocketIoRealtimeRail,
  SOCKETIO_RAIL_CAPABILITY_ID,
} from "../../../src/modules/deployments/adapters/socketio-realtime-rail";
import { SOCKETIO_RAIL_ENV_VARIABLES } from "../../../src/modules/deployments/adapters/socketio-realtime-rail-binding";
import {
  realtimeRailCloseKey,
  realtimeRailDeliverKey,
  realtimeRailOpenKey,
} from "../../../src/modules/deployments/domain/realtime";
import type {
  RealtimeRail,
  RealtimeRailDelivery,
  RealtimeRailSession,
  RealtimeRailSessionRequest,
} from "../../../src/modules/deployments/ports/realtime-rail";
import { PlatformError } from "../../../src/shared/errors";

const SYNTHETIC_API_KEY = "sk-livekit-synthetic-unit-key";
const SYNTHETIC_API_SECRET = "sk-livekit-synthetic-unit-secret";
const SYNTHETIC_SOCKETIO_SECRET = "sk-socketio-synthetic-unit-secret";

const APPLICATION_ID = "00000000-0000-7000-8000-000000000031";

function materializedEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    [LIVEKIT_RAIL_ENV_VARIABLES.url]: "http://127.0.0.1:7880",
    [LIVEKIT_RAIL_ENV_VARIABLES.apiKey]: SYNTHETIC_API_KEY,
    [LIVEKIT_RAIL_ENV_VARIABLES.apiSecret]: SYNTHETIC_API_SECRET,
    [SOCKETIO_RAIL_ENV_VARIABLES.url]: "http://127.0.0.1:3999",
    [SOCKETIO_RAIL_ENV_VARIABLES.authSecret]: SYNTHETIC_SOCKETIO_SECRET,
    ...overrides,
  };
}

function openRequest(idempotencyKey: string): RealtimeRailSessionRequest {
  return {
    applicationId: APPLICATION_ID,
    tenantId: "00000000-0000-7000-8000-000000000032",
    deploymentId: "00000000-0000-7000-8000-000000000033",
    pinnedPlanId: "00000000-0000-7000-8000-000000000034",
    pinnedPlanVersion: 1,
    executionId: "00000000-0000-7000-8000-000000000035",
    channelKind: "web",
    idempotencyKey,
    channelSessionRef: null,
    callerRef: "unit-caller-ref",
    sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 4 },
  };
}

function deliveryFrame(
  sessionId: string,
  channelSessionRef: string,
  idempotencyKey: string,
): RealtimeRailDelivery {
  return {
    applicationId: APPLICATION_ID,
    sessionId,
    channelSessionRef,
    channelEpoch: 1,
    routeClass: "generative",
    idempotencyKey,
    responseRef: "artifact://realtime/turns/rebind-unit-1",
    responsePreview: "bounded unit preview",
    cause: "unit delivery",
  };
}

/** A port-level stub rail with the stable-key convergence semantics. */
function createStubRail(railCapabilityId: string) {
  const state = {
    opens: [] as RealtimeRailSessionRequest[],
    deliverFrames: [] as RealtimeRailDelivery[],
    transferFrames: [] as RealtimeRailDelivery[],
    closeReferences: [] as { readonly channelSessionRef: string }[],
    /** First-effect opens (the exactly-once observable). */
    firstEffectOpens: 0,
    openFailure: null as PlatformError | null,
  };
  const remembered = new Map<string, RealtimeRailSession>();
  const rail: RealtimeRail = {
    descriptor: {
      railCapabilityId,
      channelKinds: ["web"],
      transportClass: "realtime",
    },
    async openSession(request: RealtimeRailSessionRequest): Promise<RealtimeRailSession> {
      state.opens.push(request);
      if (state.openFailure !== null) {
        throw state.openFailure;
      }
      const ledgerKey = `${request.applicationId}:${request.idempotencyKey}`;
      const prior = remembered.get(ledgerKey);
      if (prior !== undefined) {
        return { ...prior, replayed: true };
      }
      state.firstEffectOpens += 1;
      const session: RealtimeRailSession = {
        channelSessionRef: `${railCapabilityId}:session:${request.idempotencyKey}`,
        channelEpoch: 1,
        railMetadata: { railCapabilityId },
        replayed: false,
      };
      remembered.set(ledgerKey, session);
      return session;
    },
    async deliverTurn(delivery: RealtimeRailDelivery) {
      state.deliverFrames.push(delivery);
      return { delivered: true, deliveredAt: "2026-09-23T00:00:00.000Z", replayed: false };
    },
    async transferCall(delivery: RealtimeRailDelivery) {
      state.transferFrames.push(delivery);
      return { delivered: true, deliveredAt: "2026-09-23T00:00:00.000Z", replayed: false };
    },
    async closeSession(reference: {
      readonly channelSessionRef: string;
      readonly idempotencyKey: string;
    }) {
      state.closeReferences.push(reference);
      return { delivered: true, deliveredAt: "2026-09-23T00:00:00.000Z", replayed: false };
    },
  };
  return { rail, state };
}

const RETRYABLE_UNREACHABLE = () =>
  new PlatformError({
    code: "CAPABILITY_UNAVAILABLE",
    message: "realtime rail upstream unreachable",
    retryable: true,
  });

const NON_RETRYABLE_AUTHENTICATION = () =>
  new PlatformError({
    code: "AUTHENTICATION_FAILED",
    message: "realtime rail credential rejected by the upstream",
    retryable: false,
  });

describe("realtime rail rebind binding — the preference resolution (derived, zero new variables)", () => {
  test("BOTH gates materialize ⇒ livekit preferred, socket.io alternate", () => {
    const binding = bindEnvironmentRealtimeRailWithRebind(materializedEnv());
    expect(binding.binding).toBe("livekit+socketio");
    expect(binding.isRealRail).toBe(true);
    expect(binding.preference).toEqual(["livekit", "socketio"]);
    expect(binding.liveKitUrl).toBe("http://127.0.0.1:7880");
    expect(binding.socketIoUrl).toBe("http://127.0.0.1:3999");
    expect(binding.missing).toEqual([]);
    // The standing preference is disclosed through the serving rail's
    // own neutral capability id — no shape change.
    expect(binding.rail.descriptor.railCapabilityId).toBe(LIVEKIT_RAIL_CAPABILITY_ID);
  });

  test("ONLY the LiveKit gate materializes ⇒ real preferred, NO alternate (no rebind possible)", () => {
    const binding = bindEnvironmentRealtimeRailWithRebind(
      materializedEnv({
        [SOCKETIO_RAIL_ENV_VARIABLES.url]: undefined,
        [SOCKETIO_RAIL_ENV_VARIABLES.authSecret]: undefined,
      }),
    );
    expect(binding.binding).toBe("livekit");
    expect(binding.preference).toEqual(["livekit"]);
    expect(binding.socketIoUrl).toBeNull();
    expect(binding.missing).toEqual([
      SOCKETIO_RAIL_ENV_VARIABLES.url,
      SOCKETIO_RAIL_ENV_VARIABLES.authSecret,
    ]);
    expect(binding.rail.descriptor.railCapabilityId).toBe(LIVEKIT_RAIL_CAPABILITY_ID);
  });

  test("ONLY the socket.io gate materializes ⇒ the alternate stands alone as the preferred", () => {
    const binding = bindEnvironmentRealtimeRailWithRebind(
      materializedEnv({
        [LIVEKIT_RAIL_ENV_VARIABLES.url]: undefined,
        [LIVEKIT_RAIL_ENV_VARIABLES.apiKey]: undefined,
        [LIVEKIT_RAIL_ENV_VARIABLES.apiSecret]: undefined,
      }),
    );
    expect(binding.binding).toBe("socketio");
    expect(binding.preference).toEqual(["socketio"]);
    expect(binding.liveKitUrl).toBeNull();
    expect(binding.missing).toEqual([
      LIVEKIT_RAIL_ENV_VARIABLES.url,
      LIVEKIT_RAIL_ENV_VARIABLES.apiKey,
      LIVEKIT_RAIL_ENV_VARIABLES.apiSecret,
    ]);
    expect(binding.rail.descriptor.railCapabilityId).toBe(SOCKETIO_RAIL_CAPABILITY_ID);
  });

  test("NOTHING materializes ⇒ EXACTLY today's simulated terminal fallback (pinned both ways)", async () => {
    const binding = bindEnvironmentRealtimeRailWithRebind({});
    expect(binding.binding).toBe("simulated");
    expect(binding.isRealRail).toBe(false);
    expect(binding.liveKitUrl).toBeNull();
    expect(binding.socketIoUrl).toBeNull();
    expect(binding.preference).toEqual([]);
    expect(binding.missing).toEqual([
      LIVEKIT_RAIL_ENV_VARIABLES.url,
      LIVEKIT_RAIL_ENV_VARIABLES.apiKey,
      LIVEKIT_RAIL_ENV_VARIABLES.apiSecret,
      SOCKETIO_RAIL_ENV_VARIABLES.url,
      SOCKETIO_RAIL_ENV_VARIABLES.authSecret,
    ]);
    // No policy is in effect on the terminal fallback — forever.
    expect(binding.rebinds()).toEqual([]);
    expect(binding.servedBy("any-ref")).toBeNull();
    // The rail IS today's simulated rail: same neutral identity, same
    // observable semantics as the existing composition gate's fallback.
    const today = bindEnvironmentRealtimeRail({});
    expect(binding.rail.descriptor).toEqual(today.rail.descriptor);
    expect(binding.rail.descriptor.railCapabilityId).toBe("simulated-realtime-rail");
    const key = realtimeRailOpenKey("rebind-unit-terminal-1");
    const session = await binding.rail.openSession(openRequest(key));
    expect(session.replayed).toBe(false);
    const replay = await binding.rail.openSession(openRequest(key));
    expect(replay.replayed).toBe(true);
    expect(replay.channelSessionRef).toBe(session.channelSessionRef);
    const delivered = await binding.rail.deliverTurn(
      deliveryFrame(
        "session-unit-terminal",
        session.channelSessionRef,
        realtimeRailDeliverKey("rebind-unit-terminal-1"),
      ),
    );
    expect(delivered.delivered).toBe(true);
    const closed = await binding.rail.closeSession({
      applicationId: APPLICATION_ID,
      sessionId: "session-unit-terminal",
      channelSessionRef: session.channelSessionRef,
      channelEpoch: session.channelEpoch,
      idempotencyKey: realtimeRailCloseKey("rebind-unit-terminal-1"),
      cause: "unit terminal fallback",
    });
    expect(closed.delivered).toBe(true);
  });

  test("the binding never echoes credential values (secret hygiene)", () => {
    const binding = bindEnvironmentRealtimeRailWithRebind(materializedEnv());
    const serialized = JSON.stringify({
      binding: binding.binding,
      liveKitUrl: binding.liveKitUrl,
      socketIoUrl: binding.socketIoUrl,
      missing: binding.missing,
      preference: binding.preference,
    });
    expect(serialized).not.toContain(SYNTHETIC_API_KEY);
    expect(serialized).not.toContain(SYNTHETIC_API_SECRET);
    expect(serialized).not.toContain(SYNTHETIC_SOCKETIO_SECRET);
  });
});

describe("realtime rail rebind binding — the bounded failover (the policy proofs)", () => {
  test("a RETRYABLE normalized open failure re-binds ONCE under the SAME coordinates + key, with the alternate's railCapabilityId disclosed", async () => {
    const preferred = createStubRail("stub-preferred-rail");
    const alternate = createStubRail("stub-alternate-rail");
    const { rail, rebinds, servedBy } = createRealtimeRailRebindComposition({
      preferred: preferred.rail,
      alternate: alternate.rail,
    });
    preferred.state.openFailure = RETRYABLE_UNREACHABLE();

    const request = openRequest(realtimeRailOpenKey("rebind-unit-open-1"));
    const session = await rail.openSession(request);

    // The SAME request object (the same coordinates, the same stable
    // key) reached BOTH rails — the drilled substitution invariant.
    expect(preferred.state.opens[0]).toBe(request);
    expect(alternate.state.opens[0]).toBe(request);
    expect(preferred.state.opens).toHaveLength(1);
    expect(alternate.state.opens).toHaveLength(1);

    // The alternate's answer passes through UNMODIFIED.
    expect(session.channelSessionRef).toBe(`stub-alternate-rail:session:${request.idempotencyKey}`);
    expect(session.railMetadata).toEqual({ railCapabilityId: "stub-alternate-rail" });

    // The serving rail's own capability id is the honest disclosure.
    expect(rail.descriptor.railCapabilityId).toBe("stub-alternate-rail");
    expect(servedBy(session.channelSessionRef)).toBe("stub-alternate-rail");

    // EXACTLY ONE re-bind, in the neutral vocabulary only.
    const events: readonly RealtimeRailRebindEvent[] = rebinds();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      idempotencyKey: request.idempotencyKey,
      fromRailCapabilityId: "stub-preferred-rail",
      toRailCapabilityId: "stub-alternate-rail",
      reason: "realtime rail upstream unreachable",
    });
  });

  test("re-opening under the SAME key converges on the alternate (exactly-once per rail, replayed)", async () => {
    const preferred = createStubRail("stub-preferred-rail");
    const alternate = createStubRail("stub-alternate-rail");
    const { rail } = createRealtimeRailRebindComposition({
      preferred: preferred.rail,
      alternate: alternate.rail,
    });
    preferred.state.openFailure = RETRYABLE_UNREACHABLE();

    const key = realtimeRailOpenKey("rebind-unit-converge-1");
    const first = await rail.openSession(openRequest(key));
    expect(first.replayed).toBe(false);
    const replay = await rail.openSession(openRequest(key));
    expect(replay.replayed).toBe(true);
    expect(replay.channelSessionRef).toBe(first.channelSessionRef);
    // Exactly ONE first effect on the alternate (its own ledger
    // converged the replay); the preferred performed zero effects.
    expect(alternate.state.firstEffectOpens).toBe(1);
    expect(preferred.state.firstEffectOpens).toBe(0);
    // The policy is per-invocation: the re-open started at the
    // (still-failing) preferred and re-bound again — bounded, honest.
    expect(preferred.state.opens).toHaveLength(2);
    expect(alternate.state.opens).toHaveLength(2);
  });

  test("NON-retryable normalized failures NEVER re-bind (authentication)", async () => {
    const preferred = createStubRail("stub-preferred-rail");
    const alternate = createStubRail("stub-alternate-rail");
    const { rail, rebinds } = createRealtimeRailRebindComposition({
      preferred: preferred.rail,
      alternate: alternate.rail,
    });
    const failure = NON_RETRYABLE_AUTHENTICATION();
    preferred.state.openFailure = failure;

    const rejected = await rail
      .openSession(openRequest(realtimeRailOpenKey("rebind-unit-auth-1")))
      .then(
        () => null,
        (error: unknown) => error,
      );
    // The preferred's own failure IS the composed answer — unmasked.
    expect(rejected).toBe(failure);
    expect(alternate.state.opens).toHaveLength(0);
    expect(rebinds()).toEqual([]);
    expect(rail.descriptor.railCapabilityId).toBe("stub-preferred-rail");
  });

  test("NON-retryable normalized failures NEVER re-bind (not-found)", async () => {
    const preferred = createStubRail("stub-preferred-rail");
    const alternate = createStubRail("stub-alternate-rail");
    const { rail, rebinds } = createRealtimeRailRebindComposition({
      preferred: preferred.rail,
      alternate: alternate.rail,
    });
    const failure = new PlatformError({
      code: "PROVIDER_ERROR",
      message: "realtime rail channel not found upstream",
      retryable: false,
    });
    preferred.state.openFailure = failure;

    const rejected = await rail
      .openSession(openRequest(realtimeRailOpenKey("rebind-unit-notfound-1")))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(rejected).toBe(failure);
    expect(alternate.state.opens).toHaveLength(0);
    expect(rebinds()).toEqual([]);
  });

  test("a NON-normalized escape never re-binds (only normalized failures trigger the policy)", async () => {
    const preferred = createStubRail("stub-preferred-rail");
    const alternate = createStubRail("stub-alternate-rail");
    const { rail, rebinds } = createRealtimeRailRebindComposition({
      preferred: preferred.rail,
      alternate: alternate.rail,
    });
    const failure = new Error("a raw, non-normalized escape");
    preferred.state.openFailure = failure as PlatformError;

    const rejected = await rail
      .openSession(openRequest(realtimeRailOpenKey("rebind-unit-raw-1")))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(rejected).toBe(failure);
    expect(alternate.state.opens).toHaveLength(0);
    expect(rebinds()).toEqual([]);
  });

  test("the ONE-rebind bound: when the alternate also fails, its normalized failure surfaces with the preferred's retained as the cause", async () => {
    const preferred = createStubRail("stub-preferred-rail");
    const alternate = createStubRail("stub-alternate-rail");
    const { rail, rebinds } = createRealtimeRailRebindComposition({
      preferred: preferred.rail,
      alternate: alternate.rail,
    });
    const preferredFailure = RETRYABLE_UNREACHABLE();
    const alternateFailure = NON_RETRYABLE_AUTHENTICATION();
    preferred.state.openFailure = preferredFailure;
    alternate.state.openFailure = alternateFailure;

    const rejected = await rail
      .openSession(openRequest(realtimeRailOpenKey("rebind-unit-double-1")))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(rejected).toBeInstanceOf(PlatformError);
    const surfaced = rejected as PlatformError;
    // The ALTERNATE's normalized answer is the composed answer...
    expect(surfaced.code).toBe(alternateFailure.code);
    expect(surfaced.message).toBe(alternateFailure.message);
    expect(surfaced.retryable).toBe(alternateFailure.retryable);
    // ...with the preferred's failure retained, nothing masked.
    expect(surfaced.cause).toBe(preferredFailure);
    // The bound held: exactly one attempt per rail, no loops.
    expect(preferred.state.opens).toHaveLength(1);
    expect(alternate.state.opens).toHaveLength(1);
    expect(rebinds()).toHaveLength(1);
  });

  test("a retryable failure with NO alternate surfaces the preferred's own failure (no simulated failover target)", async () => {
    const preferred = createStubRail("stub-preferred-rail");
    const { rail, rebinds } = createRealtimeRailRebindComposition({
      preferred: preferred.rail,
      alternate: null,
    });
    const failure = RETRYABLE_UNREACHABLE();
    preferred.state.openFailure = failure;

    const rejected = await rail
      .openSession(openRequest(realtimeRailOpenKey("rebind-unit-noalt-1")))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(rejected).toBe(failure);
    expect(rebinds()).toEqual([]);
  });
});

describe("realtime rail rebind binding — no mid-session flapping (the session-affinity rule)", () => {
  test("deliverTurn/transferCall/closeSession follow the rail that opened the session — never flap mid-session", async () => {
    const preferred = createStubRail("stub-preferred-rail");
    const alternate = createStubRail("stub-alternate-rail");
    const { rail, servedBy } = createRealtimeRailRebindComposition({
      preferred: preferred.rail,
      alternate: alternate.rail,
    });

    // Session one opens on the preferred (healthy).
    const first = await rail.openSession(openRequest(realtimeRailOpenKey("rebind-unit-flap-1")));
    expect(servedBy(first.channelSessionRef)).toBe("stub-preferred-rail");

    // The preferred then fails retryably; session two re-binds.
    preferred.state.openFailure = RETRYABLE_UNREACHABLE();
    const second = await rail.openSession(openRequest(realtimeRailOpenKey("rebind-unit-flap-2")));
    expect(servedBy(second.channelSessionRef)).toBe("stub-alternate-rail");

    // Session one's frames STILL follow the preferred (the rail that
    // opened it); session two's follow the alternate. No flapping.
    await rail.deliverTurn(
      deliveryFrame(
        "session-unit-1",
        first.channelSessionRef,
        realtimeRailDeliverKey("rebind-unit-flap-1"),
      ),
    );
    await rail.deliverTurn(
      deliveryFrame(
        "session-unit-2",
        second.channelSessionRef,
        realtimeRailDeliverKey("rebind-unit-flap-2"),
      ),
    );
    expect(preferred.state.deliverFrames.map((frame) => frame.channelSessionRef)).toEqual([
      first.channelSessionRef,
    ]);
    expect(alternate.state.deliverFrames.map((frame) => frame.channelSessionRef)).toEqual([
      second.channelSessionRef,
    ]);

    await rail.transferCall(
      deliveryFrame(
        "session-unit-1",
        first.channelSessionRef,
        realtimeRailDeliverKey("rebind-unit-flap-1t"),
      ),
    );
    expect(preferred.state.transferFrames).toHaveLength(1);
    expect(alternate.state.transferFrames).toHaveLength(0);

    await rail.closeSession({
      applicationId: APPLICATION_ID,
      sessionId: "session-unit-1",
      channelSessionRef: first.channelSessionRef,
      channelEpoch: first.channelEpoch,
      idempotencyKey: realtimeRailCloseKey("rebind-unit-flap-1"),
      cause: "unit close",
    });
    await rail.closeSession({
      applicationId: APPLICATION_ID,
      sessionId: "session-unit-2",
      channelSessionRef: second.channelSessionRef,
      channelEpoch: second.channelEpoch,
      idempotencyKey: realtimeRailCloseKey("rebind-unit-flap-2"),
      cause: "unit close",
    });
    expect(preferred.state.closeReferences.map((ref) => ref.channelSessionRef)).toEqual([
      first.channelSessionRef,
    ]);
    expect(alternate.state.closeReferences.map((ref) => ref.channelSessionRef)).toEqual([
      second.channelSessionRef,
    ]);
  });

  test("a frame for a ref this process never opened follows the STANDING preferred (the in-memory-affinity boundary)", async () => {
    const preferred = createStubRail("stub-preferred-rail");
    const alternate = createStubRail("stub-alternate-rail");
    const { rail } = createRealtimeRailRebindComposition({
      preferred: preferred.rail,
      alternate: alternate.rail,
    });
    await rail.deliverTurn(
      deliveryFrame(
        "session-unit-unknown",
        "a-ref-never-opened-here",
        realtimeRailDeliverKey("rebind-unit-unknown-1"),
      ),
    );
    expect(preferred.state.deliverFrames).toHaveLength(1);
    expect(alternate.state.deliverFrames).toHaveLength(0);
  });
});

describe("realtime rail rebind binding — the policy seam over the REAL rails", () => {
  test("a dead preferred LiveKit endpoint re-binds ONCE onto the REAL embedded socket.io rail and serves the session there", {
    timeout: 20_000,
  }, async () => {
    const preferredRail = createLiveKitRealtimeRail({
      serverUrl: "http://127.0.0.1:1",
      credentialSource: createEnvironmentLiveKitCredentialSource({
        reference: "unit-synthetic-livekit-credential",
        connectionId: "unit-livekit-rebind",
        apiKey: SYNTHETIC_API_KEY,
        apiSecret: SYNTHETIC_API_SECRET,
      }),
      requestTimeoutSeconds: 2,
    });
    const alternateRail = createSocketIoRealtimeRail({
      listenUrl: "http://127.0.0.1:0",
      credentialSource: createEnvironmentSocketIoCredentialSource({
        reference: "unit-synthetic-socketio-credential",
        connectionId: "unit-socketio-rebind",
        authSecret: SYNTHETIC_SOCKETIO_SECRET,
      }),
      requestTimeoutMs: 1_500,
    });
    const { rail, rebinds, servedBy } = createRealtimeRailRebindComposition({
      preferred: preferredRail,
      alternate: alternateRail,
    });
    try {
      const session = await rail.openSession(
        openRequest(realtimeRailOpenKey("rebind-unit-real-1")),
      );
      // Converged on the REAL socket.io rail (its own channel-session
      // ref grammar), with the re-bind disclosed in the neutral
      // vocabulary.
      expect(session.replayed).toBe(false);
      expect(servedBy(session.channelSessionRef)).toBe(SOCKETIO_RAIL_CAPABILITY_ID);
      expect(rail.descriptor.railCapabilityId).toBe(SOCKETIO_RAIL_CAPABILITY_ID);
      expect(rebinds()).toEqual([
        {
          idempotencyKey: realtimeRailOpenKey("rebind-unit-real-1"),
          fromRailCapabilityId: LIVEKIT_RAIL_CAPABILITY_ID,
          toRailCapabilityId: SOCKETIO_RAIL_CAPABILITY_ID,
          reason: "realtime rail upstream unreachable",
        },
      ]);
      // The session serves (and closes) on the rail that opened it.
      const delivered = await rail.deliverTurn(
        deliveryFrame(
          "session-unit-real",
          session.channelSessionRef,
          realtimeRailDeliverKey("rebind-unit-real-1"),
        ),
      );
      expect(delivered.delivered).toBe(true);
      const closed = await rail.closeSession({
        applicationId: APPLICATION_ID,
        sessionId: "session-unit-real",
        channelSessionRef: session.channelSessionRef,
        channelEpoch: session.channelEpoch,
        idempotencyKey: realtimeRailCloseKey("rebind-unit-real-1"),
        cause: "unit real-rail rebind proof",
      });
      expect(closed.delivered).toBe(true);
    } finally {
      await alternateRail.close();
    }
  });
});
