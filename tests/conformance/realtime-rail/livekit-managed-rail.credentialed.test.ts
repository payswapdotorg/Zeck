/**
 * The realtime-rail conformance suite over the LiveKit adapter against
 * the OPERATOR-DELIVERED MANAGED PLANE (PPR-009 — the §15 Lead
 * credentialed run: the admin/server-SDK external rung).
 *
 * THE HONEST SCOPE: the upstream is the operator's managed LiveKit
 * Cloud plane (`wss://…livekit.cloud`) reached through the PUBLISHED
 * `livekit-server-sdk` RoomService admin surface with the
 * operator-delivered API keypair. This file is the §15 credentialed
 * addendum's reproducible harness — it runs ONLY when the environment
 * materializes the full LiveKit credential set (the composition gate's
 * OWN reader decides; the exact production path), and honestly skips
 * otherwise (CI-safe: no credentials, no suite).
 *
 * THE MANAGED PLANE'S HONEST DIFFERENCES from the local
 * livekit-server subject (each is pinned, not papered over):
 *
 *   - EVENTUAL CONSISTENCY — the managed plane's room list propagates
 *     on the order of seconds (directly measured: a fresh room can be
 *     absent at 0.3s/1s, present by 2.5-6s). The local server's
 *     ListRooms reflects creates/deletes immediately. The
 *     corroboration below therefore POLLS BOUNDED (≤ 15s) for
 *     propagation instead of asserting immediate equality, and its
 *     count check is a BOUND (≤ the adapter's effect-log arithmetic),
 *     never an equality — a bound is flow-independent and immune to
 *     in-flight propagation.
 *
 *   - NO SIGNAL-LEVEL REFUSAL INJECTION — the managed plane cannot be
 *     SIGSTOPped (the C9/C10 local refusal mechanism). The contract's
 *     own conditional path covers this honestly: C9 and C10 return
 *     early for subjects without `armRefusal` (the refusal
 *     normalization itself stays pinned by the local-rail and
 *     simulated-rail subjects of the SAME contract).
 *
 * THE PROBES' VANTAGE: exactly the local suite's — the adapter's
 * `upstreamEffects` log (what the adapter ACTUALLY performed upstream;
 * a converged replay records nothing there — the exactly-once
 * observable), cross-checked against the plane's own room list.
 *
 * THE CRASH MODEL (C4): `restart` builds a FRESH adapter instance (a
 * fresh in-memory delivery ledger — the adapter process died) against
 * the SAME plane; the re-open under the same key must converge on the
 * existing room (OPEN converges server-side by room identity — the
 * §15 idempotency design).
 *
 * CLEANUP: the suite deletes every room it opened (all `zeckrt-*`
 * rooms on the plane) — a beforeAll hygiene pass removes prior-run
 * artifacts (leave the plane cleaner than found) and an
 * eventual-consistency-aware afterAll loop keeps deleting until a
 * clean observation SURVIVES the propagation window (a last test's
 * create can lag seconds behind in the room list — a single pass
 * races). The credentialed plane is left CLEAN (verified by the
 * post-run probe recorded in the evidence).
 */

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  createEnvironmentLiveKitCredentialSource,
  createLiveKitRealtimeRail,
  type LiveKitRealtimeRail,
  liveKitUpstreamChannelNameOf,
} from "../../../src/modules/deployments/adapters/livekit-realtime-rail";
import {
  LIVEKIT_ENV_CREDENTIAL_REFERENCE,
  LIVEKIT_RAIL_ENV_VARIABLES,
  readLiveKitRailMaterialization,
} from "../../../src/modules/deployments/adapters/livekit-realtime-rail-binding";
import { defineRealtimeRailConformance } from "./realtime-rail-conformance";

// The managed plane is a cross-ocean WSS hop: per-test timeouts must
// tolerate the propagation polls below (the vitest 5s default bites).
vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });

const materialization = readLiveKitRailMaterialization(process.env);
// Read ONCE for the canaries + the admin corroborator (never logged,
// never in an assertion message, never in a port-crossing shape).
const apiKey = process.env[LIVEKIT_RAIL_ENV_VARIABLES.apiKey]?.trim() ?? "";
const apiSecret = process.env[LIVEKIT_RAIL_ENV_VARIABLES.apiSecret]?.trim() ?? "";
const serverUrl = materialization.url ?? "";

