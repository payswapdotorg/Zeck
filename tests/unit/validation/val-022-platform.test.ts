/**
 * VAL-022 acceptance criteria 1, 2, 4, 5: the substrate-readiness
 * platform slice against controlled fakes — the substrate-failure
 * taxonomy derivations (substrate class + platform fold +
 * retryability for every documented REAL shape, the OOM-vs-timeout
 * discrimination), the quarantine derivation and the in-memory
 * registry, the fresh-sandbox derivation, the bounded substrate
 * executor (the observation race — a lost sandbox never settles, a
 * thrown adapter error is adapter-error), and the execution driver
 * (canonical lifecycle order, planning decision BEFORE the first
 * dispatch, the readiness gate probing before EVERY dispatch, bounded
 * retry with per-attempt journaling exactly once, fresh sandboxes per
 * attempt, honest terminals, recovery rows COMPLETED with the
 * substrate-failure history journaled, quarantine-on-repeat-failure
 * with propagation to the third submission, the honest outcome
 * journal — lost sandboxes journal no outcome).
 */

import { describe, expect, test } from "vitest";
import {
  CORPUS_QUARANTINE_THRESHOLD,
  CORPUS_READINESS_POLICY,
  CORPUS_RETRY_POLICY,
  OFFLINE_CORPUS_ROWS,
  type SubstrateCorpusRow,
} from "../../../benchmarks/validation/apps/substrate-failure/corpus";
import { createFaultInjectedSubstrate } from "../../../benchmarks/validation/apps/substrate-failure/fixtures";
import {
  bindReadinessGate,
  bindSubstrateRun,
  CONTAINER_FAIL_CLOSED_SHAPE,
  CONTAINER_OOMKILLED_SHAPE,
  classifyReadinessRefusal,
  classifySubstrateRun,
  createBoundedSubstrateExecutor,
  createInMemorySubstrateRegistry,
  deriveFreshSandboxId,
  deriveQuarantineDecision,
  deriveSubstrateReadinessCriteria,
  driveSubstrateReadinessExecution,
  healthySubstrateObservation,
  isRetryableSubstrateClass,
  PAYLOAD_EXIT_NONZERO_SHAPE,
  PROCESS_DEADLINE_KILL_SHAPE,
  platformFailureClassOf,
  REAL_SUBSTRATE_FAILURE_SHAPES,
  type ReadinessProbeRecord,
  SUBSTRATE_FAILURE_CLASSES,
  type SubstrateAttemptRecord,
  type SubstrateFailureClass,
  type SubstrateReadinessLifecyclePort,
  type SubstrateTaskSpec,
  substrateTaskDigest,
} from "../../../benchmarks/validation/platform/substrate-readiness";

// ---------------------------------------------------------------------------
// Fake lifecycle + helpers
// ---------------------------------------------------------------------------

interface FakeLifecycle extends SubstrateReadinessLifecyclePort {
  readonly transitions: string[];
  readonly decisions: { provider: string; model: string; strategyClass: string }[];
  readonly probeRecords: ReadinessProbeRecord[];
  readonly admissions: { attempt: number; sandboxId: string; taskDigest: string }[];
  readonly attemptRecords: SubstrateAttemptRecord[];
  readonly outcomeRecords: {
    attempt: number;
    sandboxId: string;
    reference: Record<string, unknown>;
  }[];
  readonly quarantineRecords: { substrateId: string; failureStreak: number; reason: string }[];
  readonly completions: { verdict: string; criteria: { criterionId: string; status: string }[] }[];
  /** The ordered event kinds (the canonical-order assertion surface). */
  readonly eventLog: string[];
}

function createFakeLifecycle(): FakeLifecycle {
  const transitions: string[] = [];
  const decisions: { provider: string; model: string; strategyClass: string }[] = [];
  const probeRecords: ReadinessProbeRecord[] = [];
  const admissions: { attempt: number; sandboxId: string; taskDigest: string }[] = [];
  const attemptRecords: SubstrateAttemptRecord[] = [];
  const outcomeRecords: {
    attempt: number;
    sandboxId: string;
    reference: Record<string, unknown>;
  }[] = [];
  const quarantineRecords: { substrateId: string; failureStreak: number; reason: string }[] = [];
  const completions: { verdict: string; criteria: { criterionId: string; status: string }[] }[] =
    [];
  const eventLog: string[] = [];
  const port: SubstrateReadinessLifecyclePort = {
    async transition({ step }) {
      transitions.push(step);
      eventLog.push(`transition:${step}`);
    },
    async recordPlanningDecision({ route }) {
      decisions.push({ ...route });
      eventLog.push("planning-decision");
    },
    async recordReadinessProbe({ record }) {
      probeRecords.push(record);
      eventLog.push(`probe:${record.probe}`);
    },
    async recordSandboxAdmission({ attempt, sandboxId, taskDigest }) {
      admissions.push({ attempt, sandboxId, taskDigest });
      eventLog.push(`admission:${attempt}`);
    },
    async recordDispatchAttempt({ record }) {
      attemptRecords.push(record);
      eventLog.push(`attempt:${record.attempt}`);
    },
    async recordSandboxOutcome({ attempt, sandboxId, reference }) {
      outcomeRecords.push({ attempt, sandboxId, reference: { ...reference } });
      eventLog.push(`outcome:${attempt}`);
    },
    async recordQuarantine({ substrateId, failureStreak, reason }) {
      quarantineRecords.push({ substrateId, failureStreak, reason });
      eventLog.push("quarantine");
    },
    async complete({ verdict, criteria }) {
      completions.push({
        verdict,
        criteria: criteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          status: criterion.status,
        })),
      });
      eventLog.push(`complete:${verdict}`);
    },
  };
  return Object.assign(port, {
    transitions,
    decisions,
    probeRecords,
    admissions,
    attemptRecords,
    outcomeRecords,
    quarantineRecords,
    completions,
    eventLog,
  });
}

