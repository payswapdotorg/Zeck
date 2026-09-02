/**
 * Messaging upstream rail port (deployments module outbound; WORK-025,
 * MOD-008 — the provider-neutral conversational messaging upstream
 * seam).
 *
 * THE replaceable upstream-infrastructure seam: a messaging rail
 * adapter TRANSPORTS neutral conversation/message frames between the
 * governed conversation fabric and an upstream messaging channel
 * infrastructure (an SMS-style carrier, an email-style relay, a web
 * chat transport — channel KINDS, never vendors). The port's SHAPE
 * keeps the core contracts provider-neutral and non-authoritative:
 *
 *   - there is NO admission, authorization, budget, capability or
 *     execution-transition surface anywhere in the interface — no
 *     policy/budget/capability/execution handles cross this seam; the
 *     rail is handed only NEUTRAL coordinates (conversation/message
 *     identity refs, thread refs, bounded previews, artifact
 *     references);
 *   - the rail is identified by a NEUTRAL rail capability id and the
 *     neutral channel kinds it serves — vendor identifiers NEVER cross
 *     this contract (a concrete vendor rail binds downstream in its
 *     own adapter, exactly like model rails and the realtime rail);
 *   - RAW PAYLOADS and attachments never cross this seam in either
 *     direction: inbound events arrive as bounded previews + artifact
 *     references; outbound messages carry bounded previews + artifact
 *     references (the work order's "large attachments through
 *     artifact/object references" rule — the payload bytes live in the
 *     artifact/object-store plane, referenced by lineage);
 *   - provider-native message ids never become the primary public
 *     identity: the rail hands back an OPAQUE `channelMessageRef`
 *     (reference-only evidence); the Zeck-side stable identities are
 *     the fabric's event/message keys;
 *   - credential materialization for a real rail happens INSIDE the
 *     adapter's own scope through the mediated connections vault —
 *     never through this port's shapes (references only).
 *
 * STABLE RAIL-LEVEL IDEMPOTENCY KEYS (the WORK-024 crash-safety
 * standard): every method that can perform an upstream side effect
 * (`openConversation`, `sendMessage`, `escalate`, `closeConversation`)
 * carries an `idempotencyKey` derived deterministically from the
 * durable conversation coordinates (domain/messaging.ts
 * `messagingRail*Key`). The key's contract: re-issuing the SAME call
 * under the SAME key MUST converge — the rail performs the upstream
 * side effect EXACTLY ONCE and returns the ORIGINAL acknowledgment
 * with `replayed: true` (a real provider implements this with its
 * idempotency-key semantics; the shipped simulated rail implements it
 * with its in-memory key ledger). A crash between the durable claim
 * and the durable completion of an operation is recovered by REPLAYING
 * the call under the same key — no duplicate upstream side effect,
 * ever.
 *
 * The shipped in-process simulated rail (adapters/in-process-messaging-rail.ts)
 * implements this seam for tests and local composition; REAL external
 * messaging provider behavior is explicitly UNVERIFIED in this
 * environment (no provider credentials, no guaranteed egress) and is
 * documented as such in docs/work-items/WORK-025.md.
 */

import type { MessagingChannelKind, MessagingRouteClass } from "../domain/messaging";

export interface MessagingRailDescriptor {
  /** Provider-neutral rail identity (e.g. "simulated-messaging-rail"). */
  readonly railCapabilityId: string;
  /** The provider-neutral channel kinds this rail serves. */
  readonly channelKinds: readonly string[];
  /** The rail's declared transport class (conversational messaging only). */
  readonly transportClass: "messaging";
}

/** The neutral conversation-open request (identity refs + neutral policy). */
export interface MessagingRailConversationRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deploymentId: string;
  readonly pinnedPlanId: string;
  readonly pinnedPlanVersion: number;
  readonly executionId: string;
  readonly channelKind: MessagingChannelKind;
  /**
   * The STABLE rail-level idempotency key for this open (derived from
   * the conversation-start idempotency key): a retry/recovery re-opens
   * under the same key and converges on the SAME channel coordinates —
   * a crash between the rail open and the durable conversation row can
   * never produce a second upstream conversation.
   */
  readonly idempotencyKey: string;
  /** The caller-supplied rail conversation reference to bind (when the rail pre-allocated one). */
  readonly channelConversationRef: string | null;
  /** The rail's declared ordering semantics for this conversation. */
  readonly orderingMode: "thread-sequenced" | "unordered";
  readonly participantRef: string | null;
  /** The deployment plan's bounded session policy (duration/concurrency ceilings). */
  readonly sessionPolicy: {
    readonly maxSessionDurationMs: number;
    readonly maxConcurrentSessions: number;
  };
}

export interface MessagingRailConversation {
  readonly channelConversationRef: string;
  /** Neutral rail metadata for the binding (never credentials, never vendor ids). */
  readonly railMetadata: Readonly<Record<string, unknown>>;
  /** True when the rail converged on an existing key-bound conversation (idempotent open). */
  readonly replayed: boolean;
}

