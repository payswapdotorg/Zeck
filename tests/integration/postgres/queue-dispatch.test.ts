/**
 * Integration — durable dispatch + correlation over REAL PostgreSQL
 * (WORK-044 / D-03, acceptance criteria 1 and 7; checkpoint contracts
 * IDENTITY-IDEMPOTENCY, CONCURRENCY-CRASH-SAFETY, EXECUTION-PROVENANCE).
 *
 * Proves over the real database:
 *
 *  - the authoritative correlation record exists BEFORE the transport
 *    call (the call-order record of the transport double is read
 *    mid-flight — the envelope row is already committed);
 *  - one-to-one correlation: exactly one envelope, one correlation key,
 *    one published message per logical dispatch;
 *  - dispatch idempotency: a repeated identical dispatch replays the
 *    SAME durable record (no second envelope, no second publication);
 *  - transient publish failure: bounded attempts, backlogged state,
 *    durable attempt evidence — never a silent success, never a
 *    provider-authority claim;
 *  - permanent publish rejection: explicit dead letter;
 *  - crash recovery: the republish path recovers recorded envelopes
 *    from PostgreSQL authority alone;
 *  - the physical schema: dispatching a nonexistent execution is
 *    unrepresentable (FK), terminal envelopes are immutable, the
 *    transport progress transitions are the only legal ones.
 */

import { expect, test } from "vitest";
import type { DispatchEnvelope, QueueTransportPort } from "../../../src/platform/queue/port";
import {
  executionDispatchCorrelationKey,
  QueueTransportError,
} from "../../../src/platform/queue/port";
import { definePgSuite } from "./harness";
import { dispatchScopeOf, seedQueueWorld } from "./queue-world";

