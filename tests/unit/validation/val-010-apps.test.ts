/**
 * VAL-010 acceptance criterion 1: the three customer applications ride
 * the public SDK boundary end to end against a controlled fake
 * transport (submission → async completion → result retrieval →
 * deterministic assertions → recorder-consumable evidence), and their
 * pinned task slices match the repository configuration files.
 * Discrimination: a FAILED platform outcome fails the app's assertions
 * (the application never passes a failed execution).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  runStructuredExtractionApp,
  STRUCTURED_EXTRACTION_TASKS,
} from "../../../benchmarks/validation/apps/structured-extraction/application";
import {
  runTextGenerationApp,
  TEXT_GENERATION_TASKS,
} from "../../../benchmarks/validation/apps/text-generation/application";
import {
  runTransformationApp,
  TRANSFORMATION_TASKS,
} from "../../../benchmarks/validation/apps/transformation/application";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";

const REVISION = "90ceeddd1c6e5553254eaaade3155be391670787";

/**
 * A minimal fake public API over the SDK's injected transport seam:
 * create → receipt, poll → terminal status, results → the packaged
 * outcome with the verification the fake platform recorded.
 */
function createFakeApiWorld(options: { readonly terminal: "COMPLETED" | "FAILED" }): {
  readonly transport: TransportImplementation;
} {
  const executions = new Map<
    string,
    {
      status: string;
      verification: { status: string; criterionId: string; strategy: string; recordedBy: string }[];
    }
  >();
  let sequence = 0;
  const transport: TransportImplementation = async (input: unknown, init?: unknown) => {
    const url = String(input);
    const method = String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    if (url.endsWith("/executions") && method === "POST") {
      sequence += 1;
      const id = `fake-exec-${sequence}`;
      executions.set(id, {
        status: "RUNNING",
        verification: [],
      });
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
        task: { kind: "summarize", input: "x" },
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
          strategyClass: "single-shot",
          modelCalls: 1,
        },
        cost: pass ? { totalMicroUsd: "21", currency: "usd" } : null,
        usage: pass ? { inputTokens: 220, outputTokens: 12 } : null,
        outputArtifacts: [],
        verification: pass
          ? [
              {
                id: "v1",
                executionId: resultMatch[1],
                criterionId: "contains:revenue",
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

describe("VAL-010 customer applications (public SDK boundary)", () => {
  test("text-generation app completes end to end with valid evidence", async () => {
    const { transport } = createFakeApiWorld({ terminal: "COMPLETED" });
    const outcome = await runTextGenerationApp({ ...RUN_OPTIONS(transport), taskIndex: 0 });
    expect(outcome.passed).toBe(true);
    expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    expect(outcome.evidence.terminalStatus).toBe("COMPLETED");
    expect(outcome.evidence.request?.taskKind).toBe("summarize");
  });

  test("structured-extraction app completes end to end with valid evidence", async () => {
    const { transport } = createFakeApiWorld({ terminal: "COMPLETED" });
    const outcome = await runStructuredExtractionApp({ ...RUN_OPTIONS(transport), taskIndex: 0 });
    expect(outcome.passed).toBe(true);
    expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    expect(outcome.evidence.request?.taskKind).toBe("extract");
  });

  test("transformation app completes end to end with valid evidence", async () => {
    const { transport } = createFakeApiWorld({ terminal: "COMPLETED" });
    const outcome = await runTransformationApp({ ...RUN_OPTIONS(transport), taskIndex: 0 });
    expect(outcome.passed).toBe(true);
    expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    expect(outcome.evidence.request?.taskKind).toBe("transform");
  });

  test("a FAILED platform outcome fails every app's assertions (no silent pass)", async () => {
    const { transport } = createFakeApiWorld({ terminal: "FAILED" });
    const text = await runTextGenerationApp({ ...RUN_OPTIONS(transport), taskIndex: 0 });
    expect(text.passed).toBe(false);
    const extraction = await runStructuredExtractionApp({
      ...RUN_OPTIONS(transport),
      taskIndex: 1,
    });
    expect(extraction.passed).toBe(false);
    const transformation = await runTransformationApp({ ...RUN_OPTIONS(transport), taskIndex: 2 });
    expect(transformation.passed).toBe(false);
  });

  test("the missing-total edge row EXPECTS the honest failure (corpus expectation)", async () => {
    // A FAILED outcome is the CORRECT behavior for the edge row: the app passes.
    const failed = createFakeApiWorld({ terminal: "FAILED" });
    const honest = await runStructuredExtractionApp({
      ...RUN_OPTIONS(failed.transport),
      taskIndex: 2,
    });
    expect(honest.passed).toBe(true);
    expect(validateHarnessEvidence(honest.evidence)).toEqual([]);
    // A COMPLETED outcome on the edge row is a FORBIDDEN fabricated success.
    const completed = createFakeApiWorld({ terminal: "COMPLETED" });
    const fabricated = await runStructuredExtractionApp({
      ...RUN_OPTIONS(completed.transport),
      taskIndex: 2,
    });
    expect(fabricated.passed).toBe(false);
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
    expect(await readTasks("text-generation")).toEqual([...TEXT_GENERATION_TASKS]);
    expect(await readTasks("structured-extraction")).toEqual([...STRUCTURED_EXTRACTION_TASKS]);
    expect(await readTasks("transformation")).toEqual([...TRANSFORMATION_TASKS]);
    expect(TEXT_GENERATION_TASKS.length).toBe(3);
    expect(STRUCTURED_EXTRACTION_TASKS.length).toBe(3);
    expect(TRANSFORMATION_TASKS.length).toBe(4);
  });
});