/** The neutral outbound message frame (THE external send side effect). */
export interface MessagingRailSendRequest {
  readonly applicationId: string;
  readonly conversationId: string;
  readonly channelConversationRef: string;
  readonly channelKind: MessagingChannelKind;
  /** The turn's route class (the rail may adapt transport per class). */
  readonly routeClass: MessagingRouteClass;
  /** The neutral thread reference the message posts into. */
  readonly threadRef: string | null;
  /**
   * The Zeck-side STABLE message identity for this send (the reply's
   * send key): the rail records it as the correlation handle for
   * delivery callbacks — a retry/recovery re-sends under the same key
   * and converges (exactly one upstream send, ever).
   */
  readonly messageKey: string;
  /** The stable rail-level idempotency key for this send. */
  readonly idempotencyKey: string;
  /** The inbound event key this reply answers (provenance correlation). */
  readonly replyToEventKey: string | null;
  /** ARTIFACT REFERENCE of the reply payload (never the bytes). */
  readonly payloadRef: string | null;
  /** Bounded text preview of the reply (never raw media). */
  readonly payloadPreview: string;
  /** Attachment artifact references (bounded; never embedded binary data). */
  readonly attachments: readonly string[];
  /** Bounded delivery cause (provenance summary for the rail's record). */
  readonly cause: string | null;
}

export type MessagingRailSendOutcome =
  | {
      readonly sent: true;
      readonly sentAt: string;
      /**
       * The rail's OPAQUE message reference for the send —
       * reference-only evidence correlated to delivery callbacks
       * (never the primary public identity).
       */
      readonly channelMessageRef: string;
      /** True when the rail converged on the original send (idempotent replay). */
      readonly replayed: boolean;
      readonly railMetadata?: Readonly<Record<string, unknown>>;
    }
  | { readonly sent: false; readonly reason: string };

/** The neutral human-escalation notice (the escalation side effect). */
export interface MessagingRailEscalationRequest {
  readonly applicationId: string;
  readonly conversationId: string;
  readonly channelConversationRef: string;
  readonly channelKind: MessagingChannelKind;
  /** The STABLE rail-level idempotency key for this escalation notice. */
  readonly idempotencyKey: string;
  /** The neutral human destination receiving the notice. */
  readonly destination: string;
  /** Bounded escalation cause (provenance summary). */
  readonly cause: string | null;
  /** The governed escalation's stable key (the executions wait-human correlation). */
  readonly escalationKey: string;
}

export interface MessagingRail {
  readonly descriptor: MessagingRailDescriptor;
  /** Open (or bind) one channel conversation on the upstream rail (idempotent by key). */
  openConversation(request: MessagingRailConversationRequest): Promise<MessagingRailConversation>;
  /** Send one outbound message frame (THE external send side effect; idempotent by key). */
  sendMessage(request: MessagingRailSendRequest): Promise<MessagingRailSendOutcome>;
  /** Notify a human destination of an escalation (the escalation side effect; idempotent by key). */
  escalate(request: MessagingRailEscalationRequest): Promise<MessagingRailSendOutcome>;
  /** Close the channel conversation on the upstream rail (idempotent by key). */
  closeConversation(reference: {
    readonly applicationId: string;
    readonly conversationId: string;
    readonly channelConversationRef: string;
    /** The STABLE rail-level idempotency key for this close. */
    readonly idempotencyKey: string;
    readonly cause: string | null;
  }): Promise<MessagingRailSendOutcome>;
}

/**
 * The neutral inbound callback frames a rail emits into the
 * conversation fabric (webhook/transport callback shapes —
 * coordinates + bounded payload + upstream event ids when the rail
 * supplies them).
 */
export interface MessagingRailMessageCallback {
  readonly applicationId: string;
  readonly conversationId: string | null;
  /** The rail's OPAQUE conversation reference (resolution when the id is unknown). */
  readonly channelConversationRef: string;
  /** Upstream-supplied idempotency id, when the rail provides one. */
  readonly eventKey?: string;
  readonly channelMessageRef: string | null;
  readonly threadRef: string | null;
  readonly threadSequence?: number;
  readonly occurrenceOrdinal?: number;
  readonly payloadRef: string | null;
  readonly payloadPreview: string | null;
  readonly attachments?: readonly string[];
}

export interface MessagingRailDeliveryCallback {
  readonly applicationId: string;
  readonly conversationId: string | null;
  readonly channelConversationRef: string;
  /** The Zeck-side send key of the outbound message the callback reports on. */
  readonly messageKey: string;
  readonly channelMessageRef: string | null;
  /** Upstream-supplied callback idempotency id, when the rail provides one. */
  readonly callbackKey?: string;
  readonly status: "sent" | "delivered" | "undelivered";
  readonly detail: string | null;
}
