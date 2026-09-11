/**
 * VAL-005 acceptance criteria 1-5: baseline templates, mechanical
 * fair-comparison guards, and identical-input/identical-evaluation
 * comparisons. Discrimination: post-hoc threshold drift, task
 * substitution, skipped tasks and undeclared arms are all rejected.
 */

import { describe, expect, test } from "vitest";
import {
  type ComparisonPlan,
  competingStackBaseline,
  declareCompetingStackNotRun,
  directProviderBaseline,
  optimizedBaseline,
  pinComparisonPlan,
  runDirectTask,
  taskSlice,
  verifyFairExecution,
} from "../../../benchmarks/validation/comparators";
import { CORPUS_VERSION, GOLDEN_TASKS, taskById } from "../../../benchmarks/validation/corpus";
import { evaluateRun } from "../../../benchmarks/validation/evaluation";
import type { RunMetadata } from "../../../benchmarks/validation/run-identity";

const REVISION = "90ceeddd1c6e5553254eaaade3155be391670787";

function sliceTaskIds(): readonly string[] {
  return GOLDEN_TASKS.filter((task) => task.taskId.startsWith("text.summarize-doc.v1#00"))
    .slice(0, 3)
    .map((task) => task.taskId);
}

function metadataFor(arm: string): RunMetadata {
  return {
    program: "zeck-validation",
    workOrder: "VAL-005",
    baseRevision: REVISION,
    applicationRevision: REVISION,
    corpusRevision: CORPUS_VERSION,
    integrationSurface: arm,
    environment: { runtime: "bun", toolchain: "vitest", database: "none", configuration: { arm } },
    observedAt: "2026-09-11T23:10:00.000Z",
  };
}

const plan: ComparisonPlan = {
  arms: [
    { name: "zeck", kind: "zeck", integrationSurface: "sdk" },
    {
      name: "direct-openrouter",
      kind: "direct-provider",
      integrationSurface: "provider:openrouter",
    },
  ],
  taskIds: [...sliceTaskIds()],
  threshold: { rubricPass: 0.7, maxTerminalFailureRate: 0.1, maxLatencyMs: 30000 },
  declaredAt: "2026-09-11T23:00:00.000Z",
};

describe("validation: comparison plan pinning (VAL-005 AC5)", () => {
  test("a plan pins with a digest and validates its terms", () => {
    const pinned = pinComparisonPlan(plan);
    expect(pinned.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(pinned)).toBe(true);
  });

  test("a single-arm plan is rejected (discrimination)", () => {
    expect(() =>
      pinComparisonPlan({
        ...plan,
        arms: [
          { name: "zeck", kind: "zeck", integrationSurface: "sdk" },
          { name: "zeck", kind: "zeck", integrationSurface: "sdk" },
        ],
      }),
    ).toThrow(/distinct arms/);
  });

  test("an empty task slice is rejected (discrimination)", () => {
    expect(() => pinComparisonPlan({ ...plan, taskIds: [] })).toThrow(/task slice/);
  });

  test("out-of-range thresholds are rejected (discrimination)", () => {
    expect(() =>
      pinComparisonPlan({ ...plan, threshold: { ...plan.threshold, rubricPass: 1.5 } }),
    ).toThrow(/\[0,1\]/);
    expect(() =>
      pinComparisonPlan({ ...plan, threshold: { ...plan.threshold, maxLatencyMs: 0 } }),
    ).toThrow(/positive/);
  });
});

