/**
 * Messaging store port (deployments module outbound; WORK-025, MOD-009).
 *
 * The durable-state seam for messaging conversations, the append-only
 * message ledger, delivery-callback evidence, escalation records and
 * the durable, recoverable operation state (migration 0020). The
 * arbitration contract (the WORK-011/012/017/023/024 discipline):
 *
 *   - conversation creation converges on (application, idempotency
 *     key) with fingerprint arbitration; the physical UNIQUE
 *     (application, channel_conversation_ref) arbitrates the rail's
 *     channel coordinate;
 *   - conversation mutations are GUARDED: the store takes the expected
 *     current status and the physical single-row update arbitrates
 *     concurrent duplicates — first writer wins, duplicates converge
 *     on the committed row;
 *   - the message ledger is APPEND-ONLY, identity-ordered (event_seq)
 *     and the INBOUND IDEMPOTENCY LEDGER: appending a message
 *     converges on the physical UNIQUE (application, conversation,
 *     event_key) — the winner proceeds, a duplicate converges on the
 *     committed row (with the SAME body digest; a same-key/
 *     different-body append fails closed);
 *   - delivery-status application is CORRELATION-GUARDED and
 *     MONOTONIC: the callback resolves the outbound message by its
 *     Zeck send key inside THE conversation (a callback for another
 *     conversation's message is unrepresentable), the
 *     `channel_message_ref` guard rejects mismatched references
 *     physically, the delivery-evidence row converges on the physical
 *     UNIQUE (application, conversation, callback_key), and the
 *     message row's delivery projection moves only FORWARD through the
 *     frozen vocabulary (pending → sent → delivered|undelivered;
 *     terminal statuses immutable — delivery state is EVIDENCE, never
 *     a second execution state machine);
 *   - the DURABLE, RECOVERABLE OPERATION STATE (the WORK-024
 *     crash-safety standard): every governed rail-side-effect
 *     operation owns ONE row in the operations ledger with a
 *     PENDING → COMPLETED|FAILED machine. `beginMessagingOperation`
 *     converges on the physical UNIQUE (application, operation_key)
 *     and bumps `attempts` on re-claim; `completed`/`failed` are
 *     terminal-immutable (physical trigger); a crash between claim and
 *     completion leaves the row PENDING and a retry MUST resume it;
 *   - every read is scope-filtered (application); tenant identity is
 *     carried on every row and never dropped.
 */

import type {
  MessagingConversationRecord,
  MessagingConversationStatus,
  MessagingDeliveryRecord,
  MessagingDeliveryStatus,
  MessagingEscalationRecord,
  MessagingMessageDirection,
  MessagingMessageKind,
  MessagingMessageRecord,
  MessagingOperationCheckpoint,
  MessagingOperationKind,
  MessagingOperationRecord,
  MessagingOrderingMarker,
  MessagingRouteClass,
} from "../domain/messaging";

export interface MessagingConversationInsertInput {
  readonly conversationId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deploymentId: string;
  readonly pinnedPlanId: string;
  readonly pinnedPlanVersion: number;
  readonly executionId: string;
  readonly channelKind: string;
  readonly channelConversationRef: string;
  readonly orderingMode: string;
  readonly participantRef: string | null;
  readonly creationFingerprint: string;
  readonly createdBy: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export type MessagingConversationInsertOutcome =
  | { readonly status: "created"; readonly conversationId: string }
  | { readonly status: "converged"; readonly conversationId: string };

export interface MessagingMessageAppendInput {
  readonly messageId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly deploymentId: string;
  readonly kind: MessagingMessageKind;
  readonly direction: MessagingMessageDirection;
  readonly eventKey: string;
  readonly threadRef: string | null;
  readonly threadSequence: number | null;
  readonly orderingMarker: MessagingOrderingMarker | null;
  readonly executionId: string | null;
  readonly ledgerSequence: number | null;
  readonly routeClass: MessagingRouteClass | null;
  readonly replyToEventKey: string | null;
  readonly channelMessageRef: string | null;
  readonly deliveryStatus: MessagingDeliveryStatus | null;
  readonly cause: string | null;
  readonly payloadRef: string | null;
  readonly payloadPreview: string | null;
  readonly attachments: readonly string[];
  readonly actorId: string;
  readonly bodyDigest: string;
  readonly createdAt: string;
}

export type MessagingMessageAppendOutcome =
  | { readonly status: "appended"; readonly message: MessagingMessageRecord }
  /** The same (conversation, event_key, body) already committed — replay. */
  | { readonly status: "converged"; readonly message: MessagingMessageRecord };

export interface MessagingConversationMutation {
  readonly applicationId: string;
  readonly conversationId: string;
  /** The expected CURRENT status (the guard). */
  readonly expectedStatus: MessagingConversationStatus;
  /** The target status (the guarded status move). */
  readonly toStatus: MessagingConversationStatus;
  /** Closure timestamp for terminal moves. */
  readonly closedAt: string | null;
}

export type MessagingConversationMutationOutcome =
  | { readonly status: "applied"; readonly conversation: MessagingConversationRecord }
  | { readonly status: "converged"; readonly conversation: MessagingConversationRecord };

export interface MessagingDeliveryAppendInput {
  readonly deliveryId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly deploymentId: string;
  readonly messageId: string;
  readonly executionId: string | null;
  readonly callbackKey: string;
  readonly channelMessageRef: string;
  readonly fromStatus: MessagingDeliveryStatus;
  readonly toStatus: MessagingDeliveryStatus;
  readonly detail: string | null;
  readonly ledgerSequence: number | null;
  readonly actorId: string;
  readonly createdAt: string;
}

export type MessagingDeliveryAppendOutcome =
  | { readonly status: "appended"; readonly delivery: MessagingDeliveryRecord }
  | { readonly status: "converged"; readonly delivery: MessagingDeliveryRecord };

/** Input of `beginMessagingOperation` (the durable operation claim). */
export interface MessagingOperationBeginInput {
  readonly operationId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /**
   * Provenance reference only (NO physical FK): a conversation-start
   * operation row is durably claimed BEFORE its conversation row
   * exists — that ordering is exactly the crash window this ledger
   * closes.
   */
  readonly conversationId: string | null;
  readonly deploymentId: string;
  readonly executionId: string | null;
  readonly operationKind: MessagingOperationKind;
  readonly operationKey: string;
  readonly createdAt: string;
}

export type MessagingOperationBeginOutcome =
  | { readonly status: "begun"; readonly record: MessagingOperationRecord }
  | { readonly status: "existing"; readonly record: MessagingOperationRecord };

export interface MessagingEscalationInsertInput {
  readonly escalationId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly deploymentId: string;
  readonly executionId: string;
  readonly escalationKey: string;
  readonly destination: string;
  readonly cause: string | null;
  readonly waitSequence: number;
  readonly notifiedAt: string | null;
  readonly createdAt: string;
}

export type MessagingEscalationInsertOutcome =
  | { readonly status: "appended"; readonly escalation: MessagingEscalationRecord }
  | { readonly status: "converged"; readonly escalation: MessagingEscalationRecord };

export interface MessagingStore {
  insertConversation(
    input: MessagingConversationInsertInput,
  ): Promise<MessagingConversationInsertOutcome>;
  findConversation(applicationId: string, conversationId: string): Promise<MessagingConversationRecord | null>;
  /** The idempotent-replay fast path (the conversation-start key lookup). */
  findConversationByStartKey(
    applicationId: string,
    idempotencyKey: string,
  ): Promise<MessagingConversationRecord | null>;
  /** Find the conversation bound to a rail channel reference. */
  findConversationByChannel(
    applicationId: string,
    channelConversationRef: string,
  ): Promise<MessagingConversationRecord | null>;
  applyGuardedConversationMutation(
    input: MessagingConversationMutation,
  ): Promise<MessagingConversationMutationOutcome>;
  /** The message ledger of one conversation in append order. */
  listMessages(
    applicationId: string,
    conversationId: string,
  ): Promise<readonly MessagingMessageRecord[]>;
  /** One message by its stable Zeck-side identity (the event/message key). */
  findMessage(
    applicationId: string,
    conversationId: string,
    eventKey: string,
  ): Promise<MessagingMessageRecord | null>;
  appendMessage(input: MessagingMessageAppendInput): Promise<MessagingMessageAppendOutcome>;

