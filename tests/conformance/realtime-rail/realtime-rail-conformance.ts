/**
 * THE REALTIME-RAIL CONFORMANCE CONTRACT (PPR-009).
 *
 * ONE suite that runs against ANY `RealtimeRail` implementation and
 * proves the provider-independence iron law at the realtime plane:
 *
 *   neutral capability port → CONFORMANCE CONTRACT → provider adapter
 *
 * This file is the contract a NEW realtime provider codes against —
 * never the vendor's SDK shapes. The shipped in-process simulated rail
 * (the semantic reference) passes it by construction; the LiveKit
 * adapter (the first REAL rail) passes the same suite against a real
 * local livekit-server where one is reachable. A rail that cannot pass
 * this suite is NOT interchangeable with the others and must not bind
 * behind the session service.
 *
 * THE PINNED CONTRACT (every assertion below is part of the contract):
 *
 *  C1  DESCRIPTOR NEUTRALITY — the descriptor's rail identity matches
 *      the neutral grammar `^[a-z0-9][a-z0-9-]*$` (a rail NAMES itself,
 *      like the models module's `openrouter` rail; vendor SDK
 *      identifiers never appear), the channel kinds are non-empty
 *      neutral strings, and the transport class is `realtime`.
 *  C2  OPEN LIFECYCLE — `openSession` over neutral coordinates returns
 *      an OPAQUE, non-PII channel-session ref (grammar `^[A-Za-z0-9:_-]+$`,
 *      never the caller's strings verbatim), a monotonic epoch ≥ 1, a
 *      plain-object rail metadata map, and `replayed: false` on first
 *      open.
 *  C3  OPEN KEY CONVERGENCE — re-issuing the SAME open under the SAME
 *      stable rail-level idempotency key returns the SAME channel
 *      coordinates with `replayed: true`.
 *  C4  EXACTLY-ONCE OPEN SIDE EFFECT — repeated opens under one key
 *      (including through a FRESH adapter process where the subject
 *      models a crash) converge on EXACTLY ONE upstream channel (the
 *      subject's upstream side-effect probe counts it).
 *  C5  DELIVERY KEY CONVERGENCE — re-delivering under the same key
 *      returns the ORIGINAL acknowledgment (same deliveredAt) with
 *      `replayed: true` and performs no second upstream delivery.
 *  C6  TRANSFER KEY CONVERGENCE — the same convergence for the
 *      escalation side effect.
 *  C7  CLOSE KEY CONVERGENCE — the same convergence for the close.
 *  C8  DISTINCT KEYS ARE DISTINCT EFFECTS — a different stable key is a
 *      NEW upstream side effect (`replayed: false`, probe count grows).
 *  C9  FAILURE NORMALIZATION — a refused upstream maps to the port's
 *      declared failure shape `{ delivered: false, reason }` with a
 *      NEUTRAL reason (no vendor error strings, no SDK identifiers, no
 *      transport codes cross the seam), and a refusal is NEVER cached
 *      under the key: the retry under the same key after the upstream
 *      recovers succeeds with `replayed: false` and still exactly one
 *      upstream side effect.
 *  C10 OPEN REFUSAL NORMALIZATION (optional, `supports.openRefusal`) —
 *      a refused open REJECTS (throws) with a neutral message and
 *      leaves NO upstream channel; the retry under the same key
 *      succeeds with exactly one.
 *  C11 SECRET HYGIENE — the subject's credential canaries NEVER appear
 *      in ANY port-crossing shape (descriptor, session, acknowledgments,
 *      reasons). No credential material crosses this seam, ever.
 *  C12 BOUNDED, NON-FABRICATED METADATA — the acknowledgment metadata
 *      stays inside the closed neutral vocabulary below and serializes
 *      under 2 KiB: a rail may not invent latency/quality/coverage facts
 *      (the acknowledgment carries the upstream's real answer only).
 *
 * Honest delivery semantics are exercised throughout: every delivery
 * carries an ARTIFACT REFERENCE plus a bounded text preview (never raw
 * media), exactly as the port requires.
 */

