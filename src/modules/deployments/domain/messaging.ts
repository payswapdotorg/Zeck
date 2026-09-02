/**
 * Provider-neutral conversational messaging domain (deployments module
 * domain; WORK-025, MOD-008/MOD-009, ADR-0014 specialization).
 *
 * The provider-neutral MESSAGING CHANNEL contract for asynchronous,
 * conversational channels (the WORK-023 fabric's neutral messaging
 * channel kinds — never a vendor). A CONVERSATION is the channel-side
 * twin of a governed Execution: it is BOUND to (tenant, application,
 * deployment, PINNED deployment plan version, execution identity) and
 * every inbound message, outbound reply, delivery callback and human
 * escalation is preserved as EXECUTION provenance through the
 * executions authority (the deployments module's messaging ledger port
 * → the executions public step-event seam), never a second event
 * authority.
 *
 * Provider neutrality is structural (MOD-008/ADR-0014 invariant):
 *   - the channel vocabulary reuses the deployment fabric's neutral
 *     channel kinds (sms / email / web / in-app — channel KINDS, never
 *     vendors);
 *   - `channelConversationRef` and `channelMessageRef` are the
 *     upstream rail's OPAQUE references — the ADAPTER maps
 *     provider-native conversation/message ids onto them; provider
 *     ids are NEVER the primary public identity (the Zeck message
 *     identity is `eventKey`/`messageKey` + the message row id);
 *   - raw payloads and attachments never cross: message rows carry
 *     bounded previews and ARTIFACT REFERENCES only (`payloadRef` +
 *     `attachments` lineage — the work order's "large attachments
 *     through artifact/object references" requirement).
 *
 * ORDERING SEMANTICS (explicit, declared per conversation — the work
 * order's "define explicit ordering semantics; do not assume global
 * ordering"): the conversation records its channel's ordering mode —
 *   - `thread-sequenced` (the channel supplies a per-thread monotonic
 *     sequence): inbound messages record `threadSequence` with the
 *     deterministic marker `in-order` / `out-of-order` / `gap`
 *     (evidence, never a block: async messaging cannot wait);
 *   - `unordered` (no channel ordering): the fabric assigns the
 *     arrival ordinal as the deterministic substitute (`assigned`).
 * Dispatch identity is ALWAYS the event key (dedupe by
 * (application, conversation, event_key)) — ordering evidence rides
 * the message rows, ordering is never assumed.
 *
 * This file is pure: no stores, no authorities, no I/O. It is NOT an
 * authority: no policy, capability, budget, secret or execution-state
 * decision lives here.
 */

import type { DeploymentChannelKind } from "./profile";

/** The messaging-capable subset of the neutral channel vocabulary. */
export const MESSAGING_CHANNEL_KINDS: readonly DeploymentChannelKind[] = [
  "sms",
  "email",
  "web",
  "in-app",
];
export type MessagingChannelKind = (typeof MESSAGING_CHANNEL_KINDS)[number];

export function isMessagingChannelKind(value: string): value is MessagingChannelKind {
  return (MESSAGING_CHANNEL_KINDS as readonly string[]).includes(value);
}

/**
 * The conversation status machine. Small and subordinate (the
 * EXECUTION state machine is the runs authority — this one governs the
 * CHANNEL conversation only): conversations are long-lived; `closed`
 * is terminal-immutable. Human escalation does NOT close a
 * conversation (async messaging: the human and the agent coexist —
 * the escalation is a governed Execution step, see the escalation
 * records).
 */
export const MESSAGING_CONVERSATION_STATUSES = ["active", "closed"] as const;
export type MessagingConversationStatus = (typeof MESSAGING_CONVERSATION_STATUSES)[number];

export function isMessagingConversationStatus(value: string): value is MessagingConversationStatus {
  return (MESSAGING_CONVERSATION_STATUSES as readonly string[]).includes(value);
}

export const MESSAGING_CONVERSATION_TRANSITIONS: Readonly<
  Record<MessagingConversationStatus, readonly MessagingConversationStatus[]>
> = {
  active: ["active", "closed"],
  closed: [],
};

export function canTransitionMessagingConversation(
  from: MessagingConversationStatus,
  to: MessagingConversationStatus,
): boolean {
  return MESSAGING_CONVERSATION_TRANSITIONS[from].includes(to);
}

