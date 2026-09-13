/**
 * VAL-022 acceptance criteria 3, 4, 5, 7 — the crown proof: the
 * substrate-readiness application runs end to end against the REAL
 * platform path.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL
 *     authorities (seeded PostgreSQL world) on a real port;
 *   - the REAL executions lifecycle (canonical transitions + durable
 *     planning decision recorded BEFORE the first dispatch + the
 *     platform's OWN sandbox evidence vocabulary — `sandbox-admitted`
 *     per attempt, `sandbox-completed` for settled attempts only,
 *     `sandbox-denied` for the quarantine decision, the
 *     `agent-action-recorded` per-probe and per-attempt journals)
 *     driven platform-side exactly as Zeck's operators would;
 *   - the offline fault-injection rows replay the REAL substrate
 *     failure shapes (the process runtime's admitted-deadline kill,
 *     the container runtime's OOMKilled inspection shape, the payload
 *     exit-code fold, the never-settling mid-execution loss) through
 *     deterministic fake substrate adapters — every offline row is
 *     driven with NO credentials and NO network;
 *   - the live rows drive the REAL process substrate adapter — the
 *     platform's declared sandbox/compute adapter surface
 *     (`ProcessSandboxProvider` over `runIsolatedProcess`): REAL
 *     readiness probes (a REAL trivial spawn), REAL isolated-process
 *     dispatches, the REAL admitted-deadline SIGKILL, the REAL
 *     non-zero-exit fold.
 *
 * The crown gate is `ZECK_PG_TEST_URL` (the live rows' own gate — the
 * REAL process substrate itself needs no credential; the operator's
 * sandbox IS the substrate). Live substrate LOSS and live OOM
 * coercion are NOT RUN boundaries — they cannot be coerced on demand;
 * the injection points are the adapter seams (the work order's own
 * framing), and the offline corpus covers both shapes deterministi-
 * cally. No result is fabricated, no success is asserted.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { runSubstrateFailureApp } from "../../../benchmarks/validation/apps/substrate-failure/application";
import {
  CORPUS_QUARANTINE_THRESHOLD,
  CORPUS_READINESS_POLICY,
  CORPUS_RETRY_POLICY,
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  SUBSTRATE_CORPUS,
  type SubstrateCorpusRow,
} from "../../../benchmarks/validation/apps/substrate-failure/corpus";
import { createFaultInjectedSubstrate } from "../../../benchmarks/validation/apps/substrate-failure/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import {
  bindReadinessGate,
  bindSubstrateRun,
  type ComputeSubstrateSeam,
  createBoundedSubstrateExecutor,
  createInMemorySubstrateRegistry,
  driveSubstrateReadinessExecution,
  type SubstrateReadinessLifecyclePort,
} from "../../../benchmarks/validation/platform/substrate-readiness";
import { ProcessSandboxProvider } from "../../../src/modules/sandbox/adapters/process-provider";
import { runIsolatedProcess } from "../../../src/platform/sandbox/process-runtime";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type ApiPgWorld, seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite, type PgContext } from "../postgres/harness";

const REVISION = createHash("sha256")
  .update("val-022|substrate-readiness|pinned")
  .digest("hex")
  .slice(0, 40);

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly execution: number;
  readonly terminal: string;
  readonly substrateClass: string | null;
  readonly platformClass: string | null;
  readonly attempts: number;
  readonly probes: number;
  readonly journaled: number;
  readonly sandboxAdmissions: number;
  readonly sandboxOutcomes: number;
  readonly quarantined: boolean;
  readonly latencyMs: number;
  readonly usage: string;
  readonly appPassed: boolean;
}

/** The flat task index where each row's executions start. */
function flatStartOf(rowId: string): number {
  let cursor = 0;
  for (const row of SUBSTRATE_CORPUS) {
    if (row.rowId === rowId) {
      return cursor;
    }
    cursor += row.executions.length;
  }
  throw new Error(`unknown row ${rowId}`);
}

