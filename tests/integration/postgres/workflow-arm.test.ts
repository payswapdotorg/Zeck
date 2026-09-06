/**
 * Integration — durable orchestration arming + correlation over REAL
 * PostgreSQL (WORK-045 / D-04, acceptance criteria 1, 2, 5, 7; checkpoint
 * contracts IDENTITY-IDEMPOTENCY, CONCURRENCY-CRASH-SAFETY,
 * EXECUTION-PROVENANCE).
 *
 * Proves over the real database:
 *
 *  - the authoritative wait record exists BEFORE the provider
 *    instance-start call (the call-order record of the transport
 *    double is read mid-flight — the wait row is already committed:
 *    correlation-before-reliance);
 *  - one-to-one correlation: exactly one wait, one wait key, one
 *    provider instance per logical orchestration; the instance
 *    carries only the reference-only pointer payload;
 *  - arm idempotency: a repeated scan replays the SAME durable wait
 *    (no second wait, no second instance);
 *  - transient start failure: bounded attempts, the `deferred` state
 *    (the declared orchestration-paused degradation), durable
 *    attempt evidence — never a silent success, never an authority
 *    claim; recovery re-drives from PostgreSQL alone;
 *  - permanent start rejection: explicit abandonment with the exact
 *    reason;
 *  - the status→wait-kind mapping: WAITING_TOOL/WAITING_USER arm
 *    callback waits, WAITING_HUMAN arms approval waits;
 *  - bounded replacement lineage: an abandoned wait re-arms within
 *    the budget; the exhausted lineage is skipped (never an
 *    unbounded re-arm loop);
 *  - the physical schema: arming a nonexistent execution is
 *    unrepresentable (FK).
 */

import { expect, test } from "vitest";
import { WorkflowTransportError } from "../../../src/platform/workflow/port";
import { definePgSuite } from "./harness";
import { seedWorkflowWorld } from "./workflow-world";

