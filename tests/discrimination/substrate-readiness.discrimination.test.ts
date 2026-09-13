/**
 * VAL-022 acceptance criterion 6 — discrimination tests proving the
 * substrate-readiness semantics against controlled fakes:
 *
 *   * readiness lies — a substrate whose probe claims ready while its
 *     sandboxes never settle fails HONESTLY (bounded exhaustion, the
 *     sandbox-lost attribution) and the lying substrate is eventually
 *     QUARANTINED (bounded termination — never an infinite dispatch);
 *     a forged journal claiming a dispatch with no ready probe FAILS
 *     the readiness-gate criterion mechanically;
 *   * quarantine bypass — a gate that IGNORES the registry and
 *     dispatches to a quarantined substrate is caught by the criteria
 *     (attempt-count / readiness-gates FAIL against the
 *     zero-dispatch oracle); a registry that quarantines PREMATURELY
 *     (threshold 1 against the pinned 2) is caught by the
 *     quarantine-contract criterion;
 *   * dispatch-to-unready — a synthetic attempt gated by a REFUSED
 *     probe FAILS the readiness-gate criterion; the real driver
 *     produces zero dispatches on the refused substrate (the
 *     never-dispatch-to-unready discipline proven positively);
 *   * misattributed OOM-vs-timeout — the marker shapes discriminate:
 *     a 137 with the deadline marker is NEVER the OOM class and a 137
 *     with the OOM marker is NEVER the timeout class; a
 *     mis-signaling substrate FAILS the oracle mechanically (class +
 *     retry classification + bounded-retry).
 */

import { describe, expect, test } from "vitest";
import {
  CORPUS_QUARANTINE_THRESHOLD,
  CORPUS_READINESS_POLICY,
  CORPUS_RETRY_POLICY,
  OFFLINE_CORPUS_ROWS,
} from "../../benchmarks/validation/apps/substrate-failure/corpus";
import { createFaultInjectedSubstrate } from "../../benchmarks/validation/apps/substrate-failure/fixtures";
import {
  bindReadinessGate,
  bindSubstrateRun,
  CONTAINER_OOMKILLED_SHAPE,
  type ComputeSubstrateSeam,
  classifySubstrateRun,
  createBoundedSubstrateExecutor,
  createInMemorySubstrateRegistry,
  deriveSubstrateReadinessCriteria,
  driveSubstrateReadinessExecution,
  PROCESS_DEADLINE_KILL_SHAPE,
  type SubstrateAttemptRecord,
  type SubstrateExecutionOracle,
  type SubstrateReadinessLifecyclePort,
} from "../../benchmarks/validation/platform/substrate-readiness";

const noSleep = async () => {};
const immediateTimer = async () => {};
const pinnedClock = () => 1_000;
const PROBE_TASK_SPEC = { command: "probe-worker", args: ["--emit", "substrate-ok"], env: {} };
const PROBE_LIMITS = { cpuMilliCores: 500, memoryMiB: 256, executionTimeoutMs: 5_000 };

/** The always-open gate that IGNORES the registry (the bypass fake). */
function createBypassingGate(): {
  readonly probe: (input: { readonly substrateId: string }) => Promise<{
    ready: boolean;
    quarantined: boolean;
    reason: string | null;
  }>;
  readonly consultedRegistry: boolean;
} {
  return {
    probe: async () => ({ ready: true, quarantined: false, reason: null }),
    consultedRegistry: false,
  };
}

function createFakeLifecycle(): SubstrateReadinessLifecyclePort {
  return {
    async transition() {},
    async recordPlanningDecision() {},
    async recordReadinessProbe() {},
    async recordSandboxAdmission() {},
    async recordDispatchAttempt() {},
    async recordSandboxOutcome() {},
    async recordQuarantine() {},
    async complete() {},
  };
}

/** The lying substrate: probe always ready, runs never settle. */
function createLyingSubstrate(): ComputeSubstrateSeam {
  return {
    async probeReadiness() {
      return { ready: true, quarantined: false, reason: null };
    },
    async runInSandbox() {
      return new Promise(() => {});
    },
  };
}

