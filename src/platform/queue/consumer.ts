/**
 * Idempotent queue consumer (WORK-044 / D-03).
 *
 * THE CONVERGENCE CONTRACT (at-least-once delivery meets exactly-once
 * authoritative effects):
 *
 * Every delivery is resolved against the authoritative PostgreSQL
 * correlation record FIRST — the provider's message is a pointer, not
 * a payload of record. Then, and only then, the governed effect runs
 * through the injected `GovernedDispatchEffect` seam with a
 * DETERMINISTIC idempotency key derived from the correlation
 * identity. The crash matrix:
 *
 *   - crash BEFORE the authoritative mutation: redelivery processes
 *     it fresh (nothing was applied);
 *   - crash DURING/AROUND the mutation: the existing executions
 *     idempotency arbitration converges — one durable effect, ever;
 *   - crash AFTER the mutation but BEFORE the ack: redelivery sees
 *     `already-applied` (arbitration replay) or a consumed envelope,
 *     acks, and applies NOTHING new;
 *   - duplicate delivery: same convergence paths — duplicate
 *     deliveries can never duplicate authoritative effects;
 *   - ack loss / lease expiry: same as crash-after-mutation.
 *
 * Bounded failure handling: transient effect failures re-queue within
 * the delivery budget; exhaustion or a governed rejection dead-letters
 * EXPLICITLY (durable dead-letter row + ack — the message leaves the
 * queue and the failure is inspectable, never silent, never looping).
 * A delivery whose correlation record does not exist is refused and
 * acked — provider state is not authority, so a message without a
 * PostgreSQL correlation record is unbacked noise (reported in the
 * run report; it is never processed).
 */
import { payloadDigestOf, type QueueCorrelationStore } from "./correlation";
import {
  consumeIdempotencyKey,
  type GovernedDispatchEffect,
  type PullOptions,
  type QueueDelivery,
  type QueueRetryPolicy,
  type QueueTransportPort,
} from "./port";

export interface QueueConsumerDeps {
  readonly store: QueueCorrelationStore;
  readonly transport: QueueTransportPort;
  readonly effect: GovernedDispatchEffect;
  readonly policy: QueueRetryPolicy;
}

/** Operational run report (evidence; never authority). */
export interface ConsumeRunReport {
  readonly pulled: number;
  /** Duplicate deliveries acked with zero authoritative effects. */
  readonly duplicates: number;
  readonly applied: number;
  readonly alreadyApplied: number;
  /** Governed-path rejections → explicit dead letters. */
  readonly rejectedToDeadLetter: number;
  /** Transient failures re-queued inside the bounded budget. */
  readonly retried: number;
  /** Budget-exhausted failures → explicit dead letters. */
  readonly deadLettered: number;
  /** Unbacked messages refused (no authoritative correlation record). */
  readonly refusedUnbacked: number;
  readonly acked: number;
  /** Provider-reported backlog estimate (observational only). */
  readonly backlogEstimate: number | null;
}

/** Mutable accumulator behind the frozen report surface. */
interface ReportState {
  pulled: number;
  duplicates: number;
  applied: number;
  alreadyApplied: number;
  rejectedToDeadLetter: number;
  retried: number;
  deadLettered: number;
  refusedUnbacked: number;
  acked: number;
  backlogEstimate: number | null;
}

/** The parse result of a delivered pointer payload. */
interface ParsedPointer {
  readonly correlationKey: string;
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly purpose: string;
}

function parsePointer(body: string): ParsedPointer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const correlationKey = record.correlationKey;
  const executionId = record.executionId;
  const applicationId = record.applicationId;
  const tenantId = record.tenantId;
  const purpose = record.purpose;
  if (
    typeof correlationKey !== "string" ||
    typeof executionId !== "string" ||
    typeof applicationId !== "string" ||
    typeof tenantId !== "string" ||
    typeof purpose !== "string"
  ) {
    return null;
  }
  return { correlationKey, executionId, applicationId, tenantId, purpose };
}

export class IdempotentQueueConsumer {
  constructor(private readonly deps: QueueConsumerDeps) {}

  /**
   * Pull one batch and converge it. The settle at the end is the only
   * transport mutation beyond the governed effect; a failure there
   * propagates (the lease expires and redelivery converges — never
   * data loss, never double effects).
   */
  async consumeBatch(options?: PullOptions): Promise<ConsumeRunReport> {
    const batch = await this.deps.transport.pull(options);
    const ackLeaseIds: string[] = [];
    const retryLeaseIds: string[] = [];
    const report: ReportState = {
      pulled: batch.messages.length,
      duplicates: 0,
      applied: 0,
      alreadyApplied: 0,
      rejectedToDeadLetter: 0,
      retried: 0,
      deadLettered: 0,
      refusedUnbacked: 0,
      acked: 0,
      backlogEstimate: batch.backlogEstimate,
    };
    for (const message of batch.messages) {
      await this.handleDelivery(message, ackLeaseIds, retryLeaseIds, report);
    }
    await this.deps.transport.settle({ ackLeaseIds, retryLeaseIds });
    report.acked = ackLeaseIds.length;
    return report;
  }

