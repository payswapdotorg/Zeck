/**
 * VAL-016 acceptance criterion 1 + the async job semantics: the two
 * videogen customer applications ride the public SDK boundary end to
 * end against a controlled fake transport (submission → async
 * completion → result retrieval → deterministic assertions →
 * recorder-consumable evidence), and their pinned task/job slices
 * match the repository configuration files.
 *
 * The fake platform mirrors the REAL platform's honest behaviors:
 *   * the zero-duration edge row is FAILED (the platform rejects it
 *     before any paid dispatch) — the app EXPECTS that failure;
 *   * a FAILED platform outcome fails every healthy row's assertions
 *     (the application never passes a failed execution);
 *   * a COMPLETED outcome on the edge row is a FORBIDDEN fabricated
 *     success (the app's assertions fail it).
 *
 * The media-generation-jobs application is additionally discriminated
 * on its JOB semantics: complete item accounting (no lost tasks — an
 * item that never reaches a terminal status within the bounded
 * completion window is reported LOST and fails the job, never
 * silently dropped) and honest task-failure propagation (the failed
 * edge item fails the job mechanically while the healthy sibling
 * still completes and is accounted).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type MediaJobRunOutcome,
  runMediaGenerationJobsApp,
} from "../../../benchmarks/validation/apps/media-generation-jobs/application";
import {
  deriveMediaJobTerminal,
  jobDefinitionIsConsistent,
  MEDIA_GENERATION_JOBS,
} from "../../../benchmarks/validation/apps/media-generation-jobs/jobs";
import {
  runVideoGenerationApp,
  VIDEO_GENERATION_TASKS,
} from "../../../benchmarks/validation/apps/video-generation/application";
import { videoPromptFixture } from "../../../benchmarks/validation/apps/video-generation/prompts";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";

const REVISION = "f7d5480fc092b7efe171f4b06ce8a266464064af";

/** How the fake platform resolves an execution's terminal status. */
type FakeTerminal = "COMPLETED" | "FAILED" | "BY_TASK" | "RUNNING";

/**
 * A minimal fake public API over the SDK's injected transport seam:
 * create → receipt (the task recorded), poll → the terminal status
 * the fake platform resolves, results → the packaged outcome with
 * the verification the fake platform recorded. `BY_TASK` mirrors the
 * REAL platform's edge-row behavior (seconds ≤ 0 → FAILED).
 */