export function isTerminalMessagingConversationStatus(
  status: MessagingConversationStatus,
): boolean {
  return status === "closed";
}

/** The declared per-channel ordering semantics (never assumed). */
export const MESSAGING_ORDERING_MODES = ["thread-sequenced", "unordered"] as const;
export type MessagingOrderingMode = (typeof MESSAGING_ORDERING_MODES)[number];

export function isMessagingOrderingMode(value: string): value is MessagingOrderingMode {
  return (MESSAGING_ORDERING_MODES as readonly string[]).includes(value);
}

/**
 * The deterministic ordering outcome recorded on each inbound message
 * row (ordering EVIDENCE, never a dispatch decision): `in-order`
 * (sequenced channel, sequence == max+1), `out-of-order` (sequence <=
 * the thread's already-seen max), `gap` (sequence > max+1), `assigned`
 * (unordered channel; the fabric assigned the arrival ordinal).
 */
export const MESSAGING_ORDERING_MARKERS = [
  "in-order",
  "out-of-order",
  "gap",
  "assigned",
] as const;
export type MessagingOrderingMarker = (typeof MESSAGING_ORDERING_MARKERS)[number];

export function isMessagingOrderingMarker(value: string): value is MessagingOrderingMarker {
  return (MESSAGING_ORDERING_MARKERS as readonly string[]).includes(value);
}

/**
 * The message-ledger row kinds. `user-message` = inbound end-user
 * message (the idempotency ledger rows); `agent-reply` = the governed
 * outbound reply (the send ledger rows); `escalation-notice` = the
 * outbound human-escalation notice; `system-marker` = bounded
 * internal evidence rows (denials, close markers) — never a second
 * event authority (canonical provenance rides the executions ledger).
 */
export const MESSAGING_MESSAGE_KINDS = [
  "user-message",
  "agent-reply",
  "escalation-notice",
  "system-marker",
] as const;
export type MessagingMessageKind = (typeof MESSAGING_MESSAGE_KINDS)[number];

export function isMessagingMessageKind(value: string): value is MessagingMessageKind {
  return (MESSAGING_MESSAGE_KINDS as readonly string[]).includes(value);
}

export const MESSAGING_MESSAGE_DIRECTIONS = ["inbound", "outbound", "internal"] as const;
export type MessagingMessageDirection = (typeof MESSAGING_MESSAGE_DIRECTIONS)[number];

export const MESSAGING_ROUTE_CLASSES = ["deterministic", "hybrid", "generative"] as const;
export type MessagingRouteClass = (typeof MESSAGING_ROUTE_CLASSES)[number];

export function isMessagingRouteClass(value: string): value is MessagingRouteClass {
  return (MESSAGING_ROUTE_CLASSES as readonly string[]).includes(value);
}

/**
 * The delivery-status vocabulary — EVIDENCE/provenance only (never a
 * second execution state machine): `pending` (the reply is claimed,
 * not yet rail-acked), `sent` (the rail accepted the send), then the
 * provider's terminal confirmations `delivered` / `undelivered`.
 * Monotonic by ordinal; `delivered`/`undelivered` are terminal.
 */
export const MESSAGING_DELIVERY_STATUSES = [
  "pending",
  "sent",
  "delivered",
  "undelivered",
] as const;
export type MessagingDeliveryStatus = (typeof MESSAGING_DELIVERY_STATUSES)[number];

export function isMessagingDeliveryStatus(value: string): value is MessagingDeliveryStatus {
  return (MESSAGING_DELIVERY_STATUSES as readonly string[]).includes(value);
}

const DELIVERY_STATUS_ORDINALS: Readonly<Record<MessagingDeliveryStatus, number>> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  undelivered: 2,
};

/** Whether a delivery-status move is the monotonic forward direction. */
export function isForwardMessagingDeliveryMove(
  from: MessagingDeliveryStatus,
  to: MessagingDeliveryStatus,
): boolean {
  return DELIVERY_STATUS_ORDINALS[to] > DELIVERY_STATUS_ORDINALS[from];
}

