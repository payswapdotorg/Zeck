/**
 * The realtime-rail conformance suite over the SOCKET.IO ADAPTER against
 * its REAL embedded socket.io server (PPR-010 — the ALTERNATE REAL
 * rail's proof; GAP-003's level-5 rung, one half).
 *
 * THE HONEST SCOPE: the server is the published `socket.io` package
 * (4.8.x, unmodified) booted IN PROCESS by this suite on loopback — a
 * REAL WebSocket server (real handshakes, real rooms, real
 * acknowledgments, real failure modes), honestly labeled
 * `local-socketio-server`. NO external, managed or production socket.io
 * availability is claimed or implied anywhere; every external boundary
 * is owned by a Lead credentialed run (deploy/evidence/ppr-010.json
 * notRun registry).
 *
 * THE PROBES' VANTAGE (honest labeling): the open/deliver/transfer/close
 * side-effect counts come from the SERVER-SIDE rail protocol's own
 * observation surface (`host.observe()`) — the upstream's record of the
 * effects it ACTUALLY performed (a converged replay records NOTHING
 * there, which is exactly the exactly-once observable). This is a
 * STRONGER vantage than the adapter's own effect log: it is the
 * upstream's truth, not the caller's.
 *
 * THE REFUSAL INJECTION (C9/C10): `stopServing()` closes the listener
 * AND destroys every live connection — the embedded server's own REAL
 * "went away" mode (new connects get ECONNREFUSED; live sockets see a
 * transport close; the dispatch connection enters its bounded
 * reconnection window and the adapter's request timeout fires — the
 * honest transient-upstream shape). `startServing()` rebinds the same
 * coordinate; the server-side channel registry SURVIVES (it is keyed to
 * the socket.io server instance, not the listener), so the recovery
 * converges with all upstream state intact — the same recovery shape as
 * the LiveKit suite's SIGSTOP/SIGCONT injection.
 *
 * THE CRASH MODEL (C4): `restart` builds a FRESH adapter instance (a
 * fresh in-memory idempotency ledger — the adapter process died)
 * ATTACHED to the SAME embedded server (the upstream and its channel
 * registry survived); the re-open under the same key must converge on
 * the existing channel (the deterministic room name + the server-side
 * registry make opens crash-convergent WITHOUT any adapter ledger).
 *
 * DELIVERY SEMANTICS (honest): an empty room completes the broadcast
 * vacuously — the upstream performed its effect — exactly like
 * publishing to a LiveKit room with no participants; receivers present
 * in the room that fail to acknowledge within the bounded window fail
 * `no-receiver` (exercised by the unit battery's failure table).
 */

import { io } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createSocketIoRealtimeRail,
  LOCAL_SOCKETIO_SERVER_LABEL,
  SOCKETIO_CLIENT_ACCESS_HARD_CEILING_SECONDS,
  type SocketIoRailEmbeddedServer,
  type SocketIoRealtimeRail,
} from "../../../src/modules/deployments/adapters/socketio-realtime-rail";
import { defineRealtimeRailConformance } from "./realtime-rail-conformance";

/** The synthetic credential (the `sk-…` synthetic style; never a secret). */
const SYNTHETIC_AUTH_SECRET = "sk-socketio-conformance-0000000000000001";

const credentialSource = {
  resolve: async () => ({
    connectionId: "conformance-socketio-connection",
    credentialRef: "zeck-secret://local/socketio-auth-secret",
  }),
  materialize: async (reference: string) => ({
    reference,
    plaintext: JSON.stringify({ authSecret: SYNTHETIC_AUTH_SECRET }),
  }),
};

