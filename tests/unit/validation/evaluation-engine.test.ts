/**
 * VAL-008 acceptance criteria 1-5: deterministic oracles execute
 * exactly; tolerance bands apply with recorded measurements; rubric
 * scoring records the judge configuration; the error taxonomy
 * dispatches mechanically; evaluation facts attach to run records.
 * Discrimination tests weaken each guarantee and prove rejection.
 */

import { describe, expect, test } from "vitest";
import { CORPUS_VERSION, GOLDEN_TASKS } from "../../../benchmarks/validation/corpus";
import type { GoldenTask } from "../../../benchmarks/validation/corpus/schema";
import {
  classifyFailure,
  evaluateRubric,
  evaluateRun,
  evaluationEventPayloads,
  type ObservedOutcome,
  parseToleranceBands,
} from "../../../benchmarks/validation/evaluation";
import { ValidationRecorder } from "../../../benchmarks/validation/recorder";
import type { RunMetadata } from "../../../benchmarks/validation/run-identity";

const REVISION = "90ceeddd1c6e5553254eaaade3155be391670787";

function taskByIdPrefix(prefix: string): GoldenTask {
  const task = GOLDEN_TASKS.find((candidate) => candidate.taskId.startsWith(prefix));
  if (task === undefined) {
    throw new Error(`no corpus task with prefix ${prefix}`);
  }
  return task;
}

const observedComplete: ObservedOutcome = {
  terminalStatus: "COMPLETED",
  verificationStatuses: ["PASS"],
  responseText: "The revenue increased; root cause was the pricing change.",
  outputShapeFields: ["invoiceId", "totalCents", "currency"],
  environmentEffects: [
    { kind: "artifact-created", assertion: "the output artifact is recorded", passed: true },
  ],
  retryableErrorsSurfaced: 0,
};

describe("validation: deterministic oracles (VAL-008 AC1)", () => {
  test("all oracles pass on a matching observation", () => {
    const task = taskByIdPrefix("structured.extract-invoice.v1#000");
    const result = evaluateRun({
      task,
      corpusVersion: CORPUS_VERSION,
      observed: observedComplete,
    });
    expect(result.verdict).toBe("pass");
    expect(result.classifications).toEqual([]);
  });

  test("a wrong terminal status fails the evaluation (discrimination)", () => {
    const task = taskByIdPrefix("structured.extract-invoice.v1#000");
    const result = evaluateRun({
      task,
      corpusVersion: CORPUS_VERSION,
      observed: { ...observedComplete, terminalStatus: "FAILED" },
    });
    expect(result.verdict).toBe("fail");
    expect(result.oracles.some((o) => o.oracle === "terminal-status" && !o.passed)).toBe(true);
  });

  test("a missing containsText needle fails (discrimination)", () => {
    const task = taskByIdPrefix("rag.kb-qa.v1#000"); // expects "enterprise"
    const result = evaluateRun({
      task,
      corpusVersion: CORPUS_VERSION,
      observed: { ...observedComplete, responseText: "I do not know." },
    });
    expect(result.verdict).toBe("fail");
    expect(result.oracles.some((o) => o.oracle.startsWith("contains-text") && !o.passed)).toBe(
      true,
    );
  });

  test("a missing output-shape field fails (discrimination)", () => {
    const task = taskByIdPrefix("structured.extract-invoice.v1#000");
    const result = evaluateRun({
      task,
      corpusVersion: CORPUS_VERSION,
      observed: { ...observedComplete, outputShapeFields: ["invoiceId"] },
    });
    expect(result.verdict).toBe("fail");
    expect(result.oracles.some((o) => o.oracle === "output-shape:totalCents" && !o.passed)).toBe(
      true,
    );
  });

  test("an unobserved environment effect fails and classifies (discrimination)", () => {
    const task = taskByIdPrefix("tools.single-tool.v1#000");
    const result = evaluateRun({
      task,
      corpusVersion: CORPUS_VERSION,
      observed: { ...observedComplete, environmentEffects: [] },
    });
    expect(result.verdict).toBe("fail");
    expect(result.classifications.some((c) => c.family === "environment-effect-failure")).toBe(
      true,
    );
  });
});