/** Whether the delivery status is terminal (immutable thereafter). */
export function isTerminalMessagingDeliveryStatus(status: MessagingDeliveryStatus): boolean {
  return DELIVERY_STATUS_ORDINALS[status] >= 2;
}

/** The statuses a delivery CALLBACK may report (evidence transitions). */
export const MESSAGING_CALLBACK_STATUSES = ["sent", "delivered", "undelivered"] as const;
export type MessagingCallbackStatus = (typeof MESSAGING_CALLBACK_STATUSES)[number];

export function isMessagingCallbackStatus(value: string): value is MessagingCallbackStatus {
  return (MESSAGING_CALLBACK_STATUSES as readonly string[]).includes(value);
}

/** The immutable durable conversation record. */
export interface MessagingConversationRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deploymentId: string;
  /** The PINNED deployment plan version (immutable for the conversation lifetime). */
  readonly pinnedPlanId: string;
  readonly pinnedPlanVersion: number;
  /** The governed Execution this conversation maps to (reference only). */
  readonly executionId: string;
  readonly channelKind: MessagingChannelKind;
  /** The upstream rail's OPAQUE conversation reference (never a vendor id). */
  readonly channelConversationRef: string;
  /** The rail's declared ordering semantics for this conversation. */
  readonly orderingMode: MessagingOrderingMode;
  /** Neutral end-participant identity supplied by the rail (bounded, never a secret). */
  readonly participantRef: string | null;
  readonly status: MessagingConversationStatus;
  /** The creation-fingerprint arbitration discriminator (idempotent replay vs key reuse). */
  readonly creationFingerprint: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

/** The append-only message-ledger record (the identity + idempotency + ordering evidence). */
export interface MessagingMessageRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly deploymentId: string;
  readonly kind: MessagingMessageKind;
  readonly direction: MessagingMessageDirection;
  /**
   * The Zeck-side STABLE message identity: the dedupe key for inbound
   * messages, the send key (messageKey) for outbound replies, the
   * marker key for system rows. Provider-native ids NEVER occupy this
   * slot (they are `channelMessageRef`, reference-only).
   */
  readonly eventKey: string;
  /** The neutral thread reference within the conversation (null = the root thread). */
  readonly threadRef: string | null;
  /** The per-thread sequence (channel-supplied or fabric-assigned — ordering evidence). */
  readonly threadSequence: number | null;
  readonly orderingMarker: MessagingOrderingMarker | null;
  readonly executionId: string | null;
  /** Provenance linkage: the executions envelope sequence, when the row has one. */
  readonly ledgerSequence: number | null;
  readonly routeClass: MessagingRouteClass | null;
  /**
   * The inbound event key this outbound reply answers (the provenance
   * chain inbound message → execution → outbound reply).
   */
  readonly replyToEventKey: string | null;
  /** The rail's OPAQUE message reference for the send (reference-only evidence). */
  readonly channelMessageRef: string | null;
  /** Delivery evidence projection (agent-reply rows only; monotonic). */
  readonly deliveryStatus: MessagingDeliveryStatus | null;
  readonly deliveredAt: string | null;
  readonly cause: string | null;
  /** ARTIFACT REFERENCES only (never raw payload bytes). */
  readonly payloadRef: string | null;
  /** Bounded human-readable summary (never raw media, never secrets). */
  readonly payloadPreview: string | null;
  /** Attachment artifact references (bounded; never embedded binary data). */
  readonly attachments: readonly string[];
  readonly actorId: string;
  readonly eventSeq: number;
  readonly bodyDigest: string;
  readonly createdAt: string;
}

/** The append-only delivery-callback evidence record. */
export interface MessagingDeliveryRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly deploymentId: string;
  readonly messageId: string;
  readonly executionId: string | null;
  /** The callback's stable dedupe key (UNIQUE per conversation). */
  readonly callbackKey: string;
  readonly channelMessageRef: string;
  readonly fromStatus: MessagingDeliveryStatus;
  readonly toStatus: MessagingDeliveryStatus;
  readonly detail: string | null;
  readonly ledgerSequence: number | null;
  readonly actorId: string;
  readonly eventSeq: number;
  readonly createdAt: string;
}