import { describe, expect, test } from "vitest";
import {
  realtimeRailCloseKey,
  realtimeRailDeliverKey,
  realtimeRailOpenKey,
  realtimeRailTransferKey,
} from "../../../src/modules/deployments/domain/realtime";
import type {
  RealtimeRail,
  RealtimeRailDelivery,
  RealtimeRailDeliveryOutcome,
  RealtimeRailSessionRequest,
} from "../../../src/modules/deployments/ports/realtime-rail";

/**
 * The closed neutral rail-metadata vocabulary (C12). A conformant rail
 * keeps its acknowledgment metadata inside these keys; extending the
 * vocabulary is a governed contract change, not an adapter decision.
 */
export const NEUTRAL_RAIL_METADATA_KEYS: readonly string[] = [
  "simulated",
  "channelKind",
  "sessionPolicy",
  "routeClass",
  "transportClass",
  "converged",
  "grantTtlSeconds",
];

/** Vendor/SDK markers that must NEVER cross the port in data shapes. */
const VENDOR_MARKER_PATTERN =
  /livekit|twirp|grpc|webrtc|participant|\broom\b|unavailable|eyJ[a-z0-9_-]{10,}|sk-[a-z0-9]{8,}/i;

/** The neutral channel-session ref grammar (opaque, non-PII). */
const CHANNEL_REF_PATTERN = /^[A-Za-z0-9:_-]+$/;

export interface RealtimeRailConformanceProbes {
  /** Distinct upstream channels opened (server/provider-side count). */
  countOpenSideEffects(): Promise<number>;
  /** Upstream delivery side effects performed. */
  countDeliverSideEffects(): Promise<number>;
  /** Upstream transfer side effects performed. */
  countTransferSideEffects(): Promise<number>;
  /** Upstream close side effects performed. */
  countCloseSideEffects(): Promise<number>;
}

export interface RealtimeRailConformanceSubject {
  /** The subject's honest label (test output only). */
  readonly name: string;
  /** The rail under test. */
  readonly rail: RealtimeRail;
  /** Arm the NEXT upstream effect to be refused (failure injection). */
  readonly armRefusal?: () => void | Promise<void>;
  /** Restore the healthy upstream after `armRefusal`. */
  readonly disarmRefusal?: () => void | Promise<void>;
  /** Upstream side-effect observability (C4, C5, C6, C7, C8, C9). */
  readonly probes?: RealtimeRailConformanceProbes;
  /** Whether the subject can make `openSession` itself refuse (C10). */
  readonly supports?: { readonly openRefusal?: boolean };
  /**
   * Canary credential values the subject holds INTERNALLY (C11): they
   * must never surface in any port-crossing shape.
   */
  readonly secretCanaryValues?: readonly string[];
  /**
   * Re-create the rail as a FRESH process would (the crash model for
   * C4: the adapter's in-process state dies; the upstream survives).
   * When omitted, C4 runs the re-issues against the same instance.
   */
  readonly restart?: () => Promise<RealtimeRail> | RealtimeRail;
}

const SESSION_POLICY = {
  maxSessionDurationMs: 3_600_000,
  maxConcurrentSessions: 4,
};

function openRequest(idempotencyKey: string, callerRef: string | null): RealtimeRailSessionRequest {
  return {
    applicationId: "00000000-0000-7000-8000-000000000009",
    tenantId: "00000000-0000-7000-8000-000000000010",
    deploymentId: "00000000-0000-7000-8000-000000000011",
    pinnedPlanId: "00000000-0000-7000-8000-000000000012",
    pinnedPlanVersion: 1,
    executionId: "00000000-0000-7000-8000-000000000013",
    channelKind: "web",
    idempotencyKey,
    channelSessionRef: null,
    callerRef,
    sessionPolicy: SESSION_POLICY,
  };
}

function delivery(
  sessionId: string,
  channelSessionRef: string,
  idempotencyKey: string,
): RealtimeRailDelivery {
  return {
    applicationId: "00000000-0000-7000-8000-000000000009",
    sessionId,
    channelSessionRef,
    channelEpoch: 1,
    routeClass: "generative",
    idempotencyKey,
    responseRef: "artifact://realtime/turns/turn-0001",
    responsePreview: "bounded preview of the response media (never the bytes)",
    cause: "turn completion",
  };
}

