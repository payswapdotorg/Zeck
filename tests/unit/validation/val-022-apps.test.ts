/**
 * VAL-022 acceptance criterion 1: the substrate-failure customer
 * application rides the public SDK boundary end to end against a
 * controlled fake transport (submission → async completion → result
 * retrieval → deterministic assertions → recorder-consumable
 * evidence), and its pinned FLAT task slice (one entry per EXECUTION)
 * matches the repository configuration file and the corpus.
 * Discrimination: a FAILED platform outcome fails the COMPLETED
 * executions' assertions (the application never passes a failed
 * execution) while the substrate-failure entries EXPECT the honest
 * FAILED — and a fabricated COMPLETED on a failure entry FAILS the
 * app's assertions (a fabricated recovery is never tolerated).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runSubstrateFailureApp } from "../../../benchmarks/validation/apps/substrate-failure/application";
import {
  SUBSTRATE_CORPUS,
  SUBSTRATE_FAILURE_TASKS,
} from "../../../benchmarks/validation/apps/substrate-failure/corpus";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";

const REVISION = "fefb52f736b20e852b040c8cedc025fbc693171a";

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
        task: { kind: "substrate-readiness.probe.v1", scenario: "healthy-clean-run" },
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
          provider: "substrate-probe-rail",
          model: "process",
          strategyClass: "substrate-readiness-probe",
          modelCalls: 1,
        },
        cost: pass ? { totalMicroUsd: "1250", currency: "usd" } : null,
        usage: pass ? { inputTokens: 0, outputTokens: 0 } : null,
        outputArtifacts: [],
        // The fake mirrors the REAL platform semantics for this slice —
        // the criteria verify the substrate SEMANTICS
        // (classification, bounded retry, readiness gating,
        // quarantine); a correctly-classified substrate failure PASSES
        // its criteria while the honest FAILED terminal carries the
        // failure itself (the VAL-020 review calibration).
        verification: [
          {
            id: "v1",
            executionId: resultMatch[1],
            criterionId: "substrate-class",
            strategy: "deterministic",
            status: "PASS",
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
  return runSubstrateFailureApp({
    config: baseConfig,
    token: "zeck-token-fake",
    transport,
    now: () => new Date(1_000),
    sleep: async () => {},
    environment: {
      runtime: "node test",
      toolchain: "vitest",
      database: "none",
      configuration: { suite: "val-022-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
  });
}

describe("VAL-022 substrate-failure application (public SDK boundary)", () => {
  test("the FLAT task slice mirrors the corpus exactly (one entry per execution, in corpus order)", () => {
    const expectedCount = SUBSTRATE_CORPUS.reduce((sum, row) => sum + row.executions.length, 0);
    expect(SUBSTRATE_FAILURE_TASKS.length).toBe(expectedCount);
    let cursor = 0;
    for (const row of SUBSTRATE_CORPUS) {
      for (const [executionIndex, oracle] of row.executions.entries()) {
        const task = SUBSTRATE_FAILURE_TASKS[cursor];
        if (task === undefined) throw new Error("missing task entry");
        expect(task.scenario, `${row.rowId}#${executionIndex + 1} scenario`).toBe(row.rowId);
        expect(task.execution).toBe(executionIndex + 1);
        expect(task.substrate).toBe(row.substrateId);
        expect(task.kind).toBe("substrate-readiness.probe.v1");
        expect(task.expectedTerminal).toBe(oracle.expected.terminal);
        cursor += 1;
      }
    }
  });

  test("the repository config.json mirrors the pinned task slice", async () => {
    const config = JSON.parse(
      await readFile(
        join(process.cwd(), "benchmarks/validation/apps/substrate-failure/config.json"),
        "utf8",
      ),
    ) as {
      tasks: {
        kind: string;
        scenario: string;
        execution: number;
        substrate: string;
        expectedTerminal: string;
      }[];
    };
    expect(config.tasks.length).toBe(SUBSTRATE_FAILURE_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const pinned = SUBSTRATE_FAILURE_TASKS[index];
      if (pinned === undefined) throw new Error("missing pinned task");
      expect(task.kind).toBe(pinned.kind);
      expect(task.scenario).toBe(pinned.scenario);
      expect(task.execution).toBe(pinned.execution);
      expect(task.substrate).toBe(pinned.substrate);
      expect(task.expectedTerminal).toBe(pinned.expectedTerminal);
    }
  });

  test("every COMPLETED execution passes on the honest COMPLETED outcome with valid evidence", async () => {
    for (const [index, task] of SUBSTRATE_FAILURE_TASKS.entries()) {
      if (task.expectedTerminal !== "COMPLETED") {
        continue;
      }
      const outcome = await runAppOverFakeWorld({ terminal: "COMPLETED", taskIndex: index });
      expect(outcome.passed, `${task.scenario}#${task.execution} should pass on COMPLETED`).toBe(
        true,
      );
      expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    }
  });

  test("every substrate-failure execution passes on the honest FAILED outcome (they EXPECT the failure)", async () => {
    for (const [index, task] of SUBSTRATE_FAILURE_TASKS.entries()) {
      if (task.expectedTerminal !== "FAILED") {
        continue;
      }
      const outcome = await runAppOverFakeWorld({ terminal: "FAILED", taskIndex: index });
      expect(outcome.passed, `${task.scenario}#${task.execution} should pass on FAILED`).toBe(true);
      expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    }
  });

  test("a fabricated COMPLETED on a substrate-failure entry FAILS the app's assertions (never a fabricated recovery)", async () => {
    const lostIndex = SUBSTRATE_FAILURE_TASKS.findIndex(
      (task) => task.scenario === "sandbox-lost-exhausted",
    );
    if (lostIndex < 0) throw new Error("missing exhausted entry");
    const outcome = await runAppOverFakeWorld({ terminal: "COMPLETED", taskIndex: lostIndex });
    expect(outcome.passed).toBe(false);
  });

  test("a FAILED platform outcome fails the COMPLETED entries (the app never passes a failed execution)", async () => {
    for (const task of SUBSTRATE_FAILURE_TASKS) {
      if (task.expectedTerminal !== "COMPLETED") {
        continue;
      }
      const index = SUBSTRATE_FAILURE_TASKS.indexOf(task);
      const outcome = await runAppOverFakeWorld({ terminal: "FAILED", taskIndex: index });
      expect(outcome.passed, `${task.scenario}#${task.execution} must fail on FAILED`).toBe(false);
    }
  });

  test("the app's submissions carry per-execution-distinct idempotency keys (the VAL-018 lesson)", async () => {
    const seen = new Set<string>();
    const { transport } = createFakeApiWorld({ terminal: "COMPLETED" });
    for (const index of [9, 10, 11]) {
      const outcome = await runSubstrateFailureApp({
        config: baseConfig,
        token: "zeck-token-fake",
        transport,
        now: () => new Date(1_000),
        sleep: async () => {},
        environment: {
          runtime: "node test",
          toolchain: "vitest",
          database: "none",
          configuration: { suite: "val-022-apps" },
        },
        runSuffix: "unit",
        taskIndex: index,
      });
      expect(outcome.evidence.request).not.toBeNull();
      const key = outcome.evidence.request?.idempotencyKey;
      if (key === undefined || key === null) throw new Error("missing idempotency key");
      expect(seen.has(key), `idempotency key ${key} must be distinct`).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(3);
  });
});
