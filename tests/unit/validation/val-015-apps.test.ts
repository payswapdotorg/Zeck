/**
 * VAL-015 acceptance criterion 1: the two imagegen customer
 * applications ride the public SDK boundary end to end against a
 * controlled fake transport (submission → async completion → result
 * retrieval → deterministic assertions → recorder-consumable evidence),
 * and their pinned task slices match the repository configuration files.
 * Discrimination: a FAILED platform outcome fails the healthy rows'
 * assertions (the application never passes a failed execution), while
 * the expected-failure edge rows (the empty prompt; the corrupted
 * source) EXPECT the honest failure — and a fabricated COMPLETED
 * outcome on an edge row FAILS the app's assertions.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  IMAGE_GENERATION_TASKS,
  runImageGenerationApp,
} from "../../../benchmarks/validation/apps/image-generation/application";
import {
  IMAGE_TRANSFORMATION_TASKS,
  runImageTransformationApp,
} from "../../../benchmarks/validation/apps/image-transformation/application";
import {
  generationPromptFixture,
  imageEditFixture,
  imageFixture,
} from "../../../benchmarks/validation/apps/shared/media";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";

const REVISION = "d3b76c384bbd716b6ebcdeed27974dcfbf6d273f";

/**
 * A minimal fake public API over the SDK's injected transport seam:
 * create → receipt, poll → terminal status, results → the packaged
 * outcome with the verification the fake platform recorded.
 */
