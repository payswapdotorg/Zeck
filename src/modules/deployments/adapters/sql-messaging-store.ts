/**
 * SQL messaging store (deployments module adapter; WORK-025).
 *
 * The durable implementation of the `MessagingStore` port over the
 * provider-neutral `DatabasePort` (migration
 * `0020_messaging_conversations.sql`). Physical invariants live in the
 * migration (conversation identity-core immutability, pinned plan
 * version, the frozen conversation status machine, append-only message
 * ledger, inbound idempotency UNIQUE, the guarded monotonic delivery
 * projection, the append-only delivery evidence ledger with the
 * correlation trigger, the immutable escalation records, and the
 * durable, recoverable operation state); this adapter maps rows <->
 * domain records and converges exactly like the WORK-023/024 SQL
 * stores:
 *
 *  - conversation insert: UNIQUE (application, idempotency_key) with
 *    fingerprint arbitration + the physical channel-coordinate UNIQUE;
 *  - `applyGuardedConversationMutation`: the single-row guarded UPDATE
 *    arbitrates concurrent mutations (first writer wins; duplicates
 *    converge on the committed row);
 *  - `appendMessage`: ON CONFLICT (application, conversation,
 *    event_key) DO NOTHING + digest-checked convergence — the message
 *    ledger IS the inbound idempotency ledger (a duplicate inbound
 *    event converges on the committed row; a same-key/different-body
 *    insert fails closed);
 *  - `appendDelivery`: ON CONFLICT (application, conversation,
 *    callback_key) DO NOTHING + status-checked convergence (the
 *    deliveries ledger is the callback evidence idempotency ledger);
 *    the correlation trigger physically rejects wrong-message
 *    callbacks;
 *  - `applyGuardedDeliveryStatusUpdate`: the single-row guarded UPDATE
 *    moves the delivery projection only FORWARD through the frozen
 *    vocabulary (the migration trigger makes regressions and terminal
 *    rewrites physically unrepresentable);
 *  - every read is scope-filtered (application);
 *  - trigger-raised guard violations are mapped to the typed error
 *    taxonomy (the migration is defense-in-depth behind the service's
 *    own guards).
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
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
  MessagingOperationStatus,
  MessagingOrderingMarker,
  MessagingRouteClass,
} from "../domain/messaging";
import type {
  MessagingConversationInsertInput,
  MessagingConversationInsertOutcome,
  MessagingConversationMutation,
  MessagingConversationMutationOutcome,
  MessagingDeliveryAppendInput,
  MessagingDeliveryAppendOutcome,
  MessagingEscalationInsertInput,
  MessagingEscalationInsertOutcome,
  MessagingMessageAppendInput,
  MessagingMessageAppendOutcome,
  MessagingOperationBeginInput,
  MessagingOperationBeginOutcome,
  MessagingStore,
} from "../ports/messaging-store";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map migration-trigger guard violations to the typed taxonomy. */
function toTypedGuardError(error: unknown): PlatformError {
  const message = messageOf(error);
  if (
    message.includes("messaging conversation") &&
    message.includes("identity core is immutable")
  ) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "msg_conversations_core_guard" },
    });
  }
  if (
    message.includes("messaging_conversations is terminal-immutable") ||
    (message.includes("messaging conversation") && message.includes("cannot move from status"))
  ) {
    return new PlatformError({ code: "INVALID_STATE_TRANSITION", message });
  }
  if (message.includes("messaging_messages is append-only")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "msg_messages_append_only_guard" },
    });
  }
  if (message.includes("delivery status is terminal-immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "msg_messages_append_only_guard" },
    });
  }
  if (message.includes("delivery status cannot regress")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "msg_messages_append_only_guard" },
    });
  }
  if (message.includes("callback correlation violation")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "msg_deliveries_correlated_guard" },
    });
  }
  if (message.includes("messaging_deliveries is append-only")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "msg_deliveries_append_only_guard" },
    });
  }
  if (message.includes("messaging_escalations is write-once")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "msg_escalations_immutable_guard" },
    });
  }
  if (message.includes("messaging_operations identity core is immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "msg_ops_core_guard" },
    });
  }
  if (message.includes("messaging operation") && message.includes("cannot move from status")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "msg_ops_lifecycle_guard" },
    });
  }
  if (message.includes("messaging_operations is terminal-immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "msg_ops_lifecycle_guard" },
    });
  }
  if (message.includes("artifact-reference strings") || message.includes("attachment reference")) {
    return new PlatformError({
      code: "PROVIDER_ERROR",
      message,
      details: { guard: "msg_messages_attachments_refs_guard" },
    });
  }
  // The operations ledger's (application_id, tenant_id) FK: a claim for
  // a tenant that does not own the application IS a tenant-scope
  // violation (the claim is the first durable write of an operation).
  if (
    message.includes("messaging_operations") &&
    message.includes("violates foreign key constraint")
  ) {
    return new PlatformError({
      code: "TENANT_SCOPE_VIOLATION",
      message: "messaging operation claims require a tenant that owns the application",
      details: { guard: "msg_ops_tenant_fk", cause: message },
    });
  }
  return new PlatformError({
    code: "PROVIDER_ERROR",
    message: "messaging store guard rejection",
    details: { cause: message },
  });
}

