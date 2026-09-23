/**
 * THE RAIL SUBSTITUTION / FAILOVER DRILL (PPR-010 requirement 4 —
 * GAP-003's level-5 rung: "multi-provider replaceable + failure
 * drills"; the maturity ladder's alternate-solution evidence).
 *
 * WHAT THIS DRILL PROVES: the SAME durable session coordinates — the
 * same neutral application/execution coordinates and the SAME stable
 * rail-level idempotency keys — drive TWO GENUINELY DIFFERENT REAL
 * realtime solutions through ONE neutral port with ONE conformance
 * contract, and when the PRIMARY rail refuses, the coordinates replay
 * against the ALTERNATE rail and converge: exactly-once upstream
 * effects PER RAIL, identical neutral acknowledgment shapes, no vendor
 * state anywhere in the coordinates.
 *
 * THE RAILS (honest labeling — the drill record below states exactly
 * what ran):
 *   - PRIMARY: the REAL local livekit-server (the open-source binary,
 *     `--dev` mode, the PUBLIC devkey — not secrets) while the binary
 *     is present; otherwise the SIMULATED in-process reference rail,
 *     labeled honestly (the refusal leg is then not applicable — the
 *     fake has no upstream to refuse).
 *   - ALTERNATE: the REAL embedded socket.io server — ALWAYS real
 *     (the published socket.io package, in process, loopback).
 *
 * WHAT IS EXPLICITLY NOT PROVEN HERE (the honest residual, owned by a
 * future governed work order): the COMPOSITION-level auto-rebind
 * policy — a preference order and automatic failover INSIDE the
 * composition touches the frozen admission ordering and can mask
 * failures; this drill proves the SEAM-level substitutability that any
 * such policy would rest on, never the policy itself.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createInProcessRealtimeRail } from "../../../src/modules/deployments/adapters/in-process-realtime-rail";
import {
  createLiveKitRealtimeRail,
  LIVEKIT_FAILURE_NORMALIZATION,
  type LiveKitRealtimeRail,
  LOCAL_LIVEKIT_SERVER_LABEL,
} from "../../../src/modules/deployments/adapters/livekit-realtime-rail";
import {
  bootEmbeddedSocketIoServer,
  createSocketIoRealtimeRail,
  LOCAL_SOCKETIO_SERVER_LABEL,
  SOCKETIO_FAILURE_NORMALIZATION,
  type SocketIoRailEmbeddedServer,
  type SocketIoRealtimeRail,
} from "../../../src/modules/deployments/adapters/socketio-realtime-rail";
import {
  realtimeRailCloseKey,
  realtimeRailDeliverKey,
  realtimeRailOpenKey,
} from "../../../src/modules/deployments/domain/realtime";
import type { RealtimeRail } from "../../../src/modules/deployments/ports/realtime-rail";

const LIVEKIT_SERVER_BIN = process.env.ZECK_LIVEKIT_SERVER_BIN ?? "/tmp/livekit-server";
const LIVEKIT_PORT = 7895; // NOT 7891: the livekit conformance suite owns that port.
const livekitAvailable = existsSync(LIVEKIT_SERVER_BIN);

/** The drill's neutral coordinates — rail-agnostic by construction. */
const DRILL_APPLICATION = "00000000-0000-7000-8000-000000000070";
const DRILL_SESSION_POLICY = { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 4 };

function drillOpenRequest(idempotencyKey: string) {
  return {
    applicationId: DRILL_APPLICATION,
    tenantId: "00000000-0000-7000-8000-000000000071",
    deploymentId: "00000000-0000-7000-8000-000000000072",
    pinnedPlanId: "00000000-0000-7000-8000-000000000073",
    pinnedPlanVersion: 1,
    executionId: "00000000-0000-7000-8000-000000000074",
    channelKind: "web",
    idempotencyKey,
    channelSessionRef: null,
    callerRef: null,
    sessionPolicy: DRILL_SESSION_POLICY,
  } as const;
}

function drillDelivery(
  sessionId: string,
  channelSessionRef: string,
  idempotencyKey: string,
): Parameters<RealtimeRail["deliverTurn"]>[0] {
  return {
    applicationId: DRILL_APPLICATION,
    sessionId,
    channelSessionRef,
    channelEpoch: 1,
    routeClass: "generative",
    idempotencyKey,
    responseRef: "artifact://realtime/turns/drill-turn-0001",
    responsePreview: "the drill's bounded preview (never the bytes)",
    cause: "drill turn completion",
  };
}

