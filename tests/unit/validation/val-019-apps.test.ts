/**
 * VAL-019 acceptance criterion 1: the six agentic customer applications
 * ride the public SDK boundary end to end against a controlled fake
 * transport (submission → async completion → result retrieval →
 * deterministic assertions → recorder-consumable evidence), and their
 * pinned task slices match the repository configuration files.
 * Discrimination: a FAILED platform outcome fails the healthy rows'
 * assertions (the application never passes a failed execution), while
 * the expected-failure edge rows EXPECT the honest failure — and a
 * fabricated COMPLETED outcome on an edge row FAILS the app's
 * assertions.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  BROWSER_USE_TASKS,
  runBrowserUseApp,
} from "../../../benchmarks/validation/apps/browser-use/application";
import { CODING_TASKS, runCodingApp } from "../../../benchmarks/validation/apps/coding/application";
import {
  COMPUTER_USE_TASKS,
  runComputerUseApp,
} from "../../../benchmarks/validation/apps/computer-use/application";
import {
  CUSTOMER_SERVICE_TASKS,
  runCustomerServiceApp,
} from "../../../benchmarks/validation/apps/customer-service/application";
import {
  OPERATIONS_TASKS,
  runOperationsApp,
} from "../../../benchmarks/validation/apps/operations/application";
import {
  RESEARCH_TASKS,
  runResearchApp,
} from "../../../benchmarks/validation/apps/research/application";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";

const REVISION = "0d8969efd9431fde82317d41a312c7b7359d531f";

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
        task: { kind: "triage-ticket", input: "ticket-101" },
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
          strategyClass: "agentic-hitl-loop",
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
                criterionId: "tool-trace-ordered",
                strategy: "deterministic",
                status: "PASS",
                recordedBy: "fake-platform",
              },
            ]
          : [
              {
                id: "v1",
                executionId: resultMatch[1],
                criterionId: "agent-execution",
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

interface AppRunner {
  readonly name: string;
  readonly tasks: readonly { readonly expectedTerminal: "COMPLETED" | "FAILED" }[];
  readonly run: (options: {
    readonly config: ReturnType<typeof RUN_OPTIONS>["config"];
    readonly token: string;
    readonly transport: TransportImplementation;
    readonly now: () => Date;
    readonly sleep: (ms: number) => Promise<void>;
    readonly environment: ReturnType<typeof RUN_OPTIONS>["environment"];
    readonly runSuffix: string;
    readonly taskIndex: number;
  }) => Promise<{ readonly evidence: HarnessEvidence; readonly passed: boolean }>;
  readonly taskKind: string;
}

const APPS: readonly AppRunner[] = [
  {
    name: "customer-service",
    tasks: CUSTOMER_SERVICE_TASKS,
    run: runCustomerServiceApp,
    taskKind: "triage-ticket",
  },
  {
    name: "browser-use",
    tasks: BROWSER_USE_TASKS,
    run: runBrowserUseApp,
    taskKind: "browser-task",
  },
  {
    name: "computer-use",
    tasks: COMPUTER_USE_TASKS,
    run: runComputerUseApp,
    taskKind: "computer-task",
  },
  { name: "research", tasks: RESEARCH_TASKS, run: runResearchApp, taskKind: "research-synthesis" },
  { name: "coding", tasks: CODING_TASKS, run: runCodingApp, taskKind: "implement-function" },
  { name: "operations", tasks: OPERATIONS_TASKS, run: runOperationsApp, taskKind: "run-runbook" },
];

describe("VAL-019 customer applications (public SDK boundary)", () => {
  for (const app of APPS) {
    test(`the ${app.name} app completes end to end with valid evidence`, async () => {
      const { transport } = createFakeApiWorld({ terminal: "COMPLETED" });
      const outcome = await app.run({ ...RUN_OPTIONS(transport), taskIndex: 0 });
      expect(outcome.passed).toBe(true);
      expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
      expect(outcome.evidence.terminalStatus).toBe("COMPLETED");
      expect(outcome.evidence.request?.taskKind).toBe(app.taskKind);
    });

    test(`a FAILED platform outcome fails the ${app.name} app's healthy-row assertions`, async () => {
      const { transport } = createFakeApiWorld({ terminal: "FAILED" });
      const outcome = await app.run({ ...RUN_OPTIONS(transport), taskIndex: 0 });
      expect(outcome.passed).toBe(false);
    });
  }

  test("every expected-failure edge row EXPECTS the honest failure (corpus expectation)", async () => {
    // A FAILED outcome is the CORRECT behavior for the edge rows: the apps pass.
    const failed = createFakeApiWorld({ terminal: "FAILED" });
    const edgeRuns: readonly [string, number][] = [
      ["browser-use", 2], // fake payment instrument
      ["computer-use", 1], // outside-root read
      ["coding", 2], // impossible spec
      ["operations", 2], // forged pre-approval claim
    ];
    for (const [name, taskIndex] of edgeRuns) {
      const app = APPS.find((entry) => entry.name === name);
      if (app === undefined) throw new Error(`missing app ${name}`);
      const outcome = await app.run({ ...RUN_OPTIONS(failed.transport), taskIndex });
      expect(outcome.passed).toBe(true);
      expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
      expect(outcome.evidence.terminalStatus).toBe("FAILED");
    }
    // A COMPLETED outcome on an edge row is a FORBIDDEN fabricated success.
    const completed = createFakeApiWorld({ terminal: "COMPLETED" });
    for (const [name, taskIndex] of edgeRuns) {
      const app = APPS.find((entry) => entry.name === name);
      if (app === undefined) throw new Error(`missing app ${name}`);
      const outcome = await app.run({ ...RUN_OPTIONS(completed.transport), taskIndex });
      expect(outcome.passed).toBe(false);
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
    expect(await readTasks("customer-service")).toEqual([...CUSTOMER_SERVICE_TASKS]);
    expect(await readTasks("browser-use")).toEqual([...BROWSER_USE_TASKS]);
    expect(await readTasks("computer-use")).toEqual([...COMPUTER_USE_TASKS]);
    expect(await readTasks("research")).toEqual([...RESEARCH_TASKS]);
    expect(await readTasks("coding")).toEqual([...CODING_TASKS]);
    expect(await readTasks("operations")).toEqual([...OPERATIONS_TASKS]);
    expect(CUSTOMER_SERVICE_TASKS.length).toBe(4);
    expect(BROWSER_USE_TASKS.length).toBe(3);
    expect(COMPUTER_USE_TASKS.length).toBe(3);
    expect(RESEARCH_TASKS.length).toBe(3);
    expect(CODING_TASKS.length).toBe(3);
    expect(OPERATIONS_TASKS.length).toBe(4);
  });

  test("every expected-failure edge row is declared (the honest contracts are pinned)", () => {
    const edgeRows = APPS.flatMap((app) =>
      app.tasks
        .map((task, index) => ({ app: app.name, index, terminal: task.expectedTerminal }))
        .filter((row) => row.terminal === "FAILED"),
    );
    expect(edgeRows).toEqual([
      { app: "browser-use", index: 2, terminal: "FAILED" },
      { app: "computer-use", index: 1, terminal: "FAILED" },
      { app: "coding", index: 2, terminal: "FAILED" },
      { app: "operations", index: 2, terminal: "FAILED" },
    ]);
  });
});