/** The immutable human-escalation record (evidence + the governed wait linkage). */
export interface MessagingEscalationRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly deploymentId: string;
  readonly executionId: string;
  /** The escalation's stable idempotency key (UNIQUE per application). */
  readonly escalationKey: string;
  /** The neutral human destination (bounded, never a secret). */
  readonly destination: string;
  readonly cause: string | null;
  /** The executions ledger sequence of the governed wait-human step. */
  readonly waitSequence: number;
  /** When the rail accepted the escalation notice (null = not yet accepted). */
  readonly notifiedAt: string | null;
  readonly createdAt: string;
}

/** Input of `startConversation` (validated fail-closed). */
export interface StartMessagingConversationInput {
  readonly deploymentId: string;
  readonly channelKind: MessagingChannelKind;
  /** The upstream rail's opaque conversation reference when it pre-allocated one. */
  readonly channelConversationRef?: string;
  /** The rail's declared ordering semantics for this conversation. */
  readonly orderingMode?: MessagingOrderingMode;
  readonly participantRef?: string;
  /** The conversation-opening message's artifact reference, when present. */
  readonly initialPayloadRef?: string;
}

/** One inbound conversational event delivered by the rail (validated fail-closed). */
export interface MessagingInboundEventInput {
  readonly conversationId: string;
  /** The upstream-supplied idempotency identifier when the rail provides one. */
  readonly eventKey?: string;
  /** The rail's OPAQUE message reference for the inbound message (evidence only). */
  readonly channelMessageRef?: string;
  readonly threadRef?: string;
  /** The channel-supplied per-thread sequence (thread-sequenced channels only). */
  readonly threadSequence?: number;
  /** Rail-supplied occurrence ordinal (the deterministic-substitute input). */
  readonly occurrenceOrdinal?: number;
  /**
   * The turn's neutral subtask classification (the planner task kind);
   * validated by the planner surface (fail closed); defaults to a
   * semantic route when omitted.
   */
  readonly subtaskKind?: string;
  /** ARTIFACT REFERENCE of the inbound message payload (never the bytes). */
  readonly payloadRef?: string;
  /** Bounded text preview of the inbound message. */
  readonly payloadPreview?: string;
  /** Attachment artifact references (bounded; never embedded binary data). */
  readonly attachments?: readonly string[];
}

/** One delivery-status callback applied to an outbound reply (validated fail-closed). */
export interface MessagingDeliveryCallbackInput {
  readonly conversationId: string;
  /**
   * The OUTBOUND message's Zeck send key (the messageKey of the
   * originating reply) — the correlation target.
   */
  readonly messageKey: string;
  /** The rail's OPAQUE message reference of the send (correlation guard). */
  readonly channelMessageRef?: string;
  /** The callback's stable dedupe key when the rail supplies one. */
  readonly callbackKey?: string;
  readonly status: MessagingCallbackStatus;
  readonly detail?: string;
}

export type MessagingValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REF_PATTERN = /^[\x21-\x7e]{1,200}$/;
const THREAD_PATTERN = /^[\x21-\x7e]{1,120}$/;
const PREVIEW_MAX = 512;
const PAYLOAD_REF_MAX = 512;
const KEY_MAX = 200;
const CAUSE_MAX = 2000;
const MAX_ATTACHMENTS = 8;

/** Raw-secret VALUE patterns (the WORK-011 nine-pattern discipline). */
const RAW_SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /bearer\s+[A-Za-z0-9._-]{16,}/i,
  /(api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"']{8,}/i,
];

/** Whether a free-text value looks like a raw long-lived secret. */
export function messagingContainsRawSecretValue(value: string): boolean {
  return RAW_SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAttachmentRefs(
  attachments: readonly string[] | undefined,
): string | null {
  if (attachments === undefined) {
    return null;
  }
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) {
    return `attachments must be an array of at most ${MAX_ATTACHMENTS} artifact references`;
  }
  for (const ref of attachments) {
    if (typeof ref !== "string" || ref.length < 1 || ref.length > PAYLOAD_REF_MAX) {
      return "each attachment must be an artifact reference of at most 512 characters";
    }
    if (messagingContainsRawSecretValue(ref)) {
      return "an attachment reference looks like it embeds a raw secret value";
    }
  }
  return null;
}