/** The drill record: exactly what ran, honestly labeled. */
interface DrillRecord {
  primaryRail: string;
  alternateRail: string;
  refusalInjection: "sigstop-livekit-server" | "not-applicable-simulated-primary";
  primaryOpen: "pass" | "fail";
  primaryDeliver: "pass" | "fail";
  primaryRefusedDeliver: "refused-neutrally" | "not-applicable";
  alternateReplayOpen: "pass" | "fail";
  alternateReplayDeliver: "pass" | "fail";
  alternateReplayConvergence: "pass" | "fail";
  exactlyOncePerRail: "pass" | "fail";
  identicalNeutralShapes: "pass" | "fail";
}
const drillRecord: DrillRecord = {
  primaryRail: livekitAvailable
    ? `${LOCAL_LIVEKIT_SERVER_LABEL} (REAL)`
    : "simulated-realtime-rail (the reference fake — honest label)",
  alternateRail: `${LOCAL_SOCKETIO_SERVER_LABEL} (REAL — always)`,
  refusalInjection: livekitAvailable
    ? "sigstop-livekit-server"
    : "not-applicable-simulated-primary",
  primaryOpen: "fail",
  primaryDeliver: "fail",
  primaryRefusedDeliver: "not-applicable",
  alternateReplayOpen: "fail",
  alternateReplayDeliver: "fail",
  alternateReplayConvergence: "fail",
  exactlyOncePerRail: "fail",
  identicalNeutralShapes: "fail",
};

const livekitCredentialSource = {
  resolve: async () => ({
    connectionId: "drill-livekit-connection",
    credentialRef: "zeck-secret://local/livekit-api-keypair",
  }),
  materialize: async (reference: string) => ({
    reference,
    plaintext: JSON.stringify({ apiKey: "devkey", apiSecret: "secret" }),
  }),
};

function createLiveKitRail(): LiveKitRealtimeRail {
  return createLiveKitRealtimeRail({
    serverUrl: `http://127.0.0.1:${LIVEKIT_PORT}`,
    credentialSource: livekitCredentialSource,
    requestTimeoutSeconds: 2,
  });
}

