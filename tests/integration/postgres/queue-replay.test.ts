/**
 * Integration — bounded replay safety and provenance over REAL
 * PostgreSQL (WORK-044 / D-03, acceptance criterion 6; checkpoint
 * contracts EXECUTION-PROVENANCE, IDENTITY-IDEMPOTENCY).
 *
 * Proves the replay contract:
 *
 *  - replay creates a NEW envelope on the SAME root lineage (original
 *    provenance retained by reference; correlation identity preserved
 *    in the deterministic ordinal key);
 *  - the replay budget is a strict bound (maxReplays per root; the
 *    (N+1)-th replay is rejected — the "unbounded replay" weakening
 *    is unrepresentable);
 *  - replay re-enters the governed path: consumption of the replayed
 *    dispatch applies the SAME governed transition with ALL gates —
 *    a replay for an execution the governed path will not start
 *    (terminal / illegal state) is rejected and dead-letters;
 *  - a replay request is never an implicit authorization grant: a
 *    replay of a COMPLETED transport for a still-live envelope
 *    re-enters the governed path and the path decides;
 *  - repeated replay invocation is idempotent (deterministic ordinal
 *    correlation key: the same ordinal replays the same durable
 *    envelope);
 *  - replay of a non-terminal transport state is refused (replay is
 *    the DEAD-LETTER re-entry, not a queue-jump).
 */

import { expect, test } from "vitest";
import { definePgSuite } from "./harness";
import { dispatchScopeOf, seedQueueWorld } from "./queue-world";