interface ConversationRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly deployment_id: string;
  readonly pinned_plan_id: string;
  readonly pinned_plan_version: number;
  readonly execution_id: string;
  readonly channel_kind: string;
  readonly channel_conversation_ref: string;
  readonly ordering_mode: string;
  readonly participant_ref: string | null;
  readonly status: string;
  readonly creation_fingerprint: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly closed_at: Date | string | null;
}

function toConversation(row: ConversationRow): MessagingConversationRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    deploymentId: row.deployment_id,
    pinnedPlanId: row.pinned_plan_id,
    pinnedPlanVersion: row.pinned_plan_version,
    executionId: row.execution_id,
    channelKind: row.channel_kind as MessagingConversationRecord["channelKind"],
    channelConversationRef: row.channel_conversation_ref,
    orderingMode: row.ordering_mode as MessagingConversationRecord["orderingMode"],
    participantRef: row.participant_ref,
    status: row.status as MessagingConversationStatus,
    creationFingerprint: row.creation_fingerprint,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    closedAt:
      row.closed_at === null
        ? null
        : row.closed_at instanceof Date
          ? row.closed_at.toISOString()
          : String(row.closed_at),
  };
}

const CONVERSATION_COLUMNS = `id, application_id, tenant_id, deployment_id, pinned_plan_id,
    pinned_plan_version, execution_id, channel_kind, channel_conversation_ref, ordering_mode,
    participant_ref, status, creation_fingerprint, created_at, updated_at, closed_at`;

interface MessageRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly deployment_id: string;
  readonly kind: string;
  readonly direction: string;
  readonly event_key: string;
  readonly thread_ref: string | null;
  readonly thread_sequence: number | null;
  readonly ordering_marker: string | null;
  readonly execution_id: string | null;
  readonly ledger_sequence: string | number | null;
  readonly route_class: string | null;
  readonly reply_to_event_key: string | null;
  readonly channel_message_ref: string | null;
  readonly delivery_status: string | null;
  readonly delivered_at: Date | string | null;
  readonly cause: string | null;
  readonly payload_ref: string | null;
  readonly payload_preview: string | null;
  readonly attachments: unknown;
  readonly actor_id: string;
  readonly event_seq: string | number;
  readonly body_digest: string;
  readonly created_at: Date | string;
}

function toMessage(row: MessageRow): MessagingMessageRecord {
  const attachments = Array.isArray(row.attachments)
    ? (row.attachments as unknown[]).map((ref) => String(ref))
    : [];
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    deploymentId: row.deployment_id,
    kind: row.kind as MessagingMessageKind,
    direction: row.direction as MessagingMessageDirection,
    eventKey: row.event_key,
    threadRef: row.thread_ref,
    threadSequence: row.thread_sequence === null ? null : Number(row.thread_sequence),
    orderingMarker:
      row.ordering_marker === null ? null : (row.ordering_marker as MessagingOrderingMarker),
    executionId: row.execution_id,
    ledgerSequence: row.ledger_sequence === null ? null : Number(row.ledger_sequence),
    routeClass: row.route_class === null ? null : (row.route_class as MessagingRouteClass),
    replyToEventKey: row.reply_to_event_key,
    channelMessageRef: row.channel_message_ref,
    deliveryStatus:
      row.delivery_status === null ? null : (row.delivery_status as MessagingDeliveryStatus),
    deliveredAt:
      row.delivered_at === null
        ? null
        : row.delivered_at instanceof Date
          ? row.delivered_at.toISOString()
          : String(row.delivered_at),
    cause: row.cause,
    payloadRef: row.payload_ref,
    payloadPreview: row.payload_preview,
    attachments,
    actorId: row.actor_id,
    eventSeq: Number(row.event_seq),
    bodyDigest: row.body_digest,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

const MESSAGE_COLUMNS = `id, application_id, tenant_id, conversation_id, deployment_id, kind,
    direction, event_key, thread_ref, thread_sequence, ordering_marker, execution_id,
    ledger_sequence, route_class, reply_to_event_key, channel_message_ref, delivery_status,
    delivered_at, cause, payload_ref, payload_preview, attachments, actor_id, event_seq,
    body_digest, created_at`;

interface DeliveryRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly deployment_id: string;
  readonly message_id: string;
  readonly execution_id: string | null;
  readonly callback_key: string;
  readonly channel_message_ref: string;
  readonly from_status: string;
  readonly to_status: string;
  readonly detail: string | null;
  readonly ledger_sequence: string | number | null;
  readonly actor_id: string;
  readonly event_seq: string | number;
  readonly created_at: Date | string;
}