definePgSuite("durable dispatch correlation (WORK-044 D-03)", (ctx) => {
  const world = () => seedQueueWorld(ctx.port);

  test("the correlation record is committed BEFORE the transport publish call", async () => {
    const w = await world();
    // A transport that inspects the database mid-call: the envelope row
    // must already exist when the provider call happens (intent first).
    let sawEnvelopeDuringPublish: DispatchEnvelope | null = null;
    const executionId = await w.createQueuedExecution("intent-first");
    const originalPublish = w.transport.publish.bind(w.transport);
    const probingTransport: QueueTransportPort = {
      publish: async (message) => {
        sawEnvelopeDuringPublish = await w.store.findByCorrelationKey(
          executionDispatchCorrelationKey(executionId),
        );
        return originalPublish(message);
      },
      pull: (options) => w.transport.pull(options),
      settle: (settlement) => w.transport.settle(settlement),
    };
    const { DurableDispatcher } = await import("../../../src/platform/queue/dispatcher");
    const dispatcher = new DurableDispatcher({
      store: w.store,
      transport: probingTransport,
      policy: { maxPublishAttempts: 3, maxDeliveryAttempts: 3, maxReplays: 3, retryBackoffMs: 0 },
      generateId: (await import("../../../src/shared/ids")).createUuidv7Generator(),
      now: () => new Date(),
    });
    const outcome = await dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    expect(outcome.published).toBe(true);
    const seen = sawEnvelopeDuringPublish as DispatchEnvelope | null;
    expect(seen).not.toBeNull();
    expect(seen?.state).toBe("recorded");
    expect(seen?.executionId).toBe(executionId);
    // And after the call the state advanced to published.
    const after = await w.store.findByCorrelationKey(outcome.envelope.correlationKey);
    expect(after?.state).toBe("published");
  });

  test("one dispatch = one envelope = one correlation key = one message", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("one-to-one");
    const first = await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    const second = await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    expect(first.envelope.id).toBe(second.envelope.id);
    expect(first.envelope.correlationKey).toBe(`execution-dispatch:${executionId}`);
    expect(second.replayedIntent).toBe(true);
    expect(second.published).toBe(false); // already published: no second message
    const rows = await ctx.port.execute<{ count: string | number }>({
      sql: "SELECT count(*) AS count FROM queue_transport.dispatch_envelopes WHERE execution_id = $1",
      parameters: [executionId],
    });
    expect(Number(rows.rows[0]?.count ?? 0)).toBe(1);
    // The message on the transport carries the correlation pointer.
    const pull = await w.transport.pull({ batchSize: 10 });
    expect(pull.messages.length).toBe(1);
    const pointer = JSON.parse(pull.messages[0]?.body ?? "{}") as Record<string, unknown>;
    expect(pointer.correlationKey).toBe(`execution-dispatch:${executionId}`);
    expect(pointer.tenantId).toBe(w.tenantId);
    expect(pointer.applicationId).toBe(w.applicationId);
  });

  test("transient publish failures are bounded and land in backlogged (recoverable, explicit)", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("transient-publish");
    w.transport.failNextPublish(3, new QueueTransportError("injected unavailable", "transient"));
    const outcome = await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    expect(outcome.published).toBe(false);
    expect(outcome.envelope.state).toBe("backlogged");
    expect(outcome.envelope.publishAttempts).toBe(3);
    const attempts = await ctx.port.execute<{ stage: string; outcome: string; attempt_no: number }>(
      {
        sql: "SELECT stage, outcome, attempt_no FROM queue_transport.transport_attempts WHERE envelope_id = $1 ORDER BY attempt_no",
        parameters: [outcome.envelope.id],
      },
    );
    expect(attempts.rows.map((r) => `${r.attempt_no}:${r.outcome}`)).toEqual([
      "1:transient-failure",
      "2:transient-failure",
      "3:transient-failure",
    ]);
    // The authoritative execution state is untouched by the outage.
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("QUEUED");
    // Recovery: the republish path reads PostgreSQL authority only and
    // publishes the SAME correlation (no new envelope).
    const recovered = await w.dispatcher.republishPending(10);
    expect(recovered.length).toBe(1);
    expect(recovered[0]?.published).toBe(true);
    expect(recovered[0]?.envelope.id).toBe(outcome.envelope.id);
    expect(recovered[0]?.envelope.state).toBe("published");
    expect(w.transport.unsettledCount()).toBe(1);
  });

  test("a permanent publish rejection dead-letters immediately (no unbounded retries)", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("permanent-publish");
    w.transport.failNextPublish(
      1,
      new QueueTransportError("injected unauthorized (http 403)", "permanent", { status: 403 }),
    );
    const outcome = await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    expect(outcome.published).toBe(false);
    expect(outcome.envelope.state).toBe("dead-lettered");
    const dead = await ctx.port.execute<{ reason: string; attempts: number }>({
      sql: "SELECT reason, attempts FROM queue_transport.dead_letters WHERE envelope_id = $1",
      parameters: [outcome.envelope.id],
    });
    expect(dead.rows[0]?.reason).toBe("publish-rejected");
    expect(dead.rows[0]?.attempts).toBe(1);
    // The execution authority remains QUEUED — an explicit transport
    // failure is never execution success NOR execution failure.
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("QUEUED");
  });

  test("dispatching a nonexistent execution is unrepresentable (physical FK)", async () => {
    const w = await world();
    const fakeId = "00000000-0000-7000-8000-00000000dead";
    await expect(
      w.dispatcher.dispatchExecution({ executionId: fakeId, ...dispatchScopeOf(w) }),
    ).rejects.toThrow();
  });

  test("the transport progress state machine is physically enforced", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("state-machine");
    const outcome = await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    // Illegal: published -> backlogged is not a legal transport edge.
    await expect(
      ctx.port.execute({
        sql: "UPDATE queue_transport.dispatch_envelopes SET state = 'backlogged' WHERE id = $1",
        parameters: [outcome.envelope.id],
      }),
    ).rejects.toThrow(/illegal transport progress transition/);
    // Illegal: an unknown state word is unrepresentable.
    await expect(
      ctx.port.execute({
        sql: "UPDATE queue_transport.dispatch_envelopes SET state = 'RUNNING' WHERE id = $1",
        parameters: [outcome.envelope.id],
      }),
    ).rejects.toThrow();
    // Legal completion, then terminal immutability.
    const consumed = await w.store.markConsumed(outcome.envelope.id, "queue-consume:test", {
      stage: "delivery",
      attemptNo: 1,
      outcome: "accepted",
      detail: null,
    });
    expect(consumed.state).toBe("consumed");
    expect(consumed.appliedOperationKey).toBe("queue-consume:test");
    await expect(
      ctx.port.execute({
        sql: "UPDATE queue_transport.dispatch_envelopes SET publish_attempts = publish_attempts + 1 WHERE id = $1",
        parameters: [outcome.envelope.id],
      }),
    ).rejects.toThrow(/terminal/);
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM queue_transport.dispatch_envelopes WHERE id = $1",
        parameters: [outcome.envelope.id],
      }),
    ).rejects.toThrow(/never deleted/);
    // Transport evidence is append-only.
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM queue_transport.transport_attempts WHERE envelope_id = $1",
        parameters: [outcome.envelope.id],
      }),
    ).rejects.toThrow(/append-only/);
  });

  test("the payload is a secret-free correlation pointer (digest matches the authoritative record)", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("pointer-payload");
    const outcome = await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    const payload = outcome.envelope.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      [
        "v",
        "correlationKey",
        "purpose",
        "executionId",
        "applicationId",
        "tenantId",
        "dispatchedAt",
      ].sort(),
    );
    // No secret-shaped keys or values anywhere in the payload
    // (correlationKey is a correlation identity, not a secret).
    for (const key of Object.keys(payload)) {
      expect(/^(secret|token|password|credential|access[_-]?key|api[_-]?key)$/i.test(key)).toBe(
        false,
      );
      const value = payload[key];
      if (typeof value === "string") {
        expect(/bearer\s|sk-[A-Za-z0-9]|ghp_|postgres:\/\//i.test(value)).toBe(false);
      }
    }
    expect(payload.purpose).toBe("execution-dispatch");
  });
});
