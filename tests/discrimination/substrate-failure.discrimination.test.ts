/**
 * VAL-022 acceptance criterion 6 — discrimination tests proving the
 * substrate-failure classification and recovery policy against
 * controlled fakes:
 *
 *   * readiness lies (both directions) — a probe claiming ready while
 *     the substrate loses the sandbox NEVER yields a readiness-refused
 *     outcome (the observed failure, not the probe's claim, is
 *     attributed); a probe claiming NOT-ready while the substrate is
 *     healthy is OBEYED — the submission is refused with ZERO
 *     executes (never dispatch to an unready substrate), and an
 *     oracle expecting the healthy completion FAILS its criterion
 *     mechanically;
 *   * quarantine bypass — while the quarantine window is active the
 *     adapter's probe is NEVER even consulted (zero probe calls: the
 *     gate short-circuits; a lying-healthy probe cannot bypass the
 *     quarantine), zero executes land, and a synthetic gated run that
 *     contacted the substrate FAILS the quarantine-contract criterion;
 *   * dispatch-to-unready — every dispatched attempt was preceded by a
 *     passing probe in the SAME attempt: a synthetic attempt sequence
 *     that dispatched without a passing probe FAILS the
 *     readiness-gated-dispatch criterion mechanically, and the real
 *     driver produces probe-call counts equal to its attempt counts;
 *   * misattributed OOM-vs-timeout — the OOM kill an adapter labeled
 *     `timeout` (exit 137, OOMKilled, deadline NOT elapsed)
 *     classifies resource-exhausted and is NEVER retried (exactly one
 *     attempt — the deterministic-reproduction boundary), while the
 *     genuine deadline timeout (timer fired) classifies
 *     substrate-timeout and IS retried within the bounded budget; an
 *     oracle pinned to the misattributed class FAILS its criteria
 *     mechanically;
 *   * fresh-sandbox re-entry — a synthetic sequence re-entering a dead
 *     sandbox identity FAILS the fresh-sandbox criterion; the real
 *     driver dispatches a distinct fresh sandbox per retry;
 *   * strike honesty — a task failure never strikes the substrate; a
 *     substrate-layer failure does (an oracle declaring the wrong
 *     strike propagation FAILS the quarantine contract);
 *   * journal digest isolation — the per-attempt journal carries
 *     digests and classification facts only; payload text and
 *     credential material never appear;
 *   * recovery honesty — the recovery submission's failed attempt
 *     stays journaled exactly once with `retried` recorded (never
 *     silently swallowed), and the cool-down recovery completes with
 *     the history journaled.
 */

import { describe, expect, test } from "vitest";
import {
  groundTruthForSubmission,
  OFFLINE_CORPUS_ROWS,
  SUBSTRATE_FAILURE_CORPUS,
  taskBodyForSubmission,
} from "../../benchmarks/validation/apps/substrate-failure/corpus";
import {
  containerOomMislabeledAsTimeoutObservation,
  createScriptedSubstrate,
  createSubstrateWorld,
  processTimeoutObservation,
  sandboxLostMidExecutionObservation,
} from "../../benchmarks/validation/apps/substrate-failure/fixtures";
import {
  classifySubstrateFailure,
  deriveSubstrateFailureCriteria,
  driveSubstrateFailureExecution,
  freshSandboxId,
  freshSubstrateState,
  type SubstrateAttemptRecord,
  type SubstrateFailureLifecyclePort,
  type SubstrateSubmissionGroundTruth,
} from "../../benchmarks/validation/platform/substrate-failure";

const noSleep = async () => {};

function recordingLifecycle(): {
  readonly lifecycle: SubstrateFailureLifecyclePort;
  readonly attemptRecords: SubstrateAttemptRecord[];
} {
  const attemptRecords: SubstrateAttemptRecord[] = [];
  const lifecycle: SubstrateFailureLifecyclePort = {
    async transition() {},
    async recordPlanningDecision() {},
    async recordAttempt({ record }) {
      attemptRecords.push(record);
    },
    async recordSubstrateEvent() {},
    async recordQuarantineEngaged() {},
    async complete() {},
  };
  return { lifecycle, attemptRecords };
}

const row = (rowId: string): (typeof OFFLINE_CORPUS_ROWS)[number] => {
  const found = OFFLINE_CORPUS_ROWS.find((candidate) => candidate.rowId === rowId);
  if (found === undefined) throw new Error(`missing corpus row ${rowId}`);
  return found;
};