/** The platform-side lifecycle binding over the REAL executions service. */
function createLifecycleBinding(world: ApiPgWorld): SubstrateReadinessLifecyclePort {
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
        // Every call gets a unique key (the ledger-key discipline).
        `val-022-${executionId}-${step}-${transitionCounter}`,
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
                strategyId: "val-022-pinned",
                plan: {
                  strategyClass: route.strategyClass,
                  modelCalls: 1,
                  steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                },
              },
            ],
            selectedStrategyId: "val-022-pinned",
          },
        },
        `val-022-${executionId}-decision`,
      );
    },
    async recordReadinessProbe({ executionId, record }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-022-readiness-probe-${record.probe}`,
          reference: {
            probe: record.probe,
            ready: record.ready,
            quarantined: record.quarantined,
            reason: record.reason,
          },
          payload: { probe: record.probe, ready: record.ready },
        },
        `val-022-${executionId}-probe-${record.probe}`,
      );
    },
    async recordSandboxAdmission({ executionId, attempt, sandboxId, taskDigest }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "sandbox-admitted",
          cause: `val-022-sandbox-admitted-${attempt}`,
          reference: { attempt, sandboxId, taskDigest },
          payload: { attempt, sandboxId },
        },
        `val-022-${executionId}-admission-${attempt}`,
      );
    },
    async recordDispatchAttempt({ executionId, record }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-022-dispatch-attempt-${record.attempt}`,
          reference: {
            attempt: record.attempt,
            outcome: record.outcome,
            substrateClass: record.substrateClass,
            platformClass: record.platformClass,
            retryable: record.retryable,
            retried: record.retried,
            latencyMs: record.latencyMs,
            sandboxId: record.sandboxId,
            gatingProbe: record.gatingProbe,
            taskDigest: record.taskDigest,
            exitCode: record.exitCode,
            timedOut: record.timedOut,
            oomKilled: record.oomKilled,
          },
          payload: { attempt: record.attempt, outcome: record.outcome },
        },
        // Distinct per attempt (the ledger sees distinct payloads).
        `val-022-${executionId}-attempt-${record.attempt}`,
      );
    },
    async recordSandboxOutcome({ executionId, attempt, sandboxId, reference }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "sandbox-completed",
          cause: `val-022-sandbox-completed-${attempt}`,
          reference: { sandboxId, ...reference },
          payload: { attempt, sandboxId },
        },
        `val-022-${executionId}-outcome-${attempt}`,
      );
    },
    async recordQuarantine({ executionId, substrateId, failureStreak, reason }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "sandbox-denied",
          cause: "val-022-quarantined",
          reference: { substrateId, failureStreak, reason },
          payload: { substrateId, failureStreak },
        },
        `val-022-${executionId}-quarantine-${generateId().slice(-6)}`,
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
            recordedBy: "val-022-platform",
            evidence: [...criterion.evidence],
          })),
        },
        `val-022-${executionId}-${verdict}`,
      );
    },
  };
}

/**
 * The REAL process substrate adapter bound onto the compute-substrate
 * seam — the platform's declared sandbox/compute adapter surface (AC3:
 * the REAL adapter's healthy path verified live). The readiness probe
 * is a REAL trivial spawn through the REAL process runtime; the runs
 * are REAL isolated-process dispatches through the REAL provider. The
 * observation mapping is faithful: the provider's own timeout class
 * sets the deadline marker; the OOM marker stays honestly absent (the
 * process class cannot observe an OOM kill — the platform's own fold
 * reads a non-timeout kill as the exit-code class).
 */