describe("the rail substitution drill (GAP-003's level-5 rung)", () => {
  // ------------------------------------------------------------------
  // The ALTERNATE rail — ALWAYS REAL.
  // ------------------------------------------------------------------
  let alternateHost: SocketIoRailEmbeddedServer | null = null;
  let alternate: SocketIoRealtimeRail | null = null;

  beforeAll(async () => {
    alternateHost = await bootEmbeddedSocketIoServer({});
    alternate = createSocketIoRealtimeRail({
      listenUrl: alternateHost.url,
      embeddedServer: alternateHost,
      credentialSource: {
        resolve: async () => ({
          connectionId: "drill-socketio-connection",
          credentialRef: "zeck-secret://local/socketio-auth-secret",
        }),
        materialize: async (reference: string) => ({
          reference,
          plaintext: JSON.stringify({ authSecret: "sk-socketio-drill-0000000000000000002" }),
        }),
      },
      requestTimeoutMs: 1_500,
    });
  });

  afterAll(async () => {
    await alternate?.close();
    await alternateHost?.close();
  });

  test("(a) the shared neutral vocabulary spans BOTH real rails (and the reference fake)", () => {
    // The failure vocabularies: the five shared kinds carry the EXACT
    // same neutral reason strings — a refusal means the same thing on
    // every rail (the substitution drill's invariant).
    const sharedKinds = [
      "unreachable",
      "authentication",
      "not-found",
      "quota",
      "upstream-error",
    ] as const;
    for (const kind of sharedKinds) {
      expect(SOCKETIO_FAILURE_NORMALIZATION[kind].reason).toBe(
        LIVEKIT_FAILURE_NORMALIZATION[kind].reason,
      );
      expect(SOCKETIO_FAILURE_NORMALIZATION[kind].code).toBe(
        LIVEKIT_FAILURE_NORMALIZATION[kind].code,
      );
    }
    // The descriptor grammar: every rail NAMES itself in the neutral
    // grammar and speaks the neutral channel-kind vocabulary.
    const simulated = createInProcessRealtimeRail();
    for (const descriptor of [
      simulated.descriptor,
      ...(livekitAvailable ? [createLiveKitRail().descriptor] : []),
      ...(alternate === null ? [] : [alternate.descriptor]),
    ]) {
      expect(descriptor.railCapabilityId).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(descriptor.transportClass).toBe("realtime");
      expect(descriptor.channelKinds.length).toBeGreaterThan(0);
    }
  });

  // The PRIMARY rail's boot/teardown (real local livekit-server while
  // the binary is present; nothing boots otherwise — the leg skips).
  let server: ChildProcess | null = null;
  let primary: LiveKitRealtimeRail | null = null;

  test.skipIf(!livekitAvailable)(
    "(b→e) open+deliver on the primary, refuse, replay the SAME keys on the alternate, converge exactly-once per rail",
    { timeout: 30_000 },
    async () => {
      server = spawn(LIVEKIT_SERVER_BIN, [
        "--dev",
        "--port",
        String(LIVEKIT_PORT),
        "--bind",
        "127.0.0.1",
      ]);
      server.on("error", () => {
        server = null;
      });
      const deadline = Date.now() + 10_000;
      for (;;) {
        if (Date.now() > deadline) {
          throw new Error("the drill's local livekit-server did not become reachable within 10s");
        }
        const reachable = await new Promise<boolean>((resolve) => {
          const socket = createConnection(
            { host: "127.0.0.1", port: LIVEKIT_PORT, timeout: 500 },
            () => {
              socket.destroy();
              resolve(true);
            },
          );
          socket.on("error", () => resolve(false));
          socket.on("timeout", () => {
            socket.destroy();
            resolve(false);
          });
        });
        if (reachable) {
          primary = createLiveKitRail();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      try {
        if (primary === null || alternate === null || alternateHost === null) {
          throw new Error("the drill's rails are not booted");
        }
        const openKey = realtimeRailOpenKey("drill-open-0001");
        const deliverKey = realtimeRailDeliverKey("drill-deliver-0001");
        const closeKey = realtimeRailCloseKey("drill-close-0001");

        // (b) OPEN + DELIVER on the PRIMARY under the stable keys.
        const primarySession = await primary.openSession(drillOpenRequest(openKey));
        expect(primarySession.replayed).toBe(false);
        drillRecord.primaryOpen = "pass";
        const primaryDelivered = await primary.deliverTurn(
          drillDelivery("drill-session", primarySession.channelSessionRef, deliverKey),
        );
        expect(primaryDelivered.delivered).toBe(true);
        drillRecord.primaryDeliver = "pass";

        // (c) REFUSE the primary: SIGSTOP the livekit-server — TCP stays
        // open but nothing answers; the adapter's bounded request
        // timeout fires; the failure normalizes NEUTRALLY.
        if (server?.pid === undefined) {
          throw new Error("the drill's livekit-server process is not running");
        }
        // The settle window: the stop signal's delivery must settle
        // before the refused frame races it (an immediate request can
        // otherwise slip through the not-yet-frozen accept loop).
        process.kill(server.pid, "SIGSTOP");
        await new Promise((resolve) => setTimeout(resolve, 300));
        let refusedReason: string | null = null;
        try {
          const refused = await primary.deliverTurn(
            drillDelivery(
              "drill-session",
              primarySession.channelSessionRef,
              realtimeRailDeliverKey("drill-deliver-refused"),
            ),
          );
          expect(refused.delivered).toBe(false);
          if (!refused.delivered) {
            refusedReason = refused.reason;
            expect(refused.reason.length).toBeGreaterThan(0);
            // NEUTRAL: no vendor identifiers in the refusal reason.
            expect(refused.reason).not.toMatch(/livekit|twirp|grpc|webrtc|participant|sigstop/i);
          }
          drillRecord.primaryRefusedDeliver = "refused-neutrally";
        } finally {
          process.kill(server.pid, "SIGCONT");
        }
        expect(refusedReason).not.toBeNull();

        // (d) REPLAY the SAME durable coordinates against the ALTERNATE
        // under the SAME stable keys. The alternate has never seen these
        // keys: its own FIRST effects (fresh channels — exactly-once PER
        // RAIL is the invariant, not cross-rail dedupe).
        const alternateBefore = alternateHost.observe();
        const alternateSession = await alternate.openSession(drillOpenRequest(openKey));
        expect(alternateSession.replayed).toBe(false);
        drillRecord.alternateReplayOpen = "pass";
        const alternateDelivered = await alternate.deliverTurn(
          drillDelivery("drill-session", alternateSession.channelSessionRef, deliverKey),
        );
        expect(alternateDelivered.delivered).toBe(true);
        if (alternateDelivered.delivered) {
          expect(alternateDelivered.replayed).toBe(false);
        }
        drillRecord.alternateReplayDeliver = "pass";

        // Convergence on the alternate: the SAME key replays to the
        // ORIGINAL acknowledgment, no second upstream effect.
        const alternateReplay = await alternate.deliverTurn(
          drillDelivery("drill-session", alternateSession.channelSessionRef, deliverKey),
        );
        expect(alternateReplay.delivered).toBe(true);
        if (alternateReplay.delivered && alternateDelivered.delivered) {
          expect(alternateReplay.replayed).toBe(true);
          expect(alternateReplay.deliveredAt).toBe(alternateDelivered.deliveredAt);
        }
        drillRecord.alternateReplayConvergence = "pass";

        // Exactly-once PER RAIL: the alternate's server performed
        // exactly ONE open + ONE delivery for the drill; the primary's
        // effect log holds exactly one open + one delivery under the
        // drill keys (its refused frame never performed an effect).
        const after = alternateHost.observe();
        expect(after.countChannelsCreated() - alternateBefore.countChannelsCreated()).toBe(1);
        expect(after.countDeliveriesCompleted() - alternateBefore.countDeliveriesCompleted()).toBe(
          1,
        );
        const primaryOpens = primary.upstreamEffects.filter(
          (effect) => effect.kind === "open" && effect.idempotencyKey === openKey,
        );
        const primaryDelivers = primary.upstreamEffects.filter(
          (effect) => effect.kind === "deliver" && effect.idempotencyKey === deliverKey,
        );
        expect(primaryOpens.length).toBe(1);
        expect(primaryDelivers.length).toBe(1);
        drillRecord.exactlyOncePerRail = "pass";

        // Identical NEUTRAL acknowledgment shapes: the same key sets on
        // the session and the delivered outcome (the port's invariant).
        expect(Object.keys(alternateSession).sort().join(",")).toBe(
          Object.keys(primarySession).sort().join(","),
        );
        expect(Object.keys(alternateDelivered).sort().join(",")).toBe(
          Object.keys(primaryDelivered).sort().join(","),
        );
        expect(alternateSession.channelSessionRef).not.toBe(primarySession.channelSessionRef);
        drillRecord.identicalNeutralShapes = "pass";

        // CLOSE both channels under the SAME close key (each rail's own
        // exactly-once close).
        const primaryClose = await primary.closeSession({
          applicationId: DRILL_APPLICATION,
          sessionId: "drill-session",
          channelSessionRef: primarySession.channelSessionRef,
          channelEpoch: primarySession.channelEpoch,
          idempotencyKey: closeKey,
          cause: "drill complete",
        });
        const alternateClose = await alternate.closeSession({
          applicationId: DRILL_APPLICATION,
          sessionId: "drill-session",
          channelSessionRef: alternateSession.channelSessionRef,
          channelEpoch: alternateSession.channelEpoch,
          idempotencyKey: closeKey,
          cause: "drill complete",
        });
        expect(primaryClose.delivered).toBe(true);
        expect(alternateClose.delivered).toBe(true);

        // The drill record — the honest summary of exactly what ran.
        // eslint-disable-next-line no-console
        console.log("rail-substitution drill record:", JSON.stringify(drillRecord, null, 2));
        expect(drillRecord.primaryRail).toContain(LOCAL_LIVEKIT_SERVER_LABEL);
        expect(drillRecord.alternateRail).toContain(LOCAL_SOCKETIO_SERVER_LABEL);
      } finally {
        if (server?.pid !== undefined) {
          try {
            process.kill(server.pid, "SIGCONT");
          } catch {
            // Already gone.
          }
          try {
            process.kill(server.pid, "SIGTERM");
          } catch {
            // Already gone.
          }
        }
      }
    },
  );

  if (!livekitAvailable) {
    test.skip("the drill's primary-rail leg (no local livekit-server binary — the alternate's conformance proof stands; the primary leg is honestly not run)", () => {
      // The honest-skip record: the alternate rail is ALWAYS real and
      // proven by its own conformance subject; the primary leg needs
      // the open-source livekit-server binary
      // (ZECK_LIVEKIT_SERVER_BIN, default /tmp/livekit-server).
    });
  }
});