/** Fail-closed validation of the conversation-start input. */
export function validateStartMessagingConversationInput(
  input: unknown,
): MessagingValidation {
  if (!isRecord(input)) {
    return { valid: false, reason: "messaging conversation input must be an object" };
  }
  const c = input as unknown as StartMessagingConversationInput;
  if (typeof c.deploymentId !== "string" || !UUID_PATTERN.test(c.deploymentId)) {
    return {
      valid: false,
      reason: "deploymentId must be a UUID (the deployment fabric identity)",
    };
  }
  if (typeof c.channelKind !== "string" || !isMessagingChannelKind(c.channelKind)) {
    return {
      valid: false,
      reason: `channelKind must be one of ${MESSAGING_CHANNEL_KINDS.join("|")} (provider-neutral)`,
    };
  }
  if (
    c.orderingMode !== undefined &&
    (typeof c.orderingMode !== "string" || !isMessagingOrderingMode(c.orderingMode))
  ) {
    return {
      valid: false,
      reason: `orderingMode must be one of ${MESSAGING_ORDERING_MODES.join("|")} (explicit channel ordering semantics)`,
    };
  }
  if (
    c.channelConversationRef !== undefined &&
    (typeof c.channelConversationRef !== "string" || !REF_PATTERN.test(c.channelConversationRef))
  ) {
    return {
      valid: false,
      reason: "channelConversationRef must be the rail's printable opaque reference (1..200 chars)",
    };
  }
  if (
    c.participantRef !== undefined &&
    (typeof c.participantRef !== "string" || c.participantRef.length < 1 || c.participantRef.length > 200)
  ) {
    return { valid: false, reason: "participantRef must be 1..200 characters when present" };
  }
  if (
    c.initialPayloadRef !== undefined &&
    (typeof c.initialPayloadRef !== "string" || c.initialPayloadRef.length > PAYLOAD_REF_MAX)
  ) {
    return { valid: false, reason: "initialPayloadRef must be at most 512 characters" };
  }
  for (const [field, value] of [
    ["participantRef", c.participantRef],
    ["initialPayloadRef", c.initialPayloadRef],
    ["channelConversationRef", c.channelConversationRef],
  ] as const) {
    if (value !== undefined && typeof value === "string" && messagingContainsRawSecretValue(value)) {
      return { valid: false, reason: `${field} looks like it embeds a raw secret value` };
    }
  }
  return { valid: true };
}

/** Fail-closed validation of one inbound conversational event. */
export function validateMessagingInboundEvent(input: unknown): MessagingValidation {
  if (!isRecord(input)) {
    return { valid: false, reason: "messaging inbound event must be an object" };
  }
  const e = input as unknown as MessagingInboundEventInput;
  if (typeof e.conversationId !== "string" || !UUID_PATTERN.test(e.conversationId)) {
    return { valid: false, reason: "conversationId must be a UUID" };
  }
  if (
    e.eventKey !== undefined &&
    (typeof e.eventKey !== "string" || e.eventKey.length < 1 || e.eventKey.length > KEY_MAX)
  ) {
    return { valid: false, reason: "eventKey must be 1..200 characters when supplied by the rail" };
  }
  if (
    e.channelMessageRef !== undefined &&
    (typeof e.channelMessageRef !== "string" || !REF_PATTERN.test(e.channelMessageRef))
  ) {
    return {
      valid: false,
      reason: "channelMessageRef must be the rail's printable opaque reference (1..200 chars)",
    };
  }
  if (e.threadRef !== undefined && (typeof e.threadRef !== "string" || !THREAD_PATTERN.test(e.threadRef))) {
    return {
      valid: false,
      reason: "threadRef must be a printable neutral thread reference (1..120 chars)",
    };
  }
  if (
    e.threadSequence !== undefined &&
    (!Number.isInteger(e.threadSequence) || e.threadSequence < 1)
  ) {
    return {
      valid: false,
      reason: "threadSequence must be a positive integer (the channel's per-thread sequence)",
    };
  }
  if (
    e.occurrenceOrdinal !== undefined &&
    (!Number.isInteger(e.occurrenceOrdinal) || e.occurrenceOrdinal < 1)
  ) {
    return {
      valid: false,
      reason: "occurrenceOrdinal must be a positive integer (the deterministic-substitute input)",
    };
  }
  if (
    e.subtaskKind !== undefined &&
    (typeof e.subtaskKind !== "string" ||
      e.subtaskKind.length < 1 ||
      e.subtaskKind.length > 64 ||
      !/^[a-z][a-z0-9-]*$/.test(e.subtaskKind))
  ) {
    return {
      valid: false,
      reason: "subtaskKind must be a neutral task-kind slug (1..64 chars) when present",
    };
  }
  if (
    e.payloadRef !== undefined &&
    (typeof e.payloadRef !== "string" || e.payloadRef.length > PAYLOAD_REF_MAX)
  ) {
    return {
      valid: false,
      reason: "payloadRef must be an artifact reference of at most 512 characters",
    };
  }
  if (
    e.payloadPreview !== undefined &&
    (typeof e.payloadPreview !== "string" || e.payloadPreview.length > PREVIEW_MAX)
  ) {
    return { valid: false, reason: `payloadPreview must be at most ${PREVIEW_MAX} characters` };
  }
  const attachmentFailure = validateAttachmentRefs(e.attachments);
  if (attachmentFailure !== null) {
    return { valid: false, reason: attachmentFailure };
  }
  for (const [field, value] of [
    ["payloadPreview", e.payloadPreview],
    ["payloadRef", e.payloadRef],
    ["eventKey", e.eventKey],
  ] as const) {
    if (value !== undefined && typeof value === "string" && messagingContainsRawSecretValue(value)) {
      return { valid: false, reason: `${field} looks like it embeds a raw secret value` };
    }
  }
  return { valid: true };
}