describe.skipIf(!materialization.materialized)(
  "the LiveKit adapter conformance harness (the OPERATOR-DELIVERED managed plane — the §15 credentialed run)",
  () => {
    const railOptions = {
      serverUrl,
      credentialSource: createEnvironmentLiveKitCredentialSource({
        reference: LIVEKIT_ENV_CREDENTIAL_REFERENCE,
        connectionId: "conformance-managed-livekit",
        apiKey,
        apiSecret,
      }),
      requestTimeoutSeconds: 15,
    } as const;

    const rail: LiveKitRealtimeRail = createLiveKitRealtimeRail(railOptions);

    /** The plane's zeckrt-room count BEFORE this suite opened anything. */
    let preExistingZeckRooms = 0;

    defineRealtimeRailConformance({
      name: "livekit-realtime-rail over the managed plane (the §15 admin/server-SDK credentialed run)",
      rail,
      // NO armRefusal/disarmRefusal: the managed plane cannot be
      // SIGSTOPped — C9/C10 take the contract's conditional path and
      // the refusal-normalization coverage stays with the local-rail
      // + simulated subjects of the same contract.
      supports: {},
      secretCanaryValues: [apiKey, apiSecret],
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

    const adminRoomClient = async () => {
      const sdk = (await import("livekit-server-sdk")) as typeof import("livekit-server-sdk");
      return new sdk.RoomServiceClient(serverUrl, apiKey, apiSecret, {
        requestTimeout: 10,
        failover: false,
      });
    };

    /** Poll the eventually-consistent room list until `predicate` holds (≤ boundMs). */
    const pollRoomList = async (
      predicate: (names: string[]) => boolean,
      boundMs: number,
    ): Promise<boolean> => {
      const client = await adminRoomClient();
      const deadline = Date.now() + boundMs;
      for (;;) {
        const rooms = await client.listRooms();
        if (predicate(rooms.map((room) => room.name))) {
          return true;
        }
        if (Date.now() > deadline) {
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    };

    test("the managed plane's room list corroborates the adapter's effect log (eventual consistency, bounded)", async () => {
      // FRESH OPEN under a fresh key (flow-independent of the contract
      // tests above): the room must APPEAR (bounded propagation poll),
      // every adapter room stays CONTAINED in the adapter's prefix,
      // the visible count stays BOUNDED by the effect-log arithmetic
      // (never equality — in-flight propagation), and the CLOSE seam
      // REMOVES the room (bounded poll).
      const corroborationApplicationId = "00000000-0000-7000-8000-000000000030";
      const corroborationKey = `conformance-managed-corroboration:${Date.now()}`;
      // The upstream room name is a DETERMINISTIC function of the
      // stable coordinates (the §15 idempotency design) — the
      // corroboration observes it WITHOUT asking the adapter.
      const expectedRoomName = liveKitUpstreamChannelNameOf(
        corroborationApplicationId,
        corroborationKey,
      );
      const openedBefore =
        rail.upstreamEffects.filter((effect) => effect.kind === "open").length -
        rail.upstreamEffects.filter((effect) => effect.kind === "close").length;
      const session = await rail.openSession({
        applicationId: corroborationApplicationId,
        tenantId: "00000000-0000-7000-8000-000000000031",
        deploymentId: "00000000-0000-7000-8000-000000000032",
        pinnedPlanId: "00000000-0000-7000-8000-000000000033",
        pinnedPlanVersion: 1,
        executionId: "00000000-0000-7000-8000-000000000034",
        channelKind: "web",
        idempotencyKey: corroborationKey,
        channelSessionRef: null,
        callerRef: null,
        sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 4 },
      });
      // The port's ref is the OPAQUE neutral ref (a different hash
      // domain from the room name — no vendor identifier derivable
      // from it, and vice versa; C2's grammar pins its opacity).
      expect(session.channelSessionRef.startsWith("rtch-")).toBe(true);

      // Bounded propagation poll: the fresh room must become visible.
      const appeared = await pollRoomList((names) => names.includes(expectedRoomName), 15_000);
      expect(
        appeared,
        "the fresh room must propagate into the managed plane's room list within the 15s bound",
      ).toBe(true);

      // Containment + count bound: every visible adapter-prefixed room
      // is a `zeckrt-` room, and the visible count never EXCEEDS the
      // effect-log arithmetic (rooms pending removal may lag; nothing
      // else may appear).
      const client = await adminRoomClient();
      const rooms = await client.listRooms();
      const zeckRooms = rooms.filter((room) => room.name.startsWith("zeckrt-"));
      expect(zeckRooms.length).toBeGreaterThan(0);
      // Count bound RELATIVE TO THE BASELINE: prior-run artifacts may
      // still be visible (their deletions propagate on the same
      // eventual-consistency clock) — the bound catches the adapter
      // fabricating EXTRA channels beyond its own effect log, which
      // is the corroboration's job.
      expect(zeckRooms.length - preExistingZeckRooms).toBeLessThanOrEqual(openedBefore + 1);

      // Close-seam removal: the close deletes the upstream room.
      const closed = await rail.closeSession({
        applicationId: corroborationApplicationId,
        sessionId: "session-managed-corroboration",
        channelSessionRef: session.channelSessionRef,
        channelEpoch: session.channelEpoch,
        idempotencyKey: `conformance-managed-corroboration-close:${Date.now()}`,
        cause: "the credentialed corroboration's close-seam removal",
      });
      expect(closed.delivered).toBe(true);
      const removed = await pollRoomList((names) => !names.includes(expectedRoomName), 15_000);
      expect(removed, "the closed room must leave the room list within the 15s bound").toBe(true);
    });

    test("the client-access seam mints a short-lived, single-purpose join grant on the managed plane", async () => {
      const session = await rail.openSession({
        applicationId: "00000000-0000-7000-8000-000000000040",
        tenantId: "00000000-0000-7000-8000-000000000041",
        deploymentId: "00000000-0000-7000-8000-000000000042",
        pinnedPlanId: "00000000-0000-7000-8000-000000000043",
        pinnedPlanVersion: 1,
        executionId: "00000000-0000-7000-8000-000000000044",
        channelKind: "web",
        idempotencyKey: `conformance-managed-client-access:${Date.now()}`,
        channelSessionRef: null,
        callerRef: null,
        sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 4 },
      });
      const access = await rail.mintClientAccess({
        applicationId: "00000000-0000-7000-8000-000000000040",
        channelSessionRef: session.channelSessionRef,
        channelEpoch: session.channelEpoch,
        sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 4 },
        participantRef: "lead-credentialed-run-probe",
      });
      expect(access.grant.length).toBeGreaterThan(0);
      expect(access.purpose).toBe("join");
      expect(access.ttlSeconds).toBeGreaterThan(0);
      expect(access.ttlSeconds).toBeLessThanOrEqual(3600);
      expect(Number.isNaN(Date.parse(access.expiresAt))).toBe(false);
      // The grant is vendor material BY NATURE (it joins the vendor's
      // channel) but its DESCRIPTOR stays vendor-neutral: the wire
      // shape carries no vendor identifiers (C1's vocabulary) and no
      // credential material (C11's hygiene).
      const serialized = JSON.stringify(access);
      expect(serialized).not.toMatch(/livekit|twirp|grpc|webrtc/i);
      expect(serialized).not.toContain(apiSecret);
    });

    beforeAll(async () => {
      // BASELINE + HYGIENE: the plane is project-dedicated, so any
      // pre-existing `zeckrt-` room is a PRIOR RUN's artifact — count
      // it (the corroboration's count bound is relative to this
      // baseline) and delete it (leave the plane cleaner than found).
      try {
        const client = await adminRoomClient();
        const rooms = await client.listRooms();
        preExistingZeckRooms = rooms.filter((room) => room.name.startsWith("zeckrt-")).length;
        for (const room of rooms) {
          if (room.name.startsWith("zeckrt-")) {
            await client.deleteRoom(room.name);
          }
        }
      } catch {
        // Best-effort baseline; the bound only grows more honest.
      }
    });

    afterAll(async () => {
      // CLEANUP (delete-by-name + eventual-consistency-aware verify):
      // the adapter's own effect log names every room this suite
      // created (an "open" record carries the exact coordinates the
      // deterministic room name derives from), and deleteRoom works
      // BY NAME — independent of the room list's propagation lag (a
      // room created seconds ago can be absent from the list while
      // being fully deletable). The list-based catch-all plus a
      // clean-observation survival window then verifies the plane.
      try {
        const client = await adminRoomClient();
        const openedRoomNames = new Set(
          rail.upstreamEffects
            .filter((effect) => effect.kind === "open")
            .map((effect) =>
              liveKitUpstreamChannelNameOf(effect.applicationId, effect.idempotencyKey),
            ),
        );
        for (const name of openedRoomNames) {
          await client.deleteRoom(name).catch(() => undefined);
        }
        const deadline = Date.now() + 30_000;
        let cleanSince = -1;
        for (;;) {
          const rooms = (await client.listRooms()).filter((room) =>
            room.name.startsWith("zeckrt-"),
          );
          for (const room of rooms) {
            await client.deleteRoom(room.name).catch(() => undefined);
          }
          if (rooms.length === 0) {
            if (cleanSince < 0) {
              cleanSince = Date.now();
            }
            // A clean observation must SURVIVE the propagation window
            // (a late-propagating create would appear after it).
            if (Date.now() - cleanSince >= 8_000 || Date.now() > deadline) {
              break;
            }
          } else if (Date.now() > deadline) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      } catch {
        // Best-effort cleanup; the post-run probe records the truth.
      }
    });
  },
);

// The honest-skip record: without the credential set this file's
// suites are skipped by describe.skipIf above (the reason lives here).
if (!materialization.materialized) {
  test.skip("the LiveKit managed-plane conformance suite (credential set not materialized)", () => {
    console.warn(
      `skipped: the managed-plane credentialed run requires ${LIVEKIT_RAIL_ENV_VARIABLES.url} + ${LIVEKIT_RAIL_ENV_VARIABLES.apiKey} + ${LIVEKIT_RAIL_ENV_VARIABLES.apiSecret} (the §15 operator sequence) — missing: ${materialization.missing.join(", ")}`,
    );
  });
}
