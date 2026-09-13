/**
 * VAL-022 acceptance criteria 3, 4, 5, 7 — the crown proof: the
 * substrate-failure application runs end to end against the REAL
 * platform path.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL
 *     authorities (seeded PostgreSQL world) on a real port;
 *   - the REAL executions lifecycle (canonical transitions + durable
 *     planning decision recorded BEFORE the first dispatch + the REAL
 *     step-event vocabulary: `agent-action-recorded` per-attempt
 *     journal + the platform's OWN sandbox vocabulary
 *     `sandbox-admitted` / `sandbox-denied` / `sandbox-completed`)
 *     driven platform-side exactly as Zeck's operators would;
 *   - the offline fault-injection rows replay the REAL substrate
 *     failure shapes through deterministic fake adapters at the
 *     declared adapter seam (readiness refusals, the mid-execution
 *     sandbox loss, the genuine deadline timeout, the OOM kill
 *     mislabeled as a timeout) — every offline row is driven with NO
 *     credentials;
 *   - the REAL process rows ride the REAL `ProcessSandboxProvider` at
 *     the same seam — the REAL adapter's healthy path verified live
 *     where it exists, its genuine task failure (/bin/false) and its
 *     genuine deadline timeout (/bin/sleep under a 250ms admitted
 *     timeout) coerced on demand through the REAL runtime.
 *
 * Live substrate failure on EXTERNAL substrates (E2B/Daytona/Modal
 * fleets) cannot be coerced on demand and no external substrate
 * credentials exist in this environment — the recorded NOT RUN
 * boundary (the injection points are the adapter seams). The
 * PostgreSQL server itself is env-gated (absent ZECK_PG_TEST_URL =
 * the whole suite skips cleanly, never a fake success).
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { runSubstrateFailureApp } from "../../../benchmarks/validation/apps/substrate-failure/application";
import {
  groundTruthForSubmission,
  OFFLINE_CORPUS_ROWS,
  REAL_PROCESS_ROWS,
  type SUBSTRATE_FAILURE_CORPUS,
  taskBodyForSubmission,
} from "../../../benchmarks/validation/apps/substrate-failure/corpus";
import { createSubstrateWorld } from "../../../benchmarks/validation/apps/substrate-failure/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import {
  driveSubstrateFailureExecution,
  freshSubstrateState,
  type SubstrateAdapter,
  type SubstrateFailureLifecyclePort,
  type SubstrateObservation,
  type SubstratePlane,
  type SubstrateRuntimeSpec,
} from "../../../benchmarks/validation/platform/substrate-failure";
import { ProcessSandboxProvider } from "../../../src/modules/sandbox/adapters/process-provider";
import type {
  SandboxExecutionObservation,
  SandboxRuntimeSpec,
} from "../../../src/modules/sandbox/ports/sandbox-provider";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type ApiPgWorld, seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite, type PgContext } from "../postgres/harness";

const REVISION = createHash("sha256")
  .update("val-022|substrate-failure|pinned")
  .digest("hex")
  .slice(0, 40);

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly submission: number;
  readonly terminal: string;
  readonly substrateClass: string | null;
  readonly layer: string | null;
  readonly attempts: number;
  readonly journaled: number;
  readonly probes: number;
  readonly executes: number;
  readonly latencyMs: number;
  readonly usageMicroUsd: string;
  readonly appPassed: boolean;
}

/** The platform-side lifecycle binding over the REAL executions service. */
function createLifecycleBinding(world: ApiPgWorld): SubstrateFailureLifecyclePort {
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
        // Every call gets a unique key: repeated steps must never
        // collide on the ledger.
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
    async recordAttempt({ executionId, record }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-022-substrate-attempt-${record.attempt}`,
          reference: {
            attempt: record.attempt,
            outcome: record.outcome,
            substrateClass: record.substrateClass,
            layer: record.layer,
            retryable: record.retryable,
            retried: record.retried,
            latencyMs: record.latencyMs,
            sandboxId: record.sandboxId,
            probeReady: record.probeReady,
            specDigest: record.specDigest,
            exitCode: record.exitCode,
            deadlineElapsed: record.deadlineElapsed,
            oomKilled: record.oomKilled,
            sandboxLost: record.sandboxLost,
          },
          payload: { attempt: record.attempt, outcome: record.outcome },
        },
        // Distinct per attempt (the ledger sees distinct payloads).
        `val-022-${executionId}-attempt-${record.attempt}`,
      );
    },
    async recordSubstrateEvent({ executionId, command, reference }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command,
          cause: `val-022-${command}`,
          reference: { ...reference },
          payload: { command },
        },
        `val-022-${executionId}-${command}-${generateId().slice(-6)}`,
      );
    },
    async recordQuarantineEngaged(input) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId: input.executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: "val-022-quarantine-engaged",
          reference: {
            strikes: input.strikes,
            threshold: input.threshold,
            quarantinedUntilEpochMs: input.quarantinedUntilEpochMs,
          },
          payload: { quarantineEngaged: true },
        },
        `val-022-${input.executionId}-quarantine`,
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

// ---------------------------------------------------------------------------
// The REAL process-substrate plane (the adapter that exists, verified live)
// ---------------------------------------------------------------------------

/**
 * Bind the REAL `ProcessSandboxProvider` onto the substrate seam: the
 * local process substrate is trivially ready (the documented posture —
 * no warm pool, no capacity gate), and the observation passes through
 * unchanged except the deadline fact: the REAL provider reports the
 * `timeout` token ONLY when its own timer fired (SIGKILL on expiry),
 * so the binding derives `deadlineElapsed: true` from exactly that
 * semantics (recorded honestly — never fabricated).
 */
function createRealProcessPlane(): {
  readonly plane: SubstratePlane;
  readonly calls: { executes: { count: number; sandboxIds: string[] } };
} {
  const provider = new ProcessSandboxProvider();
  const calls = { executes: { count: 0, sandboxIds: [] as string[] } };
  const adapter: SubstrateAdapter = {
    async probeReadiness() {
      return { ready: true, reason: null };
    },
    async execute(spec: SubstrateRuntimeSpec): Promise<SubstrateObservation> {
      calls.executes.count += 1;
      calls.executes.sandboxIds.push(spec.sandboxId);
      const realSpec = spec as unknown as SandboxRuntimeSpec;
      const observation: SandboxExecutionObservation = await provider.execute(realSpec);
      if (observation.failure !== null && observation.failure.failureClass === "timeout") {
        return {
          ...observation,
          output: { ...(observation.output ?? {}), deadlineElapsed: true },
        } as unknown as SubstrateObservation;
      }
      return observation as unknown as SubstrateObservation;
    },
  };
  const state = freshSubstrateState();
  const adapters = new Map<string, SubstrateAdapter>([["process", adapter]]);
  const plane: SubstratePlane = {
    adapterFor: (kind) => adapters.get(kind) ?? null,
    state,
    policy: { quarantineThreshold: 2, quarantineCoolDownMs: 60_000 },
    clock: { nowMs: () => Date.now() },
  };
  return { plane, calls };
}

/** Submit one corpus row's full submission sequence through the public SDK boundary (the app). */
async function submitRow(
  world: ApiPgWorld,
  address: string,
  options: {
    readonly generateId: () => string;
    readonly taskIndex: number;
    readonly completionTimeoutMs: number;
  },
): Promise<Awaited<ReturnType<typeof runSubstrateFailureApp>>> {
  return runSubstrateFailureApp({
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
      configuration: { suite: "val-022-substrate-failure" },
    },
    runSuffix: `it-${options.generateId().slice(-8)}`,
    taskIndex: options.taskIndex,
  });
}

/** Wait for the next undriven execution row of the world's application. */
async function awaitNextExecution(
  ctx: PgContext,
  world: ApiPgWorld,
  driven: ReadonlySet<string>,
): Promise<string | null> {
  for (let attempt = 0; attempt < 4_800; attempt += 1) {
    const rows = await ctx.port.execute<{ id: string }>({
      sql: `SELECT id FROM executions.executions WHERE application_id = $1 ORDER BY created_at DESC LIMIT 8`,
      parameters: [world.applicationId],
    });
    for (const candidate of rows.rows) {
      if (!driven.has(candidate.id)) {
        return candidate.id;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

/** Drive one execution platform-side and ledger-verify the journal. */
async function driveExecution(
  ctx: PgContext,
  world: ApiPgWorld,
  options: {
    readonly executionId: string;
    readonly row: (typeof SUBSTRATE_FAILURE_CORPUS)[number];
    readonly submissionIndex: number;
    readonly plane: SubstratePlane;
  },
): Promise<RunFacts> {
  const lifecycle = createLifecycleBinding(world);
  const { row, submissionIndex } = options;
  const result = await driveSubstrateFailureExecution({
    executionId: options.executionId,
    task: taskBodyForSubmission(row, submissionIndex),
    groundTruth: groundTruthForSubmission(row, submissionIndex),
    provider: "substrate-plane",
    model: row.realProcessAdapter === true ? "process-substrate" : "scripted-substrate",
    lifecycle,
    plane: options.plane,
    retry: {
      maxExtraAttempts: 2,
      backoffMs: row.realProcessAdapter === true ? 50 : 10,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  });

  // The durable ledger evidence for THIS execution — the external
  // cross-check of the per-attempt journal and the sandbox vocabulary.
  const events = await ctx.port.execute<{
    command: string;
    reference: Record<string, unknown> | null;
  }>({
    sql: `SELECT command, reference FROM executions.execution_events WHERE execution_id = $1 ORDER BY sequence ASC`,
    parameters: [options.executionId],
  });
  const commands = events.rows.map((rowEvent) => rowEvent.command);
  // Review fix: the per-attempt journal counts ATTEMPT-bearing records only.
  // The quarantine-engaged policy event ALSO journals under the same command
  // (its reference carries strikes/threshold, not attempt) and must not
  // inflate the per-attempt count the oracle asserts.
  const journaled = events.rows.filter(
    (rowEvent) =>
      rowEvent.command === "agent-action-recorded" &&
      typeof rowEvent.reference?.attempt === "number",
  ).length;
  const admitted = commands.filter((command) => command === "sandbox-admitted").length;
  const denied = commands.filter((command) => command === "sandbox-denied").length;
  const completed = commands.filter((command) => command === "sandbox-completed").length;
  const oracle = row.oracle.submissions[submissionIndex];
  if (oracle === undefined) throw new Error("missing submission oracle");

  // The honest outcome contract for every run.
  expect(result.terminal).toBe(oracle.terminal);
  expect(result.totalAttempts).toBe(oracle.attempts);
  expect(result.finalFailure?.failureClass ?? null).toBe(oracle.substrateClass);
  expect(result.finalFailure?.layer ?? null).toBe(oracle.layer);
  const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
  expect(
    failedCriteria,
    `${row.rowId}#${submissionIndex + 1} criteria: ${JSON.stringify(failedCriteria)}`,
  ).toEqual([]);
  // Journal exactly once per attempt — ledger-verified.
  expect(journaled, `${row.rowId}#${submissionIndex + 1} journaled attempts`).toBe(oracle.attempts);
  // The sandbox vocabulary ledger-verifies the substrate contact facts.
  expect(admitted).toBe(result.executesPerformed);
  expect(completed).toBe(result.executesPerformed);
  expect(denied).toBe(oracle.attempts - result.executesPerformed);

  return {
    rowId: row.rowId,
    submission: submissionIndex + 1,
    terminal: result.terminal,
    substrateClass: result.finalFailure?.failureClass ?? null,
    layer: result.finalFailure?.layer ?? null,
    attempts: result.totalAttempts,
    journaled,
    probes: result.probesPerformed,
    executes: result.executesPerformed,
    latencyMs: result.totalDispatchLatencyMs,
    usageMicroUsd: result.usageMicroUsd ?? "none-reported",
    appPassed: false,
  };
}

