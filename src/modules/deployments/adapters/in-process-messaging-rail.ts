/**
 * In-process simulated messaging rail (deployments module adapter;
 * WORK-025, MOD-008/AC2 — the upstream-rail integration adapter).
 *
 * A CONVERSATIONAL MESSAGING upstream rail simulated fully in process:
 * it implements the provider-neutral `MessagingRail` seam exactly like
 * a real messaging-channel adapter would (opaque conversation/message
 * references, per-key idempotent sends, delivery callback frames,
 * human-escalation notices, close) and records every observable
 * transport side effect for the test suites' discrimination proofs
 * (which sends happened, in what order, with what frames).
 *
 * STABLE RAIL-LEVEL IDEMPOTENCY KEYS (the WORK-024 crash-safety
 * standard): every side-effect method converges on its
 * `(application, idempotencyKey)` — the FIRST call under a key
 * performs the upstream side effect and is remembered; ANY later call
 * under the SAME key returns the ORIGINAL acknowledgment with
 * `replayed: true` and records NO second side effect (the `sends`
 * observable shows exactly one entry per logical key). This is the
 * in-memory twin of a real provider's server-side idempotency-key
 * semantics: the provider survives a Zeck process crash, so the key
 * ledger is deliberately kept on the rail (which models the external
 * world), not in the crashing process. A REFUSAL (failure injection)
 * is not a side effect and is never cached under the key — a retry
 * under the same key may succeed.
 *
 * PROVIDER-INTEGRATION HONESTY: this sandbox has NO external messaging
 * provider credentials and no guaranteed egress, so no real provider
 * call is made or claimed. All rail behavior verified by this
 * repository's tests is the SIMULATED in-process rail behind the
 * neutral seam; REAL external messaging provider behavior (network
 * transport, carrier acceptance, webhook delivery/retry from a real
 * rail, credential materialization inside a vendor adapter) is
 * explicitly UNVERIFIED and documented as such in
 * docs/work-items/WORK-025.md. Replacing this adapter with a real
 * vendor adapter requires no change to any core contract (the seam is
 * the boundary).
 */

import type {
  MessagingRail,
  MessagingRailConversation,
  MessagingRailConversationRequest,
  MessagingRailEscalationRequest,
  MessagingRailSendOutcome,
  MessagingRailSendRequest,
} from "../ports/messaging-rail";

/** One recorded transport side effect (the test observable). */
export interface SimulatedMessagingRailRecord {
  readonly kind: "open" | "send" | "escalate" | "close";
  readonly applicationId: string;
  readonly conversationId: string | null;
  readonly channelConversationRef: string;
  readonly messageKey: string | null;
  /** The stable rail-level idempotency key that produced this effect. */
  readonly idempotencyKey: string;
  readonly payloadPreview: string | null;
  readonly destination: string | null;
  readonly cause: string | null;
  readonly at: string;
}

/** One key-converged replay (the idempotency observable). */
export interface SimulatedMessagingRailReplayRecord {
  readonly kind: "open" | "send" | "escalate" | "close";
  readonly idempotencyKey: string;
  readonly at: string;
}

export interface InProcessMessagingRailOptions {
  /** Deterministic conversation-reference allocator (defaults to an ordinal sequence). */
  readonly allocateConversationRef?: () => string;
  /** Deterministic message-reference allocator (defaults to an ordinal sequence). */
  readonly allocateMessageRef?: () => string;
  readonly now?: () => Date;
  /** When set, every send fails with this reason (failure-injection tests). */
  readonly failSends?: string;
}

