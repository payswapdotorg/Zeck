/**
 * VAL-041 acceptance criteria 1 and 2 (the app-side consistency +
 * the app-level discrimination floor): the customer application over
 * the fake public API world.
 *
 *   * the exported task slice mirrors the corpus exactly and
 *     config.json mirrors the exported task slice (the
 *     repository-reproducible, secret-free configuration);
 *   * the corpus well-formedness: portfolio references by digest,
 *     pinned price revisions valid in the manifest registry, arms
 *     validating against the frozen VAL-040 grammar, live gating;
 *   * every row's submission lands ONE durable execution over the
 *     honest fake world (the create/replay semantics at the POST
 *     boundary) and settles to its expected terminal (the honest
 *     COMPLETED controls AND the honestly-FAILED probe rows);
 *   * the customer-boundary discriminations: a FABRICATED
 *     pass-with-fail FAILs the app honestly; a terminal override
 *     FAILs every mismatched row; a submission that never lands
 *     FAILs honestly (never a fabricated completion).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { manifestRevisionOf } from "../../../benchmarks/validation/apps/economic-baseline/pricing";
import { validateArmDeclaration } from "../../../benchmarks/validation/apps/economic-baseline/protocol";
import {
  DIRECT_TASKS,
  runDirectApp,
} from "../../../benchmarks/validation/apps/economic-controls-direct/application";
import {
  DIRECT_CORPUS,
  DIRECT_CORPUS_VERSION,
  DIRECT_ROW_IDS,
  DIRECT_TASK_KIND,
  directRowById,
  directTasksForArm,
} from "../../../benchmarks/validation/apps/economic-controls-direct/corpus";
import {
  createDirectFakeApiWorld,
  createTickClock,
} from "../../../benchmarks/validation/apps/economic-controls-direct/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";
import { manifestDigestOf } from "../../../benchmarks/validation/platform/longitudinal-baseline";

const baseConfig = {
  applicationId: "app-1",
  baseUrl: "http://fake.local",
  tokenEnvVar: "ZECK_VALIDATION_TOKEN",
  applicationRevision: "test",
  corpusRevision: "test",
  integrationSurface: "direct:openrouter",
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
  readonly outcome: Awaited<ReturnType<typeof runDirectApp>>;
  readonly createdExecutions: number;
}> {
  const clock = createTickClock();
  const world = createDirectFakeApiWorld({
    clock,
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.verificationStatuses === undefined
      ? {}
      : { verificationStatuses: options.verificationStatuses }),
    ...(options.fabricatePassWithFail === undefined
      ? {}
      : { fabricatePassWithFail: options.fabricatePassWithFail }),
  });
  const outcome = await runDirectApp({
    config: baseConfig,
    token: "test-token",
    transport: options.transport ?? world.transport,
    now: clock.now,
    sleep: async () => {},
    environment: {
      runtime: "node test",
      toolchain: "vitest",
      database: "none",
      configuration: { suite: "val-041-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
  });
  return { outcome, createdExecutions: world.createdExecutions };
}

/** The task index of one corpus row. */
function taskIndexOf(rowId: string): number {
  const index = DIRECT_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
}

// ---------------------------------------------------------------------------
// The pinned task slice ↔ corpus ↔ config.json consistency
// ---------------------------------------------------------------------------

