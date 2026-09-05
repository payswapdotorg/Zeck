/**
 * Integration — bounded retry and explicit dead-letter behavior over
 * REAL PostgreSQL (WORK-044 / D-03, acceptance criterion 4; checkpoint
 * contracts CONCURRENCY-CRASH-SAFETY, IMPLEMENTATION-COMPLETENESS).
 *
 * Proves the bounded failure discipline:
 *
 *  - transient effect failures re-queue WITHIN the delivery budget
 *    (bounded, observable attempt evidence);
 *  - budget exhaustion dead-letters EXPLICITLY (durable dead-letter
 *    row, ack — the message leaves the queue; no infinite retry loop
 *    exists anywhere in the machinery);
 *  - a governed-path rejection (the path itself said no: policy /
 *    state legality) dead-letters with the reason — never retried,
 *    never bypassed;
 *  - the retry budget is a strict bound: exactly maxDeliveryAttempts
 *    effect attempts occur, never more;
 *  - queue outage during SETTLE propagates visibly (never silent
 *    success) and converges via lease expiry.
 */

import { expect, test } from "vitest";
import { IdempotentQueueConsumer } from "../../../src/platform/queue/consumer";
import { QueueTransportError } from "../../../src/platform/queue/port";
import { definePgSuite } from "./harness";
import { CONSUMER_ACTOR_ID, dispatchScopeOf, seedQueueWorld, TEST_POLICY } from "./queue-world";

