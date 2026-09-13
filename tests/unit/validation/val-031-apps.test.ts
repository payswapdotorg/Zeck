/**
 * VAL-031 acceptance criterion 1: the workload-replay customer
 * application rides the public SDK boundary end to end against a
 * controlled fake transport (the replay-submission phase — N replays,
 * each landing its OWN durable execution; the observation phase — the
 * per-replay completion polls, result retrievals and events reads
 * re-deriving every replay's trajectory digest over the public
 * journal; the analysis phase — the population statistics derived from
 * the app's OWN observations; the deterministic assertions; the
 * recorder-consumable evidence), and its pinned task slice matches the
 * repository configuration file and the corpus. The fake world
 * implements the platform's OWN replay-population semantics at the
 * customer boundary (the per-replay create semantics at the POST
 * boundary; the honest terminal shapes at the read boundary; the
 * world-scheduled trajectories at the events read) so the app's
 * per-row replay assertions are exercised honestly.
 *
 * Discrimination: a LEAKY fake world that binds the k-th replay's key
 * to the FIRST replay's execution FAILs the population; a DRIFTING
 * events read FAILs the drifted replay's class membership; a DROPPED
 * trajectory read FAILs the stability evidence (a partial population);
 * a SMOOTHED world that schedules the varying row's every replay
 * identically FAILs the pinned distribution (a fabricated
 * determinism); a terminal override fails every mismatched row — while
 * the deterministic populations observe IDENTICAL digests and the
 * varying population is REPORTED varying with its observed
 * distribution.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { longitudinalRowById } from "../../../benchmarks/validation/apps/longitudinal-baseline/corpus";
import {
  runWorkloadReplayApp,
  WORKLOAD_REPLAY_TASKS,
} from "../../../benchmarks/validation/apps/workload-replay/application";
import {
  liveGateOpen,
  replaySubmissionKey,
  replayTaskBodyFor,
  WORKLOAD_REPLAY_CORPUS,
  WORKLOAD_REPLAY_ROW_IDS,
  WORKLOAD_REPLAY_TASK_KIND,
  workloadReplayRowById,
} from "../../../benchmarks/validation/apps/workload-replay/corpus";
import {
  createTickClock,
  createWorkloadReplayFakeApiWorld,
} from "../../../benchmarks/validation/apps/workload-replay/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";
import {
  appDigestOf,
  controlTrajectoryStepsOf,
  manifestDigestOf,
  trajectoryClassOf,
  trajectoryDigestOf,
  workloadDigestOf,
} from "../../../benchmarks/validation/platform/longitudinal-baseline";
import { deriveStabilityReportOf } from "../../../benchmarks/validation/platform/workload-replay";

const REVISION = "4d4ab310d066a775e3d47f40e8f0b4cd02073371";

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
  readonly driftOrdinal?: number;
  readonly dropOrdinal?: number;
  readonly leakyOrdinal?: number;
  readonly smoothedVariance?: boolean;
}): Promise<{
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly outcome: Awaited<ReturnType<typeof runWorkloadReplayApp>>;
  readonly createdExecutions: number;
}> {
  const clock = createTickClock();
  const world = createWorkloadReplayFakeApiWorld({
    clock,
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.driftOrdinal === undefined ? {} : { driftOrdinal: options.driftOrdinal }),
    ...(options.dropOrdinal === undefined ? {} : { dropOrdinal: options.dropOrdinal }),
    ...(options.leakyOrdinal === undefined ? {} : { leakyOrdinal: options.leakyOrdinal }),
    ...(options.smoothedVariance === undefined
      ? {}
      : { smoothedVariance: options.smoothedVariance }),
  });
  const outcome = await runWorkloadReplayApp({
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
      configuration: { suite: "val-031-apps" },
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
  const index = WORKLOAD_REPLAY_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
}

// ---------------------------------------------------------------------------
// The pinned task slice ↔ corpus ↔ config.json consistency
// ---------------------------------------------------------------------------

describe("VAL-031 app task-slice consistency", () => {
  test("the exported task slice mirrors the corpus exactly", () => {
    expect(WORKLOAD_REPLAY_TASKS.length).toBe(WORKLOAD_REPLAY_CORPUS.length);
    for (const [index, task] of WORKLOAD_REPLAY_TASKS.entries()) {
      const row = WORKLOAD_REPLAY_CORPUS[index];
      expect(task.rowId).toBe(row?.rowId);
      expect(task.kind).toBe(WORKLOAD_REPLAY_TASK_KIND);
      expect(task.baselineRowId).toBe(row?.baselineRowId);
      expect(task.appId).toBe(row?.manifest.appId);
      expect(task.appVersion).toBe(row?.appArtifact.appVersion);
      expect(task.workloadId).toBe(row?.manifest.workloadId);
      expect(task.workloadRevision).toBe(row?.manifest.workloadRevision);
      expect(task.appDigest).toBe(row?.manifest.appDigest);
      expect(task.workloadDigest).toBe(row?.manifest.workloadDigest);
      expect(task.manifestDigest).toBe(row?.manifest.manifestDigest);
      expect(task.replayCount).toBe(row?.replayCount);
      expect(task.expectedTerminal).toBe(row?.expected.terminal);
      expect(task.expectedModelCallsPerReplay).toBe(row?.expectedModelCallsPerReplay);
      expect(task.populationModelCalls).toBe(
        (row?.expectedModelCallsPerReplay ?? 0) * (row?.replayCount ?? 0),
      );
      expect(task.trajectoryClassSize).toBe(row?.expectedTrajectoryClass.length);
      expect(task.stabilityKind).toBe(row?.expectedStability.kind);
      expect(task.stabilityDistributionSize).toBe(row?.expectedStability.distribution.length);
      expect(task.appCreated).toBe(row?.expected.appCreated);
      expect(task.replayedSubmissions).toBe(row?.expected.replayedSubmissions);
      expect(task.rejectedSubmissions).toBe(row?.expected.rejectedSubmissions);
      expect(task.ledgerIdentities).toBe(row?.expected.ledgerIdentities);
      expect(task.probe ?? null).toBe(row?.probe?.kind ?? null);
      expect(task.liveGate ?? null).toEqual(row?.liveGate?.envVars ?? null);
    }
  });

  test("config.json mirrors the exported task slice", async () => {
    const config = JSON.parse(
      await readFile(
        join(
          import.meta.dirname,
          "../../../benchmarks/validation/apps/workload-replay/config.json",
        ),
        "utf-8",
      ),
    ) as { tasks: Record<string, unknown>[]; tokenEnvVar: string; integrationSurface: string };
    expect(config.tasks.length).toBe(WORKLOAD_REPLAY_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const exported = WORKLOAD_REPLAY_TASKS[index];
      expect(task.rowId).toBe(exported?.rowId);
      expect(task.kind).toBe(exported?.kind);
      expect(task.baselineRowId).toBe(exported?.baselineRowId);
      expect(task.appId).toBe(exported?.appId);
      expect(task.appVersion).toBe(exported?.appVersion);
      expect(task.workloadId).toBe(exported?.workloadId);
      expect(task.workloadRevision).toBe(exported?.workloadRevision);
      expect(task.appDigest).toBe(exported?.appDigest);
      expect(task.workloadDigest).toBe(exported?.workloadDigest);
      expect(task.manifestDigest).toBe(exported?.manifestDigest);
      expect(task.replayCount).toBe(exported?.replayCount);
      expect(task.expectedTerminal).toBe(exported?.expectedTerminal);
      expect(task.expectedModelCallsPerReplay).toBe(exported?.expectedModelCallsPerReplay);
      expect(task.populationModelCalls).toBe(exported?.populationModelCalls);
      expect(task.trajectoryClassSize).toBe(exported?.trajectoryClassSize);
      expect(task.stabilityKind).toBe(exported?.stabilityKind);
      expect(task.stabilityDistributionSize).toBe(exported?.stabilityDistributionSize);
      expect(task.probe ?? null).toBe(exported?.probe ?? null);
      expect(task.liveGate ?? null).toEqual(exported?.liveGate ?? null);
      expect(task.appCreated).toBe(exported?.appCreated);
      expect(task.replayedSubmissions).toBe(exported?.replayedSubmissions);
      expect(task.rejectedSubmissions).toBe(exported?.rejectedSubmissions);
      expect(task.ledgerIdentities).toBe(exported?.ledgerIdentities);
    }
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("sdk");
  });

  test("the corpus is well-formed (unique ids, committed baselines, honest oracles)", () => {
    const rowIds = WORKLOAD_REPLAY_CORPUS.map((row) => row.rowId);
    expect(new Set(rowIds).size).toBe(rowIds.length);
    expect(WORKLOAD_REPLAY_ROW_IDS).toEqual(rowIds);
    expect(workloadReplayRowById("text-summarize-replay-population")?.rowId).toBe(
      "text-summarize-replay-population",
    );
    expect(workloadReplayRowById("nonexistent")).toBeNull();
    for (const row of WORKLOAD_REPLAY_CORPUS) {
      // Every baseline reference resolves in VAL-030's frozen corpus.
      const baseline = longitudinalRowById(row.baselineRowId);
      expect(baseline, `${row.rowId} baseline ${row.baselineRowId}`).not.toBeNull();
      // The manifest is the baseline's pinned entry, content-addressed by
      // construction: every digest re-derives from the pinned artifacts.
      expect(row.manifest.appDigest).toBe(appDigestOf(row.appArtifact));
      expect(row.manifest.workloadDigest).toBe(workloadDigestOf(row.workload));
      expect(row.manifest.manifestDigest).toBe(
        manifestDigestOf({
          appId: row.manifest.appId,
          appDigest: row.manifest.appDigest,
          workloadId: row.manifest.workloadId,
          workloadRevision: row.manifest.workloadRevision,
          workloadDigest: row.manifest.workloadDigest,
        }),
      );
      // The replay count is a real population (at least one replay).
      expect(row.replayCount).toBeGreaterThanOrEqual(1);
      // The pinned class is the baseline's VAL-030 class.
      expect(row.expectedTrajectoryClass).toEqual(
        trajectoryClassOf({
          workload: row.workload,
          ...(row.effectOrderings === undefined
            ? {}
            : { equivalentOrderings: row.effectOrderings }),
        }),
      );
      // The pinned population statistics: the honest schedule report,
      // every distribution digest in-class, the counts summing to N.
      const declarationOrder = row.workload.effects.map((_, index) => index);
      const schedule = Array.from({ length: row.replayCount }, (_, index) => {
        const order =
          row.replayOrderings === undefined || row.replayOrderings.length === 0
            ? (row.effectOrderings?.[0] ?? declarationOrder)
            : (row.replayOrderings[index % row.replayOrderings.length] ?? declarationOrder);
        return trajectoryDigestOf(
          controlTrajectoryStepsOf({ workload: row.workload, effectOrder: order }),
        );
      });
      expect(row.expectedStability).toEqual(deriveStabilityReportOf(schedule));
      const total = row.expectedStability.distribution.reduce((sum, entry) => sum + entry.count, 0);
      expect(total).toBe(row.replayCount);
      for (const entry of row.expectedStability.distribution) {
        expect(row.expectedTrajectoryClass).toContain(entry.digest);
      }
      // Exactly ONE ledger identity per replay: N.
      expect(row.expected.ledgerIdentities).toBe(row.replayCount);
      expect(row.expected.appCreated).toBe(row.replayCount);
      expect(row.expected.replayedSubmissions).toBe(0);
    }
  });

  test("the submission fingerprint discipline is stable (one OWN key + body per replay)", () => {
    expect(replaySubmissionKey({ runSuffix: "unit", taskIndex: 3, replayOrdinal: 1 })).toBe(
      "val-031-app-unit-3-replay-1",
    );
    // Each replay's key is its own — never another replay's.
    const keys = [1, 2, 3].map((ordinal) =>
      replaySubmissionKey({ runSuffix: "unit", taskIndex: 0, replayOrdinal: ordinal }),
    );
    expect(new Set(keys).size).toBe(3);
    const body = replayTaskBodyFor({ rowId: "text-summarize-replay-population", replayOrdinal: 2 });
    expect(body).toEqual({
      kind: WORKLOAD_REPLAY_TASK_KIND,
      rowId: "text-summarize-replay-population",
      replay: 2,
      control: { learning: "inert" },
    });
  });

  test("the live row is env-gated (offline the gate is closed; the credential opens it)", () => {
    const liveRow = WORKLOAD_REPLAY_CORPUS.find((row) => row.needsDispatch);
    expect(liveRow).toBeDefined();
    expect(liveRow?.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
    expect(liveGateOpen(liveRow as (typeof WORKLOAD_REPLAY_CORPUS)[number], {})).toBe(false);
    expect(
      liveGateOpen(liveRow as (typeof WORKLOAD_REPLAY_CORPUS)[number], {
        OPENROUTER_API_KEY: "operator-authorized",
      }),
    ).toBe(true);
    // Every offline row is always drivable.
    for (const row of WORKLOAD_REPLAY_CORPUS) {
      if (row.needsDispatch) {
        continue;
      }
      expect(liveGateOpen(row, {})).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The app over the honest fake world (every offline row passes)
// ---------------------------------------------------------------------------

describe("VAL-031 app over the honest fake world", () => {
  test("every offline row PASSES with valid evidence (N own executions, zero replays)", async () => {
    for (const [taskIndex, row] of WORKLOAD_REPLAY_CORPUS.entries()) {
      if (row.liveGate !== undefined) {
        continue;
      }
      const run = await runAppOverFakeWorld({ taskIndex });
      expect(
        run.passed,
        `${row.rowId} app passed (criteria: ${JSON.stringify(
          run.outcome.appCriteria.filter((criterion) => criterion.status === "FAIL"),
        )})`,
      ).toBe(true);
      expect(validateHarnessEvidence(run.evidence)).toEqual([]);
      const failed = run.outcome.appCriteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      // Every replay landed its OWN durable execution.
      expect(run.createdExecutions).toBe(row.replayCount);
      expect(run.outcome.submissions).toHaveLength(row.replayCount);
      for (const submission of run.outcome.submissions) {
        expect(submission.replayed).toBe(false);
        expect(submission.rejection).toBeNull();
        expect(submission.executionId).not.toBe("");
      }
      const executionIds = run.outcome.submissions.map((submission) => submission.executionId);
      expect(new Set(executionIds).size).toBe(row.replayCount);
      // Every replay's app-side digest is a member of the pinned class.
      for (const digest of run.outcome.trajectoryDigests) {
        expect(row.expectedTrajectoryClass).toContain(digest ?? "");
      }
      // Every replay made its OWN dispatches (the public route read).
      for (const calls of run.outcome.observedModelCalls) {
        expect(calls).toBe(row.expectedModelCallsPerReplay);
      }
    }
  });

  test("the deterministic populations observe IDENTICAL digests; the varying one its distribution", async () => {
    for (const row of WORKLOAD_REPLAY_CORPUS) {
      if (row.liveGate !== undefined || row.expectedStability.kind !== "deterministic") {
        continue;
      }
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(row.rowId) });
      expect(new Set(run.outcome.trajectoryDigests).size).toBe(1);
      expect(run.outcome.population.stability.kind).toBe("deterministic");
      expect(run.outcome.population.stability.distribution).toEqual(
        row.expectedStability.distribution,
      );
    }
    const varying = workloadReplayRowById("order-settlement-varying-replay-population");
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("order-settlement-varying-replay-population"),
    });
    expect(run.passed).toBe(true);
    expect(new Set(run.outcome.trajectoryDigests).size).toBe(2);
    expect(run.outcome.population.stability.kind).toBe("varying");
    expect(run.outcome.population.stability.distribution).toEqual(
      varying?.expectedStability.distribution,
    );
    expect(run.outcome.population.stability.distribution).toHaveLength(2);
  });

  test("the population statistics are derived from OWN observations (measured latencies)", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("rag-retrieval-replay-population"),
    });
    expect(run.passed).toBe(true);
    // The measured per-replay submission latencies (never estimated).
    expect(run.outcome.submissionLatencyMs).toHaveLength(4);
    for (const latency of run.outcome.submissionLatencyMs) {
      expect(latency).toBeGreaterThan(0);
    }
    // The latency distribution: min/max/median over the measured values.
    const { latency } = run.outcome.population;
    expect(latency.count).toBe(4);
    expect(latency.minMs).toBe(Math.min(...run.outcome.submissionLatencyMs));
    expect(latency.maxMs).toBe(Math.max(...run.outcome.submissionLatencyMs));
    expect(latency.medianMs).toBeGreaterThan(0);
    // The population dispatch total (4 replays × 2 own rounds).
    expect(run.outcome.population.observedModelCalls).toBe(8);
    expect(run.evidence.timings.submitMs).not.toBeNull();
  });

  test("the guard population replays the FAILED shape honestly (every replay)", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("oversized-batch-guard-replay-population"),
    });
    expect(run.passed).toBe(true);
    expect(run.outcome.observedTerminals).toEqual(["FAILED", "FAILED", "FAILED"]);
    for (const statuses of run.outcome.verificationStatuses) {
      // The honest FAILED shape: the guard criterion FAILs visibly and
      // the population criterion PASSes.
      expect(statuses).toContain("FAIL");
      expect(statuses).toContain("PASS");
    }
    for (const calls of run.outcome.observedModelCalls) {
      expect(calls).toBe(0);
    }
    // The failed baseline replays honestly: identical guard digests.
    expect(new Set(run.outcome.trajectoryDigests).size).toBe(1);
    expect(run.outcome.population.stability.kind).toBe("deterministic");
  });

  test("the run identity is the VAL-031 work order and the timeline observes every replay", async () => {
    const row = workloadReplayRowById("tool-agent-loop-replay-population");
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("tool-agent-loop-replay-population"),
    });
    expect(run.passed).toBe(true);
    expect(run.evidence.workOrder).toBe("VAL-031");
    expect(run.evidence.program).toBe("zeck-validation");
    expect(run.evidence.integrationSurface).toBe("sdk");
    expect(run.evidence.request?.taskKind).toBe(WORKLOAD_REPLAY_TASK_KIND);
    // Every replay's submission + settlement is observed (never backwards).
    expect(run.evidence.timeline.length).toBeGreaterThanOrEqual((row?.replayCount ?? 0) * 2);
  });
});

// ---------------------------------------------------------------------------
// The discriminations (a fabricated replay population never passes)
// ---------------------------------------------------------------------------

describe("VAL-031 app discriminations", () => {
  test("a LEAKY fake world (the k-th key binds the FIRST execution) FAILs the population", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("probe-duplicate-replay"),
      leakyOrdinal: 2,
    });
    expect(run.passed).toBe(false);
    // The shoulder-in minted only TWO durable executions for THREE replays.
    expect(run.createdExecutions).toBe(2);
    expect(run.outcome.submissions[1]?.replayed).toBe(true);
    expect(run.outcome.submissions[1]?.executionId).toBe(run.outcome.submissions[0]?.executionId);
    expect(
      run.outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-population-no-duplicate-replays",
      )?.status,
    ).toBe("FAIL");
    expect(
      run.outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-population-completeness-summary",
      )?.status,
    ).toBe("FAIL");
  });

  test("a DRIFTING events read FAILs the drifted replay's class membership", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("probe-drifted-trajectory"),
      driftOrdinal: 2,
    });
    expect(run.passed).toBe(false);
    // The ORIGINAL replays stay in class; the drifted replay is out.
    const row = workloadReplayRowById("probe-drifted-trajectory");
    expect(row?.expectedTrajectoryClass).toContain(run.outcome.trajectoryDigests[0] ?? "");
    expect(row?.expectedTrajectoryClass).not.toContain(run.outcome.trajectoryDigests[1] ?? "");
    expect(
      run.outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-replay-2-trajectory-class-membership",
      )?.status,
    ).toBe("FAIL");
    // The deterministic population lost its stability too.
    expect(run.outcome.population.stability.kind).toBe("varying");
    expect(
      run.outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-stability-honesty-summary",
      )?.status,
    ).toBe("FAIL");
  });

  test("a DROPPED trajectory read FAILs the stability evidence (a partial population)", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("probe-dropped-replay"),
      dropOrdinal: 3,
    });
    expect(run.passed).toBe(false);
    // The third replay's trajectory read was lost — a null digest.
    expect(run.outcome.trajectoryDigests[2]).toBeNull();
    expect(
      run.outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-replay-3-trajectory-class-membership",
      )?.status,
    ).toBe("FAIL");
    // The stability claim now rests on a PARTIAL population.
    expect(
      run.outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-stability-full-population",
      )?.status,
    ).toBe("FAIL");
    expect(
      run.outcome.appCriteria
        .find((criterion) => criterion.criterionId === "app-stability-full-population")
        ?.evidence.join(" "),
    ).toContain("PARTIAL-POPULATION");
  });

  test("a SMOOTHED world FAILs the varying row (the variance was fabricated away)", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("probe-fabricated-determinism"),
      smoothedVariance: true,
    });
    expect(run.passed).toBe(false);
    // Every replay was scheduled identically — the population lost its
    // legitimate variance (a fabricated determinism).
    expect(new Set(run.outcome.trajectoryDigests).size).toBe(1);
    expect(run.outcome.population.stability.kind).toBe("deterministic");
    const row = workloadReplayRowById("probe-fabricated-determinism");
    expect(row?.expectedStability.kind).toBe("varying");
    expect(
      run.outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-stability-claim-matches-pin",
      )?.status,
    ).toBe("FAIL");
    expect(
      run.outcome.appCriteria
        .find((criterion) => criterion.criterionId === "app-stability-claim-matches-pin")
        ?.evidence.join(" "),
    ).toContain("DISTRIBUTION-MISMATCH");
  });

  test("a terminal override that contradicts the oracle fails every replay", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("text-summarize-replay-population"),
      terminal: "FAILED",
    });
    expect(run.passed).toBe(false);
    for (const replayOrdinal of [1, 2, 3, 4, 5]) {
      expect(
        run.outcome.appCriteria.find(
          (criterion) => criterion.criterionId === `app-replay-${replayOrdinal}-expected-terminal`,
        )?.status,
      ).toBe("FAIL");
      expect(
        run.outcome.appCriteria.find(
          (criterion) =>
            criterion.criterionId === `app-replay-${replayOrdinal}-terminal-criteria-agreement`,
        )?.status,
      ).toBe("FAIL");
    }
  });
});
