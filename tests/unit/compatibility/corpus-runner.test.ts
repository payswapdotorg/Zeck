/**
 * PPR-018A — the reusable corpus runner tests (scope item 4).
 *
 * Pins over a TEST driver + an in-memory trace source (the same
 * seam-shape the sibling application proofs bind):
 *  - unpinned execution is REFUSED (driver pins AND session descriptor
 *    are both verified — the impossibility);
 *  - every corpus task runs through the pinned session and every
 *    delegated edge execution is correlated through the trace source;
 *  - IMPOSSIBILITY (missing trace correlation): an execution the trace
 *    source cannot read back records an honest found=false fact and
 *    can never support certification (the assembled record derives
 *    below COMPLETE with the named rule-4 defect);
 *  - the run-level outcomes derive (PASS / FAIL / NOT-RUN / BLOCKED /
 *    BYPASS_DETECTED) and the aggregated egress observation is honest;
 *  - the measurement builder produces all thirteen dimensions with
 *    measured facts where the run measured them;
 *  - the evidence assembly produces a STRUCTURALLY VALID record whose
 *    derived status follows its facts (never asserted).
 */

import { describe, expect, test } from "vitest";
import {
  aggregateEgressObservation,
  CorpusRunnerError,
  runCorpus,
} from "../../../compat/harness/corpus-runner";
import { evidenceRecordDraftOf } from "../../../compat/harness/evidence-assembly";
import { measurementSetOf } from "../../../compat/harness/measurement";
import {
  createRuntimeRegistry,
  evaluateCompatibility,
  type PinnedRuntimeDriver,
  type PinnedRuntimeSession,
  type RuntimeBinding,
  type TaskRunOutcome,
  type TraceRead,
  type ZeckTraceSource,
} from "../../../src/integrations/compatibility/public";

const APP_ID = "00000000-0000-7000-8000-0000000000c9";
const PIN = { upstreamRevision: "a".repeat(40), integrationRevision: "b".repeat(40) };
const EXPECTED: RuntimeBinding = { applicationId: APP_ID, pin: PIN };
const NOW = "2026-09-27T00:00:00Z";

const CORPUS = [
  { taskId: "implement-function", title: "Implement", instruction: "implement the function" },
  { taskId: "fix-bug", title: "Fix", instruction: "fix the bug" },
];

/** A correlated COMPLETED read (the executions authority's completion binding). */
function completedRead(): TraceRead {
  return {
    execution: { id: "exec", applicationId: APP_ID, status: "COMPLETED", terminal: true },
    events: [
      { eventId: "e1", sequence: 1, type: "execution.created" },
      { eventId: "e2", sequence: 2, type: "planning.decision-recorded" },
      { eventId: "e3", sequence: 3, type: "execution.completed" },
    ],
    verification: [{ id: "v1", status: "PASS" }],
    route: { provider: "neutral-provider", model: "neutral-model", strategyClass: "hybrid" },
    costMicroUsd: "4180000",
    usage: { inputTokens: 120, outputTokens: 80 },
  };
}

/** Build a test session over scripted task outcomes. */
function sessionOf(
  descriptor: { runtimeId: string; applicationId: string; pin: typeof PIN },
  taskOutcomes: readonly TaskRunOutcome[],
  environmentFacts: PinnedRuntimeSession["environmentFacts"] = [],
): PinnedRuntimeSession {
  let index = 0;
  return {
    descriptor: { ...descriptor, startedAt: NOW },
    environmentFacts,
    async executeTask() {
      const outcome = taskOutcomes[index] ?? taskOutcomes[taskOutcomes.length - 1];
      index += 1;
      if (outcome === undefined) {
        throw new Error("no scripted outcome");
      }
      return outcome;
    },
    async stop() {},
  };
}

/** Build a test driver over scripted sessions. */
function driverOf(
  pin: typeof PIN,
  session: (context: { readonly runCorrelationId: string }) => PinnedRuntimeSession,
): PinnedRuntimeDriver {
  return {
    runtimeId: "compat/test-app",
    identity: {
      name: "Test app",
      repository: "https://example.invalid/app",
      applicationId: APP_ID,
    },
    pin,
    start: async (context) => session(context),
  };
}

/** A trace source over a map of executionId → read (misses read back not-found). */
function traceSourceOf(reads: Readonly<Record<string, TraceRead>>): ZeckTraceSource {
  return {
    async readExecutionTrace(_applicationId, executionId) {
      return (
        reads[executionId] ?? {
          execution: null,
          events: [],
          verification: [],
          route: null,
          costMicroUsd: null,
          usage: null,
        }
      );
    },
  };
}

