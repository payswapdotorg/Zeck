/**
 * benchmarks/d08-usage/campaign.ts — the D-08 measured-usage campaign driver.
 *
 * Runs the full scenario matrix (12 classes, concurrency 1/4/16(+32), a
 * 30-minute sustained window with the worker process and queue live),
 * writes every execution as one JSONL record under data/, and leaves the
 * durable evidence in PostgreSQL for the summary pass (summarize.ts).
 *
 * Usage:
 *   ZECK_DATABASE_URL=… bun benchmarks/d08-usage/campaign.ts run \
 *     [--sustained-minutes 30] [--skip-sustained] [--skip-burst32]
 *   ZECK_DATABASE_URL=… bun benchmarks/d08-usage/campaign.ts warmup
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUuidv7Generator } from "../../src/shared/ids";
import { SCENARIOS, type ScenarioSpec } from "./scenarios";
import { type CampaignWorld, DATA_DIR, startWorld } from "./world";

const generateId = createUuidv7Generator();
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
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

function writeProgress(state: Record<string, unknown>): void {
  writeFileSync(join(DATA_DIR, "campaign-progress.json"), `${JSON.stringify(state, null, 2)}\n`);
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

function scenarioOf(id: string): ScenarioSpec {
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

/** The restrictive cost policy scoped to the policy-denied task kind only. */
export async function publishRestrictivePolicy(world: CampaignWorld): Promise<void> {
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
// The phases
// ---------------------------------------------------------------------------

interface PhaseOptions {
  readonly sustainedMinutes: number;
  readonly skipSustained: boolean;
  readonly skipBurst32: boolean;
}

async function runPhases(world: CampaignWorld, options: PhaseOptions): Promise<number> {
  let total = 0;

  // Phase A — concurrency 1 (the sequential baseline).
  console.log("phase A: concurrency 1");
  for (const id of [
    "simple-deterministic",
    "model-routed-decision",
    "tool-surface-programmatic",
    "context-heavy",
    "verification-heavy",
    "budget-funded",
  ]) {
    total += (await runBatch(world, scenarioOf(id), 6, 1, "A-c1")).length;
  }
  total += (await runPairs(world, scenarioOf("competence-reuse"), 3, "A-c1")).length;
  total += (await runPairs(world, scenarioOf("failure-escalation"), 3, "A-c1")).length;
  total += (await runBatch(world, scenarioOf("failure-retry"), 3, 1, "A-c1")).length;
  total += (await runBatch(world, scenarioOf("policy-denied"), 3, 1, "A-c1")).length;
  total += (await runBatch(world, scenarioOf("budget-exhausted"), 6, 6, "A-budget")).length;
  writeProgress({ phase: "A", completed: total, at: new Date().toISOString() });

  // Phase B — concurrency 4.
  console.log("phase B: concurrency 4");
  for (const id of [
    "simple-deterministic",
    "model-routed-decision",
    "tool-surface-programmatic",
    "context-heavy",
    "verification-heavy",
  ]) {
    total += (await runBatch(world, scenarioOf(id), 12, 4, "B-c4")).length;
  }
  total += (await runBatch(world, scenarioOf("budget-exhausted"), 6, 6, "B-budget")).length;
  writeProgress({ phase: "B", completed: total, at: new Date().toISOString() });

  // Phase C — concurrency 16 (burst) + 32 if stable.
  console.log("phase C: concurrency 16");
  total += (await runBatch(world, scenarioOf("burst-load"), 32, 16, "C-c16")).length;
  total += (await runBatch(world, scenarioOf("simple-deterministic"), 16, 16, "C-c16")).length;
  if (!options.skipBurst32) {
    total += (await runBatch(world, scenarioOf("burst-load"), 32, 32, "C-c32")).length;
  }
  writeProgress({ phase: "C", completed: total, at: new Date().toISOString() });

  // The sustained window — worker + queue live, mixed realistic load.
  if (!options.skipSustained) {
    console.log(`sustained window: ${options.sustainedMinutes} minutes`);
    const endAt = Date.now() + options.sustainedMinutes * 60_000;
    const mix = [
      "simple-deterministic",
      "tool-surface-programmatic",
      "model-routed-decision",
      "verification-heavy",
    ];
    let tick = 0;
    while (Date.now() < endAt) {
      const size = 1 + (tick % 3 === 0 ? 1 : 0);
      const scenarioId = mix[tick % mix.length] ?? "simple-deterministic";
      total += (await runBatch(world, scenarioOf(scenarioId), size, size, "sustained")).length;
      if (tick % 8 === 4) {
        total += (await runBatch(world, scenarioOf("context-heavy"), 1, 1, "sustained")).length;
      }
      if (tick % 20 === 10) {
        total += (await runBatch(world, scenarioOf("failure-retry"), 1, 1, "sustained")).length;
      }
      if (tick % 12 === 6) {
        total += (await runBatch(world, scenarioOf("budget-funded"), 1, 1, "sustained")).length;
      }
      if (tick % 30 === 15) {
        total += (await runPairs(world, scenarioOf("failure-escalation"), 1, "sustained")).length;
      }
      tick += 1;
      writeProgress({
        phase: "sustained",
        tick,
        completed: total,
        remainingSeconds: Math.max(0, Math.round((endAt - Date.now()) / 1000)),
        at: new Date().toISOString(),
      });
      await sleep(15_000);
    }
  }
  writeProgress({ phase: "done", completed: total, at: new Date().toISOString() });
  return total;
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

async function run(): Promise<void> {
  const sustainedMinutes = Number.parseInt(arg("--sustained-minutes", "30") ?? "30", 10);
  const startedAt = new Date().toISOString();
  console.log(`campaign start: ${startedAt}`);
  const world = await startWorld({ queueSampleIntervalMs: 1000 });
  try {
    const workerId = await awaitWorker(world, 30_000);
    console.log(`worker registered: ${workerId}`);
    await fundBudget(world);
    await publishRestrictivePolicy(world);
    const total = await runPhases(world, {
      sustainedMinutes,
      skipSustained: hasFlag("--skip-sustained"),
      skipBurst32: hasFlag("--skip-burst32"),
    });
    console.log(`campaign complete: ${total} executions`);
    writeProgress({
      phase: "finished",
      completed: total,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  } finally {
    await world.stop();
    console.log("stack stopped: worker drained, servers closed");
  }
}

const command = process.argv[2] ?? "run";
if (command === "warmup") {
  await warmup();
} else if (command === "run") {
  await run();
} else if (command === "summary") {
  const { summarize } = await import("./summarize");
  await summarize();
} else {
  console.error("usage: bun benchmarks/d08-usage/campaign.ts [run|warmup|summary] [flags]");
  process.exit(2);
}