/** Fail-closed validation of one delivery-status callback. */
export function validateMessagingDeliveryCallback(input: unknown): MessagingValidation {
  if (!isRecord(input)) {
    return { valid: false, reason: "messaging delivery callback must be an object" };
  }
  const c = input as unknown as MessagingDeliveryCallbackInput;
  if (typeof c.conversationId !== "string" || !UUID_PATTERN.test(c.conversationId)) {
    return { valid: false, reason: "conversationId must be a UUID" };
  }
  if (typeof c.messageKey !== "string" || !/^[a-zA-Z0-9:_-]{1,200}$/.test(c.messageKey)) {
    return {
      valid: false,
      reason: "messageKey must be the outbound reply's Zeck send key (1..200 printable chars)",
    };
  }
  if (
    c.channelMessageRef !== undefined &&
    (typeof c.channelMessageRef !== "string" || !REF_PATTERN.test(c.channelMessageRef))
  ) {
    return {
      valid: false,
      reason: "channelMessageRef must be the rail's printable opaque reference (1..200 chars)",
    };
  }
  if (
    c.callbackKey !== undefined &&
    (typeof c.callbackKey !== "string" || c.callbackKey.length < 1 || c.callbackKey.length > KEY_MAX)
  ) {
    return { valid: false, reason: "callbackKey must be 1..200 characters when supplied by the rail" };
  }
  if (typeof c.status !== "string" || !isMessagingCallbackStatus(c.status)) {
    return {
      valid: false,
      reason: `status must be one of ${MESSAGING_CALLBACK_STATUSES.join("|")}`,
    };
  }
  if (c.detail !== undefined && (typeof c.detail !== "string" || c.detail.length > CAUSE_MAX)) {
    return { valid: false, reason: `detail must be at most ${CAUSE_MAX} characters` };
  }
  if (c.detail !== undefined && typeof c.detail === "string" && messagingContainsRawSecretValue(c.detail)) {
    return { valid: false, reason: "detail looks like it embeds a raw secret value" };
  }
  return { valid: true };
}

/**
 * The DETERMINISTIC SUBSTITUTE idempotency key for rails that do not
 * supply event ids (the work order's implementation requirement):
 * conversation coordinates + thread + occurrence ordinal.
 */
export function deterministicMessagingEventKey(input: {
  readonly conversationId: string;
  readonly threadRef: string | null;
  readonly occurrenceOrdinal: number;
}): string {
  return `msg-${input.conversationId}-${input.threadRef ?? "root"}-${input.occurrenceOrdinal}`;
}

/**
 * The deterministic substitute key for delivery callbacks that do not
 * supply one: the reply's send coordinates + the reported status.
 */
