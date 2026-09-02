/**
 * Unit tests — the realtime voice session domain (WORK-024,
 * MOD-005/006/007).
 *
 * Pure-domain coverage of `src/modules/deployments/domain/realtime.ts`:
 * the neutral channel vocabulary, the frozen session status machine, the
 * event/route/inbound vocabularies, fail-closed validation (shape,
 * bounds, raw-secret refusal), the deterministic substitute idempotency
 * key, the session-creation fingerprint and the event body digest base.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  canTransitionRealtimeSession,
  deterministicRealtimeEventKey,
  isRealtimeChannelKind,
  isRealtimeEventKind,
  isRealtimeInboundKind,
  isRealtimeRouteClass,
  isRealtimeSessionStatus,
  isTerminalRealtimeSessionStatus,
  REALTIME_CHANNEL_KINDS,
  REALTIME_EVENT_KINDS,
  REALTIME_INBOUND_KINDS,
  REALTIME_ROUTE_CLASSES,
  REALTIME_SESSION_STATUSES,
  REALTIME_SESSION_TRANSITIONS,
  realtimeContainsRawSecretValue,
  realtimeEventBodyDigestBase,
  realtimeSessionCreationFingerprint,
  validateRealtimeInboundEvent,
  validateStartRealtimeSessionInput,
} from "../../../src/modules/deployments/public";

const UUID = "00000000-0000-7000-8000-0000000000d1";
const DEPLOYMENT = "00000000-0000-7000-8000-0000000000d4";

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");

describe("realtime domain vocabularies (MOD-005 neutrality)", () => {
  test("the channel vocabulary is exactly the realtime-capable neutral kinds", () => {
    expect([...REALTIME_CHANNEL_KINDS]).toEqual(["web", "in-app", "telephony"]);
    expect(isRealtimeChannelKind("web")).toBe(true);
    expect(isRealtimeChannelKind("in-app")).toBe(true);
    expect(isRealtimeChannelKind("telephony")).toBe(true);
    // Vendor/transport words are NOT channel kinds.
    for (const alien of ["twilio", "livekit", "vonage", "sms", "email", "websocket"]) {
      expect(isRealtimeChannelKind(alien)).toBe(false);
    }
  });

  test("the session status vocabulary and transitions are frozen", () => {
    expect([...REALTIME_SESSION_STATUSES]).toEqual([
      "live",
      "reconnecting",
      "closed",
      "failed",
      "transferred",
    ]);
    expect(REALTIME_SESSION_TRANSITIONS.live).toContain("reconnecting");
    expect(REALTIME_SESSION_TRANSITIONS.reconnecting).toContain("live");
    expect(REALTIME_SESSION_TRANSITIONS.closed).toEqual([]);
    expect(REALTIME_SESSION_TRANSITIONS.failed).toEqual([]);
    expect(REALTIME_SESSION_TRANSITIONS.transferred).toEqual([]);
    expect(isTerminalRealtimeSessionStatus("closed")).toBe(true);
    expect(isTerminalRealtimeSessionStatus("failed")).toBe(true);
    expect(isTerminalRealtimeSessionStatus("transferred")).toBe(true);
    expect(isTerminalRealtimeSessionStatus("live")).toBe(false);
    expect(canTransitionRealtimeSession("live", "closed")).toBe(true);
    expect(canTransitionRealtimeSession("live", "transferred")).toBe(true);
    expect(canTransitionRealtimeSession("closed", "live")).toBe(false);
    expect(canTransitionRealtimeSession("transferred", "live")).toBe(false);
    expect(canTransitionRealtimeSession("reconnecting", "transferred")).toBe(false);
  });

  test("the event, inbound and route-class vocabularies are frozen", () => {
    expect([...REALTIME_EVENT_KINDS]).toEqual([
      "session-started",
      "session-reattached",
      "session-completed",
      "session-failed",
      "turn-recorded",
      "interruption-recorded",
      "transfer-recorded",
      "failure-recorded",
    ]);
    expect([...REALTIME_INBOUND_KINDS]).toEqual(["user-turn", "interruption", "caller-hangup"]);
    expect([...REALTIME_ROUTE_CLASSES]).toEqual(["deterministic", "hybrid", "generative"]);
    for (const kind of REALTIME_EVENT_KINDS) {
      expect(isRealtimeEventKind(kind)).toBe(true);
    }
    for (const kind of REALTIME_INBOUND_KINDS) {
      expect(isRealtimeInboundKind(kind)).toBe(true);
    }
    for (const klass of REALTIME_ROUTE_CLASSES) {
      expect(isRealtimeRouteClass(klass)).toBe(true);
    }
    expect(isRealtimeEventKind("ledger-appended")).toBe(false);
    expect(isRealtimeInboundKind("vendor-event")).toBe(false);
    expect(isRealtimeRouteClass("model-based")).toBe(false);
  });

  test("the raw-secret refusal pattern (the WORK-011 nine-pattern discipline)", () => {
    for (const poisoned of [
      "sk-abcdefghijklmnopqrst",
      "AKIAABCDEFGHIJKLMNOP",
      "ghp_abcdefghijklmnopqrst",
      "xoxb-1234567890abcdef",
      "-----BEGIN RSA PRIVATE KEY-----",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.KxS",
      "bearer abcdefghijklmnop",
      "api_key: supersecretvalue",
    ]) {
      expect(realtimeContainsRawSecretValue(poisoned)).toBe(true);
    }
    expect(realtimeContainsRawSecretValue("transfer to support queue")).toBe(false);
    expect(realtimeContainsRawSecretValue("simrail-session-7")).toBe(false);
  });
});

describe("validateStartRealtimeSessionInput (fail-closed)", () => {
  const valid = {
    deploymentId: DEPLOYMENT,
    channelKind: "web",
    channelSessionRef: "simrail-session-1",
  };

  test("accepts the minimal start and every neutral channel kind", () => {
    expect(validateStartRealtimeSessionInput(valid)).toEqual({ valid: true });
    expect(validateStartRealtimeSessionInput({ ...valid, channelKind: "telephony" })).toEqual({
      valid: true,
    });
    expect(
      validateStartRealtimeSessionInput({ ...valid, channelKind: "in-app", callerRef: "+1555" }),
    ).toEqual({ valid: true });
  });

  test("rejects non-objects, bad deployment ids and non-neutral channel kinds", () => {
    expect(validateStartRealtimeSessionInput(null).valid).toBe(false);
    expect(validateStartRealtimeSessionInput("nope").valid).toBe(false);
    expect(validateStartRealtimeSessionInput([]).valid).toBe(false);
    expect(validateStartRealtimeSessionInput({ ...valid, deploymentId: "not-a-uuid" }).valid).toBe(
      false,
    );
    expect(validateStartRealtimeSessionInput({ ...valid, channelKind: "sms" }).valid).toBe(false);
    expect(validateStartRealtimeSessionInput({ ...valid, channelKind: "twilio" }).valid).toBe(
      false,
    );
  });

  test("rejects malformed channel references and caller refs", () => {
    expect(validateStartRealtimeSessionInput({ ...valid, channelSessionRef: "" }).valid).toBe(
      false,
    );
    expect(
      validateStartRealtimeSessionInput({
        ...valid,
        channelSessionRef: `x${"a".repeat(200)}`,
      }).valid,
    ).toBe(false);
    expect(
      validateStartRealtimeSessionInput({ ...valid, channelSessionRef: "has space" }).valid,
    ).toBe(false);
    expect(validateStartRealtimeSessionInput({ ...valid, callerRef: "" }).valid).toBe(false);
    expect(validateStartRealtimeSessionInput({ ...valid, callerRef: "x".repeat(201) }).valid).toBe(
      false,
    );
  });

  test("rejects raw-secret-looking free text and oversized payload refs", () => {
    expect(
      validateStartRealtimeSessionInput({ ...valid, callerRef: "sk-abcdefghijklmnopqrst" }).valid,
    ).toBe(false);
    expect(
      validateStartRealtimeSessionInput({
        ...valid,
        initialPayloadRef: `artifact:${"a".repeat(600)}`,
      }).valid,
    ).toBe(false);
  });
});

describe("validateRealtimeInboundEvent (fail-closed)", () => {
  const valid = {
    sessionId: UUID,
    channelSessionRef: "simrail-session-1",
    channelEpoch: 1,
    kind: "user-turn" as const,
  };

  test("accepts the minimal event and every inbound kind", () => {
    expect(validateRealtimeInboundEvent(valid)).toEqual({ valid: true });
    expect(validateRealtimeInboundEvent({ ...valid, kind: "interruption" })).toEqual({
      valid: true,
    });
    expect(validateRealtimeInboundEvent({ ...valid, kind: "caller-hangup" })).toEqual({
      valid: true,
    });
  });

  test("rejects bad session ids, epochs and kinds", () => {
    expect(validateRealtimeInboundEvent({ ...valid, sessionId: "42" }).valid).toBe(false);
    expect(validateRealtimeInboundEvent({ ...valid, channelEpoch: 0 }).valid).toBe(false);
    expect(validateRealtimeInboundEvent({ ...valid, channelEpoch: 1.5 }).valid).toBe(false);
    expect(validateRealtimeInboundEvent({ ...valid, kind: "vendor-event" }).valid).toBe(false);
  });

  test("rejects malformed event keys, ordinals, previews and refs", () => {
    expect(validateRealtimeInboundEvent({ ...valid, eventKey: "" }).valid).toBe(false);
    expect(validateRealtimeInboundEvent({ ...valid, eventKey: "x".repeat(201) }).valid).toBe(false);
    expect(validateRealtimeInboundEvent({ ...valid, occurrenceOrdinal: 0 }).valid).toBe(false);
    expect(validateRealtimeInboundEvent({ ...valid, occurrenceOrdinal: 2.25 }).valid).toBe(false);
    expect(validateRealtimeInboundEvent({ ...valid, payloadPreview: "x".repeat(513) }).valid).toBe(
      false,
    );
    expect(validateRealtimeInboundEvent({ ...valid, payloadRef: "x".repeat(513) }).valid).toBe(
      false,
    );
  });

  test("rejects non-slug subtask kinds and raw-secret-looking fields", () => {
    expect(validateRealtimeInboundEvent({ ...valid, subtaskKind: "Data Retrieval" }).valid).toBe(
      false,
    );
    expect(validateRealtimeInboundEvent({ ...valid, subtaskKind: "x".repeat(65) }).valid).toBe(
      false,
    );
    expect(validateRealtimeInboundEvent({ ...valid, subtaskKind: "data-retrieval" })).toEqual({
      valid: true,
    });
    expect(
      validateRealtimeInboundEvent({ ...valid, payloadPreview: "password: hunter2secret" }).valid,
    ).toBe(false);
    expect(
      validateRealtimeInboundEvent({ ...valid, eventKey: "sk-abcdefghijklmnopqrst" }).valid,
    ).toBe(false);
  });
});

describe("deterministic idempotency (the work order's implementation requirement)", () => {
  test("the deterministic substitute key is stable and discriminating", () => {
    const base = {
      sessionId: UUID,
      channelEpoch: 1,
      kind: "user-turn" as const,
      occurrenceOrdinal: 1,
    };
    expect(deterministicRealtimeEventKey(base)).toBe(deterministicRealtimeEventKey(base));
    expect(deterministicRealtimeEventKey(base)).not.toBe(
      deterministicRealtimeEventKey({ ...base, occurrenceOrdinal: 2 }),
    );
    expect(deterministicRealtimeEventKey(base)).not.toBe(
      deterministicRealtimeEventKey({ ...base, channelEpoch: 2 }),
    );
    expect(deterministicRealtimeEventKey(base)).not.toBe(
      deterministicRealtimeEventKey({ ...base, kind: "interruption" }),
    );
    expect(deterministicRealtimeEventKey(base)).toContain(UUID);
  });

  test("the session-creation fingerprint binds the identity coordinates", () => {
    const input = {
      deploymentId: DEPLOYMENT,
      channelKind: "web" as const,
      channelSessionRef: "simrail-session-1",
    };
    const executionA = "00000000-0000-7000-8000-0000000000e1";
    const executionB = "00000000-0000-7000-8000-0000000000e2";
    const a = realtimeSessionCreationFingerprint(UUID, input, executionA);
    expect(a).toBe(realtimeSessionCreationFingerprint(UUID, input, executionA));
    expect(a).not.toBe(realtimeSessionCreationFingerprint(UUID, input, executionB));
    expect(a).not.toBe(
      realtimeSessionCreationFingerprint("00000000-0000-7000-8000-0000000000e3", input, executionA),
    );
    // Optional fields are folded deterministically.
    const withCaller = realtimeSessionCreationFingerprint(
      UUID,
      { ...input, callerRef: "caller-1" },
      executionA,
    );
    expect(withCaller).not.toBe(a);
  });

  test("the event body digest base is stable and discriminating", () => {
    const base = {
      sessionId: UUID,
      kind: "turn-recorded" as const,
      direction: "inbound" as const,
      eventKey: "rt-key-1",
      payloadRef: null,
      payloadPreview: null,
    };
    const d1 = digest(realtimeEventBodyDigestBase(base));
    expect(d1).toBe(digest(realtimeEventBodyDigestBase(base)));
    expect(d1).not.toBe(
      digest(realtimeEventBodyDigestBase({ ...base, payloadPreview: "different turn text" })),
    );
    expect(d1).not.toBe(digest(realtimeEventBodyDigestBase({ ...base, eventKey: "rt-key-2" })));
  });
});