function toDelivery(row: DeliveryRow): MessagingDeliveryRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    deploymentId: row.deployment_id,
    messageId: row.message_id,
    executionId: row.execution_id,
    callbackKey: row.callback_key,
    channelMessageRef: row.channel_message_ref,
    fromStatus: row.from_status as MessagingDeliveryStatus,
    toStatus: row.to_status as MessagingDeliveryStatus,
    detail: row.detail,
    ledgerSequence: row.ledger_sequence === null ? null : Number(row.ledger_sequence),
    actorId: row.actor_id,
    eventSeq: Number(row.event_seq),
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

const DELIVERY_COLUMNS = `id, application_id, tenant_id, conversation_id, deployment_id, message_id,
    execution_id, callback_key, channel_message_ref, from_status, to_status, detail,
    ledger_sequence, actor_id, event_seq, created_at`;

interface EscalationRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly deployment_id: string;
  readonly execution_id: string;
  readonly escalation_key: string;
  readonly destination: string;
  readonly cause: string | null;
  readonly wait_sequence: string | number;
  readonly notified_at: Date | string | null;
  readonly created_at: Date | string;
}

function toEscalation(row: EscalationRow): MessagingEscalationRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    deploymentId: row.deployment_id,
    executionId: row.execution_id,
    escalationKey: row.escalation_key,
    destination: row.destination,
    cause: row.cause,
    waitSequence: Number(row.wait_sequence),
    notifiedAt:
      row.notified_at === null
        ? null
        : row.notified_at instanceof Date
          ? row.notified_at.toISOString()
          : String(row.notified_at),
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

const ESCALATION_COLUMNS = `id, application_id, tenant_id, conversation_id, deployment_id,
    execution_id, escalation_key, destination, cause, wait_sequence, notified_at, created_at`;

interface OperationRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly conversation_id: string | null;
  readonly deployment_id: string;
  readonly execution_id: string | null;
  readonly operation_kind: string;
  readonly operation_key: string;
  readonly status: string;
  readonly attempts: number | string;
  readonly checkpoint: MessagingOperationCheckpoint | null;
  readonly failure_reason: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly completed_at: Date | string | null;
}

function toOperation(row: OperationRow): MessagingOperationRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    deploymentId: row.deployment_id,
    executionId: row.execution_id,
    operationKind: row.operation_kind as MessagingOperationKind,
    operationKey: row.operation_key,
    status: row.status as MessagingOperationStatus,
    attempts: Number(row.attempts),
    checkpoint: row.checkpoint,
    failureReason: row.failure_reason,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    completedAt:
      row.completed_at === null
        ? null
        : row.completed_at instanceof Date
          ? row.completed_at.toISOString()
          : String(row.completed_at),
  };
}

const OPERATION_COLUMNS = `id, application_id, tenant_id, conversation_id, deployment_id, execution_id,
    operation_kind, operation_key, status, attempts, checkpoint, failure_reason, created_at,
    updated_at, completed_at`;

export class SqlMessagingStore implements MessagingStore {
  constructor(private readonly db: DatabasePort) {}

