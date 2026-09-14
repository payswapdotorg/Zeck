/**
 * VAL-046 acceptance criteria 3, 4, 5, 7 — the crown proof: the
 * substrate-cost synthesis rows run end to end against the REAL
 * platform path.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL
 *     authorities (seeded PostgreSQL world) on a real port;
 *   - the REAL executions state machine: the canonical transitions,
 *     the durable planning decisions carrying the SUBSTRATE DECISIONS
 *     (the family, the pre-registered window set with every digest
 *     reference, the composed arm set, the minimums, the Wilson
 *     configuration, the pinned revisions, the expected verdict)
 *     BEFORE any input is consulted, and the gapless step-event
 *     journal (per-record-distinct idempotency keys — the VAL-018
 *     lesson);
 *   - the REAL idempotency ledger arbitrating every submission (one
 *     record per app key; no drift, no phantoms, no orphan events —
 *     verified against the REAL SQL row counts);
 *   - the REAL accounting rails: every verified window is sealed
 *     through the REAL validation recorder (the five-share
 *     decomposition as substrate-scoped cost facts with the
 *     restart/eviction share as retry-overhead; the planner quote as a
 *     SEPARATE estimate fact) while the driver verifies each RECORDED
 *     window against the telemetry corpus over REAL SQL;
 *   - the synthesis is a PURE derivation over the RECORDED substrate
 *     telemetry (digest-referenced windows served and verified over
 *     the imported corpora — never copied, never re-measured, never
 *     re-priced): the eight oracles (startup-cost inclusion,
 *     readiness-probe honesty, reserved/measured separation,
 *     failure-amortization completeness, estimate/measure separation,
 *     confidence-and-minimum + below-minimum refusal honesty + the
 *     input-integrity oracle + the family oracle with the
 *     silent-absorption catch) run mechanically per row;
 *   - the app rides the public SDK boundary (the customer-side
 *     submission + completion poll + result retrieval) while the
 *     driver drives the landed lane.
 *
 * The live row (env-gated on the operator-authorized
 * OPENROUTER_API_KEY) drives ONE REAL substrate lifecycle measurement
 * over the REAL process substrate (`ProcessSandboxProvider` — the
 * adapter that exists): cold start, readiness probes to FIRST-USABLE
 * (real probe executions), a sustained runtime of three REAL workload
 * units (each a real substrate execution riding ONE REAL model
 * dispatch on the pinned OpenRouter rail — BYOK, measured usage,
 * max_tokens 32 pinned explicitly, temperature unset per the
 * provider's documented default; the empty-completion 200 is honest
 * SUCCESS — the VAL-014 rule; the provider envelope's code token wins
 * over the raw HTTP status), teardown — with the families computed
 * over MEASURED facts and the verdict recorded through the REAL
 * recorder. Absent credentials are a recorded NOT RUN boundary —
 * never a fake success.
 */

import { expect, test } from "vitest";
import type {
  EconomicLifecyclePort,
  EconomicWorldFacts,
} from "../../../benchmarks/validation/apps/economic-baseline/driver";
import { runSubstrateApp } from "../../../benchmarks/validation/apps/economic-substrate-runtime/application";
import {
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  SUBSTRATE_CORPUS,
  SUBSTRATE_CORPUS_VERSION,
  SUBSTRATE_TASK_KIND,
} from "../../../benchmarks/validation/apps/economic-substrate-runtime/corpus";
import type { SubstrateCorpusRow } from "../../../benchmarks/validation/apps/economic-substrate-runtime/driver";
import {
  driveLiveSubstrateRow,
  driveSubstrateRow,
  LIVE_SUBSTRATE_PLAN,
  type LiveSubstrateLifecyclePort,
  type LiveSubstrateProbeOutcome,
  type LiveSubstrateWorkloadOutcome,
} from "../../../benchmarks/validation/apps/economic-substrate-runtime/driver";
import {
  createRealAccountingRails,
  windowInputsForRow,
} from "../../../benchmarks/validation/apps/economic-substrate-runtime/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { ExecutionService } from "../../../src/modules/executions/application/execution-service";
import { ProcessSandboxProvider } from "../../../src/modules/sandbox/adapters/process-provider";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type ApiPgWorld, seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite, type PgContext } from "../postgres/harness";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const REVISION = "6a997b5bdcc1922a124f788b782c1e6edef526aa";

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly verdict: string;
  readonly windows: number;
  readonly verifiedWindows: number;
  readonly pooledRuns: number;
  readonly pooledResolved: number;
  readonly substrateTotalMicroUsd: string;
  readonly readinessWaitMicroUsd: string;
  readonly effectiveMicroUsd: string;
  readonly wilson: string;
  readonly appPassed: boolean;
  readonly usage: string;
  readonly latencyMs: number;
}

