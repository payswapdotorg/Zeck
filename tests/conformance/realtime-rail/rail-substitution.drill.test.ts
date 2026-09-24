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
  LIVEKIT_RAIL_CAPABILITY_ID,
  type LiveKitRealtimeRail,
  LOCAL_LIVEKIT_SERVER_LABEL,
} from "../../../src/modules/deployments/adapters/livekit-realtime-rail";
import { createRealtimeRailRebindComposition } from "../../../src/modules/deployments/adapters/realtime-rail-rebind-binding";
import {
  bootEmbeddedSocketIoServer,
  createSocketIoRealtimeRail,
  LOCAL_SOCKETIO_SERVER_LABEL,
  SOCKETIO_FAILURE_NORMALIZATION,
  SOCKETIO_RAIL_CAPABILITY_ID,
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

// ---------------------------------------------------------------------------
// THE POLICY SEAM (PPR-013 — this drill's recorded residual, now a
// governed work order delivered): the same substitution scenario
// driven through the composition AUTO-REBIND POLICY instead of the
// operator's hands. The rails are the same REAL pair as the drill
// above; the difference is WHO performs the substitution — the
// POLICY, inside the composition, behind the same neutral port:
// the preference (LiveKit preferred, socket.io alternate), ONE
// bounded re-bind per open on a RETRYABLE normalized refusal under
// the same coordinates + the same stable key, and NO mid-session
// flapping (a session lives on the rail that opened it).
// ---------------------------------------------------------------------------
describe("the rail substitution drill — the POLICY seam (PPR-013)", () => {
  const POLICY_LIVEKIT_PORT = 7897; // NOT 7895 (this file's drill) nor 7891 (the livekit conformance suite).

  test.skipIf(!livekitAvailable)(
    "(f→h) prefer the primary, ONE bounded re-bind on a real refusal, no mid-session flapping",
    { timeout: 30_000 },
    async () => {
      let server: ChildProcess | null = null;
      let alternateHost: SocketIoRailEmbeddedServer | null = null;
      let alternate: SocketIoRealtimeRail | null = null;
      try {
        server = spawn(LIVEKIT_SERVER_BIN, [
          "--dev",
          "--port",
          String(POLICY_LIVEKIT_PORT),
          "--bind",
          "127.0.0.1",
        ]);
        server.on("error", () => {
          server = null;
        });
        const deadline = Date.now() + 10_000;
        for (;;) {
          if (Date.now() > deadline) {
            throw new Error(
              "the policy drill's local livekit-server did not become reachable within 10s",
            );
          }
          const reachable = await new Promise<boolean>((resolve) => {
            const socket = createConnection(
              { host: "127.0.0.1", port: POLICY_LIVEKIT_PORT, timeout: 500 },
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
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (server?.pid === undefined) {
          throw new Error("the policy drill's livekit-server process is not running");
        }
        const primary = createLiveKitRealtimeRail({
          serverUrl: `http://127.0.0.1:${POLICY_LIVEKIT_PORT}`,
          credentialSource: livekitCredentialSource,
          requestTimeoutSeconds: 2,
        });
        alternateHost = await bootEmbeddedSocketIoServer({});
        alternate = createSocketIoRealtimeRail({
          listenUrl: alternateHost.url,
          embeddedServer: alternateHost,
          credentialSource: {
            resolve: async () => ({
              connectionId: "policy-drill-socketio-connection",
              credentialRef: "zeck-secret://local/socketio-auth-secret",
            }),
            materialize: async (reference: string) => ({
              reference,
              plaintext: JSON.stringify({
                authSecret: "sk-socketio-policy-drill-0000000000000003",
              }),
            }),
          },
          requestTimeoutMs: 1_500,
        });
        const { rail, rebinds, servedBy } = createRealtimeRailRebindComposition({
          preferred: primary,
          alternate,
        });

        // (f) OPEN through the POLICY on the preferred (the REAL local
        // livekit-server) — no rebind, the preferred disclosed.
        const openKeyOne = realtimeRailOpenKey("policy-drill-open-0001");
        const first = await rail.openSession(drillOpenRequest(openKeyOne));
        expect(first.replayed).toBe(false);
        expect(rebinds()).toEqual([]);
        expect(servedBy(first.channelSessionRef)).toBe(LIVEKIT_RAIL_CAPABILITY_ID);
        expect(rail.descriptor.railCapabilityId).toBe(LIVEKIT_RAIL_CAPABILITY_ID);

        // (g) REFUSE the preferred for real: TERMINATE the
        // livekit-server — new connections are then REFUSED, the
        // honest retryable capacity event (ECONNREFUSED → the neutral
        // unreachable class). NOT SIGSTOP: a frozen-but-listening
        // upstream turns the bounded request timeout into a TimeoutError
        // that normalizes as upstream-error — NON-retryable, and the
        // policy CORRECTLY never re-binds on it (verified during this
        // drill's development). Then OPEN a NEW session through the
        // POLICY: ONE bounded re-bind onto the REAL alternate under
        // the new key's own coordinates, the alternate disclosed.
        const exited = new Promise<void>((resolve) => {
          if (server === null) {
            resolve();
            return;
          }
          server.once("exit", () => resolve());
        });
        process.kill(server.pid, "SIGTERM");
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
        await new Promise((resolve) => setTimeout(resolve, 200));
        const openKeyTwo = realtimeRailOpenKey("policy-drill-open-0002");
        const second = await rail.openSession(drillOpenRequest(openKeyTwo));
        expect(second.replayed).toBe(false);
        expect(servedBy(second.channelSessionRef)).toBe(SOCKETIO_RAIL_CAPABILITY_ID);
        expect(rail.descriptor.railCapabilityId).toBe(SOCKETIO_RAIL_CAPABILITY_ID);
        const events = rebinds();
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
          idempotencyKey: openKeyTwo,
          fromRailCapabilityId: LIVEKIT_RAIL_CAPABILITY_ID,
          toRailCapabilityId: SOCKETIO_RAIL_CAPABILITY_ID,
          reason: "realtime rail upstream unreachable",
        });

        // (h) NO MID-SESSION FLAPPING: session one's frames STILL follow
        // its (now dead) primary and are refused NEUTRALLY there — the
        // policy does NOT flap them onto the healthy alternate that
        // just won the re-bind (masking a dead rail would violate the
        // honest-failure discipline); session two serves on the
        // alternate that opened it.
        const deliverKeyOne = realtimeRailDeliverKey("policy-drill-deliver-0001");
        const firstDelivery = await rail.deliverTurn(
          drillDelivery("policy-drill-session", first.channelSessionRef, deliverKeyOne),
        );
        expect(firstDelivery.delivered).toBe(false);
        if (!firstDelivery.delivered) {
          expect(firstDelivery.reason).toBe("realtime rail upstream unreachable");
          expect(firstDelivery.reason).not.toMatch(/livekit|twirp|grpc|webrtc|participant/i);
        }
        // The alternate served NOTHING for session one — no flap. (The
        // observation readers are live per protocol-state generation,
        // and this host's state was installed by the re-bind open —
        // the ABSOLUTE count on this fresh host is the honest check.)
        expect(alternateHost.observe().countDeliveriesCompleted()).toBe(0);
        const deliverKeyTwo = realtimeRailDeliverKey("policy-drill-deliver-0002");
        const secondDelivery = await rail.deliverTurn(
          drillDelivery("policy-drill-session", second.channelSessionRef, deliverKeyTwo),
        );
        expect(secondDelivery.delivered).toBe(true);
        // ...and exactly ONE delivery EVER on this fresh host: session
        // two's. Session one's frame never reached it.
        expect(alternateHost.observe().countDeliveriesCompleted()).toBe(1);

        // CLOSE both sessions through the POLICY — each on its own
        // rail: session two closes on the live alternate; session
        // one's close follows its dead primary and is refused
        // neutrally (the same no-flap rule, honestly recorded).
        const closeKeyOne = realtimeRailCloseKey("policy-drill-close-0001");
        const closeKeyTwo = realtimeRailCloseKey("policy-drill-close-0002");
        const firstClose = await rail.closeSession({
          applicationId: DRILL_APPLICATION,
          sessionId: "policy-drill-session",
          channelSessionRef: first.channelSessionRef,
          channelEpoch: first.channelEpoch,
          idempotencyKey: closeKeyOne,
          cause: "policy drill complete",
        });
        const secondClose = await rail.closeSession({
          applicationId: DRILL_APPLICATION,
          sessionId: "policy-drill-session",
          channelSessionRef: second.channelSessionRef,
          channelEpoch: second.channelEpoch,
          idempotencyKey: closeKeyTwo,
          cause: "policy drill complete",
        });
        expect(firstClose.delivered).toBe(false);
        if (!firstClose.delivered) {
          expect(firstClose.reason).toBe("realtime rail upstream unreachable");
        }
        expect(secondClose.delivered).toBe(true);
        // The primary's own effect log holds exactly its ONE successful
        // open — session one's refused frame and close performed no
        // upstream effect there (a refusal is not a side effect), and
        // the alternate's registry holds session two's effects only.
        expect(primary.upstreamEffects.filter((effect) => effect.kind === "open")).toHaveLength(1);

        // The policy drill record — the honest summary of exactly what ran.
        // eslint-disable-next-line no-console
        console.log(
          "policy-seam drill record:",
          JSON.stringify(
            {
              preferredRail: `${LOCAL_LIVEKIT_SERVER_LABEL} (REAL)`,
              alternateRail: `${LOCAL_SOCKETIO_SERVER_LABEL} (REAL — always)`,
              refusalInjection:
                "sigterm-livekit-server (connection refused ⇒ retryable unreachable)",
              boundedRebind: "one-per-open-invocation",
              midSessionFlapping:
                "none — session one's frames followed its dead primary and were refused neutrally",
            },
            null,
            2,
          ),
        );
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
        await alternate?.close();
        await alternateHost?.close();
      }
    },
  );

  if (!livekitAvailable) {
    test.skip("the policy-seam leg (no local livekit-server binary — the unit battery's REAL-rail policy proof stands; this leg is honestly not run)", () => {
      // The honest-skip record: the policy's REAL-rail failover is
      // proven by the unit battery (a dead preferred LiveKit endpoint
      // re-binding onto the REAL embedded socket.io rail); this leg
      // adds the REAL livekit-server primary and skips without it.
    });
  }
});