function assertNoVendorMarkers(value: string, where: string): void {
  expect(value, `${where} must carry no vendor identifiers`).not.toMatch(VENDOR_MARKER_PATTERN);
}

function assertNeutralMetadata(metadata: unknown, where: string): void {
  expect(metadata, `${where} metadata must be a plain object`).toBeTypeOf("object");
  const record = metadata as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    expect(
      NEUTRAL_RAIL_METADATA_KEYS,
      `${where} metadata key "${key}" must stay inside the closed neutral vocabulary`,
    ).toContain(key);
  }
  const serialized = JSON.stringify(record);
  expect(serialized.length, `${where} metadata must stay bounded (< 2 KiB)`).toBeLessThan(2048);
  assertNoVendorMarkers(serialized, `${where} metadata`);
}

/**
 * Register the FULL conformance suite for one subject. Call inside a
 * test file (registers one describe block). The subject's rail must be
 * FRESH (no prior side effects); the suite consumes its upstream.
 */
export function defineRealtimeRailConformance(subject: RealtimeRailConformanceSubject): void {
  describe(`realtime-rail conformance — ${subject.name}`, () => {
    const applicationId = "00000000-0000-7000-8000-000000000009";
    const openKey = realtimeRailOpenKey("conformance-open-0001");
    const deliverKey = realtimeRailDeliverKey("conformance-deliver-0001");
    const transferKey = realtimeRailTransferKey("conformance-transfer-0001");
    const closeKey = realtimeRailCloseKey("conformance-close-0001");
    const callerMarker = "caller-pii-marker-conformance@example.invalid";

    test("C1: the descriptor speaks the neutral vocabulary only", () => {
      const descriptor = subject.rail.descriptor;
      expect(descriptor.railCapabilityId).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(descriptor.transportClass).toBe("realtime");
      expect(descriptor.channelKinds.length).toBeGreaterThan(0);
      for (const kind of descriptor.channelKinds) {
        expect(kind).toMatch(/^[a-z][a-z0-9-]*$/);
      }
      // A rail NAMES itself (the models module's `openrouter` precedent:
      // the rail capability id is the neutral self-designation and may
      // carry the provider's name — it is NOT an SDK identifier). The
      // vendor-marker discipline applies to every OTHER descriptor
      // member and to every runtime shape below (sessions, outcomes,
      // reasons, metadata) — never to the self-designation.
      assertNoVendorMarkers(
        JSON.stringify({ channelKinds: descriptor.channelKinds }),
        "the descriptor's channel kinds",
      );
    });

    test("C2: openSession returns opaque neutral coordinates", async () => {
      const session = await subject.rail.openSession(openRequest(openKey, callerMarker));
      expect(session.channelSessionRef).toMatch(CHANNEL_REF_PATTERN);
      expect(session.channelSessionRef).not.toContain("caller-pii-marker-conformance");
      expect(session.channelEpoch).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(session.channelEpoch)).toBe(true);
      expect(session.replayed).toBe(false);
      assertNeutralMetadata(session.railMetadata, "the open acknowledgment");
    });

    test("C3 + C4: the same open key converges on one upstream channel", async () => {
      const openedBefore =
        subject.probes === undefined ? null : await subject.probes.countOpenSideEffects();
      const first = await subject.rail.openSession(openRequest(openKey, callerMarker));
      const second = await subject.rail.openSession(openRequest(openKey, callerMarker));
      expect(second.channelSessionRef).toBe(first.channelSessionRef);
      expect(second.channelEpoch).toBe(first.channelEpoch);
      expect(second.replayed).toBe(true);
      if (subject.probes !== undefined && openedBefore !== null) {
        // DELTA-BASED (the Lead's review correction): the re-opens must
        // add ZERO upstream channels — the count assertions are flow-
        // independent (a rail's world may carry other channels).
        expect(await subject.probes.countOpenSideEffects()).toBe(openedBefore);
      }
      if (subject.restart !== undefined) {
        // The crash model: the adapter process dies; the upstream (and
        // its channel identity) survives; a FRESH process re-opens
        // under the SAME key and converges — no second channel.
        const restarted = await subject.restart();
        const third = await restarted.openSession(openRequest(openKey, callerMarker));
        expect(third.channelSessionRef).toBe(first.channelSessionRef);
        expect(third.channelEpoch).toBe(first.channelEpoch);
        if (subject.probes !== undefined && openedBefore !== null) {
          expect(await subject.probes.countOpenSideEffects()).toBe(openedBefore);
        }
      }
    });

    test("C5: deliverTurn converges on the original acknowledgment", async () => {
      const deliveredBefore =
        subject.probes === undefined ? null : await subject.probes.countDeliverSideEffects();
      const session = await subject.rail.openSession(openRequest(openKey, callerMarker));
      const frame = delivery("session-0001", session.channelSessionRef, deliverKey);
      const first = await subject.rail.deliverTurn(frame);
      expect(first.delivered).toBe(true);
      if (first.delivered) {
        expect(first.replayed).toBe(false);
        expect(Number.isNaN(Date.parse(first.deliveredAt))).toBe(false);
        if (first.railMetadata !== undefined) {
          assertNeutralMetadata(first.railMetadata, "the delivery acknowledgment");
        }
      }
      const second = await subject.rail.deliverTurn(frame);
      expect(second.delivered).toBe(true);
      if (second.delivered && first.delivered) {
        expect(second.replayed).toBe(true);
        expect(second.deliveredAt).toBe(first.deliveredAt);
      }
      if (subject.probes !== undefined && deliveredBefore !== null) {
        expect(await subject.probes.countDeliverSideEffects()).toBe(deliveredBefore + 1);
      }
    });

    test("C6: transferCall converges on the original acknowledgment", async () => {
      const transferredBefore =
        subject.probes === undefined ? null : await subject.probes.countTransferSideEffects();
      const session = await subject.rail.openSession(openRequest(openKey, callerMarker));
      const frame = delivery("session-0001", session.channelSessionRef, transferKey);
      const first = await subject.rail.transferCall(frame);
      expect(first.delivered).toBe(true);
      const second = await subject.rail.transferCall(frame);
      expect(second.delivered).toBe(true);
      if (second.delivered && first.delivered) {
        expect(second.replayed).toBe(true);
        expect(second.deliveredAt).toBe(first.deliveredAt);
      }
      if (subject.probes !== undefined && transferredBefore !== null) {
        expect(await subject.probes.countTransferSideEffects()).toBe(transferredBefore + 1);
      }
    });

    test("C7: closeSession converges on the original acknowledgment", async () => {
      const closedBefore =
        subject.probes === undefined ? null : await subject.probes.countCloseSideEffects();
      const session = await subject.rail.openSession(openRequest(openKey, callerMarker));
      const reference = {
        applicationId,
        sessionId: "session-0001",
        channelSessionRef: session.channelSessionRef,
        channelEpoch: session.channelEpoch,
        idempotencyKey: closeKey,
        cause: "conformance close",
      };
      const first = await subject.rail.closeSession(reference);
      expect(first.delivered).toBe(true);
      const second = await subject.rail.closeSession(reference);
      expect(second.delivered).toBe(true);
      if (second.delivered && first.delivered) {
        expect(second.replayed).toBe(true);
        expect(second.deliveredAt).toBe(first.deliveredAt);
      }
      if (subject.probes !== undefined && closedBefore !== null) {
        expect(await subject.probes.countCloseSideEffects()).toBe(closedBefore + 1);
      }
    });

    test("C8: a distinct key is a distinct upstream effect", async () => {
      // The Lead's review correction: C8+ open under FRESH keys — a
      // delivery after C7's close would be a session-sequencing error
      // the rail contract must never rely on (the simulated world
      // tolerates it; a real server deletes the upstream channel).
      const deliveredBefore =
        subject.probes === undefined ? null : await subject.probes.countDeliverSideEffects();
      const session = await subject.rail.openSession(
        openRequest(realtimeRailOpenKey("conformance-open-0002"), callerMarker),
      );
      const frameA = delivery(
        "session-0002",
        session.channelSessionRef,
        realtimeRailDeliverKey("conformance-deliver-0002"),
      );
      const a = await subject.rail.deliverTurn(frameA);
      expect(a.delivered).toBe(true);
      if (a.delivered) {
        expect(a.replayed).toBe(false);
      }
      if (subject.probes !== undefined && deliveredBefore !== null) {
        expect(await subject.probes.countDeliverSideEffects()).toBe(deliveredBefore + 1);
      }
    });

    test("C9: a refused upstream normalizes neutrally and is never cached under the key", async () => {
      const deliveredBefore =
        subject.probes === undefined ? null : await subject.probes.countDeliverSideEffects();
      const session = await subject.rail.openSession(
        openRequest(realtimeRailOpenKey("conformance-open-0003"), callerMarker),
      );
      const frame = delivery(
        "session-0003",
        session.channelSessionRef,
        realtimeRailDeliverKey("conformance-deliver-0003"),
      );
      if (subject.armRefusal === undefined || subject.disarmRefusal === undefined) {
        return; // The subject cannot inject an upstream refusal.
      }
      await subject.armRefusal();
      const refused = await subject.rail.deliverTurn(frame);
      expect(refused.delivered).toBe(false);
      if (!refused.delivered) {
        expect(refused.reason.length).toBeGreaterThan(0);
        assertNoVendorMarkers(refused.reason, "the refusal reason");
      }
      await subject.disarmRefusal();
      const retried = await subject.rail.deliverTurn(frame);
      expect(retried.delivered).toBe(true);
      if (retried.delivered) {
        expect(retried.replayed).toBe(false);
      }
      if (subject.probes !== undefined && deliveredBefore !== null) {
        expect(await subject.probes.countDeliverSideEffects()).toBe(deliveredBefore + 1);
      }
    });

    test("C10: a refused open rejects neutrally and leaves no upstream channel", async () => {
      if (subject.supports?.openRefusal !== true) {
        return; // Optional: only subjects that can refuse an open.
      }
      if (subject.armRefusal === undefined || subject.disarmRefusal === undefined) {
        return;
      }
      const openedBefore =
        subject.probes === undefined ? null : await subject.probes.countOpenSideEffects();
      const key = realtimeRailOpenKey("conformance-open-refused-0001");
      await subject.armRefusal();
      await expect(subject.rail.openSession(openRequest(key, null))).rejects.toThrow();
      await subject.disarmRefusal();
      const session = await subject.rail.openSession(openRequest(key, null));
      expect(session.replayed).toBe(false);
      if (subject.probes !== undefined && openedBefore !== null) {
        // The refused open left NO upstream channel: exactly the one
        // successful open was added by this test.
        expect(await subject.probes.countOpenSideEffects()).toBe(openedBefore + 1);
      }
    });

    test("C11: credential canaries never cross the seam", async () => {
      const canaries = subject.secretCanaryValues ?? [];
      const session = await subject.rail.openSession(
        openRequest(realtimeRailOpenKey("conformance-open-0004"), callerMarker),
      );
      const frame = delivery(
        "session-0004",
        session.channelSessionRef,
        realtimeRailDeliverKey("conformance-deliver-0004"),
      );
      const outcome = await subject.rail.deliverTurn(frame);
      const crossing = [
        JSON.stringify(subject.rail.descriptor),
        JSON.stringify(session),
        JSON.stringify(outcome),
      ];
      for (const canary of canaries) {
        for (const shape of crossing) {
          expect(shape, "no credential material may cross the rail seam").not.toContain(canary);
        }
      }
      const followUp = await subject.rail.deliverTurn(
        delivery(
          "session-0004",
          session.channelSessionRef,
          realtimeRailDeliverKey("conformance-deliver-0005"),
        ),
      );
      expect(followUp.delivered).toBe(true);
    });

    test("C12: acknowledgments carry no fabricated facts", async () => {
      const session = await subject.rail.openSession(
        openRequest(realtimeRailOpenKey("conformance-open-0005"), callerMarker),
      );
      const outcomes: RealtimeRailDeliveryOutcome[] = [];
      const frame = delivery(
        "session-0005",
        session.channelSessionRef,
        realtimeRailDeliverKey("conformance-deliver-0006"),
      );
      outcomes.push(await subject.rail.deliverTurn(frame));
      outcomes.push(await subject.rail.transferCall(frame));
      for (const outcome of outcomes) {
        if (outcome.delivered && outcome.railMetadata !== undefined) {
          assertNeutralMetadata(outcome.railMetadata, "the acknowledgment");
        }
      }
    });
  });
}