describe("validation: fair-execution verification (VAL-005 AC5)", () => {
  test("identical slices and pinned thresholds pass", () => {
    const pinned = pinComparisonPlan(plan);
    const executed = [
      {
        arm: "zeck",
        executedTaskIds: [...pinned.plan.taskIds],
        appliedThreshold: pinned.plan.threshold,
      },
      {
        arm: "direct-openrouter",
        executedTaskIds: [...pinned.plan.taskIds],
        appliedThreshold: pinned.plan.threshold,
      },
    ];
    expect(verifyFairExecution(pinned, executed)).toEqual([]);
  });

  test("a substituted task is rejected (discrimination)", () => {
    const pinned = pinComparisonPlan(plan);
    const substituted = [...pinned.plan.taskIds];
    substituted[0] = "text.transform-tone.v1#000";
    const executed = [
      { arm: "zeck", executedTaskIds: substituted, appliedThreshold: pinned.plan.threshold },
      {
        arm: "direct-openrouter",
        executedTaskIds: [...pinned.plan.taskIds],
        appliedThreshold: pinned.plan.threshold,
      },
    ];
    const violations = verifyFairExecution(pinned, executed);
    expect(violations.some((v) => v.includes("unplanned task"))).toBe(true);
    expect(violations.some((v) => v.includes("skipped planned task"))).toBe(true);
  });

  test("post-hoc threshold drift is rejected (discrimination)", () => {
    const pinned = pinComparisonPlan(plan);
    const loosened = { ...pinned.plan.threshold, rubricPass: 0.5 };
    const executed = [
      {
        arm: "zeck",
        executedTaskIds: [...pinned.plan.taskIds],
        appliedThreshold: pinned.plan.threshold,
      },
      {
        arm: "direct-openrouter",
        executedTaskIds: [...pinned.plan.taskIds],
        appliedThreshold: loosened,
      },
    ];
    expect(
      verifyFairExecution(pinned, executed).some((v) => v.includes("differ from the pinned plan")),
    ).toBe(true);
  });

  test("an undeclared arm is rejected (discrimination)", () => {
    const pinned = pinComparisonPlan(plan);
    const executed = [
      {
        arm: "mystery-arm",
        executedTaskIds: [...pinned.plan.taskIds],
        appliedThreshold: pinned.plan.threshold,
      },
    ];
    expect(verifyFairExecution(pinned, executed).some((v) => v.includes("undeclared arm"))).toBe(
      true,
    );
  });
});

describe("validation: baseline templates (VAL-005 AC1/2/3)", () => {
  test("the direct-provider template documents its integration and builds neutral requests", () => {
    const template = directProviderBaseline({
      provider: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model: "qwen/qwen-2.5-7b-instruct",
    });
    expect(template.kind).toBe("direct-provider");
    expect(template.documentedOptimizations).toEqual([]);
    const task = taskById("text.summarize-doc.v1#000");
    if (task === undefined) {
      throw new Error("task missing");
    }
    const request = template.buildRequest(task, "doc content");
    expect(request.taskId).toBe("text.summarize-doc.v1#000");
    expect(request.endpoint).toContain("openrouter");
  });

  test("the optimized baseline documents and records its optimization set", () => {
    const { template, cache } = optimizedBaseline({
      provider: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model: "qwen/qwen-2.5-7b-instruct",
    });
    expect(template.documentedOptimizations.length).toBe(4);
    expect(cache.size).toBe(0);
  });

  test("the competing-stack template records NOT RUN with the exact access requirement", () => {
    const notRun = declareCompetingStackNotRun(
      "example-router",
      "an API credential for the example-router stack and a reachable endpoint",
    );
    expect(notRun.status).toBe("not-run");
    const template = competingStackBaseline({
      stack: "example-router",
      endpoint: "https://example.invalid/api",
      taskMapping: (task) => ({ goal: JSON.stringify(task.input) }),
    });
    expect(template.kind).toBe("competing-stack");
  });

  test("a fake-transport direct run evaluates through the shared engine (identical evaluation)", async () => {
    const template = directProviderBaseline({
      provider: "fake",
      endpoint: "https://fake.local/chat",
      model: "fake-model",
    });
    const task = taskById("text.summarize-doc.v1#000");
    if (task === undefined) {
      throw new Error("task missing");
    }
    const report = await runDirectTask({
      template,
      task,
      documentContent: "The revenue grew 12 percent. Root cause: pricing.",
      transport: async (request) => {
        expect(request.taskId).toBe(task.taskId);
        return { ok: true, status: 200, text: "Revenue grew; root cause: pricing.", latencyMs: 42 };
      },
      metadata: metadataFor("provider:fake"),
    });
    expect(report.observed.terminalStatus).toBe("COMPLETED");
    const evaluation = evaluateRun({
      task,
      corpusVersion: CORPUS_VERSION,
      observed: report.observed,
    });
    expect(evaluation.verdict).not.toBe("fail");
    expect(report.metadata.integrationSurface).toBe("provider:fake");
  });

  test("the task slice helper maps the corpus identity (AC4 identical inputs)", () => {
    const tasks = GOLDEN_TASKS.filter((task) =>
      task.taskId.startsWith("text.summarize-doc.v1#00"),
    ).slice(0, 3);
    expect(taskSlice(tasks)).toEqual(plan.taskIds);
  });
});
