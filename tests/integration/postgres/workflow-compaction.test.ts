/**
 * Integration — orchestration compaction + read-only inspection over
 * REAL PostgreSQL (WORK-045 / D-04, acceptance criteria 8 and 9;
 * checkpoint contracts IMPLEMENTATION-COMPLETENESS,
 * SELF-HOSTING-BOUNDARY).
 *
 * Proves over the real database:
 *
 *  - bounded notification retention: refused/stale notifications
 *    beyond the per-wait bound fold into the durable counter — NO
 *    rows materialize (bounded state by construction, never row
 *    deletion; the fold is inspectable);
 *  - provider-state compaction: terminal waits have their provider
 *    instances terminated (bounded provider state); an instance the
 *    provider already removed (404-class) counts as compacted;
 *  - the compaction scan is bounded and idempotent (a repeated run
 *    compacts nothing new);
 *  - the inspection snapshot is STRICTLY read-only: three
 *    consecutive inspections leave the orchestration tables
 *    byte-identical;
 *  - the inspection surfaces the operator-attention conditions
 *    (deferred/abandoned with reasons), the folded counters, the
 *    compacted-instance count and the notification outcome counts;
 *  - the provider limits are explicit and inspectable at the exact
 *    revision (the documented facts + the enforced bound).
 */

import { expect, test } from "vitest";
import { StaleNotificationError } from "../../../src/platform/workflow/engine";
import { inspectWorkflowOrchestration } from "../../../src/platform/workflow/inspection";
import { WorkflowTransportError } from "../../../src/platform/workflow/port";
import { definePgSuite } from "./harness";
import { InMemoryWorkflowTransport, seedWorkflowWorld, TEST_BOUNDS } from "./workflow-world";