describe("validation: tolerance bands (VAL-008 AC2)", () => {
  test("numeric bands parse mechanically", () => {
    const bands = parseToleranceBands(
      "WER <= 0.05; onset within 150ms; duration within +/- 10 percent",
    );
    expect(bands.length).toBe(3);
    expect(bands.some((b) => b.operator === "<=" && b.bound === 0.05)).toBe(true);
    expect(bands.some((b) => b.operator === "within" && b.bound === 150)).toBe(true);
    expect(bands.some((b) => b.operator === "within-percent" && b.bound === 10)).toBe(true);
  });

  test("a tolerance task passes within its bands with recorded measurements", () => {
    const task = taskByIdPrefix("voice.transcribe-utterance.v1#000"); // WER <= 0.05
    const result = evaluateRun({
      task,
      corpusVersion: CORPUS_VERSION,
      observed: {
        ...observedComplete,
        responseText: "The meeting notes mention the meeting schedule.",
      },
      measurements: [{ name: "word-error-rate", value: 0.03, unit: "" }],
    });
    expect(result.tolerances.length).toBeGreaterThan(0);
    expect(result.tolerances.every((v) => v.measurement !== null)).toBe(true);
    expect(result.verdict).toBe("pass");
  });

  test("a measurement outside the band fails (discrimination)", () => {
    const task = taskByIdPrefix("voice.transcribe-utterance.v1#000");
    const result = evaluateRun({
      task,
      corpusVersion: CORPUS_VERSION,
      observed: {
        ...observedComplete,
        responseText: "The meeting notes mention the meeting schedule.",
      },
      measurements: [{ name: "word-error-rate", value: 0.2, unit: "" }],
    });
    expect(result.verdict).toBe("fail");
  });

  test("a missing measurement is INCONCLUSIVE, never a pass (discrimination)", () => {
    const task = taskByIdPrefix("voice.transcribe-utterance.v1#000");
    const result = evaluateRun({
      task,
      corpusVersion: CORPUS_VERSION,
      observed: {
        ...observedComplete,
        responseText: "The meeting notes mention the meeting schedule.",
      },
      measurements: [],
    });
    expect(result.verdict).toBe("inconclusive");
  });
});

describe("validation: rubric scoring (VAL-008 AC3)", () => {
  const task = taskByIdPrefix("text.summarize-doc.v1#000");
  const judge = {
    configuration: { judgeId: "judge-v1", configurationDigest: "sha256:" + "a".repeat(64) },
    verdicts: [
      { criterion: "faithfulness", score: 0.9, rationale: "traceable claims" },
      { criterion: "coherence", score: 0.8, rationale: "readable" },
      { criterion: "instruction-following", score: 1.0, rationale: "within bound" },
    ],
    threshold: 0.7,
  };

  test("a passing rubric records the judge configuration and weighted score", () => {
    const result = evaluateRun({
      task,
      corpusVersion: CORPUS_VERSION,
      observed: observedComplete,
      judge,
    });
    expect(result.rubric).not.toBeNull();
    expect(result.rubric?.passed).toBe(true);
    expect(result.rubric?.score).toBeCloseTo(0.5 * 0.9 + 0.25 * 0.8 + 0.25 * 1.0, 5);
    expect(result.rubric?.judge.configurationDigest).toMatch(/^sha256:/);
    expect(result.verdict).toBe("pass");
  });

  test("a below-threshold rubric fails (discrimination)", () => {
    const result = evaluateRun({
      task,
      corpusVersion: CORPUS_VERSION,
      observed: observedComplete,
      judge: {
        ...judge,
        verdicts: judge.verdicts.map((v) => ({ ...v, score: 0.1 })),
      },
    });
    expect(result.rubric?.passed).toBe(false);
    expect(result.verdict).toBe("fail");
  });

  test("a missing judge verdict rejects the evaluation (discrimination)", () => {
    expect(() =>
      evaluateRubric(
        task.qualityRubric,
        [{ criterion: "faithfulness", score: 1, rationale: "x" }],
        judge.configuration,
        0.7,
      ),
    ).toThrow(/missing judge verdict/);
  });

  test("an out-of-range judge score rejects the evaluation (discrimination)", () => {
    expect(() =>
      evaluateRubric(
        task.qualityRubric,
        [...judge.verdicts.slice(1), { criterion: "faithfulness", score: 1.5, rationale: "x" }],
        judge.configuration,
        0.7,
      ),
    ).toThrow(/\[0,1\]/);
  });
});