/** Drive one execution with fully custom seams (the discrimination rig). */
async function driveOne(options: {
  readonly executionId: string;
  readonly groundTruth: SubstrateExecutionOracle;
  readonly substrateId: string;
  readonly seam: ComputeSubstrateSeam;
  readonly registry: ReturnType<typeof createInMemorySubstrateRegistry>;
  readonly gate?: (input: { readonly substrateId: string }) => Promise<{
    ready: boolean;
    quarantined: boolean;
    reason: string | null;
  }>;
  readonly observationDeadlineMs?: number;
}): Promise<Awaited<ReturnType<typeof driveSubstrateReadinessExecution>>> {
  const lifecycle = createFakeLifecycle();
  const executor = createBoundedSubstrateExecutor({
    seam: options.seam,
    observationDeadlineMs: options.observationDeadlineMs ?? 25,
    timer: immediateTimer,
  });
  const probe =
    options.gate ?? bindReadinessGate({ registry: options.registry, seam: options.seam });
  const run = bindSubstrateRun({
    executor,
    substrateId: options.substrateId,
    task: PROBE_TASK_SPEC,
    limits: PROBE_LIMITS,
  });
  return driveSubstrateReadinessExecution({
    executionId: options.executionId,
    task: { kind: "substrate-probe", input: { scenario: "discrimination" } },
    groundTruth: options.groundTruth,
    substrateId: options.substrateId,
    taskSpec: PROBE_TASK_SPEC,
    limits: PROBE_LIMITS,
    provider: "substrate-probe-rail",
    model: "process",
    lifecycle,
    run,
    probe,
    report: (input) => options.registry.reportExecutionOutcome(input),
    retry: {
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      backoffMs: 1,
      sleep: noSleep,
    },
    readiness: {
      maxProbes: CORPUS_READINESS_POLICY.maxProbes,
      backoffMs: 1,
      sleep: noSleep,
    },
    quarantineThreshold: CORPUS_QUARANTINE_THRESHOLD,
    now: pinnedClock,
  });
}

const exhaustedOracle: SubstrateExecutionOracle = {
  injectedClass: "sandbox-lost",
  injectedRetryable: true,
  expected: {
    substrateClass: "sandbox-lost",
    platformClass: "runtime-unavailable",
    attempts: 3,
    attemptOutcomes: ["failure", "failure", "failure"],
    readinessProbes: 3,
    quarantined: false,
    terminal: "FAILED",
  },
};

