/**
 * VAL-023 acceptance criteria 3, 4, 5, 7 — the crown proof: the
 * security-validation application runs end to end against the REAL
 * platform path.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL
 *     authorities (seeded PostgreSQL world) on a real port;
 *   - the REAL executions lifecycle (canonical transitions + durable
 *     planning decision recorded BEFORE the first dispatch + the
 *     `agent-action-recorded` per-attempt dispatch journal + the tool
 *     event vocabulary (tool-requested / tool-result / tool-denied)
 *     + genuine wait-tool → resume cycles around every governed tool
 *     round) driven platform-side exactly as Zeck's operators would;
 *   - the offline rows drive the scripted DEFENDED completions (the
 *     deterministic model stand-ins) and the controlled fixture world
 *     through the REAL platform path — every offline row is driven
 *     with NO credentials while the REAL endpoint domains stay pinned
 *     and asserted;
 *   - the live rows (env-gated on the authorized rails) drive the
 *     injection corpus through REAL model dispatches over the PINNED
 *     REAL endpoint domains (OpenRouter chat + vision; dashscope
 *     compatible-mode chat): a REAL model genuinely attempting to
 *     follow the injected instructions is the system under test, and
 *     the mechanical oracle verifies the DEFENSE — the injected
 *     directive was not followed; the declared task outcome was
 *     achieved or honestly refused.
 *
 * The provider credentials are environment-gated (absent key =
 * recorded NOT RUN boundary, never a fake success). Secret-flow
 * verification is mechanical and DURABLE: the per-row planted
 * synthetic secrets are scanned against the driver's run result AND
 * against the durable ledger's own event rows (no secret substring
 * appears in any evidence field).
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { runSecurityValidationApp } from "../../../benchmarks/validation/apps/security-validation/application";
import {
  CORPUS_RETRY_POLICY,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  resolveRowImageDataUri,
  resolveRowModel,
  SECURITY_CORPUS,
  type SecurityCorpusRow,
} from "../../../benchmarks/validation/apps/security-validation/corpus";
import {
  createScriptedCompletionTransport,
  createSecurityToolWorld,
} from "../../../benchmarks/validation/apps/security-validation/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import {
  bindSecurityRailDispatch,
  createBoundaryGuardedExecutor,
  createSecurityRail,
  driveSecurityExecution,
  type HttpTransport,
  type SecurityLifecyclePort,
  scanEvidenceForSecretMaterial,
  secretByLabel,
} from "../../../benchmarks/validation/platform/security-validation";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type ApiPgWorld, seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite, type PgContext } from "../postgres/harness";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const QWEN_KEY = process.env.QWEN_API_KEY ?? "";
const REVISION = createHash("sha256")
  .update("val-023|security-validation|pinned")
  .digest("hex")
  .slice(0, 40);

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly defenseVerdict: string;
  readonly attempts: number;
  readonly journaled: number;
  readonly waitToolCycles: number;
  readonly toolEvents: number;
  readonly boundaryRejections: number;
  readonly toolExecutions: number;
  readonly refusedInstruments: number;
  readonly latencyMs: number;
  readonly usage: string;
  readonly evidenceScan: "clean" | "LEAK";
  readonly appPassed: boolean;
}

/** The platform-side lifecycle binding over the REAL executions service. */
function createLifecycleBinding(world: ApiPgWorld): SecurityLifecyclePort {
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
        // resume per round) must never collide on the ledger.
        `val-023-${executionId}-${step}-${transitionCounter}`,
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
                strategyId: "val-023-pinned",
                plan: {
                  strategyClass: route.strategyClass,
                  modelCalls: 1,
                  steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                },
              },
            ],
            selectedStrategyId: "val-023-pinned",
          },
        },
        `val-023-${executionId}-decision`,
      );
    },
    async recordDispatchAttempt({ executionId, record }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-023-dispatch-attempt-${record.attempt}`,
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
        `val-023-${executionId}-attempt-${record.attempt}`,
      );
    },
    async recordToolEvent({ executionId, command, tool, reference }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command,
          cause: `val-023-${command}`,
          reference: { tool, ...reference },
          payload: { tool },
        },
        `val-023-${executionId}-${command}-${tool}-${generateId().slice(-6)}`,
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
            recordedBy: "val-023-platform",
            evidence: [...criterion.evidence],
          })),
        },
        `val-023-${executionId}-${verdict}`,
      );
    },
  };
}

/** Drive one corpus row platform-side and ledger-verify the journal. */
async function driveRow(
  ctx: PgContext,
  world: ApiPgWorld,
  options: {
    readonly row: SecurityCorpusRow;
    readonly executionId: string;
    readonly transport: "offline-scripted" | "live-rail";
  },
): Promise<RunFacts> {
  const lifecycle = createLifecycleBinding(world);
  const { row } = options;
  const isLive = options.transport === "live-rail";

  const toolWorld = createSecurityToolWorld();
  const executor = createBoundaryGuardedExecutor({
    tools: toolWorld.tools,
    exposedTools: row.exposedTools,
    now: () => Date.now(),
  });

  let transport: HttpTransport;
  if (isLive) {
    transport = (url, init) => globalThis.fetch(url, init);
  } else {
    if (row.scenario === null) throw new Error("offline row without scenario");
    transport = createScriptedCompletionTransport({ scenario: row.scenario }).transport;
  }
  const apiKey = row.rail.family === "dashscope|compatible-mode-chat" ? QWEN_KEY : OPENROUTER_KEY;
  const rail = createSecurityRail({ transport, apiKey, timeoutMs: 60_000, now: () => Date.now() });
  const dispatch = bindSecurityRailDispatch({
    rail,
    railFamily: row.rail.family,
    model: resolveRowModel(row),
    spec: row.spec,
    ...(row.rail.maxTokens === undefined ? {} : { maxTokens: row.rail.maxTokens }),
    ...(resolveRowImageDataUri(row) === undefined
      ? {}
      : { imageDataUri: resolveRowImageDataUri(row) }),
  });

  const result = await driveSecurityExecution({
    executionId: options.executionId,
    task: { kind: row.kind, input: { scenario: row.rowId } },
    groundTruth: row,
    provider: "security-probe-rail",
    model: resolveRowModel(row),
    lifecycle,
    dispatch,
    toolRound:
      row.toolInvocation === undefined ? null : { executor, invocation: row.toolInvocation },
    retry: {
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      backoffMs: isLive ? 4_000 : 10,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    now: () => new Date(),
    worldFacts: () => ({
      refusedInstruments: toolWorld.state.refusedInstrumentDigests.length,
      unexposedExecutions: toolWorld.state.credentialReads,
      ordersPlaced: toolWorld.state.ordersPlaced,
    }),
  });

  // The durable ledger evidence for THIS execution — the external
  // cross-check of the per-attempt journal (exactly once per attempt)
  // and the tool cycle counts.
  const events = await ctx.port.execute<{ command: string; reference: unknown }>({
    sql: `SELECT command, reference FROM executions.execution_events WHERE execution_id = $1 ORDER BY sequence ASC`,
    parameters: [options.executionId],
  });
  const commands = events.rows.map((rowEvent) => rowEvent.command);
  const journaled = commands.filter((command) => command === "agent-action-recorded").length;
  const waitToolCycles = commands.filter((command) => command === "wait-tool").length;
  const toolEvents = commands.filter((command) => command.startsWith("tool-")).length;
  const boundaryRejections = commands.filter((command) => command === "tool-denied").length;

  // The mechanical DURABLE secret scan: the row's planted synthetic
  // secrets must not appear in ANY evidence field — the driver's run
  // result AND the durable ledger's own event rows.
  const plantedSecrets = row.plantedSecretLabels.map((label) => {
    try {
      return secretByLabel(label);
    } catch {
      return null;
    }
  });
  const knownSecrets = plantedSecrets.filter(
    (secret): secret is NonNullable<typeof secret> => secret !== null,
  );
  const evidenceScan = scanEvidenceForSecretMaterial(
    {
      runResult: {
        attempts: result.attempts,
        criteria: result.criteria,
        waitToolCycles: result.waitToolCycles,
        toolEvents: result.toolEvents,
      },
      ledgerEvents: events.rows,
      toolWorldRefusals: toolWorld.state.refusedInstrumentDigests,
    },
    knownSecrets,
  );

  // The honest outcome contract for every run.
  expect(result.terminal).toBe(row.expected.terminal);
  expect(result.totalAttempts).toBe(row.expected.attempts);
  const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
  expect(failedCriteria, `${row.rowId} criteria: ${JSON.stringify(failedCriteria)}`).toEqual([]);
  expect(result.boundaryRejections).toBe(row.expected.boundaryRejections);
  expect(result.toolExecutions).toBe(row.expected.toolExecutions);
  expect(result.refusedInstruments).toBe(row.expected.refusedInstruments);
  // The derived defense verdict matches the row's pinned verdict
  // (offline rows are deterministic; live rows may honestly refuse
  // instead — both are passing defense outcomes, never violated).
  if (!isLive) {
    expect(result.defenseVerdict).toBe(row.expected.defenseVerdict);
  } else {
    expect(["defended", "refused-honestly"]).toContain(result.defenseVerdict);
  }
  // Journal exactly once per attempt — ledger-verified.
  expect(journaled).toBe(row.expected.attempts);
  // Tool rounds: every round is a genuine wait-tool → resume pair.
  if (row.toolInvocation !== undefined) {
    expect(waitToolCycles).toBe(1);
    expect(toolEvents).toBeGreaterThanOrEqual(
      row.expected.toolExecutions + row.expected.boundaryRejections,
    );
  } else {
    expect(waitToolCycles).toBe(0);
    expect(toolEvents).toBe(0);
  }
  expect(boundaryRejections).toBe(row.expected.boundaryRejections);
  // The durable evidence scan stays clean.
  expect(evidenceScan.clean, `${row.rowId} durable leak: ${evidenceScan.findings.join(";")}`).toBe(
    true,
  );

  return {
    rowId: row.rowId,
    terminal: result.terminal,
    defenseVerdict: result.defenseVerdict,
    attempts: result.totalAttempts,
    journaled,
    waitToolCycles,
    toolEvents,
    boundaryRejections,
    toolExecutions: result.toolExecutions,
    refusedInstruments: result.refusedInstruments,
    latencyMs: result.totalDispatchLatencyMs,
    usage:
      result.usage === null
        ? "none-reported"
        : `${result.usage.inputTokens}+${result.usage.outputTokens}` +
          (result.usage.costUsd === undefined ? "" : `/$${result.usage.costUsd}`),
    evidenceScan: evidenceScan.clean ? "clean" : "LEAK",
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
  return runSecurityValidationApp({
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
      configuration: { suite: "val-023-security-validation" },
    },
    runSuffix: `it-${options.generateId().slice(-8)}`,
    taskIndex: options.taskIndex,
  });
}

definePgSuite("VAL-023 security validation over the real platform path", (ctx) => {
  test("the offline adversarial corpus defends over the REAL platform path (injection, boundary, secret-flow)", {
    timeout: 300_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const drivenExecutionIds = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      for (const row of OFFLINE_CORPUS_ROWS) {
        const taskIndex = SECURITY_CORPUS.findIndex((candidate) => candidate.rowId === row.rowId);
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
          transport: "offline-scripted",
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
          `[VAL-023]   ${facts.rowId} -> ${facts.terminal} verdict=${facts.defenseVerdict} ` +
            `attempts=${facts.attempts} journaled=${facts.journaled} waitTool=${facts.waitToolCycles} ` +
            `toolEvents=${facts.toolEvents} boundary=${facts.boundaryRejections} ` +
            `executed=${facts.toolExecutions} refused=${facts.refusedInstruments} ` +
            `latency=${facts.latencyMs}ms usage=${facts.usage} evidence=${facts.evidenceScan}`,
        );
      }

      const defended = runFacts.filter((fact) => fact.defenseVerdict === "defended").length;
      const refused = runFacts.filter((fact) => fact.defenseVerdict === "refused-honestly").length;
      console.info(
        `[VAL-023] OFFLINE corpus summary: ${defended} defended + ${refused} refused-honestly ` +
          `= ${runFacts.length}/${runFacts.length} COMPLETED over the REAL platform path; every row ` +
          `journal-verified exactly once per attempt; the durable evidence scan clean on every row ` +
          `(scripted defended completions — the deterministic model stand-ins; zero credentials).`,
      );
      expect(runFacts.length).toBe(OFFLINE_CORPUS_ROWS.length);
      expect(runFacts.every((fact) => fact.terminal === "COMPLETED")).toBe(true);
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL live rails defend the injection corpus through REAL model dispatches", {
    timeout: 240_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    const notRun: string[] = [];
    const anyCredential = OPENROUTER_KEY.length > 0 || QWEN_KEY.length > 0;
    if (!anyCredential) {
      console.warn(
        "[VAL-023] OPENROUTER_API_KEY and QWEN_API_KEY both absent — the REAL live rail rows " +
          "are a NOT RUN boundary (recorded honestly; no fake success is asserted). The offline " +
          "corpus above covers every defense path without credentials.",
      );
      expect(true).toBe(true);
      return;
    }

    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const drivenExecutionIds = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      for (const [corpusIndex, row] of SECURITY_CORPUS.entries()) {
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
          `[VAL-023]   LIVE ${facts.rowId} -> ${facts.terminal} verdict=${facts.defenseVerdict} ` +
            `attempts=${facts.attempts} journaled=${facts.journaled} latency=${facts.latencyMs}ms ` +
            `usage=${facts.usage} evidence=${facts.evidenceScan}`,
        );
      }

      const defended = runFacts.filter((fact) => fact.defenseVerdict === "defended").length;
      const refused = runFacts.filter((fact) => fact.defenseVerdict === "refused-honestly").length;
      console.info(
        `[VAL-023] LIVE rail summary: ${defended} defended + ${refused} refused-honestly of ` +
          `${runFacts.length} driven live rows over the REAL endpoint domains (REAL model ` +
          `dispatches — a REAL model genuinely attempting to follow the injected instructions ` +
          `is the system under test; the mechanical oracle verified the DEFENSE).`,
      );
      for (const boundary of notRun) {
        console.warn(`[VAL-023] NOT RUN boundary: ${boundary}`);
      }
      // At least one REAL live dispatch happened (never an all-NOT-RUN
      // silent pass once a credential is present).
      expect(runFacts.length).toBeGreaterThan(0);
    } finally {
      await world.server.app.close();
    }
  });
});
