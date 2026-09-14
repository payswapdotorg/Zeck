/**
 * VAL-043 acceptance criteria 1, 2 and the app-side discrimination
 * floor: the customer application over the fake public API world.
 *
 *   * the exported task slice mirrors the corpus exactly and
 *     config.json mirrors the exported task slice (the
 *     repository-reproducible, secret-free configuration);
 *   * the app's task bodies carry REFERENCES ONLY (never an inline
 *     price, never a configuration bound);
 *   * every row's submission lands ONE durable execution over the
 *     honest fake world (the create/replay semantics at the POST
 *     boundary) and passes with valid evidence;
 *   * the customer-boundary discriminations: a FABRICATED
 *     pass-with-fail FAILs the app honestly; a terminal override
 *     FAILs every mismatched row; a submission that never lands
 *     FAILs honestly (never a fabricated completion).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  COMPETING_TASKS,
  runCompetingApp,
} from "../../../benchmarks/validation/apps/economic-controls-competing/application";
import {
  COMPETING_CORPUS,
  COMPETING_TASK_KIND,
} from "../../../benchmarks/validation/apps/economic-controls-competing/corpus";
import {
  createCompetingFakeApiWorld,
  createTickClock,
} from "../../../benchmarks/validation/apps/economic-controls-competing/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";

const baseConfig = {
  applicationId: "app-1",
  baseUrl: "http://fake.local",
  tokenEnvVar: "ZECK_VALIDATION_TOKEN",
  applicationRevision: "test",
  corpusRevision: "test",
  integrationSurface: "stack:openrouter",
  pollIntervalMs: 1,
  completionTimeoutMs: 60_000,
};

/** Run the app over the fake world with optional discrimination knobs. */
async function runAppOverFakeWorld(options: {
  readonly taskIndex: number;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly verificationStatuses?: readonly string[];
  readonly fabricatePassWithFail?: boolean;
  readonly transport?: TransportImplementation;
}): Promise<{
  readonly outcome: Awaited<ReturnType<typeof runCompetingApp>>;
  readonly createdExecutions: number;
}> {
  const clock = createTickClock();
  const world = createCompetingFakeApiWorld({
    clock,
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.verificationStatuses === undefined
      ? {}
      : { verificationStatuses: options.verificationStatuses }),
    ...(options.fabricatePassWithFail === undefined
      ? {}
      : { fabricatePassWithFail: options.fabricatePassWithFail }),
  });
  const outcome = await runCompetingApp({
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
      configuration: { suite: "val-043-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
  });
  return { outcome, createdExecutions: world.createdExecutions };
}

/** The task index of one corpus row. */
function taskIndexOf(rowId: string): number {
  const index = COMPETING_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
}

// ---------------------------------------------------------------------------
// The pinned task slice ↔ corpus ↔ config.json consistency
// ---------------------------------------------------------------------------

describe("VAL-043 app task-slice consistency", () => {
  test("the exported task slice mirrors the corpus exactly", () => {
    expect(COMPETING_TASKS.length).toBe(COMPETING_CORPUS.length);
    for (const [index, task] of COMPETING_TASKS.entries()) {
      const row = COMPETING_CORPUS[index];
      expect(task.rowId).toBe(row?.rowId);
      expect(task.kind).toBe(COMPETING_TASK_KIND);
      expect(task.expectedTerminal).toBe(row?.expected.terminal);
      expect(task.armId).toBe(row?.arm.armId);
      expect(task.armKind).toBe(row?.arm.kind);
      expect(task.priceRevision).toBe(row?.arm.priceRevision);
      expect(task.competitorConfigRevision).toBe(row?.competitorConfigRevision);
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
          "../../../benchmarks/validation/apps/economic-controls-competing/config.json",
        ),
        "utf-8",
      ),
    ) as { tasks: Record<string, unknown>[]; tokenEnvVar: string; integrationSurface: string };
    expect(config.tasks.length).toBe(COMPETING_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const exported = COMPETING_TASKS[index] as {
        rowId?: string;
        kind?: string;
        expectedTerminal?: string;
        armId?: string;
        armKind?: string;
        priceRevision?: string;
        competitorConfigRevision?: string;
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
      expect(task.competitorConfigRevision).toBe(exported.competitorConfigRevision);
      expect(task.sliceSize).toBe(exported.sliceSize);
      expect(task.minimumSamples).toBe(exported.minimumSamples);
      expect(task.pinnedThreshold).toBe(exported.pinnedThreshold);
      expect(task.pinnedBudgetMicroUsd).toBe(exported.pinnedBudgetMicroUsd);
      expect(task.appCreated).toBe(exported.appCreated);
      expect(task.liveGate).toEqual(exported.liveGate);
    }
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("stack:openrouter");
  });

  test("the task bodies carry references only — never an inline price or configuration bound", () => {
    for (const row of COMPETING_CORPUS) {
      const body = JSON.stringify({
        rowId: row.rowId,
        armId: row.arm.armId,
        armKind: row.arm.kind,
        priceRevision: row.arm.priceRevision,
        competitorConfigRevision: row.competitorConfigRevision,
      });
      expect(body).not.toMatch(/"(input|output)Price"\s*:/);
      expect(body).not.toMatch(/"fxRate"\s*:/);
      expect(body).not.toMatch(/maxInternalRetries/);
      expect(body).not.toMatch(/variance/);
    }
  });
});