  async insertConversation(
    input: MessagingConversationInsertInput,
  ): Promise<MessagingConversationInsertOutcome> {
    try {
      const result = await this.db.execute<ConversationRow>({
        sql: `INSERT INTO deployments.messaging_conversations (
    ${CONVERSATION_COLUMNS}, created_by, idempotency_key)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12, $13, $13, NULL, $15, $14)
RETURNING ${CONVERSATION_COLUMNS}`,
        parameters: [
          input.conversationId,
          input.applicationId,
          input.tenantId,
          input.deploymentId,
          input.pinnedPlanId,
          input.pinnedPlanVersion,
          input.executionId,
          input.channelKind,
          input.channelConversationRef,
          input.orderingMode,
          input.participantRef,
          input.creationFingerprint,
          input.createdAt,
          input.idempotencyKey,
          input.createdBy,
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "created", conversationId: row.id };
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        const message = messageOf(error);
        if (message.includes("msg_conversations_key_unique")) {
          // Idempotent replay: converge on the committed row after
          // fingerprint arbitration.
          const existing = await this.findConversationRowByStartKey(
            input.applicationId,
            input.idempotencyKey,
          );
          if (existing !== null) {
            if (existing.creation_fingerprint !== input.creationFingerprint) {
              throw new PlatformError({
                code: "IDEMPOTENCY_KEY_REUSED",
                message:
                  "messaging conversation idempotency key already exists with a different creation fingerprint",
                details: { conversationId: existing.id },
              });
            }
            return { status: "converged", conversationId: existing.id };
          }
        }
        if (message.includes("msg_conversations_channel_unique")) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message:
              "the rail channel conversation reference is already bound to another messaging conversation",
            details: { channelConversationRef: input.channelConversationRef },
          });
        }
      }
      throw toTypedGuardError(error);
    }
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "conversation insert returned no row",
    });
  }

  async findConversation(applicationId: string, conversationId: string) {
    const result = await this.db.execute<ConversationRow>({
      sql: `SELECT ${CONVERSATION_COLUMNS} FROM deployments.messaging_conversations
WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, conversationId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toConversation(row);
  }

  async findConversationByStartKey(applicationId: string, idempotencyKey: string) {
    const result = await this.db.execute<ConversationRow>({
      sql: `SELECT ${CONVERSATION_COLUMNS} FROM deployments.messaging_conversations
WHERE application_id = $1 AND idempotency_key = $2`,
      parameters: [applicationId, idempotencyKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : toConversation(row);
  }

  async findConversationByChannel(applicationId: string, channelConversationRef: string) {
    const result = await this.db.execute<ConversationRow>({
      sql: `SELECT ${CONVERSATION_COLUMNS} FROM deployments.messaging_conversations
WHERE application_id = $1 AND channel_conversation_ref = $2`,
      parameters: [applicationId, channelConversationRef],
    });
    const row = result.rows[0];
    return row === undefined ? null : toConversation(row);
  }

  async applyGuardedConversationMutation(
    input: MessagingConversationMutation,
  ): Promise<MessagingConversationMutationOutcome> {
    try {
      const result = await this.db.execute<ConversationRow>({
        sql: `UPDATE deployments.messaging_conversations
SET status = $1,
    updated_at = $2,
    closed_at = COALESCE($3, closed_at)
WHERE application_id = $4 AND id = $5 AND status = $6
RETURNING ${CONVERSATION_COLUMNS}`,
        parameters: [
          input.toStatus,
          new Date().toISOString(),
          input.closedAt,
          input.applicationId,
          input.conversationId,
          input.expectedStatus,
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "applied", conversation: toConversation(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // First writer already moved the row (or the guard disagrees):
    // converge when the committed state equals the target; fail closed
    // when it does not.
    const current = await this.findConversation(input.applicationId, input.conversationId);
    if (current === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `messaging conversation ${input.conversationId} not found in this application`,
      });
    }
    if (current.status === input.toStatus) {
      return { status: "converged", conversation: current };
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `messaging conversation ${input.conversationId} guard disagreed: row is ${current.status}; the guarded mutation expected ${input.expectedStatus} (first writer wins; replays converge on the committed state)`,
    });
  }

  async listMessages(applicationId: string, conversationId: string) {
    const result = await this.db.execute<MessageRow>({
      sql: `SELECT ${MESSAGE_COLUMNS} FROM deployments.messaging_messages
WHERE application_id = $1 AND conversation_id = $2 ORDER BY event_seq`,
      parameters: [applicationId, conversationId],
    });
    return result.rows.map(toMessage);
  }

  async findMessage(applicationId: string, conversationId: string, eventKey: string) {
    const result = await this.db.execute<MessageRow>({
      sql: `SELECT ${MESSAGE_COLUMNS} FROM deployments.messaging_messages
WHERE application_id = $1 AND conversation_id = $2 AND event_key = $3`,
      parameters: [applicationId, conversationId, eventKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : toMessage(row);
  }

  async appendMessage(input: MessagingMessageAppendInput): Promise<MessagingMessageAppendOutcome> {
    try {
      const result = await this.db.execute<MessageRow>({
        sql: `INSERT INTO deployments.messaging_messages (
    id, application_id, tenant_id, conversation_id, deployment_id, kind, direction, event_key,
    thread_ref, thread_sequence, ordering_marker, execution_id, ledger_sequence, route_class,
    reply_to_event_key, channel_message_ref, delivery_status, cause, payload_ref, payload_preview,
    attachments, actor_id, body_digest, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, $22, $23, $24)
ON CONFLICT (application_id, conversation_id, event_key) DO NOTHING
RETURNING ${MESSAGE_COLUMNS}`,
        parameters: [
          input.messageId,
          input.applicationId,
          input.tenantId,
          input.conversationId,
          input.deploymentId,
          input.kind,
          input.direction,
          input.eventKey,
          input.threadRef,
          input.threadSequence,
          input.orderingMarker,
          input.executionId,
          input.ledgerSequence,
          input.routeClass,
          input.replyToEventKey,
          input.channelMessageRef,
          input.deliveryStatus,
          input.cause,
          input.payloadRef,
          input.payloadPreview,
          JSON.stringify(input.attachments),
          input.actorId,
          input.bodyDigest,
          input.createdAt,
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "appended", message: toMessage(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // The conflict path: converge on the committed row when the body
    // digest matches; fail closed when it does not (same key,
    // different body — a poisoned replay).
    const existing = await this.findMessage(
      input.applicationId,
      input.conversationId,
      input.eventKey,
    );
    if (existing !== null) {
      if (existing.bodyDigest !== input.bodyDigest) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "messaging event key already exists with a different body",
          details: { eventKey: input.eventKey },
        });
      }
      return { status: "converged", message: existing };
    }
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "messaging message insert returned no row",
    });
  }

  async appendDelivery(
    input: MessagingDeliveryAppendInput,
  ): Promise<MessagingDeliveryAppendOutcome> {
    try {
      const result = await this.db.execute<DeliveryRow>({
        sql: `INSERT INTO deployments.messaging_deliveries (
    id, application_id, tenant_id, conversation_id, deployment_id, message_id, execution_id,
    callback_key, channel_message_ref, from_status, to_status, detail, ledger_sequence, actor_id,
    created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
ON CONFLICT (application_id, conversation_id, callback_key) DO NOTHING
RETURNING ${DELIVERY_COLUMNS}`,
        parameters: [
          input.deliveryId,
          input.applicationId,
          input.tenantId,
          input.conversationId,
          input.deploymentId,
          input.messageId,
          input.executionId,
          input.callbackKey,
          input.channelMessageRef,
          input.fromStatus,
          input.toStatus,
          input.detail,
          input.ledgerSequence,
          input.actorId,
          input.createdAt,
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "appended", delivery: toDelivery(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // The conflict path: converge on the committed row when the
    // reported status matches; fail closed when it does not (same key,
    // different status — a poisoned callback replay).
    const existing = await this.findDeliveryRow(
      input.applicationId,
      input.conversationId,
      input.callbackKey,
    );
    if (existing !== null) {
      if (existing.to_status !== input.toStatus) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "messaging delivery callback key already exists with a different status",
          details: { callbackKey: input.callbackKey },
        });
      }
      return { status: "converged", delivery: toDelivery(existing) };
    }
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "messaging delivery insert returned no row",
    });
  }

  async listDeliveries(applicationId: string, conversationId: string) {
    const result = await this.db.execute<DeliveryRow>({
      sql: `SELECT ${DELIVERY_COLUMNS} FROM deployments.messaging_deliveries
WHERE application_id = $1 AND conversation_id = $2 ORDER BY event_seq`,
      parameters: [applicationId, conversationId],
    });
    return result.rows.map(toDelivery);
  }

  async applyGuardedDeliveryStatusUpdate(input: {
    readonly applicationId: string;
    readonly conversationId: string;
    readonly messageId: string;
    readonly expectedChannelMessageRef: string | null;
    readonly toStatus: MessagingDeliveryStatus;
    readonly deliveredAt: string | null;
  }) {
    try {
      const result = await this.db.execute<MessageRow>({
        sql: `UPDATE deployments.messaging_messages
SET delivery_status = $1,
    delivered_at = COALESCE($2, delivered_at),
    ledger_sequence = COALESCE($3, ledger_sequence)
WHERE application_id = $4 AND conversation_id = $5 AND id = $6 AND kind = 'agent-reply'
  AND ($7::text IS NULL OR channel_message_ref = $7)
  AND (delivery_status IS NULL OR delivery_status = $1
       OR (delivery_status = 'pending' AND $1 IN ('sent','delivered','undelivered'))
       OR (delivery_status = 'sent' AND $1 IN ('delivered','undelivered')))
RETURNING ${MESSAGE_COLUMNS}`,
        parameters: [
          input.toStatus,
          input.deliveredAt,
          null,
          input.applicationId,
          input.conversationId,
          input.messageId,
          input.expectedChannelMessageRef,
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        const updated = toMessage(row);
        return updated.deliveryStatus === input.toStatus
          ? { status: "applied" as const, message: updated }
          : { status: "converged" as const, message: updated };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // No row moved: re-read and classify (wrong kind / wrong reference /
    // stale callback / already converged).
    const current = await this.findMessageRow(input.applicationId, input.messageId);
    if (current === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "the delivery projection requires an outbound agent-reply of this conversation",
        details: { messageId: input.messageId },
      });
    }
    if (current.kind !== "agent-reply" || current.conversation_id !== input.conversationId) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "the delivery projection requires an outbound agent-reply of this conversation",
        details: { messageId: input.messageId },
      });
    }
    if (
      input.expectedChannelMessageRef !== null &&
      current.channel_message_ref !== input.expectedChannelMessageRef
    ) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message:
          "delivery callback correlation rejected: the rail message reference does not match the originating send",
        details: { messageId: input.messageId },
      });
    }
    // The row exists and is correlated: a stale or already-applied
    // callback converges WITHOUT moving the monotonic projection.
    return { status: "converged" as const, message: toMessage(current) };
  }

  async insertEscalation(
    input: MessagingEscalationInsertInput,
  ): Promise<MessagingEscalationInsertOutcome> {
    try {
      const result = await this.db.execute<EscalationRow>({
        sql: `INSERT INTO deployments.messaging_escalations (
    ${ESCALATION_COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
ON CONFLICT (application_id, escalation_key) DO NOTHING
RETURNING ${ESCALATION_COLUMNS}`,
        parameters: [
          input.escalationId,
          input.applicationId,
          input.tenantId,
          input.conversationId,
          input.deploymentId,
          input.executionId,
          input.escalationKey,
          input.destination,
          input.cause,
          input.waitSequence,
          input.notifiedAt,
          input.createdAt,
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "appended", escalation: toEscalation(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.findEscalation(input.applicationId, input.escalationKey);
    if (existing !== null) {
      return { status: "converged", escalation: existing };
    }
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "messaging escalation insert returned no row",
    });
  }

  async findEscalation(applicationId: string, escalationKey: string) {
    const result = await this.db.execute<EscalationRow>({
      sql: `SELECT ${ESCALATION_COLUMNS} FROM deployments.messaging_escalations
WHERE application_id = $1 AND escalation_key = $2`,
      parameters: [applicationId, escalationKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : toEscalation(row);
  }

  // -- the durable, recoverable operation state (WORK-024 standard) --

  async beginMessagingOperation(
    input: MessagingOperationBeginInput,
  ): Promise<MessagingOperationBeginOutcome> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `INSERT INTO deployments.messaging_operations (
    ${OPERATION_COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 1, NULL, NULL, $9, $9, NULL)
ON CONFLICT (application_id, operation_key) DO NOTHING
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [
          input.operationId,
          input.applicationId,
          input.tenantId,
          input.conversationId,
          input.deploymentId,
          input.executionId,
          input.operationKind,
          input.operationKey,
          input.createdAt,
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "begun", record: toOperation(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // The conflict path: the operation row already exists — bump the
    // attempts ledger (PENDING rows only; a terminal row is immutable,
    // so a completed/failed operation replays without an attempt bump).
    const existing = await this.findMessagingOperation(input.applicationId, input.operationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "messaging operation begin returned no row",
        details: { operationKey: input.operationKey },
      });
    }
    if (existing.status !== "pending") {
      return { status: "existing", record: existing };
    }
    try {
      const bumped = await this.db.execute<OperationRow>({
        sql: `UPDATE deployments.messaging_operations
SET attempts = attempts + 1, updated_at = $3
WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [input.applicationId, input.operationKey, input.createdAt],
      });
      const row = bumped.rows[0];
      if (row !== undefined) {
        return { status: "existing", record: toOperation(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // A concurrent terminal move won the race: replay the committed row.
    const committed = await this.findMessagingOperation(input.applicationId, input.operationKey);
    if (committed === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "messaging operation row disappeared after begin",
        details: { operationKey: input.operationKey },
      });
    }
    return { status: "existing", record: committed };
  }

  async recordMessagingOperationCheckpoint(
    applicationId: string,
    operationKey: string,
    checkpoint: MessagingOperationCheckpoint,
    updatedAt: string,
  ): Promise<MessagingOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE deployments.messaging_operations
SET checkpoint = $3::jsonb, updated_at = $4
WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [applicationId, operationKey, JSON.stringify(checkpoint), updatedAt],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return toOperation(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.requireOperation(applicationId, operationKey);
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `messaging operation ${operationKey} is ${existing.status}; a checkpoint is writable only while pending`,
    });
  }

  async completeMessagingOperation(
    applicationId: string,
    operationKey: string,
    completedAt: string,
  ): Promise<MessagingOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE deployments.messaging_operations
SET status = 'completed', completed_at = $3, updated_at = $3
WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [applicationId, operationKey, completedAt],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return toOperation(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.requireOperation(applicationId, operationKey);
    if (existing.status === "completed") {
      // Idempotent convergence: the durable outcome already exists.
      return existing;
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `messaging operation ${operationKey} is ${existing.status}; a failed operation cannot be completed`,
      details: { failureReason: existing.failureReason },
    });
  }

  async failMessagingOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    failedAt: string,
  ): Promise<MessagingOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE deployments.messaging_operations
SET status = 'failed', failure_reason = $3, updated_at = $4
WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
RETURNING ${OPERATION_COLUMNS}`,
        parameters: [applicationId, operationKey, reason.slice(0, 512), failedAt],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return toOperation(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.requireOperation(applicationId, operationKey);
    if (existing.status === "failed") {
      // Idempotent convergence: the recorded failure already exists.
      return existing;
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `messaging operation ${operationKey} is ${existing.status}; a completed operation cannot be failed`,
      details: { completedAt: existing.completedAt },
    });
  }

  async findMessagingOperation(applicationId: string, operationKey: string) {
    const result = await this.db.execute<OperationRow>({
      sql: `SELECT ${OPERATION_COLUMNS} FROM deployments.messaging_operations
WHERE application_id = $1 AND operation_key = $2`,
      parameters: [applicationId, operationKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : toOperation(row);
  }

  private async requireOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<MessagingOperationRecord> {
    const existing = await this.findMessagingOperation(applicationId, operationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `messaging operation ${operationKey} not found in this application`,
      });
    }
    return existing;
  }

  private async findConversationRowByStartKey(
    applicationId: string,
    idempotencyKey: string,
  ): Promise<(ConversationRow & { creation_fingerprint: string }) | null> {
    const result = await this.db.execute<ConversationRow & { creation_fingerprint: string }>({
      sql: `SELECT ${CONVERSATION_COLUMNS} FROM deployments.messaging_conversations
WHERE application_id = $1 AND idempotency_key = $2`,
      parameters: [applicationId, idempotencyKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : row;
  }

  private async findMessageRow(applicationId: string, messageId: string) {
    const result = await this.db.execute<MessageRow>({
      sql: `SELECT ${MESSAGE_COLUMNS} FROM deployments.messaging_messages
WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, messageId],
    });
    const row = result.rows[0];
    return row === undefined ? null : row;
  }

  private async findDeliveryRow(
    applicationId: string,
    conversationId: string,
    callbackKey: string,
  ) {
    const result = await this.db.execute<DeliveryRow>({
      sql: `SELECT ${DELIVERY_COLUMNS} FROM deployments.messaging_deliveries
WHERE application_id = $1 AND conversation_id = $2 AND callback_key = $3`,
      parameters: [applicationId, conversationId, callbackKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : row;
  }
}
