/**
 * Integration — transport inspection over REAL PostgreSQL (WORK-044 /
 * D-03, acceptance criterion 5; checkpoint contract
 * IMPLEMENTATION-COMPLETENESS).
 *
 * Proves the operational observability contract:
 *
 *  - the snapshot reports dispatch counts by transport state, the
 *    backlogged dispatch list CORRELATED to the authoritative
 *    execution ids, dead letters with reasons, recent attempt
 *    evidence and replay lineages;
 *  - inspection is STRICTLY READ-ONLY: running it changes no
 *    authoritative and no transport-progress state (the counts before
 *    and after are identical — inspection never redefines anything);
 *  - the backlog list is bounded (list limit) and correlated.
 */

import { expect, test } from "vitest";
import { inspectQueueTransport } from "../../../src/platform/queue/inspection";
import { definePgSuite } from "./harness";
import { dispatchScopeOf, seedQueueWorld } from "./queue-world";

definePgSuite("queue transport inspection (WORK-044 D-03)", (ctx) => {
  const world = () => seedQueueWorld(ctx.port);

  test("the snapshot reports counts, backlog, dead letters, attempts and lineages", async () => {
    const w = await world();
    // One consumed dispatch.
    const done = await w.createQueuedExecution("inspect-done");
    await w.dispatcher.dispatchExecution({ executionId: done, ...dispatchScopeOf(w) });
    await w.consumer.consumeBatch({ batchSize: 10 });
    // One backlogged dispatch (provider outage for exactly one cycle).
    const backlogged = await w.createQueuedExecution("inspect-backlog");
    const { QueueTransportError } = await import("../../../src/platform/queue/port");
    w.transport.failNextPublish(3, new QueueTransportError("injected outage", "transient"));
    await w.dispatcher.dispatchExecution({ executionId: backlogged, ...dispatchScopeOf(w) });
    w.transport.clearPublishFailures();
    // One dead-lettered dispatch (governed rejection).
    const dead = await w.createQueuedExecution("inspect-dead");
    await w.dispatcher.dispatchExecution({ executionId: dead, ...dispatchScopeOf(w) });
    await w.service.transition(
      {
        command: "start",
        actorId: "00000000-0000-7000-8000-0000000000aa",
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        executionId: dead,
        reason: "pre-started for the inspection fixture",
      },
      `inspect-prestart-${dead}`,
    );
    await w.consumer.consumeBatch({ batchSize: 10 });

    const snapshot = await inspectQueueTransport(ctx.port);
    expect(snapshot.counts).toEqual({
      recorded: 0,
      published: 0,
      backlogged: 1,
      consumed: 1,
      deadLettered: 1,
    });
    expect(snapshot.backlogged.length).toBe(1);
    expect(snapshot.backlogged[0]?.executionId).toBe(backlogged);
    expect(snapshot.backlogged[0]?.correlationKey).toBe(`execution-dispatch:${backlogged}`);
    expect(snapshot.backlogged[0]?.publishAttempts).toBe(3);
    expect(snapshot.deadLetters.length).toBe(1);
    expect(snapshot.deadLetters[0]?.executionId).toBe(dead);
    expect(snapshot.deadLetters[0]?.reason).toBe("governed-rejection");
    expect(snapshot.recentAttempts.length).toBeGreaterThanOrEqual(3);
    expect(
      snapshot.recentAttempts.every(
        (a) => a.stage === "publish" || a.stage === "delivery" || a.stage === "settle",
      ),
    ).toBe(true);
    expect(snapshot.replayLineages).toEqual([]);
  });

  test("inspection is strictly read-only (no state change from inspecting)", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("inspect-readonly");
    await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    await w.consumer.consumeBatch({ batchSize: 10 });
    const before = await inspectQueueTransport(ctx.port);
    const executionBefore = await w.service.getExecution(w.applicationId, executionId);
    for (let i = 0; i < 3; i++) {
      await inspectQueueTransport(ctx.port);
    }
    const after = await inspectQueueTransport(ctx.port);
    expect(after).toEqual(before);
    const executionAfter = await w.service.getExecution(w.applicationId, executionId);
    expect(executionAfter).toEqual(executionBefore);
  });

  test("replay lineages are reported with their bounded counts", async () => {
    const w = await world();
    const executionId = await w.createQueuedExecution("inspect-replay");
    const dispatch = await w.dispatcher.dispatchExecution({
      executionId,
      ...dispatchScopeOf(w),
    });
    // Dead-letter the root, then replay once.
    await w.store.deadLetter(dispatch.envelope.id, "governed-rejection", 1, "fixture");
    const replay = await w.dispatcher.replayDispatch(dispatch.envelope.id);
    expect(replay.envelope.state).toBe("published");
    const snapshot = await inspectQueueTransport(ctx.port);
    expect(snapshot.replayLineages.length).toBe(1);
    expect(snapshot.replayLineages[0]?.rootCorrelationKey).toBe(
      `execution-dispatch:${executionId}`,
    );
    expect(snapshot.replayLineages[0]?.rootExecutionId).toBe(executionId);
    expect(snapshot.replayLineages[0]?.replays).toBe(1);
    expect(snapshot.replayLineages[0]?.replayKeys).toEqual([
      `execution-dispatch:${executionId}:replay-1`,
    ]);
  });

  test("list queries are bounded by the inspection limits", async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) {
      const executionId = await w.createQueuedExecution(`inspect-limit-${i}`);
      await w.dispatcher.dispatchExecution({ executionId, ...dispatchScopeOf(w) });
    }
    const snapshot = await inspectQueueTransport(ctx.port, { listLimit: 2, recentAttemptLimit: 2 });
    expect(snapshot.backlogged.length).toBeLessThanOrEqual(2);
    expect(snapshot.recentAttempts.length).toBeLessThanOrEqual(2);
  });
});