function taskOutcome(taskId: string, patch: Partial<TaskRunOutcome> = {}): TaskRunOutcome {
  return {
    taskId,
    succeeded: true,
    detail: `${taskId} resolved`,
    durationMs: 1500,
    edgeExecutions: [
      {
        edgeId: "main-completion",
        executionId: `exec-${taskId}`,
        outcome: "resolved",
        latencyMs: 1200,
        usage: { inputTokens: 120, outputTokens: 80 },
        costMicroUsd: "4180000",
      },
    ],
    failureCount: 0,
    retryCount: 0,
    egressObservation: { mode: "deny", status: "observed-clean", violations: [] },
    unavailable: null,
    ...patch,
  };
}

describe("the corpus runner (fail-closed pinning)", () => {
  test("IMPOSSIBILITY (unpinned execution): a driver with the wrong pins is refused", async () => {
    await expect(
      runCorpus({
        driver: driverOf({ ...PIN, upstreamRevision: "c".repeat(40) }, () =>
          sessionOf({ runtimeId: "compat/test-app", applicationId: APP_ID, pin: PIN }, []),
        ),
        expected: EXPECTED,
        corpus: CORPUS,
        traceSource: traceSourceOf({}),
        now: () => NOW,
      }),
    ).rejects.toThrow(CorpusRunnerError);
  });

  test("IMPOSSIBILITY (unpinned execution): a session whose own descriptor mismatches is refused", async () => {
    await expect(
      runCorpus({
        driver: driverOf(PIN, () =>
          sessionOf(
            {
              runtimeId: "compat/test-app",
              applicationId: APP_ID,
              pin: { ...PIN, integrationRevision: "z".repeat(40) },
            },
            [],
          ),
        ),
        expected: EXPECTED,
        corpus: CORPUS,
        traceSource: traceSourceOf({}),
        now: () => NOW,
      }),
    ).rejects.toThrow(/unpinned application execution refused/);
  });
});

