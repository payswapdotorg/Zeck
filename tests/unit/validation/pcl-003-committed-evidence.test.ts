/**
 * The PCL-003 committed-evidence validation (work order PCL-003 — the
 * committed artifacts under experiments/pcl-003/).
 *
 * THE EVIDENCE LAW being pinned: the committed artifacts are the
 * delivery's evidence — this suite proves, over the COMMITTED bytes
 * (not a re-run), that:
 *
 *  - the complete 102-cell sweep is committed (one artifact per cell,
 *    the capstone's own enumeration), and the declared thresholds are
 *    the committed declarations (the gate module's mirror equals the
 *    committed file — the declared-before discipline's drift guard);
 *  - every committed fact block VALIDATES on the REAL
 *    `validateOutcomeLatencyFacts` (the PCL-001 plane's own fail-closed
 *    validator — the deterministic-replay identity makes this a
 *    validation of the committed evidence, the PCR-003 plan-artifact
 *    precedent);
 *  - every committed content address re-derives from the committed
 *    fact through the REAL canonical form and the digest port (the
 *    identity discipline);
 *  - every committed attempt re-derives from the transport's own pure
 *    draw functions (the self-verifying evidence: the draws key on
 *    stream key, attempt and provider — the corpus is rebuilt through
 *    the lab's shared seam and every attempt's latency, cost and
 *    failure class re-derive exactly);
 *  - every committed cell digest re-derives from the committed
 *    projection, and the committed EVALUATION aggregate re-aggregates
 *    from the committed cells byte-identically (the digest reproducibility
 *    over the committed evidence);
 *  - the recorded capstone-era results are quoted VERBATIM (the quote
 *    fields equal the committed ppr-027 cell file's own fields, byte
 *    for byte — never relabeled; the synthetic-supply basis preserved
 *    on every quote);
 *  - the threshold report carries the synthetic-supply labels and the
 *    honest NOT RUN boundaries with their owners.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createNodeDigestPort } from "../../../benchmarks/validation/apps/latency-tail-evaluation/canonical";
import {
  BASELINE_ARM,
  TUNED_ARM,
} from "../../../benchmarks/validation/apps/latency-tail-evaluation/configurations";
import { edgeOfRequest } from "../../../benchmarks/validation/apps/latency-tail-evaluation/corpus";
import {
  aggregateEvaluation,
  type CellEvaluationResult,
  cellDigestProjectionOf,
  declaredThresholdsDigest,
  evaluationCells,
  loadDeclaredThresholds,
} from "../../../benchmarks/validation/apps/latency-tail-evaluation/driver";
import { DECLARED_THRESHOLDS } from "../../../benchmarks/validation/apps/latency-tail-evaluation/gate";
import { buildCellCorpus, outcomeOf } from "../../../benchmarks/validation/apps/shared/seam";
import {
  canonicalOutcomeLatencyJson as realCanonical,
  validateOutcomeLatencyFacts,
} from "../../../src/modules/executions/domain/outcome-latency-facts";

const digestPort = createNodeDigestPort();
const RESULTS_ROOT = fileURLToPath(
  new URL("../../../experiments/pcl-003/results", import.meta.url),
);
const CELLS_ROOT = join(RESULTS_ROOT, "cells");
const DECLARED_THRESHOLDS_PATH = fileURLToPath(
  new URL("../../../experiments/pcl-003/declared-thresholds.json", import.meta.url),
);
const CAPSTONE_CELLS_ROOT = fileURLToPath(
  new URL("../../../experiments/ppr-027/results/cells", import.meta.url),
);

/** All committed cell artifacts, in enumeration order. */
function committedCells(): CellEvaluationResult[] {
  const enumeration = evaluationCells();
  return enumeration.map((cell) => {
    const path = join(CELLS_ROOT, `${cell.cellId}.json`);
    expect(existsSync(path), `the committed artifact for ${cell.cellId} must exist`).toBe(true);
    return JSON.parse(readFileSync(path, "utf8")) as CellEvaluationResult;
  });
}

