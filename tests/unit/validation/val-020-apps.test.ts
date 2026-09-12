/**
 * VAL-020 acceptance criterion 1: the failure-attribution customer
 * application rides the public SDK boundary end to end against a
 * controlled fake transport (submission → async completion → result
 * retrieval → deterministic assertions → recorder-consumable
 * evidence), and its pinned task slice matches the repository
 * configuration file and the corpus. Discrimination: a FAILED
 * platform outcome fails the healthy/empty-completion/recovery rows'
 * assertions (the application never passes a failed execution) while
 * the failure rows EXPECT the honest FAILED — and a fabricated
 * COMPLETED outcome on a failure row FAILS the app's assertions (a
 * fabricated recovery is never tolerated).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  FAILURE_ATTRIBUTION_TASKS,
  runFailureAttributionApp,
} from "../../../benchmarks/validation/apps/failure-attribution/application";
import { FAILURE_CORPUS } from "../../../benchmarks/validation/apps/failure-attribution/corpus";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";

const REVISION = "1543276bd6062bdb5a2298ccc2a20dc317468fd5";

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
        task: { kind: "dispatch-probe", input: "quota-envelope" },
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
          strategyClass: "failure-attribution-probe",
          modelCalls: 1,
        },
        cost: pass ? { totalMicroUsd: "50", currency: "usd" } : null,
        usage: pass ? { inputTokens: 60, outputTokens: 12 } : null,
        outputArtifacts: [],
        verification: pass
          ? [
              {
                id: "v1",
                executionId: resultMatch[1],
                criterionId: "attribution-class",
                strategy: "deterministic",
                status: "PASS",
                recordedBy: "fake-platform",
              },
            ]
          : [
              {
                id: "v1",
                executionId: resultMatch[1],
                criterionId: "attribution-class",
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
    headers: { "Content-Type": "application/json" },
  });
}

const baseConfig = {
  applicationId: "app-1",
  baseUrl: "http://fake-zeck.local",
  tokenEnvVar: "ZECK_VALIDATION_TOKEN",
  applicationRevision: REVISION,
  corpusRevision: REVISION,
  integrationSurface: "sdk",
  pollIntervalMs: 1,
  completionTimeoutMs: 5_000,
};

async function runAppOverFakeWorld(options: {
  readonly terminal: "COMPLETED" | "FAILED";
  readonly taskIndex: number;
}): Promise<{ readonly evidence: HarnessEvidence; readonly passed: boolean }> {
  const { transport } = createFakeApiWorld({ terminal: options.terminal });
  return runFailureAttributionApp({
    config: baseConfig,
    token: "zeck-token-fake",
    transport,
    now: () => new Date(1_000),
    sleep: async () => {},
    environment: {
      runtime: "node test",
      toolchain: "vitest",
      database: "none",
      configuration: { suite: "val-020-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
  });
}

describe("VAL-020 failure-attribution application (public SDK boundary)", () => {
  test("the task slice mirrors the corpus exactly (kind, scenario, tool, terminal)", () => {
    expect(FAILURE_ATTRIBUTION_TASKS.length).toBe(FAILURE_CORPUS.length);
    for (const [index, task] of FAILURE_ATTRIBUTION_TASKS.entries()) {
      const row = FAILURE_CORPUS[index];
      if (row === undefined) throw new Error("missing corpus row");
      expect(task.kind).toBe(row.kind);
      expect(task.scenario).toBe(row.rowId);
      expect(task.expectedTerminal).toBe(row.expected.terminal);
      if (row.toolInvocation !== undefined) {
        expect(task.tool).toBe(row.toolInvocation.tool);
      }
    }
  });

  test("the repository config.json mirrors the pinned task slice", async () => {
    const config = JSON.parse(
      await readFile(
        join(process.cwd(), "benchmarks/validation/apps/failure-attribution/config.json"),
        "utf8",
      ),
    ) as { tasks: { kind: string; scenario: string; expectedTerminal: string }[] };
    expect(config.tasks.length).toBe(FAILURE_ATTRIBUTION_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const pinned = FAILURE_ATTRIBUTION_TASKS[index];
      if (pinned === undefined) throw new Error("missing pinned task");
      expect(task.kind).toBe(pinned.kind);
      expect(task.scenario).toBe(pinned.scenario);
      expect(task.expectedTerminal).toBe(pinned.expectedTerminal);
    }
  });

  test("healthy/empty-completion/recovery rows PASS on the honest COMPLETED outcome with valid evidence", async () => {
    for (const [index, row] of FAILURE_CORPUS.entries()) {
      if (row.expected.terminal !== "COMPLETED") {
        continue;
      }
      const outcome = await runAppOverFakeWorld({ terminal: "COMPLETED", taskIndex: index });
      expect(outcome.passed, `${row.rowId} should pass on COMPLETED`).toBe(true);
      expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    }
  });

  test("failure rows PASS on the honest FAILED outcome (they EXPECT the failure)", async () => {
    for (const [index, row] of FAILURE_CORPUS.entries()) {
      if (row.expected.terminal !== "FAILED") {
        continue;
      }
      const outcome = await runAppOverFakeWorld({ terminal: "FAILED", taskIndex: index });
      expect(outcome.passed, `${row.rowId} should pass on FAILED`).toBe(true);
      expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    }
  });

  test("a fabricated COMPLETED on a failure row FAILS the app's assertions (never a fabricated recovery)", async () => {
    const quotaIndex = FAILURE_CORPUS.findIndex((row) => row.rowId === "quota-envelope");
    if (quotaIndex < 0) throw new Error("missing quota row");
    const outcome = await runAppOverFakeWorld({ terminal: "COMPLETED", taskIndex: quotaIndex });
    expect(outcome.passed).toBe(false);
  });

  test("a FAILED platform outcome fails the healthy rows (the app never passes a failed execution)", async () => {
    const healthyIndex = FAILURE_CORPUS.findIndex((row) => row.rowId === "healthy-no-retry");
    const recoveryIndex = FAILURE_CORPUS.findIndex(
      (row) => row.rowId === "healthy-recovery-after-retry",
    );
    const emptyIndex = FAILURE_CORPUS.findIndex((row) => row.rowId === "empty-completion");
    if (healthyIndex < 0 || recoveryIndex < 0 || emptyIndex < 0) {
      throw new Error("missing healthy rows");
    }
    for (const index of [healthyIndex, recoveryIndex, emptyIndex]) {
      const outcome = await runAppOverFakeWorld({ terminal: "FAILED", taskIndex: index });
      expect(outcome.passed).toBe(false);
    }
  });
});