export function createInProcessMessagingRail(
  channelKinds: readonly string[] = ["sms", "email", "web", "in-app"],
  options: InProcessMessagingRailOptions = {},
): MessagingRail & {
  /** The recorded transport side effects, in order (the test observable). */
  readonly sends: readonly SimulatedMessagingRailRecord[];
  /** The key-converged replays, in order (the idempotency observable). */
  readonly replays: readonly SimulatedMessagingRailReplayRecord[];
  /** Fail the NEXT send once (failure injection). */
  failNextSend(reason: string): void;
  /** How many DISTINCT conversations the rail opened (per idempotency key). */
  readonly openedConversations: number;
  /** How many DISTINCT messages the rail accepted (per idempotency key). */
  readonly acceptedSends: number;
} {
  const records: SimulatedMessagingRailRecord[] = [];
  const replays: SimulatedMessagingRailReplayRecord[] = [];
  const now = options.now ?? (() => new Date());
  let conversationOrdinal = 0;
  let messageOrdinal = 0;
  let opened = 0;
  let accepted = 0;
  let failNext: string | null = null;
  const allocateConversationRef =
    options.allocateConversationRef ??
    (() => {
      conversationOrdinal += 1;
      return `simmsg-conversation-${conversationOrdinal}`;
    });
  const allocateMessageRef =
    options.allocateMessageRef ??
    (() => {
      messageOrdinal += 1;
      return `simmsg-message-${messageOrdinal}`;
    });

  // The provider-side idempotency ledgers: key -> the original effect.
  const opensByKey = new Map<string, MessagingRailConversation>();
  const sendOutcomesByKey = new Map<
    string,
    {
      readonly kind: "send" | "escalate" | "close";
      readonly channelMessageRef: string;
      readonly sentAt: string;
    }
  >();

  const fail = (reason: string): MessagingRailSendOutcome => {
    const injected = failNext;
    if (injected !== null) {
      failNext = null;
      return { sent: false, reason: injected };
    }
    return { sent: false, reason: options.failSends ?? reason };
  };

  const rail: MessagingRail = {
    descriptor: {
      railCapabilityId: "simulated-messaging-rail",
      channelKinds,
      transportClass: "messaging",
    },
    async openConversation(
      request: MessagingRailConversationRequest,
    ): Promise<MessagingRailConversation> {
      // Idempotent open: the SAME stable key converges on the SAME
      // channel coordinates (a crash between the rail open and the
      // durable conversation row can never produce a second channel
      // conversation).
      const key = `${request.applicationId}:${request.idempotencyKey}`;
      const existing = opensByKey.get(key);
      if (existing !== undefined) {
        replays.push({
          kind: "open",
          idempotencyKey: request.idempotencyKey,
          at: now().toISOString(),
        });
        return { ...existing, replayed: true };
      }
      opened += 1;
      const channelConversationRef =
        request.channelConversationRef === null
          ? allocateConversationRef()
          : request.channelConversationRef;
      const conversation: MessagingRailConversation = {
        channelConversationRef,
        railMetadata: {
          simulated: true,
          channelKind: request.channelKind,
          orderingMode: request.orderingMode,
          sessionPolicy: { ...request.sessionPolicy },
        },
        replayed: false,
      };
      opensByKey.set(key, conversation);
      records.push({
        kind: "open",
        applicationId: request.applicationId,
        conversationId: null,
        channelConversationRef,
        messageKey: null,
        idempotencyKey: request.idempotencyKey,
        payloadPreview: null,
        destination: null,
        cause: null,
        at: now().toISOString(),
      });
      return conversation;
    },
    async sendMessage(request: MessagingRailSendRequest): Promise<MessagingRailSendOutcome> {
      const key = `${request.applicationId}:${request.idempotencyKey}`;
      const existing = sendOutcomesByKey.get(key);
      if (existing !== undefined && existing.kind === "send") {
        replays.push({
          kind: "send",
          idempotencyKey: request.idempotencyKey,
          at: now().toISOString(),
        });
        return {
          sent: true,
          sentAt: existing.sentAt,
          channelMessageRef: existing.channelMessageRef,
          replayed: true,
          railMetadata: { simulated: true, routeClass: request.routeClass },
        };
      }
      if (failNext !== null) {
        return fail(failNext);
      }
      const sentAt = now().toISOString();
      const channelMessageRef = allocateMessageRef();
      sendOutcomesByKey.set(key, { kind: "send", channelMessageRef, sentAt });
      accepted += 1;
      records.push({
        kind: "send",
        applicationId: request.applicationId,
        conversationId: request.conversationId,
        channelConversationRef: request.channelConversationRef,
        messageKey: request.messageKey,
        idempotencyKey: request.idempotencyKey,
        payloadPreview: request.payloadPreview,
        destination: null,
        cause: request.cause,
        at: sentAt,
      });
      return {
        sent: true,
        sentAt,
        channelMessageRef,
        replayed: false,
        railMetadata: { simulated: true, routeClass: request.routeClass },
      };
    },
    async escalate(request: MessagingRailEscalationRequest): Promise<MessagingRailSendOutcome> {
      const key = `${request.applicationId}:${request.idempotencyKey}`;
      const existing = sendOutcomesByKey.get(key);
      if (existing !== undefined && existing.kind === "escalate") {
        replays.push({
          kind: "escalate",
          idempotencyKey: request.idempotencyKey,
          at: now().toISOString(),
        });
        return {
          sent: true,
          sentAt: existing.sentAt,
          channelMessageRef: existing.channelMessageRef,
          replayed: true,
        };
      }
      if (failNext !== null) {
        return fail(failNext);
      }
      const sentAt = now().toISOString();
      const channelMessageRef = allocateMessageRef();
      sendOutcomesByKey.set(key, { kind: "escalate", channelMessageRef, sentAt });
      records.push({
        kind: "escalate",
        applicationId: request.applicationId,
        conversationId: request.conversationId,
        channelConversationRef: request.channelConversationRef,
        messageKey: null,
        idempotencyKey: request.idempotencyKey,
        payloadPreview: null,
        destination: request.destination,
        cause: request.cause,
        at: sentAt,
      });
      return {
        sent: true,
        sentAt,
        channelMessageRef,
        replayed: false,
      };
    },
    async closeConversation(reference: {
      readonly applicationId: string;
      readonly conversationId: string;
      readonly channelConversationRef: string;
      readonly idempotencyKey: string;
      readonly cause: string | null;
    }): Promise<MessagingRailSendOutcome> {
      const key = `${reference.applicationId}:${reference.idempotencyKey}`;
      const existing = sendOutcomesByKey.get(key);
      if (existing !== undefined && existing.kind === "close") {
        replays.push({
          kind: "close",
          idempotencyKey: reference.idempotencyKey,
          at: now().toISOString(),
        });
        return {
          sent: true,
          sentAt: existing.sentAt,
          channelMessageRef: existing.channelMessageRef,
          replayed: true,
        };
      }
      if (failNext !== null) {
        return fail(failNext);
      }
      const sentAt = now().toISOString();
      const channelMessageRef = allocateMessageRef();
      sendOutcomesByKey.set(key, { kind: "close", channelMessageRef, sentAt });
      records.push({
        kind: "close",
        applicationId: reference.applicationId,
        conversationId: reference.conversationId,
        channelConversationRef: reference.channelConversationRef,
        messageKey: null,
        idempotencyKey: reference.idempotencyKey,
        payloadPreview: null,
        destination: null,
        cause: reference.cause,
        at: sentAt,
      });
      return { sent: true, sentAt, channelMessageRef, replayed: false };
    },
  };

  return {
    ...rail,
    get sends() {
      return records;
    },
    get replays() {
      return replays;
    },
    get openedConversations() {
      return opened;
    },
    get acceptedSends() {
      return accepted;
    },
    failNextSend(reason: string) {
      failNext = reason;
    },
  };
}
