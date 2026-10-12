/**
 * The economic-recovery-plan-evaluation CLI entry (PCR-003).
 *
 * Usage:
 *   bun run benchmarks/validation/apps/economic-recovery-plan-evaluation/run.ts           # the full evaluation + the reproducibility re-run
 *   bun run benchmarks/validation/apps/economic-recovery-plan-evaluation/run.ts single    # the full evaluation once (no re-run)
 *
 * Runs the three-arm replay evaluation over the targeted multi-provider
 * cell family (all three arms FRESH at this revision), writes the
 * committed artifacts under results/ (per-cell results with the full
 * per-attempt evidence, the aggregate, and the threshold report), and
 * verifies reproducibility by RE-RUNNING the complete evaluation and
 * comparing the evaluation digests (identical required — the
 * deterministic replay discipline).
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runRecoveryPlanEvaluation } from "./application";
import { TARGETED_CELLS } from "./corpus";
import { aggregateEvaluation, type CellEvaluationResult } from "./driver";
import { renderThresholdReport } from "./report";

const RESULTS_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "results");
const CELLS_ROOT = join(RESULTS_ROOT, "cells");

/** The current run revision (the git HEAD this evaluation runs at). */
function runRevision(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unavailable (not a git worktree)";
  }
}

/**
 * Format the committed artifacts through the repository's OWN formatter
 * (the pinned @biomejs/biome toolchain — the canonical authority for the
 * repository's committed JSON, the established apps' config.json
 * convention: collapsed short arrays, the repo formatter's layout). The
 * formatting changes BYTES only — never values — so the evaluation digests
 * (computed over the measured values) are unaffected. Fail-closed: the
 * artifacts are committed in the canonical form or the run fails with a
 * typed error (never a silently non-canonical artifact set).
 */
function formatArtifactsCanonically(): void {
  try {
    execSync(`bunx biome format --write "${RESULTS_ROOT}"`, {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    throw new Error(
      `the repository's own formatter (biome) failed on the results directory — the artifacts cannot be written in the canonical committed form: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function runOnce(label: string): Promise<{
  readonly cells: readonly CellEvaluationResult[];
  readonly digest: string;
  readonly corpusDigest: string;
  readonly runStartedAt: string;
  readonly wallMs: number;
}> {
  const startedAt = Date.now();
  console.log(
    `[pcr-003] running the three-arm evaluation over ${TARGETED_CELLS.length} targeted multi-provider cells (${label})…`,
  );
  const result = await runRecoveryPlanEvaluation({
    onCell: (cell, index, total) => {
      console.log(
        `[pcr-003] (${label}) cell ${index}/${total}: ${cell.cellId} — mediated ${cell.arms["mediated-with-plan"].tasksResolved}/${cell.arms["mediated-with-plan"].tasksTotal}, optimized ${cell.arms["strong-optimized"].tasksResolved}/${cell.arms["strong-optimized"].tasksTotal}, direct ${cell.arms["un-retried-direct"].tasksResolved}/${cell.arms["un-retried-direct"].tasksTotal}, plans ${cell.plans.length}, violations ${cell.violations.length} (${cell.wallMs} ms)`,
      );
    },
  });
  const wallMs = Date.now() - startedAt;
  console.log(
    `[pcr-003] (${label}) complete in ${wallMs} ms — evaluation digest ${result.aggregate.digest}`,
  );
  return {
    cells: result.aggregate.cells,
    digest: result.aggregate.digest,
    corpusDigest: result.corpusDigest,
    runStartedAt: result.runStartedAt,
    wallMs,
  };
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "full";
  const revision = runRevision();
  const first = await runOnce("run 1");

  mkdirSync(CELLS_ROOT, { recursive: true });
  for (const cell of first.cells) {
    writeFileSync(
      join(CELLS_ROOT, `${cell.cellId}.json`),
      `${JSON.stringify(cell, null, 2)}\n`,
      "utf8",
    );
  }

  // Re-aggregate from the run-1 cells (pure derivation — identical inputs).
  const fullAggregate = aggregateEvaluation([...first.cells]);

  let reRunDigest: string | null = null;
  let reRunWallMs: number | null = null;
  if (mode !== "single") {
    const second = await runOnce("re-run");
    reRunDigest = second.digest;
    reRunWallMs = second.wallMs;
    if (reRunDigest !== first.digest) {
      console.error(
        `[pcr-003] REPRODUCIBILITY FAILURE: the re-run digest ${reRunDigest} diverges from ${first.digest}`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        "[pcr-003] reproducibility verified: the re-run reproduced the evaluation digest byte-for-byte",
      );
    }
  }

  const perCellTable = first.cells.map((cell) => ({
    cellId: cell.cellId,
    mediatedTasksResolved: cell.arms["mediated-with-plan"].tasksResolved,
    mediatedTasksTotal: cell.arms["mediated-with-plan"].tasksTotal,
    optimizedTasksResolved: cell.arms["strong-optimized"].tasksResolved,
    optimizedTasksTotal: cell.arms["strong-optimized"].tasksTotal,
    directTasksResolved: cell.arms["un-retried-direct"].tasksResolved,
    directTasksTotal: cell.arms["un-retried-direct"].tasksTotal,
  }));

  const report = renderThresholdReport({
    aggregate: fullAggregate,
    corpusDigest: first.corpusDigest,
    runRevision: revision,
    runStartedAt: first.runStartedAt,
    reRunDigest,
    perCellTable,
  });
  writeFileSync(join(RESULTS_ROOT, "threshold-report.md"), report, "utf8");

  const aggregateArtifact = {
    ...fullAggregate,
    cells: fullAggregate.cells.map((cell) => ({
      cellId: cell.cellId,
      capstoneCellId: cell.capstoneCellId,
      subjectId: cell.subjectId,
      dimensions: cell.dimensions,
      corpus: cell.corpus,
      arms: cell.arms,
      plansSummary: {
        composed: cell.plans.length,
        decisionRecords: cell.decisionRecordCount,
      },
      violations: cell.violations,
      digest: cell.digest,
      wallMs: cell.wallMs,
      notes: cell.notes,
    })),
    reproducibility: {
      runDigest: first.digest,
      reRunDigest,
      reRunIdentical: reRunDigest === null ? null : reRunDigest === first.digest,
      runWallMs: first.wallMs,
      reRunWallMs,
    },
    runMetadata: {
      runRevision: revision,
      runStartedAt: first.runStartedAt,
      targetedCells: TARGETED_CELLS.length,
    },
  };
  writeFileSync(
    join(RESULTS_ROOT, "evaluation-aggregate.json"),
    `${JSON.stringify(aggregateArtifact, null, 2)}\n`,
    "utf8",
  );
  formatArtifactsCanonically();
  console.log(
    `[pcr-003] artifacts written under results/ (threshold-report.md, evaluation-aggregate.json, cells/*.json)`,
  );
}

await main();
