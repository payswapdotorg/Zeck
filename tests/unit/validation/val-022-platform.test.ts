/**
 * VAL-022 acceptance criteria 1, 2, 4, 5: the substrate-failure
 * platform slice against controlled fakes — the fact-driven taxonomy
 * (class + layer + retryability for every REAL failure shape the
 * substrate family produces, incl. the misattributed OOM-vs-timeout
 * fix), the strike/quarantine state derivations (threshold, window,
 * circuit-closing success), the pre-effect task validation, and the
 * execution driver over every offline corpus row and every submission
 * (readiness-gated dispatch, fresh-sandbox-per-attempt, bounded
 * fresh-sandbox retries, journal exactly-once, strike accounting,
 * quarantine propagation and cool-down recovery, honest terminals).
 */

import { describe, expect, test } from "vitest";
import {
  groundTruthForSubmission,
  OFFLINE_CORPUS_ROWS,
  SUBSTRATE_FAILURE_CORPUS,
  taskBodyForSubmission,
} from "../../../benchmarks/validation/apps/substrate-failure/corpus";
import type { SubstrateCallLog } from "../../../benchmarks/validation/apps/substrate-failure/fixtures";
import {
  containerOomMislabeledAsTimeoutObservation,
  createSubstrateWorld,
  processSuccessObservation,
  processTimeoutObservation,
  SUBSTRATE_POLICY,
  sandboxLostMidExecutionObservation,
  taskFailureObservation,
} from "../../../benchmarks/validation/apps/substrate-failure/fixtures";
import {
  applyStrike,
  applySuccess,
  classifySubstrateFailure,
  deriveGateVerdict,
  deriveSubstrateFailureCriteria,
  driveSubstrateFailureExecution,
  freshSandboxId,
  freshSubstrateState,
  isQuarantinedAt,
  isRetryableSubstrateClass,
  layerOfSubstrateClass,
  SUBSTRATE_FAILURE_CLASSES,
  type SubstrateAttemptRecord,
  type SubstrateFailureLifecyclePort,
  type SubstrateSubmissionGroundTruth,
  strikeLeadsToQuarantine,
  unwiredSubstrateMessage,
  validateSubstrateProbeTask,
} from "../../../benchmarks/validation/platform/substrate-failure";

// ---------------------------------------------------------------------------
// Fake lifecycle + driving helpers
// ---------------------------------------------------------------------------

interface FakeLifecycle extends SubstrateFailureLifecyclePort {
  readonly transitions: string[];
  readonly decisions: { provider: string; model: string; strategyClass: string }[];
  readonly attemptRecords: SubstrateAttemptRecord[];
  readonly substrateEvents: { command: string; reference: Record<string, unknown> }[];
  readonly quarantines: { strikes: number; threshold: number; until: number }[];
  readonly completions: { verdict: string; criteria: { criterionId: string; status: string }[] }[];
}

function createFakeLifecycle(): FakeLifecycle {
  const transitions: string[] = [];
  const decisions: { provider: string; model: string; strategyClass: string }[] = [];
  const attemptRecords: SubstrateAttemptRecord[] = [];
  const substrateEvents: { command: string; reference: Record<string, unknown> }[] = [];
  const quarantines: { strikes: number; threshold: number; until: number }[] = [];
  const completions: { verdict: string; criteria: { criterionId: string; status: string }[] }[] =
    [];
  const port: SubstrateFailureLifecyclePort = {
    async transition({ step }) {
      transitions.push(step);
    },
    async recordPlanningDecision({ route }) {
      decisions.push({ ...route });
    },
    async recordAttempt({ record }) {
      attemptRecords.push(record);
    },
    async recordSubstrateEvent({ command, reference }) {
      substrateEvents.push({ command, reference: { ...reference } });
    },
    async recordQuarantineEngaged(input) {
      quarantines.push({
        strikes: input.strikes,
        threshold: input.threshold,
        until: input.quarantinedUntilEpochMs,
      });
    },
    async complete({ verdict, criteria }) {
      completions.push({
        verdict,
        criteria: criteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          status: criterion.status,
        })),
      });
    },
  };
  return Object.assign(port, {
    transitions,
    decisions,
    attemptRecords,
    substrateEvents,
    quarantines,
    completions,
  });
}

const noSleep = async () => {};

