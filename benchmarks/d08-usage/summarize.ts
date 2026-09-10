/**
 * benchmarks/d08-usage/summarize.ts — the D-08 campaign summary pass.
 *
 * Derives the metric tables from the raw campaign data (executions.jsonl,
 * queue-depth.jsonl, observability-samples.jsonl, worker.log) and the
 * DURABLE PostgreSQL state (executions ledger, queue-transport journal,
 * compute plane, budgets ledger). Writes data/summary.json and prints the
 * headline tables. MEASUREMENT ONLY — it mutates nothing.
 *
 * Usage: ZECK_DATABASE_URL=… bun benchmarks/d08-usage/campaign.ts summary
 * (invoked by the CLI dispatcher in campaign.ts).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConnectionConfig } from "../../src/platform/db/connection";
import { PgDatabasePort } from "../../src/platform/db/pg-database-port";
import { DATA_DIR } from "./world";

// ---------------------------------------------------------------------------
// Small statistics helpers (nearest-rank percentiles, like the repo's harness)
// ---------------------------------------------------------------------------

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)] ?? 0;
}

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function stats(values: readonly number[]): {
  count: number;
  p50: number;
  p90: number;
  p99: number;
  avg: number;
  max: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    p99: round(percentile(sorted, 99)),
    avg: sorted.length > 0 ? round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
    max: sorted.length > 0 ? round(sorted[sorted.length - 1] ?? 0) : 0,
  };
}

function readJsonl(name: string): Record<string, unknown>[] {
  try {
    return readFileSync(join(DATA_DIR, name), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

const num = (value: unknown): number => (typeof value === "number" ? value : 0);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

// ---------------------------------------------------------------------------
// The execution metric tables
// ---------------------------------------------------------------------------

interface ScenarioRow {
  readonly scenario: string;
  readonly plane: string;
  readonly phase: string;
  readonly concurrency: number;
  readonly executions: number;
  readonly completed: number;
  readonly failed: number;
  readonly denied: number;
  readonly timeout: number;
  readonly createErrors: number;
  readonly successRate: number;
  readonly total: ReturnType<typeof stats>;
  readonly create: ReturnType<typeof stats>;
  readonly progression: ReturnType<typeof stats>;
  readonly claim: ReturnType<typeof stats>;
  readonly execute: ReturnType<typeof stats>;
  readonly settle: ReturnType<typeof stats>;
}

export async function summarize(): Promise<void> {
  const executions = readJsonl("executions.jsonl");
  const queueDepth = readJsonl("queue-depth.jsonl");
  const observability = readJsonl("observability-samples.jsonl");

  // ---- per (scenario, phase, concurrency) rows -------------------------------
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const record of executions) {
    if (str(record.phase) === "warmup") continue;
    const key = `${str(record.scenario)}|${str(record.phase)}|${num(record.concurrency)}`;
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }
  const rows: ScenarioRow[] = [];
  for (const [key, list] of groups) {
    const [scenario, phase, concurrency] = key.split("|");
    const byOutcome = (outcome: string): number =>
      list.filter((r) => str(r.outcome) === outcome).length;
    const completed = byOutcome("COMPLETED");
    rows.push({
      scenario: scenario ?? "",
      plane: str(list[0]?.plane),
      phase: phase ?? "",
      concurrency: Number.parseInt(concurrency ?? "1", 10),
      executions: list.length,
      completed,
      failed: byOutcome("FAILED"),
      denied: byOutcome("DENIED"),
      timeout: byOutcome("TIMEOUT"),
      createErrors: byOutcome("CREATE_ERROR"),
      successRate: list.length > 0 ? round((completed / list.length) * 100, 1) : 0,
      total: stats(list.map((r) => num(r.totalMs))),
      create: stats(list.map((r) => num(r.createMs))),
      progression: stats(list.map((r) => num(r.progressMs))),
      claim: stats(
        list
          .map((r) => (r.stages as Record<string, unknown> | undefined)?.claimMs)
          .filter((v): v is number => typeof v === "number"),
      ),
      execute: stats(
        list
          .map((r) => (r.stages as Record<string, unknown> | undefined)?.executeMs)
          .filter((v): v is number => typeof v === "number"),
      ),
      settle: stats(
        list
          .map((r) => (r.stages as Record<string, unknown> | undefined)?.settleMs)
          .filter((v): v is number => typeof v === "number"),
      ),
    });
  }
  rows.sort((a, b) => a.phase.localeCompare(b.phase) || a.scenario.localeCompare(b.scenario));

  // ---- aggregate --------------------------------------------------------------
  const completedAll = executions.filter(
    (r) => str(r.outcome) === "COMPLETED" && str(r.phase) !== "warmup",
  );
  const aggregate = {
    totalExecutions: executions.length,
    campaignExecutions: executions.filter((r) => str(r.phase) !== "warmup").length,
    completed: completedAll.length,
    failed: executions.filter((r) => str(r.outcome) === "FAILED").length,
    denied: executions.filter((r) => str(r.outcome) === "DENIED").length,
    timeouts: executions.filter((r) => str(r.outcome) === "TIMEOUT").length,
    endToEnd: stats(completedAll.map((r) => num(r.totalMs))),
    stages: {
      create: stats(completedAll.map((r) => num(r.createMs))),
      progression: stats(completedAll.map((r) => num(r.progressMs))),
      claim: stats(
        completedAll
          .map((r) => (r.stages as Record<string, unknown> | undefined)?.claimMs)
          .filter((v): v is number => typeof v === "number"),
      ),
      execute: stats(
        completedAll
          .map((r) => (r.stages as Record<string, unknown> | undefined)?.executeMs)
          .filter((v): v is number => typeof v === "number"),
      ),
      settle: stats(
        completedAll
          .map((r) => (r.stages as Record<string, unknown> | undefined)?.settleMs)
          .filter((v): v is number => typeof v === "number"),
      ),
    },
  };

  // ---- queue depth ---------------------------------------------------------------
  const depthValues = queueDepth.map((sample) => num(sample.pending));
  const queueDepthStats = {
    samples: queueDepth.length,
    ...stats(depthValues),
  };

  // ---- observability ------------------------------------------------------------
  const observabilityStats = {
    samples: observability.length,
    byPath: observability.reduce<Record<string, number>>((acc, sample) => {
      const path = str(sample.path);
      acc[path] = (acc[path] ?? 0) + 1;
      return acc;
    }, {}),
    totalBytes: observability.reduce((acc, sample) => acc + num(sample.bytes), 0),
  };

  // ---- the durable PostgreSQL state ----------------------------------------------
  const databaseUrl = process.env.ZECK_DATABASE_URL;
  let durable: Record<string, unknown> = {};
  if (databaseUrl !== undefined && databaseUrl.length > 0) {
    const db = new PgDatabasePort(
      parseConnectionConfig(databaseUrl, { max: 4, connectionTimeoutMillis: 8000 }),
    );
    try {
      const executionsByStatus = await db.execute<{ status: string; count: string }>({
        sql: "SELECT status, count(*) AS count FROM executions.executions GROUP BY status ORDER BY count DESC",
        parameters: [],
      });
      const envelopes = await db.execute<{ state: string; count: string }>({
        sql: "SELECT state, count(*) AS count FROM queue_transport.dispatch_envelopes GROUP BY state",
        parameters: [],
      });
      const deliveryStats = await db.execute<{
        redelivered: string;
        avg_attempts: string | null;
        max_attempts: string | null;
      }>({
        sql: `SELECT count(*) FILTER (WHERE delivery_attempts > 1) AS redelivered,
                     round(avg(delivery_attempts), 2) AS avg_attempts,
                     max(delivery_attempts) AS max_attempts
              FROM queue_transport.dispatch_envelopes`,
        parameters: [],
      });
      const deadLetters = await db.execute<{ count: string }>({
        sql: "SELECT count(*) AS count FROM queue_transport.dead_letters",
        parameters: [],
      });
      const workers = await db.execute<{
        worker_id: string;
        status: string;
        heartbeat_count: number;
        registered_at: Date;
        last_heartbeat_at: Date;
      }>({
        sql: `SELECT worker_id, status, heartbeat_count, registered_at, last_heartbeat_at
              FROM compute_plane.worker_registrations ORDER BY registered_at`,
        parameters: [],
      });
      const claims = await db.execute<{
        claims: string;
        finished: string;
        abandoned: string;
        avg_claim_ms: string | null;
        max_claim_ms: string | null;
      }>({
        sql: `SELECT count(*) AS claims,
                     count(*) FILTER (WHERE status = 'finished') AS finished,
                     count(*) FILTER (WHERE status = 'abandoned') AS abandoned,
                     round(avg(EXTRACT(EPOCH FROM (finished_at - claimed_at)) * 1000)) AS avg_claim_ms,
                     max(EXTRACT(EPOCH FROM (finished_at - claimed_at)) * 1000) AS max_claim_ms
              FROM compute_plane.worker_claims`,
        parameters: [],
      });
      const wallets = await db.execute<{
        id: string;
        owner_kind: string;
        balance_micro_usd: string;
      }>({
        sql: `SELECT id, owner_kind, balance_micro_usd FROM budgets.wallets
              WHERE application_id = (SELECT application_id FROM sandbox.compute_environments WHERE slug = 'd08-standard' LIMIT 1)`,
        parameters: [],
      });
      const ledger = await db.execute<{
        entry_class: string;
        direction: string;
        total: string;
        count: string;
      }>({
        sql: `SELECT entry_class, direction, sum(amount_micro_usd) AS total, count(*) AS count
              FROM budgets.ledger_entries GROUP BY entry_class, direction ORDER BY entry_class`,
        parameters: [],
      });
      const reservations = await db.execute<{ status: string; count: string }>({
        sql: "SELECT status, count(*) AS count FROM budgets.reservations GROUP BY status",
        parameters: [],
      });
      const planningDecisions = await db.execute<{ count: string }>({
        sql: "SELECT count(*) AS count FROM execution_ir.optimization_decision_records",
        parameters: [],
      });
      durable = {
        executionsByStatus: executionsByStatus.rows.map((r) => ({
          status: r.status,
          count: r.count,
        })),
        dispatchEnvelopes: envelopes.rows.map((r) => ({ state: r.state, count: r.count })),
        delivery: deliveryStats.rows[0] ?? null,
        deadLetters: deadLetters.rows[0]?.count ?? "0",
        workers: workers.rows.map((r) => ({
          workerId: r.worker_id,
          status: r.status,
          heartbeats: r.heartbeat_count,
          registeredAt: r.registered_at.toISOString(),
          lastHeartbeatAt: r.last_heartbeat_at.toISOString(),
          activeSeconds: round((r.last_heartbeat_at.getTime() - r.registered_at.getTime()) / 1000),
          meanHeartbeatIntervalMs:
            r.heartbeat_count > 0
              ? round(
                  (r.last_heartbeat_at.getTime() - r.registered_at.getTime()) / r.heartbeat_count,
                )
              : null,
        })),
        claims: claims.rows[0] ?? null,
        wallets: wallets.rows.map((r) => ({
          walletId: r.id,
          ownerKind: r.owner_kind,
          balanceMicroUsd: r.balance_micro_usd,
        })),
        budgetLedger: ledger.rows.map((r) => ({
          entryClass: r.entry_class,
          direction: r.direction,
          totalMicroUsd: r.total,
          entries: r.count,
        })),
        reservations: reservations.rows.map((r) => ({ status: r.status, count: r.count })),
        planningDecisions: planningDecisions.rows[0]?.count ?? "0",
      };
    } finally {
      await db.close();
    }
  }

  // ---- write + print -----------------------------------------------------------
  const summary = {
    generatedAt: new Date().toISOString(),
    aggregate,
    rows,
    queueDepth: queueDepthStats,
    observability: observabilityStats,
    durable,
  };
  writeFileSync(join(DATA_DIR, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  console.log("\n=== D-08 campaign summary ===");
  console.log(
    `executions: ${aggregate.campaignExecutions} (warmup excluded; ${aggregate.totalExecutions} raw lines)`,
  );
  console.log(
    `outcomes: ${aggregate.completed} COMPLETED · ${aggregate.failed} FAILED · ${aggregate.denied} DENIED · ${aggregate.timeouts} TIMEOUT`,
  );
  console.log(
    `end-to-end (completed): p50 ${aggregate.endToEnd.p50}ms · p90 ${aggregate.endToEnd.p90}ms · p99 ${aggregate.endToEnd.p99}ms · avg ${aggregate.endToEnd.avg}ms`,
  );
  console.log(
    `stages (completed): create p50 ${aggregate.stages.create.p50}ms · progression p50 ${aggregate.stages.progression.p50}ms · claim p50 ${aggregate.stages.claim.p50}ms · execute p50 ${aggregate.stages.execute.p50}ms · settle p50 ${aggregate.stages.settle.p50}ms`,
  );
  console.log(
    `queue depth: samples ${queueDepthStats.samples} · p50 ${queueDepthStats.p50} · p90 ${queueDepthStats.p90} · p99 ${queueDepthStats.p99} · max ${queueDepthStats.max}`,
  );
  console.log(
    `observability: ${observabilityStats.samples} OTLP export samples · ${observabilityStats.totalBytes} bytes · paths ${JSON.stringify(observabilityStats.byPath)}`,
  );
  console.log("per-scenario rows:");
  for (const row of rows) {
    console.log(
      `  ${row.phase} c=${String(row.concurrency).padStart(2)} ${row.scenario.padEnd(28)} ` +
        `n=${String(row.executions).padStart(3)} ok=${String(row.completed).padStart(3)} ` +
        `fail=${String(row.failed).padStart(2)} denied=${String(row.denied).padStart(2)} ` +
        `| total p50/p90/p99 ${String(row.total.p50).padStart(7)}/${String(row.total.p90).padStart(7)}/${String(row.total.p99).padStart(7)}ms`,
    );
  }
  console.log(`summary written: ${join(DATA_DIR, "summary.json")}`);
}
