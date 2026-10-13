/**
 * The semantic-fidelity evaluation CLI entry (PCS-004).
 *
 * Usage:
 *   bun run benchmarks/validation/apps/semantic-fidelity-evaluation/run.ts           # the full evaluation + the reproducibility re-run
 *   bun run benchmarks/validation/apps/semantic-fidelity-evaluation/run.ts single    # the full evaluation once (no re-run)
 *
 * Runs the complete evaluation over the committed corpus (the quality
 * fixtures, the gating controls, the replay lines), writes the
 * committed artifacts under results/ (the threshold report and the
 * evaluation aggregate), and verifies reproducibility by RE-RUNNING
 * the complete evaluation and comparing the evaluation digests
 * (identical required — the deterministic replay discipline).
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSemanticFidelityEvaluation } from "./application";
import { EVALUATION_ID, pinnedEvaluationCorpusDigest } from "./corpus";
import { renderThresholdReport } from "./report";

const RESULTS_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "results");

/** The current run revision (the git HEAD this evaluation runs at). */
function runRevision(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unavailable (not a git worktree)";
  }
}

/**
 * Format the committed artifacts through the repository's OWN
 * formatter (the pinned @biomejs/biome toolchain — the canonical
 * authority for the repository's committed JSON). The formatting
 * changes BYTES only — never values — so the evaluation digests
 * (computed over the measured values) are unaffected. Fail-closed:
 * the artifacts are committed in the canonical form or the run fails.
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

function runOnce(label: string): ReturnType<typeof runSemanticFidelityEvaluation> {
  console.log(`[pcs-004] running the semantic-fidelity evaluation (${label})…`);
  const run = runSemanticFidelityEvaluation();
  console.log(`[pcs-004] (${label}) complete — evaluation digest ${run.result.digest}`);
  return run;
}

function main(): void {
  const mode = process.argv[2] ?? "full";
  const revision = runRevision();
  const first = runOnce("run 1");

  let reRunDigest: string | null = null;
  if (mode !== "single") {
    const second = runOnce("re-run");
    reRunDigest = second.result.digest;
    if (reRunDigest !== first.result.digest) {
      console.error(
        `[pcs-004] REPRODUCIBILITY FAILURE: the re-run digest ${reRunDigest} diverges from ${first.result.digest}`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        "[pcs-004] reproducibility verified: the re-run reproduced the evaluation digest byte-for-byte",
      );
    }
  }

  mkdirSync(RESULTS_ROOT, { recursive: true });
  const report = renderThresholdReport({
    result: first.result,
    runRevision: revision,
    runStartedAt: first.runStartedAt,
    reRunDigest,
  });
  writeFileSync(join(RESULTS_ROOT, "threshold-report.md"), report, "utf8");

  const aggregateArtifact = {
    evaluationId: EVALUATION_ID,
    corpusDigest: first.corpusDigest,
    digest: first.result.digest,
    aggregate: first.result.aggregate,
    records: {
      fixtureRecords: first.result.fixtureRecords,
      controlRecords: first.result.controlRecords,
      replayRecords: first.result.replayRecords,
    },
    reproducibility: {
      runDigest: first.result.digest,
      reRunDigest,
      reRunIdentical: reRunDigest === null ? null : reRunDigest === first.result.digest,
    },
    runMetadata: {
      runRevision: revision,
      runStartedAt: first.runStartedAt,
      corpusRevisionPinnedDigest: pinnedEvaluationCorpusDigest(),
    },
  };
  writeFileSync(
    join(RESULTS_ROOT, "evaluation-aggregate.json"),
    `${JSON.stringify(aggregateArtifact, null, 2)}\n`,
    "utf8",
  );
  formatArtifactsCanonically();
  console.log(
    "[pcs-004] artifacts written under results/ (threshold-report.md, evaluation-aggregate.json)",
  );
}

main();