describe("validation: error taxonomy (VAL-008 AC4)", () => {
  test("surfaced provider error codes dispatch mechanically to the provider family", () => {
    const out = classifyFailure({
      terminalStatus: "FAILED",
      failedAssertions: ["terminal-status"],
      surfacedErrorCodes: ["PROVIDER_ERROR"],
      failedEnvironmentEffects: [],
    });
    expect(out.some((c) => c.family === "provider-limitation")).toBe(true);
  });

  test("quality-oracle failures with a healthy platform dispatch to the model family", () => {
    const out = classifyFailure({
      terminalStatus: "COMPLETED",
      failedAssertions: ["contains-text:enterprise"],
      surfacedErrorCodes: [],
      failedEnvironmentEffects: [],
    });
    expect(out.some((c) => c.family === "model-limitation")).toBe(true);
  });

  test("unobserved effects dispatch to the effect family", () => {
    const out = classifyFailure({
      terminalStatus: "COMPLETED",
      failedAssertions: [],
      surfacedErrorCodes: [],
      failedEnvironmentEffects: ["one output artifact recorded"],
    });
    expect(out.every((c) => c.family === "environment-effect-failure")).toBe(true);
  });

  test("signal-less failures dispatch to the harness family", () => {
    const out = classifyFailure({
      terminalStatus: "COMPLETED",
      failedAssertions: [],
      surfacedErrorCodes: [],
      failedEnvironmentEffects: [],
    });
    expect(out.some((c) => c.family === "test-harness-defect")).toBe(true);
  });

  test("terminal failure without code signals defaults to the platform family for inspection", () => {
    const out = classifyFailure({
      terminalStatus: "FAILED",
      failedAssertions: ["terminal-status"],
      surfacedErrorCodes: [],
      failedEnvironmentEffects: [],
    });
    expect(out.some((c) => c.family === "zeck-defect")).toBe(true);
  });
});

describe("validation: evaluation facts attach to run records (VAL-008 AC5)", () => {
  const metadata: RunMetadata = {
    program: "zeck-validation",
    workOrder: "VAL-008",
    baseRevision: REVISION,
    applicationRevision: REVISION,
    corpusRevision: CORPUS_VERSION,
    integrationSurface: "sdk",
    environment: { runtime: "bun", toolchain: "vitest", database: "postgresql", configuration: {} },
    observedAt: "2026-09-11T22:30:00.000Z",
  };

  test("evaluation facts become trajectory events on a sealed record", () => {
    const result = evaluateRun({
      task: taskByIdPrefix("structured.extract-invoice.v1#000"),
      corpusVersion: CORPUS_VERSION,
      observed: { ...observedComplete, environmentEffects: [] },
    });
    expect(result.verdict).toBe("fail");
    const payloads = evaluationEventPayloads(result);
    expect(payloads.some((p) => p.kind === "verification")).toBe(true);
    expect(payloads.some((p) => p.kind === "error-surfaced")).toBe(true);

    const recorder = new ValidationRecorder({
      metadata,
      corpusTaskId: result.taskId,
      environmentIdentity: "test",
    });
    recorder.recordEvent("run-start", { corpusTask: result.taskId });
    for (const payload of payloads) {
      recorder.recordEvent(payload.kind, payload.data);
    }
    recorder.recordEvent("run-end", { terminalStatus: "COMPLETED" });
    const record = recorder.seal();
    const verification = record.trajectory.filter((event) => event.kind === "verification");
    expect(verification.length).toBeGreaterThanOrEqual(1);
    expect(verification[0]?.data.strategy).toBe("evaluation-engine:deterministic");
  });
});
