/**
 * VAL-040 acceptance criterion 1: the economic-baseline customer
 * application rides the public SDK boundary end to end against a
 * controlled fake transport (the submission → the completion poll →
 * the result retrieval → the deterministic assertions → the
 * recorder-consumable evidence), and its pinned task slice matches
 * the repository configuration file and the corpus. The fake world
 * implements the platform's OWN semantics at the customer boundary
 * (the create/replay semantics at the POST boundary; the honest
 * outcome shapes — COMPLETED with all-PASS statuses — at the read
 * boundary) so the app's per-row outcome assertions are exercised
 * honestly.
 *
 * Discrimination: a FABRICATED pass-with-fail (a COMPLETED terminal
 * with a FAIL verification status) FAILs the app honestly; a terminal
 * override fails every mismatched row; a submission that never lands
 * FAILs honestly (never a fabricated completion).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ECONOMIC_TASKS,
  runEconomicApp,
} from "../../../benchmarks/validation/apps/economic-baseline/application";
import {
  ECONOMIC_CORPUS,
  ECONOMIC_TASK_KIND,
} from "../../../benchmarks/validation/apps/economic-baseline/corpus";
import {
  createEconomicFakeApiWorld,
  createTickClock,
} from "../../../benchmarks/validation/apps/economic-baseline/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";

const REVISION = "d63a77e684f6097dd974caabe4a05d6c39302fe3";

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

/** Run one app row over the fake API world. */
async function runAppOverFakeWorld(options: {
  readonly taskIndex: number;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly verificationStatuses?: readonly string[];
  readonly fabricatePassWithFail?: boolean;
  readonly transport?: TransportImplementation;
}): Promise<{
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly outcome: Awaited<ReturnType<typeof runEconomicApp>>;
  readonly createdExecutions: number;
}> {
  const clock = createTickClock();
  const world = createEconomicFakeApiWorld({
    clock,
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.verificationStatuses === undefined
      ? {}
      : { verificationStatuses: options.verificationStatuses }),
    ...(options.fabricatePassWithFail === undefined
      ? {}
      : { fabricatePassWithFail: options.fabricatePassWithFail }),
  });
  const outcome = await runEconomicApp({
    config: baseConfig,
    token: "zeck-token-fake",
    transport: options.transport ?? (world.transport as TransportImplementation),
    now: clock.now,
    sleep: async (ms) => {
      clock.advance(ms);
    },
    environment: {
      runtime: "node test",
      toolchain: "vitest",
      database: "none",
      configuration: { suite: "val-040-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
  });
  return {
    evidence: outcome.evidence,
    passed: outcome.passed,
    outcome,
    createdExecutions: world.createdExecutions,
  };
}

/** The task index of one corpus row. */
function taskIndexOf(rowId: string): number {
  const index = ECONOMIC_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
}

// ---------------------------------------------------------------------------
// The pinned task slice ↔ corpus ↔ config.json consistency
// ---------------------------------------------------------------------------

describe("VAL-040 app task-slice consistency", () => {
  test("the exported task slice mirrors the corpus exactly", () => {
    expect(ECONOMIC_TASKS.length).toBe(ECONOMIC_CORPUS.length);
    for (const [index, task] of ECONOMIC_TASKS.entries()) {
      const row = ECONOMIC_CORPUS[index];
      expect(task.rowId).toBe(row?.rowId);
      expect(task.kind).toBe(ECONOMIC_TASK_KIND);
      expect(task.expectedTerminal).toBe(row?.expected.terminal);
      expect(task.armId).toBe(row?.arm.armId);
      expect(task.armKind).toBe(row?.arm.kind);
      expect(task.priceRevision).toBe(row?.arm.priceRevision);
      expect(task.sliceSize).toBe(row?.arm.corpusSlice.length);
      expect(task.minimumSamples).toBe(row?.arm.minimumSamples);
      const asPinned = task as {
        pinnedThreshold?: number;
        pinnedBudgetMicroUsd?: string;
      };
      if (row?.arm.kind === "fixed-quality") {
        expect(asPinned.pinnedThreshold).toBe(row.arm.pinnedThreshold.resolutionRate);
      } else if (row?.arm.kind === "fixed-cost") {
        expect(asPinned.pinnedBudgetMicroUsd).toBe(row.arm.pinnedBudgetMicroUsd);
      }
      expect(task.appCreated).toBe(row?.expected.appCreated);
      expect(task.replayedSubmissions).toBe(row?.expected.replayedSubmissions);
      expect(task.rejectedSubmissions).toBe(row?.expected.rejectedSubmissions);
    }
  });

  test("config.json mirrors the exported task slice", async () => {
    const config = JSON.parse(
      await readFile(
        join(
          import.meta.dirname,
          "../../../benchmarks/validation/apps/economic-baseline/config.json",
        ),
        "utf-8",
      ),
    ) as { tasks: Record<string, unknown>[]; tokenEnvVar: string; integrationSurface: string };
    expect(config.tasks.length).toBe(ECONOMIC_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const exported = ECONOMIC_TASKS[index] as {
        rowId?: string;
        kind?: string;
        expectedTerminal?: string;
        armId?: string;
        armKind?: string;
        priceRevision?: string;
        sliceSize?: number;
        minimumSamples?: number;
        pinnedThreshold?: number;
        pinnedBudgetMicroUsd?: string;
        appCreated?: number;
        liveGate?: string[];
      };
      expect(task.rowId).toBe(exported.rowId);
      expect(task.kind).toBe(exported.kind);
      expect(task.expectedTerminal).toBe(exported.expectedTerminal);
      expect(task.armId).toBe(exported.armId);
      expect(task.armKind).toBe(exported.armKind);
      expect(task.priceRevision).toBe(exported.priceRevision);
      expect(task.sliceSize).toBe(exported.sliceSize);
      expect(task.minimumSamples).toBe(exported.minimumSamples);
      expect(task.pinnedThreshold).toBe(exported.pinnedThreshold);
      expect(task.pinnedBudgetMicroUsd).toBe(exported.pinnedBudgetMicroUsd);
      expect(task.appCreated).toBe(exported.appCreated);
      expect(task.liveGate).toEqual(exported.liveGate);
    }
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("sdk");
  });

  test("the task bodies carry references only — never an inline list price", () => {
    for (const row of ECONOMIC_CORPUS) {
      const body = JSON.stringify({
        rowId: row.rowId,
        armId: row.arm.armId,
        armKind: row.arm.kind,
        priceRevision: row.arm.priceRevision,
      });
      expect(body).not.toMatch(/"(input|output)Price"\s*:/);
      expect(body).not.toMatch(/"fxRate"\s*:/);
    }
  });
});

// ---------------------------------------------------------------------------
// The app over the honest fake world
// ---------------------------------------------------------------------------

describe("VAL-040 app over the honest fake world", () => {
  test("every row's submission lands ONE durable execution and passes with valid evidence", async () => {
    for (const [taskIndex, row] of ECONOMIC_CORPUS.entries()) {
      const result = await runAppOverFakeWorld({ taskIndex });
      expect(result.outcome.passed, `${row.rowId} app passed`).toBe(true);
      expect(result.createdExecutions, `${row.rowId} executions`).toBe(1);
      expect(result.outcome.observedTerminal).toBe(row.expected.terminal);
      expect(result.outcome.verificationStatuses).toEqual(["PASS", "PASS"]);
      const failed = result.outcome.economicCriteria.filter(
        (criterion) => criterion.status === "FAIL",
      );
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(validateHarnessEvidence(result.evidence)).toEqual([]);
      expect(result.evidence.terminalStatus).toBe(row.expected.terminal);
      expect(result.evidence.request?.taskKind).toBe(ECONOMIC_TASK_KIND);
    }
  }, 60_000);

  test("the submission key is per-row distinct and the timeline records the honest terminal", async () => {
    const first = await runAppOverFakeWorld({ taskIndex: 0 });
    expect(first.evidence.request?.idempotencyKey).toBe("val-040-app-unit-0");
    expect(first.evidence.timeline.length).toBeGreaterThan(0);
    const second = await runAppOverFakeWorld({ taskIndex: 1 });
    expect(second.evidence.request?.idempotencyKey).toBe("val-040-app-unit-1");
  });
});

// ---------------------------------------------------------------------------
// The app discriminations (the customer-boundary catches)
// ---------------------------------------------------------------------------

describe("VAL-040 app discriminations", () => {
  test("a FABRICATED pass-with-fail FAILs the app honestly", async () => {
    const result = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("fixed-quality-openrouter-usd-metered"),
      verificationStatuses: ["FAIL", "PASS"],
    });
    expect(result.outcome.passed).toBe(false);
    const failed = result.outcome.economicCriteria.filter(
      (criterion) => criterion.status === "FAIL",
    );
    expect(failed.map((criterion) => criterion.criterionId)).toContain(
      "app-terminal-criteria-agreement",
    );
  });

  test("a terminal override FAILs every mismatched row", async () => {
    const result = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("fixed-quality-euro-relay-eur"),
      terminal: "FAILED",
    });
    expect(result.outcome.passed).toBe(false);
    const failed = result.outcome.economicCriteria.filter(
      (criterion) => criterion.status === "FAIL",
    );
    expect(failed.map((criterion) => criterion.criterionId)).toContain("app-expected-terminal");
  });

  test("a submission that never lands FAILs honestly (never a fabricated completion)", async () => {
    const clock = createTickClock();
    const failingTransport: TransportImplementation = async (input: unknown) => {
      void input;
      await clock.tick();
      return new Response(
        JSON.stringify({
          code: "CAPABILITY_UNAVAILABLE",
          message: "the fake API is unavailable",
          retryable: false,
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    };
    const result = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("fixed-quality-retry-amortization"),
      transport: failingTransport,
    });
    expect(result.outcome.passed).toBe(false);
    expect(result.outcome.economicCriteria[0]?.criterionId).toBe("submission-landed");
    expect(result.outcome.economicCriteria[0]?.status).toBe("FAIL");
    expect(result.outcome.observedTerminal).toBeNull();
  });
});