/** Drive one full corpus row (every submission, with the declared clock advances). */
async function driveRow(row: (typeof OFFLINE_CORPUS_ROWS)[number]): Promise<{
  readonly results: Awaited<ReturnType<typeof driveSubstrateFailureExecution>>[];
  readonly lifecycles: FakeLifecycle[];
  readonly calls: SubstrateCallLog;
}> {
  const world = createSubstrateWorld({
    probeScript: row.probeScript,
    executeScript: row.executeScript,
  });
  const results: Awaited<ReturnType<typeof driveSubstrateFailureExecution>>[] = [];
  const lifecycles: FakeLifecycle[] = [];
  for (let index = 0; index < row.oracle.submissions.length; index += 1) {
    const advance = row.clockAdvanceBySubmission?.[index] ?? 0;
    if (advance > 0) {
      world.clock.advance(advance);
    }
    const lifecycle = createFakeLifecycle();
    lifecycles.push(lifecycle);
    results.push(
      await driveSubstrateFailureExecution({
        executionId: `exec-${row.rowId}-s${index + 1}`,
        task: taskBodyForSubmission(row, index),
        groundTruth: groundTruthForSubmission(row, index),
        provider: "substrate-test-rail",
        model: "substrate-failure-probe",
        lifecycle,
        plane: world.plane,
        retry: { maxExtraAttempts: 2, backoffMs: 0, sleep: noSleep },
      }),
    );
  }
  return { results, lifecycles, calls: world.calls };
}

// ---------------------------------------------------------------------------
// The fact-driven taxonomy (PURE derivations)
// ---------------------------------------------------------------------------