describe("VAL-022 discrimination — readiness lies", () => {
  test("a substrate that claims ready while its sandboxes never settle fails honestly and is eventually quarantined (bounded termination)", async () => {
    const registry = createInMemorySubstrateRegistry({
      threshold: CORPUS_QUARANTINE_THRESHOLD,
    });
    const lying = createLyingSubstrate();
    // execution 1: bounded exhaustion, honest FAILED.
    const first = await driveOne({
      executionId: "lying-exec-1",
      groundTruth: exhaustedOracle,
      substrateId: "substrate-lying",
      seam: lying,
      registry,
    });
    expect(first.terminal).toBe("FAILED");
    expect(first.totalAttempts).toBe(3);
    expect(first.finalSubstrateClass).toBe("sandbox-lost");
    expect(first.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    // execution 2: the streak crosses the threshold — quarantined.
    const second = await driveOne({
      executionId: "lying-exec-2",
      groundTruth: {
        ...exhaustedOracle,
        expected: { ...exhaustedOracle.expected, quarantined: true },
      },
      substrateId: "substrate-lying",
      seam: lying,
      registry,
    });
    expect(second.quarantinedByThisExecution).toBe(true);
    // execution 3: refused at the FIRST probe — ZERO dispatches; the
    // lying substrate never receives another sandbox to lose.
    const third = await driveOne({
      executionId: "lying-exec-3",
      groundTruth: {
        injectedClass: "readiness-refused",
        injectedRetryable: false,
        expected: {
          substrateClass: "readiness-refused",
          platformClass: "runtime-unavailable",
          attempts: 0,
          attemptOutcomes: [],
          readinessProbes: 1,
          quarantined: false,
          terminal: "FAILED",
        },
      },
      substrateId: "substrate-lying",
      seam: lying,
      registry,
    });
    expect(third.totalAttempts).toBe(0);
    expect(third.probes.length).toBe(1);
    expect(third.probes[0]?.quarantined).toBe(true);
    expect(third.terminal).toBe("FAILED");
    expect(third.finalSubstrateClass).toBe("readiness-refused");
  });

  test("a forged journal claiming a dispatch with NO gating probe FAILS the readiness-gate criterion", () => {
    const criteria = deriveSubstrateReadinessCriteria({
      groundTruth: exhaustedOracle,
      attempts: [syntheticAttempt({ attempt: 1, gatingProbe: 1, substrateClass: "sandbox-lost" })],
      probes: [],
      finalVerdict: classifySubstrateRun({
        settled: false,
        timedOut: false,
        oomKilled: false,
        exitCode: null,
        stdoutDigest: null,
        durationMs: null,
        usageMicroUsd: null,
        adapterError: null,
      }),
      journaledAttempts: 1,
      journaledOutcomes: 0,
      settledAttempts: 0,
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      readinessMaxProbes: CORPUS_READINESS_POLICY.maxProbes,
      usageMicroUsd: null,
      totalDispatchLatencyMs: 0,
      quarantinedByThisExecution: false,
      failureStreak: 1,
      quarantineThreshold: CORPUS_QUARANTINE_THRESHOLD,
    });
    const gate = criteria.find((criterion) => criterion.criterionId === "readiness-gates-dispatch");
    expect(gate?.status).toBe("FAIL");
  });
});

describe("VAL-022 discrimination — quarantine bypass", () => {
  test("a gate that IGNORES the quarantine registry dispatches to the quarantined substrate and is caught by the criteria", async () => {
    const registry = createInMemorySubstrateRegistry({
      threshold: CORPUS_QUARANTINE_THRESHOLD,
    });
    const seam = createFaultInjectedSubstrate({ scenario: "sandbox-lost-always" }).seam;
    // Two failing executions quarantine the substrate.
    await driveOne({
      executionId: "bypass-exec-1",
      groundTruth: exhaustedOracle,
      substrateId: "substrate-bypass",
      seam,
      registry,
    });
    await driveOne({
      executionId: "bypass-exec-2",
      groundTruth: {
        ...exhaustedOracle,
        expected: { ...exhaustedOracle.expected, quarantined: true },
      },
      substrateId: "substrate-bypass",
      seam,
      registry,
    });
    expect(registry.isQuarantined("substrate-bypass")).toBe(true);
    // The third submission, driven through the BYPASSING gate
    // (registry ignored): the substrate IS quarantined but the rogue
    // gate answers ready — the dispatch happens and the criteria FAIL
    // against the zero-dispatch oracle (the mechanical catch).
    const bypassing = createBypassingGate();
    const third = await driveOne({
      executionId: "bypass-exec-3",
      groundTruth: {
        injectedClass: "readiness-refused",
        injectedRetryable: false,
        expected: {
          substrateClass: "readiness-refused",
          platformClass: "runtime-unavailable",
          attempts: 0,
          attemptOutcomes: [],
          readinessProbes: 1,
          quarantined: false,
          terminal: "FAILED",
        },
      },
      substrateId: "substrate-bypass",
      seam,
      registry,
      gate: bypassing.probe,
    });
    expect(third.totalAttempts).toBe(3); // the bypass actually dispatched
    const failedCriteria = third.criteria.filter((criterion) => criterion.status === "FAIL");
    const failedIds = failedCriteria.map((criterion) => criterion.criterionId);
    expect(failedIds).toContain("attempt-count");
    expect(failedIds).toContain("readiness-gates-dispatch");
    expect(failedIds).toContain("recovery-outcome-sequence");
    // The terminal is honestly FAILED either way — never a fabricated pass.
    expect(third.terminal).toBe("FAILED");
  });

  test("a registry that quarantines PREMATURELY (threshold 1 against the pinned 2) is caught by the quarantine-contract criterion", async () => {
    const rogueRegistry = createInMemorySubstrateRegistry({ threshold: 1 });
    const seam = createFaultInjectedSubstrate({ scenario: "sandbox-lost-always" }).seam;
    const first = await driveOne({
      executionId: "premature-exec-1",
      groundTruth: exhaustedOracle,
      substrateId: "substrate-premature",
      seam,
      registry: rogueRegistry,
    });
    // The oracle pins NO quarantine at streak 1; the rogue registry
    // quarantined — the quarantine-contract criterion FAILS.
    const quarantine = first.criteria.find(
      (criterion) => criterion.criterionId === "quarantine-contract",
    );
    expect(quarantine?.status).toBe("FAIL");
    expect(first.quarantinedByThisExecution).toBe(true);
    expect(first.terminal).toBe("FAILED");
  });
});

describe("VAL-022 discrimination — dispatch-to-unready", () => {
  test("a synthetic attempt gated by a REFUSED probe FAILS the readiness-gate criterion (the unready dispatch caught)", () => {
    const criteria = deriveSubstrateReadinessCriteria({
      groundTruth: exhaustedOracle,
      attempts: [syntheticAttempt({ attempt: 1, gatingProbe: 1, substrateClass: "sandbox-lost" })],
      probes: [{ probe: 1, ready: false, quarantined: false, reason: "substrate down" }],
      finalVerdict: classifySubstrateRun({
        settled: false,
        timedOut: false,
        oomKilled: false,
        exitCode: null,
        stdoutDigest: null,
        durationMs: null,
        usageMicroUsd: null,
        adapterError: null,
      }),
      journaledAttempts: 1,
      journaledOutcomes: 0,
      settledAttempts: 0,
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      readinessMaxProbes: CORPUS_READINESS_POLICY.maxProbes,
      usageMicroUsd: null,
      totalDispatchLatencyMs: 0,
      quarantinedByThisExecution: false,
      failureStreak: 1,
      quarantineThreshold: CORPUS_QUARANTINE_THRESHOLD,
    });
    const gate = criteria.find((criterion) => criterion.criterionId === "readiness-gates-dispatch");
    expect(gate?.status).toBe("FAIL");
  });

  test("the REAL driver never dispatches to the unready substrate (the positive proof: zero admissions on the refused row)", async () => {
    const row = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "readiness-refused-terminal",
    );
    if (row === undefined) throw new Error("missing readiness-refused row");
    const registry = createInMemorySubstrateRegistry({
      threshold: CORPUS_QUARANTINE_THRESHOLD,
    });
    const { seam } = createFaultInjectedSubstrate({ scenario: "readiness-refused-forever" });
    const oracle = row.executions[0];
    if (oracle === undefined) throw new Error("missing refused-row oracle");
    const result = await driveOne({
      executionId: "unready-exec-1",
      groundTruth: oracle,
      substrateId: "substrate-proc-2",
      seam,
      registry,
    });
    expect(result.totalAttempts).toBe(0);
    expect(result.probes.length).toBe(3);
    expect(result.probes.every((probe) => !probe.ready)).toBe(true);
    expect(result.finalSubstrateClass).toBe("readiness-refused");
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });
});