/** Drive one submission of a row over a FRESH world (the unit-driving shape). */
async function driveSubmission(
  rowId: string,
  submissionIndex = 0,
): Promise<{
  readonly result: Awaited<ReturnType<typeof driveSubstrateFailureExecution>>;
  readonly attemptRecords: readonly SubstrateAttemptRecord[];
  readonly world: ReturnType<typeof createSubstrateWorld>;
}> {
  const corpusRow = row(rowId);
  const world = createSubstrateWorld({
    probeScript: corpusRow.probeScript,
    executeScript: corpusRow.executeScript,
  });
  const { lifecycle, attemptRecords } = recordingLifecycle();
  const result = await driveSubstrateFailureExecution({
    executionId: `exec-disc-${rowId}-${submissionIndex}`,
    task: taskBodyForSubmission(corpusRow, submissionIndex),
    groundTruth: groundTruthForSubmission(corpusRow, submissionIndex),
    provider: "substrate-discrimination-rail",
    model: "substrate-failure-probe",
    lifecycle,
    plane: world.plane,
    retry: { maxExtraAttempts: 2, backoffMs: 0, sleep: noSleep },
  });
  return { result, attemptRecords, world };
}

describe("substrate-failure discrimination (VAL-022 AC6)", () => {
  test("readiness lies (ready claim): a probe claiming ready while the sandbox is lost attributes sandbox-lost — an oracle expecting readiness-refused FAILS mechanically", async () => {
    // The substrate family's lying probe: ready, but every execution
    // loses its sandbox. The observed FAILURE is the truth.
    const { adapter, calls } = createScriptedSubstrate({
      probeScript: ["ready"],
      executeScript: ["lost"],
    });
    const plane = {
      adapterFor: () => adapter,
      state: freshSubstrateState(),
      policy: { quarantineThreshold: 2, quarantineCoolDownMs: 60_000 },
      clock: { nowMs: () => 1_000 },
    };
    const lyingReadyRow = row("sandbox-lost-persistent");
    const { lifecycle } = recordingLifecycle();
    const result = await driveSubstrateFailureExecution({
      executionId: "exec-disc-lying-ready",
      task: taskBodyForSubmission(lyingReadyRow, 0),
      groundTruth: {
        // The WRONG oracle: trusting the probe's ready claim, the
        // submission should have been refused — it was not.
        injectedClass: "readiness-refused",
        injectedRetryable: true,
        attempts: 3,
        attemptOutcomes: ["readiness-refused", "readiness-refused", "readiness-refused"],
        terminal: "FAILED",
        substrateClass: "readiness-refused",
        layer: "substrate",
        strikesBefore: 0,
        strikesAfter: 1,
        quarantineEngages: false,
        gatedAtSubmission: false,
      } satisfies SubstrateSubmissionGroundTruth,
      provider: "p",
      model: "m",
      lifecycle,
      plane,
      retry: { maxExtraAttempts: 2, backoffMs: 0, sleep: noSleep },
    });
    // The probe WAS consulted (the gate obeyed its ready claim)…
    expect(calls.probes.count).toBe(3);
    // …but the observed failure is the honest sandbox-lost, and the
    // readiness-refused oracle FAILS mechanically.
    expect(result.finalFailure?.failureClass).toBe("sandbox-lost");
    expect(result.criteria.find((c) => c.criterionId === "substrate-class")?.status).toBe("FAIL");
    expect(result.criteria.find((c) => c.criterionId === "retry-classification")?.status).toBe(
      "FAIL",
    );
  });

  test("readiness lies (not-ready claim): a healthy substrate behind a not-ready probe is NEVER dispatched — an oracle expecting the healthy completion FAILS mechanically", async () => {
    // The substrate could execute (the execute script is healthy) but
    // the probe refuses: the gate OBEYS the probe. Zero executes.
    const { adapter, calls } = createScriptedSubstrate({
      probeScript: ["not-ready"],
      executeScript: ["success"],
    });
    const plane = {
      adapterFor: () => adapter,
      state: freshSubstrateState(),
      policy: { quarantineThreshold: 2, quarantineCoolDownMs: 60_000 },
      clock: { nowMs: () => 1_000 },
    };
    const healthyRow = row("healthy-substrate");
    const { lifecycle } = recordingLifecycle();
    const result = await driveSubstrateFailureExecution({
      executionId: "exec-disc-lying-unready",
      task: taskBodyForSubmission(healthyRow, 0),
      groundTruth: {
        // The WRONG oracle: the substrate was healthy, so the run
        // "should" have completed. It honestly did not — the gate held.
        injectedClass: null,
        injectedRetryable: false,
        attempts: 1,
        attemptOutcomes: ["success"],
        terminal: "COMPLETED",
        substrateClass: null,
        layer: null,
        strikesBefore: 0,
        strikesAfter: 0,
        quarantineEngages: false,
        gatedAtSubmission: false,
      } satisfies SubstrateSubmissionGroundTruth,
      provider: "p",
      model: "m",
      lifecycle,
      plane,
      retry: { maxExtraAttempts: 2, backoffMs: 0, sleep: noSleep },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.executesPerformed).toBe(0);
    expect(calls.executes.count).toBe(0);
    expect(result.finalFailure?.failureClass).toBe("readiness-refused");
    expect(result.criteria.find((c) => c.criterionId === "outcome-contract")?.status).toBe("FAIL");
    expect(result.criteria.find((c) => c.criterionId === "substrate-class")?.status).toBe("FAIL");
  });

  test("quarantine bypass: while quarantined the probe is NEVER consulted (zero probe calls) and nothing executes — a lying-healthy probe cannot bypass the gate", async () => {
    const { adapter, calls } = createScriptedSubstrate({
      probeScript: ["ready"],
      executeScript: ["success"],
    });
    // A pre-quarantined plane (two prior terminal failures).
    const state = freshSubstrateState();
    state.strikes = 2;
    state.quarantinedUntilEpochMs = 1_500_000;
    const plane = {
      adapterFor: () => adapter,
      state,
      policy: { quarantineThreshold: 2, quarantineCoolDownMs: 60_000 },
      clock: { nowMs: () => 1_000_000 },
    };
    const probeRow = row("healthy-substrate");
    const { lifecycle } = recordingLifecycle();
    const result = await driveSubstrateFailureExecution({
      executionId: "exec-disc-quarantine-bypass",
      task: taskBodyForSubmission(probeRow, 0),
      groundTruth: {
        injectedClass: null,
        injectedRetryable: false,
        attempts: 1,
        attemptOutcomes: ["success"],
        terminal: "COMPLETED",
        substrateClass: null,
        layer: null,
        strikesBefore: 2,
        strikesAfter: 2,
        quarantineEngages: false,
        gatedAtSubmission: true,
      } satisfies SubstrateSubmissionGroundTruth,
      provider: "p",
      model: "m",
      lifecycle,
      plane,
      retry: { maxExtraAttempts: 2, backoffMs: 0, sleep: noSleep },
    });
    // The gate refused BEFORE the probe: zero probes, zero executes,
    // despite the adapter being scripted healthy-and-ready.
    expect(calls.probes.count).toBe(0);
    expect(calls.executes.count).toBe(0);
    expect(result.terminal).toBe("FAILED");
    expect(result.attempts[0]?.outcome).toBe("quarantine-refused");
    // A WRONG oracle (expecting the healthy completion through the
    // quarantine) FAILS mechanically.
    expect(result.criteria.find((c) => c.criterionId === "substrate-class")?.status).toBe("FAIL");
    expect(result.criteria.find((c) => c.criterionId === "outcome-contract")?.status).toBe("FAIL");
  });

  test("quarantine bypass (synthetic): a gated run that CONTACTED the substrate FAILS the quarantine-contract criterion", () => {
    const gatedGround: SubstrateSubmissionGroundTruth = {
      injectedClass: "readiness-refused",
      injectedRetryable: false,
      attempts: 1,
      attemptOutcomes: ["quarantine-refused"],
      terminal: "FAILED",
      substrateClass: "readiness-refused",
      layer: "substrate",
      strikesBefore: 2,
      strikesAfter: 2,
      quarantineEngages: false,
      gatedAtSubmission: true,
    };
    // The violation: the gated attempt actually dispatched.
    const violating: SubstrateAttemptRecord[] = [
      {
        attempt: 1,
        outcome: "quarantine-refused",
        substrateClass: "readiness-refused",
        layer: "substrate",
        retryable: false,
        retried: false,
        latencyMs: 3,
        sandboxId: freshSandboxId("exec-disc", 1),
        probeReady: true,
        specDigest: "aaaa0000",
        exitCode: null,
        deadlineElapsed: null,
        oomKilled: null,
        sandboxLost: null,
        message: "quarantined",
        atEpochMs: 1_000,
      },
    ];
    const criteria = deriveSubstrateFailureCriteria({
      executionId: "exec-disc",
      groundTruth: gatedGround,
      attempts: violating,
      finalOutcome: null,
      journaledAttempts: 1,
      maxExtraAttempts: 2,
      strikesBefore: 2,
      strikesAfter: 2,
      quarantineEngagedDuringRun: false,
      usageMicroUsd: null,
      totalDispatchLatencyMs: 3,
    });
    const quarantine = criteria.find((c) => c.criterionId === "quarantine-contract");
    expect(quarantine?.status).toBe("FAIL");
    expect(quarantine?.evidence).toContain("gated-submission-contacted-substrate");
    // The readiness gate also flags the probeless dispatch.
    expect(criteria.find((c) => c.criterionId === "readiness-gated-dispatch")?.status).toBe("FAIL");
  });

  test("dispatch-to-unready (synthetic): a dispatched attempt without a passing same-attempt probe FAILS the readiness-gated-dispatch criterion; the real driver probes per attempt", async () => {
    const unreadyDispatch: SubstrateAttemptRecord[] = [
      {
        attempt: 1,
        outcome: "failure",
        substrateClass: "sandbox-lost",
        layer: "substrate",
        retryable: true,
        retried: false,
        latencyMs: 3,
        sandboxId: freshSandboxId("exec-disc", 1),
        probeReady: false, // the probe said NOT ready — and it dispatched anyway
        specDigest: "aaaa0000",
        exitCode: null,
        deadlineElapsed: null,
        oomKilled: null,
        sandboxLost: true,
        message: "lost",
        atEpochMs: 1_000,
      },
    ];
    const criteria = deriveSubstrateFailureCriteria({
      executionId: "exec-disc",
      groundTruth: {
        injectedClass: "sandbox-lost",
        injectedRetryable: true,
        attempts: 1,
        attemptOutcomes: ["failure"],
        terminal: "FAILED",
        substrateClass: "sandbox-lost",
        layer: "substrate",
        strikesBefore: 0,
        strikesAfter: 1,
        quarantineEngages: false,
        gatedAtSubmission: false,
      } satisfies SubstrateSubmissionGroundTruth,
      attempts: unreadyDispatch,
      finalOutcome: null,
      journaledAttempts: 1,
      maxExtraAttempts: 2,
      strikesBefore: 0,
      strikesAfter: 1,
      quarantineEngagedDuringRun: false,
      usageMicroUsd: null,
      totalDispatchLatencyMs: 3,
    });
    expect(criteria.find((c) => c.criterionId === "readiness-gated-dispatch")?.status).toBe("FAIL");

    // The real driver: probes === attempts on the readiness row; every
    // probe answer is journaled per attempt.
    const readiness = await driveSubmission("readiness-refused-persistent");
    expect(readiness.result.probesPerformed).toBe(readiness.result.totalAttempts);
    expect(readiness.world.calls.probes.count).toBe(3);
    expect(readiness.world.calls.probes.ready.every((ready) => ready === false)).toBe(true);
    expect(readiness.result.executesPerformed).toBe(0);
  });

  test("misattributed OOM-vs-timeout: the OOM-mislabeled timeout is resource-exhausted and NEVER retried; the genuine deadline timeout is substrate-timeout and retried within budget; oracles pinned to the wrong class FAIL", async () => {
    // (a) The fact-driven classification: identical `timeout` tokens,
    //     disjoint classes — exactly the facts decide.
    const oom = classifySubstrateFailure(containerOomMislabeledAsTimeoutObservation(64));
    const genuine = classifySubstrateFailure(processTimeoutObservation(30_000));
    expect(oom?.failureClass).toBe("resource-exhausted");
    expect(oom?.retryable).toBe(false);
    expect(genuine?.failureClass).toBe("substrate-timeout");
    expect(genuine?.retryable).toBe(true);
    expect(oom?.adapterToken).toBe(genuine?.adapterToken);

    // (b) The driver honors the split: the OOM row is a single attempt
    //     (the deterministic-reproduction boundary); the timeout row
    //     exhausts the bounded budget with fresh sandboxes.
    const oomRun = await driveSubmission("resource-exhausted-oom");
    expect(oomRun.result.totalAttempts).toBe(1);
    expect(oomRun.result.executesPerformed).toBe(1);
    expect(oomRun.result.attempts[0]?.deadlineElapsed).toBe(false);
    expect(oomRun.result.attempts[0]?.oomKilled).toBe(true);

    const timeoutRun = await driveSubmission("substrate-timeout");
    expect(timeoutRun.result.totalAttempts).toBe(3);
    expect(timeoutRun.result.executesPerformed).toBe(3);
    expect(timeoutRun.result.attempts.every((r) => r.deadlineElapsed === true)).toBe(true);
    const sandboxIds = timeoutRun.attemptRecords
      .filter((record) => record.sandboxId !== null)
      .map((record) => record.sandboxId);
    expect(new Set(sandboxIds).size).toBe(3);

    // (c) The WRONG oracle: pinning the misattributed retryable
    //     timeout for the OOM row FAILS mechanically.
    const oomRow = row("resource-exhausted-oom");
    const { lifecycle } = recordingLifecycle();
    const world = createSubstrateWorld({
      probeScript: oomRow.probeScript,
      executeScript: oomRow.executeScript,
    });
    const misattribution = await driveSubstrateFailureExecution({
      executionId: "exec-disc-oom-misattributed",
      task: taskBodyForSubmission(oomRow, 0),
      groundTruth: {
        injectedClass: "substrate-timeout",
        injectedRetryable: true,
        attempts: 3,
        attemptOutcomes: ["failure", "failure", "failure"],
        terminal: "FAILED",
        substrateClass: "substrate-timeout",
        layer: "substrate",
        strikesBefore: 0,
        strikesAfter: 1,
        quarantineEngages: false,
        gatedAtSubmission: false,
      } satisfies SubstrateSubmissionGroundTruth,
      provider: "p",
      model: "m",
      lifecycle,
      plane: world.plane,
      retry: { maxExtraAttempts: 2, backoffMs: 0, sleep: noSleep },
    });
    expect(misattribution.finalFailure?.failureClass).toBe("resource-exhausted");
    expect(misattribution.totalAttempts).toBe(1);
    expect(misattribution.criteria.find((c) => c.criterionId === "substrate-class")?.status).toBe(
      "FAIL",
    );
    expect(misattribution.criteria.find((c) => c.criterionId === "attempt-count")?.status).toBe(
      "FAIL",
    );
  });

  test("misattributed OOM-vs-timeout (direct classifier discrimination): a `sandbox-execution` exit 137 with OOMKilled is STILL resource-exhausted — the task is never blamed for a resource-manager kill", () => {
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
    // And the task's own exit 2 with the same token stays the task's.
    const taskExit = classifySubstrateFailure({
      outcomeClass: "sandbox-failure",
      outputDigest: null,
      output: { exitCode: 2, deadlineElapsed: false },
      usageMicroUsd: null,
      failure: {
        failureClass: "sandbox-execution",
        message: "process exited with code 2",
        retryable: false,
      },
    });
    expect(taskExit?.failureClass).toBe("task-failure");
    expect(taskExit?.layer).toBe("task");
  });

  test("fresh-sandbox re-entry (synthetic): a retry that re-enters a DEAD sandbox identity FAILS the fresh-sandbox criterion", () => {
    const reentry: SubstrateAttemptRecord[] = [1, 2].map((attempt) => ({
      attempt,
      outcome: "failure" as const,
      substrateClass: "sandbox-lost" as const,
      layer: "substrate" as const,
      retryable: true,
      retried: attempt === 1,
      latencyMs: 3,
      // The violation: attempt 2 re-entered attempt 1's dead sandbox.
      sandboxId: freshSandboxId("exec-disc", 1),
      probeReady: true,
      specDigest: "aaaa0000",
      exitCode: null,
      deadlineElapsed: false,
      oomKilled: null,
      sandboxLost: true,
      message: "lost",
      atEpochMs: 1_000 + attempt,
    }));
    const criteria = deriveSubstrateFailureCriteria({
      executionId: "exec-disc",
      groundTruth: {
        injectedClass: "sandbox-lost",
        injectedRetryable: true,
        attempts: 2,
        attemptOutcomes: ["failure", "failure"],
        terminal: "FAILED",
        substrateClass: "sandbox-lost",
        layer: "substrate",
        strikesBefore: 0,
        strikesAfter: 1,
        quarantineEngages: false,
        gatedAtSubmission: false,
      } satisfies SubstrateSubmissionGroundTruth,
      attempts: reentry,
      finalOutcome: null,
      journaledAttempts: 2,
      maxExtraAttempts: 2,
      strikesBefore: 0,
      strikesAfter: 1,
      quarantineEngagedDuringRun: false,
      usageMicroUsd: null,
      totalDispatchLatencyMs: 6,
    });
    expect(criteria.find((c) => c.criterionId === "fresh-sandbox-per-attempt")?.status).toBe(
      "FAIL",
    );
  });

  test("strike honesty: a task failure never strikes; a synthetic strike-accounting mismatch FAILS the quarantine contract", async () => {
    const taskRun = await driveSubmission("task-failure-in-sandbox");
    expect(taskRun.result.strikesAfter).toBe(0);
    expect(taskRun.result.strikesBefore).toBe(0);

    const lostRun = await driveSubmission("sandbox-lost-persistent");
    expect(lostRun.result.strikesAfter).toBe(1);

    // A WRONG oracle: declaring the task-failure row struck.
    const criteria = deriveSubstrateFailureCriteria({
      executionId: "exec-disc",
      groundTruth: {
        injectedClass: "task-failure",
        injectedRetryable: false,
        attempts: 1,
        attemptOutcomes: ["failure"],
        terminal: "FAILED",
        substrateClass: "task-failure",
        layer: "task",
        strikesBefore: 0,
        strikesAfter: 2,
        quarantineEngages: false,
        gatedAtSubmission: false,
      } satisfies SubstrateSubmissionGroundTruth,
      attempts: [
        {
          attempt: 1,
          outcome: "failure",
          substrateClass: "task-failure",
          layer: "task",
          retryable: false,
          retried: false,
          latencyMs: 3,
          sandboxId: freshSandboxId("exec-disc", 1),
          probeReady: true,
          specDigest: "aaaa0000",
          exitCode: 2,
          deadlineElapsed: null,
          oomKilled: null,
          sandboxLost: null,
          message: "exit 2",
          atEpochMs: 1_000,
        },
      ],
      finalOutcome: null,
      journaledAttempts: 1,
      maxExtraAttempts: 2,
      strikesBefore: 0,
      strikesAfter: 0,
      quarantineEngagedDuringRun: false,
      usageMicroUsd: null,
      totalDispatchLatencyMs: 3,
    });
    const quarantine = criteria.find((c) => c.criterionId === "quarantine-contract");
    expect(quarantine?.status).toBe("FAIL");
    expect(quarantine?.evidence).toContain("strikesMatchOracle:false");
  });

  test("journal digest isolation: the per-attempt journal carries digests and classification facts only — payload text and credential material never appear", async () => {
    const oomRun = await driveSubmission("resource-exhausted-oom");
    const journalText = JSON.stringify(oomRun.attemptRecords);
    expect(journalText).not.toContain("substrate-ok");
    expect(journalText).not.toContain("/bin/echo");
    expect(journalText).not.toContain("Bearer");
    expect(journalText).not.toContain("zeck-token");
    expect(oomRun.attemptRecords[0]?.specDigest).toMatch(/^[0-9a-f]{8}$/);
    // The sandbox-lost evidence rides as a FACT, never as payload.
    const lostRun = await driveSubmission("sandbox-lost-recovery");
    expect(lostRun.attemptRecords[0]?.sandboxLost).toBe(true);
    expect(JSON.stringify(lostRun.attemptRecords)).not.toContain("substrate-ok");
  });

  test("recovery honesty: the recovery submission's failed attempt stays journaled exactly once with retried recorded; the cool-down recovery completes with the history journaled", async () => {
    const recoveryRun = await driveSubmission("sandbox-lost-recovery");
    expect(recoveryRun.result.terminal).toBe("COMPLETED");
    expect(recoveryRun.attemptRecords.length).toBe(2);
    expect(recoveryRun.attemptRecords[0]?.outcome).toBe("failure");
    expect(recoveryRun.attemptRecords[0]?.substrateClass).toBe("sandbox-lost");
    expect(recoveryRun.attemptRecords[0]?.retried).toBe(true);
    expect(recoveryRun.attemptRecords[1]?.outcome).toBe("success");
    expect(recoveryRun.attemptRecords[1]?.retried).toBe(false);

    // The quarantine row's full sequence: the engagement, the gated
    // future submission and the cool-down recovery — all journaled.
    const quarantineRow = row("quarantine-propagation-and-recovery");
    const world = createSubstrateWorld({
      probeScript: quarantineRow.probeScript,
      executeScript: quarantineRow.executeScript,
    });
    const allRecords: SubstrateAttemptRecord[] = [];
    const terminals: string[] = [];
    for (let index = 0; index < quarantineRow.oracle.submissions.length; index += 1) {
      const advance = quarantineRow.clockAdvanceBySubmission?.[index] ?? 0;
      if (advance > 0) {
        world.clock.advance(advance);
      }
      const { lifecycle, attemptRecords } = recordingLifecycle();
      const result = await driveSubstrateFailureExecution({
        executionId: `exec-disc-q-${index + 1}`,
        task: taskBodyForSubmission(quarantineRow, index),
        groundTruth: groundTruthForSubmission(quarantineRow, index),
        provider: "p",
        model: "m",
        lifecycle,
        plane: world.plane,
        retry: { maxExtraAttempts: 2, backoffMs: 0, sleep: noSleep },
      });
      terminals.push(result.terminal);
      allRecords.push(...attemptRecords);
    }
    expect(terminals).toEqual(["FAILED", "FAILED", "FAILED", "COMPLETED"]);
    // The whole substrate-failure history is journaled: 3 + 3 + 1 + 1
    // attempts across the row's four submissions.
    expect(allRecords.length).toBe(8);
    expect(allRecords[6]?.outcome).toBe("quarantine-refused");
    expect(allRecords[6]?.probeReady).toBeNull();
    expect(allRecords[7]?.outcome).toBe("success");
  });

  test("request reproducibility: identical probe tasks produce identical spec digests; a different task digests differently", async () => {
    const first = await driveSubmission("sandbox-lost-persistent");
    const second = await driveSubmission("sandbox-lost-persistent");
    expect(first.attemptRecords[0]?.specDigest).toBe(second.attemptRecords[0]?.specDigest);
    // The same row's digests are also stable ACROSS attempts (the same
    // submitted task), while a different row digests differently.
    const timeoutRun = await driveSubmission("substrate-timeout");
    expect(timeoutRun.attemptRecords[0]?.specDigest).not.toBe(first.attemptRecords[0]?.specDigest);
    const digests = new Set(timeoutRun.attemptRecords.map((record) => record.specDigest));
    expect(digests.size).toBe(1);
  });

  test("the REAL failure shapes classify disjointly: identical adapter tokens, fact-driven classes (the taxonomy table holds)", () => {
    // Both carry the `adapter-error` token; only the lost-sandbox
    // evidence separates the retryable loss from the non-retryable
    // adapter error.
    const lost = classifySubstrateFailure(sandboxLostMidExecutionObservation("sbx-1"));
    expect(lost?.failureClass).toBe("sandbox-lost");
    expect(lost?.retryable).toBe(true);
    expect(
      classifySubstrateFailure({
        outcomeClass: "sandbox-failure",
        outputDigest: null,
        output: {},
        usageMicroUsd: null,
        failure: {
          failureClass: "adapter-error",
          message: "client threw",
          retryable: false,
        },
      })?.failureClass,
    ).toBe("adapter-error");
    // The corpus covers every substrate-layer class the work order
    // names: readiness-refused, lost-mid-execution,
    // timeout-classified, resource-exhausted.
    const injectedClasses = new Set(SUBSTRATE_FAILURE_CORPUS.map((r) => r.oracle.injectedClass));
    for (const required of [
      "readiness-refused",
      "sandbox-lost",
      "substrate-timeout",
      "resource-exhausted",
      "runtime-unavailable",
      "task-failure",
    ]) {
      expect(injectedClasses.has(required as never), `corpus must cover ${required}`).toBe(true);
    }
  });
});