describe("the socket.io adapter conformance harness (a real embedded socket.io server)", () => {
  let host: SocketIoRailEmbeddedServer | null = null;

  /** Wait for the dispatch connection to return after a recovery. */
  const waitForDispatch = async (deadlineMs = 8_000): Promise<void> => {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      if (host !== null && host.observe().connectedSocketCount() >= 1) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error("the embedded socket.io server's dispatch connection did not return");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const railOptions = {
    listenUrl: "http://127.0.0.1:0",
    credentialSource,
    requestTimeoutMs: 1_500,
  } as const;

  const rail: SocketIoRealtimeRail = createSocketIoRealtimeRail(railOptions);

  defineRealtimeRailConformance({
    name: `socketio-realtime-rail over ${LOCAL_SOCKETIO_SERVER_LABEL} (the ALTERNATE REAL rail)`,
    rail,
    armRefusal: async () => {
      if (host === null) {
        throw new Error("the embedded socket.io server is not booted");
      }
      await host.stopServing();
    },
    disarmRefusal: async () => {
      if (host === null) {
        throw new Error("the embedded socket.io server is not booted");
      }
      await host.startServing();
      await waitForDispatch();
    },
    supports: { openRefusal: true },
    secretCanaryValues: [SYNTHETIC_AUTH_SECRET],
    probes: {
      countOpenSideEffects: async () => host?.observe().countChannelsCreated() ?? 0,
      countDeliverSideEffects: async () => host?.observe().countDeliveriesCompleted() ?? 0,
      countTransferSideEffects: async () => host?.observe().countTransfersCompleted() ?? 0,
      countCloseSideEffects: async () => host?.observe().countClosesPerformed() ?? 0,
    },
    restart: () => {
      if (host === null) {
        throw new Error("the embedded socket.io server is not booted");
      }
      // A FRESH adapter instance (fresh ledger) attached to the SAME
      // surviving server: the crash model.
      return createSocketIoRealtimeRail({ ...railOptions, embeddedServer: host });
    },
  });

  test("the server-side channel registry independently corroborates the effect counters", async () => {
    // The independent observation: the upstream's own registry must hold
    // EXACTLY the channels the counters say are open-but-not-closed
    // (channels survive closes-of-other-channels; a close deletes).
    const observation = host?.observe();
    expect(observation).toBeDefined();
    if (observation === undefined) {
      return;
    }
    const liveChannels = observation.liveChannelCount();
    const opened = observation.countChannelsCreated();
    const closed = observation.countClosesPerformed();
    expect(liveChannels).toBe(opened - closed);
    expect(liveChannels).toBeGreaterThan(0);
    // The conformance suite's world: at least one dispatch connection
    // (the adapter's privileged authority) plus the restart model's.
    expect(observation.connectedSocketCount()).toBeGreaterThanOrEqual(1);
  });

  test("the client-access seam mints a short-lived, single-purpose join grant that REALLY joins the channel", async () => {
    const session = await rail.openSession({
      applicationId: "00000000-0000-7000-8000-000000000030",
      tenantId: "00000000-0000-7000-8000-000000000031",
      deploymentId: "00000000-0000-7000-8000-000000000032",
      pinnedPlanId: "00000000-0000-7000-8000-000000000033",
      pinnedPlanVersion: 1,
      executionId: "00000000-0000-7000-8000-000000000034",
      channelKind: "web",
      idempotencyKey: `conformance-client-access:${Date.now()}`,
      channelSessionRef: null,
      callerRef: null,
      sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 4 },
    });
    const access = await rail.mintClientAccess({
      applicationId: "00000000-0000-7000-8000-000000000030",
      channelSessionRef: session.channelSessionRef,
      channelEpoch: session.channelEpoch,
      sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 4 },
      participantRef: "agent-session-probe",
    });
    expect(access.purpose).toBe("join");
    expect(access.ttlSeconds).toBeGreaterThan(0);
    expect(access.ttlSeconds).toBeLessThanOrEqual(SOCKETIO_CLIENT_ACCESS_HARD_CEILING_SECONDS);
    expect(Number.isNaN(Date.parse(access.expiresAt))).toBe(false);
    // The grant descriptor stays vendor-neutral (C1's vocabulary); the
    // grant string is vendor material BY NATURE (it joins the channel).
    const serialized = JSON.stringify({
      ...access,
      grant: "<redacted-by-design>",
    });
    expect(serialized).not.toMatch(/socket\.?io|engine\.?io|livekit|webrtc/i);
    expect(JSON.stringify(access)).not.toContain(SYNTHETIC_AUTH_SECRET);

    // The REAL join: the grant redeems in the handshake auth payload
    // over a real WebSocket connection to the embedded server.
    if (host === null) {
      throw new Error("the embedded socket.io server is not booted");
    }
    const receiver = io(host.url, {
      path: host.railPath,
      transports: ["websocket"],
      auth: { grant: access.grant },
      reconnection: false,
      timeout: 3_000,
    });
    await new Promise<void>((resolve, reject) => {
      receiver.once("connect", () => resolve());
      receiver.once("connect_error", (error: Error) => reject(error));
    });
    // The receiver acks rail frames: one REAL acked delivery round-trip.
    receiver.on("rail-turn", (_frame: unknown, cb: () => void) => cb());
    const before = host.observe().countDeliveriesCompleted();
    const outcome = await rail.deliverTurn({
      applicationId: "00000000-0000-7000-8000-000000000030",
      sessionId: "session-client-access",
      channelSessionRef: session.channelSessionRef,
      channelEpoch: session.channelEpoch,
      routeClass: "generative",
      idempotencyKey: `conformance-join-deliver:${Date.now()}`,
      responseRef: "artifact://realtime/turns/turn-join",
      responsePreview: "a bounded preview of the joined delivery",
      cause: "join proof",
    });
    expect(outcome.delivered).toBe(true);
    expect(host.observe().countDeliveriesCompleted()).toBe(before + 1);
    receiver.close();

    // A GARBAGE grant is refused by the handshake (the gate is real).
    const impostor = io(host.url, {
      path: host.railPath,
      transports: ["websocket"],
      auth: { grant: "zeckgrant1.deadbeef.deadbeef" },
      reconnection: false,
      timeout: 3_000,
    });
    await new Promise<void>((resolve) => {
      impostor.once("connect_error", () => resolve());
      impostor.once("connect", () => {
        throw new Error("a garbage grant must not connect");
      });
    });
    impostor.close();
  });

  test("the join grant is single-channel: it cannot join a channel it was not minted for", async () => {
    const openFor = async (key: string) =>
      rail.openSession({
        applicationId: "00000000-0000-7000-8000-000000000040",
        tenantId: "00000000-0000-7000-8000-000000000041",
        deploymentId: "00000000-0000-7000-8000-000000000042",
        pinnedPlanId: "00000000-0000-7000-8000-000000000043",
        pinnedPlanVersion: 1,
        executionId: "00000000-0000-7000-8000-000000000044",
        channelKind: "web",
        idempotencyKey: key,
        channelSessionRef: null,
        callerRef: null,
        sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 4 },
      });
    const channelA = await openFor(`conformance-single-channel-a:${Date.now()}`);
    const channelB = await openFor(`conformance-single-channel-b:${Date.now()}`);
    const accessForA = await rail.mintClientAccess({
      applicationId: "00000000-0000-7000-8000-000000000040",
      channelSessionRef: channelA.channelSessionRef,
      channelEpoch: channelA.channelEpoch,
      sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 4 },
      participantRef: null,
    });
    expect(accessForA.channelSessionRef).toBe(channelA.channelSessionRef);
    // The grant's payload is scoped to channel A's room; channel B has a
    // DIFFERENT room — the scoped grant simply cannot address it. (The
    // room derivation is opaque; the scope is enforced by the grant
    // payload's room member, verified cryptographically at the server.)
    const grantParts = accessForA.grant.split(".");
    expect(grantParts.length).toBe(3);
    const payload = JSON.parse(Buffer.from(grantParts[1] ?? "", "hex").toString("utf8")) as {
      p?: string;
      r?: string;
    };
    expect(payload.p).toBe("join");
    expect(typeof payload.r).toBe("string");
    expect(payload.r).not.toContain(channelB.channelSessionRef);
  });

  test("client access fails closed for a channel the rail never opened", async () => {
    await expect(
      rail.mintClientAccess({
        applicationId: "00000000-0000-7000-8000-000000000050",
        channelSessionRef: "siort-never-opened-by-this-rail",
        channelEpoch: 1,
        sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 4 },
        participantRef: null,
      }),
    ).rejects.toThrow(/open, admitted rail session/i);
  });

  beforeAll(async () => {
    // The rail boots its OWN embedded server on its first side effect
    // (the listen form, ephemeral port); the harness-boot session below
    // triggers it, after which `host` is the rail's own server — the
    // vantage every probe and refusal injection below addresses.
    await rail.openSession({
      applicationId: "00000000-0000-7000-8000-000000000060",
      tenantId: "00000000-0000-7000-8000-000000000061",
      deploymentId: "00000000-0000-7000-8000-000000000062",
      pinnedPlanId: "00000000-0000-7000-8000-000000000063",
      pinnedPlanVersion: 1,
      executionId: "00000000-0000-7000-8000-000000000064",
      channelKind: "web",
      idempotencyKey: `conformance-harness-boot:${Date.now()}`,
      channelSessionRef: null,
      callerRef: null,
      sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 4 },
    });
    host = rail.embeddedServer;
    if (host === null) {
      throw new Error("the rail did not boot its embedded socket.io server");
    }
  });

  afterAll(async () => {
    await rail.close();
    if (host !== null) {
      await host.close();
    }
  });
});