  /**
   * Append one delivery-callback EVIDENCE row (the deliveries ledger
   * converges on the physical UNIQUE (application, conversation,
   * callback_key); a same-key/different-status replay fails closed).
   */
  appendDelivery(input: MessagingDeliveryAppendInput): Promise<MessagingDeliveryAppendOutcome>;
  /** The delivery-evidence rows of one conversation in append order. */
  listDeliveries(
    applicationId: string,
    conversationId: string,
  ): Promise<readonly MessagingDeliveryRecord[]>;
  /**
   * The message row's delivery-status PROJECTION: a guarded single-row
   * move that (i) requires the message to be an outbound agent-reply
   * of THIS conversation, (ii) requires the callback's channel message
   * reference to match the recorded one, and (iii) moves the status
   * only FORWARD through the frozen vocabulary (regressions and
   * terminal rewrites fail closed).
   */
  applyGuardedDeliveryStatusUpdate(input: {
    readonly applicationId: string;
    readonly conversationId: string;
    readonly messageId: string;
    readonly expectedChannelMessageRef: string | null;
    readonly toStatus: MessagingDeliveryStatus;
    readonly deliveredAt: string | null;
  }): Promise<
    | { readonly status: "applied"; readonly message: MessagingMessageRecord }
    | { readonly status: "converged"; readonly message: MessagingMessageRecord }
  >;

  /** Insert the immutable escalation record (idempotent by escalation key). */
  insertEscalation(input: MessagingEscalationInsertInput): Promise<MessagingEscalationInsertOutcome>;
  findEscalation(
    applicationId: string,
    escalationKey: string,
  ): Promise<MessagingEscalationRecord | null>;

  // -- the durable, recoverable operation state (WORK-024 standard) ------

  /**
   * Claim (or re-claim) one governed operation. Converges on the
   * physical UNIQUE (application, operation_key): the first invocation
   * inserts a PENDING row; every later invocation with the same key
   * returns the EXISTING row with `attempts` bumped — the caller MUST
   * distinguish `completed` (pure replay), `failed` (recorded failure
   * replay) and `pending` (crash-resume) before side effects.
   */
  beginMessagingOperation(
    input: MessagingOperationBeginInput,
  ): Promise<MessagingOperationBeginOutcome>;
  /**
   * Persist the stage checkpoint (PENDING rows only; the
   * past-the-point-of-no-return facts a resume completes from).
   */
  recordMessagingOperationCheckpoint(
    applicationId: string,
    operationKey: string,
    checkpoint: MessagingOperationCheckpoint,
    updatedAt: string,
  ): Promise<MessagingOperationRecord>;
  /** PENDING → COMPLETED (idempotent convergence; a failed operation cannot complete). */
  completeMessagingOperation(
    applicationId: string,
    operationKey: string,
    completedAt: string,
  ): Promise<MessagingOperationRecord>;
  /** PENDING → FAILED with a bounded reason (idempotent convergence when already failed). */
  failMessagingOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    failedAt: string,
  ): Promise<MessagingOperationRecord>;
  /** The operation lookup by its stable key (the recovery discriminator). */
  findMessagingOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<MessagingOperationRecord | null>;
}