function createRealProcessSubstrateSeam(world: ApiPgWorld): ComputeSubstrateSeam {
  const provider = new ProcessSandboxProvider();
  const runtimeBinary = process.execPath;
  const resolveCommand = (command: string): string =>
    command === "runtime" ? runtimeBinary : command;
  return {
    async probeReadiness() {
      try {
        const probe = await runIsolatedProcess({
          command: runtimeBinary,
          args: ["--version"],
          env: {},
          timeoutMs: 10_000,
          workspace: "none",
        });
        if (probe.exitCode === 0 && !probe.timedOut) {
          return { ready: true, quarantined: false, reason: null };
        }
        return {
          ready: false,
          quarantined: false,
          reason: `process substrate probe exited ${String(probe.exitCode)} (timedOut: ${String(probe.timedOut)})`,
        };
      } catch (error) {
        return {
          ready: false,
          quarantined: false,
          reason: error instanceof Error ? error.message : "the process substrate probe failed",
        };
      }
    },
    async runInSandbox(spec) {
      const executionId = spec.sandboxId.split("/sandbox/")[0] ?? spec.sandboxId;
      const observation = await provider.execute({
        sandboxId: spec.sandboxId,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        executionId,
        kind: "process",
        isolationClass: "standard",
        task: {
          command: resolveCommand(spec.task.command),
          args: [...spec.task.args],
          publicEnv: { ...spec.task.env },
        },
        limits: {
          cpuMilliCores: spec.limits.cpuMilliCores,
          memoryMiB: spec.limits.memoryMiB,
          executionTimeoutMs: spec.limits.executionTimeoutMs,
        },
        network: { egress: "none", allowedHosts: [] },
        filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
        secretRefs: [],
      });
      const output = (observation.output ?? {}) as { exitCode?: unknown; durationMs?: unknown };
      const readExit = (): number | null =>
        typeof output.exitCode === "number" ? output.exitCode : null;
      if (observation.outcomeClass === "sandbox-success") {
        return {
          settled: true,
          timedOut: false,
          oomKilled: false,
          exitCode: 0,
          stdoutDigest: observation.outputDigest,
          durationMs: typeof output.durationMs === "number" ? output.durationMs : null,
          usageMicroUsd: observation.usageMicroUsd,
          adapterError: null,
        };
      }
      const failureClass = observation.failure?.failureClass;
      if (failureClass === "timeout") {
        return {
          settled: true,
          timedOut: true,
          oomKilled: false,
          exitCode: readExit() ?? 137,
          stdoutDigest: observation.outputDigest,
          durationMs: null,
          usageMicroUsd: null,
          adapterError: null,
        };
      }
      if (failureClass === "runtime-unavailable" || failureClass === "adapter-error") {
        return {
          settled: true,
          timedOut: false,
          oomKilled: false,
          exitCode: null,
          stdoutDigest: observation.outputDigest,
          durationMs: null,
          usageMicroUsd: null,
          adapterError: observation.failure?.message ?? "the process substrate failed closed",
        };
      }
      return {
        settled: true,
        timedOut: false,
        oomKilled: false,
        exitCode: readExit() ?? 1,
        stdoutDigest: observation.outputDigest,
        durationMs: null,
        usageMicroUsd: null,
        adapterError: null,
      };
    },
  };
}