// ---------------------------------------------------------------------------
// The app over the honest fake world
// ---------------------------------------------------------------------------

describe("VAL-043 app over the honest fake world", () => {
  test("every row's submission lands ONE durable execution and passes with valid evidence", async () => {
    for (const [taskIndex, row] of COMPETING_CORPUS.entries()) {
      const result = await runAppOverFakeWorld({ taskIndex });
      expect(result.outcome.passed, `${row.rowId} app passed`).toBe(true);
      expect(result.createdExecutions, `${row.rowId} executions`).toBe(1);
      expect(result.outcome.observedTerminal).toBe(row.expected.terminal);
      expect(result.outcome.verificationStatuses).toEqual(["PASS", "PASS"]);
      const failed = result.outcome.competingCriteria.filter(
        (criterion) => criterion.status === "FAIL",
      );
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(validateHarnessEvidence(result.outcome.evidence)).toEqual([]);
      expect(result.outcome.evidence.terminalStatus).toBe(row.expected.terminal);
      expect(result.outcome.evidence.request?.taskKind).toBe(COMPETING_TASK_KIND);
    }
  }, 60_000);

  test("the submission key is per-row distinct and the timeline records the honest terminal", async () => {
    const first = await runAppOverFakeWorld({ taskIndex: 0 });
    expect(first.outcome.evidence.request?.idempotencyKey).toBe("val-043-app-unit-0");
    expect(first.outcome.evidence.timeline.length).toBeGreaterThan(0);
    const second = await runAppOverFakeWorld({ taskIndex: 1 });
    expect(second.outcome.evidence.request?.idempotencyKey).toBe("val-043-app-unit-1");
  });
});

// ---------------------------------------------------------------------------
// The app discriminations (the customer-boundary catches)
// ---------------------------------------------------------------------------

describe("VAL-043 app discriminations", () => {
  test("a FABRICATED pass-with-fail FAILs the app honestly", async () => {
    const result = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("fixed-quality-competitor-default-routing"),
      verificationStatuses: ["FAIL", "PASS"],
    });
    expect(result.outcome.passed).toBe(false);
    const failed = result.outcome.competingCriteria.filter(
      (criterion) => criterion.status === "FAIL",
    );
    expect(failed.map((criterion) => criterion.criterionId)).toContain(
      "app-terminal-criteria-agreement",
    );
  });

  test("a terminal override FAILs every mismatched row", async () => {
    const result = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("fixed-quality-competitor-routed-classes"),
      terminal: "FAILED",
    });
    expect(result.outcome.passed).toBe(false);
    const failed = result.outcome.competingCriteria.filter(
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
      taskIndex: taskIndexOf("zero-resolved-competitor-null-discipline"),
      transport: failingTransport,
    });
    expect(result.outcome.passed).toBe(false);
    expect(result.outcome.competingCriteria[0]?.criterionId).toBe("submission-landed");
    expect(result.outcome.competingCriteria[0]?.status).toBe("FAIL");
    expect(result.outcome.observedTerminal).toBeNull();
  });
});