definePgSuite("bounded retry and dead-letter behavior (WORK-044 D-03)", (ctx) => {
  const world = () => seedQueueWorld(ctx.port);

  /** A consumer whose effect always throws a transient failure. */
  function alwaysFailingConsumer(w: Awaited<ReturnType<typeof world>>) {
    const effect = {
      apply: async () => {
        throw new Error("injected transient effect failure");
      },
    };
    return new IdempotentQueueConsumer({
      store: w.store,
      transport: w.transport,
      effect,
      policy: TEST_POLICY,
    });
  }

  test("transient effect failures re-queue inside the budget (observable, bounded)", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("retry-budget");
    await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    const consumer = alwaysFailingConsumer(w);
    // Attempt 1 of 3: re-queued.
    const first = await consumer.consumeBatch({ batchSize: 10 });
    expect(first.retried).toBe(1);
    expect(first.deadLettered).toBe(0);
    // Attempt 2 of 3: re-queued.
    const second = await consumer.consumeBatch({ batchSize: 10 });
    expect(second.retried).toBe(1);
    // Attempt 3 of 3: budget exhausted → EXPLICIT dead letter + ack.
    const third = await consumer.consumeBatch({ batchSize: 10 });
    expect(third.retried).toBe(0);
    expect(third.deadLettered).toBe(1);
    // The message is gone (acked) — no loop, no residue.
    expect(w.transport.unsettledCount()).toBe(0);
    const fourth = await consumer.consumeBatch({ batchSize: 10 });
    expect(fourth.pulled).toBe(0);
    // Exactly maxDeliveryAttempts attempts occurred — a strict bound.
    const envelope = mustFind(
      await w.store.findByCorrelationKey(`execution-dispatch:${executionId}`),
    );
    expect(envelope.state).toBe("dead-lettered");
    expect(envelope.deliveryAttempts).toBe(3);
    const attempts = await ctx.port.execute<{ outcome: string; attempt_no: number }>({
      sql: "SELECT outcome, attempt_no FROM queue_transport.transport_attempts WHERE envelope_id = $1 AND stage = 'delivery' ORDER BY attempt_no",
      parameters: [envelope.id],
    });
    expect(attempts.rows.map((r) => `${r.attempt_no}:${r.outcome}`)).toEqual([
      "1:transient-failure",
      "2:transient-failure",
      "3:transient-failure",
    ]);
    // The authoritative execution NEVER started — the transport's
    // failure is not the execution's state.
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("QUEUED");
  });

  test("dead-letter reason and correlation are explicit and inspectable", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("dlq-evidence");
    await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    const consumer = alwaysFailingConsumer(w);
    await consumer.consumeBatch({ batchSize: 10 });
    await consumer.consumeBatch({ batchSize: 10 });
    await consumer.consumeBatch({ batchSize: 10 });
    const dead = await ctx.port.execute<{
      reason: string;
      attempts: number;
      detail: string | null;
    }>({
      sql: `SELECT d.reason, d.attempts, d.detail
FROM queue_transport.dead_letters d
JOIN queue_transport.dispatch_envelopes e ON e.id = d.envelope_id
WHERE e.execution_id = $1`,
      parameters: [executionId],
    });
    expect(dead.rows.length).toBe(1);
    expect(dead.rows[0]?.reason).toBe("delivery-exhausted");
    expect(dead.rows[0]?.attempts).toBe(3);
    expect(dead.rows[0]?.detail).toContain("injected transient effect failure");
  });

  test("a governed rejection (illegal state) dead-letters with the reason — never retried, never bypassed", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("governed-rejection");
    await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    // The governed path itself is primed to reject: start the execution
    // directly through the single write path BEFORE the delivery runs,
    // so the consumer's `start` is an illegal transition (QUEUED is
    // gone) — the path says no, the transport dead-letters explicitly.
    await w.service.transition(
      {
        command: "start",
        actorId: CONSUMER_ACTOR_ID,
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        executionId,
        reason: "pre-started outside the transport for the rejection proof",
      },
      `manual-start-${executionId}`,
    );
    const report = await w.consumer.consumeBatch({ batchSize: 10 });
    expect(report.rejectedToDeadLetter).toBe(1);
    expect(report.retried).toBe(0);
    expect(report.applied).toBe(0);
    const envelope = mustFind(
      await w.store.findByCorrelationKey(`execution-dispatch:${executionId}`),
    );
    expect(envelope.state).toBe("dead-lettered");
    const dead = await ctx.port.execute<{ reason: string; detail: string | null }>({
      sql: "SELECT reason, detail FROM queue_transport.dead_letters WHERE envelope_id = $1",
      parameters: [envelope.id],
    });
    expect(dead.rows[0]?.reason).toBe("governed-rejection");
    expect(dead.rows[0]?.detail).toContain("INVALID_STATE_TRANSITION");
    // The message left the queue (bounded) and the execution authority
    // stays exactly where the governed path left it.
    expect(w.transport.unsettledCount()).toBe(0);
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("RUNNING");
  });

  test("transport outage during settle propagates visibly and converges (never silent success)", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("outage-settle");
    await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    w.transport.failNextSettle();
    await expect(w.consumer.consumeBatch({ batchSize: 10 })).rejects.toThrow(/ack lost/);
    // The state on the authority side is complete; the queue still
    // holds the unacked message; lease expiry redelivers and the
    // duplicate path acks it.
    const envelope = mustFind(
      await w.store.findByCorrelationKey(`execution-dispatch:${executionId}`),
    );
    expect(envelope.state).toBe("consumed");
    expect(w.transport.unsettledCount()).toBe(1);
    w.transport.expireLeases();
    const report = await w.consumer.consumeBatch({ batchSize: 10 });
    expect(report.duplicates).toBe(1);
    expect(w.transport.unsettledCount()).toBe(0);
  });

  test("publish-side outage is classified and bounded by the transport error taxonomy", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("outage-publish");
    // Transient provider outage for the whole first cycle: backlogged.
    w.transport.failNextPublish(
      10,
      new QueueTransportError("provider unavailable (injected)", "transient"),
    );
    const outcome = await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    expect(outcome.published).toBe(false);
    expect(outcome.envelope.state).toBe("backlogged");
    expect(outcome.envelope.publishAttempts).toBe(3); // exactly the budget
    // The execution authority is untouched (QUEUED, recoverable).
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("QUEUED");
  });
});

/** Envelope lookup guard (no non-null assertions in this suite). */
function mustFind(
  envelope: Awaited<
    ReturnType<
      import("../../../src/platform/queue/correlation").QueueCorrelationStore["findByCorrelationKey"]
    >
  >,
): NonNullable<typeof envelope> {
  if (envelope === null) {
    throw new Error("fixture error: envelope not found");
  }
  return envelope;
}
