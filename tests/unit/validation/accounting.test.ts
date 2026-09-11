/**
 * VAL-006 acceptance criteria 1-5: threshold-gated resolution,
 * measured-vs-estimated cost separation, confidence-bearing
 * aggregates, and the mechanical report feed. Discrimination:
 * below-threshold outcomes never resolve; estimate-only costs never
 * back cost-per-resolved; empty sets refuse aggregation.
 */

import { describe, expect, test } from "vitest";
import {
  type AccountedRun,
  aggregateArm,
  economicEntryOf,
  economicMarkdownRows,
  isResolvedOutcome,
  thresholdsFor,
  wilsonInterval,
} from "../../../benchmarks/validation/accounting";
import { CORPUS_VERSION, GOLDEN_TASKS, taskById } from "../../../benchmarks/validation/corpus";
import { evaluateRun } from "../../../benchmarks/validation/evaluation";
import {
  ValidationRecorder,
  type ValidationRunRecord,
} from "../../../benchmarks/validation/recorder";
import type { RunMetadata } from "../../../benchmarks/validation/run-identity";

const REVISION = "90ceeddd1c6e5553254eaaade3155be391670787";

function recordFor(input: {
  arm: string;
  latencyMs: number;
  retryable?: number;
  measuredMicroUsd?: string;
  estimateMicroUsd?: string;
}): ValidationRunRecord {
  const metadata: RunMetadata = {
    program: "zeck-validation",
    workOrder: "VAL-006",
    baseRevision: REVISION,
    applicationRevision: REVISION,
    corpusRevision: CORPUS_VERSION,
    integrationSurface: input.arm,
    environment: { runtime: "bun", toolchain: "vitest", database: "none", configuration: {} },
    observedAt: "2026-09-11T23:50:00.000Z",
  };
  const recorder = new ValidationRecorder({
    metadata,
    corpusTaskId: "text.summarize-doc.v1#000",
    environmentIdentity: "test",
  });
  recorder.recordEvent("run-start", { corpusTask: "x" });
  for (let index = 0; index < (input.retryable ?? 0); index += 1) {
    recorder.recordEvent("error-surfaced", { code: "PROVIDER_ERROR", retryable: true });
  }
  recorder.recordEvent("run-end", { terminalStatus: "COMPLETED" });
  if (input.measuredMicroUsd !== undefined) {
    recorder.recordCost({
      kind: "measured",
      amountMicroUsd: input.measuredMicroUsd,
      source: "ledger",
      scope: "direct-execution",
    });
  }
  if (input.estimateMicroUsd !== undefined) {
    recorder.recordCost({
      kind: "estimate",
      amountMicroUsd: input.estimateMicroUsd,
      source: "planner-quote",
      scope: "direct-execution",
    });
  }
  recorder.recordLatency({
    phase: "total",
    source: "harness-wallclock",
    milliseconds: input.latencyMs,
  });
  return recorder.seal();
}

function accountedRun(input: {
  arm: string;
  latencyMs: number;
  retryable?: number;
  measuredMicroUsd?: string;
  estimateMicroUsd?: string;
  responseText?: string;
}): AccountedRun {
  const record = recordFor(input);
  const task = taskById("text.summarize-doc.v1#000");
  if (task === undefined) {
    throw new Error("task missing");
  }
  const evaluation = evaluateRun({
    task,
    corpusVersion: CORPUS_VERSION,
    observed: {
      terminalStatus: "COMPLETED",
      verificationStatuses: ["PASS"],
      responseText:
        input.responseText ?? "The revenue increased; root cause was the pricing change.",
      outputShapeFields: [],
      environmentEffects: [],
      retryableErrorsSurfaced: input.retryable ?? 0,
    },
    judge: {
      configuration: { judgeId: "judge-v1", configurationDigest: "sha256:" + "a".repeat(64) },
      verdicts: task.qualityRubric.map((criterion, index) => ({
        criterion: criterion.name,
        score: index === 0 ? 0.9 : 0.8,
        rationale: "ok",
      })),
      threshold: 0.7,
    },
  });
  return { record, evaluation };
}

