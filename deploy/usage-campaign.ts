/**
 * deploy/usage-campaign.ts — the D-08 measured-usage campaign driver.
 *
 * CHUNKED EXECUTION (the sandbox operating contract): this sandbox kills
 * every process spawned by a tool call when that call returns (proven by a
 * heartbeat test — see the evidence document). The campaign therefore runs
 * as N sequential bounded CHUNKS, each a synchronous invocation from its own
 * operator call:
 *
 *   - the DURABLE campaign state lives in PostgreSQL (executions, envelopes,
 *     compute plane, budgets) and benchmarks/d08-usage/data/campaign-state.json
 *     (the work-list cursor);
 *   - each chunk starts a FRESH world (API server + queue stand-in + OTLP stub
 *     + REAL worker service process), continues the work list, appends to the
 *     SAME JSONL data files, then stops cleanly: every execution started in
 *     the chunk is awaited to a terminal state BEFORE the worker's graceful
 *     bounded drain — nothing undispatched crosses a chunk boundary;
 *   - sustained-window wall-clock coverage accumulates across chunks (each
 *     chunk's live window is recorded in data/chunks/chunk-*.json);
 *   - chunk boundaries, per-chunk liveness and worker/queue continuity are
 *     disclosed in the evidence document (honest chunked shape, never claimed
 *     as a single uninterrupted process).
 *
 * Usage:
 *   ZECK_DATABASE_URL=… bun deploy/usage-campaign.ts warmup
 *   ZECK_DATABASE_URL=… bun deploy/usage-campaign.ts chunk --chunk-id 1 --budget-seconds 360
 *   ZECK_DATABASE_URL=… bun deploy/usage-campaign.ts summary
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCENARIOS, type ScenarioId, type ScenarioSpec } from "../benchmarks/d08-usage/scenarios";
import { createUuidv7Generator } from "../src/shared/ids";
import { type CampaignWorld, DATA_DIR, startWorld } from "./usage-world";

const generateId = createUuidv7Generator();
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

// ---------------------------------------------------------------------------
// The execution record (one JSONL line per governed execution)
// ---------------------------------------------------------------------------

interface ExecutionRecord {
  readonly at: string;
  readonly phase: string;
  readonly scenario: string;
  readonly plane: string;
  readonly concurrency: number;
  readonly variant: number;
  readonly executionId: string;
  readonly outcome: "COMPLETED" | "FAILED" | "DENIED" | "TIMEOUT" | "CREATE_ERROR";
  readonly denialCode: string | null;
  readonly failureEvidence: string | null;
  readonly createdAt: string;
  readonly createMs: number;
  readonly progressMs: number;
  readonly awaitMs: number;
  readonly totalMs: number;
  readonly stages: {
    authorizeMs: number | null;
    planMs: number | null;
    queueMs: number;
    claimMs: number | null;
    executeMs: number | null;
    settleMs: number | null;
  };
  readonly eventTypes: readonly string[];
}

function recordExecution(record: ExecutionRecord): void {
  appendFileSync(join(DATA_DIR, "executions.jsonl"), `${JSON.stringify(record)}\n`);
}

// ---------------------------------------------------------------------------
// Stage extraction from the durable ledger events (HTTP reads)
// ---------------------------------------------------------------------------

interface WireEvent {
  readonly sequence: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly command?: string;
}

function stagesOf(events: readonly WireEvent[]): {
  stages: ExecutionRecord["stages"];
  eventTypes: string[];
} {
  const at = new Map<string, number>();
  const eventTypes: string[] = [];
  for (const event of events) {
    const step = (event.command ?? event.type).replace(/^execution\./, "");
    eventTypes.push(`${event.sequence}:${event.type}`);
    if (!at.has(step)) at.set(step, Date.parse(event.occurredAt));
  }
  const stage = (from: string, to: string): number | null => {
    const a = at.get(from);
    const b = at.get(to);
    return a !== undefined && b !== undefined && b >= a ? Math.round((b - a) * 100) / 100 : null;
  };
  return {
    stages: {
      authorizeMs: stage("created", "authorize"),
      planMs: stage("authorize", "plan"),
      queueMs: stage("plan", "queue") ?? 0,
      claimMs: stage("queue", "start"),
      executeMs: stage("start", "verify"),
      settleMs: stage("verify", "pass") ?? stage("verify", "fail"),
    },
    eventTypes,
  };
}

// ---------------------------------------------------------------------------
// Drive ONE governed execution through the real surfaces
// ---------------------------------------------------------------------------

interface DriveOptions {
  readonly world: CampaignWorld;
  readonly spec: ScenarioSpec;
  readonly variant: number;
  readonly phase: string;
  readonly concurrency: number;
}

async function driveOne(options: DriveOptions): Promise<ExecutionRecord> {
  const { world, spec, variant, phase, concurrency } = options;
  const identity = world.identity;
  const scope = {
    actorId: identity.actorId,
    applicationId: identity.applicationId,
    tenantId: identity.tenantId,
  };
  const task = spec.buildTask(world, variant);
  const key = `d08-${phase}-${spec.id}-${variant}-${generateId()}`;
  const startedWall = performance.now();

  // 1) CREATE through the real HTTP surface (the SDK client).
  const createStart = performance.now();
  let executionId: string;
  let createdAt: string;
  try {
    const { receipt } = await world.client.createExecution(
      {
        applicationId: identity.applicationId,
        environmentId: identity.environmentId,
        task: task as unknown as Record<string, unknown>,
        ...(task.constraints === undefined ? {} : { constraints: task.constraints }),
      },
      key,
    );
    executionId = receipt.executionId;
    createdAt = receipt.createdAt;
  } catch (error) {
    const record: ExecutionRecord = {
      at: new Date().toISOString(),
      phase,
      scenario: spec.id,
      plane: spec.plane,
      concurrency,
      variant,
      executionId: "n/a",
      outcome: "CREATE_ERROR",
      denialCode: null,
      failureEvidence: error instanceof Error ? error.message : "unknown create error",
      createdAt: new Date().toISOString(),
      createMs: Math.round((performance.now() - createStart) * 100) / 100,
      progressMs: 0,
      awaitMs: 0,
      totalMs: Math.round((performance.now() - startedWall) * 100) / 100,
      stages: {
        authorizeMs: null,
        planMs: null,
        queueMs: 0,
        claimMs: null,
        executeMs: null,
        settleMs: null,
      },
      eventTypes: [],
    };
    recordExecution(record);
    return record;
  }
  const createMs = Math.round((performance.now() - createStart) * 100) / 100;

  // 2) The platform-side progression (the composition-root role — no HTTP
  //    surface exists for authorize/plan/queue/dispatch at this revision).
  const progressStart = performance.now();
  let denialCode: string | null = null;
  let failureEvidence: string | null = null;
  try {
    await world.executions.transition(
      { ...scope, executionId, command: "authorize" },
      `${key}-auth`,
    );
    await world.executions.transition({ ...scope, executionId, command: "plan" }, `${key}-plan`);
    if (spec.decision !== undefined) {
      await world.executions.recordPlanningDecision(
        {
          applicationId: identity.applicationId,
          tenantId: identity.tenantId,
          actorId: identity.actorId,
          executionId,
          decisionId: `d08-decision-${generateId()}`,
          planId: `d08-plan-${spec.id}-${variant}`,
          payload: spec.decision(world, variant) as unknown as Record<string, unknown>,
        },
        `${key}-decision`,
      );
    }
    await world.executions.transition({ ...scope, executionId, command: "queue" }, `${key}-queue`);
    await world.dispatcher.dispatchExecution({
      executionId,
      applicationId: identity.applicationId,
      tenantId: identity.tenantId,
    });
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : null;
    denialCode = code;
    failureEvidence = error instanceof Error ? error.message : "unknown progression error";
  }
  const progressMs = Math.round((performance.now() - progressStart) * 100) / 100;

  // 3) Await the terminal state through the real HTTP surface.
  const awaitStart = performance.now();
  const deadline = Date.now() + spec.timeoutMs;
  const pollIntervalMs = spec.id === "failure-retry" ? 500 : 150;
  let outcome: ExecutionRecord["outcome"] = "TIMEOUT";
  let status = "UNKNOWN";
  while (Date.now() < deadline) {
    try {
      const execution = await world.client.getExecution(executionId);
      status = execution.status;
      if (TERMINAL.has(execution.status)) {
        outcome = execution.status === "COMPLETED" ? "COMPLETED" : "FAILED";
        break;
      }
    } catch (error) {
      failureEvidence = error instanceof Error ? error.message : "unknown read error";
      break;
    }
    await sleep(pollIntervalMs);
  }
  const awaitMs = Math.round((performance.now() - awaitStart) * 100) / 100;
  const totalMs = Math.round((performance.now() - startedWall) * 100) / 100;

  // 4) The durable ledger timeline (HTTP read) → per-stage latencies.
  let stages: ExecutionRecord["stages"] = {
    authorizeMs: null,
    planMs: null,
    queueMs: 0,
    claimMs: null,
    executeMs: null,
    settleMs: null,
  };
  let eventTypes: string[] = [];
  try {
    const events = (await world.client.listEvents(executionId)) as readonly WireEvent[];
    const extracted = stagesOf(events);
    stages = extracted.stages;
    eventTypes = extracted.eventTypes;
  } catch {
    // The record is still complete; the ledger read is best-effort here.
  }

  // A denial at the progression step (policy) is its own honest outcome.
  if (denialCode !== null) {
    outcome = "DENIED";
  }

  const record: ExecutionRecord = {
    at: new Date().toISOString(),
    phase,
    scenario: spec.id,
    plane: spec.plane,
    concurrency,
    variant,
    executionId,
    outcome,
    denialCode,
    failureEvidence: outcome === "COMPLETED" ? null : (failureEvidence ?? `terminal:${status}`),
    createdAt,
    createMs,
    progressMs,
    awaitMs,
    totalMs,
    stages,
    eventTypes,
  };
  recordExecution(record);
  return record;
}

// ---------------------------------------------------------------------------
// The concurrent batch runner (shared-cursor worker pool)
// ---------------------------------------------------------------------------

async function runBatch(
  world: CampaignWorld,
  spec: ScenarioSpec,
  count: number,
  concurrency: number,
  phase: string,
): Promise<readonly ExecutionRecord[]> {
  let cursor = 0;
  const records: ExecutionRecord[] = [];
  const worker = async (): Promise<void> => {
    for (;;) {
      const variant = cursor++;
      if (variant >= count) return;
      records.push(await driveOne({ world, spec, variant, phase, concurrency }));
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => worker()));
  const wallMs = Math.round((performance.now() - started) * 100) / 100;
  console.log(
    `  [${phase}] ${spec.id}: ${count} executions at c=${concurrency} in ${wallMs}ms ` +
      `(${Math.round((count / (wallMs / 1000)) * 100) / 100}/s)`,
  );
  return records;
}

/** Sequential paired classes (escalation, competence-reuse). */
async function runPairs(
  world: CampaignWorld,
  spec: ScenarioSpec,
  pairs: number,
  phase: string,
): Promise<readonly ExecutionRecord[]> {
  const records: ExecutionRecord[] = [];
  for (let pair = 0; pair < pairs; pair += 1) {
    records.push(await driveOne({ world, spec, variant: 0, phase, concurrency: 1 }));
    records.push(await driveOne({ world, spec, variant: 1, phase, concurrency: 1 }));
  }
  console.log(`  [${phase}] ${spec.id}: ${pairs} pairs (attempt1 + attempt2)`);
  return records;
}