  private async handleDelivery(
    message: QueueDelivery,
    ackLeaseIds: string[],
    retryLeaseIds: string[],
    report: ReportState,
  ): Promise<void> {
    const pointer = parsePointer(message.body);
    if (pointer === null || pointer.purpose !== "execution-dispatch") {
      // Unbacked noise: no authoritative record can exist for an
      // unparseable/non-pointer message. Refuse + ack (bounded); the
      // refusal is reported, never processed.
      report.refusedUnbacked += 1;
      ackLeaseIds.push(message.leaseId);
      return;
    }

    // AUTHORITY FIRST: resolve the durable correlation record.
    const envelope = await this.deps.store.findByCorrelationKey(pointer.correlationKey);
    if (envelope === null) {
      report.refusedUnbacked += 1;
      ackLeaseIds.push(message.leaseId);
      return;
    }

    // Payload integrity: the delivered message must match the
    // authoritative record (tenant/application/execution binding and
    // the canonical digest). A mismatch is fail-closed dead-letter.
    const bindingMismatch =
      pointer.executionId !== envelope.executionId ||
      pointer.applicationId !== envelope.applicationId ||
      pointer.tenantId !== envelope.tenantId;
    let digestMismatch = false;
    try {
      const parsed = JSON.parse(message.body) as Record<string, unknown>;
      if (payloadDigestOf(parsed) !== envelope.payloadDigest) {
        digestMismatch = true;
      }
    } catch {
      digestMismatch = true;
    }
    if (bindingMismatch || digestMismatch) {
      const detail = bindingMismatch
        ? "delivered binding disagrees with the authoritative record"
        : "payload digest mismatch";
      if (envelope.state === "consumed" || envelope.state === "dead-lettered") {
        // Tampered duplicate of a TERMINAL envelope: record the
        // immutable failure evidence without rewriting history, then
        // ack (nothing authoritative can be affected).
        await this.deps.store.recordDeadLetterEvidence(
          envelope.id,
          "payload-mismatch",
          Math.max(1, envelope.deliveryAttempts),
          detail,
        );
      } else {
        await this.deps.store.deadLetter(
          envelope.id,
          "payload-mismatch",
          Math.max(1, envelope.deliveryAttempts),
          detail,
        );
      }
      report.deadLettered += 1;
      ackLeaseIds.push(message.leaseId);
      return;
    }

    // Terminal transports: duplicates need no effects, dead letters
    // need explicit replay — both are acked, nothing is reprocessed.
    if (envelope.state === "consumed") {
      report.duplicates += 1;
      ackLeaseIds.push(message.leaseId);
      return;
    }
    if (envelope.state === "dead-lettered") {
      report.duplicates += 1;
      ackLeaseIds.push(message.leaseId);
      return;
    }

    // A delivery of a recorded/backlogged envelope is itself proof of
    // publication (crash between provider-accept and the accepted
    // mark, or a stale duplicate of a republish): adopt it, then
    // continue. The state machine stays single and legal.
    let current = envelope;
    if (current.state === "recorded" || current.state === "backlogged") {
      current = await this.deps.store.markPublishAccepted(current.id, {
        stage: "publish",
        attemptNo: Math.max(1, current.publishAttempts),
        outcome: "accepted",
        detail: "publication proven by delivery",
      });
    }

    // The governed effect, with the deterministic consume key.
    const idempotencyKey = consumeIdempotencyKey(current.correlationKey);
    const attemptNo = current.deliveryAttempts + 1;
    try {
      const outcome = await this.deps.effect.apply({ envelope: current }, idempotencyKey);
      if (outcome.outcome === "applied" || outcome.outcome === "already-applied") {
        await this.deps.store.markConsumed(current.id, idempotencyKey, {
          stage: "delivery",
          attemptNo,
          outcome: "accepted",
          detail: outcome.outcome === "already-applied" ? "idempotent replay" : null,
        });
        if (outcome.outcome === "applied") {
          report.applied += 1;
        } else {
          report.alreadyApplied += 1;
        }
        ackLeaseIds.push(message.leaseId);
        return;
      }
      // Governed rejection: the path itself said no (policy, budget,
      // state legality). Explicit dead letter; the message leaves the
      // queue; nothing was bypassed.
      await this.deps.store.recordDeliveryFailure(
        current.id,
        {
          stage: "delivery",
          attemptNo,
          outcome: "permanent-failure",
          detail: outcome.reason.slice(0, 200),
        },
        this.deps.policy,
        { governedRejection: outcome.reason.slice(0, 200) },
      );
      report.rejectedToDeadLetter += 1;
      ackLeaseIds.push(message.leaseId);
      return;
    } catch (error) {
      // Transient (or unknown) failure: bounded re-queue or explicit
      // dead-letter at budget exhaustion. Never silent success.
      const detail = (error as Error).message.slice(0, 200);
      const updated = await this.deps.store.recordDeliveryFailure(
        current.id,
        {
          stage: "delivery",
          attemptNo,
          outcome: "transient-failure",
          detail,
        },
        this.deps.policy,
      );
      if (updated.state === "dead-lettered") {
        report.deadLettered += 1;
        ackLeaseIds.push(message.leaseId);
      } else {
        report.retried += 1;
        retryLeaseIds.push(message.leaseId);
      }
    }
  }
}

/** Convenience factory matching the module conventions. */
export function createIdempotentQueueConsumer(deps: QueueConsumerDeps): IdempotentQueueConsumer {
  return new IdempotentQueueConsumer(deps);
}