const pinnedClock = () => 1_000;

/** The deterministic backoff spy (records waits; never sleeps). */
function createSleepSpy(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return { sleep: async (ms: number) => void calls.push(ms), calls };
}

/** The PROBE_TASK spec (mirrors the corpus's pinned task). */
const PROBE_TASK_SPEC: SubstrateTaskSpec = {
  command: "probe-worker",
  args: ["--emit", "substrate-ok"],
  env: {},
};

/** The pinned limits (mirrors the corpus's pinned limits). */
const PROBE_LIMITS = { cpuMilliCores: 500, memoryMiB: 256, executionTimeoutMs: 5_000 };

/** The immediate deadline timer (the lost-sandbox race elapses instantly). */
const immediateTimer = async () => {};

/** Drive one offline corpus ROW's executions in sequence over one shared world. */
async function driveRow(row: SubstrateCorpusRow): Promise<{
  readonly results: Awaited<ReturnType<typeof driveSubstrateReadinessExecution>>[];
  readonly lifecycle: FakeLifecycle;
  readonly registry: ReturnType<typeof createInMemorySubstrateRegistry>;
  readonly sleepCalls: number[];
  readonly seam: ReturnType<typeof createFaultInjectedSubstrate>["seam"];
  readonly calls: ReturnType<typeof createFaultInjectedSubstrate>["calls"];
}> {
  const lifecycle = createFakeLifecycle();
  const registry = createInMemorySubstrateRegistry({
    threshold: CORPUS_QUARANTINE_THRESHOLD,
  });
  const { sleep, calls } = createSleepSpy();
  if (row.scenario === null) {
    throw new Error(`offline row ${row.rowId} without a scenario`);
  }
  const { seam, calls: seamCalls } = createFaultInjectedSubstrate({ scenario: row.scenario });
  const executor = createBoundedSubstrateExecutor({
    seam,
    observationDeadlineMs: 25,
    timer: immediateTimer,
  });
  const probe = bindReadinessGate({ registry, seam });
  const run = bindSubstrateRun({
    executor,
    substrateId: row.substrateId,
    task: PROBE_TASK_SPEC,
    limits: PROBE_LIMITS,
  });
  const results: Awaited<ReturnType<typeof driveSubstrateReadinessExecution>>[] = [];
  for (const [executionIndex, groundTruth] of row.executions.entries()) {
    const result = await driveSubstrateReadinessExecution({
      executionId: `exec-${row.rowId}-${executionIndex + 1}`,
      task: { kind: "substrate-probe", input: { scenario: row.rowId } },
      groundTruth,
      substrateId: row.substrateId,
      taskSpec: PROBE_TASK_SPEC,
      limits: PROBE_LIMITS,
      provider: "substrate-probe-rail",
      model: "process",
      lifecycle,
      run,
      probe,
      report: (input) => registry.reportExecutionOutcome(input),
      retry: {
        maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
        backoffMs: 5,
        sleep,
      },
      readiness: {
        maxProbes: CORPUS_READINESS_POLICY.maxProbes,
        backoffMs: 5,
        sleep,
      },
      quarantineThreshold: CORPUS_QUARANTINE_THRESHOLD,
      now: pinnedClock,
    });
    results.push(result);
  }
  return { results, lifecycle, registry, sleepCalls: calls, seam, calls: seamCalls };
}

// ---------------------------------------------------------------------------
// The taxonomy (PURE derivations)
// ---------------------------------------------------------------------------

