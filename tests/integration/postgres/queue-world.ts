/**
 * Shared real-PostgreSQL fixture for the D-03 queue transport suites
 * (WORK-044).
 *
 * Seeds the executions world (tenant + application + environment) and
 * one execution driven through the REAL governed lifecycle up to
 * QUEUED (create → authorize → plan → queue — the existing single
 * write path, untouched), then wires the full D-03 fabric:
 *
 *  - the SQL correlation store over the real DatabasePort;
 *  - an in-memory `QueueTransportPort` double with at-least-once
 *    delivery semantics (visibility timeout, lease expiry, duplicate
 *    injection, publish/settle failure injection, call-order record);
 *  - the durable dispatcher and the idempotent consumer;
 *  - the governed effect = the executions module transport-effect
 *    adapter over the REAL execution service (the same service the
 *    lifecycle used).
 *
 * The provider-neutral port contract is the only seam the double
 * implements — the production adapter (Cloudflare Queues REST) is
 * verified separately over the documented protocol.
 */

import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import { createExecutionDispatchEffect } from "../../../src/modules/executions/adapters/transport-effect";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import type { DatabasePort } from "../../../src/platform/db/port";
import { IdempotentQueueConsumer } from "../../../src/platform/queue/consumer";
import { QueueCorrelationStore } from "../../../src/platform/queue/correlation";
import { DurableDispatcher } from "../../../src/platform/queue/dispatcher";
import type {
  PublishReceipt,
  PulledBatch,
  PullOptions,
  QueueOutboundMessage,
  QueueRetryPolicy,
  QueueTransportPort,
  Settlement,
} from "../../../src/platform/queue/port";
import { createUuidv7Generator } from "../../../src/shared/ids";

export const generateId = createUuidv7Generator();
export const ACTOR_ID = "00000000-0000-7000-8000-0000000000aa";
export const CONSUMER_ACTOR_ID = "00000000-0000-7000-8000-0000000000ce";

export const TEST_POLICY: QueueRetryPolicy = Object.freeze({
  maxPublishAttempts: 3,
  maxDeliveryAttempts: 3,
  maxReplays: 3,
  retryBackoffMs: 0,
});

/** One delivered message inside the in-memory transport. */
interface InFlightMessage {
  readonly body: string;
  readonly messageId: string;
  leaseId: string | null;
  attempts: number;
  readonly publishedAtMs: number;
  readonly contentType: string | undefined;
  visibleAtMs: number;
  settled: boolean;
}

export interface TransportEvent {
  readonly kind: "publish" | "pull" | "settle";
  readonly at: number;
  readonly detail: string;
}

/**
 * The in-memory at-least-once transport double.
 *
 * Semantics deliberately mirror the real provider's pull-consumer
 * model: pulls lease visible messages (with lease ids); settling
 * acks/removes or retries (re-visibility); leases expire after the
 * visibility timeout (redelivery — the crash-recovery mechanism);
 * publish failure/settle failure are injectable; every call is
 * recorded in order (the correlation-before-publish proof reads this).
 */
export class InMemoryQueueTransport implements QueueTransportPort {
  private readonly messages: InFlightMessage[] = [];
  private readonly events: TransportEvent[] = [];
  private counter = 0;
  private clockMs = 1_000_000;
  /** When set, publish throws this failure once (or N times). */
  private publishFailures: { count: number; error: Error }[] = [];
  private settleFailures = 0;
  private visibilityTimeoutMs = 60_000;

  async publish(message: QueueOutboundMessage): Promise<PublishReceipt> {
    this.events.push({ kind: "publish", at: ++this.counter, detail: message.body.slice(0, 80) });
    const failure = this.publishFailures[0];
    if (failure !== undefined && failure.count > 0) {
      failure.count -= 1;
      if (failure.count === 0) {
        this.publishFailures.shift();
      }
      throw failure.error;
    }
    this.messages.push({
      body: message.body,
      messageId: `msg-${++this.counter}`,
      leaseId: null,
      attempts: 0,
      publishedAtMs: this.clockMs,
      contentType: message.contentType,
      visibleAtMs: this.clockMs,
      settled: false,
    });
    return { accepted: true };
  }

  async pull(options?: PullOptions): Promise<PulledBatch> {
    this.events.push({ kind: "pull", at: ++this.counter, detail: "pull" });
    this.clockMs += 1;
    const batchSize = options?.batchSize ?? 10;
    const visibility = options?.visibilityTimeoutMs ?? this.visibilityTimeoutMs;
    const leased: InFlightMessage[] = [];
    for (const message of this.messages) {
      if (leased.length >= batchSize) {
        break;
      }
      if (message.settled || message.leaseId !== null || message.visibleAtMs > this.clockMs) {
        continue;
      }
      message.leaseId = `lease-${++this.counter}`;
      message.attempts += 1;
      leased.push(message);
    }
    for (const message of leased) {
      // Lease expiry: after the visibility window the message becomes
      // pullable again with attempts incremented (redelivery).
      message.visibleAtMs = this.clockMs + visibility;
    }
    return {
      messages: leased.map((message) => ({
        messageId: message.messageId,
        leaseId: message.leaseId ?? "",
        body: message.body,
        contentType: message.contentType,
        attempts: message.attempts,
        publishedAt: new Date(message.publishedAtMs).toISOString(),
      })),
      backlogEstimate: this.messages.filter((m) => !m.settled).length,
    };
  }

