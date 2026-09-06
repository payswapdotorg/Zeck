/**
 * Discrimination tests — the D-04 orchestration protections
 * (WORK-045, HIGH_ASSURANCE; the worker-runbook rule: "For
 * HIGH_ASSURANCE and CRITICAL, add an explicit discrimination test
 * that proves a weakened protection is rejected").
 *
 * Every fail-closed protection introduced by WORK-045 is
 * mutation-proven — the WEAKENED form of the state is rejected by the
 * gate that owns it:
 *
 *  - bounded budgets: zero / negative / fractional / over-ceiling
 *    policies and state bounds are rejected (the "infinite
 *    orchestration" and "unbounded state" weakenings are
 *    unrepresentable);
 *  - configuration: missing provider materialization fails closed
 *    naming the exact variable (the "default-and-go" weakening is
 *    rejected) — and the value never appears in the error;
 *  - probe isolation (the PR #6 discipline applied to orchestration):
 *    the weakened forms that would let a probe touch application
 *    orchestration — no dedicated probe workflow, or a probe workflow
 *    that IS the orchestration workflow — are rejected fail-closed
 *    before any wire call (the protocol suite carries the
 *    regression battery over real HTTP);
 *  - the error taxonomy: provider refusals classify permanent
 *    (401/403/404) vs transient (429/5xx/network);
 *  - secret hygiene: the API token never appears in any error;
 *  - reference-only payloads: an oversized payload is rejected BEFORE
 *    any durable write or wire call (the "store the bytes" weakening
 *    is detectable — the table has no payload column at all);
 *  - the vocabulary disjointness: a wait vocabulary that overlaps the
 *    frozen execution state machine is DETECTED by the same
 *    mechanical check the unit suite pins;
 *  - authority-side double-application (real PostgreSQL): a second
 *    governed effect against the execution authority is rejected
 *    INVALID_STATE_TRANSITION — the physical guard that makes
 *    duplicate-notification convergence a property of the AUTHORITY,
 *    not a hope of the engine;
 *  - authority-side refusal (real PostgreSQL): an orchestration
 *    resolution against a NON-waiting execution is rejected by the
 *    state machine (the orchestration never widens authority —
 *    resume from RUNNING is unrepresentable);
 *  - unbacked notification intake (real PostgreSQL): a notification
 *    with no durable wait is refused with zero effects (the
 *    provider-said-so weakening is rejected — provider state is
 *    never authority).
 */

import { describe, expect, test } from "vitest";
import { EXECUTION_STATES } from "../../src/modules/executions/domain/state-machine";
import {
  createCloudflareWorkflowsTransport,
  missingCloudflareWorkflowsConfiguration,
} from "../../src/platform/workflow/cloudflare-workflows";
import {
  ORCHESTRATION_WAIT_STATES,
  validateRetryPolicy,
  validateStateBounds,
  WorkflowConfigError,
  WorkflowTransportError,
  waitEffectIdempotencyKey,
} from "../../src/platform/workflow/port";
import { PlatformError } from "../../src/shared/errors";
import { definePgSuite } from "../integration/postgres/harness";
import { seedWorkflowWorld } from "../integration/postgres/workflow-world";