describe("validation: resolution thresholds (VAL-006 AC2)", () => {
  test("a passing evaluation within latency and error thresholds resolves", () => {
    expect(
      isResolvedOutcome(thresholdsFor(GOLDEN_TASKS[0]!), {
        evaluationVerdict: "pass",
        totalLatencyMs: 1000,
        retryableErrorsSurfaced: 0,
        failedSafetyObservations: 0,
      }),
    ).toBe(true);
  });

  test("a failed or inconclusive evaluation never resolves (discrimination)", () => {
    for (const verdict of ["fail", "inconclusive"] as const) {
      expect(
        isResolvedOutcome(thresholdsFor(GOLDEN_TASKS[0]!), {
          evaluationVerdict: verdict,
          totalLatencyMs: 1000,
          retryableErrorsSurfaced: 0,
          failedSafetyObservations: 0,
        }),
      ).toBe(false);
    }
  });

  test("a latency breach never resolves (discrimination)", () => {
    expect(
      isResolvedOutcome(thresholdsFor(GOLDEN_TASKS[0]!), {
        evaluationVerdict: "pass",
        totalLatencyMs: 60001,
        retryableErrorsSurfaced: 0,
        failedSafetyObservations: 0,
      }),
    ).toBe(false);
  });

  test("retryable errors and failed safety observations never resolve (discrimination)", () => {
    expect(
      isResolvedOutcome(thresholdsFor(GOLDEN_TASKS[0]!), {
        evaluationVerdict: "pass",
        totalLatencyMs: 1000,
        retryableErrorsSurfaced: 1,
        failedSafetyObservations: 0,
      }),
    ).toBe(false);
    expect(
      isResolvedOutcome(thresholdsFor(GOLDEN_TASKS[0]!), {
        evaluationVerdict: "pass",
        totalLatencyMs: 1000,
        retryableErrorsSurfaced: 0,
        failedSafetyObservations: 1,
      }),
    ).toBe(false);
  });
});

describe("validation: aggregates (VAL-006 AC1/3/4)", () => {
  test("cost per resolved outcome comes from MEASURED facts only", () => {
    const runs = [
      accountedRun({ arm: "a", latencyMs: 500, measuredMicroUsd: "900", estimateMicroUsd: "100" }),
      accountedRun({ arm: "a", latencyMs: 700, measuredMicroUsd: "300", estimateMicroUsd: "100" }),
    ];
    const aggregate = aggregateArm("a", "text.summarize-doc.v1", runs);
    expect(aggregate.runCount).toBe(2);
    expect(aggregate.resolvedCount).toBe(2);
    expect(aggregate.measuredCostMicroUsd).toBe("1200");
    expect(aggregate.estimatedCostMicroUsd).toBe("200");
    expect(aggregate.costPerResolvedMicroUsd).toBe("600");
    expect(aggregate.resolutionConfidence.low).toBeLessThan(1);
    expect(aggregate.resolutionConfidence.high).toBeLessThanOrEqual(1);
  });

  test("zero resolved outcomes yield NULL cost-per-resolved, never zero (discrimination)", () => {
    const runs = [
      accountedRun({ arm: "a", latencyMs: 500, measuredMicroUsd: "500", responseText: "wrong" }),
    ];
    const aggregate = aggregateArm("a", "text.summarize-doc.v1", runs);
    expect(aggregate.resolvedCount).toBe(0);
    expect(aggregate.costPerResolvedMicroUsd).toBeNull();
    expect(aggregate.measuredCostMicroUsd).toBe("500");
  });

  test("an empty run set refuses aggregation (discrimination)", () => {
    expect(() => aggregateArm("a", "slice", [])).toThrow(/empty run set/);
  });

  test("the Wilson interval widens for small samples", () => {
    const small = wilsonInterval(1, 2);
    const large = wilsonInterval(500, 1000);
    expect(small.high - small.low).toBeGreaterThan(large.high - large.low);
  });
});

describe("validation: report feed (VAL-006 AC5)", () => {
  test("aggregates convert to report entries and markdown rows mechanically", () => {
    const runs = [
      accountedRun({ arm: "direct-openrouter", latencyMs: 500, measuredMicroUsd: "400" }),
    ];
    const aggregate = aggregateArm("direct-openrouter", "text.summarize-doc.v1", runs);
    const entry = economicEntryOf(aggregate);
    expect(entry.arm).toBe("direct-openrouter");
    expect(entry.costPerResolvedMicroUsd).toBe("400");
    expect(entry.resolutionConfidence).toMatch(/^\[0\.\d{3}, 1\.000\]$/);
    const rows = economicMarkdownRows([entry]);
    expect(rows[0]).toContain("| Arm | Slice |");
    expect(rows[2]).toContain("| direct-openrouter | text.summarize-doc.v1 |");
  });

  test("no-resolved arms carry the explicit never-estimate-backed marker", () => {
    const runs = [
      accountedRun({ arm: "x", latencyMs: 500, measuredMicroUsd: "100", responseText: "wrong" }),
    ];
    const entry = economicEntryOf(aggregateArm("x", "slice", runs));
    expect(entry.costPerResolvedMicroUsd).toContain("never estimate-backed");
  });
});
