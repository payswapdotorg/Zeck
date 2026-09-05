/**
 * Integration — durable deadline / expiration handling over REAL
 * PostgreSQL (WORK-045 / D-04, acceptance criteria 5 and 6; checkpoint
 * contracts CONCURRENCY-CRASH-SAFETY, EXECUTION-PROVENANCE).
 *
 * Proves over the real database:
 *
 *  - a due deadline elapses through the GOVERNED expiration path
 *    (WAITING_* -> EXPIRED through the single execution write path);
 *  - the PostgreSQL deadline is the authority: a not-yet-due wait is
 *    untouched even when the PROVIDER instance has already finished
 *    its sleep (observed "complete" — evidence only, never an
 *    authority claim);
 *  - a due deadline elapses even when the provider is unreachable
 *    (the governed effect precedes the transport signal; the
 *    authority never depends on the provider);
 *  - the elapsed wait is terminal: a late callback is refused stale
 *    with zero effects;
 *  - the deadline scan is bounded and idempotent (a repeated scan
 *    re-processes nothing);
 *  - the governed rejection path: expiring an execution that already
 *    moved on (resumed by other means) supersedes the wait instead
 *    of forcing a transition — the state machine arbitrates, the
 *    orchestration never widens authority;
 *  - the engine-driven deadline signal reaches the provider instance
 *    (reference-only body).
 */

import { expect, test } from "vitest";
import { StaleNotificationError } from "../../../src/platform/workflow/engine";
import { definePgSuite } from "./harness";
import { ACTOR_ID, seedWorkflowWorld } from "./workflow-world";