export function deterministicMessagingCallbackKey(input: {
  readonly conversationId: string;
  readonly messageKey: string;
  readonly status: MessagingCallbackStatus;
}): string {
  return `dlv-${input.conversationId}-${input.messageKey}-${input.status}`;
}

/**
 * The deterministic ordering outcome for one inbound message (the
 * explicit channel-contract semantics; ordering evidence, never a
 * dispatch decision): thread-sequenced channels mark in-order /
 * out-of-order / gap against the thread's already-seen maximum;
 * unordered channels assign the arrival ordinal.
 */
export function resolveMessagingOrdering(input: {
  readonly orderingMode: MessagingOrderingMode;
  readonly threadRef: string | null;
  readonly threadSequence: number | null;
  /** The thread's already-recorded maximum sequence (0 when none). */
  readonly maxThreadSequence: number;
  /** The thread's already-recorded message count (arrival ordinals). */
  readonly threadMessageCount: number;
}): {
  readonly threadSequence: number;
  readonly marker: MessagingOrderingMarker;
} {
  if (input.orderingMode === "unordered") {
    // No channel ordering exists: the fabric's arrival ordinal is the
    // deterministic substitute (never an assumed global order).
    return {
      threadSequence: input.threadMessageCount + 1,
      marker: "assigned",
    };
  }
  const sequence = input.threadSequence ?? input.threadMessageCount + 1;
  if (input.maxThreadSequence === 0 || sequence === input.maxThreadSequence + 1) {
    return { threadSequence: sequence, marker: "in-order" };
  }
  if (sequence <= input.maxThreadSequence) {
    return { threadSequence: sequence, marker: "out-of-order" };
  }
  return { threadSequence: sequence, marker: "gap" };
}

// ---------------------------------------------------------------------------
// DURABLE, RECOVERABLE OPERATION STATE (the WORK-024 crash-safety
// standard, applied to messaging — the architect's review bar): every
// governed messaging operation that can perform an external side
// effect (conversation-start, turn-reply, delivery-apply,
// human-escalation, conversation-close) owns ONE durable operation row
// with a PENDING → COMPLETED|FAILED machine plus STABLE rail-level
// idempotency keys derived below. A crash between the durable claim
// and the durable completion leaves the row PENDING; a retry RESUMES
// it (the rail converges by key — exactly one upstream side effect)
// and then completes it. A COMPLETED row replays its recorded outcome
// with no side effect; a FAILED row replays its recorded failure.
// ---------------------------------------------------------------------------

/** The governed operations that own durable recoverable state. */
export const MESSAGING_OPERATION_KINDS = [
  "conversation-start",
  "turn-reply",
  "delivery-apply",
  "human-escalation",
  "conversation-close",
] as const;
export type MessagingOperationKind = (typeof MESSAGING_OPERATION_KINDS)[number];

export function isMessagingOperationKind(value: string): value is MessagingOperationKind {
  return (MESSAGING_OPERATION_KINDS as readonly string[]).includes(value);
}

/** The recoverable status machine (pending → completed|failed; terminal-immutable). */
export const MESSAGING_OPERATION_STATUSES = ["pending", "completed", "failed"] as const;
export type MessagingOperationStatus = (typeof MESSAGING_OPERATION_STATUSES)[number];

export function isMessagingOperationStatus(value: string): value is MessagingOperationStatus {
  return (MESSAGING_OPERATION_STATUSES as readonly string[]).includes(value);
}

/**
 * The bounded durable stage checkpoint. A checkpoint's meaning: the
 * operation has passed its POINT OF NO RETURN — resumption must NOT
 * re-run admission (the decision preceded the side effect) and must
 * complete the durable tail from these facts:
 *
 *  - `conversation-opened` (conversation-start): the rail opened/bound
 *    the channel conversation and the durable conversation row can be
 *    inserted from these facts;
 *  - `responded` (turn-reply): the admitted responder produced the
 *    reply frame — the rail send resumes with THESE facts (the
 *    paid-inference seam is not re-invoked);
 *  - `rail-issued` (human-escalation / conversation-close): the rail
 *    side effect was issued — the durable tail completes from here.
 */