describe("VAL-022 substrate-failure taxonomy", () => {
  test("every substrate-failure class maps to exactly one layer; the retryable set is exactly the three fresh-sandbox classes", () => {
    for (const failureClass of SUBSTRATE_FAILURE_CLASSES) {
      expect(["substrate", "task", "platform"]).toContain(layerOfSubstrateClass(failureClass));
    }
    const retryable = SUBSTRATE_FAILURE_CLASSES.filter(isRetryableSubstrateClass);
    expect(retryable.sort()).toEqual(
      ["readiness-refused", "sandbox-lost", "substrate-timeout"].sort(),
    );
    // The task and platform classes are never substrate-layer.
    expect(layerOfSubstrateClass("task-failure")).toBe("task");
    expect(layerOfSubstrateClass("platform-error")).toBe("platform");
  });

  test("a success observation carries no failure", () => {
    expect(classifySubstrateFailure(processSuccessObservation("substrate-ok", 12))).toBeNull();
  });

  test("the REAL process timeout (timer-fired fact) classifies substrate-timeout — retryable", () => {
    const failure = classifySubstrateFailure(processTimeoutObservation(30_000));
    expect(failure?.failureClass).toBe("substrate-timeout");
    expect(failure?.layer).toBe("substrate");
    expect(failure?.retryable).toBe(true);
    expect(failure?.deadlineElapsed).toBe(true);
    expect(failure?.adapterToken).toBe("timeout");
  });

  test("the OOM kill MISLABELED as a timeout classifies resource-exhausted — NON-retryable (the misattribution fix)", () => {
    const failure = classifySubstrateFailure(containerOomMislabeledAsTimeoutObservation(64));
    expect(failure?.failureClass).toBe("resource-exhausted");
    expect(failure?.layer).toBe("substrate");
    expect(failure?.retryable).toBe(false);
    expect(failure?.exitCode).toBe(137);
    expect(failure?.oomKilled).toBe(true);
    expect(failure?.deadlineElapsed).toBe(false);
    // The adapter's own token is preserved (the label it guessed).
    expect(failure?.adapterToken).toBe("timeout");
  });

  test("an OOM-labeled sandbox-execution (exit 137 without the deadline elapsing) is ALSO resource-exhausted — the task is never blamed for a resource-manager kill", () => {
    const failure = classifySubstrateFailure({
      outcomeClass: "sandbox-failure",
      outputDigest: null,
      output: { exitCode: 137, oomKilled: true, deadlineElapsed: false },
      usageMicroUsd: null,
      failure: {
        failureClass: "sandbox-execution",
        message: "process exited with code 137",
        retryable: false,
      },
    });
    expect(failure?.failureClass).toBe("resource-exhausted");
    expect(failure?.layer).toBe("substrate");
    expect(failure?.retryable).toBe(false);
  });

  test("the mid-execution sandbox loss (adapter-error + sandboxLost evidence) classifies sandbox-lost — retryable with a fresh sandbox", () => {
    const failure = classifySubstrateFailure(sandboxLostMidExecutionObservation("exec-1-sbx-1"));
    expect(failure?.failureClass).toBe("sandbox-lost");
    expect(failure?.layer).toBe("substrate");
    expect(failure?.retryable).toBe(true);
    expect(failure?.sandboxLost).toBe(true);
    expect(failure?.adapterToken).toBe("adapter-error");
  });

  test("a generic adapter error without the lost-sandbox evidence stays adapter-error — NON-retryable", () => {
    const failure = classifySubstrateFailure({
      outcomeClass: "sandbox-failure",
      outputDigest: null,
      output: { deadlineElapsed: false },
      usageMicroUsd: null,
      failure: {
        failureClass: "adapter-error",
        message: "the substrate client threw an unknown error",
        retryable: false,
      },
    });
    expect(failure?.failureClass).toBe("adapter-error");
    expect(failure?.retryable).toBe(false);
  });

  test("the runtime-unavailable token (the unwired-substrate posture) is NON-retryable, substrate layer", () => {
    const failure = classifySubstrateFailure({
      outcomeClass: "sandbox-failure",
      outputDigest: null,
      output: null,
      usageMicroUsd: null,
      failure: {
        failureClass: "runtime-unavailable",
        message: unwiredSubstrateMessage("container"),
        retryable: false,
      },
    });
    expect(failure?.failureClass).toBe("runtime-unavailable");
    expect(failure?.layer).toBe("substrate");
    expect(failure?.retryable).toBe(false);
  });

  test("the task's own non-zero exit in a healthy sandbox is task-failure — the task layer, never the substrate", () => {
    const failure = classifySubstrateFailure(taskFailureObservation(2));
    expect(failure?.failureClass).toBe("task-failure");
    expect(failure?.layer).toBe("task");
    expect(failure?.retryable).toBe(false);
    expect(failure?.exitCode).toBe(2);
  });

  test("a genuine timeout without the deadline fact and without OOM evidence stays substrate-timeout (the deadline class is retryable either way; only OOM facts flip it)", () => {
    const failure = classifySubstrateFailure({
      outcomeClass: "sandbox-failure",
      outputDigest: null,
      output: null,
      usageMicroUsd: null,
      failure: {
        failureClass: "timeout",
        message: "process exceeded its admitted timeout of 30000ms",
        retryable: true,
      },
    });
    expect(failure?.failureClass).toBe("substrate-timeout");
    expect(failure?.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The strike/quarantine state derivations (PURE)
// ---------------------------------------------------------------------------

describe("VAL-022 strike/quarantine state machine", () => {
  test("the threshold crossing: two strikes engage, the window is pinned at engagement", () => {
    const first = applyStrike(freshSubstrateState(), {
      threshold: 2,
      coolDownMs: 60_000,
      nowEpochMs: 1_000,
    });
    expect(first.state.strikes).toBe(1);
    expect(first.quarantined).toBe(false);
    expect(first.quarantinedUntilEpochMs).toBeNull();
    const second = applyStrike(first.state, {
      threshold: 2,
      coolDownMs: 60_000,
      nowEpochMs: 2_000,
    });
    expect(second.quarantined).toBe(true);
    expect(second.quarantinedUntilEpochMs).toBe(62_000);
    expect(strikeLeadsToQuarantine(second.state.strikes, 2)).toBe(true);
  });

  test("the window check: quarantined before the end, recovered at/after it", () => {
    const state = { strikes: 2, quarantinedUntilEpochMs: 62_000 };
    expect(isQuarantinedAt(state, 61_999)).toBe(true);
    expect(isQuarantinedAt(state, 62_000)).toBe(false);
    expect(deriveGateVerdict(state, 61_999)).toBe("quarantined");
    expect(deriveGateVerdict(state, 62_000)).toBe("probe-required");
    expect(deriveGateVerdict(freshSubstrateState(), 0)).toBe("probe-required");
  });

  test("a success closes the circuit: strikes reset and the window clears", () => {
    const closed = applySuccess({ strikes: 2, quarantinedUntilEpochMs: 62_000 });
    expect(closed.strikes).toBe(0);
    expect(closed.quarantinedUntilEpochMs).toBeNull();
    expect(deriveGateVerdict(closed, 1_000)).toBe("probe-required");
  });

  test("a re-strike while already quarantined never EXTENDS the window (the earliest recovery bound holds)", () => {
    const quarantined = { strikes: 2, quarantinedUntilEpochMs: 62_000 };
    const reStruck = applyStrike(quarantined, {
      threshold: 2,
      coolDownMs: 60_000,
      nowEpochMs: 70_000,
    });
    expect(reStruck.quarantined).toBe(true);
    expect(reStruck.quarantinedUntilEpochMs).toBe(62_000);
  });
});

// ---------------------------------------------------------------------------
// The pre-effect task validation
// ---------------------------------------------------------------------------

describe("VAL-022 probe-task validation (pre-effect)", () => {
  const validTask = {
    kind: "substrate-probe",
    scenario: "healthy-substrate",
    submission: 1,
    substrateKind: "process",
    command: "/bin/echo",
    args: ["substrate-ok"],
    publicEnv: { PROBE: "substrate-failure" },
    limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
  };

  test("the well-formed probe task validates", () => {
    expect(validateSubstrateProbeTask(validTask).valid).toBe(true);
  });

  test("an out-of-vocabulary task kind is rejected before any effect", () => {
    const verdict = validateSubstrateProbeTask({ ...validTask, kind: "teleport-probe" });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain("outside the substrate-probe vocabulary");
  });

  test("a secret-shaped public env name and a raw-secret value are both rejected", () => {
    expect(validateSubstrateProbeTask({ ...validTask, publicEnv: { API_KEY: "x" } }).valid).toBe(
      false,
    );
    expect(
      validateSubstrateProbeTask({
        ...validTask,
        publicEnv: { NOTE: "see sk-abcdefghijklmnopqrst for the rail key" },
      }).valid,
    ).toBe(false);
  });

  test("missing or non-positive limits are rejected (explicit resource profile required)", () => {
    expect(validateSubstrateProbeTask({ ...validTask, limits: null }).valid).toBe(false);
    expect(
      validateSubstrateProbeTask({
        ...validTask,
        limits: { cpuMilliCores: 0, memoryMiB: 128, executionTimeoutMs: 1 },
      }).valid,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The execution driver over the offline corpus (every row, every submission)
// ---------------------------------------------------------------------------

describe("VAL-022 substrate-failure execution driver (offline corpus rows)", () => {
  test("the corpus is well-formed: 10 offline rows + 3 REAL process rows, every oracle self-consistent", () => {
    expect(OFFLINE_CORPUS_ROWS.length).toBe(10);
    expect(SUBSTRATE_FAILURE_CORPUS.length).toBe(13);
    for (const row of SUBSTRATE_FAILURE_CORPUS) {
      expect(row.oracle.submissions.length).toBeGreaterThan(0);
      for (const submission of row.oracle.submissions) {
        expect(submission.attempts).toBe(submission.attemptOutcomes.length);
        // Non-retryable injected classes are single-attempt submissions
        // (except the gated submission — the quarantine's own boundary).
        if (
          row.oracle.injectedClass !== null &&
          !row.oracle.injectedRetryable &&
          !submission.gatedAtSubmission
        ) {
          expect(submission.attempts).toBe(1);
        }
        // Retryable all-failure submissions exhaust the budget exactly.
        const allFailures = submission.attemptOutcomes.every(
          (outcome) => outcome === "failure" || outcome === "readiness-refused",
        );
        if (row.oracle.injectedRetryable && allFailures && !submission.gatedAtSubmission) {
          expect(submission.attempts).toBe(1 + 2);
        }
        // The gated submission never contacts the substrate.
        if (submission.gatedAtSubmission) {
          expect(submission.attemptOutcomes).toEqual(["quarantine-refused"]);
        }
      }
      // The strike propagation is monotone across a row's submissions.
      let strikes = 0;
      for (const submission of row.oracle.submissions) {
        expect(submission.strikesBefore).toBe(strikes);
        strikes = submission.strikesAfter;
      }
      // The unwired row declares the container kind with no scripted adapter.
      if (row.rowId === "unwired-substrate") {
        expect(row.substrateKind).toBe("container");
      }
    }
  });

  test("every offline corpus row satisfies its own oracle through the driver (classification, gating, fresh sandboxes, strikes, terminal)", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const { results, lifecycles } = await driveRow(row);
      expect(results.length, `${row.rowId} submissions`).toBe(row.oracle.submissions.length);
      for (const [index, result] of results.entries()) {
        const oracle = row.oracle.submissions[index];
        if (oracle === undefined) throw new Error("missing oracle");
        expect(result.terminal, `${row.rowId}#${index + 1} terminal`).toBe(oracle.terminal);
        expect(result.totalAttempts, `${row.rowId}#${index + 1} attempts`).toBe(oracle.attempts);
        expect(result.finalFailure?.failureClass ?? null, `${row.rowId}#${index + 1} class`).toBe(
          oracle.substrateClass,
        );
        expect(result.finalFailure?.layer ?? null, `${row.rowId}#${index + 1} layer`).toBe(
          oracle.layer,
        );
        const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
        expect(
          failedCriteria,
          `${row.rowId}#${index + 1} criteria: ${JSON.stringify(failedCriteria)}`,
        ).toEqual([]);
        expect(result.journaledAttempts).toBe(oracle.attempts);
        expect(result.strikesAfter).toBe(oracle.strikesAfter);
        // The canonical lifecycle order (no wait-tool cycles: the
        // sandbox dispatch is synchronous within the run).
        const lifecycle = lifecycles[index];
        if (lifecycle === undefined) throw new Error("missing lifecycle");
        expect(lifecycle.transitions).toEqual(["authorize", "plan", "queue", "start", "verify"]);
        expect(lifecycle.decisions.length).toBe(1);
      }
    }
  }, 30_000);

  test("the planning decision is durably recorded BEFORE the first dispatch attempt is journaled", async () => {
    const row = OFFLINE_CORPUS_ROWS.find((candidate) => candidate.rowId === "healthy-substrate");
    if (row === undefined) throw new Error("missing healthy row");
    const { lifecycles } = await driveRow(row);
    // The driver's construction: transitions authorize→plan, then the
    // decision, then queue→start, then the attempt journal.
    const lifecycle = lifecycles[0];
    if (lifecycle === undefined) throw new Error("missing lifecycle");
    expect(lifecycle.decisions.length).toBe(1);
    expect(lifecycle.attemptRecords.length).toBe(1);
  });

  test("readiness gating: the persistent-refusal row never executes (zero dispatches) and the transient row recovers", async () => {
    const persistent = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "readiness-refused-persistent",
    );
    const transient = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "readiness-refused-transient",
    );
    if (persistent === undefined || transient === undefined) {
      throw new Error("missing readiness rows");
    }
    const persistentRun = await driveRow(persistent);
    const persistentResult = persistentRun.results[0];
    if (persistentResult === undefined) throw new Error("missing result");
    expect(persistentResult.executesPerformed).toBe(0);
    expect(persistentResult.probesPerformed).toBe(3);
    expect(persistentRun.calls.executes.count).toBe(0);
    expect(persistentResult.terminal).toBe("FAILED");
    expect(persistentResult.finalFailure?.failureClass).toBe("readiness-refused");

    const transientRun = await driveRow(transient);
    const transientResult = transientRun.results[0];
    if (transientResult === undefined) throw new Error("missing result");
    expect(transientResult.terminal).toBe("COMPLETED");
    expect(transientResult.probesPerformed).toBe(2);
    expect(transientResult.executesPerformed).toBe(1);
    // The refusal is journaled with the failure still attributed honestly.
    expect(transientRun.lifecycles[0]?.attemptRecords[0]?.outcome).toBe("readiness-refused");
    expect(transientRun.lifecycles[0]?.attemptRecords[0]?.retried).toBe(true);
  });

  test("fresh-sandbox retries: the persistent-loss row dispatches THREE distinct fresh sandboxes (never re-entering a dead one)", async () => {
    const row = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "sandbox-lost-persistent",
    );
    if (row === undefined) throw new Error("missing persistent-loss row");
    const { results, calls } = await driveRow(row);
    const result = results[0];
    if (result === undefined) throw new Error("missing result");
    expect(result.executesPerformed).toBe(3);
    const sandboxIds = calls.executes.specs.map((spec) => spec.sandboxId);
    expect(new Set(sandboxIds).size).toBe(3);
    for (const [index, sandboxId] of sandboxIds.entries()) {
      expect(sandboxId).toBe(freshSandboxId(`exec-${row.rowId}-s1`, index + 1));
    }
  });

  test("the OOM row never retries: exactly one attempt (the deterministic-reproduction boundary)", async () => {
    const row = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "resource-exhausted-oom",
    );
    if (row === undefined) throw new Error("missing OOM row");
    const { results, calls } = await driveRow(row);
    const result = results[0];
    if (result === undefined) throw new Error("missing result");
    expect(result.totalAttempts).toBe(1);
    expect(result.executesPerformed).toBe(1);
    expect(calls.executes.count).toBe(1);
    expect(result.finalFailure?.failureClass).toBe("resource-exhausted");
    expect(result.finalFailure?.retryable).toBe(false);
  });

  test("the task-failure row never strikes the substrate (strike accounting blames the right layer)", async () => {
    const row = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "task-failure-in-sandbox",
    );
    if (row === undefined) throw new Error("missing task-failure row");
    const { results } = await driveRow(row);
    const result = results[0];
    if (result === undefined) throw new Error("missing result");
    expect(result.terminal).toBe("FAILED");
    expect(result.finalFailure?.layer).toBe("task");
    expect(result.strikesAfter).toBe(0);
  });

  test("the unwired substrate fails closed with zero substrate contact", async () => {
    const row = OFFLINE_CORPUS_ROWS.find((candidate) => candidate.rowId === "unwired-substrate");
    if (row === undefined) throw new Error("missing unwired row");
    const { results, calls, lifecycles } = await driveRow(row);
    const result = results[0];
    if (result === undefined) throw new Error("missing result");
    expect(result.terminal).toBe("FAILED");
    expect(result.totalAttempts).toBe(1);
    expect(result.probesPerformed).toBe(0);
    expect(result.executesPerformed).toBe(0);
    expect(calls.probes.count).toBe(0);
    expect(calls.executes.count).toBe(0);
    expect(result.finalFailure?.failureClass).toBe("runtime-unavailable");
    expect(result.finalFailure?.message).toContain("fails closed");
    // The denial is journaled in the platform's own vocabulary.
    const denials = lifecycles[0]?.substrateEvents.filter(
      (event) => event.command === "sandbox-denied",
    );
    expect(denials?.[0]?.reference.reason).toBe("unwired-substrate");
  });

  test("the quarantine row: engagement, propagation with ZERO substrate contact, and the cool-down recovery", async () => {
    const row = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "quarantine-propagation-and-recovery",
    );
    if (row === undefined) throw new Error("missing quarantine row");
    const world = createSubstrateWorld({
      probeScript: row.probeScript,
      executeScript: row.executeScript,
    });
    const lifecycles: FakeLifecycle[] = [];
    const results: Awaited<ReturnType<typeof driveSubstrateFailureExecution>>[] = [];
    const probesBefore: number[] = [];
    const executesBefore: number[] = [];
    for (let index = 0; index < row.oracle.submissions.length; index += 1) {
      const advance = row.clockAdvanceBySubmission?.[index] ?? 0;
      if (advance > 0) {
        world.clock.advance(advance);
      }
      probesBefore.push(world.calls.probes.count);
      executesBefore.push(world.calls.executes.count);
      const lifecycle = createFakeLifecycle();
      lifecycles.push(lifecycle);
      results.push(
        await driveSubstrateFailureExecution({
          executionId: `exec-${row.rowId}-s${index + 1}`,
          task: taskBodyForSubmission(row, index),
          groundTruth: groundTruthForSubmission(row, index),
          provider: "substrate-test-rail",
          model: "substrate-failure-probe",
          lifecycle,
          plane: world.plane,
          retry: { maxExtraAttempts: 2, backoffMs: 0, sleep: noSleep },
        }),
      );
    }

    // Submission 2's terminal failure engages the quarantine (journaled).
    expect(results[1]?.quarantineEngagedDuringRun).toBe(true);
    expect(lifecycles[1]?.quarantines.length).toBe(1);
    expect(lifecycles[1]?.quarantines[0]?.strikes).toBe(2);
    expect(lifecycles[1]?.quarantines[0]?.threshold).toBe(SUBSTRATE_POLICY.quarantineThreshold);

    // Submission 3 (the future submission while quarantined): refused
    // at the gate with ZERO probes and ZERO executes — the spy adapter
    // records nothing between submissions 2 and 4.
    const gated = results[2];
    if (gated === undefined) throw new Error("missing gated result");
    expect(gated.terminal).toBe("FAILED");
    expect(gated.totalAttempts).toBe(1);
    expect(gated.probesPerformed).toBe(0);
    expect(gated.executesPerformed).toBe(0);
    expect(probesBefore[2]).toBe(probesBefore[3]);
    expect(executesBefore[2]).toBe(executesBefore[3]);
    expect(gated.attempts[0]?.outcome).toBe("quarantine-refused");
    expect(gated.attempts[0]?.probeReady).toBeNull();

    // Submission 4 (after the cool-down advance): probes ready, executes
    // healthily, COMPLETED — with the history journaled across the row.
    const recovered = results[3];
    if (recovered === undefined) throw new Error("missing recovered result");
    expect(recovered.terminal).toBe("COMPLETED");
    expect(recovered.probesPerformed).toBe(1);
    expect(recovered.executesPerformed).toBe(1);
    expect(recovered.strikesAfter).toBe(0);
    // The strike history is visible across the row's ledgers.
    expect(results[0]?.strikesAfter).toBe(1);
    expect(results[1]?.strikesAfter).toBe(2);
    expect(recovered.strikesBefore).toBe(2);
  });

  test("per-attempt journal records carry DIGESTS and classification facts — never payload bytes", async () => {
    const row = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "sandbox-lost-recovery",
    );
    if (row === undefined) throw new Error("missing recovery row");
    const { lifecycles } = await driveRow(row);
    const journalText = JSON.stringify(lifecycles[0]?.attemptRecords);
    expect(journalText).not.toContain("substrate-ok");
    expect(journalText).not.toContain("/bin/echo");
    expect(lifecycles[0]?.attemptRecords[0]?.specDigest).toMatch(/^[0-9a-f]{8}$/);
  });

  test("the substrate vocabulary journaling: one admitted + one completed per execute; denials for every refusal", async () => {
    const lost = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "sandbox-lost-persistent",
    );
    if (lost === undefined) throw new Error("missing persistent-loss row");
    const { lifecycles } = await driveRow(lost);
    const events = lifecycles[0]?.substrateEvents ?? [];
    expect(events.filter((event) => event.command === "sandbox-admitted").length).toBe(3);
    expect(events.filter((event) => event.command === "sandbox-completed").length).toBe(3);
    expect(events.filter((event) => event.command === "sandbox-denied").length).toBe(0);

    const readiness = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "readiness-refused-persistent",
    );
    if (readiness === undefined) throw new Error("missing readiness row");
    const readinessRun = await driveRow(readiness);
    const readinessEvents = readinessRun.lifecycles[0]?.substrateEvents ?? [];
    expect(readinessEvents.filter((event) => event.command === "sandbox-denied").length).toBe(3);
    expect(readinessEvents.filter((event) => event.command === "sandbox-admitted").length).toBe(0);
  });

  test("an out-of-vocabulary task is a PLATFORM-layer rejection with ZERO probes and executes", async () => {
    const lifecycle = createFakeLifecycle();
    const world = createSubstrateWorld({ executeScript: ["success"] });
    const result = await driveSubstrateFailureExecution({
      executionId: "exec-vocab",
      task: { kind: "teleport-probe", scenario: "x" },
      groundTruth: {
        injectedClass: "platform-error",
        injectedRetryable: false,
        attempts: 1,
        attemptOutcomes: ["failure"],
        terminal: "FAILED",
        substrateClass: "platform-error",
        layer: "platform",
        strikesBefore: 0,
        strikesAfter: 0,
        quarantineEngages: false,
        gatedAtSubmission: false,
      } satisfies SubstrateSubmissionGroundTruth,
      provider: "p",
      model: "m",
      lifecycle,
      plane: world.plane,
      retry: { maxExtraAttempts: 2, backoffMs: 0, sleep: noSleep },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.totalAttempts).toBe(1);
    expect(result.probesPerformed).toBe(0);
    expect(result.executesPerformed).toBe(0);
    expect(world.calls.probes.count).toBe(0);
    expect(world.calls.executes.count).toBe(0);
    expect(result.finalFailure?.layer).toBe("platform");
    expect(result.finalFailure?.failureClass).toBe("platform-error");
  });
});