describe("VAL-041 app task-slice consistency", () => {
  test("the exported task slice mirrors the corpus exactly", () => {
    expect(DIRECT_TASKS.length).toBe(DIRECT_CORPUS.length);
    for (const [index, task] of DIRECT_TASKS.entries()) {
      const row = DIRECT_CORPUS[index];
      expect(task.rowId).toBe(row?.rowId);
      expect(task.kind).toBe(DIRECT_TASK_KIND);
      expect(task.expectedTerminal).toBe(row?.expected.terminal);
      expect(task.armId).toBe(row?.arm.armId);
      expect(task.armKind).toBe(row?.arm.kind);
      expect(task.integrationSurface).toBe(row?.arm.integrationSurface);
      expect(task.provider).toBe(row?.arm.provider);
      expect(task.model).toBe(row?.arm.model);
      expect(task.priceRevision).toBe(row?.arm.priceRevision);
      expect(task.sliceSize).toBe(row?.arm.corpusSlice.length);
      expect(task.minimumSamples).toBe(row?.arm.minimumSamples);
      const asPinned = task as {
        pinnedThreshold?: number;
        pinnedBudgetMicroUsd?: string;
        liveGate?: readonly string[];
      };
      if (row?.arm.kind === "fixed-quality") {
        expect(asPinned.pinnedThreshold).toBe(row.arm.pinnedThreshold.resolutionRate);
      } else if (row?.arm.kind === "fixed-cost") {
        expect(asPinned.pinnedBudgetMicroUsd).toBe(row.arm.pinnedBudgetMicroUsd);
      }
      if (row?.liveGate === undefined) {
        expect(asPinned.liveGate).toBeUndefined();
      } else {
        expect(asPinned.liveGate).toEqual(row.liveGate.envVars);
      }
      expect(task.appCreated).toBe(row?.expected.appCreated);
      expect(task.replayedSubmissions).toBe(row?.expected.replayedSubmissions);
      expect(task.rejectedSubmissions).toBe(row?.expected.rejectedSubmissions);
    }
  });

  test("config.json mirrors the exported task slice", async () => {
    const raw = await readFile(
      join("benchmarks", "validation", "apps", "economic-controls-direct", "config.json"),
      "utf8",
    );
    const config = JSON.parse(raw) as {
      readonly integrationSurface: string;
      readonly tokenEnvVar: string;
      readonly tasks: readonly Record<string, unknown>[];
    };
    expect(config.tasks.length).toBe(DIRECT_TASKS.length);
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("direct:openrouter");
    for (const [index, task] of config.tasks.entries()) {
      expect(task.rowId).toBe(DIRECT_TASKS[index]?.rowId);
      expect(task.kind).toBe(DIRECT_TASK_KIND);
      expect(task.expectedTerminal).toBe(DIRECT_TASKS[index]?.expectedTerminal);
      expect(task.armId).toBe(DIRECT_TASKS[index]?.armId);
      expect(task.priceRevision).toBe(DIRECT_TASKS[index]?.priceRevision);
      expect(task.sliceSize).toBe(DIRECT_TASKS[index]?.sliceSize);
      expect(task.minimumSamples).toBe(DIRECT_TASKS[index]?.minimumSamples);
    }
  });

  test("config.json is secret-free", async () => {
    const raw = await readFile(
      join("benchmarks", "validation", "apps", "economic-controls-direct", "config.json"),
      "utf8",
    );
    // The env-var NAME rides the live rows' gates (never a secret
    // VALUE); no credential VALUE may appear anywhere.
    expect(raw).not.toContain("sk-");
    expect(raw).not.toMatch(/"(apiKey|api_key|password|secret)"\s*:/i);
  });
});

// ---------------------------------------------------------------------------
// The corpus well-formedness
// ---------------------------------------------------------------------------

describe("VAL-041 corpus well-formedness", () => {
  test("the row ids are unique and the row lookup agrees", () => {
    expect(new Set(DIRECT_ROW_IDS).size).toBe(DIRECT_ROW_IDS.length);
    for (const rowId of DIRECT_ROW_IDS) {
      expect(directRowById(rowId)?.rowId).toBe(rowId);
    }
    expect(directRowById("no-such-row")).toBeNull();
  });

  test("every arm validates against the frozen VAL-040 grammar and declares a direct surface", () => {
    for (const row of DIRECT_CORPUS) {
      expect(validateArmDeclaration(row.arm)).toEqual([]);
      expect(row.arm.integrationSurface.startsWith("direct:")).toBe(true);
      expect(row.arm.minimumSamples).toBeGreaterThan(0);
      expect(row.arm.minimumSamples).toBeLessThanOrEqual(row.arm.corpusSlice.length);
    }
  });

  test("every pinned price revision is known in the manifest registry", () => {
    for (const row of DIRECT_CORPUS) {
      const manifest = manifestRevisionOf(row.arm.priceRevision);
      expect(manifest).not.toBeNull();
      const entry = manifest?.tables.find(
        (candidate) =>
          candidate.provider === row.arm.provider &&
          candidate.model === row.arm.model &&
          candidate.tier === "input",
      );
      expect(entry).toBeDefined();
    }
  });

  test("the frozen-portfolio references are the VAL-030 baseline revisions by digest", () => {
    for (const row of DIRECT_CORPUS) {
      const reference = row.frozenPortfolio;
      const rederived = manifestDigestOf({
        appId: reference.appId,
        appDigest: reference.appDigest,
        workloadId: reference.workloadId,
        workloadRevision: reference.workloadRevision,
        workloadDigest: reference.workloadDigest,
      });
      expect(rederived).toBe(reference.manifestDigest);
    }
  });

  test("the offline rows carry recorded traces for (at least) their executed prefix; live rows do not", () => {
    for (const row of DIRECT_CORPUS) {
      if (row.needsDispatch) {
        expect(row.liveGate?.envVars).toContain("OPENROUTER_API_KEY");
        for (const plan of row.directReplay) {
          expect(plan.recorded).toBeUndefined();
        }
      } else {
        expect(row.liveGate).toBeUndefined();
        expect(row.directReplay.length).toBeGreaterThan(0);
        expect(row.expected.normalized).toBeDefined();
      }
    }
  });

  test("the golden tasks derive for every arm over its full pre-registered slice", () => {
    for (const row of DIRECT_CORPUS) {
      const tasks = directTasksForArm(row.arm);
      expect(tasks.length).toBe(row.arm.corpusSlice.length);
      for (const task of tasks) {
        expect(task.expectedOutcome.terminalStatus).toBe("COMPLETED");
        expect(task.expectedOutcome.containsText).toContain("confirm");
        expect(task.evaluation.method).toBe("deterministic");
      }
    }
  });

  test("the corpus version is pinned", () => {
    expect(DIRECT_CORPUS_VERSION).toBe("val-041-direct-controls-v1");
  });
});