describe("VAL-022 substrate-failure taxonomy", () => {
  test("every substrate class folds onto exactly one platform class; the retryable set is exactly {sandbox-lost, substrate-timeout}", () => {
    for (const substrateClass of SUBSTRATE_FAILURE_CLASSES) {
      expect(platformFailureClassOf(substrateClass)).toMatch(
        /^(sandbox-execution|timeout|adapter-error|runtime-unavailable)$/,
      );
    }
    const retryable = SUBSTRATE_FAILURE_CLASSES.filter(isRetryableSubstrateClass);
    expect(retryable.sort()).toEqual(["sandbox-lost", "substrate-timeout"].sort());
  });

  test("the REAL process-runtime deadline-kill shape classifies as substrate-timeout (the platform's timeout fold, retryable)", () => {
    const verdict = classifySubstrateRun(PROCESS_DEADLINE_KILL_SHAPE);
    expect(verdict.substrateClass).toBe("substrate-timeout");
    expect(verdict.platformClass).toBe("timeout");
    expect(verdict.retryable).toBe(true);
    expect(verdict.exitCode).toBe(137);
    expect(verdict.timedOut).toBe(true);
    expect(verdict.oomKilled).toBe(false);
  });

  test("the REAL container OOMKilled shape classifies as resource-exhausted (NON-retryable — the same work would exhaust again)", () => {
    const verdict = classifySubstrateRun(CONTAINER_OOMKILLED_SHAPE);
    expect(verdict.substrateClass).toBe("resource-exhausted");
    expect(verdict.platformClass).toBe("sandbox-execution");
    expect(verdict.retryable).toBe(false);
    expect(verdict.exitCode).toBe(137);
    expect(verdict.timedOut).toBe(false);
    expect(verdict.oomKilled).toBe(true);
  });

  test("the OOM-vs-timeout discrimination: a 137 WITH the timeout marker is never an OOM; a 137 WITH the OOM marker is never a timeout", () => {
    // exit 137 + timedOut (the deadline kill) — timeout, NOT resource-exhausted
    const deadlineKill = classifySubstrateRun({
      settled: true,
      timedOut: true,
      oomKilled: false,
      exitCode: 137,
      stdoutDigest: null,
      durationMs: 250,
      usageMicroUsd: null,
      adapterError: null,
    });
    expect(deadlineKill.substrateClass).toBe("substrate-timeout");
    // exit 137 + oomKilled (the container inspection) — OOM, NOT a timeout
    const oomKill = classifySubstrateRun({
      settled: true,
      timedOut: false,
      oomKilled: true,
      exitCode: 137,
      stdoutDigest: null,
      durationMs: null,
      usageMicroUsd: null,
      adapterError: null,
    });
    expect(oomKill.substrateClass).toBe("resource-exhausted");
    // BOTH markers cannot co-occur honestly, but if they did, the
    // deadline marker wins (the admitted bound was enforced first).
    const both = classifySubstrateRun({
      settled: true,
      timedOut: true,
      oomKilled: true,
      exitCode: 137,
      stdoutDigest: null,
      durationMs: null,
      usageMicroUsd: null,
      adapterError: null,
    });
    expect(both.substrateClass).toBe("substrate-timeout");
  });

  test("the REAL payload exit-code shape classifies as sandbox-execution (the exit-code fold, NON-retryable)", () => {
    const verdict = classifySubstrateRun(PAYLOAD_EXIT_NONZERO_SHAPE);
    expect(verdict.substrateClass).toBe("sandbox-execution");
    expect(verdict.platformClass).toBe("sandbox-execution");
    expect(verdict.retryable).toBe(false);
    expect(verdict.exitCode).toBe(7);
  });

  test("a never-settling observation classifies as sandbox-lost (the honest mid-execution LOSS, retryable)", () => {
    const verdict = classifySubstrateRun({
      settled: false,
      timedOut: false,
      oomKilled: false,
      exitCode: null,
      stdoutDigest: null,
      durationMs: null,
      usageMicroUsd: null,
      adapterError: null,
    });
    expect(verdict.substrateClass).toBe("sandbox-lost");
    expect(verdict.platformClass).toBe("runtime-unavailable");
    expect(verdict.retryable).toBe(true);
    expect(verdict.exitCode).toBeNull();
  });

  test("a thrown adapter error classifies as adapter-error (the REAL fail-closed container-provider shape)", () => {
    const verdict = classifySubstrateRun(CONTAINER_FAIL_CLOSED_SHAPE);
    expect(verdict.substrateClass).toBe("adapter-error");
    expect(verdict.platformClass).toBe("adapter-error");
    expect(verdict.retryable).toBe(false);
    expect(verdict.message).toContain("isolation guarantees cannot be established");
  });

  test("the healthy observation classifies as success (class null — never a fabricated failure)", () => {
    const verdict = classifySubstrateRun(healthySubstrateObservation());
    expect(verdict.substrateClass).toBeNull();
    expect(verdict.platformClass).toBeNull();
    expect(verdict.exitCode).toBe(0);
  });

  test("a readiness refusal classifies as readiness-refused / runtime-unavailable, never dispatch-retryable", () => {
    const verdict = classifyReadinessRefusal("the substrate refused readiness");
    expect(verdict.substrateClass).toBe("readiness-refused");
    expect(verdict.platformClass).toBe("runtime-unavailable");
    expect(verdict.retryable).toBe(false);
  });

  test("every documented REAL failure shape classifies to a distinct (or pinned-fold) verdict", () => {
    const shapes = REAL_SUBSTRATE_FAILURE_SHAPES.map(
      (shape) => classifySubstrateRun(shape.raw).substrateClass,
    );
    expect(shapes).toEqual([
      "substrate-timeout",
      "resource-exhausted",
      "adapter-error",
      "sandbox-execution",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The quarantine derivation + registry
// ---------------------------------------------------------------------------

describe("VAL-022 quarantine derivation and registry", () => {
  test("the quarantine decision is threshold-exact — never premature, reset on success", () => {
    expect(deriveQuarantineDecision({ failureStreak: 0, threshold: 2 }).quarantined).toBe(false);
    expect(deriveQuarantineDecision({ failureStreak: 1, threshold: 2 }).quarantined).toBe(false);
    expect(deriveQuarantineDecision({ failureStreak: 2, threshold: 2 }).quarantined).toBe(true);
    expect(deriveQuarantineDecision({ failureStreak: 5, threshold: 2 }).quarantined).toBe(true);
  });

  test("the in-memory registry advances the streak, quarantines at the threshold and resets on success", async () => {
    const registry = createInMemorySubstrateRegistry({ threshold: 2 });
    const first = await registry.reportExecutionOutcome({ substrateId: "s1", failed: true });
    expect(first).toEqual({ substrateId: "s1", failureStreak: 1, quarantined: false });
    const second = await registry.reportExecutionOutcome({ substrateId: "s1", failed: true });
    expect(second).toEqual({ substrateId: "s1", failureStreak: 2, quarantined: true });
    const quarantinedProbe = await registry.probe({ substrateId: "s1" });
    expect(quarantinedProbe.ready).toBe(false);
    expect(quarantinedProbe.quarantined).toBe(true);
    expect(quarantinedProbe.reason).toContain("quarantined after 2");
    // A success resets the streak and lifts the quarantine.
    await registry.reportExecutionOutcome({ substrateId: "s1", failed: false });
    const recovered = await registry.probe({ substrateId: "s1" });
    expect(recovered.ready).toBe(true);
    expect(recovered.quarantined).toBe(false);
    expect(registry.streakOf("s1")).toBe(0);
  });

  test("quarantine is per-substrate — a second substrate is unaffected (no cross-propagation)", async () => {
    const registry = createInMemorySubstrateRegistry({ threshold: 2 });
    await registry.reportExecutionOutcome({ substrateId: "hot", failed: true });
    await registry.reportExecutionOutcome({ substrateId: "hot", failed: true });
    const other = await registry.probe({ substrateId: "cold" });
    expect(other.ready).toBe(true);
    expect(registry.isQuarantined("cold")).toBe(false);
    expect(registry.isQuarantined("hot")).toBe(true);
  });

  test("fresh sandbox ids are per-attempt-distinct by construction (a lost sandbox is never reused)", () => {
    const first = deriveFreshSandboxId({ executionId: "exec-1", attempt: 1 });
    const second = deriveFreshSandboxId({ executionId: "exec-1", attempt: 2 });
    expect(first).not.toBe(second);
    expect(first).toBe("exec-1/sandbox/1");
    expect(second).toBe("exec-1/sandbox/2");
    expect(deriveFreshSandboxId({ executionId: "exec-2", attempt: 1 })).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// The bounded substrate executor (the observation race)
// ---------------------------------------------------------------------------

describe("VAL-022 bounded substrate executor", () => {
  test("a never-settling sandbox run is recorded as LOST (the honest absence — no result fabricated)", async () => {
    const neverSettles = createFaultInjectedSubstrate({ scenario: "sandbox-lost-always" });
    const executor = createBoundedSubstrateExecutor({
      seam: neverSettles.seam,
      observationDeadlineMs: 25,
      timer: immediateTimer,
    });
    const outcome = await executor({
      sandboxId: "sbx-1",
      substrateId: "substrate-proc-5",
      task: PROBE_TASK_SPEC,
      limits: PROBE_LIMITS,
    });
    expect(outcome.kind).toBe("lost");
  });

  test("a settled run wins the race and carries the raw observation", async () => {
    const healthy = createFaultInjectedSubstrate({ scenario: "healthy-clean" });
    const executor = createBoundedSubstrateExecutor({
      seam: healthy.seam,
      observationDeadlineMs: 25,
      timer: immediateTimer,
    });
    const outcome = await executor({
      sandboxId: "sbx-1",
      substrateId: "substrate-proc-1",
      task: PROBE_TASK_SPEC,
      limits: PROBE_LIMITS,
    });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind === "settled") {
      expect(outcome.raw.exitCode).toBe(0);
      expect(outcome.raw.settled).toBe(true);
    }
  });

  test("a thrown adapter error settles as adapter-error (the machinery failed — never a loss)", async () => {
    const seam = {
      async probeReadiness() {
        return { ready: true, quarantined: false, reason: null };
      },
      async runInSandbox() {
        throw new Error("runner socket vanished (injected adapter crash)");
      },
    };
    const executor = createBoundedSubstrateExecutor({
      seam,
      observationDeadlineMs: 25,
      timer: immediateTimer,
    });
    const outcome = await executor({
      sandboxId: "sbx-1",
      substrateId: "substrate-throwing",
      task: PROBE_TASK_SPEC,
      limits: PROBE_LIMITS,
    });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind === "settled") {
      const verdict = classifySubstrateRun(outcome.raw);
      expect(verdict.substrateClass).toBe("adapter-error");
    }
  });

  test("the task digest is deterministic and payload-free", () => {
    const digest = substrateTaskDigest(PROBE_TASK_SPEC);
    expect(digest).toBe(substrateTaskDigest({ ...PROBE_TASK_SPEC }));
    expect(substrateTaskDigest({ ...PROBE_TASK_SPEC, args: ["--emit", "different"] })).not.toBe(
      digest,
    );
    expect(digest).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// The execution driver over every offline corpus row
// ---------------------------------------------------------------------------

describe("VAL-022 substrate-readiness driver (the offline corpus)", () => {
  test("every offline row satisfies its oracle: terminal, class, platform fold, attempts, probes, outcomes, quarantine transitions", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const { results } = await driveRow(row);
      expect(results.length, `${row.rowId} executions`).toBe(row.executions.length);
      for (const [executionIndex, result] of results.entries()) {
        const oracle = row.executions[executionIndex];
        if (oracle === undefined) throw new Error("missing oracle");
        const context = `${row.rowId}#${executionIndex + 1}`;
        expect(result.terminal, `${context} terminal`).toBe(oracle.expected.terminal);
        expect(result.totalAttempts, `${context} attempts`).toBe(oracle.expected.attempts);
        expect(result.finalSubstrateClass, `${context} class`).toBe(oracle.expected.substrateClass);
        expect(result.finalPlatformClass, `${context} platform fold`).toBe(
          oracle.expected.platformClass,
        );
        expect(result.probes.length, `${context} probes`).toBe(oracle.expected.readinessProbes);
        expect(result.quarantinedByThisExecution, `${context} quarantine`).toBe(
          oracle.expected.quarantined,
        );
        const outcomes = result.attempts.map((record) => record.outcome);
        expect(outcomes.join(">"), `${context} outcomes`).toBe(
          oracle.expected.attemptOutcomes.join(">"),
        );
        const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
        expect(failedCriteria, `${context} criteria: ${JSON.stringify(failedCriteria)}`).toEqual(
          [],
        );
        expect(result.journaledAttempts, `${context} journal`).toBe(oracle.expected.attempts);
      }
    }
  });

  test("the canonical lifecycle order holds and the planning decision precedes the first dispatch", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const { lifecycle } = await driveRow(row);
      // One planning decision per execution, each between `plan` and
      // that execution's first probe/dispatch, `verify` after the work.
      expect(lifecycle.decisions.length).toBe(row.executions.length);
      for (const decision of lifecycle.decisions) {
        expect(decision.strategyClass).toBe("substrate-readiness-probe");
        expect(decision.provider).toBe("substrate-probe-rail");
        expect(decision.model).toBe("process");
      }
      expect(lifecycle.transitions).toEqual(
        row.executions.flatMap(() => ["authorize", "plan", "queue", "start", "verify"]),
      );
      // Every decision sits AFTER its plan and BEFORE its verify.
      const decisions = lifecycle.eventLog.filter((event) => event === "planning-decision").length;
      const plans = lifecycle.eventLog.filter((event) => event === "transition:plan").length;
      const verifies = lifecycle.eventLog.filter((event) => event === "transition:verify").length;
      expect(decisions).toBe(plans);
      expect(verifies).toBe(plans);
      const firstDecision = lifecycle.eventLog.indexOf("planning-decision");
      const lastVerify = lifecycle.eventLog.lastIndexOf("transition:verify");
      expect(firstDecision).toBeGreaterThan(-1);
      expect(firstDecision).toBeLessThan(lastVerify);
      const firstProbe = lifecycle.eventLog.findIndex((event) => event.startsWith("probe:"));
      expect(firstDecision).toBeLessThan(firstProbe);
    }
  });

  test("readiness gates EVERY dispatch: every attempt's gating probe is ready, ready-probe count equals the dispatch count, no dispatch after a quarantined probe", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const { results } = await driveRow(row);
      for (const [executionIndex, result] of results.entries()) {
        const context = `${row.rowId}#${executionIndex + 1}`;
        for (const record of result.attempts) {
          const gating = result.probes[record.gatingProbe - 1];
          expect(gating, `${context} attempt ${record.attempt} has a gating probe`).toBeDefined();
          expect(gating?.ready, `${context} gating probe ready`).toBe(true);
          expect(gating?.quarantined, `${context} gating probe not quarantined`).toBe(false);
        }
        const readyProbes = result.probes.filter((probe) => probe.ready).length;
        // one ready probe per dispatch (the driver's discipline)
        expect(readyProbes, `${context} ready probes`).toBe(result.totalAttempts);
        // A quarantined probe is never followed by a dispatch.
        for (const [probeIndex, probe] of result.probes.entries()) {
          if (probe.quarantined) {
            const laterAttempt = result.attempts.find(
              (record) => record.gatingProbe > probeIndex + 1,
            );
            expect(laterAttempt, `${context} dispatch after quarantined probe`).toBeUndefined();
            expect(result.totalAttempts, `${context} zero attempts after quarantine`).toBe(0);
          }
        }
      }
    }
  });

  test("every attempt runs in a FRESH sandbox (pairwise-distinct ids — a lost sandbox is never reused)", async () => {
    const row = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "sandbox-lost-exhausted",
    );
    if (row === undefined) throw new Error("missing exhausted row");
    const { lifecycle } = await driveRow(row);
    const ids = lifecycle.attemptRecords.map((record) => record.sandboxId);
    expect(ids.length).toBe(3);
    expect(new Set(ids).size).toBe(3);
    expect(lifecycle.admissions.map((admission) => admission.sandboxId)).toEqual(ids);
  });

  test("a lost sandbox journals NO outcome (the honest absence); settled attempts journal exactly one each", async () => {
    const lostRow = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "sandbox-lost-retry-fresh-recovery",
    );
    if (lostRow === undefined) throw new Error("missing lost-recovery row");
    const { lifecycle, results } = await driveRow(lostRow);
    // attempt 1 lost (no outcome journal); attempt 2 settled (one).
    expect(lifecycle.outcomeRecords.length).toBe(1);
    expect(lifecycle.outcomeRecords[0]?.attempt).toBe(2);
    expect(results[0]?.journaledOutcomes).toBe(1);
    // The exhausted row: three lost attempts, ZERO outcome journals.
    const exhaustedRow = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "sandbox-lost-exhausted",
    );
    if (exhaustedRow === undefined) throw new Error("missing exhausted row");
    const exhausted = await driveRow(exhaustedRow);
    expect(exhausted.lifecycle.outcomeRecords.length).toBe(0);
    expect(exhausted.results[0]?.journaledOutcomes).toBe(0);
  });

  test("readiness-refused rows never dispatch: zero admissions, zero attempts, zero sandbox outcomes", async () => {
    const row = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "readiness-refused-terminal",
    );
    if (row === undefined) throw new Error("missing readiness-refused row");
    const { lifecycle } = await driveRow(row);
    expect(lifecycle.admissions.length).toBe(0);
    expect(lifecycle.attemptRecords.length).toBe(0);
    expect(lifecycle.outcomeRecords.length).toBe(0);
    expect(lifecycle.probeRecords.length).toBe(3);
    for (const probe of lifecycle.probeRecords) {
      expect(probe.ready).toBe(false);
      expect(probe.quarantined).toBe(false);
    }
  });

  test("the bounded retry sleeps a measured backoff per retry (never an unbounded loop)", async () => {
    const row = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "substrate-timeout-classified",
    );
    if (row === undefined) throw new Error("missing timeout row");
    const { sleepCalls, results } = await driveRow(row);
    // 3 attempts → 2 retry backoffs; no readiness backoffs (probes ready).
    expect(sleepCalls.length).toBe(2);
    expect(results[0]?.totalAttempts).toBe(3);
  });

  test("quarantine-on-repeat-failure: the second terminal crosses the threshold (journaled), the third submission is refused at the FIRST probe with ZERO dispatches", async () => {
    const row = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "quarantine-on-repeat-failure",
    );
    if (row === undefined) throw new Error("missing quarantine row");
    const { lifecycle, registry, results } = await driveRow(row);
    expect(results.length).toBe(3);
    // exec 1 + 2: exhausted (3 fresh-sandbox attempts each).
    expect(results[0]?.totalAttempts).toBe(3);
    expect(results[1]?.totalAttempts).toBe(3);
    expect(results[2]?.totalAttempts).toBe(0);
    // exec 2's terminal report quarantined the substrate (ONE journal).
    expect(lifecycle.quarantineRecords.length).toBe(1);
    expect(lifecycle.quarantineRecords[0]?.substrateId).toBe("substrate-quarantine-1");
    expect(lifecycle.quarantineRecords[0]?.failureStreak).toBe(2);
    // exec 3: the FIRST probe is the quarantined refusal.
    const exec3Probes = lifecycle.probeRecords.slice(-1);
    expect(exec3ProbeRefused(exec3Probes)).toBe(true);
    expect(registry.isQuarantined("substrate-quarantine-1")).toBe(true);
    expect(registry.streakOf("substrate-quarantine-1")).toBe(3);
    // The execution after the quarantined one dispatched nothing.
    const admissionsBefore = lifecycle.admissions.length;
    expect(admissionsBefore).toBe(6);
  });

  test("the exhausted rows stay honestly FAILED with every semantics criterion PASSing (the VAL-020 calibration)", async () => {
    for (const rowId of ["sandbox-lost-exhausted", "substrate-timeout-classified"]) {
      const row = OFFLINE_CORPUS_ROWS.find((candidate) => candidate.rowId === rowId);
      if (row === undefined) throw new Error(`missing ${rowId}`);
      const { results } = await driveRow(row);
      const result = results[0];
      if (result === undefined) throw new Error("missing result");
      expect(result.terminal).toBe("FAILED");
      const statuses = result.criteria.map((criterion) => criterion.status);
      expect(statuses.every((status) => status === "PASS")).toBe(true);
      expect(result.criteria.map((criterion) => criterion.criterionId)).toContain("bounded-retry");
    }
  });

  test("recovery rows land COMPLETED with the substrate-failure history journaled exactly once per attempt", async () => {
    for (const rowId of [
      "sandbox-lost-retry-fresh-recovery",
      "readiness-refused-recovery",
      "healthy-clean-run",
    ]) {
      const row = OFFLINE_CORPUS_ROWS.find((candidate) => candidate.rowId === rowId);
      if (row === undefined) throw new Error(`missing ${rowId}`);
      const { results, lifecycle } = await driveRow(row);
      const result = results[0];
      if (result === undefined) throw new Error("missing result");
      expect(result.terminal).toBe("COMPLETED");
      expect(lifecycle.completions[0]?.verdict).toBe("pass");
      // The lost-recovery row journals BOTH attempts (the failure history).
      if (rowId === "sandbox-lost-retry-fresh-recovery") {
        expect(lifecycle.attemptRecords.length).toBe(2);
        expect(lifecycle.attemptRecords[0]?.outcome).toBe("failure");
        expect(lifecycle.attemptRecords[0]?.substrateClass).toBe("sandbox-lost");
        expect(lifecycle.attemptRecords[1]?.outcome).toBe("success");
      }
    }
  });
});

