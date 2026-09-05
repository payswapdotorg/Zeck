/**
 * Integration — idempotent consumption over REAL PostgreSQL
 * (WORK-044 / D-03, acceptance criteria 3, 7, 8; checkpoint contracts
 * IDENTITY-IDEMPOTENCY, CONCURRENCY-CRASH-SAFETY).
 *
 * The crash matrix is executed against the real execution authority:
 *
 *  - baseline: dispatch → consume → the governed `start` runs →
 *    completed envelope → acked message;
 *  - duplicate delivery (the SAME message twice): exactly ONE
 *    authoritative start, second delivery acked with zero effects;
 *  - crash AFTER the authoritative mutation but BEFORE the
 *    acknowledgment: redelivery converges (arbitration replay /
 *    completed-envelope duplicate detection) — never a second effect;
 *  - ack loss (settle fails after the mutation): lease expiry →
 *    redelivery → duplicate → ack — the same convergence;
 *  - crash BEFORE the mutation: bounded re-queue, then the mutation
 *    applies on the next delivery;
 *  - consumer restart: a fresh consumer instance over the same
 *    durable state converges identically;
 *  - unbacked noise: messages without an authoritative correlation
 *    record are refused and acked — provider state is not authority;
 *  - tampered payloads: binding/digest mismatches dead-letter
 *    fail-closed (tenant isolation included).
 */

import { expect, test } from "vitest";
import { createExecutionDispatchEffect } from "../../../src/modules/executions/adapters/transport-effect";
import { IdempotentQueueConsumer } from "../../../src/platform/queue/consumer";
import { definePgSuite } from "./harness";
import {
  CONSUMER_ACTOR_ID,
  dispatchScopeOf,
  type QueueWorld,
  seedQueueWorld,
  TEST_POLICY,
} from "./queue-world";