describe("PCL-003: the committed evidence — the complete sweep, the declarations, and the artifact census", () => {
  test("the complete 102-cell sweep is committed (one artifact per cell of the capstone's own enumeration)", () => {
    const files = readdirSync(CELLS_ROOT).filter((name) => name.endsWith(".json"));
    expect(files.length).toBe(102);
    expect(committedCells().length).toBe(102);
  });

  test("the committed declarations equal the gate module's declared thresholds (the drift guard), and the declarations' digest binds into the aggregate", () => {
    const committed = JSON.parse(readFileSync(DECLARED_THRESHOLDS_PATH, "utf8"));
    expect(committed.t1Tail.rule).toBe(DECLARED_THRESHOLDS.t1Tail.rule);
    expect(committed.t2Resolution.rule).toBe(DECLARED_THRESHOLDS.t2Resolution.rule);
    expect(committed.t3Cost.rule).toBe(DECLARED_THRESHOLDS.t3Cost.rule);
    expect(committed.t3Cost.budgetDeltaFraction).toBe(
      DECLARED_THRESHOLDS.t3Cost.budgetDeltaFraction,
    );
    expect(committed.t4Preservation.rule).toBe(DECLARED_THRESHOLDS.t4Preservation.rule);
    const aggregate = JSON.parse(
      readFileSync(join(RESULTS_ROOT, "evaluation-aggregate.json"), "utf8"),
    ) as { thresholdsDigest: string; evaluationDigest: string };
    expect(aggregate.thresholdsDigest).toBe(declaredThresholdsDigest(digestPort));
    // The committed declarations load fail-closed through the driver.
    expect(loadDeclaredThresholds().t3Cost.budgetDeltaFraction).toBe(0.25);
  });
});

describe("PCL-003: the committed evidence — every fact validates on the REAL validator and every identity re-derives", () => {
  test("every committed fact block of both arms validates on the REAL PCL-001 fail-closed validator", () => {
    for (const cell of committedCells()) {
      for (const arm of [cell.evidence.baseline, cell.evidence.tuned]) {
        for (const execution of arm) {
          const verdict = validateOutcomeLatencyFacts(execution.facts);
          expect(
            verdict.valid,
            `${cell.cellId}/${execution.executionId} failed the REAL validator: ${verdict.valid ? "" : verdict.reason}`,
          ).toBe(true);
        }
      }
    }
  });

  test("every committed content address re-derives from the committed fact through the REAL canonical form", () => {
    for (const cell of committedCells()) {
      for (const arm of [cell.evidence.baseline, cell.evidence.tuned]) {
        for (const execution of arm) {
          const canonical = realCanonical(execution.facts as Parameters<typeof realCanonical>[0]);
          expect(
            execution.factsIdentity,
            `${cell.cellId}/${execution.executionId}: the identity must re-derive from the REAL canonical form`,
          ).toBe(digestPort.sha256Hex(canonical));
        }
      }
    }
  });
});

describe("PCL-003: the committed evidence — every attempt re-derives from the transport's pure draws (self-verifying)", () => {
  test("every committed attempt's latency, cost and failure class re-derive exactly from outcomeOf over the rebuilt corpus", () => {
    const enumeration = evaluationCells();
    for (const [index, cellArtifact] of committedCells().entries()) {
      const cell = enumeration[index] as (typeof enumeration)[number];
      expect(cell).toBeDefined();
      expect(cellArtifact.cellId).toBe(cell.cellId);
      const corpus = buildCellCorpus(cell.subject, cell.modality, cell.volume, cell.repetitions);
      const requestsByTask = new Map(corpus.map((task) => [task.taskId, task.requests]));
      for (const arm of [
        { records: cellArtifact.evidence.baseline, arm: BASELINE_ARM },
        { records: cellArtifact.evidence.tuned, arm: TUNED_ARM },
      ]) {
        for (const execution of arm.records) {
          const requests = requestsByTask.get(execution.taskId);
          expect(requests, `the corpus must rebuild ${execution.taskId}`).toBeDefined();
          const request = requests?.[execution.requestIndex];
          expect(request).toBeDefined();
          const edge = edgeOfRequest(cell.subject, request as never);
          for (const attempt of execution.attempts) {
            const drawn = outcomeOf({
              providerId: attempt.providerId,
              edge,
              request: request as never,
              streamKey: execution.streamKey,
              attempt: attempt.attempt,
            });
            expect(attempt.latencyMs).toBe(drawn.latencyMs);
            expect(attempt.costNanoUsd).toBe(drawn.costNanoUsd);
            if (drawn.ok === true) {
              expect(attempt.failureClass).toBeNull();
            } else {
              expect(attempt.failureClass).not.toBeNull();
            }
          }
        }
      }
    }
  });
});