function exec3ProbeRefused(probes: readonly ReadinessProbeRecord[]): boolean {
  const probe = probes[0];
  return probe !== undefined && !probe.ready && probe.quarantined;
}

// ---------------------------------------------------------------------------
// Mechanical criteria against synthetic violations
// ---------------------------------------------------------------------------

/** A synthetic healthy-execution fact base for the violation probes. */
type CriteriaInput = Parameters<typeof deriveSubstrateReadinessCriteria>[0];
type MutableCriteriaInput = { -readonly [K in keyof CriteriaInput]: CriteriaInput[K] };

function syntheticHealthyFacts(): MutableCriteriaInput {
  const oracle: CriteriaInput["groundTruth"] = {
    injectedClass: null,
    injectedRetryable: false,
    expected: {
      substrateClass: null,
      platformClass: null,
      attempts: 1,
      attemptOutcomes: ["success" as const],
      readinessProbes: 1,
      quarantined: false,
      terminal: "COMPLETED" as const,
    },
  };
  const attempts: SubstrateAttemptRecord[] = [
    {
      attempt: 1,
      outcome: "success",
      substrateClass: null,
      platformClass: null,
      retryable: false,
      retried: false,
      latencyMs: 4,
      sandboxId: "exec/sandbox/1",
      gatingProbe: 1,
      taskDigest: "0123abcd",
      exitCode: 0,
      timedOut: false,
      oomKilled: false,
      message: "success",
    },
  ];
  const probes: ReadinessProbeRecord[] = [
    { probe: 1, ready: true, quarantined: false, reason: null },
  ];
  return {
    groundTruth: oracle,
    attempts,
    probes,
    finalVerdict: classifySubstrateRun(healthySubstrateObservation()),
    journaledAttempts: 1,
    journaledOutcomes: 1,
    settledAttempts: 1,
    maxExtraAttempts: 2,
    readinessMaxProbes: 3,
    usageMicroUsd: "1250",
    totalDispatchLatencyMs: 4,
    quarantinedByThisExecution: false,
    failureStreak: 0,
    quarantineThreshold: 2,
  };
}