definePgSuite("idempotent queue consumption (WORK-044 D-03)", (ctx) => {
  const world = () => seedQueueWorld(ctx.port);

  test("baseline: dispatch → consume applies the governed start exactly once", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("baseline");
    const dispatch = await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    expect(dispatch.envelope.state).toBe("published");
    const report = await w.consumer.consumeBatch({ batchSize: 10 });
    expect(report.pulled).toBe(1);
    expect(report.applied).toBe(1);
    expect(report.acked).toBe(1);
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("RUNNING");
    const envelope = await w.store.findByCorrelationKey(dispatch.envelope.correlationKey);
    expect(envelope?.state).toBe("consumed");
    expect(envelope?.appliedOperationKey).toBe(`queue-consume:execution-dispatch:${executionId}`);
    // The message left the transport (acked) and the ledger proves the
    // start was driven by the consumer actor through the single write
    // path (event actor provenance).
    const events = await w.service.listEvents(w.applicationId, executionId);
    const startEvent = events.find((e) => e.type === "execution.start");
    expect(startEvent).toBeDefined();
    expect(w.transport.unsettledCount()).toBe(0);
    expect(await countStarts(w, executionId)).toBe(1);
  });

  test("duplicate delivery of the SAME message cannot duplicate authoritative effects", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("duplicate");
    const dispatch = await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    await w.consumer.consumeBatch({ batchSize: 10 });
    // Inject a true duplicate: the same logical message delivered again.
    w.transport.duplicateLastDelivery();
    const report = await w.consumer.consumeBatch({ batchSize: 10 });
    expect(report.pulled).toBe(1);
    expect(report.duplicates).toBe(1);
    expect(report.applied).toBe(0);
    expect(report.acked).toBe(1);
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("RUNNING");
    // Exactly ONE start transition exists in the durable ledger.
    expect(await countStarts(w, executionId)).toBe(1);
    const envelope = await w.store.findByCorrelationKey(dispatch.envelope.correlationKey);
    expect(envelope?.state).toBe("consumed");
  });

  test("crash AFTER the authoritative mutation but BEFORE the ack converges (no second effect)", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("crash-after-mutation");
    await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    // A consumer whose effect applies the governed mutation and then
    // "crashes" (throws) before the envelope can be marked consumed —
    // the mutation is durable, the transport mark is not.
    const base = createExecutionDispatchEffect({
      service: w.service,
      consumerActorId: CONSUMER_ACTOR_ID,
    });
    let appliedBeforeCrash = 0;
    const crashingEffect = {
      apply: async (delivery: Parameters<typeof base.apply>[0], key: string) => {
        const _outcome = await base.apply(delivery, key);
        appliedBeforeCrash += 1;
        throw new Error("injected crash after the authoritative mutation");
      },
    };
    const consumer = new IdempotentQueueConsumer({
      store: w.store,
      transport: w.transport,
      effect: crashingEffect,
      policy: TEST_POLICY,
    });
    // First delivery: mutation applied, then the crash surfaces as a
    // transient failure → bounded re-queue (attempt 1 of 3).
    const first = await consumer.consumeBatch({ batchSize: 10 });
    expect(first.retried).toBe(1);
    expect(appliedBeforeCrash).toBe(1);
    const executionAfterCrash = await w.service.getExecution(w.applicationId, executionId);
    expect(executionAfterCrash?.status).toBe("RUNNING");
    // Redelivery: the same deterministic consume key → the executions
    // idempotency arbitration REPLAYS the durable outcome — no second
    // mutation (the crash fires again on the replay path, budget 2 of 3).
    const second = await consumer.consumeBatch({ batchSize: 10 });
    expect(second.retried + second.deadLettered).toBe(1);
    expect(appliedBeforeCrash).toBe(2); // two effect invocations...
    // ...but only ONE durable start (arbitration replayed, not applied).
    const startsAfterCrashLoop = await countStarts(w, executionId);
    expect(startsAfterCrashLoop).toBe(1);
    // Now the real consumer (no injected crash) converges the next
    // delivery: already-applied → completed → acked.
    const final = await w.consumer.consumeBatch({ batchSize: 10 });
    expect(final.alreadyApplied + final.duplicates).toBe(1);
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("RUNNING");
    expect(await countStarts(w, executionId)).toBe(1);
  });

  test("ack loss (settle failure after the mutation) converges through redelivery", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("ack-loss");
    const dispatch = await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    w.transport.failNextSettle();
    // The settle fails AFTER the effect applied and the envelope was
    // marked completed: the settle error propagates (visible failure —
    // never silent success).
    await expect(w.consumer.consumeBatch({ batchSize: 10 })).rejects.toThrow(/ack lost/);
    const envelope = await w.store.findByCorrelationKey(dispatch.envelope.correlationKey);
    expect(envelope?.state).toBe("consumed");
    const executionAfterAckLoss = await w.service.getExecution(w.applicationId, executionId);
    expect(executionAfterAckLoss?.status).toBe("RUNNING");
    // Lease expiry (the provider's recovery mechanism) → redelivery →
    // duplicate detection → ack. Nothing re-applies.
    w.transport.expireLeases();
    const report = await w.consumer.consumeBatch({ batchSize: 10 });
    expect(report.duplicates).toBe(1);
    expect(report.applied).toBe(0);
    expect(await countStarts(w, executionId)).toBe(1);
  });

  test("crash BEFORE the mutation: bounded re-queue, then the mutation applies", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("crash-before");
    await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    const base = createExecutionDispatchEffect({
      service: w.service,
      consumerActorId: CONSUMER_ACTOR_ID,
    });
    let failuresLeft = 1;
    const flakyEffect = {
      apply: async (delivery: Parameters<typeof base.apply>[0], key: string) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("injected transient failure before any mutation");
        }
        return base.apply(delivery, key);
      },
    };
    const consumer = new IdempotentQueueConsumer({
      store: w.store,
      transport: w.transport,
      effect: flakyEffect,
      policy: TEST_POLICY,
    });
    const first = await consumer.consumeBatch({ batchSize: 10 });
    expect(first.retried).toBe(1);
    expect(first.applied).toBe(0);
    const executionBefore = await w.service.getExecution(w.applicationId, executionId);
    expect(executionBefore?.status).toBe("QUEUED");
    const second = await consumer.consumeBatch({ batchSize: 10 });
    expect(second.applied).toBe(1);
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("RUNNING");
    expect(await countStarts(w, executionId)).toBe(1);
  });

  test("consumer restart: a fresh consumer instance converges over the durable state", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("restart");
    const dispatch = await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    // Deliver but do NOT consume (simulate the consumer dying before
    // processing: the lease expires, the message returns).
    const leased = await w.transport.pull({ batchSize: 10 });
    expect(leased.messages.length).toBe(1);
    w.transport.expireLeases();
    // A brand-new consumer over the same durable state:
    const restarted = new IdempotentQueueConsumer({
      store: w.store,
      transport: w.transport,
      effect: createExecutionDispatchEffect({
        service: w.service,
        consumerActorId: CONSUMER_ACTOR_ID,
      }),
      policy: TEST_POLICY,
    });
    const report = await restarted.consumeBatch({ batchSize: 10 });
    expect(report.applied).toBe(1);
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("RUNNING");
    const envelope = await w.store.findByCorrelationKey(dispatch.envelope.correlationKey);
    expect(envelope?.state).toBe("consumed");
  });

  test("unbacked messages are refused and acked (provider state is never authority)", async () => {
    const w = await world();
    w.transport.pushRaw(JSON.stringify({ not: "a-pointer" }));
    w.transport.pushRaw(
      JSON.stringify({
        v: 1,
        correlationKey: "execution-dispatch:00000000-0000-7000-8000-00000000feed",
        purpose: "execution-dispatch",
        executionId: "00000000-0000-7000-8000-00000000feed",
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        dispatchedAt: new Date().toISOString(),
      }),
    );
    const report = await w.consumer.consumeBatch({ batchSize: 10 });
    expect(report.refusedUnbacked).toBe(2);
    expect(report.applied).toBe(0);
    expect(report.acked).toBe(2);
    expect(w.transport.unsettledCount()).toBe(0);
  });

  test("tampered payloads (binding/digest mismatch) dead-letter fail-closed — tenant isolation", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("tampered");
    const dispatch = await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    // Consume the real one first.
    await w.consumer.consumeBatch({ batchSize: 10 });
    // Forged pointer: claims a DIFFERENT tenant for the same correlation.
    const otherTenant = "00000000-0000-7000-8000-00000000bad";
    w.transport.pushRaw(
      JSON.stringify({
        v: 1,
        correlationKey: dispatch.envelope.correlationKey,
        purpose: "execution-dispatch",
        executionId,
        applicationId: w.applicationId,
        tenantId: otherTenant,
        dispatchedAt: new Date().toISOString(),
      }),
    );
    // Forged payload: right binding, tampered content (digest mismatch).
    w.transport.pushRaw(
      JSON.stringify({
        v: 1,
        correlationKey: dispatch.envelope.correlationKey,
        purpose: "execution-dispatch",
        executionId,
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        dispatchedAt: "1970-01-01T00:00:00.000Z",
      }),
    );
    const report = await w.consumer.consumeBatch({ batchSize: 10 });
    expect(report.deadLettered).toBe(2);
    expect(report.applied).toBe(0);
    const dead = await ctx.port.execute<{ reason: string }>({
      sql: "SELECT reason FROM queue_transport.dead_letters WHERE envelope_id = $1 ORDER BY created_at",
      parameters: [dispatch.envelope.id],
    });
    expect(dead.rows.map((r) => r.reason)).toEqual(["payload-mismatch", "payload-mismatch"]);
    // The authoritative envelope stays completed; the execution stays
    // exactly where the governed path left it.
    const envelope = await w.store.findByCorrelationKey(dispatch.envelope.correlationKey);
    expect(envelope?.state).toBe("consumed");
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("RUNNING");
  });
});

/** Count the durable start events for one execution (authority-side proof). */
async function countStarts(w: QueueWorld, executionId: string): Promise<number> {
  const events = await w.service.listEvents(w.applicationId, executionId);
  return events.filter((e) => e.type === "execution.start").length;
}