export interface MessagingOperationCheckpoint {
  readonly stage: "conversation-opened" | "responded" | "rail-issued";
  readonly conversationId?: string;
  readonly executionId?: string;
  readonly deploymentId?: string;
  readonly pinnedPlanId?: string;
  readonly pinnedPlanVersion?: number;
  readonly channelConversationRef?: string;
  readonly orderingMode?: MessagingOrderingMode;
  readonly participantRef?: string | null;
  readonly policySetId?: string | null;
  /** responded: the responder's bounded output + reservation binding. */
  readonly routeClass?: MessagingRouteClass;
  readonly plannerOutcome?: "sufficient" | "uncertain" | "insufficient";
  readonly reasonCodes?: readonly string[];
  readonly responseRef?: string | null;
  readonly responsePreview?: string;
  readonly responseAttachments?: readonly string[];
  readonly reservationId?: string | null;
  readonly actualCostMicroUsd?: string;
  readonly deliveryCause?: string | null;
  /** rail-issued: the original delivery acknowledgment. */
  readonly deliveredAt?: string;
}

/** The immutable-view durable operation record (status moves only pending → terminal). */
export interface MessagingOperationRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** Provenance reference (NO FK — a conversation-start row precedes its conversation row). */
  readonly conversationId: string | null;
  readonly deploymentId: string;
  readonly executionId: string | null;
  readonly operationKind: MessagingOperationKind;
  /** The stable operation key (UNIQUE per application — the recovery discriminator). */
  readonly operationKey: string;
  readonly status: MessagingOperationStatus;
  /** How many invocations claimed/resumed this operation (the retry ledger). */
  readonly attempts: number;
  readonly checkpoint: MessagingOperationCheckpoint | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

/**
 * The stable DURABLE OPERATION key (the recovery discriminator — the
 * retry looks the operation up by exactly this key): the operation
 * kind plus the operation's logical discriminator (the caller
 * idempotency key for start/escalation/close, the CONVERSATION-SCOPED
 * inbound event key for turn replies, the conversation-scoped callback
 * key for delivery application).
 */
export function messagingOperationKey(kind: MessagingOperationKind, discriminator: string): string {
  return `msgop:${kind}:${discriminator}`;
}

/**
 * The STABLE RAIL-LEVEL IDEMPOTENCY KEYS (the WORK-024 crash-safety
 * standard): every call that can perform an upstream side effect
 * carries one, derived deterministically from the SAME durable
 * coordinates across retries — a retry (or a crash-resume) re-issues
 * the call under the SAME key and the rail converges (exactly one
 * upstream side effect, ever).
 */
export function messagingRailOpenKey(idempotencyKey: string): string {
  return `msgrail:open:${idempotencyKey}`;
}

export function messagingRailSendKey(scopedEventKey: string): string {
  return `msgrail:send:${scopedEventKey}`;
}

export function messagingRailEscalateKey(idempotencyKey: string): string {
  return `msgrail:escalate:${idempotencyKey}`;
}

export function messagingRailCloseKey(idempotencyKey: string): string {
  return `msgrail:close:${idempotencyKey}`;
}

/**
 * Deterministic conversation-creation fingerprint (the idempotency
 * discriminator): the same logical conversation start under the same
 * key replays; a different start under a reused key fails
 * `IDEMPOTENCY_KEY_REUSED`.
 */
export function messagingConversationCreationFingerprint(
  applicationId: string,
  input: StartMessagingConversationInput,
  executionId: string,
): string {
  return JSON.stringify([
    "deployments.messaging.conversation",
    applicationId,
    input.deploymentId,
    input.channelKind,
    input.channelConversationRef ?? null,
    input.orderingMode ?? "unordered",
    input.participantRef ?? null,
    input.initialPayloadRef ?? null,
    executionId,
  ]);
}

/** Bounded message-body digest base (the dedupe discriminator). */
export function messagingMessageBodyDigestBase(input: {
  readonly conversationId: string;
  readonly kind: MessagingMessageKind;
  readonly direction: MessagingMessageDirection;
  readonly eventKey: string;
  readonly payloadRef: string | null;
  readonly payloadPreview: string | null;
}): string {
  return JSON.stringify([
    "deployments.messaging.message",
    input.conversationId,
    input.kind,
    input.direction,
    input.eventKey,
    input.payloadRef,
    input.payloadPreview,
  ]);
}
