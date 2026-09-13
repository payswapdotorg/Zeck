/**
 * VAL-026 acceptance criterion 1: the outcome-correctness customer
 * application rides the public SDK boundary end to end against a
 * controlled fake transport (the submission → the completion poll →
 * the result retrieval → (the replay rows) the key re-issue → the
 * deterministic assertions → the recorder-consumable evidence), and
 * its pinned task slice matches the repository configuration file and
 * the corpus. The fake world implements the platform's OWN outcome
 * semantics at the customer boundary (the create/replay semantics at
 * the POST boundary; the honest outcome shapes — COMPLETED with
 * all-PASS statuses, FAILED with the honest FAIL criterion visible in
 * the result read — at the read boundary) so the app's per-row outcome
 * assertions are exercised honestly.
 *
 * Discrimination: a FABRICATED pass-with-fail (a COMPLETED terminal
 * with a FAIL verification status) FAILs the app honestly; a LEAKY
 * replay fake that mints a second execution FAILs the replay rows; a
 * terminal override fails every mismatched row.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  OUTCOME_TASKS,
  runOutcomeApp,
} from "../../../benchmarks/validation/apps/outcome-correctness/application";
import {
  OUTCOME_CORPUS,
  OUTCOME_TASK_KIND,
} from "../../../benchmarks/validation/apps/outcome-correctness/corpus";
import {
  createOutcomeFakeApiWorld,
  createTickClock,
} from "../../../benchmarks/validation/apps/outcome-correctness/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";
import { declaredFixtureDigestOf } from "../../../benchmarks/validation/platform/outcome-correctness";

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
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly verificationStatuses?: readonly string[];
  readonly fabricatePassWithFail?: boolean;
  readonly leakyReplay?: boolean;
}): Promise<{
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly outcome: Awaited<ReturnType<typeof runOutcomeApp>>;
  readonly createdExecutions: number;
}> {
  const clock = createTickClock();
  const world = createOutcomeFakeApiWorld({
    clock,
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.verificationStatuses === undefined
      ? {}
      : { verificationStatuses: options.verificationStatuses }),
    ...(options.fabricatePassWithFail === undefined
      ? {}
      : { fabricatePassWithFail: options.fabricatePassWithFail }),
    ...(options.leakyReplay === undefined ? {} : { leakyReplay: options.leakyReplay }),
  });
  const outcome = await runOutcomeApp({
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
      configuration: { suite: "val-026-apps" },
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
  const index = OUTCOME_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
}

// ---------------------------------------------------------------------------
// The pinned task slice ↔ corpus ↔ config.json consistency
// ---------------------------------------------------------------------------

describe("VAL-026 app task-slice consistency", () => {
  test("the exported task slice mirrors the corpus exactly", () => {
    expect(OUTCOME_TASKS.length).toBe(OUTCOME_CORPUS.length);
    for (const [index, task] of OUTCOME_TASKS.entries()) {
      const row = OUTCOME_CORPUS[index];
      expect(task.rowId).toBe(row?.rowId);
      expect(task.kind).toBe(OUTCOME_TASK_KIND);
      expect(task.expectedTerminal).toBe(row?.expected.terminal);
      expect(task.declaredEffects).toBe(row?.declaredEffects.length);
      expect(task.quotaMicro).toBe(row?.quotaMicro);
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
          "../../../benchmarks/validation/apps/outcome-correctness/config.json",
        ),
        "utf-8",
      ),
    ) as { tasks: Record<string, unknown>[]; tokenEnvVar: string; integrationSurface: string };
    expect(config.tasks.length).toBe(OUTCOME_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const exported = OUTCOME_TASKS[index];
      expect(task.rowId).toBe(exported?.rowId);
      expect(task.kind).toBe(exported?.kind);
      expect(task.expectedTerminal).toBe(exported?.expectedTerminal);
      expect(task.declaredEffects).toBe(exported?.declaredEffects);
      expect(task.quotaMicro).toBe(exported?.quotaMicro);
      expect(task.appCreated).toBe(exported?.appCreated);
      expect(task.replayedSubmissions).toBe(exported?.replayedSubmissions);
      expect(task.rejectedSubmissions).toBe(exported?.rejectedSubmissions);
    }
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("sdk");
  });

  test("the corpus is well-formed (unique row ids, vocabulary shapes)", () => {
    const rowIds = OUTCOME_CORPUS.map((row) => row.rowId);
    expect(new Set(rowIds).size).toBe(rowIds.length);
    for (const row of OUTCOME_CORPUS) {
      expect(row.expected.terminal === "COMPLETED" || row.expected.terminal === "FAILED").toBe(
        true,
      );
      // AC1's first-class pin: every FAILED row declares the EMPTY
      // fixture-state delta (a failed execution's declared effects
      // must NOT have been applied).
      if (row.expected.terminal === "FAILED") {
        expect(row.expected.fixtureDelta, `${row.rowId} FAILED delta`).toEqual({});
      } else {
        expect(Object.keys(row.expected.fixtureDelta).length).toBe(row.declaredEffects.length);
      }
      // The declared digest is a well-shaped digest.
      expect(row.expectedFixtureDigest).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  test("the corpus-fail row's declared digest deliberately disagrees (the anyFail pin)", () => {
    const row = OUTCOME_CORPUS.find(
      (candidate) => candidate.rowId === "criterion-fail-any-fail-failed",
    );
    expect(row).toBeDefined();
    if (row === undefined) {
      return;
    }
    // The declared digest is NOT the honest digest of the row's own
    // declared set — the deliberate disagreement that forces the
    // anyFail→FAILED shape.
    expect(row.expectedFixtureDigest).not.toBe(declaredFixtureDigestOf(row.declaredEffects));
    // Every OTHER row declares the honest digest of its own set.
    for (const other of OUTCOME_CORPUS) {
      if (other.rowId === row.rowId) {
        continue;
      }
      expect(other.expectedFixtureDigest).toBe(declaredFixtureDigestOf(other.declaredEffects));
    }
  });
});

// ---------------------------------------------------------------------------
// The app over the honest fake world (every offline row passes)
// ---------------------------------------------------------------------------

describe("VAL-026 app over the honest fake world", () => {
  test("every offline row PASSES with valid evidence", async () => {
    for (const [taskIndex, row] of OUTCOME_CORPUS.entries()) {
      if (row.liveGate !== undefined) {
        continue;
      }
      const run = await runAppOverFakeWorld({ taskIndex });
      expect(
        run.passed,
        `${row.rowId} app passed (criteria: ${JSON.stringify(
          run.outcome.outcomeCriteria.filter((criterion) => criterion.status === "FAIL"),
        )})`,
      ).toBe(true);
      expect(validateHarnessEvidence(run.evidence)).toEqual([]);
      const failed = run.outcome.outcomeCriteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
    }
  });

  test("the COMPLETED rows observe the all-PASS verification statuses", async () => {
    for (const row of OUTCOME_CORPUS) {
      if (row.liveGate !== undefined || row.expected.terminal !== "COMPLETED") {
        continue;
      }
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(row.rowId) });
      expect(run.outcome.observedTerminal).toBe("COMPLETED");
      expect(run.outcome.verificationStatuses).toEqual(["PASS", "PASS"]);
    }
  });

  test("the FAILED rows observe the honest FAIL criterion in the result read", async () => {
    for (const row of OUTCOME_CORPUS) {
      if (row.expected.terminal !== "FAILED") {
        continue;
      }
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(row.rowId) });
      expect(run.outcome.observedTerminal).toBe("FAILED");
      expect(run.outcome.verificationStatuses).toContain("FAIL");
      expect(run.outcome.verificationStatuses).toContain("PASS");
    }
  });

  test("the replay rows observe the replayed receipt with identity preserved", async () => {
    for (const rowId of [
      "replay-idempotent-zero-new-effects",
      "replay-after-failure-zero-new-effects",
    ]) {
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(rowId) });
      expect(run.passed, `${rowId} app passed`).toBe(true);
      expect(run.outcome.replay?.replayed).toBe(true);
      expect(run.outcome.replay?.executionId).toBe(run.outcome.submission?.executionId);
      // The replay created ZERO new executions (the app's own view).
      expect(run.createdExecutions).toBe(1);
    }
  });

  test("the submission latencies are measured (never estimated)", async () => {
    const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf("order-placement-completed") });
    expect(run.outcome.submissionLatencyMs.length).toBe(1);
    for (const latency of run.outcome.submissionLatencyMs) {
      expect(latency).toBeGreaterThan(0);
    }
    expect(run.evidence.timings.submitMs).not.toBeNull();
  });

  test("the replay rows measure BOTH submission latencies", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("replay-idempotent-zero-new-effects"),
    });
    expect(run.outcome.submissionLatencyMs.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The discriminations (a fabricated outcome never passes)
// ---------------------------------------------------------------------------

describe("VAL-026 app discriminations", () => {
  test("a FABRICATED pass-with-fail (COMPLETED + a FAIL status) FAILs the app honestly", async () => {
    // The guard-rejected row (honestly FAILED) fabricated into a
    // COMPLETED terminal with the FAIL criterion still visible.
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("guard-rejected-zero-effects"),
      fabricatePassWithFail: true,
    });
    expect(run.passed).toBe(false);
    const failed = run.outcome.outcomeCriteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed.length).toBeGreaterThan(0);
    expect(
      failed.find((criterion) => criterion.criterionId === "app-terminal-criteria-agreement"),
    ).toBeDefined();
  });

  test("the same fabrication on a COMPLETED row (an injected FAIL status) FAILs too", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("workspace-tree-completed"),
      verificationStatuses: ["PASS", "FAIL"],
    });
    expect(run.passed).toBe(false);
    expect(
      run.outcome.outcomeCriteria.find(
        (criterion) => criterion.criterionId === "app-terminal-criteria-agreement",
      )?.status,
    ).toBe("FAIL");
  });

  test("a fabricated fail-with-all-pass (FAILED + all PASS) FAILs the agreement", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("workspace-tree-completed"),
      terminal: "FAILED",
      verificationStatuses: ["PASS", "PASS"],
    });
    expect(run.passed).toBe(false);
    expect(
      run.outcome.outcomeCriteria.find(
        (criterion) => criterion.criterionId === "app-terminal-criteria-agreement",
      )?.status,
    ).toBe("FAIL");
  });

  test("a terminal override that contradicts the oracle fails the row", async () => {
    // The honest COMPLETED row overridden to FAILED.
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("ticket-routing-completed"),
      terminal: "FAILED",
      verificationStatuses: ["FAIL", "PASS"],
    });
    expect(run.passed).toBe(false);
    expect(
      run.outcome.outcomeCriteria.find(
        (criterion) => criterion.criterionId === "app-expected-terminal",
      )?.status,
    ).toBe("FAIL");
  });

  test("a LEAKY replay fake (a second execution on the replayed key) FAILs the replay rows", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("replay-idempotent-zero-new-effects"),
      leakyReplay: true,
    });
    expect(run.passed).toBe(false);
    // The leak minted a SECOND durable execution.
    expect(run.createdExecutions).toBe(2);
    expect(run.outcome.replay?.replayed).toBe(false);
  });
});
