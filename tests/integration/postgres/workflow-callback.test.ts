/**
 * Integration — callback intake + idempotent convergence over REAL
 * PostgreSQL (WORK-045 / D-04, acceptance criteria 3, 4, 7; checkpoint
 * contracts IDENTITY-IDEMPOTENCY, CONCURRENCY-CRASH-SAFETY,
 * EXECUTION-PROVENANCE).
 *
 * Proves over the real database:
 *
 *  - a callback resolves the authoritative wait and re-enters the
 *    governed execution path: WAITING_USER -> RUNNING through the
 *    single write path (the state machine arbitrates);
 *  - duplicate delivery converges: the same notification key replays
 *    the SAME durable outcome — exactly one authoritative effect ever
 *    (zero duplicate transitions, zero duplicate provider signals);
 *  - a DIFFERENT notification key after resolution is refused stale
 *    (bounded evidence; zero effects);
 *  - unbacked claims are refused fail-closed with ZERO durable rows
 *    and zero effects;
 *  - forged scope (wrong tenant/application) is refused with the
 *    bounded refused-scope evidence;
 *  - oversized payloads are refused before any durable write (large
 *    bytes never enter workflow state — only the digest would be);
 *  - notification payload BYTES are never stored (digest-only);
 *  - a crash between the durable signal record and the governed
 *    effect is healed by the recovery scan (signaled -> settled,
 *    already-applied convergence);
 *  - provider-signal delivery failure is bounded: the wait stays
 *    settled (the authority already moved), delivery retries within
 *    budget and then stops; the compaction run terminates the
 *    instance (bounded state).
 */

import { expect, test } from "vitest";
import {
  NotificationScopeError,
  OversizedNotificationError,
  StaleNotificationError,
  UnbackedNotificationError,
} from "../../../src/platform/workflow/engine";
import { definePgSuite } from "./harness";
import { seedWorkflowWorld } from "./workflow-world";

