/**
 * VAL-014 acceptance criterion 1: the voice-io and realtime-voice
 * customer applications ride the public SDK boundary end to end against
 * a controlled fake transport (submission → async completion → result
 * retrieval → deterministic assertions → recorder-consumable evidence),
 * and their pinned task slices match the repository configuration files.
 * Discrimination: a FAILED platform outcome fails the healthy rows'
 * assertions (the application never passes a failed execution), while
 * the corrupted-audio and empty-text edge rows EXPECT the honest
 * failure (and the corrupted-checkpoint session row likewise).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  expectedTerminalForRealtimeRow,
  runRealtimeVoiceApp,
} from "../../../benchmarks/validation/apps/realtime-voice/application";
import { REALTIME_VOICE_TASKS } from "../../../benchmarks/validation/apps/realtime-voice/dialogs";
import {
  expectedTerminalForVoiceIoRow,
  runVoiceIoApp,
  VOICE_IO_TASKS,
} from "../../../benchmarks/validation/apps/voice-io/application";
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
        task: { kind: "transcribe-utterance", input: "x" },
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
          strategyClass: "single-shot-asr",
          modelCalls: 1,
        },
        cost: pass ? { totalMicroUsd: "21", currency: "usd" } : null,
        usage: pass ? { inputTokens: 89, outputTokens: 2 } : null,
        outputArtifacts: [],
        verification: pass
          ? [
              {
                id: "v1",
                executionId: resultMatch[1],
                criterionId: "asr-provider-ok",
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

describe("VAL-014 customer applications (public SDK boundary)", () => {
  test("every healthy voice-io row completes end to end with valid evidence", async () => {
    const { transport } = createFakeApiWorld({ terminal: "COMPLETED" });
    for (const index of [0, 1, 2, 4, 5]) {
      const outcome = await runVoiceIoApp({ ...RUN_OPTIONS(transport), taskIndex: index });
      expect(outcome.passed).toBe(true);
      expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
      expect(outcome.evidence.terminalStatus).toBe("COMPLETED");
    }
  });

  test("the STT rows submit transcribe task kinds through the SDK boundary", async () => {
    const { transport } = createFakeApiWorld({ terminal: "COMPLETED" });
    const stt = await runVoiceIoApp({ ...RUN_OPTIONS(transport), taskIndex: 0 });
    expect(stt.evidence.request?.taskKind).toBe("transcribe-utterance");
    const roundtrip = await runVoiceIoApp({ ...RUN_OPTIONS(transport), taskIndex: 2 });
    expect(roundtrip.evidence.request?.taskKind).toBe("transcribe-roundtrip");
    const tts = await runVoiceIoApp({ ...RUN_OPTIONS(transport), taskIndex: 4 });
    expect(tts.evidence.request?.taskKind).toBe("synthesize-speech");
  });

  test("a FAILED platform outcome fails every healthy row's assertions (no silent pass)", async () => {
    const { transport } = createFakeApiWorld({ terminal: "FAILED" });
    for (const index of [0, 1, 2, 4, 5]) {
      const outcome = await runVoiceIoApp({ ...RUN_OPTIONS(transport), taskIndex: index });
      expect(outcome.passed).toBe(false);
    }
  });

  test("the corrupted-audio and empty-text edge rows EXPECT the honest failure", async () => {
    // A FAILED outcome is the CORRECT behavior for the edge rows: the app passes.
    const failed = createFakeApiWorld({ terminal: "FAILED" });
    const corruptAudio = await runVoiceIoApp({ ...RUN_OPTIONS(failed.transport), taskIndex: 3 });
    expect(corruptAudio.passed).toBe(true);
    expect(validateHarnessEvidence(corruptAudio.evidence)).toEqual([]);
    const emptyText = await runVoiceIoApp({ ...RUN_OPTIONS(failed.transport), taskIndex: 6 });
    expect(emptyText.passed).toBe(true);
    expect(validateHarnessEvidence(emptyText.evidence)).toEqual([]);
    // A COMPLETED outcome on an edge row is a FORBIDDEN fabricated success.
    const completed = createFakeApiWorld({ terminal: "COMPLETED" });
    const fabricatedAudio = await runVoiceIoApp({
      ...RUN_OPTIONS(completed.transport),
      taskIndex: 3,
    });
    expect(fabricatedAudio.passed).toBe(false);
    const fabricatedText = await runVoiceIoApp({
      ...RUN_OPTIONS(completed.transport),
      taskIndex: 6,
    });
    expect(fabricatedText.passed).toBe(false);
  });

  test("every healthy realtime-voice session row completes end to end with valid evidence", async () => {
    const { transport } = createFakeApiWorld({ terminal: "COMPLETED" });
    for (const index of [0, 1, 2, 3]) {
      const outcome = await runRealtimeVoiceApp({ ...RUN_OPTIONS(transport), taskIndex: index });
      expect(outcome.passed).toBe(true);
      expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
      expect(outcome.evidence.request?.taskKind).toBe("voice-loop");
    }
  });

  test("the corrupted-checkpoint session row EXPECTS the honest failure", async () => {
    const failed = createFakeApiWorld({ terminal: "FAILED" });
    const corrupt = await runRealtimeVoiceApp({ ...RUN_OPTIONS(failed.transport), taskIndex: 4 });
    expect(corrupt.passed).toBe(true);
    expect(validateHarnessEvidence(corrupt.evidence)).toEqual([]);
    // A COMPLETED outcome there would mean trusting corrupted session state.
    const completed = createFakeApiWorld({ terminal: "COMPLETED" });
    const fabricated = await runRealtimeVoiceApp({
      ...RUN_OPTIONS(completed.transport),
      taskIndex: 4,
    });
    expect(fabricated.passed).toBe(false);
  });

  test("a FAILED platform outcome fails the healthy session rows (no silent pass)", async () => {
    const { transport } = createFakeApiWorld({ terminal: "FAILED" });
    const outcome = await runRealtimeVoiceApp({ ...RUN_OPTIONS(transport), taskIndex: 0 });
    expect(outcome.passed).toBe(false);
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
    expect(await readTasks("voice-io")).toEqual([...VOICE_IO_TASKS]);
    expect(await readTasks("realtime-voice")).toEqual([...REALTIME_VOICE_TASKS]);
    expect(VOICE_IO_TASKS.length).toBe(7);
    expect(REALTIME_VOICE_TASKS.length).toBe(5);
  });

  test("the expected-terminal helpers agree with the pinned row contracts", () => {
    for (const index of VOICE_IO_TASKS.keys()) {
      expect(expectedTerminalForVoiceIoRow(index)).toBe(
        index === 3 || index === 6 ? "FAILED" : "COMPLETED",
      );
    }
    for (const index of REALTIME_VOICE_TASKS.keys()) {
      expect(expectedTerminalForRealtimeRow(index)).toBe(index === 4 ? "FAILED" : "COMPLETED");
    }
  });
});
