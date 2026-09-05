/**
 * Integration — restart / resume / crash recovery over REAL
 * PostgreSQL (WORK-045 / D-04, acceptance criteria 3, 7; checkpoint
 * contracts CONCURRENCY-CRASH-SAFETY, IDENTITY-IDEMPOTENCY).
 *
 * The crash matrix: a fresh coordinator instance (a process restart)
 * over the SAME durable state converges every honest mid-flight
 * condition to the correct authoritative outcome:
 *
 *  - crash between the durable intent and the instance start
 *    (recorded) -> recovery re-drives the bounded start;
 *  - crash between the resolution record and the governed effect
 *    (signaled) -> recovery applies the effect (idempotent);
 *  - crash between the governed effect and the provider signal
 *    (settled, undelivered) -> recovery re-delivers within budget;
 *  - provider outage exhaustion (deferred) -> recovery re-drives;
 *  - the execution moved on by other governed means -> recovery
 *    supersedes the stale wait (never fires it);
 *  - provider-reported instance failure -> the wait abandons with
 *    the exact reason and the bounded replacement path re-arms;
 *  - waiting executions SURVIVE restart: a fresh coordinator scan
 *    re-arms waits for still-waiting executions (correlation-first,
 *    idempotent).
 *
 * None of the recovery paths consults the provider for what SHOULD
 * exist — PostgreSQL authority only.
 */

import { expect, test } from "vitest";
import { createOrchestrationSource } from "../../../src/modules/executions/adapters/orchestration-source";
import { createOrchestrationResolutionEffect } from "../../../src/modules/executions/adapters/workflow-effect";
import { createOrchestrationCoordinator } from "../../../src/platform/workflow/engine";
import { WorkflowTransportError } from "../../../src/platform/workflow/port";
import { definePgSuite } from "./harness";
import { seedWorkflowWorld, TEST_BOUNDS, TEST_POLICY, type WorkflowWorld } from "./workflow-world";