describe("the corpus runner (correlation + outcomes)", () => {
  test("every task runs and every delegated edge correlates through the trace source", async () => {
    const report = await runCorpus({
      driver: driverOf(PIN, () =>
        sessionOf(
          { runtimeId: "compat/test-app", applicationId: APP_ID, pin: PIN },
          CORPUS.map((task) => taskOutcome(task.taskId)),
        ),
      ),
      expected: EXPECTED,
      corpus: CORPUS,
      traceSource: traceSourceOf({
        "exec-implement-function": completedRead(),
        "exec-fix-bug": completedRead(),
      }),
      now: () => NOW,
    });
    expect(report.runOutcomes).toEqual([
      { taskId: "implement-function", outcome: "PASS" },
      { taskId: "fix-bug", outcome: "PASS" },
    ]);
    expect(report.taskReports).toHaveLength(2);
    for (const taskReport of report.taskReports) {
      expect(taskReport.traces).toHaveLength(1);
      expect(taskReport.traces[0]?.correlated).toBe(true);
      expect(taskReport.traces[0]?.status).toBe("COMPLETED");
      expect(taskReport.traces[0]?.passingVerificationCount).toBe(1);
    }
    expect(report.egressObservation).toEqual({
      mode: "deny",
      status: "observed-clean",
      violations: [],
    });
    expect(report.credentialErasure?.erased).toBe(true);
    expect(report.runtime.pin).toEqual(PIN);
  });

  test("IMPOSSIBILITY (missing trace correlation): a miss reads back honestly and forbids certification", async () => {
    const report = await runCorpus({
      driver: driverOf(PIN, () =>
        sessionOf({ runtimeId: "compat/test-app", applicationId: APP_ID, pin: PIN }, [
          taskOutcome("implement-function"),
        ]),
      ),
      expected: EXPECTED,
      corpus: [CORPUS[0] as { taskId: string; title: string; instruction: string }],
      // The trace source has NO read for the execution: an honest miss.
      traceSource: traceSourceOf({}),
      now: () => NOW,
    });
    const trace = report.taskReports[0]?.traces[0];
    expect(trace?.found).toBe(false);
    expect(trace?.correlated).toBe(false);

    // The assembled record derives BELOW complete with the named defect.
    const record = evidenceRecordDraftOf({
      recordId: "runner-missing-correlation-record",
      pinnedApplication: {
        identity: {
          name: "Test app",
          repository: "https://example.invalid/app",
          applicationId: APP_ID,
        },
        pin: PIN,
      },
      graph: {
        edges: [
          {
            edgeId: "main-completion",
            component: "chat loop",
            surface: "text-generation",
            transport: "client",
            externalExecution: "provider model",
            materiality: "the main call",
          },
        ],
      },
      report,
    });
    const assessment = evaluateCompatibility(record);
    expect(assessment.status).not.toBe("AI_EXECUTION_COMPLETE");
    expect(assessment.findings.some((finding) => finding.code === "ZECK_TRACE_NOT_FOUND")).toBe(
      true,
    );
  });

  test("a FAILED task derives FAIL and the assembled corpus usability is not-verified", async () => {
    const report = await runCorpus({
      driver: driverOf(PIN, () =>
        sessionOf({ runtimeId: "compat/test-app", applicationId: APP_ID, pin: PIN }, [
          taskOutcome("implement-function", { succeeded: false, detail: "the check failed" }),
        ]),
      ),
      expected: EXPECTED,
      corpus: [CORPUS[0] as { taskId: string; title: string; instruction: string }],
      traceSource: traceSourceOf({ "exec-implement-function": completedRead() }),
      now: () => NOW,
    });
    expect(report.runOutcomes[0]?.outcome).toBe("FAIL");
    const record = evidenceRecordDraftOf({
      recordId: "runner-fail-record",
      pinnedApplication: {
        identity: {
          name: "Test app",
          repository: "https://example.invalid/app",
          applicationId: APP_ID,
        },
        pin: PIN,
      },
      graph: {
        edges: [
          {
            edgeId: "main-completion",
            component: "loop",
            surface: "text-generation",
            transport: "client",
            externalExecution: "provider",
            materiality: "main",
          },
        ],
      },
      report,
    });
    expect(record.runtimeEvidence.corpusUsability).toBe("not-verified");
    expect(evaluateCompatibility(record).status).not.toBe("AI_EXECUTION_COMPLETE");
  });

  test("an unavailable run derives NOT-RUN/BLOCKED and a bypass observation derives BYPASS_DETECTED", async () => {
    const unavailable = await runCorpus({
      driver: driverOf(PIN, () =>
        sessionOf({ runtimeId: "compat/test-app", applicationId: APP_ID, pin: PIN }, [
          taskOutcome("implement-function", {
            succeeded: null,
            unavailable: {
              outcome: "NOT-RUN",
              cause: "credentials unavailable",
              owner: "provider",
            },
          }),
        ]),
      ),
      expected: EXPECTED,
      corpus: [CORPUS[0] as { taskId: string; title: string; instruction: string }],
      traceSource: traceSourceOf({}),
      now: () => NOW,
    });
    expect(unavailable.runOutcomes[0]?.outcome).toBe("NOT-RUN");

    const bypassed = await runCorpus({
      driver: driverOf(PIN, () =>
        sessionOf({ runtimeId: "compat/test-app", applicationId: APP_ID, pin: PIN }, [
          taskOutcome("implement-function", {
            egressObservation: {
              mode: "observe",
              status: "violations-detected",
              violations: [
                {
                  host: "api.openai.com",
                  url: "https://api.openai.com/v1",
                  rule: "provider class",
                  at: NOW,
                  blocked: false,
                },
              ],
            },
          }),
        ]),
      ),
      expected: EXPECTED,
      corpus: [CORPUS[0] as { taskId: string; title: string; instruction: string }],
      traceSource: traceSourceOf({ "exec-implement-function": completedRead() }),
      now: () => NOW,
    });
    expect(bypassed.runOutcomes[0]?.outcome).toBe("BYPASS_DETECTED");
    expect(bypassed.egressObservation?.status).toBe("violations-detected");
  });

  test("the egress aggregation is worst-case honest", () => {
    const clean = { mode: "deny" as const, status: "observed-clean" as const, violations: [] };
    expect(aggregateEgressObservation([clean, null])).toEqual(clean);
    expect(aggregateEgressObservation([null, null])).toBeNull();
    expect(
      aggregateEgressObservation([
        clean,
        {
          mode: "deny",
          status: "violations-detected",
          violations: [{ host: "h", url: "u", rule: "r", at: NOW, blocked: false }],
        },
      ])?.status,
    ).toBe("violations-detected");
  });
});