describe("PCL-003: the committed evidence — the digests re-derive and the aggregate re-aggregates byte-identically", () => {
  test("every committed cell digest re-derives from the committed projection (wall-clock excluded by construction)", () => {
    for (const cell of committedCells()) {
      expect(cell.digest).toBe(digestPort.sha256Hex(cellDigestProjectionOf(cell)));
    }
  });

  test("the committed evaluation aggregate re-aggregates from the committed cells byte-identically (the digest + the gate verdict + the verdict tallies)", () => {
    const committedAggregate = JSON.parse(
      readFileSync(join(RESULTS_ROOT, "evaluation-aggregate.json"), "utf8"),
    ) as {
      evaluationDigest: string;
      corpusDigest: string;
      gate: { verdict: string };
      cellVerdicts: { passed: number; missed: number };
      reproducibility: {
        runDigest: string;
        reRunDigest: string | null;
        reRunIdentical: boolean | null;
      };
    };
    const reAggregated = aggregateEvaluation(committedCells(), {
      corpusDigest: committedAggregate.corpusDigest,
      thresholds: DECLARED_THRESHOLDS,
      thresholdsDigest: declaredThresholdsDigest(digestPort),
      digest: digestPort,
    });
    expect(reAggregated.evaluationDigest).toBe(committedAggregate.evaluationDigest);
    expect(reAggregated.gate.verdict).toBe(committedAggregate.gate.verdict);
    expect(reAggregated.cellVerdicts.passed).toBe(committedAggregate.cellVerdicts.passed);
    expect(reAggregated.cellVerdicts.missed).toBe(committedAggregate.cellVerdicts.missed);
    // The committed reproducibility record: the re-run reproduced the
    // digest byte-for-byte.
    expect(committedAggregate.reproducibility.reRunIdentical).toBe(true);
    expect(committedAggregate.reproducibility.reRunDigest).toBe(
      committedAggregate.reproducibility.runDigest,
    );
  });
});

describe("PCL-003: the committed evidence — the capstone quotes are VERBATIM and the honest labels present", () => {
  test("every recorded capstone-era quote equals the committed ppr-027 cell file's own fields, byte for byte (never relabeled)", () => {
    for (const cell of committedCells()) {
      const capstonePath = join(CAPSTONE_CELLS_ROOT, `${cell.cellId}.json`);
      expect(existsSync(capstonePath), `the capstone record for ${cell.cellId}`).toBe(true);
      const capstone = JSON.parse(readFileSync(capstonePath, "utf8")) as {
        zeck: {
          outcomes: { attempts: number; successes: number; failures: number };
          latency: {
            samples: number;
            medianMs: number | null;
            p95Ms: number | null;
            meanMs: number | null;
          };
          measurements: { entries: { dimension: string }[] };
        };
      };
      const entries = capstone.zeck.measurements.entries as unknown[];
      const latencyTail = entries.find(
        (entry) => (entry as { dimension: string }).dimension === "latency-tail",
      );
      expect(cell.recorded.recorded).toBe(true);
      expect(cell.recorded.latencyTail).toEqual(latencyTail);
      expect(cell.recorded.mediatedOutcomes).toEqual(capstone.zeck.outcomes);
      expect(cell.recorded.mediatedLatencySummary).toEqual(capstone.zeck.latency);
      expect(cell.recorded.basis).toContain("quoted VERBATIM");
      expect(cell.recorded.basis).toContain("synthetic-supply");
    }
  });

  test("the threshold report carries the synthetic-supply labels, the honest NOT RUN boundaries with owners, and the complete 102-row replay table", () => {
    const report = readFileSync(join(RESULTS_ROOT, "threshold-report.md"), "utf8");
    expect(report).toContain("# PCL-003 — Latency-Tail Evaluation: Threshold Report");
    expect(report).toContain("synthetic-supply");
    expect(report).toContain("synthetic-cost");
    expect(report).toContain("synthetic-latency");
    expect(report).toContain("NOT RUN boundaries (the honest spelling, with owners)");
    expect(report).toContain("operator-era obligation");
    expect(report).toContain("never backfilled");
    expect(report).toContain("VERBATIM");
    // The 102 per-cell rows (plus the header and separator).
    const rows = report
      .split("\n")
      .filter((line) => line.startsWith("| ") && line.includes(" cell-"));
    expect(rows.length).toBe(102);
    // The promotion gate's verdict is stated, never asserted: the legs
    // carry their numbers.
    expect(report).toContain("THE PROMOTION GATE");
    expect(report).toContain("### T1 —");
    expect(report).toContain("### T2 —");
    expect(report).toContain("### T3 —");
    expect(report).toContain("### T4 —");
  });
});