definePgSuite("restart / resume / crash recovery (WORK-045 D-04)", (ctx) => {
  const world = () => seedWorkflowWorld(ctx.port);

  /**
   * Simulate a process restart: a FRESH coordinator over the same
   * durable state AND the same provider (the provider instances
   * survive process restarts — that is the entire D-04 premise; only
   * the Zeck process is fresh).
   */
  const restartedCoordinator = async (
    w: WorkflowWorld,
  ): Promise<{
    readonly coordinator: ReturnType<typeof createOrchestrationCoordinator>;
    readonly transport: WorkflowWorld["transport"];
  }> => {
    const worldModule = await import("./workflow-world");
    const coordinator = createOrchestrationCoordinator({
      store: w.store,
      workflow: w.transport,
      effect: createOrchestrationResolutionEffect({
        service: w.service,
        orchestratorActorId: worldModule.ORCHESTRATOR_ACTOR_ID,
      }),
      source: createOrchestrationSource({
        db: w.db,
        deadlines: { waitTimeoutMs: 0 },
        now: () => new Date(),
      }),
      policy: TEST_POLICY,
      bounds: TEST_BOUNDS,
      generateId: (await import("../../../src/shared/ids")).createUuidv7Generator(),
      now: () => new Date(),
      sleep: async () => undefined,
    });
    return { coordinator: coordinator, transport: w.transport };
  };

  test("crash between intent and instance start: recovery re-drives the bounded start", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("crash-recorded", "user");
    // The crash: the durable intent commits, then the process dies
    // before the instance start (a non-transport error propagates
    // fail-closed — the wait stays `recorded`).
    w.transport.failNextStarts(1, new Error("simulated crash between intent and start"));
    await expect(w.coordinator.armWaitingExecutions(50)).rejects.toThrow(
      "simulated crash between intent and start",
    );
    const recorded = await w.store.listWaitsByExecution(executionId);
    expect(recorded.length).toBe(1);
    expect(recorded[0]?.state).toBe("recorded");
    expect(recorded[0]?.providerInstanceId).toBeNull();
    // A fresh coordinator (process restart) re-drives the bounded
    // start from PostgreSQL authority only.
    const { coordinator: fresh } = await restartedCoordinator(w);
    const report = await fresh.recoverPending(50);
    expect(report.startsDriven).toBe(1);
    const durable = await w.store.findWaitByKey(recorded[0]?.waitKey ?? "");
    expect(durable?.state).toBe("armed");
    expect(durable?.providerInstanceId).not.toBeNull();
    expect(await w.statusOf(executionId)).toBe("WAITING_USER");
  });

  test("crash between resolution and effect: recovery applies the pending governed effect", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("crash-signaled", "user");
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    const wait = outcomes[0]?.wait;
    // The crash: the notification recorded, the wait signaled, the
    // effect never applied (the process died).
    await w.store.recordNotification(
      {
        waitId: wait?.id ?? "",
        notificationKey: "cb-crash",
        kind: "callback",
        decision: null,
        approverId: null,
        payloadDigest: "c".repeat(64),
        outcome: "accepted",
        detail: null,
      },
      TEST_BOUNDS,
    );
    await w.store.markSignaled(wait?.id ?? "", {
      stage: "effect",
      attemptNo: 1,
      outcome: "accepted",
      detail: "resolution recorded: callback",
    });
    expect(await w.statusOf(executionId)).toBe("WAITING_USER");
    // A fresh coordinator (process restart) applies the effect from
    // durable state — idempotent, exactly one authoritative effect.
    const { coordinator: fresh } = await restartedCoordinator(w);
    const report = await fresh.recoverPending(50);
    expect(report.effectsApplied).toBe(1);
    const durable = await w.store.findWaitByKey(wait?.waitKey ?? "");
    expect(durable?.state).toBe("settled");
    expect(await w.statusOf(executionId)).toBe("RUNNING");
  });

  test("crash between effect and provider signal: the fresh recovery delivers and records the fact", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("crash-delivery", "user");
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    const wait = outcomes[0]?.wait;
    // The crash: the notification recorded, the wait signaled — the
    // process died before BOTH the effect and the provider signal.
    await w.store.recordNotification(
      {
        waitId: wait?.id ?? "",
        notificationKey: "cb-delivery",
        kind: "callback",
        decision: null,
        approverId: null,
        payloadDigest: "d".repeat(64),
        outcome: "accepted",
        detail: null,
      },
      TEST_BOUNDS,
    );
    await w.store.markSignaled(wait?.id ?? "", {
      stage: "effect",
      attemptNo: 1,
      outcome: "accepted",
      detail: "resolution recorded: callback",
    });
    // A fresh coordinator (process restart) applies the effect AND
    // delivers the provider signal; the delivery fact is durable.
    const { coordinator: fresh, transport } = await restartedCoordinator(w);
    const report = await fresh.recoverPending(50);
    expect(report.effectsApplied).toBe(1);
    expect(await w.statusOf(executionId)).toBe("RUNNING");
    const delivered = await ctx.port.execute<{ provider_delivered_at: string | null }>({
      sql: `SELECT provider_delivered_at FROM workflow_orchestration.notifications
WHERE notification_key = 'cb-delivery'`,
    });
    expect(delivered.rows[0]?.provider_delivered_at).not.toBeNull();
    // The signal reached the provider instance (the fresh transport's
    // instance — identified by the durable wait record).
    const durable = await w.store.findWaitByKey(wait?.waitKey ?? "");
    expect(transport.eventsOf(durable?.providerInstanceId ?? "")).toEqual(["zeck.callback"]);
  });

  test("provider outage exhaustion (deferred): recovery re-drives from PostgreSQL only", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("outage-deferred", "user");
    w.transport.failNextStarts(
      3,
      new WorkflowTransportError("provider unavailable (injected)", "transient"),
    );
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    expect(outcomes[0]?.wait.state).toBe("deferred");
    expect(await w.statusOf(executionId)).toBe("WAITING_USER");
    const { coordinator: fresh } = await restartedCoordinator(w);
    const report = await fresh.recoverPending(50);
    expect(report.startsDriven).toBeGreaterThanOrEqual(1);
    const durable = await w.store.findWaitByKey(outcomes[0]?.wait.waitKey ?? "");
    expect(durable?.state).toBe("armed");
  });

  test("the execution moved on by other governed means: recovery supersedes the stale wait", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("stale-wait", "user");
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    const wait = outcomes[0]?.wait;
    // The execution resumed by another path (the long-running
    // machinery, an operator, D-05 worker fabric...).
    await w.service.transition({ ...w.scopeOf(executionId), command: "resume" }, "resume-external");
    expect(await w.statusOf(executionId)).toBe("RUNNING");
    const { coordinator: fresh } = await restartedCoordinator(w);
    const report = await fresh.recoverPending(50);
    expect(report.staleSuperseded).toBeGreaterThanOrEqual(1);
    const durable = await w.store.findWaitByKey(wait?.waitKey ?? "");
    expect(durable?.state).toBe("superseded");
    // Superseded: no effect ever fired, no signal delivered.
    expect(w.transport.eventsOf(wait?.providerInstanceId ?? "")).toEqual([]);
  });

  test("provider-reported instance failure abandons the wait; the bounded replacement re-arms", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("provider-errored", "user");
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    const wait = outcomes[0]?.wait;
    w.transport.forceObservedStatus(wait?.providerInstanceId ?? "", "errored");
    const observed = await w.coordinator.observeProviderInstances(50);
    const mine = observed.find((o) => o.wait.executionId === executionId);
    expect(mine?.observed).toBe("errored");
    const durable = await w.store.findWaitByKey(wait?.waitKey ?? "");
    expect(durable?.state).toBe("abandoned");
    const abandoned = await ctx.port.execute<{ reason: string }>({
      sql: `SELECT aw.reason FROM workflow_orchestration.abandoned_waits aw
JOIN workflow_orchestration.waits wt ON wt.id = aw.wait_id WHERE wt.execution_id = $1`,
      parameters: [executionId],
    });
    expect(abandoned.rows[0]?.reason).toBe("provider-reported-errored");
    // The authority is untouched and the bounded replacement re-arms.
    expect(await w.statusOf(executionId)).toBe("WAITING_USER");
    const rearm = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    expect(rearm.length).toBe(1);
    expect(rearm[0]?.wait.waitOrdinal).toBe(1);
  });

  test("waiting executions survive restart: the fresh scan re-arms idempotently (correlation-first)", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("survive", "human");
    const first = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    expect(first.length).toBe(1);
    // A fresh coordinator (process restart) scans: the durable wait
    // is live, nothing new is armed — the wait SURVIVED the restart.
    const { coordinator: fresh } = await restartedCoordinator(w);
    const second = (await fresh.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    expect(second.length).toBe(0);
    const waits = await w.store.listWaitsByExecution(executionId);
    expect(waits.length).toBe(1);
    expect(waits[0]?.state).toBe("armed");
    // And the resolution still works through the fresh coordinator.
    const outcome = await w.coordinator.recordApproval({
      applicationId: w.applicationId,
      tenantId: w.tenantId,
      executionId,
      approverId: "approver-restart",
      decision: "approve",
      notificationKey: "approval-restart",
    });
    expect(outcome.effect).toBe("applied");
    expect(await w.statusOf(executionId)).toBe("RUNNING");
  });
});