definePgSuite("durable orchestration arming + correlation (WORK-045 D-04)", (ctx) => {
  const world = () => seedWorkflowWorld(ctx.port);

  test("the wait record is committed BEFORE the provider instance-start call", async () => {
    const w = await world();
    // A transport that inspects the database mid-call: the wait row
    // must already exist when the provider call happens (intent
    // first — correlation before reliance).
    const sawWaitDuringStart: {
      seen: { readonly state: string; readonly executionId: string } | null;
    } = { seen: null };
    const executionId = await w.createWaitingExecution("intent-first", "user");
    const originalStart = w.transport.startInstance.bind(w.transport);
    w.transport.startInstance = async (input) => {
      const live = await w.store.findLiveWait(executionId, "callback");
      sawWaitDuringStart.seen =
        live === null ? null : { state: live.state, executionId: live.executionId };
      return originalStart(input);
    };
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]?.started).toBe(true);
    expect(sawWaitDuringStart.seen).not.toBeNull();
    expect(sawWaitDuringStart.seen?.state).toBe("recorded");
    expect(sawWaitDuringStart.seen?.executionId).toBe(executionId);
    // And after the call the state advanced to armed.
    const wait = await w.store.findWaitByKey(outcomes[0]?.wait.waitKey ?? "");
    expect(wait?.state).toBe("armed");
    expect(wait?.providerInstanceId).not.toBeNull();
  });

  test("one-to-one correlation with a reference-only pointer payload", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("one-to-one", "human");
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    expect(outcomes.length).toBe(1);
    const wait = outcomes[0]?.wait;
    expect(wait).toBeDefined();
    expect(wait?.waitKey).toBe(`wait:${executionId}:approval:0`);
    expect(wait?.waitKind).toBe("approval");
    expect(wait?.waitOrdinal).toBe(0);
    expect(wait?.replacementOf).toBeNull();
    // The provider instance is exactly the hinted id, and the only
    // instance the double holds.
    expect(w.transport.callLog().filter((e) => e.kind === "start").length).toBe(1);
    // The pointer payload is ids/provenance only (reference-only):
    const params = wait?.pointerPayload as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(
      [
        "applicationId",
        "armedAt",
        "deadline",
        "executionId",
        "tenantId",
        "v",
        "waitKey",
        "waitKind",
      ].sort(),
    );
    expect(params.v).toBe(1);
    expect(params.executionId).toBe(executionId);
  });

  test("the status-to-kind mapping arms the three wait kinds from the authoritative statuses", async () => {
    const w = await world();
    const tool = await w.createWaitingExecution("map-tool", "tool");
    const user = await w.createWaitingExecution("map-user", "user");
    const human = await w.createWaitingExecution("map-human", "human");
    const scope = new Set([tool, user, human]);
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter((o) =>
      scope.has(o.wait.executionId),
    );
    expect(outcomes.length).toBe(3);
    const kinds = outcomes.map((o) => o.wait.waitKind).sort();
    expect(kinds).toEqual(["approval", "callback", "callback"]);
    const statuses = outcomes.map((o) => o.wait.waitKind);
    expect(new Set(statuses).size).toBe(2);
  });

  test("arm idempotency: a repeated scan replays the same durable wait", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("idempotent", "user");
    const ofMine = (outcomes: readonly { wait: { executionId: string } }[]) =>
      outcomes.filter((o) => o.wait.executionId === executionId);
    const first = ofMine(await w.coordinator.armWaitingExecutions(50));
    expect(first.length).toBe(1);
    const second = ofMine(await w.coordinator.armWaitingExecutions(50));
    expect(second.length).toBe(0);
    const waits = await w.store.listWaitsByExecution(executionId);
    expect(waits.length).toBe(1);
    expect(w.transport.callLog().filter((e) => e.kind === "start").length).toBe(1);
  });

  test("transient start failures exhaust into deferred with durable evidence; recovery re-drives", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("outage", "user");
    // All three per-invocation attempts fail transiently.
    w.transport.failNextStarts(
      3,
      new WorkflowTransportError("provider unavailable (injected)", "transient"),
    );
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]?.started).toBe(false);
    const wait = outcomes[0]?.wait;
    expect(wait?.state).toBe("deferred");
    expect(wait?.startAttempts).toBe(3);
    // The authoritative execution is untouched — orchestration
    // degraded, authority unchanged.
    expect(await w.statusOf(executionId)).toBe("WAITING_USER");
    // Recovery reads PostgreSQL only and re-drives the start.
    const report = await w.coordinator.recoverPending(10);
    expect(report.startsDriven).toBe(1);
    const recovered = await w.store.findWaitByKey(wait?.waitKey ?? "");
    expect(recovered?.state).toBe("armed");
    expect(recovered?.startAttempts).toBe(4);
  });

  test("permanent start rejection abandons the wait with the exact reason", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("rejected", "user");
    w.transport.failNextStarts(
      1,
      new WorkflowTransportError(
        "workflow instance start rejected (http 401, provider code 10000: Authentication error)",
        "permanent",
      ),
    );
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    expect(outcomes[0]?.wait.state).toBe("abandoned");
    const abandoned = await ctx.port.execute<{ reason: string }>({
      sql: `SELECT reason FROM workflow_orchestration.abandoned_waits aw
JOIN workflow_orchestration.waits wt ON wt.id = aw.wait_id WHERE wt.execution_id = $1`,
      parameters: [executionId],
    });
    expect(abandoned.rows[0]?.reason).toBe("start-rejected");
    expect(await w.statusOf(executionId)).toBe("WAITING_USER");
  });

  test("bounded replacement lineage: re-arm within budget, skip beyond it", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("lineage", "user");
    // Each cycle: arm a wait, then have the provider report the
    // instance errored (the engine abandons the wait — bounded
    // replacement available), then re-arm. The lineage budget (3
    // replacements) caps the total at root + 3.
    for (let cycle = 0; cycle < 5; cycle++) {
      const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
        (o) => o.wait.executionId === executionId,
      );
      if (cycle < 4) {
        expect(outcomes.length).toBe(1);
        const instanceId = outcomes[0]?.wait.providerInstanceId;
        expect(instanceId).not.toBeNull();
        w.transport.forceObservedStatus(instanceId ?? "", "errored");
        const observed = await w.coordinator.observeProviderInstances(50);
        const mine = observed.find((o) => o.wait.executionId === executionId);
        expect(mine?.observed).toBe("errored");
      } else {
        // Beyond the budget: no more waits are created (bounded —
        // inspection surfaces the stuck condition, no loop exists).
        expect(outcomes.length).toBe(0);
      }
    }
    const waits = await w.store.listWaitsByExecution(executionId);
    // Root (0) + 3 bounded replacements = 4; the 5th cycle skipped.
    expect(waits.length).toBe(4);
    expect(waits.map((wait) => wait.waitOrdinal).sort()).toEqual([0, 1, 2, 3]);
    expect(waits.every((wait) => wait.state === "abandoned")).toBe(true);
    expect(await w.liveWait(executionId, "callback")).toBeNull();
    // The authoritative execution is untouched throughout.
    expect(await w.statusOf(executionId)).toBe("WAITING_USER");
  });

  test("the explicit replacement path is bounded against the root lineage", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("replace", "user");
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    const rootId = outcomes[0]?.wait.id ?? "";
    w.transport.forceObservedStatus(outcomes[0]?.wait.providerInstanceId ?? "", "errored");
    await w.coordinator.observeProviderInstances(50);
    for (let i = 0; i < 3; i++) {
      const replacement = await w.coordinator.replaceWait(rootId);
      expect(replacement.wait.waitOrdinal).toBe(i + 1);
      expect(replacement.wait.replacementOf).toBe(rootId);
      expect(replacement.wait.state).toBe("armed");
      // The live wait replays instead of advancing the lineage.
      const again = await w.coordinator.replaceWait(rootId);
      expect(again.wait.id).toBe(replacement.wait.id);
      expect(again.created).toBe(false);
      // Abandon it to advance the lineage.
      w.transport.forceObservedStatus(replacement.wait.providerInstanceId ?? "", "errored");
      await w.coordinator.observeProviderInstances(50);
    }
    await expect(w.coordinator.replaceWait(rootId)).rejects.toThrow(
      /replacement budget exhausted.*3\/3/,
    );
    const waits = await w.store.listWaitsByExecution(executionId);
    expect(waits.length).toBe(4);
  });

  test("arming a nonexistent execution is unrepresentable (physical FK)", async () => {
    const w = await world();
    await expect(
      w.store.recordWaitIntent({
        id: "00000000-0000-7000-8000-000000000001",
        waitKey: "wait:00000000-0000-7000-8000-000000000002:callback:0",
        tenantId: w.tenantId,
        applicationId: w.applicationId,
        executionId: "00000000-0000-7000-8000-000000000002",
        waitKind: "callback",
        waitOrdinal: 0,
        replacementOf: null,
        pointerPayload: {},
        payloadDigest: "0".repeat(64),
        deadline: null,
      }),
    ).rejects.toThrow();
  });
});