describe("D-04 orchestration discrimination (WORK-045)", () => {
  test("bounded budgets: the unbounded/weakened policies and bounds are rejected", () => {
    const base = {
      maxStartAttempts: 3,
      maxSignalAttempts: 3,
      maxEffectAttempts: 3,
      maxReplacements: 3,
      retryBackoffMs: 500,
    };
    for (const override of [
      { maxStartAttempts: 0 },
      { maxStartAttempts: -1 },
      { maxStartAttempts: 101 },
      { maxSignalAttempts: 0.5 },
      { maxEffectAttempts: Number.NaN },
      { maxReplacements: 1e9 },
      { retryBackoffMs: -100 },
    ]) {
      expect(() => validateRetryPolicy({ ...base, ...override })).toThrow(WorkflowConfigError);
    }
    for (const override of [
      { maxPayloadBytes: 255 },
      { maxPayloadBytes: 65_537 },
      { maxRetainedNotifications: 0 },
    ]) {
      expect(() =>
        validateStateBounds({ maxPayloadBytes: 4096, maxRetainedNotifications: 32, ...override }),
      ).toThrow(WorkflowConfigError);
    }
  });

  test("configuration: the default-and-go weakening is rejected with the variable NAME", () => {
    const missing = missingCloudflareWorkflowsConfiguration({});
    expect(missing.length).toBe(3);
    expect(missing.join("; ")).toContain("ZECK_CLOUDFLARE_ACCOUNT_ID is not set");
    expect(missing.join("; ")).toContain("ZECK_WORKFLOW_NAME is not set");
    expect(missing.join("; ")).toContain("ZECK_WORKFLOW_API_TOKEN is not set");
    expect(() =>
      createCloudflareWorkflowsTransport({
        accountId: "a".repeat(32),
        workflowName: "zeck-production-orchestration",
        apiToken: "",
      }),
    ).toThrow(WorkflowConfigError);
  });

  test("the error taxonomy discriminates permanent from transient provider refusals", async () => {
    let respondStatus = 200;
    const transport = createCloudflareWorkflowsTransport({
      accountId: "a".repeat(32),
      workflowName: "zeck-production-orchestration",
      apiToken: "cf-workflow-discrimination-token",
      requestTimeoutMs: 500,
      fetchImpl: (async () => {
        return new Response(
          JSON.stringify({ success: false, errors: [{ code: 10000, message: "injected" }] }),
          { status: respondStatus },
        );
      }) as unknown as typeof fetch,
    });
    // 401/403/404 classify permanent.
    for (const status of [401, 403, 404]) {
      respondStatus = status;
      await expect(transport.describeInstance("any-instance")).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof WorkflowTransportError && error.failureKind === "permanent",
      );
    }
    // 429/5xx classify transient (bounded-retry material, never
    // abandonment).
    for (const status of [429, 500, 503]) {
      respondStatus = status;
      await expect(transport.describeInstance("any-instance")).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof WorkflowTransportError && error.failureKind === "transient",
      );
    }
  });

  test("secret hygiene: the API token never appears in transport errors", async () => {
    const token = "cf-super-secret-discrimination-token-material";
    const transport = createCloudflareWorkflowsTransport({
      accountId: "a".repeat(32),
      workflowName: "zeck-production-orchestration",
      apiToken: token,
      requestTimeoutMs: 500,
      fetchImpl: (async () => {
        throw new Error(`network refused while holding ${token}`);
      }) as unknown as typeof fetch,
    });
    await expect(transport.describeInstance("any-instance")).rejects.toSatisfy((error: unknown) => {
      expect((error as Error).message).not.toContain(token);
      expect((error as Error).message).toContain("[redacted]");
      return true;
    });
  });

  test("probe isolation: the weakened probe-on-orchestration-workflow forms are rejected fail-closed", () => {
    const base = {
      accountId: "a".repeat(32),
      workflowName: "zeck-production-orchestration",
      apiToken: "cf-token",
      requestTimeoutMs: 500,
      fetchImpl: (async () => {
        throw new Error("no wire call may happen for a weakened probe");
      }) as unknown as typeof fetch,
    };
    // No probe workflow: probe() refuses naming the exact variable.
    const noProbe = createCloudflareWorkflowsTransport(base);
    expect(noProbe.probe()).rejects.toThrow(
      /ZECK_WORKFLOW_PROBE_NAME is not set; the probe never targets the orchestration workflow/,
    );

    // Probe workflow == orchestration workflow: rejected at
    // configuration validation (before any wire call).
    expect(() =>
      createCloudflareWorkflowsTransport({
        ...base,
        probeWorkflowName: base.workflowName,
      }),
    ).toThrow(/must differ from workflowName/);
  });

  test("vocabulary disjointness: a weakened (overlapping) wait vocabulary is DETECTED", () => {
    const weakenedVocabularies = [
      ["recorded", "armed", "signaled", "settled", "running"],
      ["recorded", "armed", "signaled", "completed"],
      ["recorded", "armed", "signaled", "failed"],
      ["recorded", "armed", "signaled", "elapsed", "cancelled"],
      ["queued", "armed", "signaled", "settled"],
    ];
    for (const weakened of weakenedVocabularies) {
      const collisions = weakened.filter((state) =>
        EXECUTION_STATES.some(
          (executionState) =>
            executionState.toLowerCase() === state.toLowerCase() ||
            executionState.toLowerCase().includes(state.toLowerCase()) ||
            state.toLowerCase().includes(executionState.toLowerCase()),
        ),
      );
      expect(
        collisions.length,
        `weakened vocabulary ${weakened.join("/")} must be detected`,
      ).toBeGreaterThan(0);
      // The ACTUAL vocabulary has no collisions (the same check).
      const actualCollisions = ORCHESTRATION_WAIT_STATES.filter((state) =>
        EXECUTION_STATES.some(
          (executionState) =>
            executionState.toLowerCase() === state.toLowerCase() ||
            executionState.toLowerCase().includes(state.toLowerCase()) ||
            state.toLowerCase().includes(executionState.toLowerCase()),
        ),
      );
      expect(actualCollisions).toEqual([]);
    }
  });

  test("reference-only payloads: the oversized weakening is rejected before any write", async () => {
    // The engine's intake bound (proven over real PG in the callback
    // suite) rejects oversized payloads; here the ADAPTER's
    // provider-bound defense is pinned: the rejection happens before
    // any wire call.
    const wireCalls = { count: 0 };
    const transport = createCloudflareWorkflowsTransport({
      accountId: "a".repeat(32),
      workflowName: "zeck-production-orchestration",
      apiToken: "cf-token",
      fetchImpl: (async () => {
        wireCalls.count += 1;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const huge: Record<string, unknown> = {};
    huge.padding = "x".repeat(1_048_577);
    await expect(
      transport.startInstance({ instanceHint: "zeck-w-huge-a1", params: huge }),
    ).rejects.toThrow(WorkflowConfigError);
    expect(wireCalls.count).toBe(0);
  });
});

definePgSuite("D-04 authority-side discrimination (WORK-045; real PostgreSQL)", (ctx) => {
  test("a second governed effect is REJECTED by the execution authority itself", async () => {
    const w = await seedWorkflowWorld(ctx.port);
    const executionId = await w.createWaitingExecution("double-effect", "user");
    await w.coordinator.armWaitingExecutions(50);
    const first = await w.coordinator.notifyCallback({
      applicationId: w.applicationId,
      tenantId: w.tenantId,
      executionId,
      notificationKey: "cb-once",
      payload: {},
    });
    expect(first.effect).toBe("applied");
    expect(await w.statusOf(executionId)).toBe("RUNNING");
    // The weakened form: re-apply the SAME governed effect with a
    // FRESH idempotency key (the "just run it again" bypass). The
    // execution AUTHORITY rejects it — RUNNING has no resume edge.
    const scope = w.scopeOf(executionId);
    await expect(
      w.service.transition({ ...scope, command: "resume" }, "discrimination-fresh-key"),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PlatformError && error.code === "INVALID_STATE_TRANSITION",
    );
    expect(await w.statusOf(executionId)).toBe("RUNNING");
  });

  test("an orchestration resolution against a NON-waiting execution is rejected by the state machine", async () => {
    const w = await seedWorkflowWorld(ctx.port);
    // A RUNNING execution (never entered a wait state): the governed
    // resume is unrepresentable — the orchestration can never widen
    // authority into a direct status write.
    const executionId = await w.createWaitingExecution("never-waited", "user");
    await w.service.transition({ ...w.scopeOf(executionId), command: "resume" }, "resume-early");
    expect(await w.statusOf(executionId)).toBe("RUNNING");
    // No wait exists: the intake is refused BEFORE any effect.
    await expect(
      w.coordinator.notifyCallback({
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        executionId,
        notificationKey: "cb-unbacked",
        payload: {},
      }),
    ).rejects.toThrow(/no live callback wait exists/);
    // And the direct effect application (the weakened bypass) is
    // rejected by the authority: RUNNING has no resume edge.
    const wait = {
      id: "00000000-0000-7000-8000-000000000001",
      waitKey: "wait:00000000-0000-7000-8000-000000000002:callback:0",
      tenantId: w.tenantId,
      applicationId: w.applicationId,
      executionId,
      waitKind: "callback" as const,
      waitOrdinal: 0,
      replacementOf: null,
      pointerPayload: {},
      payloadDigest: "0".repeat(64),
      deadline: null,
      state: "armed" as const,
      providerInstanceId: null,
      providerObservedStatus: null,
      providerObservedAt: null,
      providerTerminatedAt: null,
      startAttempts: 0,
      signalDeliveryAttempts: 0,
      retainedNotifications: 0,
      foldedNotifications: 0,
      appliedOperationKey: null,
      appliedAt: null,
      settledAt: null,
      elapsedAt: null,
      supersededAt: null,
      abandonedAt: null,
      createdAt: "",
      updatedAt: "",
    };
    const effect = w.coordinator
      ? (
          await import("../../src/modules/executions/adapters/workflow-effect")
        ).createOrchestrationResolutionEffect({
          service: w.service,
          orchestratorActorId: "00000000-0000-7000-8000-0000000000ed",
        })
      : null;
    const outcome = await effect?.apply(
      { wait, cause: { kind: "callback", notificationKey: "cb-direct" } },
      waitEffectIdempotencyKey(wait.waitKey),
    );
    expect(outcome?.outcome).toBe("rejected");
    expect(outcome?.outcome === "rejected" && outcome.reason).toContain("INVALID_STATE_TRANSITION");
    expect(await w.statusOf(executionId)).toBe("RUNNING");
  });

  test("unbacked notification intake is refused with zero effects (provider state is never authority)", async () => {
    const w = await seedWorkflowWorld(ctx.port);
    const ghost = "00000000-0000-7000-8000-000000000003";
    await expect(
      w.coordinator.notifyCallback({
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        executionId: ghost,
        notificationKey: "cb-ghost",
        payload: {},
      }),
    ).rejects.toThrow(/unbacked notification/);
    // Zero rows were written for the ghost claim (the suite shares
    // the database with the earlier discrimination tests — the
    // refusal itself must not add anything).
    const rows = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*) AS count FROM workflow_orchestration.notifications n
JOIN workflow_orchestration.waits wt ON wt.id = n.wait_id
WHERE wt.execution_id = $1`,
      parameters: [ghost],
    });
    expect(rows.rows[0]?.count).toBe("0");
    const before = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*) AS count FROM workflow_orchestration.notifications",
    });
    const beforeCount = Number(before.rows[0]?.count);
    // The refusal is idempotent: repeating it writes nothing.
    await expect(
      w.coordinator.notifyCallback({
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        executionId: ghost,
        notificationKey: "cb-ghost-2",
        payload: {},
      }),
    ).rejects.toThrow(/unbacked notification/);
    const after = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*) AS count FROM workflow_orchestration.notifications",
    });
    expect(Number(after.rows[0]?.count)).toBe(beforeCount);
  });
});