function scenarioOf(id: ScenarioId): ScenarioSpec {
  const spec = SCENARIOS.find((s) => s.id === id);
  if (spec === undefined) throw new Error(`unknown scenario: ${id}`);
  return spec;
}

// ---------------------------------------------------------------------------
// Worker readiness + budget funding + restrictive policy seeding
// ---------------------------------------------------------------------------

async function awaitWorker(world: CampaignWorld, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await world.db.execute<{ worker_id: string; heartbeat_count: number }>({
      sql: `SELECT worker_id, heartbeat_count FROM compute_plane.worker_registrations
            WHERE status = 'active' ORDER BY registered_at DESC LIMIT 1`,
      parameters: [],
    });
    const row = result.rows[0];
    if (row !== undefined && row.heartbeat_count > 0) {
      return row.worker_id;
    }
    await sleep(250);
  }
  throw new Error("the worker service did not register within the readiness window");
}

/**
 * Budget funding: durable in PostgreSQL (idempotency-keyed — replays safely
 * on every chunk). The wallet funds exactly ONE live costed reservation
 * (1000 microUsd): sequential costed executions settle-and-release; truly
 * concurrent ones exceed the live bound → honest BUDGET_EXCEEDED denials.
 */
async function fundBudget(world: CampaignWorld): Promise<void> {
  const scope = {
    actorId: world.identity.actorId,
    applicationId: world.identity.applicationId,
    tenantId: world.identity.tenantId,
  };
  await world.budgets.configureFundingMode(
    { ...scope, fundingMode: "developer" },
    "d08-funding-mode",
  );
  await world.budgets.grantCredits(
    { ...scope, ownerKind: "developer", amountMicroUsd: "1000" },
    "d08-grant-developer-1000",
  );
}

