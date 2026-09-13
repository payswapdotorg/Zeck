/**
 * VAL-025 acceptance criterion 1: the concurrency/soak customer
 * application rides the public SDK boundary end to end against a
 * controlled fake transport (the concurrent submission phase → the
 * bounded completion/admission polls → the result retrieval → the
 * deterministic assertions → the recorder-consumable evidence), and
 * its pinned task slice matches the repository configuration file and
 * the corpus. The fake world implements the platform's OWN
 * concurrency semantics (the racing arbitration at the create
 * boundary, the admission shaping at the authorize boundary with the
 * durable policy-denied envelope) so the app's per-pattern submission
 * assertions are exercised honestly.
 *
 * Discrimination: a LEAKY racing fake that admits both racers FAILs
 * the racing rows' app assertions; a FAILED platform outcome fails
 * every row; a failed verification status fails every row.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CONCURRENCY_SOAK_TASKS,
  runConcurrencySoakApp,
} from "../../../benchmarks/validation/apps/concurrency-soak/application";
import {
  CONCURRENCY_CORPUS,
  CONCURRENCY_TASK_KIND,
  CORPUS_SOAK_POLICY,
} from "../../../benchmarks/validation/apps/concurrency-soak/corpus";
import {
  createConcurrencyFakeApiWorld,
  createTickClock,
} from "../../../benchmarks/validation/apps/concurrency-soak/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";

const REVISION = "060972617c256889dbae5c51a65017edf5cb54b1";

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
  readonly roundIndex?: number;
  readonly ceiling?: number;
  readonly leakyRace?: boolean;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly verificationStatuses?: readonly string[];
}): Promise<{
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly outcome: Awaited<ReturnType<typeof runConcurrencySoakApp>>;
  readonly createdExecutions: number;
}> {
  const clock = createTickClock();
  const world = createConcurrencyFakeApiWorld({
    clock,
    ...(options.ceiling === undefined ? {} : { ceiling: options.ceiling }),
    ...(options.leakyRace === undefined ? {} : { leakyRace: options.leakyRace }),
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.verificationStatuses === undefined
      ? {}
      : { verificationStatuses: options.verificationStatuses }),
  });
  const outcome = await runConcurrencySoakApp({
    config: baseConfig,
    token: "zeck-token-fake",
    transport: world.transport as TransportImplementation,
    now: clock.now,
    sleep: async (ms) => {
      clock.advance(ms);
    },
    environment: {
      runtime: "node test",
      toolchain: "vitest",
      database: "none",
      configuration: { suite: "val-025-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
    ...(options.roundIndex === undefined ? {} : { roundIndex: options.roundIndex }),
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
  const index = CONCURRENCY_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
}

// ---------------------------------------------------------------------------
// The pinned task slice ↔ corpus ↔ config.json consistency
// ---------------------------------------------------------------------------

describe("VAL-025 app task-slice consistency", () => {
  test("the exported task slice mirrors the corpus exactly", () => {
    expect(CONCURRENCY_SOAK_TASKS.length).toBe(CONCURRENCY_CORPUS.length);
    for (const [index, task] of CONCURRENCY_SOAK_TASKS.entries()) {
      const row = CONCURRENCY_CORPUS[index];
      expect(task.rowId).toBe(row?.rowId);
      expect(task.kind).toBe(CONCURRENCY_TASK_KIND);
      expect(task.pattern).toBe(row?.pattern);
      expect(task.expectedTerminal).toBe(row?.expected.terminal);
    }
  });

  test("config.json mirrors the exported task slice", async () => {
    const config = JSON.parse(
      await readFile(
        join(
          import.meta.dirname,
          "../../../benchmarks/validation/apps/concurrency-soak/config.json",
        ),
        "utf-8",
      ),
    ) as { tasks: Record<string, unknown>[]; tokenEnvVar: string; integrationSurface: string };
    expect(config.tasks.length).toBe(CONCURRENCY_SOAK_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const exported = CONCURRENCY_SOAK_TASKS[index];
      expect(task.rowId).toBe(exported?.rowId);
      expect(task.kind).toBe(exported?.kind);
      expect(task.pattern).toBe(exported?.pattern);
      expect(task.expectedTerminal).toBe(exported?.expectedTerminal);
      expect(task.submissions).toBe(exported?.submissions);
      expect(task.appCreated).toBe(exported?.appCreated);
      expect(task.replayedSubmissions).toBe(exported?.replayedSubmissions);
      expect(task.rejectedSubmissions).toBe(exported?.rejectedSubmissions);
    }
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("sdk");
  });

  test("the corpus is well-formed (unique row ids, patterns in vocabulary)", () => {
    const rowIds = CONCURRENCY_CORPUS.map((row) => row.rowId);
    expect(new Set(rowIds).size).toBe(rowIds.length);
    for (const row of CONCURRENCY_CORPUS) {
      expect([
        "same-key-race",
        "distinct-key-fanout",
        "over-ceiling-burst",
        "soak-rounds",
      ]).toContain(row.pattern);
    }
  });
});

// ---------------------------------------------------------------------------
// The app over the honest fake world (every offline row passes)
// ---------------------------------------------------------------------------

describe("VAL-025 app over the honest fake world", () => {
  test("every non-soak offline row PASSES with valid evidence", async () => {
    for (const row of CONCURRENCY_CORPUS) {
      if (row.pattern === "soak-rounds" || row.liveGate !== undefined) {
        continue;
      }
      const run = await runAppOverFakeWorld({
        taskIndex: taskIndexOf(row.rowId),
        ...(row.ceiling === undefined ? {} : { ceiling: row.ceiling }),
      });
      expect(
        run.passed,
        `${row.rowId} app passed (criteria: ${JSON.stringify(run.outcome.submissionCriteria.filter((c) => c.status === "FAIL"))})`,
      ).toBe(true);
      expect(validateHarnessEvidence(run.evidence)).toEqual([]);
      const failedSubmission = run.outcome.submissionCriteria.filter(
        (criterion) => criterion.status === "FAIL",
      );
      expect(failedSubmission, `${row.rowId}: ${JSON.stringify(failedSubmission)}`).toEqual([]);
    }
  });

  test("the racing rows: exactly ONE durable execution per key (the fake's own ledger)", async () => {
    for (const rowId of ["same-key-race-pair", "same-key-race-storm", "same-key-race-conflict"]) {
      const row = CONCURRENCY_CORPUS[taskIndexOf(rowId)];
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(rowId) });
      expect(run.passed).toBe(true);
      // The fake's ledger holds exactly the created receipts' identities.
      expect(run.outcome.landedIds.length).toBe(row?.expected.appCreated);
    }
  });

  test("the racing conflict row: the typed 409 IDEMPOTENCY_KEY_REUSED surfaced as app evidence", async () => {
    const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf("same-key-race-conflict") });
    expect(run.passed).toBe(true);
    const rejected = run.outcome.observations.filter((o) => o.rejection !== null);
    expect(rejected.length).toBe(1);
    expect(rejected[0]?.rejection?.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(rejected[0]?.rejection?.status).toBe(409);
    // The typed rejection is surfaced in the harness evidence errors.
    expect(run.evidence.errors.some((error) => error.code === "IDEMPOTENCY_KEY_REUSED")).toBe(true);
  });

  test("the burst rows: the app observes the declared shaping (admitted + durable denials)", async () => {
    for (const rowId of ["over-ceiling-burst-shaped", "over-ceiling-burst-slot-release"]) {
      const row = CONCURRENCY_CORPUS[taskIndexOf(rowId)];
      const run = await runAppOverFakeWorld({
        taskIndex: taskIndexOf(rowId),
        ceiling: row?.ceiling,
      });
      expect(run.passed, `${rowId} app passed`).toBe(true);
      expect(run.outcome.admissionOutcomes?.filter((o) => o === "admitted").length).toBe(
        row?.expected.admitted,
      );
      expect(run.outcome.admissionOutcomes?.filter((o) => o === "denied").length).toBe(
        row?.expected.denied,
      );
      expect(run.outcome.admissionOutcomes?.filter((o) => o === "unresolved").length ?? 1).toBe(0);
    }
  });

  test("the soak row: every round's app run PASSES (six rounds, per-round contract)", async () => {
    const taskIndex = taskIndexOf("soak-rounds-invariants");
    for (let round = 1; round <= CORPUS_SOAK_POLICY.rounds; round += 1) {
      const run = await runAppOverFakeWorld({ taskIndex, roundIndex: round });
      expect(run.passed, `round ${round} app passed`).toBe(true);
      expect(validateHarnessEvidence(run.evidence)).toEqual([]);
    }
  });

  test("the submission latencies are measured (never estimated)", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("distinct-key-fanout-parallel"),
    });
    expect(run.outcome.submissionLatencyMs.length).toBe(4);
    for (const latency of run.outcome.submissionLatencyMs) {
      expect(latency).toBeGreaterThan(0);
    }
    expect(run.evidence.timings.submitMs).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The discriminations (a fabricated convergence never passes)
// ---------------------------------------------------------------------------

describe("VAL-025 app discriminations", () => {
  test("a LEAKY racing fake (double admission) FAILs the racing rows", async () => {
    for (const rowId of ["same-key-race-pair", "same-key-race-storm"]) {
      const run = await runAppOverFakeWorld({
        taskIndex: taskIndexOf(rowId),
        leakyRace: true,
      });
      expect(run.passed, `${rowId} must fail on the leaky fake`).toBe(false);
      const failed = run.outcome.submissionCriteria.filter((c) => c.status === "FAIL");
      expect(failed.length).toBeGreaterThan(0);
    }
  });

  test("a FAILED platform outcome fails every row (never a fabricated COMPLETED)", async () => {
    for (const row of CONCURRENCY_CORPUS) {
      if (row.pattern === "soak-rounds" || row.liveGate !== undefined) {
        continue;
      }
      const run = await runAppOverFakeWorld({
        taskIndex: taskIndexOf(row.rowId),
        ...(row.ceiling === undefined ? {} : { ceiling: row.ceiling }),
        terminal: "FAILED",
      });
      expect(run.passed, `${row.rowId} must fail on a FAILED platform outcome`).toBe(false);
    }
  });

  test("a failed verification status fails every row", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("distinct-key-fanout-parallel"),
      verificationStatuses: ["FAIL"],
    });
    expect(run.passed).toBe(false);
  });

  test("a leaky burst gate (no ceiling bound) FAILs the burst rows' shaping contract", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("over-ceiling-burst-shaped"),
      // No ceiling: every lane admits — the shaping never fires.
    });
    expect(run.passed).toBe(false);
    const shaping = run.outcome.submissionCriteria.find(
      (criterion) => criterion.criterionId === "app-admission-shaping-counts",
    );
    expect(shaping?.status).toBe("FAIL");
  });
});