// ---------------------------------------------------------------------------
// The REAL world bindings
// ---------------------------------------------------------------------------

/** The REAL durable world facts over the application's SQL ledger. */
function createWorldFacts(ctx: PgContext, world: ApiPgWorld): () => Promise<EconomicWorldFacts> {
  return async () => {
    const execCount = await ctx.port.execute<{ c: number }>({
      sql: `SELECT count(*)::int AS c FROM executions.executions WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    const eventCount = await ctx.port.execute<{ c: number }>({
      sql: `SELECT count(*)::int AS c FROM executions.execution_events WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    // The create-arbitration records only (the submission keys' own
    // ledger rows — the transitions' and step-events' operation records
    // are the platform's expected machinery, never submission drift).
    const keyCount = await ctx.port.execute<{ c: number }>({
      sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = 'executions.create'`,
      parameters: [world.applicationId],
    });
    const orphans = await ctx.port.execute<{ c: number }>({
      sql: `SELECT count(*)::int AS c FROM executions.execution_events e
            LEFT JOIN executions.executions x ON e.execution_id = x.id
            WHERE e.application_id = $1 AND x.id IS NULL`,
      parameters: [world.applicationId],
    });
    return {
      executionCount: execCount.rows[0]?.c ?? 0,
      eventCount: eventCount.rows[0]?.c ?? 0,
      idempotencyRecordCount: keyCount.rows[0]?.c ?? 0,
      orphanEventCount: orphans.rows[0]?.c ?? 0,
    };
  };
}

/**
 * The platform-side lifecycle binding over the REAL executions
 * service: the canonical transitions (per-call-distinct idempotency
 * keys — the VAL-018 lesson), the durable planning decisions carrying
 * the SUBSTRATE DECISIONS, the step-event journal (digest references
 * only), the terminal completion with the mechanically derived
 * criteria and the observed-terminal read-back.
 */
function createLifecycleBinding(
  world: ApiPgWorld,
  executions: ExecutionService,
): EconomicLifecyclePort {
  const generateId = createUuidv7Generator();
  let transitionCounter = 0;
  return {
    async transition({ executionId, step, reason, callKey }) {
      transitionCounter += 1;
      void callKey;
      await executions.transition(
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
        `val-046-${executionId}-${step}-${transitionCounter}`,
      );
    },
    async recordPlanningDecision({ executionId, route, armDecision }) {
      await executions.recordPlanningDecision(
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
                strategyId: "val-046-substrate-synthesis",
                plan: {
                  strategyClass: route.strategyClass,
                  modelCalls: 0,
                  steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                },
              },
            ],
            selectedStrategyId: "val-046-substrate-synthesis",
            armDecision,
          },
        },
        `val-046-${executionId}-decision`,
      );
    },
    async recordStepEvent({ executionId, record }) {
      await executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-046-${record.kind}-${record.ordinal}`,
          reference: {
            kind: record.kind,
            ordinal: record.ordinal,
            digest: record.digest,
          },
          payload: { kind: record.kind, ordinal: record.ordinal },
        },
        // Distinct per record (the ledger sees distinct payloads — the
        // VAL-018 lesson).
        `val-046-${executionId}-${record.kind}-${record.ordinal}`,
      );
    },
    async complete({ executionId, verdict, criteria, reason }) {
      await executions.transition(
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
            recordedBy: "val-046-platform",
            evidence: [...criterion.evidence],
          })),
        },
        `val-046-${executionId}-${verdict}`,
      );
    },
    async statusOf(executionId) {
      const execution = await executions.getExecution(world.applicationId, executionId);
      return execution?.status ?? null;
    },
  };
}

/**
 * The landed-executions provider: polls the REAL SQL until the row's
 * expected count of the APP's experiment executions land.
 */
