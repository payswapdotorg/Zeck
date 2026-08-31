/**
 * Benchmark report (WORK-016 — a PURE PROJECTION over the evidence).
 *
 * The report assembles the side-by-side comparison and strategy totals
 * from an immutable `BenchmarkEvidence` record. It is DATA ONLY: no
 * authority calls, no callbacks, no routing decisions — production
 * authority remains with the owning modules (the harness measures, the
 * report displays, nothing acts).
 */

import {
  BENCHMARK_STRATEGY_KINDS,
  type BenchmarkEvidence,
  type BenchmarkReport,
  type BenchmarkStrategyKind,
} from "./contract";

const strategyTotalsOf = (evidence: BenchmarkEvidence): BenchmarkReport["strategyTotals"] =>
  BENCHMARK_STRATEGY_KINDS.map((strategy: BenchmarkStrategyKind) => {
    const runs = evidence.runs.filter((run) => run.strategy === strategy);
    const completed = runs.filter((run) => run.status === "COMPLETED").length;
    const passOutcomes = runs
      .flatMap((run) => run.verificationOutcomes)
      .filter((outcome) => outcome === "PASS").length;
    const outcomes = runs.flatMap((run) => run.verificationOutcomes).length;
    return {
      strategy,
      runs: runs.length,
      successRate: runs.length === 0 ? 0 : completed / runs.length,
      passRate: outcomes === 0 ? 0 : passOutcomes / outcomes,
      meanWallClockMs:
        runs.length === 0
          ? 0
          : Math.round(
              (runs.reduce((total, run) => total + run.wallClockMs, 0) / runs.length) * 100,
            ) / 100,
    };
  });

const comparisonOf = (evidence: BenchmarkEvidence): BenchmarkReport["comparison"] => {
  const taskIds = [...new Set(evidence.runs.map((run) => run.taskId))];
  return taskIds.map((taskId) => ({
    taskId,
    rows: BENCHMARK_STRATEGY_KINDS.map((strategy) => {
      const summary = evidence.summaries.find(
        (candidate) => candidate.taskId === taskId && candidate.strategy === strategy,
      );
      const outcomes =
        summary === undefined
          ? 0
          : summary.passResults + summary.failResults + summary.inconclusiveResults;
      return {
        strategy,
        successRate:
          summary === undefined || summary.runs === 0 ? 0 : summary.completed / summary.runs,
        passRate: summary === undefined || outcomes === 0 ? 0 : summary.passResults / outcomes,
        meanWallClockMs: summary?.meanWallClockMs ?? 0,
        meanRetryEvents: summary?.meanRetryEvents ?? 0,
        settledCostMicroUsd: summary?.settledCostMicroUsd ?? null,
      };
    }),
  }));
};

/** Assemble the neutral report (pure function over the evidence). */
export function buildBenchmarkReport(evidence: BenchmarkEvidence): BenchmarkReport {
  return {
    evidence,
    comparison: comparisonOf(evidence),
    strategyTotals: strategyTotalsOf(evidence),
  };
}

/** Human-readable rendering (measurement display, nothing more). */
export function renderBenchmarkReport(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`# Benchmark report — ${report.evidence.label}`);
  lines.push("");
  lines.push(
    `Environment: wiring=${report.evidence.environment.wiring}; clock=${report.evidence.environment.clock}; repetitions=${report.evidence.environment.repetitions}`,
  );
  lines.push(`Verification provenance: ${report.evidence.environment.verificationProvenance}`);
  for (const note of report.evidence.environment.notes) {
    lines.push(`Note: ${note}`);
  }
  lines.push("");
  for (const task of report.comparison) {
    lines.push(`## Task ${task.taskId}`);
    lines.push("");
    lines.push(
      "| strategy | success rate | pass rate | mean wall-clock ms | mean retries | settled cost (µUSD) |",
    );
    lines.push("|---|---|---|---|---|---|");
    for (const row of task.rows) {
      lines.push(
        `| ${row.strategy} | ${row.successRate.toFixed(2)} | ${row.passRate.toFixed(2)} | ${row.meanWallClockMs} | ${row.meanRetryEvents} | ${row.settledCostMicroUsd ?? "—"} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Strategy totals (all tasks pooled)");
  lines.push("");
  lines.push("| strategy | runs | success rate | pass rate | mean wall-clock ms |");
  lines.push("|---|---|---|---|---|");
  for (const total of report.strategyTotals) {
    lines.push(
      `| ${total.strategy} | ${total.runs} | ${total.successRate.toFixed(2)} | ${total.passRate.toFixed(2)} | ${total.meanWallClockMs} |`,
    );
  }
  lines.push("");
  lines.push(
    "_Benchmark outputs are measurement evidence only — they carry no production authority (no provider authorization, no policy/budget/routing changes, no agent promotion, no verification mutation)._",
  );
  return lines.join("\n");
}