  async settle(settlement: Settlement): Promise<void> {
    this.events.push({
      kind: "settle",
      at: ++this.counter,
      detail: `ack=${settlement.ackLeaseIds.length} retry=${settlement.retryLeaseIds.length}`,
    });
    if (this.settleFailures > 0) {
      this.settleFailures -= 1;
      throw new (class extends Error {
        constructor() {
          super("injected settle failure (ack lost)");
        }
      })();
    }
    for (const message of this.messages) {
      if (settlement.ackLeaseIds.includes(message.leaseId ?? "")) {
        message.settled = true;
        message.leaseId = null;
      } else if (settlement.retryLeaseIds.includes(message.leaseId ?? "")) {
        message.leaseId = null;
        message.visibleAtMs = this.clockMs; // immediately revisible
      }
    }
  }

  /** Inject N publish failures. */
  failNextPublish(count: number, error: Error): void {
    this.publishFailures.push({ count, error });
  }

  /** Clear all injected publish failures (re-arm the transport). */
  clearPublishFailures(): void {
    this.publishFailures = [];
  }

  /** Inject one settle failure (simulates ack loss). */
  failNextSettle(): void {
    this.settleFailures += 1;
  }

  /** Expire all outstanding leases (simulate the crash/lease-expiry clock). */
  expireLeases(): void {
    this.clockMs += this.visibilityTimeoutMs + 1000;
    for (const message of this.messages) {
      if (!message.settled && message.leaseId !== null) {
        message.leaseId = null;
      }
    }
  }

  /** Deliver the SAME logical message again (duplicate injection). */
  duplicateLastDelivery(): void {
    const last = this.messages[this.messages.length - 1];
    if (last === undefined) {
      throw new Error("no message to duplicate");
    }
    // A provider-side duplicate: a fresh message id, the same body,
    // unsettled and visible (at-least-once delivery of the same
    // logical message — even after a prior ack raced).
    this.messages.push({
      ...last,
      messageId: `msg-${++this.counter}`,
      leaseId: null,
      attempts: 0,
      settled: false,
      visibleAtMs: this.clockMs,
    });
  }

  /** Push an arbitrary raw message (unbacked/forged noise). */
  pushRaw(body: string): void {
    this.messages.push({
      body,
      messageId: `msg-${++this.counter}`,
      leaseId: null,
      attempts: 0,
      publishedAtMs: this.clockMs,
      contentType: undefined,
      visibleAtMs: this.clockMs,
      settled: false,
    });
  }

  /** The ordered call record (correlation-before-publish proof). */
  eventLog(): readonly TransportEvent[] {
    return this.events;
  }

  unsettledCount(): number {
    return this.messages.filter((m) => !m.settled).length;
  }
}

export interface QueueWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly environmentId: string;
  readonly service: ExecutionService;
  readonly store: QueueCorrelationStore;
  readonly transport: InMemoryQueueTransport;
  readonly dispatcher: DurableDispatcher;
  readonly consumer: IdempotentQueueConsumer;
  /** Create + drive one execution through the REAL lifecycle to QUEUED. */
  createQueuedExecution: (suffix: string) => Promise<string>;
}

export async function seedQueueWorld(db: DatabasePort): Promise<QueueWorld> {
  const tenantId = generateId();
  const applicationId = generateId();
  const environmentId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "queue tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "queue app"],
  });
  await db.execute({
    sql: "INSERT INTO applications.environments (id, application_id, tenant_id, kind, name) VALUES ($1, $2, $3, $4, $5)",
    parameters: [environmentId, applicationId, tenantId, "production", "prod"],
  });

  const executionStore = new SqlExecutionStore(db);
  const service = createExecutionService({
    store: executionStore,
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: { evaluate: async () => ({ allowed: true }) },
    generateId,
    now: () => new Date(),
  });

  const store = new QueueCorrelationStore(db);
  const transport = new InMemoryQueueTransport();
  const dispatcher = new DurableDispatcher({
    store,
    transport,
    policy: TEST_POLICY,
    generateId,
    now: () => new Date(),
    sleep: async () => undefined,
  });
  const effect = createExecutionDispatchEffect({
    service,
    consumerActorId: CONSUMER_ACTOR_ID,
  });
  const consumer = new IdempotentQueueConsumer({ store, transport, effect, policy: TEST_POLICY });

  const createQueuedExecution = async (suffix: string): Promise<string> => {
    const receipt = await service.createExecution(
      {
        applicationId,
        environmentId,
        task: { kind: "queue-transport-test", input: suffix },
      },
      `create-${suffix}`,
      { actorId: ACTOR_ID, tenantId },
    );
    const scope = { actorId: ACTOR_ID, applicationId, tenantId };
    for (const [command, key] of [
      ["authorize", `auth-${suffix}`],
      ["plan", `plan-${suffix}`],
      ["queue", `queue-${suffix}`],
    ] as const) {
      await service.transition({ ...scope, executionId: receipt.executionId, command }, key);
    }
    return receipt.executionId;
  };

  return {
    db,
    tenantId,
    applicationId,
    environmentId,
    service,
    store,
    transport,
    dispatcher,
    consumer,
    createQueuedExecution,
  };
}

export const dispatchScopeOf = (world: QueueWorld) => ({
  applicationId: world.applicationId,
  tenantId: world.tenantId,
});