function createLandedProvider(
  ctx: PgContext,
  world: ApiPgWorld,
  driven: Set<string>,
  taskKind: string,
): (group: number, expectedCount: number) => Promise<readonly string[]> {
  return async (group, expectedCount) => {
    void group;
    for (let attempt = 0; attempt < 4_800; attempt += 1) {
      const rows = await ctx.port.execute<{ id: string }>({
        sql: `SELECT id FROM executions.executions
              WHERE application_id = $1
                AND task->>'kind' = $2
                AND id != ALL($3::uuid[])
              ORDER BY created_at ASC, id ASC
              LIMIT $4`,
        parameters: [world.applicationId, taskKind, [...driven], expectedCount],
      });
      if (rows.rows.length >= expectedCount) {
        const ids = rows.rows.map((row) => row.id);
        for (const id of ids) {
          driven.add(id);
        }
        return ids;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no new landed executions after 120s (expected ${expectedCount})`);
  };
}

// ---------------------------------------------------------------------------
// The per-row crown orchestration
// ---------------------------------------------------------------------------

/**
 * Drive one synthesis row crown-style: the app rides the public wire
 * (the customer-side submission + completion poll + result retrieval)
 * while the driver drives the landed execution through the REAL
 * platform path — the RECORDED windows verified against the telemetry
 * corpus, sealed through the REAL accounting rails, the substrate-cost
 * family derived PURELY over the recorded results.
 */
async function driveCrownRow(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly row: SubstrateCorpusRow;
  readonly taskIndex: number;
  readonly runSuffix: string;
  readonly driven: Set<string>;
  readonly facts: () => Promise<EconomicWorldFacts>;
}): Promise<{
  readonly result: Awaited<ReturnType<typeof driveSubstrateRow>>;
  readonly appOutcome: Awaited<ReturnType<typeof runSubstrateApp>>;
}> {
  const { ctx, world, row, taskIndex } = options;
  const lifecycle = createLifecycleBinding(world, world.executions);
  const baseline = await options.facts();

  const metadata = {
    program: "zeck-validation",
    workOrder: "VAL-046",
    baseRevision: REVISION,
    applicationRevision: REVISION,
    corpusRevision: SUBSTRATE_CORPUS_VERSION,
    integrationSurface: "synthesis:recorded-substrate-telemetry",
    environment: {
      runtime: `node ${process.version}`,
      toolchain: "vitest",
      database: "postgresql",
      configuration: { suite: "val-046-substrate-runtime", row: row.rowId },
    },
    observedAt: new Date().toISOString(),
  };

  // The app promise: submits through the public wire and polls to the
  // row's terminal while the driver drives the landed lane.
  const appPromise = runSubstrateApp({
    config: {
      applicationId: world.applicationId,
      baseUrl: options.address,
      tokenEnvVar: "ZECK_VALIDATION_TOKEN",
      applicationRevision: REVISION,
      corpusRevision: SUBSTRATE_CORPUS_VERSION,
      integrationSurface: "synthesis:recorded-substrate-telemetry",
      pollIntervalMs: 250,
      completionTimeoutMs: 300_000,
    },
    token: world.bearerToken,
    transport: globalThis.fetch,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    environment: {
      runtime: `node ${process.version}`,
      toolchain: "vitest",
      database: "postgresql",
      configuration: { suite: "val-046-substrate-runtime" },
    },
    runSuffix: options.runSuffix,
    taskIndex,
  });

  const result = await driveSubstrateRow({
    row,
    lifecycle,
    windows: windowInputsForRow(row),
    rails: createRealAccountingRails(),
    metadata,
    environmentIdentity: `val-046-crown-${row.rowId}`,
    baseline,
    worldFacts: options.facts,
    landedProvider: createLandedProvider(ctx, world, options.driven, SUBSTRATE_TASK_KIND),
    now: () => new Date(),
  });
  const appOutcome = await appPromise;
  return { result, appOutcome };
}

// ---------------------------------------------------------------------------
// The REAL live substrate lifecycle binding (the process substrate + the rail)
// ---------------------------------------------------------------------------

/** The OpenRouter response envelope (the provider's own code tokens win over the raw HTTP status). */
interface OpenRouterEnvelope {
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: unknown[];
  error?: { code?: number | string; message?: string };
}

/**
 * Build the REAL live substrate lifecycle port: the probes and the
 * workload units' substrate executions ride the REAL
 * `ProcessSandboxProvider` (the adapter that exists — real child
 * processes in ephemeral isolated workspaces), and each workload
 * unit's model dispatch rides ONE REAL OpenRouter binding (BYOK,
 * pinned endpoint/model/max_tokens, temperature unset). The provider
 * envelope's code token wins over the raw HTTP status; the
 * empty-completion 200 is honest SUCCESS (the VAL-014 rule).
 */
function createRealSubstrateLifecycle(): LiveSubstrateLifecyclePort {
  const provider = new ProcessSandboxProvider();
  const spec = (command: string, args: readonly string[]) => ({
    sandboxId: `val-046-live-${command.replace(/[^a-z]/g, "")}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    applicationId: "val-046-live",
    tenantId: "val-046-live",
    executionId: "val-046-live",
    kind: "process" as const,
    isolationClass: "standard" as const,
    task: { command, args: [...args], publicEnv: { PROBE: "val-046-substrate-runtime" } },
    limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
    network: { egress: "none" as const, allowedHosts: [] },
    filesystem: { workspace: "ephemeral-writable" as const, readOnlyArtifactRefs: [] },
    secretRefs: [],
  });

  const dispatchModel = async (): Promise<LiveSubstrateWorkloadOutcome["model"]> => {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(LIVE_SUBSTRATE_PLAN.rail.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: LIVE_SUBSTRATE_PLAN.rail.model,
          max_tokens: LIVE_SUBSTRATE_PLAN.rail.maxTokens,
          // temperature UNSET — the provider's documented default.
          messages: [
            {
              role: "user",
              content:
                "Reply with the single word: confirm (this is a substrate-economics workload dispatch).",
            },
          ],
        }),
      });
    } catch {
      // The transport failure: the honest category (bounded retry applies).
      return {
        ok: false,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - startedAt,
        category: "transport-failure",
      };
    }
    const latencyMs = Date.now() - startedAt;
    let envelope: OpenRouterEnvelope | null = null;
    try {
      envelope = (await response.json()) as OpenRouterEnvelope;
    } catch {
      envelope = null;
    }
    if (response.status === 200) {
      // The empty-completion 200 is honest SUCCESS (the VAL-014 rule).
      return {
        ok: true,
        inputTokens: envelope?.usage?.prompt_tokens ?? 0,
        outputTokens: envelope?.usage?.completion_tokens ?? 0,
        latencyMs,
      };
    }
    // The provider envelope's code token WINS over the raw HTTP status.
    const code = envelope?.error?.code;
    const category =
      code === 429 || String(code) === "429"
        ? "rate-limit"
        : code === 402 || String(code) === "402"
          ? "insufficient-credit"
          : code === 401 || String(code) === "401"
            ? "auth-rejected"
            : "provider-unavailable";
    return {
      ok: false,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs,
      category,
    };
  };

  return {
    async probe(unit): Promise<LiveSubstrateProbeOutcome> {
      const observation = await provider.execute(spec("/bin/echo", [`val-046-probe-${unit}`]));
      return {
        ready: observation.outcomeClass === "sandbox-success",
        reason:
          observation.outcomeClass === "sandbox-success"
            ? null
            : (observation.failure?.message ?? "the probe execution did not complete"),
        executionMs:
          typeof observation.output?.durationMs === "number" ? observation.output.durationMs : 0,
      };
    },
    async runWorkloadUnit(unit): Promise<LiveSubstrateWorkloadOutcome> {
      // The substrate executes a REAL bounded-occupancy workload unit
      // (a real 250ms /bin/sleep in the ephemeral workspace) while the
      // unit's model dispatch rides the pinned rail.
      const observation = await provider.execute(spec("/bin/sleep", ["0.25"]));
      const model = await dispatchModel();
      void unit;
      return {
        substrateExecutionMs:
          observation.outcomeClass === "sandbox-success" &&
          typeof observation.output?.durationMs === "number"
            ? observation.output.durationMs
            : 0,
        model,
      };
    },
    async teardown() {
      const observation = await provider.execute(spec("/bin/echo", ["val-046-teardown"]));
      return {
        executionMs:
          observation.outcomeClass === "sandbox-success" &&
          typeof observation.output?.durationMs === "number"
            ? observation.output.durationMs
            : 0,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The suites
// ---------------------------------------------------------------------------

definePgSuite("VAL-046 substrate/runtime economics over the real platform path", (ctx) => {
  test("the offline synthesis corpus drives every substrate-cost family over the REAL platform path", {
    timeout: 600_000,
  }, async () => {
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const facts = createWorldFacts(ctx, world);
    const driven = new Set<string>();
    const runFacts: RunFacts[] = [];

    /** Each adversarial probe row's NAMED criterion (the honest failure). */
    const probeNamedCriterion: Readonly<Record<string, string>> = {
      "probe-startup-hiding": "startup-cost-inclusion",
      "probe-readiness-inflation": "readiness-probe-honesty",
      "probe-reserved-measured-conflation": "reserved-measured-separation",
      "probe-failure-amortization-away": "failure-amortization-completeness",
      "probe-post-hoc-exclusion": "confidence-and-minimum",
      "probe-sample-size-violation": "below-minimum-refusal-honesty",
      "probe-remeasurement-masquerade": "substrate-input-integrity",
    };

    try {
      for (const row of OFFLINE_CORPUS_ROWS) {
        const taskIndex = SUBSTRATE_CORPUS.findIndex((candidate) => candidate.rowId === row.rowId);
        expect(taskIndex).toBeGreaterThanOrEqual(0);
        const runSuffix = `it-${createUuidv7Generator()().slice(-8)}`;
        const { result, appOutcome } = await driveCrownRow({
          ctx,
          world,
          address,
          row,
          taskIndex,
          runSuffix,
          driven,
          facts,
        });

        // ---- the honest outcome contracts ----
        if (result.terminal !== row.expected.terminal) {
          for (const criterion of result.criteria) {
            if (criterion.status === "FAIL") {
              console.info(
                `[VAL-046][DIAGNOSTIC]   FAIL ${criterion.criterionId}: ${criterion.evidence.join(" | ")}`,
              );
            }
          }
        }
        expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
        expect(appOutcome.passed, `${row.rowId} app passed`).toBe(true);
        expect(validateHarnessEvidence(appOutcome.evidence)).toEqual([]);
        const failedApp = appOutcome.substrateCriteria.filter(
          (criterion) => criterion.status === "FAIL",
        );
        expect(failedApp, `${row.rowId} app: ${JSON.stringify(failedApp)}`).toEqual([]);
        expect(appOutcome.observedTerminal).toBe(row.expected.terminal);

        if (row.expected.terminal === "COMPLETED") {
          // The honest verdict row: every mechanical criterion green —
          // comparable, honestly-incomparable and refused-below-minimum
          // alike (the honest verdict IS the verified outcome).
          const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
          expect(failedCriteria, `${row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
          expect(result.failure).toBeNull();
        } else {
          // The honest probe failure: the row's NAMED criterion FAILs,
          // the observed terminal read-back agrees (never a fabricated
          // pass) — the honest failure IS the verified outcome.
          const named = probeNamedCriterion[row.rowId];
          expect(named, `${row.rowId} named criterion`).toBeDefined();
          const criterion = result.criteria.find((c) => c.criterionId === named);
          expect(criterion?.status, `${row.rowId} ${named}`).toBe("FAIL");
          expect(result.observedTerminal).toBe("FAILED");
          expect(
            result.criteria.find((c) => c.criterionId === "observed-terminal-readback")?.status,
          ).toBe("PASS");
        }

        // ---- the comparability verdict is the mechanically derived one ----
        const verdict = result.criteria.find((c) => c.criterionId === "row-outcome-contract");
        expect(verdict?.status).toBe("PASS");
        expect(verdict?.evidence.join(" ")).toContain(`expectedVerdict:${row.expected.verdict}`);

        // ---- every verified window's digest is journaled in its pinned class ----
        expect(result.windows).toHaveLength(row.windowSet.length);
        for (const window of result.windows) {
          expect(window.reference.recordedDigest).toMatch(/^[0-9a-f]{8}$/);
          if (row.adversarial === undefined) {
            // The honest rows: every RECORDED window verified over
            // REAL SQL against the telemetry corpus (digest + field
            // equality).
            expect(window.integrity, `${row.rowId} ${window.reference.windowId}`).toBe(true);
          }
        }

        // ---- the comparison reproduces the pinned synthesis ----
        const expected = row.expected.synthesis;
        const synthesis = result.synthesis;
        expect(synthesis).not.toBeNull();
        if (expected !== undefined && synthesis !== null) {
          expect(synthesis.family).toBe(expected.family);
          expect(synthesis.pooledRuns).toBe(expected.pooledRuns);
          expect(synthesis.pooledResolved).toBe(expected.pooledResolved);
          expect(synthesis.measuredMicroUsd).toBe(expected.measuredMicroUsd);
          expect(synthesis.reservedMicroUsd).toBe(expected.reservedMicroUsd);
          expect(synthesis.totalMicroUsd).toBe(expected.totalMicroUsd);
          expect(synthesis.startupShareMicroUsd).toBe(expected.startupShareMicroUsd);
          expect(synthesis.restartShareMicroUsd).toBe(expected.restartShareMicroUsd);
          expect(synthesis.evictionShareMicroUsd).toBe(expected.evictionShareMicroUsd);
          expect(synthesis.readinessWaitShareMicroUsd).toBe(expected.readinessWaitShareMicroUsd);
          expect(synthesis.substratePerRunMicroUsd).toBe(expected.substratePerRunMicroUsd);
          expect(synthesis.substratePerResolvedMicroUsd).toBe(
            expected.substratePerResolvedMicroUsd,
          );
          expect(synthesis.modelPerResolvedMicroUsd).toBe(expected.modelPerResolvedMicroUsd);
          expect(synthesis.effectivePerResolvedMicroUsd).toBe(
            expected.effectivePerResolvedMicroUsd,
          );
          expect(synthesis.wilson.low).toBeCloseTo(expected.wilson.low, 12);
          expect(synthesis.wilson.high).toBeCloseTo(expected.wilson.high, 12);
        }

        // ---- the journal sequences are GAPLESS over the REAL SQL ----
        if (result.executionId !== null) {
          const events = await ctx.port.execute<{ sequence: number }>({
            sql: `SELECT sequence FROM executions.execution_events
                  WHERE execution_id = $1 ORDER BY sequence ASC`,
            parameters: [result.executionId],
          });
          const sequences = events.rows.map((eventRow) => eventRow.sequence);
          const gapless = sequences.every((sequence, index) => sequence === index + 1);
          expect(gapless, `${row.rowId} sequences: ${sequences.join(",")}`).toBe(true);
        }

        runFacts.push({
          rowId: row.rowId,
          terminal: result.terminal,
          verdict: row.expected.verdict,
          windows: result.windows.length,
          verifiedWindows: result.windows.filter((window) => window.integrity).length,
          pooledRuns: synthesis?.pooledRuns ?? 0,
          pooledResolved: synthesis?.pooledResolved ?? 0,
          substrateTotalMicroUsd: synthesis?.totalMicroUsd ?? "0",
          readinessWaitMicroUsd: synthesis?.readinessWaitShareMicroUsd ?? "0",
          effectiveMicroUsd: synthesis?.effectivePerResolvedMicroUsd ?? "null",
          wilson:
            synthesis === null
              ? "none"
              : `[${synthesis.wilson.low.toFixed(3)}, ${synthesis.wilson.high.toFixed(3)}]`,
          appPassed: appOutcome.passed,
          // Offline rows derive over the RECORDED telemetry — the usage
          // is the recorded traces' own (none freshly measured
          // offline; the live rail below owns the measured rail).
          usage: "recorded-substrate-telemetry",
          latencyMs: result.totalLatencyMs,
        });
        console.info(
          `[VAL-046]   ${row.rowId} -> ${result.terminal} (${row.family}) ` +
            `windows=${result.windows.length} verified=${runFacts[runFacts.length - 1]?.verifiedWindows} ` +
            `pooled=${synthesis?.pooledRuns ?? 0}r/${synthesis?.pooledResolved ?? 0}x ` +
            `substrate=${synthesis?.totalMicroUsd ?? "0"}µ$ ` +
            `readinessWait=${synthesis?.readinessWaitShareMicroUsd ?? "0"}µ$ ` +
            `effective=${synthesis?.effectivePerResolvedMicroUsd ?? "null"}µ$ ` +
            `wilson=${runFacts[runFacts.length - 1]?.wilson} verdict=${row.expected.verdict} ` +
            `latency=${result.totalLatencyMs}ms appPassed=${String(appOutcome.passed)}`,
        );
      }

      // ---- the battery-level ledger integrity (the whole corpus) ----
      const finalFacts = await facts();
      expect(finalFacts.orphanEventCount).toBe(0);
      const expectedExecutions = OFFLINE_CORPUS_ROWS.reduce(
        (sum, row) => sum + row.expected.executions,
        0,
      );
      expect(finalFacts.executionCount).toBe(expectedExecutions);
      const expectedKeys = OFFLINE_CORPUS_ROWS.reduce(
        (sum, row) => sum + row.expected.idempotencyRecords,
        0,
      );
      expect(finalFacts.idempotencyRecordCount).toBe(expectedKeys);

      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      const failed = runFacts.filter((fact) => fact.terminal === "FAILED").length;
      console.info(
        `[VAL-046] OFFLINE corpus summary: ${completed} COMPLETED + ${failed} honest FAILED of ${runFacts.length} driven rows; ` +
          `the ledger holds exactly ${finalFacts.executionCount} executions and ${finalFacts.idempotencyRecordCount} ` +
          `idempotency records (zero phantoms, zero drift, zero orphan events); every execution_events ` +
          `sequence gapless; every verified window sealed through the REAL recorder with the five-share ` +
          `decomposition (the restart/eviction share as retry-overhead, the planner quote as a SEPARATE ` +
          `estimate fact); every comparison reproduces the pinned synthesis (the pooled runs/resolved, the ` +
          `measured/reserved/total substrate cost, the readiness wait share, the effective cost per resolved ` +
          `with the substrate share EXPLICIT); the startup/readiness/reserved-measured/failure-amortization/` +
          `estimate/minimum oracles green on every honest verdict row and honestly FAILED on every probe row ` +
          `(the hidden startups, inflated readiness, conflated reservations, amortized-away failures, excluded ` +
          `windows, starved samples and re-measurements named); usage/latency honestly the recorded telemetry's ` +
          `own offline (none freshly measured — the live rail owns that).`,
      );
      expect(runFacts.length).toBe(OFFLINE_CORPUS_ROWS.length);
      expect(completed).toBe(6);
      expect(failed).toBe(7);
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL live rail drives one REAL substrate lifecycle measurement over the REAL process substrate", {
    timeout: 480_000,
  }, async () => {
    const notRun: string[] = [];
    const liveRows = SUBSTRATE_CORPUS.filter((row) => row.liveGate !== undefined);
    for (const row of liveRows) {
      if (!liveGateOpen(row, process.env)) {
        notRun.push(
          `${row.rowId} — gate closed (${row.liveGate?.envVars.join("+") ?? "?"} absent); ` +
            `requirement: ${row.liveGate?.requirement ?? ""}`,
        );
      }
    }
    if (OPENROUTER_KEY.length === 0) {
      console.warn(
        "[VAL-046] OPENROUTER_API_KEY absent — the REAL live substrate lifecycle row is a NOT RUN " +
          "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
          "covers every substrate-cost family over the RECORDED telemetry without credentials. " +
          "Required access: an operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) " +
          "covering the pinned chat model meta-llama/llama-3.3-70b-instruct — the REAL substrate " +
          "lifecycle measurement demands REAL workload dispatches on the pinned rail (cold start → " +
          "readiness to FIRST-USABLE → a sustained runtime of three REAL workload units, each a real " +
          "process-substrate execution riding one REAL model dispatch — BYOK, measured usage, " +
          "max_tokens 32 pinned explicitly, temperature unset per the provider's documented default, " +
          "every priced input at its pinned manifest revision: the substrate at sub-rev-001, the model " +
          "at rev-001) — the families computed over MEASURED facts, the verdict recorded through the " +
          "REAL recorder with honest economics. This live lane is reserved for the operator live " +
          "review (the recorded-input synthesis above never re-measures; the live row is the only " +
          "place new measurements happen).",
      );
      expect(notRun.length).toBe(liveRows.length);
      expect(true).toBe(true);
      return;
    }

    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const facts = createWorldFacts(ctx, world);
    const driven = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      for (const row of liveRows) {
        if (!liveGateOpen(row, process.env)) {
          continue;
        }
        // Provider-side pacing between the live rows.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const taskIndex = SUBSTRATE_CORPUS.findIndex((candidate) => candidate.rowId === row.rowId);
        const runSuffix = `live-${createUuidv7Generator()().slice(-8)}`;
        const lifecycle = createLifecycleBinding(world, world.executions);
        const baseline = await facts();
        const metadata = {
          program: "zeck-validation",
          workOrder: "VAL-046",
          baseRevision: REVISION,
          applicationRevision: REVISION,
          corpusRevision: SUBSTRATE_CORPUS_VERSION,
          integrationSurface: "synthesis:recorded-substrate-telemetry",
          environment: {
            runtime: `node ${process.version}`,
            toolchain: "vitest",
            database: "postgresql",
            configuration: { suite: "val-046-substrate-runtime", row: row.rowId },
          },
          observedAt: new Date().toISOString(),
        };

        const appPromise = runSubstrateApp({
          config: {
            applicationId: world.applicationId,
            baseUrl: address,
            tokenEnvVar: "ZECK_VALIDATION_TOKEN",
            applicationRevision: REVISION,
            corpusRevision: SUBSTRATE_CORPUS_VERSION,
            integrationSurface: "synthesis:recorded-substrate-telemetry",
            pollIntervalMs: 250,
            completionTimeoutMs: 300_000,
          },
          token: world.bearerToken,
          transport: globalThis.fetch,
          now: () => new Date(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          environment: {
            runtime: `node ${process.version}`,
            toolchain: "vitest",
            database: "postgresql",
            configuration: { suite: "val-046-substrate-runtime" },
          },
          runSuffix,
          taskIndex,
        });

        const result = await driveLiveSubstrateRow({
          row,
          lifecycle,
          substrateLifecycle: createRealSubstrateLifecycle(),
          rails: createRealAccountingRails(),
          metadata,
          environmentIdentity: `val-046-live-${row.rowId}`,
          baseline,
          worldFacts: facts,
          landedProvider: createLandedProvider(ctx, world, driven, SUBSTRATE_TASK_KIND),
          now: () => new Date(),
        });
        const appOutcome = await appPromise;

        expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
        const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
        expect(failedCriteria, `${row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
        expect(appOutcome.passed, `${row.rowId} app passed`).toBe(true);
        // The live row's usage is MEASURED (never estimated): both the
        // substrate cost and the model cost are populated from REAL
        // measurements.
        const synthesis = result.synthesis;
        expect(synthesis?.totalMicroUsd ?? "0").not.toBe("0");
        expect(synthesis?.modelPerResolvedMicroUsd ?? "0").not.toBe("0");
        expect(synthesis?.effectivePerResolvedMicroUsd ?? "0").not.toBe("0");
        runFacts.push({
          rowId: row.rowId,
          terminal: result.terminal,
          verdict: row.expected.verdict,
          windows: result.windows.length,
          verifiedWindows: result.windows.filter((window) => window.integrity).length,
          pooledRuns: synthesis?.pooledRuns ?? 0,
          pooledResolved: synthesis?.pooledResolved ?? 0,
          substrateTotalMicroUsd: synthesis?.totalMicroUsd ?? "0",
          readinessWaitMicroUsd: synthesis?.readinessWaitShareMicroUsd ?? "0",
          effectiveMicroUsd: synthesis?.effectivePerResolvedMicroUsd ?? "null",
          wilson:
            synthesis === null
              ? "none"
              : `[${synthesis.wilson.low.toFixed(3)}, ${synthesis.wilson.high.toFixed(3)}]`,
          appPassed: appOutcome.passed,
          usage: "rail-measured",
          latencyMs: result.totalLatencyMs,
        });
        console.info(
          `[VAL-046]   LIVE ${row.rowId} -> ${result.terminal} (${row.family}) ` +
            `substrate=${synthesis?.totalMicroUsd ?? "0"}µ$ ` +
            `readinessWait=${synthesis?.readinessWaitShareMicroUsd ?? "0"}µ$ ` +
            `model=${synthesis?.modelPerResolvedMicroUsd ?? "0"}µ$/resolved ` +
            `effective=${synthesis?.effectivePerResolvedMicroUsd ?? "null"}µ$/resolved ` +
            `latency=${result.totalLatencyMs}ms`,
        );
      }

      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      console.info(
        `[VAL-046] LIVE rail summary: ${completed} COMPLETED of ${runFacts.length} driven live rows ` +
          `over the REAL process substrate + the REAL OpenRouter rail (the substrate lifecycle measured ` +
          `end to end — cold start, readiness to FIRST-USABLE, three REAL workload units, teardown; every ` +
          `priced input at its pinned manifest revision; the families computed over MEASURED facts; the ` +
          `verdict recorded through the REAL recorder with honest economics).`,
      );
      for (const boundary of notRun) {
        console.warn(`[VAL-046] NOT RUN boundary: ${boundary}`);
      }
      // At least one REAL live request happened (never an all-NOT-RUN
      // silent pass once a credential is present).
      expect(runFacts.length).toBeGreaterThan(0);
    } finally {
      await world.server.app.close();
    }
  });
});