/**
 * The restrictive cost policy (version 2, task-scoped). The policy authority
 * is process-local (InMemoryPolicyStore behind the REAL authority seam), so
 * EVERY chunk re-publishes the identical set into its fresh authority.
 */
async function publishRestrictivePolicy(world: CampaignWorld): Promise<void> {
  await world.policyAuthority.publish({
    id: "default",
    version: 2,
    documents: [
      { scope: "platform", selector: {}, restrictions: {} },
      {
        scope: "task",
        selector: { taskKind: "d08-policy-denied" },
        restrictions: { cost: { maxCostMicroUsd: "100" } },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// The campaign work list (the durable, chunk-resumable plan)
// ---------------------------------------------------------------------------

type WorkItem =
  | {
      readonly kind: "batch";
      readonly scenario: ScenarioId;
      readonly count: number;
      readonly concurrency: number;
      readonly phase: string;
    }
  | {
      readonly kind: "pairs";
      readonly scenario: ScenarioId;
      readonly pairs: number;
      readonly phase: string;
    };

/** The sustained window's total target (seconds of live-stack coverage). */
export const SUSTAINED_TOTAL_SECONDS = 1800;
/** The sustained tick cadence (seconds per tick, including its idle tail). */
const SUSTAINED_TICK_SECONDS = 15;

function buildWorkList(): readonly WorkItem[] {
  return [
    // Phase A — concurrency 1 (the sequential baseline).
    { kind: "batch", scenario: "simple-deterministic", count: 6, concurrency: 1, phase: "A-c1" },
    { kind: "batch", scenario: "model-routed-decision", count: 6, concurrency: 1, phase: "A-c1" },
    {
      kind: "batch",
      scenario: "tool-surface-programmatic",
      count: 6,
      concurrency: 1,
      phase: "A-c1",
    },
    { kind: "batch", scenario: "context-heavy", count: 6, concurrency: 1, phase: "A-c1" },
    { kind: "batch", scenario: "verification-heavy", count: 6, concurrency: 1, phase: "A-c1" },
    { kind: "batch", scenario: "budget-funded", count: 6, concurrency: 1, phase: "A-c1" },
    { kind: "pairs", scenario: "competence-reuse", pairs: 3, phase: "A-c1" },
    { kind: "pairs", scenario: "failure-escalation", pairs: 3, phase: "A-c1" },
    { kind: "batch", scenario: "failure-retry", count: 3, concurrency: 1, phase: "A-c1" },
    { kind: "batch", scenario: "policy-denied", count: 3, concurrency: 1, phase: "A-c1" },
    { kind: "batch", scenario: "budget-exhausted", count: 6, concurrency: 6, phase: "A-budget" },
    // Phase B — concurrency 4.
    { kind: "batch", scenario: "simple-deterministic", count: 12, concurrency: 4, phase: "B-c4" },
    { kind: "batch", scenario: "model-routed-decision", count: 12, concurrency: 4, phase: "B-c4" },
    {
      kind: "batch",
      scenario: "tool-surface-programmatic",
      count: 12,
      concurrency: 4,
      phase: "B-c4",
    },
    { kind: "batch", scenario: "context-heavy", count: 12, concurrency: 4, phase: "B-c4" },
    { kind: "batch", scenario: "verification-heavy", count: 12, concurrency: 4, phase: "B-c4" },
    { kind: "batch", scenario: "budget-exhausted", count: 6, concurrency: 6, phase: "B-budget" },
    // Phase C — concurrency 16 and 32 bursts.
    { kind: "batch", scenario: "burst-load", count: 32, concurrency: 16, phase: "C-c16" },
    { kind: "batch", scenario: "simple-deterministic", count: 16, concurrency: 16, phase: "C-c16" },
    { kind: "batch", scenario: "burst-load", count: 32, concurrency: 32, phase: "C-c32" },
  ];
}

interface CampaignState {
  /** Cursor into the fixed work list (phases A/B/C). */
  nextItem: number;
  /** Accumulated sustained-window seconds across chunks. */
  sustainedElapsedSeconds: number;
  /** Sustained ticks executed (drives the mixed-load rotation). */
  sustainedTicks: number;
  /** Governed executions recorded (all chunks). */
  totalExecutions: number;
}

const STATE_FILE = join(DATA_DIR, "campaign-state.json");
const CHUNKS_DIR = join(DATA_DIR, "chunks");

function loadState(): CampaignState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as CampaignState;
  } catch {
    return {
      nextItem: 0,
      sustainedElapsedSeconds: 0,
      sustainedTicks: 0,
      totalExecutions: 0,
    };
  }
}

function saveState(state: CampaignState): void {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

/** One sustained tick: mixed realistic load, then idle tail (live stack).
 * Returns [secondsSpent, executionsStarted]. */
async function sustainedTick(
  world: CampaignWorld,
  tick: number,
): Promise<{ seconds: number; executions: number }> {
  const started = Date.now();
  let executions = 0;
  const mix: ScenarioId[] = [
    "simple-deterministic",
    "tool-surface-programmatic",
    "model-routed-decision",
    "verification-heavy",
  ];
  const scenarioId = mix[tick % mix.length] ?? "simple-deterministic";
  const size = 1 + (tick % 3 === 0 ? 1 : 0);
  executions += (await runBatch(world, scenarioOf(scenarioId), size, size, "sustained")).length;
  if (tick % 8 === 4) {
    executions += (await runBatch(world, scenarioOf("context-heavy"), 1, 1, "sustained")).length;
  }
  if (tick % 20 === 10) {
    executions += (await runBatch(world, scenarioOf("failure-retry"), 1, 1, "sustained")).length;
  }
  if (tick % 12 === 6) {
    executions += (await runBatch(world, scenarioOf("budget-funded"), 1, 1, "sustained")).length;
  }
  if (tick % 30 === 15) {
    executions += (await runPairs(world, scenarioOf("failure-escalation"), 1, "sustained")).length;
  }
  const spentMs = Date.now() - started;
  if (spentMs < SUSTAINED_TICK_SECONDS * 1000) {
    await sleep(SUSTAINED_TICK_SECONDS * 1000 - spentMs);
  }
  return { seconds: (Date.now() - started) / 1000, executions };
}

// ---------------------------------------------------------------------------
// The chunk runner (one bounded synchronous invocation)
// ---------------------------------------------------------------------------

interface ChunkManifest {
  readonly chunkId: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationSeconds: number;
  readonly workerId: string;
  readonly itemsExecuted: number;
  readonly executions: number;
  readonly sustainedElapsedSeconds: number;
  readonly totalExecutions: number;
  readonly workListDone: boolean;
  readonly sustainedDone: boolean;
  readonly drained: boolean;
}

async function runChunk(chunkId: number, budgetSeconds: number): Promise<void> {
  mkdirSync(CHUNKS_DIR, { recursive: true });
  const state = loadState();
  const work = buildWorkList();
  const startedAt = new Date().toISOString();
  const budgetDeadline = Date.now() + budgetSeconds * 1000;
  console.log(`chunk ${chunkId}: start ${startedAt} (budget ${budgetSeconds}s)`);
  console.log(
    `chunk ${chunkId}: resuming at work item ${state.nextItem}/${work.length}, ` +
      `sustained ${state.sustainedElapsedSeconds.toFixed(1)}/${SUSTAINED_TOTAL_SECONDS}s`,
  );

  const world = await startWorld({ queueSampleIntervalMs: 1000 });
  let drained = false;
  let workerId = "n/a";
  let itemsExecuted = 0;
  let executions = 0;
  let workListDone = false;
  let sustainedDone = false;
  try {
    workerId = await awaitWorker(world, 30_000);
    console.log(`chunk ${chunkId}: worker registered ${workerId}`);
    // Idempotent (durable in PG / re-published into the fresh authority).
    await fundBudget(world);
    await publishRestrictivePolicy(world);

    // Phases A/B/C: consume the fixed work list.
    while (state.nextItem < work.length && Date.now() < budgetDeadline) {
      const item = work[state.nextItem];
      if (item === undefined) break;
      if (item.kind === "batch") {
        const records = await runBatch(
          world,
          scenarioOf(item.scenario),
          item.count,
          item.concurrency,
          item.phase,
        );
        executions += records.length;
        state.totalExecutions += records.length;
      } else {
        const records = await runPairs(world, scenarioOf(item.scenario), item.pairs, item.phase);
        executions += records.length;
        state.totalExecutions += records.length;
      }
      state.nextItem += 1;
      itemsExecuted += 1;
      saveState(state);
    }
    workListDone = state.nextItem >= work.length;

    // The sustained window: accumulate live-stack seconds across chunks.
    while (
      workListDone &&
      state.sustainedElapsedSeconds < SUSTAINED_TOTAL_SECONDS &&
      Date.now() < budgetDeadline
    ) {
      const tick = await sustainedTick(world, state.sustainedTicks);
      state.sustainedTicks += 1;
      state.sustainedElapsedSeconds = Math.min(
        SUSTAINED_TOTAL_SECONDS,
        state.sustainedElapsedSeconds + tick.seconds,
      );
      state.totalExecutions += tick.executions;
      executions += tick.executions;
      itemsExecuted += 1;
      saveState(state);
      console.log(
        `chunk ${chunkId}: sustained tick ${state.sustainedTicks} ` +
          `(${state.sustainedElapsedSeconds.toFixed(0)}/${SUSTAINED_TOTAL_SECONDS}s)`,
      );
    }
    sustainedDone = state.sustainedElapsedSeconds >= SUSTAINED_TOTAL_SECONDS;
  } finally {
    // The clean chunk boundary: graceful bounded worker drain, servers closed.
    await world.stop();
    drained = true;
    console.log(`chunk ${chunkId}: stack stopped (worker drained gracefully)`);
  }

  // The chunk manifest (written after drain so its facts are final).
  const manifest: ChunkManifest = {
    chunkId,
    startedAt,
    endedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
    workerId,
    itemsExecuted,
    executions,
    sustainedElapsedSeconds: Math.round(state.sustainedElapsedSeconds),
    totalExecutions: state.totalExecutions,
    workListDone,
    sustainedDone,
    drained,
  };
  writeFileSync(
    join(CHUNKS_DIR, `chunk-${chunkId}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  appendFileSync(join(DATA_DIR, "chunks.jsonl"), `${JSON.stringify(manifest)}\n`);
  console.log(
    `chunk ${chunkId}: complete — ${manifest.executions} executions, ` +
      `sustained ${manifest.sustainedElapsedSeconds}s, total ${manifest.totalExecutions}`,
  );
  if (manifest.workListDone && manifest.sustainedDone) {
    console.log("campaign: ALL WORK COMPLETE");
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function warmup(): Promise<void> {
  const world = await startWorld({ queueSampleIntervalMs: 1000 });
  try {
    const workerId = await awaitWorker(world, 30_000);
    console.log(`warmup: worker registered ${workerId}`);
    const health = await fetch(`${world.apiBaseUrl}/health`);
    console.log(`warmup: GET /health → HTTP ${health.status}`);
    const records = await runBatch(world, scenarioOf("simple-deterministic"), 3, 1, "warmup");
    for (const record of records) {
      console.log(
        `warmup: ${record.executionId} → ${record.outcome} in ${record.totalMs}ms ` +
          `(create ${record.createMs}ms, claim ${record.stages.claimMs ?? "?"}ms, execute ${record.stages.executeMs ?? "?"}ms)`,
      );
    }
    const failed = records.filter((r) => r.outcome !== "COMPLETED");
    if (failed.length > 0) {
      for (const record of failed) {
        console.error(`warmup failure: ${record.failureEvidence}`);
      }
      process.exitCode = 1;
    }
  } finally {
    await world.stop();
  }
}

const command = process.argv[2] ?? "run";
if (command === "warmup") {
  await warmup();
} else if (command === "chunk") {
  const chunkId = Number.parseInt(arg("--chunk-id", "1") ?? "1", 10);
  const budgetSeconds = Number.parseInt(arg("--budget-seconds", "360") ?? "360", 10);
  await runChunk(chunkId, budgetSeconds);
} else if (command === "summary") {
  const { summarize } = await import("./usage-summarize");
  await summarize();
} else {
  console.error(
    "usage: bun deploy/usage-campaign.ts [warmup|chunk --chunk-id N --budget-seconds S|summary]",
  );
  process.exit(2);
}