definePgSuite("durable deadline + expiration handling (WORK-045 D-04)", (ctx) => {
  test("a due deadline elapses through the governed expiration path", async () => {
    const clock = { now: new Date() };
    const w = await seedWorkflowWorld(ctx.port, {
      waitTimeoutMs: 60_000,
      now: () => clock.now,
    });
    const executionId = await w.createWaitingExecution("due", "user");
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    const wait = outcomes[0]?.wait;
    expect(wait?.deadline).not.toBeNull();
    // Not yet due: nothing happens.
    expect((await w.coordinator.applyDueDeadlines(50)).length).toBe(0);
    expect(await w.statusOf(executionId)).toBe("WAITING_USER");
    // The clock advances past the deadline.
    clock.now = new Date(clock.now.getTime() + 61_000);
    const applied = (await w.coordinator.applyDueDeadlines(50)).filter(
      (o) => o.waitKey === wait?.waitKey,
    );
    expect(applied.length).toBe(1);
    expect(applied[0]?.state).toBe("elapsed");
    expect(applied[0]?.effect).toBe("applied");
    // The governed expiration: WAITING_USER -> EXPIRED.
    expect(await w.statusOf(executionId)).toBe("EXPIRED");
    const durable = await w.store.findWaitByKey(wait?.waitKey ?? "");
    expect(durable?.state).toBe("elapsed");
    expect(durable?.appliedOperationKey).toBe(`workflow-effect:${wait?.waitKey}`);
    // The engine-driven deadline signal reached the provider instance.
    expect(w.transport.eventsOf(wait?.providerInstanceId ?? "")).toEqual(["zeck.deadline"]);
  });

  test("the PostgreSQL deadline is the authority — the provider's finished sleep is evidence only", async () => {
    const clock = { now: new Date() };
    const w = await seedWorkflowWorld(ctx.port, {
      waitTimeoutMs: 60_000,
      now: () => clock.now,
    });
    const executionId = await w.createWaitingExecution("provider-clock", "user");
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    const wait = outcomes[0]?.wait;
    // The PROVIDER instance finished its sleep (observed "complete")
    // while the authoritative deadline is not yet due.
    w.transport.forceObservedStatus(wait?.providerInstanceId ?? "", "complete");
    const observed = await w.coordinator.observeProviderInstances(50);
    const mine = observed.find((o) => o.wait.executionId === executionId);
    expect(mine?.observed).toBe("complete");
    // Evidence recorded; the wait stays armed; nothing expired.
    const durable = await w.store.findWaitByKey(wait?.waitKey ?? "");
    expect(durable?.providerObservedStatus).toBe("complete");
    expect(durable?.state).toBe("armed");
    expect((await w.coordinator.applyDueDeadlines(50)).length).toBe(0);
    expect(await w.statusOf(executionId)).toBe("WAITING_USER");
  });

  test("a due deadline elapses even when the provider is unreachable", async () => {
    const clock = { now: new Date() };
    const w = await seedWorkflowWorld(ctx.port, {
      waitTimeoutMs: 1_000,
      now: () => clock.now,
    });
    const executionId = await w.createWaitingExecution("provider-down", "user");
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    const wait = outcomes[0]?.wait;
    clock.now = new Date(clock.now.getTime() + 2_000);
    // The provider signal delivery fails: the governed effect
    // PRECEDES the transport signal — the authority never depends on
    // the provider.
    for (let i = 0; i < 3; i++) {
      w.transport.failNextSignal();
    }
    const applied = (await w.coordinator.applyDueDeadlines(50)).filter(
      (o) => o.waitKey === wait?.waitKey,
    );
    expect(applied[0]?.effect).toBe("applied");
    expect(applied[0]?.providerSignaled).toBe(false);
    expect(await w.statusOf(executionId)).toBe("EXPIRED");
  });

  test("an elapsed wait is terminal: late callbacks are refused stale", async () => {
    const clock = { now: new Date() };
    const w = await seedWorkflowWorld(ctx.port, {
      waitTimeoutMs: 60_000,
      now: () => clock.now,
    });
    const executionId = await w.createWaitingExecution("late-callback", "user");
    await w.coordinator.armWaitingExecutions(50);
    clock.now = new Date(clock.now.getTime() + 61_000);
    await w.coordinator.applyDueDeadlines(50);
    // The external party finally calls back after expiry.
    await expect(
      w.coordinator.notifyCallback({
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        executionId,
        notificationKey: "cb-late",
        payload: {},
      }),
    ).rejects.toThrow(StaleNotificationError);
    // The expired outcome is final: no second effect, no rows.
    expect(await w.statusOf(executionId)).toBe("EXPIRED");
    const rows = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*) AS count FROM workflow_orchestration.notifications n
JOIN workflow_orchestration.waits wt ON wt.id = n.wait_id WHERE wt.execution_id = $1`,
      parameters: [executionId],
    });
    expect(rows.rows[0]?.count).toBe("0");
  });

  test("the deadline scan is bounded and idempotent", async () => {
    const clock = { now: new Date() };
    const w = await seedWorkflowWorld(ctx.port, {
      waitTimeoutMs: 60_000,
      now: () => clock.now,
    });
    const executionId = await w.createWaitingExecution("idempotent-deadline", "user");
    const armed = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    const waitKey = armed[0]?.wait.waitKey;
    clock.now = new Date(clock.now.getTime() + 61_000);
    const first = (await w.coordinator.applyDueDeadlines(50)).filter((o) => o.waitKey === waitKey);
    expect(first.length).toBe(1);
    const second = (await w.coordinator.applyDueDeadlines(50)).filter((o) => o.waitKey === waitKey);
    expect(second.length).toBe(0);
  });

  test("expiring an execution that moved on supersedes the wait (the state machine arbitrates)", async () => {
    const clock = { now: new Date() };
    const w = await seedWorkflowWorld(ctx.port, {
      waitTimeoutMs: 60_000,
      now: () => clock.now,
    });
    const executionId = await w.createWaitingExecution("moved-on", "user");
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    const wait = outcomes[0]?.wait;
    clock.now = new Date(clock.now.getTime() + 61_000);
    // The execution COMPLETED by other governed means before the
    // deadline fired (resume -> verify -> pass).
    const scope = w.scopeOf(executionId);
    await w.service.transition({ ...scope, command: "resume" }, "resume-external");
    await w.service.transition({ ...scope, command: "verify" }, "verify-external");
    await w.service.transition(
      {
        ...scope,
        command: "pass",
        verificationResults: [
          {
            criterionId: "crit-1",
            strategy: "operator-confirmation",
            status: "PASS",
            recordedBy: ACTOR_ID,
          },
        ],
      },
      "pass-external",
    );
    expect(await w.statusOf(executionId)).toBe("COMPLETED");
    const applied = (await w.coordinator.applyDueDeadlines(50)).filter(
      (o) => o.waitKey === wait?.waitKey,
    );
    // The governed path refused the expiration (terminal states have
    // no outgoing edge): the wait is superseded, NOT force-expired —
    // the state machine arbitrates, the orchestration never widens
    // authority.
    expect(applied[0]?.state).toBe("superseded");
    expect(applied[0]?.effect).toBe("rejected");
    expect(await w.statusOf(executionId)).toBe("COMPLETED");
    const durable = await w.store.findWaitByKey(wait?.waitKey ?? "");
    expect(durable?.state).toBe("superseded");
  });
});