definePgSuite("callback intake + convergence (WORK-045 D-04)", (ctx) => {
  const world = () => seedWorkflowWorld(ctx.port);

  async function armedUserWait(suffix: string) {
    const w = await world();
    const executionId = await w.createWaitingExecution(suffix, "user");
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    return { w, executionId, wait: outcomes[0]?.wait };
  }

  test("a callback resolves the wait through the governed path (WAITING to RUNNING)", async () => {
    const { w, executionId, wait } = await armedUserWait("resolve");
    const outcome = await w.coordinator.notifyCallback({
      applicationId: w.applicationId,
      tenantId: w.tenantId,
      executionId,
      notificationKey: "cb-1",
      payload: { result: "external-party-done" },
    });
    expect(outcome.waitKey).toBe(wait?.waitKey);
    expect(outcome.state).toBe("settled");
    expect(outcome.effect).toBe("applied");
    expect(outcome.providerSignaled).toBe(true);
    expect(await w.statusOf(executionId)).toBe("RUNNING");
    // The provider instance received exactly the resolution signal.
    expect(w.transport.eventsOf(wait?.providerInstanceId ?? "")).toEqual(["zeck.callback"]);
    // The deterministic effect key is recorded on the durable wait.
    const durable = await w.store.findWaitByKey(wait?.waitKey ?? "");
    expect(durable?.appliedOperationKey).toBe(`workflow-effect:${wait?.waitKey}`);
  });

  test("duplicate delivery converges to exactly one authoritative effect", async () => {
    const { w, executionId, wait } = await armedUserWait("dup");
    const first = await w.coordinator.notifyCallback({
      applicationId: w.applicationId,
      tenantId: w.tenantId,
      executionId,
      notificationKey: "cb-1",
      payload: { attempt: 1 },
    });
    expect(first.effect).toBe("applied");
    // The duplicate (same key) is late: the wait resolved already.
    await expect(
      w.coordinator.notifyCallback({
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        executionId,
        notificationKey: "cb-1",
        payload: { attempt: 2 },
      }),
    ).rejects.toThrow(StaleNotificationError);
    // A different key after resolution is also refused stale.
    await expect(
      w.coordinator.notifyCallback({
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        executionId,
        notificationKey: "cb-other",
        payload: { attempt: 3 },
      }),
    ).rejects.toThrow(StaleNotificationError);
    // Exactly one governed transition ever: the execution is RUNNING,
    // one accepted notification row, one provider signal — and the
    // late deliveries wrote ZERO rows (the terminal wait is history:
    // late noise refuses with nothing durable, bounded by
    // construction).
    expect(await w.statusOf(executionId)).toBe("RUNNING");
    const notifications = await ctx.port.execute<{ outcome: string; count: string }>({
      sql: `SELECT outcome, count(*) AS count FROM workflow_orchestration.notifications n
JOIN workflow_orchestration.waits wt ON wt.id = n.wait_id WHERE wt.execution_id = $1
GROUP BY outcome`,
      parameters: [executionId],
    });
    const accepted = notifications.rows.find((r) => r.outcome === "accepted");
    expect(accepted?.count).toBe("1");
    expect(notifications.rows.length).toBe(1);
    expect(w.transport.eventsOf(wait?.providerInstanceId ?? "")).toEqual(["zeck.callback"]);
  });

  test("the arbitration is physical: one accepted notification per wait", async () => {
    const { w, executionId } = await armedUserWait("one-accepted");
    const wait = await w.liveWait(executionId, "callback");
    // The first resolution is accepted.
    const first = await w.coordinator.notifyCallback({
      applicationId: w.applicationId,
      tenantId: w.tenantId,
      executionId,
      notificationKey: "cb-first",
      payload: {},
    });
    expect(first.effect).toBe("applied");
    // A second accepted insert for the same wait is unrepresentable
    // (the partial unique index: first resolution wins physically).
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO workflow_orchestration.notifications
  (wait_id, notification_key, kind, payload_digest, outcome)
VALUES ($1, 'other-key', 'callback', '${"a".repeat(64)}', 'accepted')`,
        parameters: [wait?.id ?? ""],
      }),
    ).rejects.toThrow();
    expect(await w.statusOf(executionId)).toBe("RUNNING");
  });

  test("unbacked claims are refused with zero durable rows and zero effects", async () => {
    const { w } = await armedUserWait("unbacked");
    const ghost = await w.createWaitingExecution("ghost", "user").then(async (id) => {
      // Never armed: no wait exists for this execution.
      return id;
    });
    await expect(
      w.coordinator.notifyCallback({
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        executionId: ghost,
        notificationKey: "cb-ghost",
        payload: {},
      }),
    ).rejects.toThrow(UnbackedNotificationError);
    const rows = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*) AS count FROM workflow_orchestration.notifications n
JOIN workflow_orchestration.waits wt ON wt.id = n.wait_id WHERE wt.execution_id = $1`,
      parameters: [ghost],
    });
    expect(rows.rows[0]?.count).toBe("0");
    expect(w.transport.callLog().filter((e) => e.kind === "signal").length).toBe(0);
  });

  test("forged scope is refused with bounded evidence (tenant isolation)", async () => {
    const { w, executionId, wait } = await armedUserWait("scope");
    await expect(
      w.coordinator.notifyCallback({
        applicationId: w.applicationId,
        tenantId: "00000000-0000-7000-8000-0000000000ff",
        executionId,
        notificationKey: "cb-forged",
        payload: {},
      }),
    ).rejects.toThrow(NotificationScopeError);
    // The authority is untouched: still waiting, never signaled.
    expect(await w.statusOf(executionId)).toBe("WAITING_USER");
    expect(w.transport.eventsOf(wait?.providerInstanceId ?? "")).toEqual([]);
    // And the bounded refusal evidence exists on the real wait.
    const evidence = await ctx.port.execute<{ outcome: string }>({
      sql: `SELECT outcome FROM workflow_orchestration.notifications n
JOIN workflow_orchestration.waits wt ON wt.id = n.wait_id WHERE wt.execution_id = $1 AND n.outcome = 'refused-scope'`,
      parameters: [executionId],
    });
    expect(evidence.rows.length).toBe(1);
    // The wait is still live and resolvable by the rightful party.
    const outcome = await w.coordinator.notifyCallback({
      applicationId: w.applicationId,
      tenantId: w.tenantId,
      executionId,
      notificationKey: "cb-legit",
      payload: {},
    });
    expect(outcome.effect).toBe("applied");
  });

  test("oversized payloads are refused before any durable write", async () => {
    const { w, executionId } = await armedUserWait("oversized");
    const huge: Record<string, unknown> = {};
    huge.padding = "x".repeat(8192); // beyond the 4096 test bound
    await expect(
      w.coordinator.notifyCallback({
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        executionId,
        notificationKey: "cb-huge",
        payload: huge,
      }),
    ).rejects.toThrow(OversizedNotificationError);
    const rows = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*) AS count FROM workflow_orchestration.notifications n
JOIN workflow_orchestration.waits wt ON wt.id = n.wait_id WHERE wt.execution_id = $1`,
      parameters: [executionId],
    });
    expect(rows.rows[0]?.count).toBe("0");
    expect(await w.statusOf(executionId)).toBe("WAITING_USER");
  });

  test("notification payload bytes are never stored (digest only)", async () => {
    const { w, executionId } = await armedUserWait("digest");
    await w.coordinator.notifyCallback({
      applicationId: w.applicationId,
      tenantId: w.tenantId,
      executionId,
      notificationKey: "cb-digest",
      payload: { secretLookingValue: "SK-LIVE-1234567890", result: "ok" },
    });
    const columns = await ctx.port.execute<{ column_name: string }>({
      sql: `SELECT column_name FROM information_schema.columns
WHERE table_schema = 'workflow_orchestration' AND table_name = 'notifications'`,
    });
    expect(columns.rows.map((r) => r.column_name)).not.toContain("payload");
    const stored = await ctx.port.execute<{ payload_digest: string; detail: string | null }>({
      sql: `SELECT n.payload_digest, n.detail FROM workflow_orchestration.notifications n
JOIN workflow_orchestration.waits wt ON wt.id = n.wait_id WHERE wt.execution_id = $1`,
      parameters: [executionId],
    });
    expect(stored.rows[0]?.payload_digest).toMatch(/^[a-f0-9]{64}$/);
    // The payload VALUE never appears anywhere in the table.
    const scan = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*) AS count FROM workflow_orchestration.notifications
WHERE payload_digest LIKE '%SK-LIVE%' OR coalesce(detail, '') LIKE '%SK-LIVE%'`,
    });
    expect(scan.rows[0]?.count).toBe("0");
  });

  test("a crash between the signal record and the effect is healed by recovery", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("crash-signal", "user");
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    const wait = outcomes[0]?.wait;
    // Simulate the crash: record the notification + signal the wait
    // WITHOUT applying the effect (the engine crashed after step 3).
    await w.store.recordNotification(
      {
        waitId: wait?.id ?? "",
        notificationKey: "cb-crash",
        kind: "callback",
        decision: null,
        approverId: null,
        payloadDigest: "a".repeat(64),
        outcome: "accepted",
        detail: null,
      },
      { maxPayloadBytes: 4096, maxRetainedNotifications: 32 },
    );
    const signaled = await w.store.markSignaled(wait?.id ?? "", {
      stage: "effect",
      attemptNo: 1,
      outcome: "accepted",
      detail: "resolution recorded: callback",
    });
    expect(signaled.state).toBe("signaled");
    // The crash left the execution WAITING with a signaled wait.
    expect(await w.statusOf(executionId)).toBe("WAITING_USER");
    // Recovery re-applies the pending governed effect from durable
    // state (already-applied / applied convergence).
    const report = await w.coordinator.recoverPending(50);
    expect(report.effectsApplied).toBe(1);
    const after = await w.store.findWaitByKey(wait?.waitKey ?? "");
    expect(after?.state).toBe("settled");
    expect(await w.statusOf(executionId)).toBe("RUNNING");
  });

  test("provider-signal delivery failure is bounded; the authority already moved", async () => {
    const { w, executionId, wait } = await armedUserWait("delivery");
    // All three delivery attempts fail transiently.
    for (let i = 0; i < 3; i++) {
      w.transport.failNextSignal();
    }
    const outcome = await w.coordinator.notifyCallback({
      applicationId: w.applicationId,
      tenantId: w.tenantId,
      executionId,
      notificationKey: "cb-delivery",
      payload: {},
    });
    // The wait settled authoritatively; the provider never learned.
    expect(outcome.state).toBe("settled");
    expect(outcome.effect).toBe("applied");
    expect(outcome.providerSignaled).toBe(false);
    expect(await w.statusOf(executionId)).toBe("RUNNING");
    // The delivery evidence is bounded (3 attempts, never delivered).
    const notification = await ctx.port.execute<{
      provider_delivery_attempts: number;
      provider_delivered_at: string | null;
    }>({
      sql: `SELECT n.provider_delivery_attempts, n.provider_delivered_at
FROM workflow_orchestration.notifications n
JOIN workflow_orchestration.waits wt ON wt.id = n.wait_id WHERE wt.execution_id = $1 AND n.outcome = 'accepted'`,
      parameters: [executionId],
    });
    expect(notification.rows[0]?.provider_delivery_attempts).toBe(3);
    expect(notification.rows[0]?.provider_delivered_at).toBeNull();
    // A later recovery re-delivers within the remaining budget
    // (budget exhausted: 3 of 3 consumed) — nothing more happens.
    const report = await w.coordinator.recoverPending(50);
    expect(report.signalsDelivered).toBe(0);
    // Compaction terminates the instance — bounded provider state.
    const compaction = await w.coordinator.compact(50);
    expect(compaction.instancesTerminated).toBeGreaterThanOrEqual(1);
    expect(w.transport.wasTerminated(wait?.providerInstanceId ?? "")).toBe(true);
  });
});