describe("VAL-022 discrimination — misattributed OOM-vs-timeout", () => {
  test("the marker shapes discriminate: 137+timedOut is the timeout class; 137+oomKilled is the OOM class; neither reads as the other", () => {
    const deadlineKill = classifySubstrateRun(PROCESS_DEADLINE_KILL_SHAPE);
    const oomKill = classifySubstrateRun(CONTAINER_OOMKILLED_SHAPE);
    expect(deadlineKill.substrateClass).toBe("substrate-timeout");
    expect(deadlineKill.retryable).toBe(true);
    expect(deadlineKill.platformClass).toBe("timeout");
    expect(oomKill.substrateClass).toBe("resource-exhausted");
    expect(oomKill.retryable).toBe(false);
    expect(oomKill.platformClass).toBe("sandbox-execution");
    // The retryability difference is the policy seam: only the
    // timeout class is retried (a misreading that retried OOMs would
    // exhaust the same memory again).
  });

  test("a mis-signaling substrate (the OOM shape carrying the deadline marker) FAILS the OOM oracle mechanically", async () => {
    const registry = createInMemorySubstrateRegistry({
      threshold: CORPUS_QUARANTINE_THRESHOLD,
    });
    const oomOracle: SubstrateExecutionOracle = {
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
    // The mis-signaling seam: the OOMKilled shape but with the
    // deadline marker SET (a substrate that mis-reports its kill).
    const misSignaling: ComputeSubstrateSeam = {
      async probeReadiness() {
        return { ready: true, quarantined: false, reason: null };
      },
      async runInSandbox() {
        return { ...CONTAINER_OOMKILLED_SHAPE, timedOut: true };
      },
    };
    const result = await driveOne({
      executionId: "mismatched-oom-1",
      groundTruth: oomOracle,
      substrateId: "substrate-mis-signal",
      seam: misSignaling,
      registry,
    });
    // The deadline marker wins the classification (substrate-timeout),
    // which FAILS the OOM oracle's class/fold/retry criteria.
    expect(result.finalSubstrateClass).toBe("substrate-timeout");
    const failedIds = result.criteria
      .filter((criterion) => criterion.status === "FAIL")
      .map((criterion) => criterion.criterionId);
    expect(failedIds).toContain("substrate-class");
    expect(failedIds).toContain("platform-class-fold");
    expect(failedIds).toContain("retry-classification");
    expect(failedIds).toContain("attempt-count");
    expect(result.terminal).toBe("FAILED");
  });

  test("the correctly-signaled OOM shape PASSES its oracle (the discrimination is the marker, not the exit code)", async () => {
    const registry = createInMemorySubstrateRegistry({
      threshold: CORPUS_QUARANTINE_THRESHOLD,
    });
    const row = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "resource-exhausted-oom",
    );
    if (row === undefined) throw new Error("missing OOM row");
    const { seam } = createFaultInjectedSubstrate({ scenario: "resource-exhausted-oom" });
    const oracle = row.executions[0];
    if (oracle === undefined) throw new Error("missing OOM-row oracle");
    const result = await driveOne({
      executionId: "oom-1",
      groundTruth: oracle,
      substrateId: "substrate-proc-7",
      seam,
      registry,
    });
    expect(result.finalSubstrateClass).toBe("resource-exhausted");
    expect(result.totalAttempts).toBe(1);
    expect(result.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    expect(result.terminal).toBe("FAILED");
  });
});

/** A synthetic attempt record for the criteria-violation probes. */
function syntheticAttempt(overrides: {
  readonly attempt: number;
  readonly gatingProbe: number;
  readonly substrateClass: "sandbox-lost" | "substrate-timeout" | "resource-exhausted";
}): SubstrateAttemptRecord {
  const retryable = overrides.substrateClass !== "resource-exhausted";
  const platformClass =
    overrides.substrateClass === "substrate-timeout" ? "timeout" : "runtime-unavailable";
  return {
    attempt: overrides.attempt,
    outcome: "failure",
    substrateClass: overrides.substrateClass,
    platformClass,
    retryable,
    retried: false,
    latencyMs: 4,
    sandboxId: `exec/sandbox/${overrides.attempt}`,
    gatingProbe: overrides.gatingProbe,
    taskDigest: "0123abcd",
    exitCode: null,
    timedOut: overrides.substrateClass === "substrate-timeout",
    oomKilled: overrides.substrateClass === "resource-exhausted",
    message: "synthetic",
  };
}
