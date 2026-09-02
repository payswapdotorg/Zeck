/**
 * Unit tests — the provider-neutral conversational messaging domain
 * (WORK-025, MOD-008/MOD-009).
 *
 * Pure-domain coverage of
 * `src/modules/deployments/domain/messaging.ts`: the neutral channel
 * vocabulary, the frozen conversation status machine, the
 * ordering-mode/marker vocabularies (the explicit channel-contract
 * ordering semantics), the message/delivery vocabularies, fail-closed
 * validation (shape, bounds, attachment references, raw-secret
 * refusal), the deterministic substitute idempotency keys, the
 * conversation-creation fingerprint and the message body digest base.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  canTransitionMessagingConversation,
  deterministicMessagingCallbackKey,
  deterministicMessagingEventKey,
  isForwardMessagingDeliveryMove,
  isMessagingCallbackStatus,
  isMessagingChannelKind,
  isMessagingOrderingMode,
  isTerminalMessagingConversationStatus,
  isTerminalMessagingDeliveryStatus,
  MESSAGING_CHANNEL_KINDS,
  MESSAGING_CONVERSATION_STATUSES,
  MESSAGING_CONVERSATION_TRANSITIONS,
  MESSAGING_DELIVERY_STATUSES,
  MESSAGING_MESSAGE_KINDS,
  MESSAGING_ORDERING_MARKERS,
  MESSAGING_ORDERING_MODES,
  MESSAGING_ROUTE_CLASSES,
  messagingContainsRawSecretValue,
  messagingConversationCreationFingerprint,
  messagingMessageBodyDigestBase,
  messagingOperationKey,
  messagingRailCloseKey,
  messagingRailEscalateKey,
  messagingRailOpenKey,
  messagingRailSendKey,
  resolveMessagingOrdering,
  validateMessagingDeliveryCallback,
  validateMessagingInboundEvent,
  validateStartMessagingConversationInput,
} from "../../../src/modules/deployments/public";

const UUID = "00000000-0000-7000-8000-0000000000d1";
const DEPLOYMENT = "00000000-0000-7000-8000-0000000000d4";

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");

describe("messaging domain vocabularies (MOD-008 neutrality)", () => {
  test("the channel vocabulary is exactly the messaging-capable neutral kinds", () => {
    expect([...MESSAGING_CHANNEL_KINDS]).toEqual(["sms", "email", "web", "in-app"]);
    for (const kind of MESSAGING_CHANNEL_KINDS) {
      expect(isMessagingChannelKind(kind)).toBe(true);
    }
    // Vendor/channel words are NOT channel kinds.
    for (const alien of [
      "twilio",
      "slack",
      "whatsapp",
      "telegram",
      "vonage",
      "messenger",
      "intercom",
      "zendesk",
      "sunshine",
      "telephony",
    ]) {
      expect(isMessagingChannelKind(alien)).toBe(false);
    }
  });

  test("the conversation status vocabulary and transitions are frozen", () => {
    expect([...MESSAGING_CONVERSATION_STATUSES]).toEqual(["active", "closed"]);
    expect(MESSAGING_CONVERSATION_TRANSITIONS.active).toEqual(["active", "closed"]);
    expect(MESSAGING_CONVERSATION_TRANSITIONS.closed).toEqual([]);
    expect(isTerminalMessagingConversationStatus("closed")).toBe(true);
    expect(isTerminalMessagingConversationStatus("active")).toBe(false);
    expect(canTransitionMessagingConversation("active", "closed")).toBe(true);
    expect(canTransitionMessagingConversation("closed", "active")).toBe(false);
  });

  test("the ordering-mode vocabulary is the explicit channel-contract semantics", () => {
    expect([...MESSAGING_ORDERING_MODES]).toEqual(["thread-sequenced", "unordered"]);
    expect(isMessagingOrderingMode("thread-sequenced")).toBe(true);
    expect(isMessagingOrderingMode("unordered")).toBe(true);
    expect(isMessagingOrderingMode("globally-ordered")).toBe(false);
    expect([...MESSAGING_ORDERING_MARKERS]).toEqual([
      "in-order",
      "out-of-order",
      "gap",
      "assigned",
    ]);
  });

  test("the message-kind and delivery-status vocabularies are frozen", () => {
    expect([...MESSAGING_MESSAGE_KINDS]).toEqual(["user-message", "agent-reply", "system-marker"]);
    expect([...MESSAGING_DELIVERY_STATUSES]).toEqual([
      "pending",
      "sent",
      "delivered",
      "undelivered",
    ]);
    expect([...MESSAGING_ROUTE_CLASSES]).toEqual(["deterministic", "hybrid", "generative"]);
    // The delivery vocabulary is monotonic: forward moves only.
    expect(isForwardMessagingDeliveryMove("pending", "sent")).toBe(true);
    expect(isForwardMessagingDeliveryMove("sent", "delivered")).toBe(true);
    expect(isForwardMessagingDeliveryMove("sent", "undelivered")).toBe(true);
    expect(isForwardMessagingDeliveryMove("pending", "delivered")).toBe(true);
    expect(isForwardMessagingDeliveryMove("delivered", "sent")).toBe(false);
    expect(isForwardMessagingDeliveryMove("undelivered", "delivered")).toBe(false);
    expect(isTerminalMessagingDeliveryStatus("delivered")).toBe(true);
    expect(isTerminalMessagingDeliveryStatus("undelivered")).toBe(true);
    expect(isTerminalMessagingDeliveryStatus("sent")).toBe(false);
    expect(isTerminalMessagingDeliveryStatus("pending")).toBe(false);
    // The callback vocabulary reports evidence transitions only — a
    // callback can never set the pre-send state.
    for (const status of ["sent", "delivered", "undelivered"]) {
      expect(isMessagingCallbackStatus(status)).toBe(true);
    }
    expect(isMessagingCallbackStatus("pending")).toBe(false);
  });

  test("the raw-secret refusal pattern (the WORK-011 nine-pattern discipline)", () => {
    for (const secret of [
      "sk-abcdefghij1234567890",
      "AKIA1234567890ABCDEF",
      "ghp_abcdefghijklmnopqrst",
      "xoxb-1234567890abcdef",
      "-----BEGIN RSA PRIVATE KEY-----",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV",
      "bearer abcdefghijklmnop",
      "password: supersecretvalue",
    ]) {
      expect(messagingContainsRawSecretValue(secret)).toBe(true);
    }
    for (const benign of ["hello", "order 42", "conversation about keys", "token count: 3"]) {
      expect(messagingContainsRawSecretValue(benign)).toBe(false);
    }
  });
});

describe("validateStartMessagingConversationInput (fail-closed)", () => {
  const valid = {
    deploymentId: DEPLOYMENT,
    channelKind: "sms",
  };

  test("accepts the minimal start and every neutral channel kind", () => {
    expect(validateStartMessagingConversationInput(valid).valid).toBe(true);
    for (const kind of MESSAGING_CHANNEL_KINDS) {
      expect(validateStartMessagingConversationInput({ ...valid, channelKind: kind }).valid).toBe(
        true,
      );
    }
    expect(
      validateStartMessagingConversationInput({
        ...valid,
        channelConversationRef: "thread-ref-1",
        orderingMode: "thread-sequenced",
        participantRef: "participant-7",
        initialPayloadRef: "artifact:welcome/1",
      }).valid,
    ).toBe(true);
  });

  test("rejects non-objects, bad deployment ids and non-neutral channel kinds", () => {
    expect(validateStartMessagingConversationInput(null).valid).toBe(false);
    expect(validateStartMessagingConversationInput("x").valid).toBe(false);
    expect(validateStartMessagingConversationInput({ ...valid, deploymentId: "nope" }).valid).toBe(
      false,
    );
    expect(
      validateStartMessagingConversationInput({ ...valid, channelKind: "whatsapp" }).valid,
    ).toBe(false);
    expect(
      validateStartMessagingConversationInput({ ...valid, orderingMode: "global" }).valid,
    ).toBe(false);
  });

  test("rejects malformed conversation references and participant refs", () => {
    expect(
      validateStartMessagingConversationInput({ ...valid, channelConversationRef: "" }).valid,
    ).toBe(false);
    expect(
      validateStartMessagingConversationInput({ ...valid, channelConversationRef: "a".repeat(201) })
        .valid,
    ).toBe(false);
    expect(
      validateStartMessagingConversationInput({ ...valid, channelConversationRef: "has space" })
        .valid,
    ).toBe(false);
    expect(validateStartMessagingConversationInput({ ...valid, participantRef: "" }).valid).toBe(
      false,
    );
  });

  test("rejects raw-secret-looking free text and oversized payload refs", () => {
    expect(
      validateStartMessagingConversationInput({
        ...valid,
        participantRef: "sk-abcdefghij1234567890",
      }).valid,
    ).toBe(false);
    expect(
      validateStartMessagingConversationInput({
        ...valid,
        initialPayloadRef: "x".repeat(513),
      }).valid,
    ).toBe(false);
  });
});

describe("validateMessagingInboundEvent (fail-closed)", () => {
  const valid = {
    conversationId: UUID,
    payloadPreview: "customer question",
  };

  test("accepts the minimal event with upstream ids, threads and sequences", () => {
    expect(validateMessagingInboundEvent(valid).valid).toBe(true);
    expect(
      validateMessagingInboundEvent({
        ...valid,
        eventKey: "upstream-evt-42",
        channelMessageRef: "msg-ref-42",
        threadRef: "thread-7",
        threadSequence: 3,
        occurrenceOrdinal: 2,
        subtaskKind: "data-retrieval",
        payloadRef: "artifact:inbound/9",
        attachments: ["artifact:attach/1", "artifact:attach/2"],
      }).valid,
    ).toBe(true);
  });

  test("rejects bad conversation ids, keys, threads and sequences", () => {
    expect(validateMessagingInboundEvent({ ...valid, conversationId: "nope" }).valid).toBe(false);
    expect(validateMessagingInboundEvent({ ...valid, eventKey: "" }).valid).toBe(false);
    expect(validateMessagingInboundEvent({ ...valid, eventKey: "k".repeat(201) }).valid).toBe(
      false,
    );
    expect(validateMessagingInboundEvent({ ...valid, threadRef: "has space" }).valid).toBe(false);
    expect(validateMessagingInboundEvent({ ...valid, threadSequence: 0 }).valid).toBe(false);
    expect(validateMessagingInboundEvent({ ...valid, threadSequence: 1.5 }).valid).toBe(false);
    expect(validateMessagingInboundEvent({ ...valid, occurrenceOrdinal: -1 }).valid).toBe(false);
    expect(validateMessagingInboundEvent({ ...valid, subtaskKind: "Not A Slug" }).valid).toBe(
      false,
    );
  });

  test("rejects oversized previews/refs, malformed attachments and secret-looking fields", () => {
    expect(validateMessagingInboundEvent({ ...valid, payloadPreview: "x".repeat(513) }).valid).toBe(
      false,
    );
    expect(validateMessagingInboundEvent({ ...valid, payloadRef: "x".repeat(513) }).valid).toBe(
      false,
    );
    expect(validateMessagingInboundEvent({ ...valid, attachments: ["x".repeat(513)] }).valid).toBe(
      false,
    );
    expect(
      validateMessagingInboundEvent({ ...valid, attachments: Array.from({ length: 9 }, () => "a") })
        .valid,
    ).toBe(false);
    expect(
      validateMessagingInboundEvent({ ...valid, attachments: ["sk-abcdefghij1234567890"] }).valid,
    ).toBe(false);
    expect(
      validateMessagingInboundEvent({ ...valid, payloadPreview: "bearer abcdefghijklmnop" }).valid,
    ).toBe(false);
  });
});

describe("validateMessagingDeliveryCallback (fail-closed)", () => {
  const valid = {
    conversationId: UUID,
    messageKey: "evt-1:reply",
    status: "delivered" as const,
  };

  test("accepts the correlated callback shapes", () => {
    expect(validateMessagingDeliveryCallback(valid).valid).toBe(true);
    for (const status of ["sent", "delivered", "undelivered"] as const) {
      expect(validateMessagingDeliveryCallback({ ...valid, status }).valid).toBe(true);
    }
    expect(
      validateMessagingDeliveryCallback({
        ...valid,
        channelMessageRef: "msg-ref-42",
        callbackKey: "cbk-9",
        detail: "accepted by carrier",
      }).valid,
    ).toBe(true);
  });

  test("rejects bad correlation coordinates and non-evidence statuses", () => {
    expect(validateMessagingDeliveryCallback({ ...valid, conversationId: "x" }).valid).toBe(false);
    expect(validateMessagingDeliveryCallback({ ...valid, messageKey: "" }).valid).toBe(false);
    expect(validateMessagingDeliveryCallback({ ...valid, messageKey: "has spaces!" }).valid).toBe(
      false,
    );
    expect(validateMessagingDeliveryCallback({ ...valid, status: "pending" }).valid).toBe(false);
    expect(
      validateMessagingDeliveryCallback({ ...valid, channelMessageRef: "x".repeat(201) }).valid,
    ).toBe(false);
    expect(validateMessagingDeliveryCallback({ ...valid, detail: "x".repeat(2001) }).valid).toBe(
      false,
    );
    expect(
      validateMessagingDeliveryCallback({ ...valid, detail: "password: hunter2secret" }).valid,
    ).toBe(false);
  });
});

describe("the explicit ordering semantics (resolveMessagingOrdering)", () => {
  test("thread-sequenced channels mark in-order, out-of-order and gap arrivals", () => {
    expect(
      resolveMessagingOrdering({
        orderingMode: "thread-sequenced",
        threadRef: "t1",
        threadSequence: 1,
        maxThreadSequence: 0,
        threadMessageCount: 0,
      }),
    ).toEqual({ threadSequence: 1, marker: "in-order" });
    expect(
      resolveMessagingOrdering({
        orderingMode: "thread-sequenced",
        threadRef: "t1",
        threadSequence: 3,
        maxThreadSequence: 2,
        threadMessageCount: 2,
      }),
    ).toEqual({ threadSequence: 3, marker: "in-order" });
    expect(
      resolveMessagingOrdering({
        orderingMode: "thread-sequenced",
        threadRef: "t1",
        threadSequence: 1,
        maxThreadSequence: 5,
        threadMessageCount: 5,
      }),
    ).toEqual({ threadSequence: 1, marker: "out-of-order" });
    expect(
      resolveMessagingOrdering({
        orderingMode: "thread-sequenced",
        threadRef: "t1",
        threadSequence: 9,
        maxThreadSequence: 2,
        threadMessageCount: 2,
      }),
    ).toEqual({ threadSequence: 9, marker: "gap" });
  });

  test("unordered channels assign the deterministic arrival ordinal (never an assumed global order)", () => {
    expect(
      resolveMessagingOrdering({
        orderingMode: "unordered",
        threadRef: null,
        threadSequence: null,
        maxThreadSequence: 0,
        threadMessageCount: 0,
      }),
    ).toEqual({ threadSequence: 1, marker: "assigned" });
    expect(
      resolveMessagingOrdering({
        orderingMode: "unordered",
        threadRef: null,
        threadSequence: 999,
        maxThreadSequence: 0,
        threadMessageCount: 4,
      }),
    ).toEqual({ threadSequence: 5, marker: "assigned" });
  });
});

describe("deterministic idempotency (the work order's implementation requirement)", () => {
  test("the deterministic substitute event key is stable and discriminating", () => {
    const key = deterministicMessagingEventKey({
      conversationId: UUID,
      threadRef: "t1",
      occurrenceOrdinal: 3,
    });
    expect(key).toBe(
      deterministicMessagingEventKey({
        conversationId: UUID,
        threadRef: "t1",
        occurrenceOrdinal: 3,
      }),
    );
    expect(key).not.toBe(
      deterministicMessagingEventKey({
        conversationId: UUID,
        threadRef: "t1",
        occurrenceOrdinal: 4,
      }),
    );
    expect(key).not.toBe(
      deterministicMessagingEventKey({
        conversationId: "00000000-0000-7000-8000-0000000000d2",
        threadRef: "t1",
        occurrenceOrdinal: 3,
      }),
    );
    expect(key).not.toBe(
      deterministicMessagingEventKey({
        conversationId: UUID,
        threadRef: "t2",
        occurrenceOrdinal: 3,
      }),
    );
    // The root thread is a stable discriminator.
    expect(
      deterministicMessagingEventKey({
        conversationId: UUID,
        threadRef: null,
        occurrenceOrdinal: 1,
      }),
    ).toBe(`msg-${UUID}-root-1`);
  });

  test("the deterministic callback key is stable and discriminating", () => {
    const key = deterministicMessagingCallbackKey({
      conversationId: UUID,
      messageKey: "evt-1:reply",
      status: "delivered",
    });
    expect(key).toBe(`dlv-${UUID}-evt-1:reply-delivered`);
    expect(key).not.toBe(
      deterministicMessagingCallbackKey({
        conversationId: UUID,
        messageKey: "evt-1:reply",
        status: "undelivered",
      }),
    );
  });

  test("the conversation-creation fingerprint binds the identity coordinates", () => {
    const input = {
      deploymentId: DEPLOYMENT,
      channelKind: "sms" as const,
      channelConversationRef: "thread-ref-1",
      participantRef: "participant-7",
    };
    const execution = "00000000-0000-7000-8000-0000000000d5";
    const fingerprint = messagingConversationCreationFingerprint(UUID, input, execution);
    expect(fingerprint).toBe(messagingConversationCreationFingerprint(UUID, input, execution));
    expect(fingerprint).not.toBe(
      messagingConversationCreationFingerprint(UUID, { ...input, channelKind: "email" }, execution),
    );
    expect(fingerprint).not.toBe(
      messagingConversationCreationFingerprint(
        "00000000-0000-7000-8000-0000000000d2",
        input,
        execution,
      ),
    );
    expect(fingerprint).not.toBe(
      messagingConversationCreationFingerprint(UUID, input, "00000000-0000-7000-8000-0000000000d6"),
    );
    // The default ordering mode is part of the identity arbitration.
    expect(messagingConversationCreationFingerprint(UUID, input, execution)).not.toBe(
      messagingConversationCreationFingerprint(
        UUID,
        { ...input, orderingMode: "thread-sequenced" },
        execution,
      ),
    );
  });

  test("the message body digest base is stable and discriminating", () => {
    const base = messagingMessageBodyDigestBase({
      conversationId: UUID,
      kind: "user-message",
      direction: "inbound",
      eventKey: "evt-1",
      payloadRef: "artifact:1",
      payloadPreview: "hello",
    });
    expect(digest(base)).toBe(
      digest(
        messagingMessageBodyDigestBase({
          conversationId: UUID,
          kind: "user-message",
          direction: "inbound",
          eventKey: "evt-1",
          payloadRef: "artifact:1",
          payloadPreview: "hello",
        }),
      ),
    );
    expect(digest(base)).not.toBe(
      digest(
        messagingMessageBodyDigestBase({
          conversationId: UUID,
          kind: "user-message",
          direction: "inbound",
          eventKey: "evt-2",
          payloadRef: "artifact:1",
          payloadPreview: "hello",
        }),
      ),
    );
  });
});

describe("the stable rail-level idempotency keys (the WORK-024 crash-safety standard)", () => {
  test("the four rail keys are distinct per operation kind and discriminating", () => {
    expect(messagingRailOpenKey("start-1")).toBe("msgrail:open:start-1");
    expect(messagingRailSendKey("conv:evt-1")).toBe("msgrail:send:conv:evt-1");
    expect(messagingRailEscalateKey("esc-1")).toBe("msgrail:escalate:esc-1");
    expect(messagingRailCloseKey("close-1")).toBe("msgrail:close:close-1");
    const keys = [
      messagingRailOpenKey("k"),
      messagingRailSendKey("k"),
      messagingRailEscalateKey("k"),
      messagingRailCloseKey("k"),
    ];
    expect(new Set(keys).size).toBe(4);
    expect(messagingRailSendKey("conv:evt-1")).not.toBe(messagingRailSendKey("conv:evt-2"));
  });

  test("the durable operation key carries the operation kind and discriminator", () => {
    expect(messagingOperationKey("turn-reply", "conv:evt-1")).toBe("msgop:turn-reply:conv:evt-1");
    expect(messagingOperationKey("turn-reply", "conv:evt-1")).not.toBe(
      messagingOperationKey("turn-reply", "conv:evt-2"),
    );
    expect(messagingOperationKey("turn-reply", "conv:evt-1")).not.toBe(
      messagingOperationKey("delivery-apply", "conv:evt-1"),
    );
  });
});