// ---------------------------------------------------------------------------
// The app over the honest fake world
// ---------------------------------------------------------------------------

describe("VAL-041 app over the honest fake world", () => {
  test("every row's submission lands ONE durable execution with valid evidence", async () => {
    for (const [index] of DIRECT_CORPUS.entries()) {
      const { outcome, createdExecutions } = await runAppOverFakeWorld({ taskIndex: index });
      expect(createdExecutions).toBe(1);
      expect(outcome.observedTerminal).toBe(DIRECT_CORPUS[index]?.expected.terminal);
      expect(outcome.passed).toBe(true);
      const violations = validateHarnessEvidence(outcome.evidence);
      expect(violations).toEqual([]);
      expect(outcome.submissionLatencyMs.length).toBe(1);
      expect(outcome.submissionLatencyMs[0]).toBeGreaterThanOrEqual(0);
    }
  });

  test("the honest control rows settle COMPLETED with all-PASS statuses", async () => {
    const index = taskIndexOf("fixed-quality-direct-default-rail");
    const { outcome } = await runAppOverFakeWorld({ taskIndex: index });
    expect(outcome.observedTerminal).toBe("COMPLETED");
    expect(outcome.verificationStatuses.every((status) => status === "PASS")).toBe(true);
    for (const criterion of outcome.directCriteria) {
      expect(criterion.status).toBe("PASS");
    }
  });

  test("the probe rows settle FAILED honestly (the failure is the verified outcome)", async () => {
    const index = taskIndexOf("probe-platform-shortcut-masquerade");
    const { outcome } = await runAppOverFakeWorld({ taskIndex: index });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(outcome.verificationStatuses).toContain("FAIL");
    expect(outcome.passed).toBe(true);
  });

  test("a same-key re-submission replays the committed receipt (no second execution)", async () => {
    const clock = createTickClock();
    const world = createDirectFakeApiWorld({ clock });
    const run = async () =>
      runDirectApp({
        config: baseConfig,
        token: "test-token",
        transport: world.transport,
        now: clock.now,
        sleep: async () => {},
        environment: {
          runtime: "node test",
          toolchain: "vitest",
          database: "none",
          configuration: { suite: "val-041-apps" },
        },
        runSuffix: "unit",
        taskIndex: 0,
      });
    const first = await run();
    const second = await run();
    expect(world.createdExecutions).toBe(1);
    expect(first.passed).toBe(true);
    expect(second.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The customer-boundary discriminations
// ---------------------------------------------------------------------------

describe("VAL-041 app customer-boundary discriminations", () => {
  test("a FABRICATED pass-with-fail FAILs the app honestly (anyFail→FAILED at the boundary)", async () => {
    const index = taskIndexOf("probe-estimate-backed-cost");
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: index,
      fabricatePassWithFail: true,
    });
    expect(outcome.observedTerminal).toBe("COMPLETED");
    expect(outcome.verificationStatuses).toContain("FAIL");
    expect(outcome.passed).toBe(false);
    const agreement = outcome.directCriteria.find(
      (criterion) => criterion.criterionId === "app-terminal-criteria-agreement",
    );
    expect(agreement?.status).toBe("FAIL");
  });

  test("a terminal override FAILs every mismatched row", async () => {
    const index = taskIndexOf("fixed-quality-direct-default-rail");
    const { outcome } = await runAppOverFakeWorld({ taskIndex: index, terminal: "FAILED" });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(outcome.passed).toBe(false);
    const expected = outcome.directCriteria.find(
      (criterion) => criterion.criterionId === "app-expected-terminal",
    );
    expect(expected?.status).toBe("FAIL");
  });

  test("a fabricated all-PASS status list over a FAILED-expected row FAILs the agreement", async () => {
    const index = taskIndexOf("probe-mixed-currency-conflation");
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: index,
      terminal: "FAILED",
      verificationStatuses: ["PASS", "PASS"],
    });
    expect(outcome.passed).toBe(false);
    const agreement = outcome.directCriteria.find(
      (criterion) => criterion.criterionId === "app-terminal-criteria-agreement",
    );
    expect(agreement?.status).toBe("FAIL");
  });

  test("a submission that never lands FAILs honestly (never a fabricated completion)", async () => {
    const rejectingTransport: TransportImplementation = async () =>
      new Response(JSON.stringify({ code: "CAPABILITY_UNAVAILABLE", retryable: false }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    const { outcome, createdExecutions } = await runAppOverFakeWorld({
      taskIndex: 0,
      transport: rejectingTransport,
    });
    expect(createdExecutions).toBe(0);
    expect(outcome.observedTerminal).toBeNull();
    expect(outcome.passed).toBe(false);
    expect(outcome.directCriteria[0]?.criterionId).toBe("submission-landed");
    expect(outcome.directCriteria[0]?.status).toBe("FAIL");
  });
});