definePgSuite("bounded replay safety and provenance (WORK-044 D-03)", (ctx) => {
  const world = () => seedQueueWorld(ctx.port);

  test("replay creates a new envelope on the same lineage with retained provenance", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("replay-lineage");
    const root = await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    // Dead-letter the root (the only replay-legal terminal start).
    await w.store.deadLetter(root.envelope.id, "governed-rejection", 1, "fixture");
    const replay = await w.dispatcher.replayDispatch(root.envelope.id);
    expect(replay.envelope.id).not.toBe(root.envelope.id);
    expect(replay.envelope.replayOf).toBe(root.envelope.id);
    expect(replay.envelope.correlationKey).toBe(`execution-dispatch:${executionId}:replay-1`);
    expect(replay.envelope.executionId).toBe(executionId);
    expect(replay.envelope.tenantId).toBe(w.tenantId);
    expect(replay.envelope.applicationId).toBe(w.applicationId);
    expect(replay.envelope.state).toBe("published");
    // The root envelope is untouched (terminal immutable).
    const rootAfter = await w.store.findById(root.envelope.id);
    expect(rootAfter?.state).toBe("dead-lettered");
    // The replay message carries the SAME execution correlation
    // pointer (identity preserved). The root's own message is still
    // on the transport (dead-lettered without consuming) — find the
    // replay's message by its pointer.
    const pull = await w.transport.pull({ batchSize: 10 });
    const replayMessage = pull.messages.find((message) => {
      const parsed = JSON.parse(message.body) as Record<string, unknown>;
      return parsed.correlationKey === `execution-dispatch:${executionId}:replay-1`;
    });
    expect(replayMessage).toBeDefined();
    const pointer = JSON.parse(replayMessage?.body ?? "{}") as Record<string, unknown>;
    expect(pointer.executionId).toBe(executionId);
    expect(pointer.correlationKey).toBe(`execution-dispatch:${executionId}:replay-1`);
  });

  test("replay is bounded: the budget is a strict per-root bound", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("replay-budget");
    const root = await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    await w.store.deadLetter(root.envelope.id, "governed-rejection", 1, "fixture");
    // The policy allows 3 replays; each must TERMINATE before the next
    // ordinal is issued (the outstanding-replay idempotency rule).
    const first = await w.dispatcher.replayDispatch(root.envelope.id);
    expect(first.envelope.correlationKey).toContain(":replay-1");
    await w.store.deadLetter(first.envelope.id, "governed-rejection", 1, "fixture");
    const second = await w.dispatcher.replayDispatch(root.envelope.id);
    expect(second.envelope.correlationKey).toContain(":replay-2");
    await w.store.deadLetter(second.envelope.id, "governed-rejection", 1, "fixture");
    const third = await w.dispatcher.replayDispatch(root.envelope.id);
    expect(third.envelope.correlationKey).toContain(":replay-3");
    await w.store.deadLetter(third.envelope.id, "governed-rejection", 1, "fixture");
    // The 4th replay is rejected: the budget is exhausted.
    await expect(w.dispatcher.replayDispatch(root.envelope.id)).rejects.toThrow(
      /replay budget exhausted.*3\/3/,
    );
    // Exactly 3 replay envelopes exist for the root.
    const rows = await ctx.port.execute<{ count: string | number }>({
      sql: "SELECT count(*) AS count FROM queue_transport.dispatch_envelopes WHERE replay_of = $1",
      parameters: [root.envelope.id],
    });
    expect(Number(rows.rows[0]?.count ?? 0)).toBe(3);
  });

  test("repeated replay invocation is idempotent (deterministic ordinal key)", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("replay-idempotent");
    const root = await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    await w.store.deadLetter(root.envelope.id, "governed-rejection", 1, "fixture");
    const first = await w.dispatcher.replayDispatch(root.envelope.id);
    const again = await w.dispatcher.replayDispatch(root.envelope.id);
    expect(again.envelope.id).toBe(first.envelope.id);
    expect(again.replayedIntent).toBe(true);
    expect(again.published).toBe(false); // already published: no duplicate message
    const rows = await ctx.port.execute<{ count: string | number }>({
      sql: "SELECT count(*) AS count FROM queue_transport.dispatch_envelopes WHERE replay_of = $1",
      parameters: [root.envelope.id],
    });
    expect(Number(rows.rows[0]?.count ?? 0)).toBe(1);
  });

  test("replay re-enters the governed path: a legal start applies, an illegal one dead-letters", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("replay-governed");
    const root = await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    // Consume the root dispatch (start applied) — the envelope is
    // completed, which is a legal replay target (terminal). The
    // replayed dispatch will re-enter the governed path, which will
    // now REJECT the start (the execution is already RUNNING) —
    // proving the replay cannot bypass the state legality gate.
    await w.consumer.consumeBatch({ batchSize: 10 });
    const replay = await w.dispatcher.replayDispatch(root.envelope.id);
    expect(replay.envelope.state).toBe("published");
    const report = await w.consumer.consumeBatch({ batchSize: 10 });
    expect(report.rejectedToDeadLetter).toBe(1);
    expect(report.applied).toBe(0);
    const replayEnvelope = await w.store.findByCorrelationKey(
      `execution-dispatch:${executionId}:replay-1`,
    );
    expect(replayEnvelope?.state).toBe("dead-lettered");
    const dead = await ctx.port.execute<{ reason: string }>({
      sql: "SELECT reason FROM queue_transport.dead_letters WHERE envelope_id = $1",
      parameters: [replayEnvelope?.id],
    });
    expect(dead.rows[0]?.reason).toBe("governed-rejection");
    // The authority: exactly ONE start ever, the execution stays
    // RUNNING — the replay attempt did not double-apply or bypass.
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("RUNNING");
    const events = await w.service.listEvents(w.applicationId, executionId);
    expect(events.filter((e) => e.type === "execution.start").length).toBe(1);
  });

  test("a replay whose governed start is legal DOES apply through the full path", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("replay-legal");
    const root = await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    // Dead-letter the root WITHOUT consuming it (the execution is
    // still QUEUED — the governed start remains legal).
    await w.store.deadLetter(root.envelope.id, "governed-rejection", 1, "fixture");
    const replay = await w.dispatcher.replayDispatch(root.envelope.id);
    expect(replay.envelope.state).toBe("published");
    const report = await w.consumer.consumeBatch({ batchSize: 10 });
    expect(report.applied).toBe(1);
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("RUNNING");
    const replayEnvelope = await w.store.findByCorrelationKey(
      `execution-dispatch:${executionId}:replay-1`,
    );
    expect(replayEnvelope?.state).toBe("consumed");
    expect(replayEnvelope?.appliedOperationKey).toBe(
      `queue-consume:execution-dispatch:${executionId}:replay-1`,
    );
  });

  test("replay of a non-terminal transport state is refused", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("replay-nonterminal");
    const root = await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    expect(root.envelope.state).toBe("published");
    await expect(w.dispatcher.replayDispatch(root.envelope.id)).rejects.toThrow(
      /replay targets a non-terminal transport state/,
    );
  });

  test("replay of an unknown envelope is refused fail-closed", async () => {
    const w = await world();
    await expect(
      w.dispatcher.replayDispatch("00000000-0000-7000-8000-00000000feed"),
    ).rejects.toThrow(/does not exist/);
  });
});
