/**
 * In-memory messaging store (deployments module adapter; WORK-025).
 *
 * The test/world implementation of the `MessagingStore` port with the
 * SAME arbitration contract as the SQL store (migration 0020):
 * idempotent conversation creation, guarded conversation mutations,
 * the append-only message ledger as the inbound idempotency ledger,
 * the correlation-guarded monotonic delivery projection, the
 * append-only delivery evidence ledger, immutable escalation records
 * and the durable, recoverable operation state (PENDING ->
 * COMPLETED|FAILED with the same key-uniqueness, attempts-ledger and
 * terminal-immutability discipline).
 */

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
import {
  canTransitionMessagingConversation,
  isForwardMessagingDeliveryMove,
  isTerminalMessagingConversationStatus,
  isTerminalMessagingDeliveryStatus,
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

interface MemoryConversation {
  readonly id: string;
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
  status: MessagingConversationStatus;
  readonly creationFingerprint: string;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

interface MemoryMessage {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly deploymentId: string;
  readonly kind: MessagingMessageKind;
  readonly direction: MessagingMessageDirection;
  readonly eventKey: string;
  threadRef: string | null;
  threadSequence: number | null;
  readonly orderingMarker: MessagingOrderingMarker | null;
  readonly executionId: string | null;
  ledgerSequence: number | null;
  readonly routeClass: MessagingRouteClass | null;
  readonly replyToEventKey: string | null;
  readonly channelMessageRef: string | null;
  deliveryStatus: MessagingDeliveryStatus | null;
  deliveredAt: string | null;
  readonly cause: string | null;
  readonly payloadRef: string | null;
  readonly payloadPreview: string | null;
  readonly attachments: readonly string[];
  readonly actorId: string;
  readonly eventSeq: number;
  readonly bodyDigest: string;
  readonly createdAt: string;
}

interface MemoryDelivery {
  readonly id: string;
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
  ledgerSequence: number | null;
  readonly actorId: string;
  readonly eventSeq: number;
  readonly createdAt: string;
}

interface MemoryEscalation {
  readonly id: string;
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

interface MemoryOperation {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly conversationId: string | null;
  readonly deploymentId: string;
  readonly executionId: string | null;
  readonly operationKind: MessagingOperationKind;
  readonly operationKey: string;
  status: MessagingOperationStatus;
  attempts: number;
  checkpoint: MessagingOperationCheckpoint | null;
  failureReason: string | null;
  readonly createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function toConversation(row: MemoryConversation): MessagingConversationRecord {
  return {
    id: row.id,
    applicationId: row.applicationId,
    tenantId: row.tenantId,
    deploymentId: row.deploymentId,
    pinnedPlanId: row.pinnedPlanId,
    pinnedPlanVersion: row.pinnedPlanVersion,
    executionId: row.executionId,
    channelKind: row.channelKind as MessagingConversationRecord["channelKind"],
    channelConversationRef: row.channelConversationRef,
    orderingMode: row.orderingMode as MessagingConversationRecord["orderingMode"],
    participantRef: row.participantRef,
    status: row.status,
    creationFingerprint: row.creationFingerprint,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt,
  };
}

function toMessage(row: MemoryMessage): MessagingMessageRecord {
  return {
    id: row.id,
    applicationId: row.applicationId,
    tenantId: row.tenantId,
    conversationId: row.conversationId,
    deploymentId: row.deploymentId,
    kind: row.kind,
    direction: row.direction,
    eventKey: row.eventKey,
    threadRef: row.threadRef,
    threadSequence: row.threadSequence,
    orderingMarker: row.orderingMarker,
    executionId: row.executionId,
    ledgerSequence: row.ledgerSequence,
    routeClass: row.routeClass,
    replyToEventKey: row.replyToEventKey,
    channelMessageRef: row.channelMessageRef,
    deliveryStatus: row.deliveryStatus,
    deliveredAt: row.deliveredAt,
    cause: row.cause,
    payloadRef: row.payloadRef,
    payloadPreview: row.payloadPreview,
    attachments: row.attachments,
    actorId: row.actorId,
    eventSeq: row.eventSeq,
    bodyDigest: row.bodyDigest,
    createdAt: row.createdAt,
  };
}

function toDelivery(row: MemoryDelivery): MessagingDeliveryRecord {
  return {
    id: row.id,
    applicationId: row.applicationId,
    tenantId: row.tenantId,
    conversationId: row.conversationId,
    deploymentId: row.deploymentId,
    messageId: row.messageId,
    executionId: row.executionId,
    callbackKey: row.callbackKey,
    channelMessageRef: row.channelMessageRef,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    detail: row.detail,
    ledgerSequence: row.ledgerSequence,
    actorId: row.actorId,
    eventSeq: row.eventSeq,
    createdAt: row.createdAt,
  };
}

function toEscalation(row: MemoryEscalation): MessagingEscalationRecord {
  return {
    id: row.id,
    applicationId: row.applicationId,
    tenantId: row.tenantId,
    conversationId: row.conversationId,
    deploymentId: row.deploymentId,
    executionId: row.executionId,
    escalationKey: row.escalationKey,
    destination: row.destination,
    cause: row.cause,
    waitSequence: row.waitSequence,
    notifiedAt: row.notifiedAt,
    createdAt: row.createdAt,
  };
}

function toOperation(row: MemoryOperation): MessagingOperationRecord {
  return {
    id: row.id,
    applicationId: row.applicationId,
    tenantId: row.tenantId,
    conversationId: row.conversationId,
    deploymentId: row.deploymentId,
    executionId: row.executionId,
    operationKind: row.operationKind,
    operationKey: row.operationKey,
    status: row.status,
    attempts: row.attempts,
    checkpoint: row.checkpoint,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

export class InMemoryMessagingStore implements MessagingStore {
  private readonly conversations = new Map<string, MemoryConversation>();
  private readonly messages = new Map<string, MemoryMessage[]>();
  private readonly deliveries = new Map<string, MemoryDelivery[]>();
  private readonly escalations = new Map<string, MemoryEscalation>();
  private readonly operations = new Map<string, MemoryOperation>();
  private seq = 0;

  async insertConversation(
    input: MessagingConversationInsertInput,
  ): Promise<MessagingConversationInsertOutcome> {
    const conversationKey = `${input.applicationId}:${input.idempotencyKey}`;
    const existing = this.conversations.get(conversationKey);
    if (existing !== undefined) {
      if (existing.creationFingerprint !== input.creationFingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message:
            "messaging conversation idempotency key already exists with a different creation fingerprint",
          details: { conversationId: existing.id },
        });
      }
      return { status: "converged", conversationId: existing.id };
    }
    for (const conversation of this.conversations.values()) {
      if (
        conversation.applicationId === input.applicationId &&
        conversation.channelConversationRef === input.channelConversationRef
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "the rail channel conversation reference is already bound to another conversation",
          details: { channelConversationRef: input.channelConversationRef },
        });
      }
    }
    const conversation: MemoryConversation = {
      id: input.conversationId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      deploymentId: input.deploymentId,
      pinnedPlanId: input.pinnedPlanId,
      pinnedPlanVersion: input.pinnedPlanVersion,
      executionId: input.executionId,
      channelKind: input.channelKind,
      channelConversationRef: input.channelConversationRef,
      orderingMode: input.orderingMode,
      participantRef: input.participantRef,
      status: "active",
      creationFingerprint: input.creationFingerprint,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      closedAt: null,
    };
    this.conversations.set(conversationKey, conversation);
    this.messages.set(`${input.applicationId}:${conversation.id}`, []);
    this.deliveries.set(`${input.applicationId}:${conversation.id}`, []);
    return { status: "created", conversationId: conversation.id };
  }

  async findConversation(applicationId: string, conversationId: string) {
    for (const conversation of this.conversations.values()) {
      if (conversation.applicationId === applicationId && conversation.id === conversationId) {
        return toConversation(conversation);
      }
    }
    return null;
  }

  async findConversationByStartKey(applicationId: string, idempotencyKey: string) {
    const existing = this.conversations.get(`${applicationId}:${idempotencyKey}`);
    return existing === undefined ? null : toConversation(existing);
  }

  async findConversationByChannel(applicationId: string, channelConversationRef: string) {
    for (const conversation of this.conversations.values()) {
      if (
        conversation.applicationId === applicationId &&
        conversation.channelConversationRef === channelConversationRef
      ) {
        return toConversation(conversation);
      }
    }
    return null;
  }

  async applyGuardedConversationMutation(
    input: MessagingConversationMutation,
  ): Promise<MessagingConversationMutationOutcome> {
    for (const [key, conversation] of this.conversations.entries()) {
      if (
        conversation.applicationId === input.applicationId &&
        conversation.id === input.conversationId
      ) {
        if (
          conversation.status === input.expectedStatus ||
          (isTerminalMessagingConversationStatus(conversation.status) &&
            conversation.status === input.toStatus)
        ) {
          if (
            conversation.status !== input.toStatus &&
            !canTransitionMessagingConversation(conversation.status, input.toStatus)
          ) {
            break;
          }
          if (conversation.status !== input.toStatus) {
            conversation.status = input.toStatus;
            conversation.updatedAt = new Date().toISOString();
            conversation.closedAt = input.closedAt ?? conversation.closedAt;
          }
          return { status: "applied", conversation: toConversation(conversation) };
        }
        break;
      }
      void key;
    }
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
    const rows = this.messages.get(`${applicationId}:${conversationId}`) ?? [];
    return rows.map(toMessage);
  }

  async findMessage(applicationId: string, conversationId: string, eventKey: string) {
    const rows = this.messages.get(`${applicationId}:${conversationId}`) ?? [];
    const row = rows.find((message) => message.eventKey === eventKey);
    return row === undefined ? null : toMessage(row);
  }

  async appendMessage(input: MessagingMessageAppendInput): Promise<MessagingMessageAppendOutcome> {
    const listKey = `${input.applicationId}:${input.conversationId}`;
    const rows = this.messages.get(listKey);
    if (rows === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `messaging conversation ${input.conversationId} not found in this application`,
      });
    }
    const existing = rows.find((message) => message.eventKey === input.eventKey);
    if (existing !== undefined) {
      if (existing.bodyDigest !== input.bodyDigest) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "messaging event key already exists with a different body",
          details: { eventKey: input.eventKey },
        });
      }
      return { status: "converged", message: toMessage(existing) };
    }
    this.seq += 1;
    const message: MemoryMessage = {
      id: input.messageId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      deploymentId: input.deploymentId,
      kind: input.kind,
      direction: input.direction,
      eventKey: input.eventKey,
      threadRef: input.threadRef,
      threadSequence: input.threadSequence,
      orderingMarker: input.orderingMarker,
      executionId: input.executionId,
      ledgerSequence: input.ledgerSequence,
      routeClass: input.routeClass,
      replyToEventKey: input.replyToEventKey,
      channelMessageRef: input.channelMessageRef,
      deliveryStatus: input.deliveryStatus,
      deliveredAt: null,
      cause: input.cause,
      payloadRef: input.payloadRef,
      payloadPreview: input.payloadPreview,
      attachments: [...input.attachments],
      actorId: input.actorId,
      eventSeq: this.seq,
      bodyDigest: input.bodyDigest,
      createdAt: input.createdAt,
    };
    rows.push(message);
    return { status: "appended", message: toMessage(message) };
  }

  async appendDelivery(
    input: MessagingDeliveryAppendInput,
  ): Promise<MessagingDeliveryAppendOutcome> {
    const listKey = `${input.applicationId}:${input.conversationId}`;
    const rows = this.deliveries.get(listKey);
    if (rows === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `messaging conversation ${input.conversationId} not found in this application`,
      });
    }
    const existing = rows.find((delivery) => delivery.callbackKey === input.callbackKey);
    if (existing !== undefined) {
      if (existing.toStatus !== input.toStatus) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "messaging delivery callback key already exists with a different status",
          details: { callbackKey: input.callbackKey },
        });
      }
      return { status: "converged", delivery: toDelivery(existing) };
    }
    this.seq += 1;
    const delivery: MemoryDelivery = {
      id: input.deliveryId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      deploymentId: input.deploymentId,
      messageId: input.messageId,
      executionId: input.executionId,
      callbackKey: input.callbackKey,
      channelMessageRef: input.channelMessageRef,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      detail: input.detail,
      ledgerSequence: input.ledgerSequence,
      actorId: input.actorId,
      eventSeq: this.seq,
      createdAt: input.createdAt,
    };
    rows.push(delivery);
    return { status: "appended", delivery: toDelivery(delivery) };
  }

  async listDeliveries(applicationId: string, conversationId: string) {
    const rows = this.deliveries.get(`${applicationId}:${conversationId}`) ?? [];
    return rows.map(toDelivery);
  }

  async applyGuardedDeliveryStatusUpdate(input: {
    readonly applicationId: string;
    readonly conversationId: string;
    readonly messageId: string;
    readonly expectedChannelMessageRef: string | null;
    readonly toStatus: MessagingDeliveryStatus;
    readonly deliveredAt: string | null;
  }) {
    const rows = this.messages.get(`${input.applicationId}:${input.conversationId}`) ?? [];
    const message = rows.find((row) => row.id === input.messageId);
    if (message === undefined || message.kind !== "agent-reply") {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "the delivery projection requires an outbound agent-reply of this conversation",
        details: { messageId: input.messageId },
      });
    }
    if (
      input.expectedChannelMessageRef !== null &&
      message.channelMessageRef !== input.expectedChannelMessageRef
    ) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message:
          "delivery callback correlation rejected: the rail message reference does not match the originating send",
        details: { messageId: input.messageId },
      });
    }
    const current = message.deliveryStatus ?? "pending";
    if (current === input.toStatus) {
      return { status: "converged" as const, message: toMessage(message) };
    }
    if (
      isTerminalMessagingDeliveryStatus(current) ||
      !isForwardMessagingDeliveryMove(current, input.toStatus)
    ) {
      // A stale callback records its evidence but cannot regress the
      // projection (monotonic delivery vocabulary).
      return { status: "converged" as const, message: toMessage(message) };
    }
    message.deliveryStatus = input.toStatus;
    message.deliveredAt = input.deliveredAt;
    return { status: "applied" as const, message: toMessage(message) };
  }

  async insertEscalation(
    input: MessagingEscalationInsertInput,
  ): Promise<MessagingEscalationInsertOutcome> {
    const existing = this.escalations.get(`${input.applicationId}:${input.escalationKey}`);
    if (existing !== undefined) {
      return { status: "converged", escalation: toEscalation(existing) };
    }
    const record: MemoryEscalation = {
      id: input.escalationId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      deploymentId: input.deploymentId,
      executionId: input.executionId,
      escalationKey: input.escalationKey,
      destination: input.destination,
      cause: input.cause,
      waitSequence: input.waitSequence,
      notifiedAt: input.notifiedAt,
      createdAt: input.createdAt,
    };
    this.escalations.set(`${input.applicationId}:${input.escalationKey}`, record);
    return { status: "appended", escalation: toEscalation(record) };
  }

  async findEscalation(applicationId: string, escalationKey: string) {
    const existing = this.escalations.get(`${applicationId}:${escalationKey}`);
    return existing === undefined ? null : toEscalation(existing);
  }

  async beginMessagingOperation(
    input: MessagingOperationBeginInput,
  ): Promise<MessagingOperationBeginOutcome> {
    const existing = this.operations.get(`${input.applicationId}:${input.operationKey}`);
    if (existing === undefined) {
      const operation: MemoryOperation = {
        id: input.operationId,
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        deploymentId: input.deploymentId,
        executionId: input.executionId,
        operationKind: input.operationKind,
        operationKey: input.operationKey,
        status: "pending",
        attempts: 1,
        checkpoint: null,
        failureReason: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        completedAt: null,
      };
      this.operations.set(`${input.applicationId}:${input.operationKey}`, operation);
      return { status: "begun", record: toOperation(operation) };
    }
    if (existing.status !== "pending") {
      return { status: "existing", record: toOperation(existing) };
    }
    existing.attempts += 1;
    existing.updatedAt = input.createdAt;
    return { status: "existing", record: toOperation(existing) };
  }

  async recordMessagingOperationCheckpoint(
    applicationId: string,
    operationKey: string,
    checkpoint: MessagingOperationCheckpoint,
    updatedAt: string,
  ): Promise<MessagingOperationRecord> {
    const operation = this.operations.get(`${applicationId}:${operationKey}`);
    if (operation === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `messaging operation ${operationKey} not found in this application`,
      });
    }
    if (operation.status !== "pending") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `messaging operation ${operationKey} is ${operation.status}; a checkpoint is writable only while pending`,
      });
    }
    operation.checkpoint = checkpoint;
    operation.updatedAt = updatedAt;
    return toOperation(operation);
  }

  async completeMessagingOperation(
    applicationId: string,
    operationKey: string,
    completedAt: string,
  ): Promise<MessagingOperationRecord> {
    const operation = this.operations.get(`${applicationId}:${operationKey}`);
    if (operation === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `messaging operation ${operationKey} not found in this application`,
      });
    }
    if (operation.status === "completed") {
      return toOperation(operation);
    }
    if (operation.status === "failed") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `messaging operation ${operationKey} is failed; a failed operation cannot be completed`,
        details: { failureReason: operation.failureReason },
      });
    }
    operation.status = "completed";
    operation.completedAt = completedAt;
    operation.updatedAt = completedAt;
    return toOperation(operation);
  }

  async failMessagingOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    failedAt: string,
  ): Promise<MessagingOperationRecord> {
    const operation = this.operations.get(`${applicationId}:${operationKey}`);
    if (operation === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `messaging operation ${operationKey} not found in this application`,
      });
    }
    if (operation.status === "failed") {
      return toOperation(operation);
    }
    if (operation.status === "completed") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `messaging operation ${operationKey} is completed; a completed operation cannot be failed`,
        details: { completedAt: operation.completedAt },
      });
    }
    operation.status = "failed";
    operation.failureReason = reason.slice(0, 512);
    operation.updatedAt = failedAt;
    return toOperation(operation);
  }

  async findMessagingOperation(applicationId: string, operationKey: string) {
    const existing = this.operations.get(`${applicationId}:${operationKey}`);
    return existing === undefined ? null : toOperation(existing);
  }
}
