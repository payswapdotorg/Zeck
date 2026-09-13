/**
 * VAL-022 acceptance criterion 1: the substrate-failure customer
 * application rides the public SDK boundary end to end against a
 * controlled fake transport (submission → async completion → result
 * retrieval → deterministic assertions → recorder-consumable
 * evidence), per submission, and its pinned task slice matches the
 * repository configuration file and the corpus. Discrimination: a
 * fabricated COMPLETED outcome on a failure submission FAILS the app's
 * assertions (a fabricated recovery is never tolerated) while a FAILED
 * outcome on a healthy/recovery submission fails it likewise.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  runSubstrateFailureApp,
  SUBSTRATE_FAILURE_TASKS,
} from "../../../benchmarks/validation/apps/substrate-failure/application";
import {
  headlineTerminalOf,
  SUBSTRATE_FAILURE_CORPUS,
  submissionCountOf,
} from "../../../benchmarks/validation/apps/substrate-failure/corpus";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";

const REVISION = "d6845502f398d98f441a799c1d43d6f84736c884";

/**
 * A minimal fake public API over the SDK's injected transport seam:
 * create → receipt, poll → terminal status (per submission index), and
 * results → the packaged outcome with the verification the fake
 * platform recorded.
 */
function createFakeApiWorld(options: {
  /** The terminal each sequentially-created execution reports (cycled if shorter). */
  readonly terminals: readonly ("COMPLETED" | "FAILED")[];
}): {
  readonly transport: TransportImplementation;
  readonly createdExecutions: string[];
} {
  const executions = new Map<string, { status: string; terminal: string }>();
  const createdExecutions: string[] = [];
  let sequence = 0;
  const transport: TransportImplementation = async (input: unknown, init?: unknown) => {
    const url = String(input);
    const method = String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    if (url.endsWith("/executions") && method === "POST") {
      sequence += 1;
      const id = `fake-exec-${sequence}`;
      const terminal = options.terminals[(sequence - 1) % options.terminals.length] ?? "COMPLETED";
      executions.set(id, { status: "RUNNING", terminal });
      createdExecutions.push(id);
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
      return jsonResponse(200, {
        id: execMatch[1],
        applicationId: "app-1",
        environmentId: null,
        status: execution.terminal,
        task: { kind: "substrate-probe", scenario: "healthy-substrate" },
        constraints: null,
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        terminalAt: new Date().toISOString(),
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
      const pass = execution.terminal === "COMPLETED";
      return jsonResponse(200, {
        executionId: resultMatch[1],
        status: execution.terminal,
        route: {
          provider: "substrate-plane",
          model: "substrate-failure-probe",
          strategyClass: "substrate-failure-probe",
          modelCalls: 1,
        },
        cost: pass ? { totalMicroUsd: "0", currency: "usd" } : null,
        usage: pass ? { inputTokens: 0, outputTokens: 0 } : null,
        outputArtifacts: [],
        // The fake mirrors the REAL platform semantics for this slice:
        // the criteria prove the substrate-failure semantics (a
        // correctly-classified failure PASSES its criteria while the
        // terminal stays honestly FAILED).
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
  return { transport, createdExecutions };
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
  readonly terminals: readonly ("COMPLETED" | "FAILED")[];
  readonly taskIndex: number;
}): Promise<{
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly createdExecutions: string[];
}> {
  const { transport, createdExecutions } = createFakeApiWorld({
    terminals: options.terminals,
  });
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
    taskIndex: options.taskIndex,
  });
  return {
    evidence: outcome.evidence,
    passed: outcome.passed,
    createdExecutions,
  };
}

describe("VAL-022 substrate-failure application (public SDK boundary)", () => {
  test("the task slice mirrors the corpus exactly (scenario, submission, terminal)", () => {
    expect(SUBSTRATE_FAILURE_TASKS.length).toBe(
      SUBSTRATE_FAILURE_CORPUS.reduce((sum, row) => sum + submissionCountOf(row), 0),
    );
    let cursor = 0;
    for (const row of SUBSTRATE_FAILURE_CORPUS) {
      for (let submission = 1; submission <= submissionCountOf(row); submission += 1) {
        const task = SUBSTRATE_FAILURE_TASKS[cursor];
        cursor += 1;
        if (task === undefined) throw new Error("missing pinned task");
        expect(task.scenario).toBe(row.rowId);
        expect(task.submission).toBe(submission);
        expect(task.expectedTerminal).toBe(
          row.oracle.submissions[submission - 1]?.terminal ?? headlineTerminalOf(row),
        );
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
      tasks: { kind: string; scenario: string; submission: number; expectedTerminal: string }[];
    };
    expect(config.tasks.length).toBe(SUBSTRATE_FAILURE_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const pinned = SUBSTRATE_FAILURE_TASKS[index];
      if (pinned === undefined) throw new Error("missing pinned task");
      expect(task.kind).toBe(pinned.kind);
      expect(task.scenario).toBe(pinned.scenario);
      expect(task.submission).toBe(pinned.submission);
      expect(task.expectedTerminal).toBe(pinned.expectedTerminal);
    }
  });

  test("single-submission rows PASS on their honest outcome with valid evidence", async () => {
    for (const [index, row] of SUBSTRATE_FAILURE_CORPUS.entries()) {
      if (submissionCountOf(row) !== 1) {
        continue;
      }
      const terminal = headlineTerminalOf(row);
      const outcome = await runAppOverFakeWorld({
        terminals: [terminal],
        taskIndex: index,
      });
      expect(outcome.passed, `${row.rowId} should pass on ${terminal}`).toBe(true);
      expect(outcome.createdExecutions.length).toBe(1);
      expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    }
  });

  test("the quarantine row: four sequential submissions, each on its declared terminal — the app passes with per-submission evidence", async () => {
    const index = SUBSTRATE_FAILURE_CORPUS.findIndex(
      (row) => row.rowId === "quarantine-propagation-and-recovery",
    );
    if (index < 0) throw new Error("missing quarantine row");
    const outcome = await runAppOverFakeWorld({
      terminals: ["FAILED", "FAILED", "FAILED", "COMPLETED"],
      taskIndex: index,
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.createdExecutions.length).toBe(4);
    expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
  });

  test("a fabricated COMPLETED on a failure row FAILS the app's assertions (never a fabricated recovery)", async () => {
    const oomIndex = SUBSTRATE_FAILURE_CORPUS.findIndex(
      (row) => row.rowId === "resource-exhausted-oom",
    );
    if (oomIndex < 0) throw new Error("missing OOM row");
    const outcome = await runAppOverFakeWorld({ terminals: ["COMPLETED"], taskIndex: oomIndex });
    expect(outcome.passed).toBe(false);
  });

  test("a FAILED platform outcome fails the healthy and recovery rows (the app never passes a failed execution)", async () => {
    for (const rowId of [
      "healthy-substrate",
      "readiness-refused-transient",
      "sandbox-lost-recovery",
      "real-process-echo-healthy",
    ]) {
      const index = SUBSTRATE_FAILURE_CORPUS.findIndex((row) => row.rowId === rowId);
      if (index < 0) throw new Error(`missing healthy row ${rowId}`);
      const outcome = await runAppOverFakeWorld({ terminals: ["FAILED"], taskIndex: index });
      expect(outcome.passed, `${rowId} must fail on a fabricated FAILED`).toBe(false);
    }
  });

  test("the quarantine row fails when the recovery submission is served a fabricated FAILED terminal", async () => {
    const index = SUBSTRATE_FAILURE_CORPUS.findIndex(
      (row) => row.rowId === "quarantine-propagation-and-recovery",
    );
    if (index < 0) throw new Error("missing quarantine row");
    const outcome = await runAppOverFakeWorld({
      terminals: ["FAILED", "FAILED", "FAILED", "FAILED"],
      taskIndex: index,
    });
    expect(outcome.passed).toBe(false);
  });
});