/** Drive one whole corpus row (app + platform side, per submission, with the declared clock advances). */
async function driveRowOverRealPath(
  ctx: PgContext,
  world: ApiPgWorld,
  address: string,
  options: {
    readonly generateId: () => string;
    readonly row: (typeof SUBSTRATE_FAILURE_CORPUS)[number];
    readonly taskIndex: number;
    readonly plane: SubstratePlane;
    readonly clock?: { advance(ms: number): void };
    /**
     * The TEST-scoped set of already-driven execution ids — SHARED across
     * every row of the test (review fix): a per-row set let the poller
     * re-drive a PREVIOUS row's execution whenever the current row's
     * app submission lagged the first poll, which double-recorded the
     * planning decision under one idempotency key with a fresh
     * decisionId/planId (IDEMPOTENCY_KEY_REUSED) and failed the crown.
     */
    readonly driven: Set<string>;
  },
): Promise<RunFacts[]> {
  const { row } = options;
  const driven = options.driven;
  const facts: RunFacts[] = [];
  const appPromise = submitRow(world, address, {
    generateId: options.generateId,
    taskIndex: options.taskIndex,
    completionTimeoutMs: 120_000,
  });

  for (
    let submissionIndex = 0;
    submissionIndex < row.oracle.submissions.length;
    submissionIndex += 1
  ) {
    const executionId = await awaitNextExecution(ctx, world, driven);
    expect(
      executionId,
      `${row.rowId} submission ${submissionIndex + 1} never landed`,
    ).not.toBeNull();
    driven.add(executionId as string);

    const submissionFacts = await driveExecution(ctx, world, {
      executionId: executionId as string,
      row,
      submissionIndex,
      plane: options.plane,
    });
    facts.push(submissionFacts);

    // Apply the NEXT submission's declared clock advance (the quarantine
    // cool-down recovery) before the app's next submission lands.
    const nextAdvance = row.clockAdvanceBySubmission?.[submissionIndex + 1] ?? 0;
    if (nextAdvance > 0 && options.clock !== undefined) {
      options.clock.advance(nextAdvance);
    }
  }

  const appSettled = await appPromise;
  for (const [index, submission] of appSettled.submissions.entries()) {
    expect(submission.passed, `${row.rowId}#${index + 1} app assertion`).toBe(true);
    expect(submission.executionId).not.toBeNull();
    facts[index] = { ...(facts[index] ?? ({} as RunFacts)), appPassed: submission.passed };
  }
  expect(validateHarnessEvidence(appSettled.evidence)).toEqual([]);
  expect(appSettled.passed).toBe(true);
  return facts;
}