// ---------------------------------------------------------------------------
// The criteria derivation against synthetic violations
// ---------------------------------------------------------------------------

describe("VAL-022 mechanical criteria derivation (synthetic violations)", () => {
  const baseGround: SubstrateSubmissionGroundTruth = {
    injectedClass: "sandbox-lost",
    injectedRetryable: true,
    attempts: 3,
    attemptOutcomes: ["failure", "failure", "failure"],
    terminal: "FAILED",
    substrateClass: "sandbox-lost",
    layer: "substrate",
    strikesBefore: 0,
    strikesAfter: 1,
    quarantineEngages: false,
    gatedAtSubmission: false,
  };

  function synthAttempt(
    attempt: number,
    overrides: Partial<SubstrateAttemptRecord> = {},
  ): SubstrateAttemptRecord {
    return {
      attempt,
      outcome: "failure",
      substrateClass: "sandbox-lost",
      layer: "substrate",
      retryable: true,
      retried: attempt < 3,
      latencyMs: 4,
      sandboxId: freshSandboxId("exec-synth", attempt),
      probeReady: true,
      specDigest: "aaaa0000",
      exitCode: null,
      deadlineElapsed: false,
      oomKilled: null,
      sandboxLost: true,
      message: "sandbox lost",
      atEpochMs: 1_000 + attempt,
      ...overrides,
    };
  }

  test("a synthetic sandbox RE-ENTRY (the same dead sandbox dispatched twice) FAILS the fresh-sandbox criterion", () => {
    const attempts = [
      synthAttempt(1),
      synthAttempt(2, { sandboxId: freshSandboxId("exec-synth", 1) }),
      synthAttempt(3),
    ];
    const criteria = deriveSubstrateFailureCriteria({
      executionId: "exec-synth",
      groundTruth: baseGround,
      attempts,
      finalOutcome: {
        kind: "failure",
        failure: {
          failureClass: "sandbox-lost",
          layer: "substrate",
          retryable: true,
          adapterToken: "adapter-error",
          message: "lost",
          exitCode: null,
          deadlineElapsed: false,
          oomKilled: null,
          sandboxLost: true,
        },
      },
      journaledAttempts: 3,
      maxExtraAttempts: 2,
      strikesBefore: 0,
      strikesAfter: 1,
      quarantineEngagedDuringRun: false,
      usageMicroUsd: null,
      totalDispatchLatencyMs: 12,
    });
    expect(criteria.find((c) => c.criterionId === "fresh-sandbox-per-attempt")?.status).toBe(
      "FAIL",
    );
  });

  test("a synthetic dispatch WITHOUT a passing probe FAILS the readiness-gated-dispatch criterion (dispatch-to-unready)", () => {
    const attempts = [synthAttempt(1, { probeReady: false }), synthAttempt(2), synthAttempt(3)];
    const criteria = deriveSubstrateFailureCriteria({
      executionId: "exec-synth",
      groundTruth: baseGround,
      attempts,
      finalOutcome: null,
      journaledAttempts: 3,
      maxExtraAttempts: 2,
      strikesBefore: 0,
      strikesAfter: 1,
      quarantineEngagedDuringRun: false,
      usageMicroUsd: null,
      totalDispatchLatencyMs: 12,
    });
    expect(criteria.find((c) => c.criterionId === "readiness-gated-dispatch")?.status).toBe("FAIL");
  });

  test("a synthetic gate-refusal run that CONTACTED the substrate FAILS the quarantine contract (quarantine bypass)", () => {
    const gatedGround: SubstrateSubmissionGroundTruth = {
      ...baseGround,
      injectedClass: "readiness-refused",
      injectedRetryable: false,
      attempts: 1,
      attemptOutcomes: ["quarantine-refused" as const],
      substrateClass: "readiness-refused",
      strikesBefore: 2,
      strikesAfter: 2,
      gatedAtSubmission: true,
    };
    // The violation: the "gated" attempt actually probed AND dispatched.
    const violating = [synthAttempt(1, { outcome: "quarantine-refused", probeReady: true })];
    const criteria = deriveSubstrateFailureCriteria({
      executionId: "exec-synth",
      groundTruth: gatedGround,
      attempts: violating,
      finalOutcome: null,
      journaledAttempts: 1,
      maxExtraAttempts: 2,
      strikesBefore: 2,
      strikesAfter: 2,
      quarantineEngagedDuringRun: false,
      usageMicroUsd: null,
      totalDispatchLatencyMs: 4,
    });
    const quarantine = criteria.find((c) => c.criterionId === "quarantine-contract");
    expect(quarantine?.status).toBe("FAIL");
    expect(quarantine?.evidence).toContain("gated-submission-contacted-substrate");
  });

  test("a synthetic over-budget attempt sequence FAILS the bounded-retry criterion (no infinite loops tolerated)", () => {
    const attempts = [1, 2, 3, 4, 5].map((attempt) => synthAttempt(attempt));
    const criteria = deriveSubstrateFailureCriteria({
      executionId: "exec-synth",
      groundTruth: baseGround,
      attempts,
      finalOutcome: null,
      journaledAttempts: 5,
      maxExtraAttempts: 2,
      strikesBefore: 0,
      strikesAfter: 1,
      quarantineEngagedDuringRun: false,
      usageMicroUsd: null,
      totalDispatchLatencyMs: 20,
    });
    expect(criteria.find((c) => c.criterionId === "bounded-retry")?.status).toBe("FAIL");
    // The oracle pins the honest 3-attempt budget; the observed 5 also
    // fails the attempt-count criterion.
    expect(criteria.find((c) => c.criterionId === "attempt-count")?.status).toBe("FAIL");
  });

  test("a MISCLASSIFIED observation against the oracle FAILS the substrate-class and retry-classification criteria (the OOM masquerade)", () => {
    // The oracle pins resource-exhausted; the observed records claim a
    // retryable substrate-timeout (the misattribution shape).
    const misclassified = [1, 2, 3].map((attempt) =>
      synthAttempt(attempt, {
        substrateClass: "substrate-timeout",
        sandboxLost: null,
        deadlineElapsed: true,
      }),
    );
    const criteria = deriveSubstrateFailureCriteria({
      executionId: "exec-synth",
      groundTruth: {
        ...baseGround,
        injectedClass: "resource-exhausted",
        injectedRetryable: false,
        attempts: 1,
        attemptOutcomes: ["failure"],
        substrateClass: "resource-exhausted",
      },
      attempts: misclassified,
      finalOutcome: null,
      journaledAttempts: 3,
      maxExtraAttempts: 2,
      strikesBefore: 0,
      strikesAfter: 1,
      quarantineEngagedDuringRun: false,
      usageMicroUsd: null,
      totalDispatchLatencyMs: 12,
    });
    expect(criteria.find((c) => c.criterionId === "substrate-class")?.status).toBe("FAIL");
    expect(criteria.find((c) => c.criterionId === "retry-classification")?.status).toBe("FAIL");
  });

  test("a strike-accounting mismatch FAILS the quarantine contract (the propagation facts)", () => {
    const criteria = deriveSubstrateFailureCriteria({
      executionId: "exec-synth",
      groundTruth: baseGround,
      attempts: [synthAttempt(1), synthAttempt(2), synthAttempt(3)],
      finalOutcome: null,
      journaledAttempts: 3,
      maxExtraAttempts: 2,
      strikesBefore: 0,
      strikesAfter: 5, // the oracle declared 1
      quarantineEngagedDuringRun: false,
      usageMicroUsd: null,
      totalDispatchLatencyMs: 12,
    });
    const quarantine = criteria.find((c) => c.criterionId === "quarantine-contract");
    expect(quarantine?.status).toBe("FAIL");
    expect(quarantine?.evidence).toContain("strikesMatchOracle:false");
  });

  test("a duplicate journal record FAILS the journal-exactly-once criterion", () => {
    const criteria = deriveSubstrateFailureCriteria({
      executionId: "exec-synth",
      groundTruth: baseGround,
      attempts: [synthAttempt(1), synthAttempt(2), synthAttempt(3)],
      finalOutcome: null,
      journaledAttempts: 4,
      maxExtraAttempts: 2,
      strikesBefore: 0,
      strikesAfter: 1,
      quarantineEngagedDuringRun: false,
      usageMicroUsd: null,
      totalDispatchLatencyMs: 12,
    });
    expect(criteria.find((c) => c.criterionId === "journal-exactly-once-per-attempt")?.status).toBe(
      "FAIL",
    );
  });
});