describe("VAL-022 mechanical criteria (the synthetic-violation catches)", () => {
  const statusOf = (criteria: { criterionId: string; status: string }[], id: string): string => {
    const found = criteria.find((criterion) => criterion.criterionId === id);
    if (found === undefined) throw new Error(`missing criterion ${id}`);
    return found.status;
  };

  test("a reused sandbox id across attempts FAILs the fresh-sandbox criterion", () => {
    const facts = syntheticHealthyFacts();
    const base = facts.attempts[0];
    if (base === undefined) throw new Error("missing base attempt");
    facts.attempts = [
      {
        ...base,
        attempt: 1,
        outcome: "failure",
        substrateClass: "sandbox-lost",
        platformClass: "runtime-unavailable",
        retryable: true,
        retried: true,
      },
      { ...base, attempt: 2, sandboxId: "exec/sandbox/1" },
    ];
    const criteria = deriveSubstrateReadinessCriteria(facts);
    expect(statusOf(criteria, "fresh-sandbox-per-attempt")).toBe("FAIL");
  });

  test("a dispatch gated by a REFUSED probe FAILs the readiness gate (dispatch-to-unready)", () => {
    const facts = syntheticHealthyFacts();
    facts.probes = [{ probe: 1, ready: false, quarantined: false, reason: "down" }];
    const criteria = deriveSubstrateReadinessCriteria(facts);
    expect(statusOf(criteria, "readiness-gates-dispatch")).toBe("FAIL");
  });

  test("a dispatch after a QUARANTINED probe FAILs the readiness gate (quarantine bypass)", () => {
    const facts = syntheticHealthyFacts();
    facts.probes = [
      { probe: 1, ready: true, quarantined: false, reason: null },
      { probe: 2, ready: false, quarantined: true, reason: "quarantined after 2" },
    ];
    const base = facts.attempts[0];
    if (base === undefined) throw new Error("missing base attempt");
    facts.attempts = [{ ...base, gatingProbe: 2 }];
    const criteria = deriveSubstrateReadinessCriteria(facts);
    expect(statusOf(criteria, "readiness-gates-dispatch")).toBe("FAIL");
  });

  test("a misattributed OOM (a timeout verdict against the OOM oracle) FAILS class + platform fold + retry classification", () => {
    const facts = syntheticHealthyFacts();
    facts.groundTruth = {
      injectedClass: "resource-exhausted",
      injectedRetryable: false,
      expected: {
        substrateClass: "resource-exhausted",
        platformClass: "sandbox-execution",
        attempts: 1,
        attemptOutcomes: ["failure"],
        readinessProbes: 1,
        quarantined: false,
        terminal: "FAILED",
      },
    };
    const base = facts.attempts[0];
    if (base === undefined) throw new Error("missing base attempt");
    facts.attempts = [
      {
        ...base,
        outcome: "failure",
        substrateClass: "substrate-timeout",
        platformClass: "timeout",
        retryable: true,
        timedOut: true,
        exitCode: 137,
      },
    ];
    facts.finalVerdict = classifySubstrateRun(PROCESS_DEADLINE_KILL_SHAPE);
    const criteria = deriveSubstrateReadinessCriteria(facts);
    expect(statusOf(criteria, "substrate-class")).toBe("FAIL");
    expect(statusOf(criteria, "platform-class-fold")).toBe("FAIL");
    expect(statusOf(criteria, "retry-classification")).toBe("FAIL");
  });

  test("an OOM history with retries FAILS the bounded-retry criterion (non-retryable classes never retry)", () => {
    const facts = syntheticHealthyFacts();
    facts.groundTruth = {
      injectedClass: "resource-exhausted",
      injectedRetryable: false,
      expected: {
        substrateClass: "resource-exhausted",
        platformClass: "sandbox-execution",
        attempts: 3,
        attemptOutcomes: ["failure", "failure", "failure"],
        readinessProbes: 3,
        quarantined: false,
        terminal: "FAILED",
      },
    };
    facts.attempts = [1, 2, 3].map((attempt) => ({
      attempt,
      outcome: "failure" as const,
      substrateClass: "resource-exhausted" as SubstrateFailureClass,
      platformClass: "sandbox-execution" as const,
      retryable: false,
      retried: attempt < 3,
      latencyMs: 4,
      sandboxId: `exec/sandbox/${attempt}`,
      gatingProbe: attempt,
      taskDigest: "0123abcd",
      exitCode: 137,
      timedOut: false,
      oomKilled: true,
      message: "oom",
    }));
    facts.probes = [1, 2, 3].map((probe) => ({
      probe,
      ready: true,
      quarantined: false,
      reason: null,
    }));
    facts.finalVerdict = classifySubstrateRun(CONTAINER_OOMKILLED_SHAPE);
    const criteria = deriveSubstrateReadinessCriteria(facts);
    expect(statusOf(criteria, "bounded-retry")).toBe("FAIL");
  });

  test("a journal count mismatch FAILS the journal-exactly-once criterion", () => {
    const facts = syntheticHealthyFacts();
    facts.journaledAttempts = 2;
    const criteria = deriveSubstrateReadinessCriteria(facts);
    expect(statusOf(criteria, "journal-exactly-once-per-attempt")).toBe("FAIL");
  });

  test("a fabricated outcome for a LOST sandbox FAILS the honest-outcome-journal criterion", () => {
    const facts = syntheticHealthyFacts();
    facts.journaledOutcomes = 1;
    facts.settledAttempts = 0;
    const criteria = deriveSubstrateReadinessCriteria(facts);
    expect(statusOf(criteria, "honest-outcome-journal")).toBe("FAIL");
  });

  test("a premature quarantine FAILS the quarantine-contract criterion", () => {
    const facts = syntheticHealthyFacts();
    facts.quarantinedByThisExecution = true;
    facts.failureStreak = 1;
    const criteria = deriveSubstrateReadinessCriteria(facts);
    expect(statusOf(criteria, "quarantine-contract")).toBe("FAIL");
  });

  test("a fabricated COMPLETED (a success verdict against a FAILED oracle) FAILS the outcome contract", () => {
    const facts = syntheticHealthyFacts();
    facts.groundTruth = {
      ...facts.groundTruth,
      expected: { ...facts.groundTruth.expected, terminal: "FAILED" },
    };
    const criteria = deriveSubstrateReadinessCriteria(facts);
    expect(statusOf(criteria, "outcome-contract")).toBe("FAIL");
  });

  test("the healthy fact base passes every criterion", () => {
    const criteria = deriveSubstrateReadinessCriteria(syntheticHealthyFacts());
    expect(criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });
});