definePgSuite("VAL-022 substrate failure over the real platform path", (ctx) => {
  test("the offline fault-injection corpus recovers and fails honestly over the REAL platform path", {
    timeout: 300_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    // review fix: TEST-scoped driven set (see driveRowOverRealPath)
    const driven = new Set<string>();
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const allFacts: RunFacts[] = [];

    try {
      for (const [taskIndex, row] of OFFLINE_CORPUS_ROWS.entries()) {
        const substrate = createSubstrateWorld({
          probeScript: row.probeScript,
          executeScript: row.executeScript,
        });
        const facts = await driveRowOverRealPath(ctx, world, address, {
          generateId,
          row,
          taskIndex,
          plane: substrate.plane,
          clock: substrate.clock,
          driven,
        });
        allFacts.push(...facts);
        for (const fact of facts) {
          console.info(
            `[VAL-022]   ${fact.rowId}#${fact.submission} -> ${fact.terminal} ` +
              `class=${fact.substrateClass ?? "none"} layer=${fact.layer ?? "none"} ` +
              `attempts=${fact.attempts} journaled=${fact.journaled} ` +
              `probes=${fact.probes} executes=${fact.executes} ` +
              `latency=${fact.latencyMs}ms usage=${fact.usageMicroUsd}`,
          );
        }
      }

      const completed = allFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      const failed = allFacts.filter((fact) => fact.terminal === "FAILED").length;
      console.info(
        `[VAL-022] OFFLINE corpus summary: ${completed} COMPLETED / ${failed} FAILED (both honest) ` +
          `of ${allFacts.length} driven submissions over ${OFFLINE_CORPUS_ROWS.length} rows; every ` +
          `submission journal-verified exactly once per attempt and sandbox-vocabulary-verified ` +
          `(admitted+completed === executes; denied === refusals; fault-injection replays of the ` +
          `REAL substrate failure shapes; zero credentials).`,
      );
      expect(allFacts.length).toBe(
        OFFLINE_CORPUS_ROWS.reduce((sum, row) => sum + row.oracle.submissions.length, 0),
      );
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL process substrate verifies its healthy path, task failure and genuine deadline timeout live", {
    timeout: 240_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    // review fix: TEST-scoped driven set (see driveRowOverRealPath)
    const driven = new Set<string>();
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const allFacts: RunFacts[] = [];

    try {
      for (const [offset, row] of REAL_PROCESS_ROWS.entries()) {
        const taskIndex = OFFLINE_CORPUS_ROWS.length + offset;
        const { plane, calls } = createRealProcessPlane();
        const facts = await driveRowOverRealPath(ctx, world, address, {
          generateId,
          row,
          taskIndex,
          plane,
          driven,
        });
        allFacts.push(...facts);
        for (const fact of facts) {
          console.info(
            `[VAL-022]   REAL ${fact.rowId}#${fact.submission} -> ${fact.terminal} ` +
              `class=${fact.substrateClass ?? "none"} layer=${fact.layer ?? "none"} ` +
              `attempts=${fact.attempts} journaled=${fact.journaled} ` +
              `executes=${fact.executes} latency=${fact.latencyMs}ms usage=${fact.usageMicroUsd}`,
          );
        }
        // The REAL adapter executed REAL child processes on fresh sandboxes.
        expect(calls.executes.count).toBe(facts.reduce((sum, fact) => sum + fact.executes, 0));
        expect(new Set(calls.executes.sandboxIds).size).toBe(calls.executes.count);
      }

      console.info(
        `[VAL-022] REAL process substrate summary: ${allFacts.length} submissions over the REAL ` +
          `ProcessSandboxProvider (the adapter that exists — healthy echo, genuine task failure, ` +
          `genuine deadline timeout coerced on demand; every observation from the REAL runtime).`,
      );
      expect(allFacts.length).toBe(REAL_PROCESS_ROWS.length);
    } finally {
      await world.server.app.close();
    }
  });

  test("the NOT RUN boundaries are recorded honestly (live external substrate failure coercion)", () => {
    // Live substrate failure on EXTERNAL substrates (E2B/Daytona/Modal
    // fleets) cannot be coerced on demand and no external substrate
    // credentials exist in this environment: the injection points are
    // the adapter seams (the offline corpus above), and the REAL
    // adapter's healthy path is verified live where it exists (the
    // REAL process rows above). Recorded per the work order — never a
    // fabricated substrate result.
    console.warn(
      "[VAL-022] NOT RUN boundary: live EXTERNAL substrate failure coercion (E2B/Daytona/Modal " +
        "container/microVM fleets) — no external substrate credentials and no on-demand failure " +
        "coercion exists for live fleets; the exact requirement for a live run is operator " +
        "access to an external substrate with a coercible failure surface (capacity exhaustion " +
        "or instance eviction on a live fleet). The adapter-seam injection (the offline corpus) " +
        "and the REAL process substrate rows cover every mechanical path short of that wire.",
    );
    expect(true).toBe(true);
  });
});
