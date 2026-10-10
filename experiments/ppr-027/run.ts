/**
 * PPR-027 — the study's CLI entry.
 *
 * Usage:
 *   bun run experiments/ppr-027/run.ts sweep      # the full sweep (resumable)
 *   bun run experiments/ppr-027/run.ts portability # the per-subject provider-portability probes
 *   bun run experiments/ppr-027/run.ts audit      # the thin-adapter audit
 *   bun run experiments/ppr-027/run.ts aggregate  # the portfolio aggregation (nine records)
 *   bun run experiments/ppr-027/run.ts all        # everything, in order
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditAllSubjectAdapters } from "./adapter-audit";
import { aggregatePortfolio } from "./aggregation";
import { computeObservedDistributions } from "./analysis";
import { SUBJECTS } from "./config";
import { RESULTS_ROOT, readCellResults, runPortabilityProbe, runSweep } from "./sweep";

const RESULTS_ROOT_PATH = RESULTS_ROOT;

async function main(): Promise<void> {
  const command = process.argv[2] ?? "all";
  if (command === "sweep" || command === "all") {
    console.log("[ppr-027] running the sweep (resumable — completed cells are skipped)…");
    const startedAt = Date.now();
    const summary = await runSweep({
      onCell: (result, index, total) => {
        console.log(
          `[ppr-027] cell ${index}/${total}: ${result.cellId} — zeck ${result.zeck.outcomes.successes}/${result.zeck.outcomes.attempts}, direct ${result.baselines.direct.tasksResolved}/${result.baselines.direct.tasksTotal}, optimized ${result.baselines.optimized.tasksResolved}/${result.baselines.optimized.tasksTotal} (${result.wallMs} ms)`,
        );
      },
    });
    console.log(
      `[ppr-027] sweep complete: completed=${summary.completedCells.length} skipped=${summary.skippedCells.length} failed=${summary.failedCells.length} planned=${summary.totalPlanned} in ${Date.now() - startedAt} ms`,
    );
    if (summary.failedCells.length > 0) {
      for (const failure of summary.failedCells) {
        console.error(`[ppr-027] FAILED cell ${failure.cellId}: ${failure.error}`);
      }
    }
  }
  if (command === "portability" || command === "all") {
    console.log("[ppr-027] running the provider-portability probes…");
    const probes = [];
    for (const subject of SUBJECTS) {
      const probe = await runPortabilityProbe(subject);
      probes.push(probe);
      console.log(
        `[ppr-027] portability ${probe.subjectId}: switchedWithoutAppChanges=${probe.switchedWithoutAppChanges} changedFiles=${probe.changedApplicationFiles} switchTimeMs=${probe.switchTimeMs}`,
      );
    }
    mkdirSync(RESULTS_ROOT_PATH, { recursive: true });
    writeFileSync(
      join(RESULTS_ROOT_PATH, "portability-probes.json"),
      `${JSON.stringify({ probes }, null, 2)}\n`,
      "utf8",
    );
  }
  if (command === "audit" || command === "all") {
    console.log("[ppr-027] running the thin-adapter audit…");
    const audits = auditAllSubjectAdapters();
    for (const audit of audits) {
      console.log(
        `[ppr-027] audit ${audit.subjectId}: verdict=${audit.verdict} adapterLines=${audit.adapterLinesTotal} delegationSites=${audit.delegationCallSites} forbidden=${audit.forbiddenFindings.length} disclosed=${audit.disclosedMechanisms.length}`,
      );
    }
    mkdirSync(RESULTS_ROOT_PATH, { recursive: true });
    writeFileSync(
      join(RESULTS_ROOT_PATH, "adapter-audit.json"),
      `${JSON.stringify({ audits }, null, 2)}\n`,
      "utf8",
    );
  }
  if (command === "aggregate" || command === "all") {
    console.log("[ppr-027] aggregating the nine delivered evidence records…");
    const aggregation = aggregatePortfolio();
    for (const record of aggregation.records) {
      console.log(
        `[ppr-027] ${record.workOrder} ${record.subjectId}: ${record.derivedStatus} (corpus ${record.corpusOutcomes.successes}/${record.corpusOutcomes.attempts}, delegated ${record.delegatedEdges}/${record.declaredEdges})`,
      );
    }
    console.log(`[ppr-027] tallies: ${JSON.stringify(aggregation.tallies)}`);
    mkdirSync(RESULTS_ROOT_PATH, { recursive: true });
    writeFileSync(
      join(RESULTS_ROOT_PATH, "portfolio-aggregation.json"),
      `${JSON.stringify(aggregation, null, 2)}\n`,
      "utf8",
    );
  }
  if (command === "analyze" || command === "all") {
    console.log("[ppr-027] deriving the observed distributions over the committed cells…");
    const cells = readCellResults();
    const distributions = computeObservedDistributions(cells);
    console.log(
      `[ppr-027] observed: ${distributions.cells} cells — zeck ${distributions.overall.zeck.resolved}/${distributions.overall.zeck.attempts} (${(distributions.overall.zeck.resolvedRate * 100).toFixed(1)}%), direct ${distributions.overall.direct.resolved}/${distributions.overall.direct.attempts} (${(distributions.overall.direct.resolvedRate * 100).toFixed(1)}%), optimized ${distributions.overall.optimized.resolved}/${distributions.overall.optimized.attempts} (${(distributions.overall.optimized.resolvedRate * 100).toFixed(1)}%)`,
    );
    console.log(
      `[ppr-027] microPerResolved (failure-adjusted, synthetic): zeck ${distributions.overall.zeck.microPerResolved?.toFixed(2)} vs direct ${distributions.overall.direct.microPerResolved?.toFixed(2)} vs optimized ${distributions.overall.optimized.microPerResolved?.toFixed(2)}`,
    );
    console.log(
      `[ppr-027] reuse ${distributions.reuse.replays}/${distributions.reuse.requests} (${(distributions.reuse.replayRate * 100).toFixed(1)}%); telemetry reconstructible ${distributions.telemetry.reconstructible}/${distributions.telemetry.traces}; canary blocked ${distributions.canary.blocked}/${distributions.canary.cells}`,
    );
    console.log(
      `[ppr-027] honest weaknesses: ${distributions.honestWeaknesses.cellsWithZeckTaskFailures} cell(s) with mediated-arm task failures; ${distributions.honestWeaknesses.cellsWhereABaselineResolvedMore} cell(s) where a baseline resolved more; zeck-vs-optimized resolution gap ${distributions.honestWeaknesses.zeckVsOptimizedResolutionGap}`,
    );
    mkdirSync(RESULTS_ROOT_PATH, { recursive: true });
    writeFileSync(
      join(RESULTS_ROOT_PATH, "observed-distributions.json"),
      `${JSON.stringify(distributions, null, 2)}\n`,
      "utf8",
    );
  }
  if (command === "cells") {
    const cells = readCellResults();
    console.log(`[ppr-027] ${cells.length} committed cell result(s) under results/cells/`);
  }
}

await main();
