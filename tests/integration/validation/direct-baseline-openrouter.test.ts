/**
 * VAL-005 acceptance criteria 1, 4, 6 — the REAL direct-provider
 * baseline: corpus tasks executed through the provider's own chat
 * endpoint (OpenRouter, open-weights route) with the SAME evaluation
 * as a Zeck arm, over the SAME pinned task slice, with per-run
 * identities recorded. Skips with reason when the credential is
 * absent (NOT RUN boundary — never a fabricated baseline result).
 */

import { describe, expect, test } from "vitest";
import {
  type ComparisonPlan,
  directProviderBaseline,
  pinComparisonPlan,
  runDirectTask,
  verifyFairExecution,
} from "../../../benchmarks/validation/comparators";
import { CORPUS_VERSION, GOLDEN_TASKS, taskById } from "../../../benchmarks/validation/corpus";
import { evaluateRun } from "../../../benchmarks/validation/evaluation";
import { deriveRunId, type RunMetadata } from "../../../benchmarks/validation/run-identity";

const REVISION = "90ceeddd1c6e5553254eaaade3155be391670787";
const SLICE_PREFIX = "text.summarize-doc.v1#00";
const SLICE_SIZE = 3;
const DOCUMENT_CONTENT =
  "Quarterly synthetic report: revenue grew 12 percent quarter over quarter. " +
  "The root cause was the pricing change introduced in June. Support volume " +
  "stayed flat while the release cadence doubled. Decision: keep the pricing.";

function plan(): ComparisonPlan {
  const taskIds = GOLDEN_TASKS.filter((task) => task.taskId.startsWith(SLICE_PREFIX))
    .slice(0, SLICE_SIZE)
    .map((task) => task.taskId);
  return {
    arms: [
      { name: "zeck", kind: "zeck", integrationSurface: "sdk" },
      {
        name: "direct-openrouter",
        kind: "direct-provider",
        integrationSurface: "provider:openrouter",
      },
    ],
    taskIds,
    threshold: { rubricPass: 0.7, maxTerminalFailureRate: 0.34, maxLatencyMs: 60000 },
    declaredAt: "2026-09-11T23:20:00.000Z",
  };
}

describe("validation: real direct-provider baseline over OpenRouter (VAL-005 AC1/4)", () => {
  test("the pinned plan covers both arms on the same slice", () => {
    const pinned = pinComparisonPlan(plan());
    expect(pinned.plan.taskIds.length).toBe(SLICE_SIZE);
    expect(pinned.plan.arms[1]?.integrationSurface).toBe("provider:openrouter");
  });

  test("direct baseline executes the slice through the provider's own endpoint (NOT RUN without the credential)", async () => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      console.info("[VAL-005] NOT RUN: direct-openrouter — set OPENROUTER_API_KEY");
      return;
    }
    const pinned = pinComparisonPlan(plan());
    const template = directProviderBaseline({
      provider: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model: "qwen/qwen-2.5-7b-instruct",
    });

    const executedTaskIds: string[] = [];
    for (const taskId of pinned.plan.taskIds) {
      const task = taskById(taskId);
      if (task === undefined) {
        throw new Error(`planned task missing from the corpus: ${taskId}`);
      }
      const metadata: RunMetadata = {
        program: "zeck-validation",
        workOrder: "VAL-005",
        baseRevision: REVISION,
        applicationRevision: REVISION,
        corpusRevision: CORPUS_VERSION,
        integrationSurface: template.integrationSurface,
        environment: {
          runtime: `node ${process.version}`,
          toolchain: "vitest",
          database: "none",
          configuration: { arm: template.arm, corpusTask: task.taskId },
        },
        observedAt: new Date().toISOString(),
      };
      const report = await runDirectTask({
        template,
        task,
        documentContent: DOCUMENT_CONTENT,
        transport: async (request) => {
          const started = Date.now();
          const response = await globalThis.fetch(request.endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(request.payload),
            signal: AbortSignal.timeout(60000),
          });
          const text = response.ok
            ? (((await response.json()) as { choices?: { message?: { content?: string } }[] })
                .choices?.[0]?.message?.content ?? null)
            : null;
          console.info(
            `[VAL-005] direct-openrouter ${task.taskId} -> HTTP ${response.status} (${Date.now() - started}ms)`,
          );
          return {
            ok: response.ok,
            status: response.status,
            text,
            latencyMs: Date.now() - started,
          };
        },
        metadata,
      });
      executedTaskIds.push(task.taskId);
      expect(deriveRunId(report.metadata)).toMatch(/^val-run-[0-9a-f]{64}$/);
      const evaluation = evaluateRun({
        task,
        corpusVersion: CORPUS_VERSION,
        observed: report.observed,
      });
      console.info(
        `[VAL-005] evaluation ${task.taskId} -> ${evaluation.verdict} ` +
          `(${evaluation.oracles.filter((o) => o.passed).length}/${evaluation.oracles.length} oracles)`,
      );
      // a real provider run must be recorded honestly: any verdict is
      // valid evidence — but the response must have arrived.
      expect(report.observed.terminalStatus).toBe("COMPLETED");
    }

    const violations = verifyFairExecution(pinned, [
      { arm: template.arm, executedTaskIds, appliedThreshold: pinned.plan.threshold },
    ]);
    expect(violations).toEqual([]);
  });
});
