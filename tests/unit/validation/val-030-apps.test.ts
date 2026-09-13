/**
 * VAL-030 acceptance criterion 1: the longitudinal-baseline customer
 * application rides the public SDK boundary end to end against a
 * controlled fake transport (the control-run submission → the
 * completion poll → the result retrieval with the route's model-call
 * count → the events read re-deriving the platform's own trajectory
 * digest → (the rerun rows) the key re-issue with the IDENTICAL body →
 * the deterministic assertions → the recorder-consumable evidence),
 * and its pinned task slice matches the repository configuration file
 * and the corpus. The fake world implements the platform's OWN
 * control-run semantics at the customer boundary (the create/replay
 * semantics at the POST boundary; the honest terminal shapes at the
 * read boundary; the canonical control trajectory at the events read)
 * so the app's per-row control-run assertions are exercised honestly.
 *
 * Discrimination: a LEAKY ledger fake that mints a second execution on
 * the re-issued key FAILs the rerun row; a DRIFTING recorder between
 * re-runs FAILs the re-run class membership; a CONTAMINATED
 * (under-dispatching, reuse-shaped) run FAILs the control contract at
 * the customer boundary; a terminal override fails every mismatched
 * row — while the equivalence-class row still PASSES under either
 * equivalent effect ordering.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  LONGITUDINAL_TASKS,
  runLongitudinalApp,
} from "../../../benchmarks/validation/apps/longitudinal-baseline/application";
import {
  controlSubmissionKey,
  controlTaskBodyFor,
  LONGITUDINAL_CORPUS,
  LONGITUDINAL_ROW_IDS,
  LONGITUDINAL_TASK_KIND,
  liveGateOpen,
  longitudinalRowById,
} from "../../../benchmarks/validation/apps/longitudinal-baseline/corpus";
import {
  createLongitudinalFakeApiWorld,
  createTickClock,
} from "../../../benchmarks/validation/apps/longitudinal-baseline/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";
import {
  appDigestOf,
  deriveWorkloadAdmission,
  manifestDigestOf,
  trajectoryClassOf,
  workloadDigestOf,
} from "../../../benchmarks/validation/platform/longitudinal-baseline";

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
  readonly trajectoryVariant?: number;
  readonly contaminatedLearning?: boolean;
  readonly driftRecorder?: boolean;
  readonly leakyLedger?: boolean;
}): Promise<{
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly outcome: Awaited<ReturnType<typeof runLongitudinalApp>>;
  readonly createdExecutions: number;
}> {
  const clock = createTickClock();
  const world = createLongitudinalFakeApiWorld({
    clock,
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.trajectoryVariant === undefined
      ? {}
      : { trajectoryVariant: options.trajectoryVariant }),
    ...(options.contaminatedLearning === undefined
      ? {}
      : { contaminatedLearning: options.contaminatedLearning }),
    ...(options.driftRecorder === undefined ? {} : { driftRecorder: options.driftRecorder }),
    ...(options.leakyLedger === undefined ? {} : { leakyLedger: options.leakyLedger }),
  });
  const outcome = await runLongitudinalApp({
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
      configuration: { suite: "val-030-apps" },
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
  const index = LONGITUDINAL_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
}

// ---------------------------------------------------------------------------
// The pinned task slice ↔ corpus ↔ config.json consistency
// ---------------------------------------------------------------------------

describe("VAL-030 app task-slice consistency", () => {
  test("the exported task slice mirrors the corpus exactly", () => {
    expect(LONGITUDINAL_TASKS.length).toBe(LONGITUDINAL_CORPUS.length);
    for (const [index, task] of LONGITUDINAL_TASKS.entries()) {
      const row = LONGITUDINAL_CORPUS[index];
      expect(task.rowId).toBe(row?.rowId);
      expect(task.kind).toBe(LONGITUDINAL_TASK_KIND);
      expect(task.appId).toBe(row?.manifest.appId);
      expect(task.appVersion).toBe(row?.appArtifact.appVersion);
      expect(task.workloadId).toBe(row?.manifest.workloadId);
      expect(task.workloadRevision).toBe(row?.manifest.workloadRevision);
      expect(task.appDigest).toBe(row?.manifest.appDigest);
      expect(task.workloadDigest).toBe(row?.manifest.workloadDigest);
      expect(task.manifestDigest).toBe(row?.manifest.manifestDigest);
      expect(task.expectedTerminal).toBe(row?.expected.terminal);
      expect(task.dispatchRounds).toBe(row?.workload.dispatchRounds);
      expect(task.quotaMicro).toBe(row?.workload.quotaMicro);
      expect(task.declaredEffects).toBe(row?.workload.effects.length);
      expect(task.expectedModelCalls).toBe(row?.expectedModelCalls);
      expect(task.trajectoryClassSize).toBe(row?.expectedTrajectoryClass.length);
      expect(task.appCreated).toBe(row?.expected.appCreated);
      expect(task.replayedSubmissions).toBe(row?.expected.replayedSubmissions);
      expect(task.rejectedSubmissions).toBe(row?.expected.rejectedSubmissions);
      expect(task.ledgerIdentities).toBe(row?.expected.ledgerIdentities);
      expect(task.rerun ?? null).toBe(row?.rerun?.probe ?? null);
      expect(task.contamination ?? null).toBe(row?.contamination?.kind ?? null);
      expect(task.liveGate ?? null).toEqual(row?.liveGate?.envVars ?? null);
    }
  });

  test("config.json mirrors the exported task slice", async () => {
    const config = JSON.parse(
      await readFile(
        join(
          import.meta.dirname,
          "../../../benchmarks/validation/apps/longitudinal-baseline/config.json",
        ),
        "utf-8",
      ),
    ) as { tasks: Record<string, unknown>[]; tokenEnvVar: string; integrationSurface: string };
    expect(config.tasks.length).toBe(LONGITUDINAL_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const exported = LONGITUDINAL_TASKS[index];
      expect(task.rowId).toBe(exported?.rowId);
      expect(task.kind).toBe(exported?.kind);
      expect(task.appId).toBe(exported?.appId);
      expect(task.appVersion).toBe(exported?.appVersion);
      expect(task.workloadId).toBe(exported?.workloadId);
      expect(task.workloadRevision).toBe(exported?.workloadRevision);
      expect(task.appDigest).toBe(exported?.appDigest);
      expect(task.workloadDigest).toBe(exported?.workloadDigest);
      expect(task.manifestDigest).toBe(exported?.manifestDigest);
      expect(task.expectedTerminal).toBe(exported?.expectedTerminal);
      expect(task.dispatchRounds).toBe(exported?.dispatchRounds);
      expect(task.quotaMicro).toBe(exported?.quotaMicro);
      expect(task.declaredEffects).toBe(exported?.declaredEffects);
      expect(task.expectedModelCalls).toBe(exported?.expectedModelCalls);
      expect(task.trajectoryClassSize).toBe(exported?.trajectoryClassSize);
      expect(task.rerun ?? null).toBe(exported?.rerun ?? null);
      expect(task.contamination ?? null).toBe(exported?.contamination ?? null);
      expect(task.liveGate ?? null).toEqual(exported?.liveGate ?? null);
      expect(task.appCreated).toBe(exported?.appCreated);
      expect(task.replayedSubmissions).toBe(exported?.replayedSubmissions);
      expect(task.rejectedSubmissions).toBe(exported?.rejectedSubmissions);
      expect(task.ledgerIdentities).toBe(exported?.ledgerIdentities);
    }
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("sdk");
  });

  test("the corpus is well-formed (unique ids, content-addressed manifests, honest oracles)", () => {
    const rowIds = LONGITUDINAL_CORPUS.map((row) => row.rowId);
    expect(new Set(rowIds).size).toBe(rowIds.length);
    expect(LONGITUDINAL_ROW_IDS).toEqual(rowIds);
    expect(longitudinalRowById("text-summarize-baseline")?.rowId).toBe("text-summarize-baseline");
    expect(longitudinalRowById("nonexistent")).toBeNull();
    for (const row of LONGITUDINAL_CORPUS) {
      // The manifest is content-addressed by construction: every digest
      // re-derives from the pinned artifacts.
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
      // The expected terminal and dispatch demand follow the admission.
      const admission = deriveWorkloadAdmission(row.workload);
      expect(row.expected.terminal).toBe(admission.allowed ? "COMPLETED" : "FAILED");
      expect(row.expectedModelCalls).toBe(admission.allowed ? row.workload.dispatchRounds : 0);
      // The pinned class is the declared equivalence class.
      expect(row.expectedTrajectoryClass).toEqual(
        trajectoryClassOf({
          workload: row.workload,
          ...(row.effectOrderings === undefined
            ? {}
            : { equivalentOrderings: row.effectOrderings }),
        }),
      );
      // Exactly ONE ledger identity per control run.
      expect(row.expected.ledgerIdentities).toBe(1);
    }
  });

  test("the submission fingerprint discipline is stable (key + IDENTICAL body for the re-run)", () => {
    expect(controlSubmissionKey({ runSuffix: "unit", taskIndex: 3 })).toBe("val-030-app-unit-3");
    const body = controlTaskBodyFor({ rowId: "research-digest-rerun-equivalence" });
    expect(body).toEqual({
      kind: LONGITUDINAL_TASK_KIND,
      rowId: "research-digest-rerun-equivalence",
      control: { learning: "inert" },
    });
  });

  test("the live row is env-gated (offline the gate is closed; the credential opens it)", () => {
    const liveRow = LONGITUDINAL_CORPUS.find((row) => row.needsDispatch);
    expect(liveRow).toBeDefined();
    expect(liveRow?.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
    expect(liveGateOpen(liveRow as (typeof LONGITUDINAL_CORPUS)[number], {})).toBe(false);
    expect(
      liveGateOpen(liveRow as (typeof LONGITUDINAL_CORPUS)[number], {
        OPENROUTER_API_KEY: "operator-authorized",
      }),
    ).toBe(true);
    // Every offline row is always drivable.
    for (const row of LONGITUDINAL_CORPUS) {
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

describe("VAL-030 app over the honest fake world", () => {
  test("every offline row PASSES with valid evidence", async () => {
    for (const [taskIndex, row] of LONGITUDINAL_CORPUS.entries()) {
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
      // The app-side trajectory digest is a MEMBER of the pinned class.
      expect(row.expectedTrajectoryClass).toContain(run.outcome.trajectoryDigest ?? "");
      // The control run made its OWN dispatches (the public route read).
      expect(run.outcome.observedModelCalls).toBe(row.expectedModelCalls);
    }
  });

  test("the COMPLETED rows observe the all-PASS statuses; the FAILED row the honest FAIL", async () => {
    for (const row of LONGITUDINAL_CORPUS) {
      if (row.liveGate !== undefined) {
        continue;
      }
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(row.rowId) });
      expect(run.outcome.observedTerminal).toBe(row.expected.terminal);
      if (row.expected.terminal === "COMPLETED") {
        expect(run.outcome.verificationStatuses).toEqual(["PASS", "PASS"]);
      } else {
        // The guard-rejected baseline: the precondition criterion FAILs
        // visibly, the freeze criterion PASSes — the honest FAILED shape.
        expect(run.outcome.verificationStatuses).toContain("FAIL");
        expect(run.outcome.verificationStatuses).toContain("PASS");
      }
    }
  });

  test("the rerun row observes the replayed receipt with identity preserved", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("research-digest-rerun-equivalence"),
    });
    expect(run.passed).toBe(true);
    expect(run.outcome.replay?.replayed).toBe(true);
    expect(run.outcome.replay?.executionId).toBe(run.outcome.submission?.executionId);
    expect(run.outcome.replay?.rejection).toBeNull();
    // The replay created ZERO new executions (the app's own view) and
    // the re-observed trajectory is STILL in the recorded class.
    expect(run.createdExecutions).toBe(1);
    expect(run.outcome.rerunTrajectoryDigest).toBe(run.outcome.trajectoryDigest);
  });

  test("the submission latencies are measured (never estimated)", async () => {
    const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf("coding-fix-baseline") });
    expect(run.outcome.submissionLatencyMs.length).toBe(1);
    for (const latency of run.outcome.submissionLatencyMs) {
      expect(latency).toBeGreaterThan(0);
    }
    expect(run.evidence.timings.submitMs).not.toBeNull();
  });

  test("the rerun row measures BOTH submission latencies", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("research-digest-rerun-equivalence"),
    });
    expect(run.outcome.submissionLatencyMs.length).toBe(2);
    for (const latency of run.outcome.submissionLatencyMs) {
      expect(latency).toBeGreaterThan(0);
    }
  });

  test("the equivalence-class row still PASSES under the OTHER equivalent ordering", async () => {
    // The second declared ordering (warehouse notice first) is an
    // honest reproduction — the CLASS, not one byte-sequence, is the
    // frozen oracle.
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("order-settlement-equivalence-class"),
      trajectoryVariant: 1,
    });
    expect(run.passed).toBe(true);
    const row = longitudinalRowById("order-settlement-equivalence-class");
    expect(row?.expectedTrajectoryClass).toContain(run.outcome.trajectoryDigest ?? "");
    expect(run.outcome.trajectoryDigest).toBe(row?.expectedTrajectoryClass[1]);
  });
});

// ---------------------------------------------------------------------------
// The discriminations (a fabricated control run never passes)
// ---------------------------------------------------------------------------

describe("VAL-030 app discriminations", () => {
  test("a LEAKY ledger fake (a second execution on the re-issued key) FAILs the rerun row", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("research-digest-rerun-equivalence"),
      leakyLedger: true,
    });
    expect(run.passed).toBe(false);
    // The leak minted a SECOND durable execution for one control run.
    expect(run.createdExecutions).toBe(2);
    expect(run.outcome.replay?.replayed).toBe(false);
    expect(run.outcome.replay?.executionId).not.toBe(run.outcome.submission?.executionId);
    expect(
      run.outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-replay-identity-preserved",
      )?.status,
    ).toBe("FAIL");
  });

  test("a DRIFTING recorder (the events drift between the run and the re-run) FAILs the re-run class", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("research-digest-rerun-equivalence"),
      driftRecorder: true,
    });
    expect(run.passed).toBe(false);
    // The ORIGINAL trajectory stays in class; the re-run drifted out.
    const row = longitudinalRowById("research-digest-rerun-equivalence");
    expect(row?.expectedTrajectoryClass).toContain(run.outcome.trajectoryDigest ?? "");
    expect(row?.expectedTrajectoryClass).not.toContain(run.outcome.rerunTrajectoryDigest ?? "");
    expect(
      run.outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-rerun-trajectory-class",
      )?.status,
    ).toBe("FAIL");
  });

  test("a CONTAMINATED (reuse-shaped, under-dispatching) run FAILs the control contract", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("probe-reuse-contamination"),
      contaminatedLearning: true,
    });
    expect(run.passed).toBe(false);
    // The public route read shows ZERO model calls (a reused round
    // dispatched nothing) — the inert-learning floor at the customer
    // boundary.
    expect(run.outcome.observedModelCalls).toBe(0);
    expect(
      run.outcome.appCriteria.find((criterion) => criterion.criterionId === "app-control-run-inert")
        ?.status,
    ).toBe("FAIL");
    // The surfaced trajectory lacks the dispatch steps — out of class.
    expect(
      run.outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-trajectory-class-membership",
      )?.status,
    ).toBe("FAIL");
  });

  test("a terminal override that contradicts the oracle fails the row", async () => {
    // The honest COMPLETED baseline overridden to FAILED with all-PASS
    // statuses — BOTH the expected-terminal and the terminal↔criteria
    // agreement catch the fabrication.
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("text-summarize-baseline"),
      terminal: "FAILED",
    });
    expect(run.passed).toBe(false);
    expect(
      run.outcome.appCriteria.find((criterion) => criterion.criterionId === "app-expected-terminal")
        ?.status,
    ).toBe("FAIL");
    expect(
      run.outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-terminal-criteria-agreement",
      )?.status,
    ).toBe("FAIL");
  });
});
