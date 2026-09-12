/**
 * VAL-020 acceptance criteria 3, 4, 5, 7 — the crown proof: the
 * failure-attribution application runs end to end against the REAL
 * platform path.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL
 *     authorities (seeded PostgreSQL world) on a real port;
 *   - the REAL executions lifecycle (canonical transitions + durable
 *     planning decision recorded BEFORE the first dispatch + the
 *     `agent-action-recorded` per-attempt dispatch journal + the tool
 *     event vocabulary + genuine wait-tool → resume cycles around
 *     every tool attempt) driven platform-side exactly as Zeck's
 *     operators would;
 *   - the offline fault-injection rows replay the REAL provider
 *     failure envelope shapes from the documented live runs through
 *     deterministic fake transports (the REAL endpoint domains are
 *     pinned and asserted) — every offline row is driven with NO
 *     credentials;
 *   - the live rail rows (env-gated on the authorized rails) drive
 *     REAL dispatches through the production fetch transport against
 *     the PINNED REAL endpoint domains and verify the platform's
 *     honest handling of the failure classes the live rails
 *     genuinely produce: classification, bounded retry, terminal
 *     state, journal evidence.
 *
 * The provider credentials are environment-gated (absent key =
 * recorded NOT RUN boundary, never a fake success). The live rows pin
 * the DOCUMENTED live postures of the operator credentials (the
 * quota-blocked QWEN imagegen, the video-synthesis tier boundary, the
 * OpenRouter credit-limit posture) — a posture change is an honest
 * finding that re-pins the row, never a silently tolerated mismatch.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { runFailureAttributionApp } from "../../../benchmarks/validation/apps/failure-attribution/application";
import {
  CORPUS_RETRY_POLICY,
  FAILURE_CORPUS,
  type FailureCorpusRow,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  resolveRailRequest,
} from "../../../benchmarks/validation/apps/failure-attribution/corpus";
import {
  createAttributionToolWorld,
  createFaultInjectedTransport,
} from "../../../benchmarks/validation/apps/failure-attribution/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import {
  type AttributionDispatch,
  type AttributionLifecyclePort,
  bindRailDispatch,
  bindToolDispatch,
  createAttributionRail,
  createBoundedToolExecutor,
  driveAttributionExecution,
} from "../../../benchmarks/validation/platform/failure-attribution";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type ApiPgWorld, seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite, type PgContext } from "../postgres/harness";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const QWEN_KEY = process.env.QWEN_API_KEY ?? "";
const REVISION = createHash("sha256")
  .update("val-020|failure-attribution|pinned")
  .digest("hex")
  .slice(0, 40);

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly attributionClass: string | null;
  readonly layer: string | null;
  readonly attempts: number;
  readonly journaled: number;
  readonly waitToolCycles: number;
  readonly toolEvents: number;
  readonly latencyMs: number;
  readonly usage: string;
  readonly appPassed: boolean;
}

/** The platform-side lifecycle binding over the REAL executions service. */
function createLifecycleBinding(world: ApiPgWorld): AttributionLifecyclePort {
  const generateId = createUuidv7Generator();
  let transitionCounter = 0;
  return {
    async transition({ executionId, step, reason }) {
      transitionCounter += 1;
      await world.executions.transition(
        {
          actorId: world.actorId,
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          executionId,
          command: step,
          reason,
        },
        // Every call gets a unique key: repeated steps (wait-tool /
        // resume per attempt) must never collide on the ledger.
        `val-020-${executionId}-${step}-${transitionCounter}`,
      );
    },
    async recordPlanningDecision({ executionId, route }) {
      await world.executions.recordPlanningDecision(
        {
          applicationId: world.applicationId,
          executionId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          decisionId: generateId(),
          planId: generateId(),
          payload: {
            candidates: [
              {
                strategyId: "val-020-pinned",
                plan: {
                  strategyClass: route.strategyClass,
                  modelCalls: 1,
                  steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                },
              },
            ],
            selectedStrategyId: "val-020-pinned",
          },
        },
        `val-020-${executionId}-decision`,
      );
    },
    async recordDispatchAttempt({ executionId, record }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-020-dispatch-attempt-${record.attempt}`,
          reference: {
            attempt: record.attempt,
            outcome: record.outcome,
            attributionClass: record.attributionClass,
            layer: record.layer,
            retryable: record.retryable,
            retried: record.retried,
            latencyMs: record.latencyMs,
            requestDigest: record.requestDigest,
            httpStatus: record.httpStatus,
          },
          payload: { attempt: record.attempt, outcome: record.outcome },
        },
        // Distinct per attempt (the ledger sees distinct payloads):
        // the idempotency key carries the attempt number.
        `val-020-${executionId}-attempt-${record.attempt}`,
      );
    },
    async recordToolEvent({ executionId, command, tool, reference }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command,
          cause: `val-020-${command}`,
          reference: { tool, ...reference },
          payload: { tool },
        },
        `val-020-${executionId}-${command}-${tool}-${generateId().slice(-6)}`,
      );
    },
    async complete({ executionId, verdict, criteria, reason }) {
      await world.executions.transition(
        {
          actorId: world.actorId,
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          executionId,
          command: verdict,
          reason,
          verificationResults: criteria.map((criterion) => ({
            criterionId: criterion.criterionId,
            strategy: criterion.strategy,
            status: criterion.status,
            recordedBy: "val-020-platform",
            evidence: [...criterion.evidence],
          })),
        },
        `val-020-${executionId}-${verdict}`,
      );
    },
  };
}

/** Drive one corpus row platform-side and ledger-verify the journal. */
async function driveRow(
  ctx: PgContext,
  world: ApiPgWorld,
  options: {
    readonly row: FailureCorpusRow;
    readonly executionId: string;
    readonly transport: "offline-injection" | "live-rail";
  },
): Promise<RunFacts> {
  const lifecycle = createLifecycleBinding(world);
  const { row } = options;
  const isLive = options.transport === "live-rail";

  let dispatch: AttributionDispatch;
  if (row.kind === "tool-probe") {
    if (row.toolInvocation === undefined) throw new Error("tool row without invocation");
    const toolWorld = createAttributionToolWorld();
    const executor = createBoundedToolExecutor({
      tools: toolWorld.tools,
      deadlineMs: 25,
      timer: async () => {},
    });
    dispatch = bindToolDispatch({ executor, invocation: row.toolInvocation });
  } else {
    const request = resolveRailRequest(row);
    const apiKey = request.rail === "openrouter" ? OPENROUTER_KEY : QWEN_KEY;
    const transport = isLive
      ? (
          url: string,
          init: Parameters<typeof globalThis.fetch>[1] & {
            method: string;
            headers: Record<string, string>;
            body?: string;
            signal?: AbortSignal;
          },
        ) => globalThis.fetch(url, init)
      : (() => {
          if (row.scenario === null) throw new Error("offline row without scenario");
          return createFaultInjectedTransport({ scenario: row.scenario }).transport;
        })();
    const rail = createAttributionRail({ transport, apiKey, timeoutMs: 60_000 });
    dispatch = bindRailDispatch({ rail, request });
  }

  const taskInput =
    row.kind === "tool-probe" && row.toolInvocation !== undefined
      ? { ...row.toolInvocation }
      : { scenario: row.rowId };
  const result = await driveAttributionExecution({
    executionId: options.executionId,
    task: { kind: row.kind, input: taskInput },
    groundTruth: row,
    provider: "attribution-probe-rail",
    model: row.railRequest?.model ?? "tool-surface",
    lifecycle,
    dispatch,
    retry: {
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      backoffMs: isLive ? 4_000 : 10,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    now: () => new Date(),
  });

  // The durable ledger evidence for THIS execution — the external
  // cross-check of the per-attempt journal (exactly once per attempt).
  const events = await ctx.port.execute<{ command: string }>({
    sql: `SELECT command FROM executions.execution_events WHERE execution_id = $1 ORDER BY sequence ASC`,
    parameters: [options.executionId],
  });
  const commands = events.rows.map((rowEvent) => rowEvent.command);
  const journaled = commands.filter((command) => command === "agent-action-recorded").length;
  const waitToolCycles = commands.filter((command) => command === "wait-tool").length;
  const toolEvents = commands.filter((command) => command.startsWith("tool-")).length;

  // The honest outcome contract for every run.
  expect(result.terminal).toBe(row.expected.terminal);
  expect(result.totalAttempts).toBe(row.expected.attempts);
  expect(result.finalAttribution?.attributionClass ?? null).toBe(row.expected.attributionClass);
  expect(result.finalAttribution?.layer ?? null).toBe(row.expected.layer);
  const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
  expect(failedCriteria, `${row.rowId} criteria: ${JSON.stringify(failedCriteria)}`).toEqual([]);
  // Journal exactly once per attempt — ledger-verified.
  expect(journaled).toBe(row.expected.attempts);
  // Tool rows: every attempt is a genuine wait-tool → resume pair.
  if (row.kind === "tool-probe") {
    expect(waitToolCycles).toBe(row.expected.attempts);
    expect(toolEvents).toBeGreaterThanOrEqual(row.expected.attempts);
  } else {
    expect(waitToolCycles).toBe(0);
  }

  return {
    rowId: row.rowId,
    terminal: result.terminal,
    attributionClass: result.finalAttribution?.attributionClass ?? null,
    layer: result.finalAttribution?.layer ?? null,
    attempts: result.totalAttempts,
    journaled,
    waitToolCycles,
    toolEvents,
    latencyMs: result.totalDispatchLatencyMs,
    usage:
      result.usage === null
        ? "none-reported"
        : `${result.usage.inputTokens}+${result.usage.outputTokens}` +
          (result.usage.costUsd === undefined ? "" : `/$${result.usage.costUsd}`),
    appPassed: false,
  };
}

/** Submit one corpus row through the public SDK boundary (the app). */
async function submitRow(
  world: ApiPgWorld,
  address: string,
  options: {
    readonly generateId: () => string;
    readonly taskIndex: number;
    readonly completionTimeoutMs: number;
  },
): Promise<{ readonly evidence: unknown; readonly passed: boolean }> {
  return runFailureAttributionApp({
    config: {
      applicationId: world.applicationId,
      baseUrl: address,
      tokenEnvVar: "ZECK_VALIDATION_TOKEN",
      applicationRevision: REVISION,
      corpusRevision: REVISION,
      integrationSurface: "sdk",
      pollIntervalMs: 250,
      completionTimeoutMs: options.completionTimeoutMs,
    },
    token: world.bearerToken,
    transport: globalThis.fetch,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    environment: {
      runtime: `node ${process.version}`,
      toolchain: "vitest",
      database: "postgresql",
      configuration: { suite: "val-020-failure-attribution" },
    },
    runSuffix: `it-${options.generateId().slice(-8)}`,
    taskIndex: options.taskIndex,
  });
}

definePgSuite("VAL-020 failure attribution over the real platform path", (ctx) => {
  test("the offline fault-injection corpus attributes and recovers over the REAL platform path", {
    timeout: 300_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const drivenExecutionIds = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      for (const row of OFFLINE_CORPUS_ROWS) {
        const taskIndex = FAILURE_CORPUS.findIndex((candidate) => candidate.rowId === row.rowId);
        const appPromise = submitRow(world, address, {
          generateId,
          taskIndex,
          completionTimeoutMs: 120_000,
        }).then(
          (outcome) => ({ ok: true as const, outcome }),
          (error: unknown) => ({ ok: false as const, error }),
        );

        // Platform side: wait for THIS task's submission to land.
        let executionId: string | null = null;
        for (let attempt = 0; attempt < 2_400 && executionId === null; attempt += 1) {
          const rows = await ctx.port.execute<{ id: string }>({
            sql: `SELECT id FROM executions.executions WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`,
            parameters: [world.applicationId],
          });
          const id = rows.rows[0]?.id;
          if (id !== undefined && !drivenExecutionIds.has(id)) {
            drivenExecutionIds.add(id);
            executionId = id;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(executionId).not.toBeNull();

        const facts = await driveRow(ctx, world, {
          row,
          executionId: executionId as string,
          transport: "offline-injection",
        });

        const appSettled = await appPromise;
        if (!appSettled.ok) {
          throw appSettled.error;
        }
        const violations = validateHarnessEvidence(appSettled.outcome.evidence as never);
        expect(violations).toEqual([]);
        // The application's assertions PASS on the honest outcome.
        expect(appSettled.outcome.passed).toBe(true);

        runFacts.push({ ...facts, appPassed: appSettled.outcome.passed });
        console.info(
          `[VAL-020]   ${facts.rowId} -> ${facts.terminal} ` +
            `class=${facts.attributionClass ?? "none"} layer=${facts.layer ?? "none"} ` +
            `attempts=${facts.attempts} journaled=${facts.journaled} ` +
            `waitTool=${facts.waitToolCycles} toolEvents=${facts.toolEvents} ` +
            `latency=${facts.latencyMs}ms usage=${facts.usage}`,
        );
      }

      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      const failed = runFacts.filter((fact) => fact.terminal === "FAILED").length;
      console.info(
        `[VAL-020] OFFLINE corpus summary: ${completed} COMPLETED / ${failed} FAILED (both honest) ` +
          `of ${runFacts.length} driven rows; every row journal-verified exactly once per attempt ` +
          `(fault-injection replays of the REAL envelope shapes; zero credentials).`,
      );
      expect(runFacts.length).toBe(OFFLINE_CORPUS_ROWS.length);
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL live rails attribute their genuine failure classes honestly", {
    timeout: 240_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    const notRun: string[] = [];
    const anyCredential = OPENROUTER_KEY.length > 0 || QWEN_KEY.length > 0;
    if (!anyCredential) {
      console.warn(
        "[VAL-020] OPENROUTER_API_KEY and QWEN_API_KEY both absent — the REAL live rail rows " +
          "are a NOT RUN boundary (recorded honestly; no fake success is asserted). The offline " +
          "corpus above covers every injection path without credentials.",
      );
      expect(true).toBe(true);
      return;
    }

    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const drivenExecutionIds = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      for (const [corpusIndex, row] of FAILURE_CORPUS.entries()) {
        if (row.liveGate === undefined) {
          continue;
        }
        if (!liveGateOpen(row, process.env)) {
          notRun.push(
            `${row.rowId} — gate closed (${row.liveGate.envVars.join("+")} absent); ` +
              `requirement: ${row.liveGate.requirement}`,
          );
          continue;
        }
        // Provider-side pacing: a modest spacing between REAL dispatches.
        await new Promise((resolve) => setTimeout(resolve, 2_000));

        const appPromise = submitRow(world, address, {
          generateId,
          taskIndex: corpusIndex,
          completionTimeoutMs: 180_000,
        }).then(
          (outcome) => ({ ok: true as const, outcome }),
          (error: unknown) => ({ ok: false as const, error }),
        );

        let executionId: string | null = null;
        for (let attempt = 0; attempt < 2_400 && executionId === null; attempt += 1) {
          const rows = await ctx.port.execute<{ id: string }>({
            sql: `SELECT id FROM executions.executions WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`,
            parameters: [world.applicationId],
          });
          const id = rows.rows[0]?.id;
          if (id !== undefined && !drivenExecutionIds.has(id)) {
            drivenExecutionIds.add(id);
            executionId = id;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(executionId).not.toBeNull();

        const facts = await driveRow(ctx, world, {
          row,
          executionId: executionId as string,
          transport: "live-rail",
        });

        const appSettled = await appPromise;
        if (!appSettled.ok) {
          throw appSettled.error;
        }
        expect(validateHarnessEvidence(appSettled.outcome.evidence as never)).toEqual([]);
        expect(appSettled.outcome.passed).toBe(true);

        runFacts.push({ ...facts, appPassed: appSettled.outcome.passed });
        console.info(
          `[VAL-020]   LIVE ${facts.rowId} -> ${facts.terminal} ` +
            `class=${facts.attributionClass ?? "none"} layer=${facts.layer ?? "none"} ` +
            `attempts=${facts.attempts} journaled=${facts.journaled} ` +
            `latency=${facts.latencyMs}ms usage=${facts.usage}`,
        );
      }

      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      const failed = runFacts.filter((fact) => fact.terminal === "FAILED").length;
      console.info(
        `[VAL-020] LIVE rail summary: ${completed} COMPLETED / ${failed} FAILED (both honest) ` +
          `of ${runFacts.length} driven live rows over the REAL endpoint domains ` +
          `(posture-pinned oracles: the quota-blocked QWEN imagegen, the video tier boundary, ` +
          `the OpenRouter credit limit).`,
      );
      for (const boundary of notRun) {
        console.warn(`[VAL-020] NOT RUN boundary: ${boundary}`);
      }
      // At least one REAL live dispatch happened (never an all-NOT-RUN
      // silent pass once a credential is present).
      expect(runFacts.length).toBeGreaterThan(0);
    } finally {
      await world.server.app.close();
    }
  });
});
