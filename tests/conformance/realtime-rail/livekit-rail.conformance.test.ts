/**
 * The realtime-rail conformance suite over the LIVEKIT ADAPTER against
 * a REAL LOCAL livekit-server (PPR-009 — the first REAL rail's proof).
 *
 * THE HONEST SCOPE: the server is the open-source livekit-server binary
 * (label `local-livekit-server`) booted by this suite on loopback in
 * `--dev` mode with the PUBLIC development keypair (devkey/secret —
 * LiveKit's documented dev credentials, not secrets). NO managed or
 * production LiveKit availability is claimed or implied anywhere; every
 * external boundary is owned by a Lead credentialed run
 * (deploy/evidence/ppr-009.json notRun registry).
 *
 * THE PROBES' VANTAGE (honest labeling): the open/deliver/transfer/close
 * side-effect counts come from the ADAPTER's `upstreamEffects` log — the
 * adapter's record of the upstream calls it ACTUALLY performed (a
 * converged replay records NOTHING there, which is exactly the
 * exactly-once observable). The suite's C3/C4 open convergence is
 * ADDITIONALLY cross-checked against the SERVER's own room list (the
 * independent observation) in the final test below.
 *
 * THE REFUSAL INJECTION (C9/C10): SIGSTOP freezes the server process —
 * TCP connections stay open but no request is answered, so the adapter's
 * bounded request timeout fires (the honest transient-upstream shape);
 * SIGCONT recovers it with all upstream state intact (rooms survive).
 *
 * THE CRASH MODEL (C4): `restart` builds a FRESH adapter instance (a
 * fresh in-memory idempotency ledger — the adapter process died)
 * against the SAME server (the upstream and its room identities
 * survived); the re-open under the same key must converge on the
 * existing room.
 *
 * Skips with an explicit reason when no local livekit-server binary is
 * available (ZECK_LIVEKIT_SERVER_BIN, default /tmp/livekit-server) —
 * the same honest-skip discipline as the PG suites.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createLiveKitRealtimeRail } from "../../../src/modules/deployments/adapters/livekit-realtime-rail";
import { defineRealtimeRailConformance } from "./realtime-rail-conformance";

const SERVER_BIN = process.env.ZECK_LIVEKIT_SERVER_BIN ?? "/tmp/livekit-server";
const PORT = 7891;
const SERVER_URL = `http://127.0.0.1:${PORT}`;

/** The PUBLIC development keypair of livekit-server --dev (not secrets). */
const DEV_API_KEY = "devkey";
const DEV_API_SECRET = "secret";

const serverAvailable = existsSync(SERVER_BIN);