describe("the measurement + evidence assembly over a run report", () => {
  async function passingReport() {
    return runCorpus({
      driver: driverOf(PIN, () =>
        sessionOf(
          { runtimeId: "compat/test-app", applicationId: APP_ID, pin: PIN },
          CORPUS.map((task) =>
            taskOutcome(task.taskId, {
              durationMs: task.taskId === "implement-function" ? 1000 : 2000,
            }),
          ),
        ),
      ),
      expected: EXPECTED,
      corpus: CORPUS,
      traceSource: traceSourceOf({
        "exec-implement-function": completedRead(),
        "exec-fix-bug": completedRead(),
      }),
      now: () => NOW,
    });
  }

  test("the measurement set covers all thirteen dimensions with measured facts where measured", async () => {
    const measurements = measurementSetOf(await passingReport());
    const byDimension = new Map(measurements.entries.map((entry) => [entry.dimension, entry]));
    expect(byDimension.size).toBe(13);
    expect(byDimension.get("outcome-success")).toMatchObject({
      attempts: 2,
      successes: 2,
      failures: 0,
      basis: "measured",
    });
    expect(byDimension.get("latency-tail")).toMatchObject({
      medianMs: 1500,
      p95Ms: 2000,
      p99Ms: 2000,
      maxMs: 2000,
      sampleCount: 2,
    });
    expect(byDimension.get("usage-cost")).toMatchObject({
      inputTokens: 240,
      outputTokens: 160,
      totalCostMicroUsd: "8360000",
      costPerSuccessMicroUsd: "4180000",
    });
    expect(byDimension.get("quality-verification")).toMatchObject({
      taskChecksPassed: 2,
      taskChecksTotal: 2,
      zeckVerificationsPassed: 2,
      zeckVerificationsTotal: 2,
    });
    expect(byDimension.get("telemetry-explainability")).toMatchObject({
      reconstructibleExecutions: 2,
      executionsTotal: 2,
    });
    expect(byDimension.get("reproducibility")).toMatchObject({
      rerunsAttempted: 2,
      rerunsAgreed: 2,
    });
    // The work-order-measured dimensions stay honest not-measured.
    expect(byDimension.get("determinism-reuse")?.basis).toBe("not-measured");
    expect(byDimension.get("provider-portability")?.basis).toBe("not-measured");
    expect(byDimension.get("diagnosis-recovery")?.basis).toBe("not-measured");
  });

  test("the assembled record is structurally valid and derives honestly from its facts", async () => {
    const report = await passingReport();
    const record = evidenceRecordDraftOf({
      recordId: "runner-assembled-record",
      pinnedApplication: {
        identity: {
          name: "Test app",
          repository: "https://example.invalid/app",
          applicationId: APP_ID,
        },
        pin: PIN,
      },
      graph: {
        edges: [
          {
            edgeId: "main-completion",
            component: "chat loop",
            surface: "text-generation",
            transport: "client",
            externalExecution: "provider model",
            materiality: "the main call",
          },
        ],
      },
      report,
      baselines: [
        {
          kind: "direct-baseline",
          stack: "direct provider stack",
          methodology: "comparable constraints",
          taskRuns: [
            {
              taskId: "implement-function",
              succeeded: true,
              detail: "ok",
              durationMs: 3000,
              costMicroUsd: "6000",
            },
            {
              taskId: "fix-bug",
              succeeded: true,
              detail: "ok",
              durationMs: 3200,
              costMicroUsd: "6200",
            },
          ],
          recordedAt: NOW,
        },
      ],
    });
    expect(record.recordBasis).toBe("live-proof");
    expect(record.dispositions).toEqual([
      {
        edgeId: "main-completion",
        disposition: "delegated",
        zeckExecutionIds: ["exec-implement-function", "exec-fix-bug"],
        evidenceBasis: "live",
      },
    ]);
    expect(record.comparison[0]?.baseline).toBe("direct-baseline");
    expect(record.comparison[0]?.statement).toContain("never Zeck evidence");
    expect(record.zeckTraces).toHaveLength(2);
    // Without a discovered inventory the record stays un-reconciled
    // (the coverage gate) — certification needs the inventory too.
    const assessment = evaluateCompatibility(record);
    expect(assessment.status).not.toBe("AI_EXECUTION_COMPLETE");
    expect(assessment.findings.some((finding) => finding.code === "INVENTORY_MISSING")).toBe(true);
  });

  test("the registry composes (the deployment registration seam)", () => {
    const registry = createRuntimeRegistry({
      drivers: [
        driverOf(PIN, () =>
          sessionOf({ runtimeId: "compat/test-app", applicationId: APP_ID, pin: PIN }, []),
        ),
      ],
    });
    expect(registry.resolve("compat/test-app")?.runtimeId).toBe("compat/test-app");
    expect(registry.resolve("compat/other")).toBeNull();
  });
});