function createFakeApiWorld(options: { readonly terminal: FakeTerminal }): {
  readonly transport: TransportImplementation;
} {
  const executions = new Map<
    string,
    { status: string; task: { kind?: unknown; seconds?: unknown } }
  >();
  let sequence = 0;
  const transport: TransportImplementation = async (input: unknown, init?: unknown) => {
    const url = String(input);
    const method = String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    if (url.endsWith("/executions") && method === "POST") {
      sequence += 1;
      const id = `fake-exec-${sequence}`;
      const body = JSON.parse(String((init as RequestInit).body ?? "{}")) as {
        task?: { kind?: unknown; seconds?: unknown };
      };
      executions.set(id, { status: "RUNNING", task: body.task ?? {} });
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
      const terminal =
        options.terminal === "BY_TASK"
          ? typeof execution.task.seconds === "number" && execution.task.seconds <= 0
            ? "FAILED"
            : "COMPLETED"
          : options.terminal === "RUNNING"
            ? "RUNNING"
            : options.terminal;
      return jsonResponse(200, {
        id: execMatch[1],
        applicationId: "app-1",
        environmentId: null,
        status: terminal,
        task: execution.task,
        constraints: null,
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        terminalAt: terminal === "RUNNING" ? null : new Date().toISOString(),
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
      if (options.terminal === "RUNNING") {
        // No result exists for a still-running execution — honest 404.
        return jsonResponse(404, {
          code: "NOT_FOUND",
          message: "no result for a running execution",
          retryable: false,
        });
      }
      const terminal =
        options.terminal === "BY_TASK"
          ? typeof execution.task.seconds === "number" && execution.task.seconds <= 0
            ? "FAILED"
            : "COMPLETED"
          : options.terminal;
      const pass = terminal === "COMPLETED";
      return jsonResponse(200, {
        executionId: resultMatch[1],
        status: terminal,
        route: {
          provider: "fake-rail",
          model: "fake-model",
          strategyClass: "async-text-to-video",
          modelCalls: 1,
        },
        cost: pass ? { totalMicroUsd: "500", currency: "usd" } : null,
        usage: pass ? { inputTokens: 0, outputTokens: 1 } : null,
        outputArtifacts: [],
        verification: pass
          ? [
              {
                id: "v1",
                executionId: resultMatch[1],
                criterionId: "mp4-container",
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

describe("VAL-016 customer applications (public SDK boundary)", () => {
  test("the video-generation app completes end to end with valid evidence", async () => {
    const { transport } = createFakeApiWorld({ terminal: "COMPLETED" });
    const outcome = await runVideoGenerationApp({ ...RUN_OPTIONS(transport), taskIndex: 0 });
    expect(outcome.passed).toBe(true);
    expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    expect(outcome.evidence.terminalStatus).toBe("COMPLETED");
    expect(outcome.evidence.request?.taskKind).toBe("generate-video");
    expect(outcome.evidence.timeline.length).toBeGreaterThan(0);
  });

  test("a FAILED platform outcome fails the healthy rows' assertions (no silent pass)", async () => {
    const { transport } = createFakeApiWorld({ terminal: "FAILED" });
    const outcome = await runVideoGenerationApp({ ...RUN_OPTIONS(transport), taskIndex: 0 });
    expect(outcome.passed).toBe(false);
    expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
  });

  test("the zero-seconds edge row EXPECTS the honest failure (corpus expectation)", async () => {
    // The fake platform mirrors the REAL platform: seconds ≤ 0 → FAILED.
    const honest = createFakeApiWorld({ terminal: "BY_TASK" });
    const edge = await runVideoGenerationApp({ ...RUN_OPTIONS(honest.transport), taskIndex: 3 });
    expect(edge.passed).toBe(true);
    expect(validateHarnessEvidence(edge.evidence)).toEqual([]);
    expect(edge.evidence.terminalStatus).toBe("FAILED");
    // A COMPLETED outcome on the edge row is a FORBIDDEN fabricated success.
    const fabricated = createFakeApiWorld({ terminal: "COMPLETED" });
    const cheated = await runVideoGenerationApp({
      ...RUN_OPTIONS(fabricated.transport),
      taskIndex: 3,
    });
    expect(cheated.passed).toBe(false);
  });

  test("the healthy rows complete over the task-honest fake platform", async () => {
    const { transport } = createFakeApiWorld({ terminal: "BY_TASK" });
    for (const taskIndex of [0, 1, 2]) {
      const outcome = await runVideoGenerationApp({ ...RUN_OPTIONS(transport), taskIndex });
      expect(outcome.passed).toBe(true);
      expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    }
  });
});

describe("VAL-016 media-generation-jobs application (async job semantics)", () => {
  test("media-job-001 completes: every item submitted, polled, retrieved and accounted", async () => {
    const { transport } = createFakeApiWorld({ terminal: "BY_TASK" });
    const outcome: MediaJobRunOutcome = await runMediaGenerationJobsApp({
      ...RUN_OPTIONS(transport),
      jobIndex: 0,
    });
    expect(outcome.jobTerminal).toBe("COMPLETED");
    expect(outcome.expectedJobTerminal).toBe("COMPLETED");
    expect(outcome.jobPassed).toBe(true);
    expect(outcome.completedItemCount).toBe(2);
    expect(outcome.failedItemCount).toBe(0);
    expect(outcome.lostItemCount).toBe(0); // no lost tasks
    expect(outcome.items).toHaveLength(2);
    for (const item of outcome.items) {
      expect(item.lost).toBe(false);
      expect(item.terminalStatus).toBe("COMPLETED");
      expect(item.assertionsPassed).toBe(true);
      expect(item.resultDigest).not.toBeNull();
      expect(validateHarnessEvidence(item.evidence)).toEqual([]);
      expect(item.evidence.request?.taskKind).toBe("generate-video");
      expect(item.evidence.timings.submitMs).not.toBeNull();
    }
    expect(outcome.pollObservations).toBeGreaterThanOrEqual(2);
    expect(outcome.jobWallMs).toBeGreaterThanOrEqual(0);
  });

  test("media-job-002 fails honestly: the edge item fails, the healthy sibling completes (no lost tasks)", async () => {
    const { transport } = createFakeApiWorld({ terminal: "BY_TASK" });
    const outcome = await runMediaGenerationJobsApp({
      ...RUN_OPTIONS(transport),
      jobIndex: 1,
    });
    expect(outcome.jobTerminal).toBe("FAILED");
    expect(outcome.expectedJobTerminal).toBe("FAILED");
    expect(outcome.jobPassed).toBe(true); // the honest failure is the EXPECTED outcome
    expect(outcome.completedItemCount).toBe(1); // the healthy sibling still completes
    expect(outcome.failedItemCount).toBe(1); // ...and the failed item is accounted
    expect(outcome.lostItemCount).toBe(0);
    const failed = outcome.items.find((item) => item.terminalStatus === "FAILED");
    expect(failed?.fixtureKey).toBe("vid-prompt-005");
    expect(failed?.assertionsPassed).toBe(true); // FAILED+FAIL was the pinned expectation
    expect(failed?.verificationStatuses).toContain("FAIL");
    expect(validateHarnessEvidence(failed?.evidence as never)).toEqual([]);
    const healthy = outcome.items.find((item) => item.terminalStatus === "COMPLETED");
    expect(healthy?.fixtureKey).toBe("vid-prompt-003");
    expect(validateHarnessEvidence(healthy?.evidence as never)).toEqual([]);
  });

  test("a platform that fails everything fails the healthy job (no fabricated job success)", async () => {
    const { transport } = createFakeApiWorld({ terminal: "FAILED" });
    const outcome = await runMediaGenerationJobsApp({
      ...RUN_OPTIONS(transport),
      jobIndex: 0,
    });
    expect(outcome.jobTerminal).toBe("FAILED");
    expect(outcome.jobPassed).toBe(false);
    expect(outcome.failedItemCount).toBe(2);
    expect(outcome.lostItemCount).toBe(0);
  });

  test("an item that never reaches a terminal status is LOST: accounted, job FAILED (never dropped)", async () => {
    const { transport } = createFakeApiWorld({ terminal: "RUNNING" });
    // A clock that advances with every poll sleep, so the bounded
    // completion window elapses deterministically (no real waiting).
    let clockMs = 0;
    const outcome = await runMediaGenerationJobsApp({
      config: {
        applicationId: "app-1",
        baseUrl: "http://fake.local",
        tokenEnvVar: "ZECK_VALIDATION_TOKEN",
        applicationRevision: REVISION,
        corpusRevision: REVISION,
        integrationSurface: "sdk",
        pollIntervalMs: 1,
        completionTimeoutMs: 5,
      },
      token: "test-token",
      transport,
      now: () => new Date(clockMs),
      sleep: () => {
        clockMs += 1;
        return Promise.resolve();
      },
      environment: {
        runtime: "node test",
        toolchain: "vitest",
        database: "fake",
        configuration: {},
      },
      runSuffix: "unit-lost",
      jobIndex: 0,
    });
    expect(outcome.jobTerminal).toBe("FAILED");
    expect(outcome.lostItemCount).toBe(2); // both items lost — accounted, not dropped
    expect(outcome.completedItemCount).toBe(0);
    expect(outcome.jobPassed).toBe(false);
    for (const item of outcome.items) {
      expect(item.lost).toBe(true);
      expect(item.terminalStatus).toBeNull();
      expect(item.assertionsPassed).toBe(false);
      expect(item.evidence.timeline.length).toBeGreaterThan(0); // polls genuinely happened
    }
    expect(outcome.jobWallMs).toBeGreaterThan(0); // the bounded window was measured
  });
});

describe("VAL-016 pinned slices and configuration files", () => {
  test("the pinned task slice matches the video-generation configuration file", async () => {
    const config = JSON.parse(
      await readFile(
        join(process.cwd(), "benchmarks/validation/apps/video-generation/config.json"),
        "utf8",
      ),
    ) as { tasks: unknown[]; pollIntervalMs: number; completionTimeoutMs: number };
    expect(config.tasks).toEqual([...VIDEO_GENERATION_TASKS]);
    expect(VIDEO_GENERATION_TASKS.length).toBe(4);
    expect(config.pollIntervalMs).toBeGreaterThan(0);
    expect(config.completionTimeoutMs).toBeGreaterThan(0);
  });

  test("the pinned job slice matches the media-generation-jobs configuration file", async () => {
    const config = JSON.parse(
      await readFile(
        join(process.cwd(), "benchmarks/validation/apps/media-generation-jobs/config.json"),
        "utf8",
      ),
    ) as { jobCount: number; pollIntervalMs: number; completionTimeoutMs: number };
    expect(config.jobCount).toBe(MEDIA_GENERATION_JOBS.length);
    expect(MEDIA_GENERATION_JOBS.length).toBe(2);
    expect(config.pollIntervalMs).toBeGreaterThan(0);
    expect(config.completionTimeoutMs).toBeGreaterThan(0);
  });

  test("the job table is internally consistent (expected terminals equal the mechanical derivation)", () => {
    for (const job of MEDIA_GENERATION_JOBS) {
      expect(jobDefinitionIsConsistent(job)).toBe(true);
      expect(job.items.length).toBeGreaterThan(0);
    }
    // The pure derivation matrix: all-COMPLETED → COMPLETED; any
    // failure or loss → FAILED; the empty job → COMPLETED (nothing lost).
    expect(deriveMediaJobTerminal([{ terminalStatus: "COMPLETED" }])).toBe("COMPLETED");
    expect(
      deriveMediaJobTerminal([{ terminalStatus: "COMPLETED" }, { terminalStatus: "COMPLETED" }]),
    ).toBe("COMPLETED");
    expect(
      deriveMediaJobTerminal([{ terminalStatus: "COMPLETED" }, { terminalStatus: "FAILED" }]),
    ).toBe("FAILED");
    expect(deriveMediaJobTerminal([{ terminalStatus: null }])).toBe("FAILED");
    expect(
      deriveMediaJobTerminal([{ terminalStatus: "COMPLETED" }, { terminalStatus: null }]),
    ).toBe("FAILED");
    expect(deriveMediaJobTerminal([])).toBe("COMPLETED");
  });

  test("the pinned slices carry only fixture keys the platform materializes", () => {
    // Every referenced prompt key must be materializable — otherwise
    // the pinned slice would be a silent NOT RUN.
    for (const task of VIDEO_GENERATION_TASKS) {
      expect(() => videoPromptFixture(task.prompt)).not.toThrow();
    }
    for (const job of MEDIA_GENERATION_JOBS) {
      for (const item of job.items) {
        expect(() => videoPromptFixture(item.task.prompt)).not.toThrow();
      }
    }
  });
});