function createFakeApiWorld(options: { readonly terminal: "COMPLETED" | "FAILED" }): {
  readonly transport: TransportImplementation;
} {
  const executions = new Map<string, { status: string }>();
  let sequence = 0;
  const transport: TransportImplementation = async (input: unknown, init?: unknown) => {
    const url = String(input);
    const method = String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    if (url.endsWith("/executions") && method === "POST") {
      sequence += 1;
      const id = `fake-exec-${sequence}`;
      executions.set(id, { status: "RUNNING" });
      return jsonResponse(201, {
        executionId: id,
        applicationId: "app-1",
        status: "RUNNING",
        createdAt: new Date().toISOString(),
        replayed: false,
        lastEventSequence: 1,
      });
    }
    const execMatch = url.match(/\/executions\/([^/]+)$/);
    if (execMatch !== null && method === "GET") {
      const execution = executions.get(execMatch[1] ?? "");
      if (execution === undefined)
        return jsonResponse(404, {
          code: "NOT_FOUND",
          message: "unknown execution",
          retryable: false,
        });
      execution.status = options.terminal;
      return jsonResponse(200, {
        id: execMatch[1],
        applicationId: "app-1",
        environmentId: null,
        status: execution.status,
        task: { kind: "generate-image", input: "x" },
        constraints: null,
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        terminalAt: options.terminal === "COMPLETED" ? new Date().toISOString() : null,
      });
    }
    const resultMatch = url.match(/\/executions\/([^/]+)\/results$/);
    if (resultMatch !== null) {
      const execution = executions.get(resultMatch[1] ?? "");
      if (execution === undefined)
        return jsonResponse(404, {
          code: "NOT_FOUND",
          message: "unknown execution",
          retryable: false,
        });
      const pass = options.terminal === "COMPLETED";
      return jsonResponse(200, {
        executionId: resultMatch[1],
        status: options.terminal,
        route: {
          provider: "fake-rail",
          model: "fake-model",
          strategyClass: "single-shot-imagegen",
          modelCalls: 1,
        },
        cost: pass ? { totalMicroUsd: "50", currency: "usd" } : null,
        usage: pass ? { inputTokens: 0, outputTokens: 1 } : null,
        outputArtifacts: [],
        verification: pass
          ? [
              {
                id: "v1",
                executionId: resultMatch[1],
                criterionId: "raster-container",
                strategy: "deterministic",
                status: "PASS",
                recordedBy: "fake-platform",
              },
            ]
          : [
              {
                id: "v1",
                executionId: resultMatch[1],
                criterionId: "provider-dispatch",
                strategy: "deterministic",
                status: "FAIL",
                recordedBy: "fake-platform",
              },
            ],
        warnings: [],
        terminalAt: new Date().toISOString(),
      });
    }
    return jsonResponse(500, {
      code: "INTERNAL",
      message: `unmapped fake route ${url}`,
      retryable: true,
    });
  };
  return { transport };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const RUN_OPTIONS = (transport: TransportImplementation) => ({
  config: {
    applicationId: "app-1",
    baseUrl: "http://fake.local",
    tokenEnvVar: "ZECK_VALIDATION_TOKEN",
    applicationRevision: REVISION,
    corpusRevision: REVISION,
    integrationSurface: "sdk" as const,
    pollIntervalMs: 1,
    completionTimeoutMs: 2000,
  },
  token: "test-token",
  transport,
  now: () => new Date(1_000_000),
  sleep: () => Promise.resolve(),
  environment: {
    runtime: "node test",
    toolchain: "vitest",
    database: "fake",
    configuration: {},
  },
  runSuffix: "unit",
});

describe("VAL-015 customer applications (public SDK boundary)", () => {
  test("the image-generation app completes end to end with valid evidence", async () => {
    const { transport } = createFakeApiWorld({ terminal: "COMPLETED" });
    const outcome = await runImageGenerationApp({ ...RUN_OPTIONS(transport), taskIndex: 0 });
    expect(outcome.passed).toBe(true);
    expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    expect(outcome.evidence.terminalStatus).toBe("COMPLETED");
    expect(outcome.evidence.request?.taskKind).toBe("generate-image");
  });

  test("the image-transformation app completes end to end with valid evidence", async () => {
    const { transport } = createFakeApiWorld({ terminal: "COMPLETED" });
    const outcome = await runImageTransformationApp({ ...RUN_OPTIONS(transport), taskIndex: 0 });
    expect(outcome.passed).toBe(true);
    expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    expect(outcome.evidence.terminalStatus).toBe("COMPLETED");
    expect(outcome.evidence.request?.taskKind).toBe("transform-image");
  });

  test("a FAILED platform outcome fails every healthy row's assertions (no silent pass)", async () => {
    const { transport } = createFakeApiWorld({ terminal: "FAILED" });
    const generation = await runImageGenerationApp({ ...RUN_OPTIONS(transport), taskIndex: 0 });
    expect(generation.passed).toBe(false);
    const transformation = await runImageTransformationApp({
      ...RUN_OPTIONS(transport),
      taskIndex: 0,
    });
    expect(transformation.passed).toBe(false);
  });

  test("the expected-failure edge rows EXPECT the honest failure (corpus expectation)", async () => {
    // A FAILED outcome is the CORRECT behavior for the edge rows: the apps pass.
    const failed = createFakeApiWorld({ terminal: "FAILED" });
    const emptyPrompt = await runImageGenerationApp({
      ...RUN_OPTIONS(failed.transport),
      taskIndex: 3,
    });
    expect(emptyPrompt.passed).toBe(true);
    expect(validateHarnessEvidence(emptyPrompt.evidence)).toEqual([]);
    const corruptSource = await runImageTransformationApp({
      ...RUN_OPTIONS(failed.transport),
      taskIndex: 3,
    });
    expect(corruptSource.passed).toBe(true);
    expect(validateHarnessEvidence(corruptSource.evidence)).toEqual([]);
    // A COMPLETED outcome on an edge row is a FORBIDDEN fabricated success.
    const completed = createFakeApiWorld({ terminal: "COMPLETED" });
    const fabricatedGeneration = await runImageGenerationApp({
      ...RUN_OPTIONS(completed.transport),
      taskIndex: 3,
    });
    expect(fabricatedGeneration.passed).toBe(false);
    const fabricatedTransformation = await runImageTransformationApp({
      ...RUN_OPTIONS(completed.transport),
      taskIndex: 3,
    });
    expect(fabricatedTransformation.passed).toBe(false);
  });

  test("the pinned task slices match the repository configuration files", async () => {
    const readTasks = async (app: string): Promise<unknown[]> => {
      const config = JSON.parse(
        await readFile(
          join(process.cwd(), `benchmarks/validation/apps/${app}/config.json`),
          "utf8",
        ),
      ) as { tasks: unknown[] };
      return config.tasks ?? [];
    };
    expect(await readTasks("image-generation")).toEqual([...IMAGE_GENERATION_TASKS]);
    expect(await readTasks("image-transformation")).toEqual([...IMAGE_TRANSFORMATION_TASKS]);
    expect(IMAGE_GENERATION_TASKS.length).toBe(4);
    expect(IMAGE_TRANSFORMATION_TASKS.length).toBe(4);
  });

  test("the pinned slices carry only fixture keys the platform materializes", () => {
    // Every generation prompt key and every transform source/edit key
    // must be materializable — otherwise the pinned slice would be a
    // silent NOT RUN. (The empty prompt is the declared edge row.)
    for (const task of IMAGE_GENERATION_TASKS) {
      expect(() => generationPromptFixture(task.prompt)).not.toThrow();
    }
    for (const task of IMAGE_TRANSFORMATION_TASKS) {
      const edit = imageEditFixture(task.edit);
      expect(edit.source).toBe(task.source);
      expect(() => imageFixture(task.source)).not.toThrow();
    }
  });
});