describe.skipIf(!serverAvailable)(
  "the LiveKit adapter conformance harness (a real local livekit-server)",
  () => {
    let server: ChildProcess | null = null;

    const bootServer = async (): Promise<void> => {
      server = spawn(SERVER_BIN, ["--dev", "--port", String(PORT), "--bind", "127.0.0.1"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      server.on("error", () => {
        server = null;
      });
      // Readiness: poll the TCP port (the server's HTTP surface).
      const deadline = Date.now() + 10_000;
      for (;;) {
        if (Date.now() > deadline) {
          throw new Error("the local livekit-server did not become reachable within 10s");
        }
        const reachable = await new Promise<boolean>((resolve) => {
          const socket = createConnection({ host: "127.0.0.1", port: PORT, timeout: 500 }, () => {
            socket.destroy();
            resolve(true);
          });
          socket.on("error", () => resolve(false));
          socket.on("timeout", () => {
            socket.destroy();
            resolve(false);
          });
        });
        if (reachable) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    };

    const stopServer = (): void => {
      if (server !== null && server.pid !== undefined) {
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
    };

    const credentialSource = {
      resolve: async () => ({
        connectionId: "conformance-livekit-connection",
        credentialRef: "zeck-secret://local/livekit-api-keypair",
      }),
      materialize: async (reference: string) => ({
        reference,
        plaintext: JSON.stringify({ apiKey: DEV_API_KEY, apiSecret: DEV_API_SECRET }),
      }),
    };

    const railOptions = {
      serverUrl: SERVER_URL,
      credentialSource,
      requestTimeoutSeconds: 2,
    } as const;

    const rail = createLiveKitRealtimeRail(railOptions);

    defineRealtimeRailConformance({
      name: "livekit-realtime-rail over local-livekit-server (the first REAL rail)",
      rail,
      armRefusal: () => {
        if (server?.pid === undefined) {
          throw new Error("the livekit-server process is not running");
        }
        process.kill(server.pid, "SIGSTOP");
      },
      disarmRefusal: () => {
        if (server?.pid === undefined) {
          throw new Error("the livekit-server process is not running");
        }
        process.kill(server.pid, "SIGCONT");
      },
      supports: { openRefusal: true },
      secretCanaryValues: [DEV_API_KEY, DEV_API_SECRET],
      probes: {
        countOpenSideEffects: async () =>
          rail.upstreamEffects.filter((effect) => effect.kind === "open").length,
        countDeliverSideEffects: async () =>
          rail.upstreamEffects.filter((effect) => effect.kind === "deliver").length,
        countTransferSideEffects: async () =>
          rail.upstreamEffects.filter((effect) => effect.kind === "transfer").length,
        countCloseSideEffects: async () =>
          rail.upstreamEffects.filter((effect) => effect.kind === "close").length,
      },
      restart: () => createLiveKitRealtimeRail(railOptions),
    });

    test("the server-side room list independently corroborates the adapter's effect log", async () => {
      // The independent observation: the server's own room list must
      // hold EXACTLY the channels the adapter's effect log says are
      // open-but-not-closed (rooms survive; closes delete).
      const opens = rail.upstreamEffects.filter((effect) => effect.kind === "open").length;
      const closes = rail.upstreamEffects.filter((effect) => effect.kind === "close").length;
      const expectedLiveRooms = opens - closes;
      const sdk = (await import("livekit-server-sdk")) as typeof import("livekit-server-sdk");
      const roomClient = new sdk.RoomServiceClient(SERVER_URL, DEV_API_KEY, DEV_API_SECRET, {
        requestTimeout: 5,
        failover: false,
      });
      const rooms = await roomClient.listRooms();
      const zeckChannels = rooms.filter((room) => room.name.startsWith("zeckrt-"));
      expect(zeckChannels.length).toBe(expectedLiveRooms);
      expect(zeckChannels.length).toBeGreaterThan(0);
    });

    test("the client-access seam mints a short-lived, single-purpose join grant for an open channel", async () => {
      const session = await rail.openSession({
        applicationId: "00000000-0000-7000-8000-000000000020",
        tenantId: "00000000-0000-7000-8000-000000000021",
        deploymentId: "00000000-0000-7000-8000-000000000022",
        pinnedPlanId: "00000000-0000-7000-8000-000000000023",
        pinnedPlanVersion: 1,
        executionId: "00000000-0000-7000-8000-000000000024",
        channelKind: "web",
        idempotencyKey: `conformance-client-access:${Date.now()}`,
        channelSessionRef: null,
        callerRef: null,
        sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 4 },
      });
      const access = await rail.mintClientAccess({
        applicationId: "00000000-0000-7000-8000-000000000020",
        channelSessionRef: session.channelSessionRef,
        channelEpoch: session.channelEpoch,
        sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 4 },
        participantRef: "agent-session-probe",
      });
      expect(access.grant.length).toBeGreaterThan(0);
      expect(access.purpose).toBe("join");
      expect(access.ttlSeconds).toBeGreaterThan(0);
      expect(access.ttlSeconds).toBeLessThanOrEqual(3600);
      expect(Number.isNaN(Date.parse(access.expiresAt))).toBe(false);
      // The grant is vendor material BY NATURE (it joins the vendor's
      // channel) but its DESCRIPTOR stays vendor-neutral: the wire
      // shape carries no vendor identifiers (C1's vocabulary).
      const serialized = JSON.stringify(access);
      expect(serialized).not.toMatch(/livekit|twirp|grpc|webrtc/i);
      expect(serialized).not.toContain(DEV_API_SECRET);
    });

    beforeAll(bootServer);
    afterAll(stopServer);
  },
);

// The honest-skip record: when no binary exists, this file's suites are
// skipped by describe.skipIf above (the explicit reason lives here).
if (!serverAvailable) {
  test.skip("the LiveKit conformance suite (no local livekit-server binary)", () => {
    console.warn(
      `skipped: ${SERVER_BIN} not found — set ZECK_LIVEKIT_SERVER_BIN or place the open-source livekit-server binary there to run the REAL-rail conformance`,
    );
  });
}
