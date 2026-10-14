/**
 * The latency-tail-evaluation CLI entry (PCL-003).
 *
 * Usage:
 *   bun run benchmarks/validation/apps/latency-tail-evaluation/run.ts          # the full evaluation + the reproducibility re-run
 *   bun run benchmarks/validation/apps/latency-tail-evaluation/run.ts single   # the full evaluation once
 *
 * Runs the two-configuration paced replay evaluation over the complete
 * PPR-027 latency-cell sweep (102 cells, both arms FRESH at this
 * revision), writes the committed artifacts under
 * `experiments/pcl-003/results/` (per-cell results with the complete
 * typed-fact evidence, the aggregate with the mechanical promotion-gate
 * verdict, and the threshold report), and verifies reproducibility by
 * RE-RUNNING the complete evaluation and comparing the evaluation
 * digests (identical required — the deterministic replay discipline).
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runLatencyTailEvaluation } from "./application";
import { createNodeDigestPort } from "./canonical";
import { pinnedEvaluationCorpusDigest } from "./corpus";
import {
  type CellEvaluationResult,
  declaredThresholdsDigest,
  type EvaluationAggregate,
} from "./driver";
import { renderThresholdReport } from "./report";

const RESULTS_ROOT = fileURLToPath(
  new URL("../../../../experiments/pcl-003/results", import.meta.url),
);
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
 * The committed artifacts' spelling: COMPACT deterministic JSON (the
 * value-identical, byte-stable serialization). The PCR-003 biome-format
 * convention is consciously NOT applied to these artifacts: the
 * formatter's pretty layout expands the per-cell evidence (up to ~1.4
 * MiB) beyond the project's configured 1.0 MiB file-size bound, which
 * would introduce biome diagnostics on the committed evidence; the
 * compact spelling keeps every cell under the bound while changing
 * BYTES only — never values — so the evaluation digests (computed over
 * the measured values) are unaffected, and the same artifact object
 * always serializes byte-identically (JSON.stringify's deterministic
 * key order over the same construction path).
 */
function writeArtifact(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function runOnce(label: string): Promise<{
  readonly aggregate: EvaluationAggregate;
  readonly cells: readonly CellEvaluationResult[];
  readonly corpusDigest: string;
  readonly runStartedAt: string;
  readonly wallMs: number;
}> {
  const startedAt = Date.now();
  console.log(
    `[pcl-003] running the two-configuration evaluation over the 102 latency cells (${label})…`,
  );
  const result = await runLatencyTailEvaluation({
    onCell: (cell, index, total) => {
      console.log(
        `[pcl-003] (${label}) cell ${index}/${total}: ${cell.cellId} — baseline ${cell.arms.baseline.resolved}/${cell.arms.baseline.executions}, tuned ${cell.arms.tuned.resolved}/${cell.arms.tuned.executions}, verdict ${cell.cellVerdict.verdict} (${cell.cellVerdict.failingLegs.join(",") || "all legs pass"}) (${cell.wallMs} ms)`,
      );
    },
  });
  const wallMs = Date.now() - startedAt;
  console.log(
    `[pcl-003] (${label}) complete in ${wallMs} ms — evaluation digest ${result.aggregate.evaluationDigest}, gate ${result.aggregate.gate.verdict}`,
  );
  return {
    aggregate: result.aggregate,
    cells: result.cells,
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
    writeArtifact(join(CELLS_ROOT, `${cell.cellId}.json`), cell);
  }

  let reRunDigest: string | null = null;
  let reRunWallMs: number | null = null;
  if (mode !== "single") {
    const second = await runOnce("re-run");
    reRunDigest = second.aggregate.evaluationDigest;
    reRunWallMs = second.wallMs;
    if (reRunDigest !== first.aggregate.evaluationDigest) {
      console.error(
        `[pcl-003] REPRODUCIBILITY FAILURE: the re-run digest ${reRunDigest} diverges from ${first.aggregate.evaluationDigest}`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        "[pcl-003] reproducibility verified: the re-run reproduced the evaluation digest byte-for-byte",
      );
    }
  }

  const digestPort = createNodeDigestPort();
  const report = renderThresholdReport({
    aggregate: first.aggregate,
    cells: first.cells,
    runRevision: revision,
    runStartedAt: first.runStartedAt,
    reRunDigest,
    corpusDigest: first.corpusDigest,
    thresholdsDigest: declaredThresholdsDigest(digestPort),
  });
  writeFileSync(join(RESULTS_ROOT, "threshold-report.md"), report, "utf8");

  const aggregateArtifact = {
    ...first.aggregate,
    reproducibility: {
      runDigest: first.aggregate.evaluationDigest,
      reRunDigest,
      reRunIdentical:
        reRunDigest === null ? null : reRunDigest === first.aggregate.evaluationDigest,
      runWallMs: first.wallMs,
      reRunWallMs,
    },
    runMetadata: {
      runRevision: revision,
      runStartedAt: first.runStartedAt,
      targetedCells: first.cells.length,
      declaredThresholds: "experiments/pcl-003/declared-thresholds.json",
      corpusDigest: pinnedEvaluationCorpusDigest(digestPort),
      thresholdsDigest: declaredThresholdsDigest(digestPort),
    },
  };
  writeArtifact(join(RESULTS_ROOT, "evaluation-aggregate.json"), aggregateArtifact);
  console.log(
    "[pcl-003] artifacts written under experiments/pcl-003/results/ (threshold-report.md, evaluation-aggregate.json, cells/*.json — the compact deterministic spelling)",
  );
}

await main();
