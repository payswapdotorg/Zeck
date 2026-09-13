/**
 * VAL-023 acceptance criterion 1: the security-validation customer
 * application rides the public SDK boundary end to end against a
 * controlled fake transport (submission → async completion → result
 * retrieval → deterministic assertions → recorder-consumable
 * evidence), and its pinned task slice matches the repository
 * configuration file and the corpus. Discrimination: a FAILED
 * platform outcome fails every row's assertions (the application
 * never passes a failed execution — a defense failure or a dispatch
 * failure is an honest finding, never a fabricated defense), and a
 * completion whose verification carries no PASS fails the
 * verification-status assertion.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  runSecurityValidationApp,
  SECURITY_TASKS,
} from "../../../benchmarks/validation/apps/security-validation/application";
import { SECURITY_CORPUS } from "../../../benchmarks/validation/apps/security-validation/corpus";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";

const REVISION = "ae373e6c863a0c8adf558ccf5618b7353ee0a557";

/**
 * A minimal fake public API over the SDK's injected transport seam:
 * create → receipt, poll → terminal status, results → the packaged
 * outcome with the verification the fake platform recorded.
 */
function createFakeApiWorld(options: {
  readonly terminal: "COMPLETED" | "FAILED";
  readonly verificationStatus: "PASS" | "FAIL";
}): {
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
        task: { kind: "injection-probe", input: "injection-tool-result" },
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
          strategyClass: "security-validation-probe",
          modelCalls: 1,
        },
        cost: pass ? { totalMicroUsd: "31", currency: "usd" } : null,
        usage: pass ? { inputTokens: 64, outputTokens: 12 } : null,
        outputArtifacts: [],
        verification: [
          {
            id: "v1",
            executionId: resultMatch[1],
            criterionId: "injection-not-followed",
            strategy: "deterministic",
            status: options.verificationStatus,
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
  readonly verificationStatus?: "PASS" | "FAIL";
  readonly taskIndex: number;
}): Promise<{ readonly evidence: HarnessEvidence; readonly passed: boolean }> {
  const { transport } = createFakeApiWorld({
    terminal: options.terminal,
    verificationStatus: options.verificationStatus ?? "PASS",
  });
  return runSecurityValidationApp({
    config: baseConfig,
    token: "zeck-token-fake",
    transport,
    now: () => new Date(1_000),
    sleep: async () => {},
    environment: {
      runtime: "node test",
      toolchain: "vitest",
      database: "none",
      configuration: { suite: "val-023-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
  });
}

describe("VAL-023 security-validation application (public SDK boundary)", () => {
  test("the task slice mirrors the corpus exactly (kind, scenario, tool, terminal)", () => {
    expect(SECURITY_TASKS.length).toBe(SECURITY_CORPUS.length);
    for (const [index, task] of SECURITY_TASKS.entries()) {
      const row = SECURITY_CORPUS[index];
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
        join(process.cwd(), "benchmarks/validation/apps/security-validation/config.json"),
        "utf8",
      ),
    ) as { tasks: { kind: string; scenario: string; expectedTerminal: string }[] };
    expect(config.tasks.length).toBe(SECURITY_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const pinned = SECURITY_TASKS[index];
      if (pinned === undefined) throw new Error("missing pinned task");
      expect(task.kind).toBe(pinned.kind);
      expect(task.scenario).toBe(pinned.scenario);
      expect(task.expectedTerminal).toBe(pinned.expectedTerminal);
    }
  });

  test("every row PASSES on the honest defended COMPLETED outcome with valid evidence", async () => {
    for (const [index, row] of SECURITY_CORPUS.entries()) {
      const outcome = await runAppOverFakeWorld({ terminal: "COMPLETED", taskIndex: index });
      expect(outcome.passed, `${row.rowId} should pass on COMPLETED`).toBe(true);
      expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    }
  }, 30_000);

  test("a FAILED platform outcome fails every row (the app never passes a failed execution — a defense or dispatch failure is honest, never fabricated)", async () => {
    for (const [index, row] of SECURITY_CORPUS.entries()) {
      const outcome = await runAppOverFakeWorld({ terminal: "FAILED", taskIndex: index });
      expect(outcome.passed, `${row.rowId} should fail on FAILED`).toBe(false);
      expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    }
  }, 30_000);

  test("a completion whose verification carries FAIL statuses fails the app's verification assertion (a violated criterion is never tolerated)", async () => {
    const injectionIndex = SECURITY_CORPUS.findIndex(
      (row) => row.rowId === "injection-tool-result",
    );
    if (injectionIndex < 0) throw new Error("missing injection row");
    const outcome = await runAppOverFakeWorld({
      terminal: "COMPLETED",
      verificationStatus: "FAIL",
      taskIndex: injectionIndex,
    });
    expect(outcome.passed).toBe(false);
  });
});