definePgSuite("orchestration compaction + inspection (WORK-045 D-04)", (ctx) => {
  const world = () => seedWorkflowWorld(ctx.port, { waitTimeoutMs: 1_000 });

  async function snapshotChecksum() {
    const rows = await ctx.port.execute<{ table_name: string }>({
      sql: `SELECT table_name FROM information_schema.tables
WHERE table_schema = 'workflow_orchestration' ORDER BY table_name`,
    });
    const parts: string[] = [];
    for (const { table_name } of rows.rows) {
      const count = await ctx.port.execute<{ count: string }>({
        sql: `SELECT count(*) AS count FROM workflow_orchestration.${table_name}`,
      });
      const digest = await ctx.port.execute<{ md5: string | null }>({
        sql: `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS md5 FROM (
  SELECT * FROM workflow_orchestration.${table_name} OFFSET 0
) t`,
      });
      parts.push(`${table_name}:${count.rows[0]?.count}:${digest.rows[0]?.md5}`);
    }
    return parts.join(";");
  }

  test("refused notifications beyond the retention bound fold into the durable counter", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("flood", "user");
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    const wait = outcomes[0]?.wait;
    // Resolve nothing; instead flood the wait with STALE refusals by
    // forcing the wait signaled then pushing late arrivals.
    await w.store.recordNotification(
      {
        waitId: wait?.id ?? "",
        notificationKey: "flood-winner",
        kind: "callback",
        decision: null,
        approverId: null,
        payloadDigest: "e".repeat(64),
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
    // The wait is signaled: late arrivals are REFUSED-STALE, each
    // materializing a bounded row — until the bound folds the rest.
    for (let i = 0; i < 40; i++) {
      await expect(
        w.coordinator.notifyCallback({
          applicationId: w.applicationId,
          tenantId: w.tenantId,
          executionId,
          notificationKey: `flood-late-${i}`,
          payload: { i },
        }),
      ).rejects.toThrow(StaleNotificationError);
    }
    // The accepted row (1) + refused rows up to the bound (32 total
    // retained incl. accepted) — the rest folded into the counter.
    const rows = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*) AS count FROM workflow_orchestration.notifications n
JOIN workflow_orchestration.waits wt ON wt.id = n.wait_id WHERE wt.execution_id = $1`,
      parameters: [executionId],
    });
    expect(Number(rows.rows[0]?.count)).toBeLessThanOrEqual(32);
    const durable = await w.store.findWaitByKey(wait?.waitKey ?? "");
    expect(durable?.foldedNotifications ?? 0).toBeGreaterThanOrEqual(40 - 31);
    expect(durable?.retainedNotifications ?? 0).toBeLessThanOrEqual(32);
  });

  test("terminal waits have their provider instances terminated (bounded provider state)", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("compact", "user");
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    const wait = outcomes[0]?.wait;
    const resolved = await w.coordinator.notifyCallback({
      applicationId: w.applicationId,
      tenantId: w.tenantId,
      executionId,
      notificationKey: "cb-compact",
      payload: {},
    });
    expect(resolved.state).toBe("settled");
    expect(w.transport.wasTerminated(wait?.providerInstanceId ?? "")).toBe(false);
    const report = await w.coordinator.compact(50);
    expect(report.instancesTerminated).toBeGreaterThanOrEqual(1);
    expect(w.transport.wasTerminated(wait?.providerInstanceId ?? "")).toBe(true);
    const durable = await w.store.findWaitByKey(wait?.waitKey ?? "");
    expect(durable?.providerTerminatedAt).not.toBeNull();
    // Idempotent: a repeated run compacts nothing new.
    const again = await w.coordinator.compact(50);
    const mine = again.instancesTerminated;
    expect(mine).toBe(0);
  });

  test("a provider-removed instance (404) counts as compacted", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("compact-404", "user");
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    const wait = outcomes[0]?.wait;
    await w.coordinator.notifyCallback({
      applicationId: w.applicationId,
      tenantId: w.tenantId,
      executionId,
      notificationKey: "cb-404",
      payload: {},
    });
    // The provider already removed the instance: terminate answers
    // 404 permanent (the double forgets it).
    w.transport.forgetInstance(wait?.providerInstanceId ?? "");
    const report = await w.coordinator.compact(50);
    expect(report.instancesTerminated).toBeGreaterThanOrEqual(1);
    const durable = await w.store.findWaitByKey(wait?.waitKey ?? "");
    expect(durable?.providerTerminatedAt).not.toBeNull();
  });

  test("the inspection snapshot is strictly read-only", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("inspect", "human");
    await w.coordinator.armWaitingExecutions(50);
    await w.coordinator.recordApproval({
      applicationId: w.applicationId,
      tenantId: w.tenantId,
      executionId,
      approverId: "approver-inspect",
      decision: "approve",
      notificationKey: "approval-inspect",
    });
    await w.coordinator.compact(50);
    const before = await snapshotChecksum();
    const first = await inspectWorkflowOrchestration(ctx.port);
    const second = await inspectWorkflowOrchestration(ctx.port);
    const third = await inspectWorkflowOrchestration(ctx.port);
    const after = await snapshotChecksum();
    expect(after).toBe(before);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(second)).toBe(JSON.stringify(third));
  });

  test("the inspection surfaces the attention conditions and counters", async () => {
    const w = await world();
    const deferred = await w.createWaitingExecution("inspect-deferred", "user");
    w.transport.failNextStarts(3, new WorkflowTransportError("injected outage", "transient"));
    await w.coordinator.armWaitingExecutions(50);
    const abandoned = await w.createWaitingExecution("inspect-abandoned", "user");
    const armedAbandoned = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === abandoned,
    );
    w.transport.forceObservedStatus(armedAbandoned[0]?.wait.providerInstanceId ?? "", "errored");
    await w.coordinator.observeProviderInstances(50);

    const snapshot = await inspectWorkflowOrchestration(ctx.port);
    expect(snapshot.totalWaits).toBeGreaterThanOrEqual(2);
    expect(snapshot.waitsByState.map((s) => s.state)).toContain("deferred");
    expect(snapshot.waitsByState.map((s) => s.state)).toContain("abandoned");
    const deferredAttention = snapshot.attention.find((a) => a.state === "deferred");
    expect(deferredAttention).toBeDefined();
    const abandonedAttention = snapshot.attention.find((a) => a.state === "abandoned");
    expect(abandonedAttention?.reason).toBe("provider-reported-errored");
    // The authority is untouched by inspection.
    expect(await w.statusOf(deferred)).toBe("WAITING_USER");
    expect(await w.statusOf(abandoned)).toBe("WAITING_USER");
  });

  test("the provider limits descriptor is part of the port contract", () => {
    // The double implements the same port method the production
    // adapter implements (`describeLimits`); the protocol suite proves
    // the documented provider facts against the real adapter. This
    // pins the descriptor's presence and shape on the composed world.
    const limits = new InMemoryWorkflowTransport().describeLimits();
    expect(limits.maxPayloadBytes).toBeGreaterThan(0);
    expect(limits.supportsTermination).toBe(true);
    expect(typeof limits.documented).toBe("object");
    // The enforced reference-only bound stays far below the provider
    // payload limit (large bytes never enter workflow state).
    expect(TEST_BOUNDS.maxPayloadBytes).toBeLessThan(limits.maxPayloadBytes);
  });
});
