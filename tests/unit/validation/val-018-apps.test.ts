/**
 * VAL-018 acceptance criterion 1: the two new customer applications
 * (multimodal-transformation and three-d-rendering) ride the public
 * SDK boundary end to end against a controlled fake transport
 * (submission → async completion → result retrieval → deterministic
 * assertions → recorder-consumable evidence), and their pinned task
 * slices match the repository configuration files.
 *
 * Discrimination: a FAILED platform outcome fails the healthy rows'
 * assertions (the application never passes a failed execution), while
 * the edge rows EXPECT the honest failure — and a COMPLETED outcome
 * on an edge row is a forbidden fabricated success.
 *
 * The 3D application's REAL dispatches are a NOT RUN boundary (no
 * authorized rail exists); THIS suite is its offline path — the
 * SDK-boundary integration proven over the controlled fake API world.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  MULTIMODAL_TRANSFORMATION_TASKS,
  runMultimodalTransformationApp,
} from "../../../benchmarks/validation/apps/multimodal-transformation/application";
import {
  runThreeDRenderingApp,
  THREE_D_RENDERING_TASKS,
} from "../../../benchmarks/validation/apps/three-d-rendering/application";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";

const REVISION = "789716086832883096bf34f4e00698760ea1b02a";

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
      if (execution === undefined) {
        return jsonResponse(404, {
          code: "NOT_FOUND",
          message: "unknown execution",
          retryable: false,
        });
      }
      execution.status = options.terminal;
      return jsonResponse(200, {
        id: execMatch[1],
        applicationId: "app-1",
        environmentId: null,
        status: execution.status,
        task: { kind: "describe-and-generate", input: "x" },
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
      if (execution === undefined) {
        return jsonResponse(404, {
          code: "NOT_FOUND",
          message: "unknown execution",
          retryable: false,
        });
      }
      const pass = options.terminal === "COMPLETED";
      return jsonResponse(200, {
        executionId: resultMatch[1],
        status: options.terminal,
        route: {
          provider: "fake-rail",
          model: "fake-model",
          strategyClass: "chained-multimodal-transform",
          modelCalls: 2,
        },
        cost: pass ? { totalMicroUsd: "21", currency: "usd" } : null,
        usage: pass ? { inputTokens: 208, outputTokens: 25 } : null,
        outputArtifacts: [],
        verification: pass
          ? [
              {
                id: "v1",
                executionId: resultMatch[1],
                criterionId: "stage1:contains:bus",
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

describe("VAL-018 customer applications (public SDK boundary)", () => {
  test("the multimodal-transformation app completes end to end with valid evidence", async () => {
    const { transport } = createFakeApiWorld({ terminal: "COMPLETED" });
    const outcome = await runMultimodalTransformationApp({
      ...RUN_OPTIONS(transport),
      taskIndex: 0,
    });
    expect(outcome.passed).toBe(true);
    expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    expect(outcome.evidence.terminalStatus).toBe("COMPLETED");
    expect(outcome.evidence.request?.taskKind).toBe("describe-and-generate");
  });

  test("the three-d-rendering app completes end to end with valid evidence (its offline SDK path)", async () => {
    const { transport } = createFakeApiWorld({ terminal: "COMPLETED" });
    const outcome = await runThreeDRenderingApp({ ...RUN_OPTIONS(transport), taskIndex: 0 });
    expect(outcome.passed).toBe(true);
    expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    expect(outcome.evidence.request?.taskKind).toBe("render-3d");
  });

  test("a FAILED platform outcome fails every healthy row's assertions (no silent pass)", async () => {
    const { transport } = createFakeApiWorld({ terminal: "FAILED" });
    const transformation = await runMultimodalTransformationApp({
      ...RUN_OPTIONS(transport),
      taskIndex: 0,
    });
    expect(transformation.passed).toBe(false);
    const threeD = await runThreeDRenderingApp({ ...RUN_OPTIONS(transport), taskIndex: 0 });
    expect(threeD.passed).toBe(false);
  });

  test("the multimodal-transformation corrupted-source edge row EXPECTS the honest failure", async () => {
    // A FAILED outcome is the CORRECT behavior for the edge row (the
    // REAL vision rail rejects the corrupted source at stage 1): the
    // app passes.
    const failed = createFakeApiWorld({ terminal: "FAILED" });
    const honest = await runMultimodalTransformationApp({
      ...RUN_OPTIONS(failed.transport),
      taskIndex: 2,
    });
    expect(honest.passed).toBe(true);
    expect(validateHarnessEvidence(honest.evidence)).toEqual([]);
    // A COMPLETED outcome on the edge row is a FORBIDDEN fabricated
    // success.
    const completed = createFakeApiWorld({ terminal: "COMPLETED" });
    const fabricated = await runMultimodalTransformationApp({
      ...RUN_OPTIONS(completed.transport),
      taskIndex: 2,
    });
    expect(fabricated.passed).toBe(false);
  });

  test("the three-d-rendering invalid-spec edge rows EXPECT the honest failure", async () => {
    // Edge rows 3..5 (empty scene, unknown primitive, corrupted spec):
    // FAILED is the CORRECT terminal — the app passes.
    const failed = createFakeApiWorld({ terminal: "FAILED" });
    for (const taskIndex of [3, 4, 5]) {
      const honest = await runThreeDRenderingApp({
        ...RUN_OPTIONS(failed.transport),
        taskIndex,
      });
      expect(honest.passed).toBe(true);
      expect(validateHarnessEvidence(honest.evidence)).toEqual([]);
    }
    // A COMPLETED outcome on an edge row is a FORBIDDEN fabricated
    // success.
    const completed = createFakeApiWorld({ terminal: "COMPLETED" });
    for (const taskIndex of [3, 4, 5]) {
      const fabricated = await runThreeDRenderingApp({
        ...RUN_OPTIONS(completed.transport),
        taskIndex,
      });
      expect(fabricated.passed).toBe(false);
    }
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
    expect(await readTasks("multimodal-transformation")).toEqual([
      ...MULTIMODAL_TRANSFORMATION_TASKS,
    ]);
    expect(await readTasks("three-d-rendering")).toEqual([...THREE_D_RENDERING_TASKS]);
    expect(MULTIMODAL_TRANSFORMATION_TASKS.length).toBe(3);
    expect(THREE_D_RENDERING_TASKS.length).toBe(6);
  });
});