/** Drive one corpus row platform-side and ledger-verify the journal. */
async function driveRow(
  ctx: PgContext,
  world: ApiPgWorld,
  options: {
    readonly row: SubstrateCorpusRow;
    readonly transport: "offline-injection" | "real-process-substrate";
    readonly registry: ReturnType<typeof createInMemorySubstrateRegistry>;
    readonly observationDeadlineMs: number;
    readonly backoffMs: number;
    readonly submitRow: (taskIndex: number) => Promise<
      | {
          readonly ok: true;
          readonly outcome: { readonly evidence: unknown; readonly passed: boolean };
        }
      | { readonly ok: false; readonly error: unknown }
    >;
    readonly generateId: () => string;
    readonly drivenExecutionIds: Set<string>;
  },
): Promise<RunFacts[]> {
  const lifecycle = createLifecycleBinding(world);
  const { row } = options;
  const seam =
    options.transport === "real-process-substrate"
      ? createRealProcessSubstrateSeam(world)
      : (() => {
          if (row.scenario === null) throw new Error("offline row without scenario");
          return createFaultInjectedSubstrate({ scenario: row.scenario }).seam;
        })();
  const executor = createBoundedSubstrateExecutor({
    seam,
    observationDeadlineMs: options.observationDeadlineMs,
  });
  const probe = bindReadinessGate({ registry: options.registry, seam });
  const run = bindSubstrateRun({
    executor,
    substrateId: row.substrateId,
    task: { command: row.task.command, args: [...row.task.args], env: {} },
    limits: { ...row.limits },
  });

  const facts: RunFacts[] = [];
  const flatStart = flatStartOf(row.rowId);
  for (const [executionIndex, groundTruth] of row.executions.entries()) {
    // Submit this execution through the public SDK boundary (the app).
    const appPromise = options.submitRow(flatStart + executionIndex);
    // Platform side: wait for THIS submission to land.
    let executionId: string | null = null;
    for (let attempt = 0; attempt < 4_800 && executionId === null; attempt += 1) {
      const rows = await ctx.port.execute<{ id: string }>({
        sql: `SELECT id FROM executions.executions WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`,
        parameters: [world.applicationId],
      });
      const id = rows.rows[0]?.id;
      if (id !== undefined && !options.drivenExecutionIds.has(id)) {
        options.drivenExecutionIds.add(id);
        executionId = id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(executionId, `${row.rowId}#${executionIndex + 1} landed`).not.toBeNull();

    const result = await driveSubstrateReadinessExecution({
      executionId: executionId as string,
      task: { kind: "substrate-probe", input: { scenario: row.rowId } },
      groundTruth,
      substrateId: row.substrateId,
      taskSpec: { command: row.task.command, args: [...row.task.args], env: {} },
      limits: { ...row.limits },
      provider: "substrate-probe-rail",
      model: "process",
      lifecycle,
      run,
      probe,
      report: (input) => options.registry.reportExecutionOutcome(input),
      retry: {
        maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
        backoffMs: options.backoffMs,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      readiness: {
        maxProbes: CORPUS_READINESS_POLICY.maxProbes,
        backoffMs: options.backoffMs,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      quarantineThreshold: CORPUS_QUARANTINE_THRESHOLD,
      now: () => Date.now(),
    });

    // The durable ledger evidence for THIS execution — the external
    // cross-check of the per-probe/per-attempt journal.
    const events = await ctx.port.execute<{ command: string; cause: string | null }>({
      sql: `SELECT command, cause FROM executions.execution_events WHERE execution_id = $1 ORDER BY sequence ASC`,
      parameters: [executionId],
    });
    const cause = (command: string, prefix: string): number =>
      events.rows.filter(
        (rowEvent) => rowEvent.command === command && (rowEvent.cause ?? "").startsWith(prefix),
      ).length;
    const journaled = cause("agent-action-recorded", "val-022-dispatch-attempt-");
    const probeJournal = cause("agent-action-recorded", "val-022-readiness-probe-");
    const sandboxAdmissions = events.rows.filter(
      (rowEvent) => rowEvent.command === "sandbox-admitted",
    ).length;
    const sandboxOutcomes = events.rows.filter(
      (rowEvent) => rowEvent.command === "sandbox-completed",
    ).length;
    const quarantines = events.rows.filter(
      (rowEvent) => rowEvent.command === "sandbox-denied",
    ).length;
    const planningDecisions = events.rows.filter(
      (rowEvent) => rowEvent.command === "plan" && rowEvent.cause === "planning-decision",
    ).length;
    const transitionCommands = events.rows
      .filter(
        (rowEvent) =>
          !rowEvent.command.startsWith("sandbox-") &&
          rowEvent.command !== "agent-action-recorded" &&
          rowEvent.cause !== "planning-decision",
      )
      .map((rowEvent) => rowEvent.command);

    // The honest outcome contract for every run.
    expect(result.terminal, `${row.rowId}#${executionIndex + 1} terminal`).toBe(
      groundTruth.expected.terminal,
    );
    expect(result.totalAttempts).toBe(groundTruth.expected.attempts);
    expect(result.probes.length).toBe(groundTruth.expected.readinessProbes);
    expect(result.finalSubstrateClass ?? null).toBe(groundTruth.expected.substrateClass);
    expect(result.finalPlatformClass ?? null).toBe(groundTruth.expected.platformClass);
    expect(result.quarantinedByThisExecution).toBe(groundTruth.expected.quarantined);
    const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(
      failedCriteria,
      `${row.rowId}#${executionIndex + 1} criteria: ${JSON.stringify(failedCriteria)}`,
    ).toEqual([]);
    // Journal exactly once per attempt + per probe — ledger-verified.
    expect(journaled).toBe(groundTruth.expected.attempts);
    expect(probeJournal).toBe(groundTruth.expected.readinessProbes);
    expect(sandboxAdmissions).toBe(groundTruth.expected.attempts);
    // Settled attempts journal exactly one sandbox-completed; lost
    // attempts journal none (the honest absence).
    const lostAttempts = result.attempts.filter(
      (record) => record.substrateClass === "sandbox-lost",
    ).length;
    expect(sandboxOutcomes).toBe(groundTruth.expected.attempts - lostAttempts);
    expect(quarantines).toBe(groundTruth.expected.quarantined ? 1 : 0);
    // The canonical transition order on the REAL ledger, with the
    // durable planning decision BEFORE the first probe/dispatch.
    expect(transitionCommands).toEqual([
      "create",
      "authorize",
      "plan",
      "queue",
      "start",
      "verify",
      groundTruth.expected.terminal === "COMPLETED" ? "pass" : "fail",
    ]);
    expect(planningDecisions).toBe(1);
    // The decision lands BEFORE the queue transition (raw event order).
    const decisionSequence = events.rows.findIndex(
      (rowEvent) => rowEvent.cause === "planning-decision",
    );
    const queueSequence = events.rows.findIndex((rowEvent) => rowEvent.command === "queue");
    expect(decisionSequence).toBeGreaterThan(-1);
    expect(queueSequence).toBeGreaterThan(decisionSequence);

    const appSettled = await appPromise;
    if (!appSettled.ok) {
      throw appSettled.error;
    }
    expect(validateHarnessEvidence(appSettled.outcome.evidence as never)).toEqual([]);
    // The application's assertions PASS on the honest outcome.
    expect(appSettled.outcome.passed, `${row.rowId}#${executionIndex + 1} app`).toBe(true);

    facts.push({
      rowId: row.rowId,
      execution: executionIndex + 1,
      terminal: result.terminal,
      substrateClass: result.finalSubstrateClass ?? null,
      platformClass: result.finalPlatformClass ?? null,
      attempts: result.totalAttempts,
      probes: result.probes.length,
      journaled,
      sandboxAdmissions,
      sandboxOutcomes,
      quarantined: result.quarantinedByThisExecution,
      latencyMs: result.totalDispatchLatencyMs,
      usage: result.usageMicroUsd === null ? "none-reported" : `${result.usageMicroUsd}uUSD`,
      appPassed: appSettled.outcome.passed,
    });
    console.info(
      `[VAL-022]   ${facts[facts.length - 1]?.rowId}#${executionIndex + 1} -> ${result.terminal} ` +
        `class=${result.finalSubstrateClass ?? "none"}/${result.finalPlatformClass ?? "none"} ` +
        `attempts=${result.totalAttempts} probes=${result.probes.length} ` +
        `journal=${journaled}+${probeJournal} sandbox=${sandboxAdmissions}+${sandboxOutcomes} ` +
        `latency=${result.totalDispatchLatencyMs}ms usage=${result.usageMicroUsd ?? "none"}`,
    );
  }
  return facts;
}

/** Build the submitRow closure over the app harness. */
function buildSubmitRow(
  world: ApiPgWorld,
  address: string,
  options: {
    readonly generateId: () => string;
    readonly completionTimeoutMs: number;
    readonly runSuffix: string;
  },
) {
  return (taskIndex: number) =>
    runSubstrateFailureApp({
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
        configuration: { suite: "val-022-substrate-readiness" },
      },
      runSuffix: options.runSuffix,
      taskIndex,
    }).then(
      (outcome) => ({ ok: true as const, outcome }),
      (error: unknown) => ({ ok: false as const, outcome: null, error }),
    );
}

definePgSuite("VAL-022 substrate readiness over the real platform path", (ctx) => {
  test("the offline fault-injection corpus drives substrate failure semantics over the REAL platform path", {
    timeout: 300_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const drivenExecutionIds = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      for (const row of OFFLINE_CORPUS_ROWS) {
        // One shared registry + fixture world per ROW: the registry
        // state carries across the row's executions (the quarantine
        // propagation contract).
        const registry = createInMemorySubstrateRegistry({
          threshold: CORPUS_QUARANTINE_THRESHOLD,
        });
        const facts = await driveRow(ctx, world, {
          row,
          transport: "offline-injection",
          registry,
          observationDeadlineMs: 250,
          backoffMs: 10,
          submitRow: buildSubmitRow(world, address, {
            generateId,
            completionTimeoutMs: 120_000,
            runSuffix: `it-${generateId().slice(-8)}`,
          }),
          generateId,
          drivenExecutionIds,
        });
        runFacts.push(...facts);
      }

      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      const failed = runFacts.filter((fact) => fact.terminal === "FAILED").length;
      console.info(
        `[VAL-022] OFFLINE corpus summary: ${completed} COMPLETED / ${failed} FAILED (both honest) ` +
          `of ${runFacts.length} driven executions; every attempt/probe journaled exactly once ` +
          `(ledger-verified sandbox-admitted/-completed/-denied + agent-action-recorded); readiness ` +
          `gated every dispatch; every lost sandbox journaled no outcome (fault-injection replays ` +
          `of the REAL substrate failure shapes; zero credentials, zero network).`,
      );
      expect(runFacts.length).toBe(
        OFFLINE_CORPUS_ROWS.reduce((sum, row) => sum + row.executions.length, 0),
      );
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL process substrate adapter drives its genuine classes honestly (the live crown)", {
    timeout: 240_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    const runFacts: RunFacts[] = [];

    // The NOT RUN boundaries of the live substrate: mid-execution LOSS
    // and OOM coercion cannot be produced on demand on a REAL healthy
    // substrate — the injection points are the adapter seams (the
    // offline corpus covers both shapes deterministically).
    console.warn(
      "[VAL-022] NOT RUN boundary (live): mid-execution sandbox-loss coercion — not " +
        "coercible on demand on the REAL process substrate; the offline rows " +
        "(sandbox-lost-*) replay the REAL never-settling shape at the adapter seam.",
    );
    console.warn(
      "[VAL-022] NOT RUN boundary (live): resource-exhaustion (OOM) coercion — not " +
        "coercible deterministically on the REAL process substrate; the offline " +
        "resource-exhausted-oom row replays the REAL container OOMKilled shape.",
    );

    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const drivenExecutionIds = new Set<string>();
    const notRun: string[] = [];

    try {
      for (const row of LIVE_CORPUS_ROWS) {
        if (!liveGateOpen(row, process.env)) {
          notRun.push(
            `${row.rowId} — gate closed (${row.liveGate?.envVars.join("+")} absent); ` +
              `requirement: ${row.liveGate?.requirement ?? "unknown"}`,
          );
          continue;
        }
        // Each live row drives its OWN substrate id + a fresh registry
        // window (the cross-execution quarantine carry is the offline
        // quarantine row's contract; the live rows verify the REAL
        // adapter path).
        const registry = createInMemorySubstrateRegistry({
          threshold: CORPUS_QUARANTINE_THRESHOLD,
        });
        const facts = await driveRow(ctx, world, {
          row,
          transport: "real-process-substrate",
          registry,
          observationDeadlineMs: 15_000,
          backoffMs: 100,
          submitRow: buildSubmitRow(world, address, {
            generateId,
            completionTimeoutMs: 180_000,
            runSuffix: `live-${generateId().slice(-8)}`,
          }),
          generateId,
          drivenExecutionIds,
        });
        runFacts.push(...facts);
      }

      for (const boundary of notRun) {
        console.warn(`[VAL-022] NOT RUN boundary: ${boundary}`);
      }
      if (runFacts.length > 0) {
        const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
        const failed = runFacts.filter((fact) => fact.terminal === "FAILED").length;
        console.info(
          `[VAL-022] LIVE substrate summary: ${completed} COMPLETED / ${failed} FAILED (both honest) ` +
            `of ${runFacts.length} driven live rows over the REAL process substrate adapter ` +
            `(REAL readiness probes, REAL isolated-process dispatches, the REAL admitted-deadline ` +
            `SIGKILL, the REAL exit-code fold).`,
        );
      }
      // With the crown gate open, at least one REAL live row drove
      // (never an all-NOT-RUN silent pass inside the open suite).
      expect(runFacts.length).toBeGreaterThan(0);
    } finally {
      await world.server.app.close();
    }
  });
});
