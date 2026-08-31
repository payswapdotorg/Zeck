/**
 * Benchmark harness (WORK-016 — MEASUREMENT, never authority).
 *
 * Runs every (task, strategy) pair through the SAME governed substrate
 * and derives every dimension from the DURABLE evidence (the executions
 * authority's public reads). The harness performs NO authority
 * mutation of its own:
 *  - no policy publish/change;
 *  - no budget reserve/settle/release;
 *  - no agent registration/promotion/rollback (strategies arrive
 *    PRE-CONFIGURED — setup is the caller's governed composition, not
 *    a measurement step);
 *  - no verification-authority mutation (completions ride the canonical
 *    governed lifecycle the strategies drive);
 *  - no WorkflowOS-state surface AT ALL (there is none to mutate).
 *
 * The strategy seam: each strategy is `runTask(task, idempotencyKey)`
 * returning the durable execution identity it created. Every strategy
 * must produce its execution through the SAME executions authority
 * (injected here) — the harness re-reads the durable evidence itself and
 * distrusts anything the strategy returns except the executionId.
 */

import type {
  EventEnvelope,
  ExecutionService,
  VerificationResultRecord,
} from "../src/modules/executions/public";
import type {
  BenchmarkEnvironment,
  BenchmarkEvidence,
  BenchmarkStrategyKind,
  BenchmarkTask,
  ExecutionRunMeasurement,
  StrategyTaskSummary,
} from "./contract";

export interface BenchmarkStrategy {
  readonly kind: BenchmarkStrategyKind;
  /**
   * Run ONE governed task and return the durable execution identity.
   * Implementations MUST create executions through the same injected
   * executions authority (the fair-comparison contract).
   */
  readonly runTask: (task: BenchmarkTask, idempotencyKey: string) => Promise<readonly string[]>;
}

export interface BenchmarkHarnessDeps {
  /** THE executions authority every strategy must use (fair comparison). */
  readonly executions: ExecutionService;
  readonly applicationId: string;
  readonly label: string;
  readonly environment: Omit<BenchmarkEnvironment, "verificationProvenance">;
}

const RETRY_EVENT_TYPES = new Set([
  "execution.replanned",
  "execution.wait-tool",
  "execution.resumed",
]);

const TOOL_USAGE_EVENT_TYPES = new Set([
  "agent-action-recorded",
  "tool.invoked",
  "tool.completed",
  "tool.failed",
]);

interface LedgerFacts {
  readonly events: readonly EventEnvelope[];
  readonly verification: readonly VerificationResultRecord[];
  readonly settledCostMicroUsd: string | null;
  readonly selectedStrategyId: string | null;
  readonly artifactCount: number;
  readonly retryEvents: number;
  readonly toolUsageEvents: number;
  readonly failureMode: string | null;
}

const ledgerFactsOf = (
  events: readonly EventEnvelope[],
  verification: readonly VerificationResultRecord[],
): LedgerFacts => {
  const settled = [...events].reverse().find((event) => event.type === "execution.completed");
  const costMicroUsd = (settled?.payload as { readonly costMicroUsd?: unknown } | undefined)
    ?.costMicroUsd;
  const artifacts = (settled?.payload as { readonly outputArtifacts?: unknown } | undefined)
    ?.outputArtifacts;
  const decision = [...events]
    .reverse()
    .find((event) => event.type === "planning.decision-recorded");
  const selectedStrategyId = (
    decision?.payload as { readonly selectedStrategyId?: unknown } | undefined
  )?.selectedStrategyId;
  const failure = events.find((event) => event.type === "execution.failed");
  const failureReason = (failure?.payload as { readonly reason?: unknown } | undefined)?.reason;
  return {
    events,
    verification,
    settledCostMicroUsd:
      typeof costMicroUsd === "string" && /^\d+$/.test(costMicroUsd) ? costMicroUsd : null,
    selectedStrategyId: typeof selectedStrategyId === "string" ? selectedStrategyId : null,
    artifactCount: Array.isArray(artifacts) ? artifacts.length : 0,
    retryEvents: events.filter((event) => RETRY_EVENT_TYPES.has(event.type)).length,
    toolUsageEvents: events.filter((event) => TOOL_USAGE_EVENT_TYPES.has(event.type)).length,
    failureMode:
      failure === undefined
        ? null
        : typeof failureReason === "string"
          ? `execution.failed: ${failureReason}`
          : "execution.failed",
  };
};

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

const round = (value: number): number => Math.round(value * 100) / 100;

/** Create the measurement harness over the injected authority wiring. */
export function createBenchmarkHarness(deps: BenchmarkHarnessDeps) {
  const { executions, applicationId } = deps;

  const measureRun = async (
    strategy: BenchmarkStrategy,
    task: BenchmarkTask,
    runIndex: number,
    idempotencyKey: string,
  ): Promise<readonly ExecutionRunMeasurement[]> => {
    const startedAt = performance.now();
    // THE strategy seam: run through the governed substrate.
    const executionIds = await strategy.runTask(task, idempotencyKey);
    const wallClockMs = performance.now() - startedAt;
    // The harness re-reads the DURABLE evidence itself — never trusting
    // anything but the execution identities the strategies returned.
    const measurements: ExecutionRunMeasurement[] = [];
    for (const [index, executionId] of executionIds.entries()) {
      const execution = await executions.getExecution(applicationId, executionId);
      if (execution === null) {
        continue;
      }
      const [events, verification] = await Promise.all([
        executions.listEvents(applicationId, executionId),
        executions.listVerificationResults(applicationId, executionId),
      ]);
      const facts = ledgerFactsOf(events, verification);
      const ledgerDurationMs =
        execution.terminalAt === null
          ? null
          : Math.max(0, Date.parse(execution.terminalAt) - Date.parse(execution.createdAt));
      measurements.push({
        taskId: task.taskId,
        strategy: strategy.kind,
        runIndex: runIndex + index,
        executionId,
        status: execution.status,
        terminal: execution.terminalAt !== null,
        verificationOutcomes: facts.verification.map((result) => result.status),
        settledCostMicroUsd: facts.settledCostMicroUsd,
        wallClockMs: round(wallClockMs),
        ledgerDurationMs: ledgerDurationMs === null ? null : round(ledgerDurationMs),
        retryEvents: facts.retryEvents,
        toolUsageEvents: facts.toolUsageEvents,
        selectedStrategyId: facts.selectedStrategyId,
        artifactCount: facts.artifactCount,
        failureMode: facts.failureMode,
      });
    }
    return measurements;
  };

  const summarize = (
    taskId: string,
    strategy: BenchmarkStrategyKind,
    runs: readonly ExecutionRunMeasurement[],
  ): StrategyTaskSummary => {
    const scoped = runs.filter((run) => run.taskId === taskId && run.strategy === strategy);
    return {
      taskId,
      strategy,
      runs: scoped.length,
      completed: scoped.filter((run) => run.status === "COMPLETED").length,
      failed: scoped.filter((run) => run.status === "FAILED").length,
      nonTerminal: scoped.filter((run) => !run.terminal).length,
      passResults: scoped.flatMap((run) => run.verificationOutcomes).filter((o) => o === "PASS")
        .length,
      failResults: scoped.flatMap((run) => run.verificationOutcomes).filter((o) => o === "FAIL")
        .length,
      inconclusiveResults: scoped
        .flatMap((run) => run.verificationOutcomes)
        .filter((o) => o === "INCONCLUSIVE").length,
      settledCostMicroUsd:
        scoped.find((run) => run.settledCostMicroUsd !== null)?.settledCostMicroUsd ?? null,
      meanWallClockMs: round(mean(scoped.map((run) => run.wallClockMs))),
      meanLedgerDurationMs: scoped.every((run) => run.ledgerDurationMs === null)
        ? null
        : round(mean(scoped.map((run) => run.ledgerDurationMs ?? 0))),
      meanRetryEvents: round(mean(scoped.map((run) => run.retryEvents))),
      meanToolUsageEvents: round(mean(scoped.map((run) => run.toolUsageEvents))),
      meanArtifactCount: round(mean(scoped.map((run) => run.artifactCount))),
      failureModes: [...new Set(scoped.map((run) => run.failureMode).filter((m) => m !== null))],
    };
  };

  return {
    /** Run the full benchmark: every (task, strategy) pair × repetitions. */
    async run(
      strategies: readonly BenchmarkStrategy[],
      tasks: readonly BenchmarkTask[],
    ): Promise<BenchmarkEvidence> {
      const startedAt = new Date().toISOString();
      const repetitions = deps.environment.repetitions;
      const runs: ExecutionRunMeasurement[] = [];
      for (const task of tasks) {
        for (const strategy of strategies) {
          for (let repetition = 0; repetition < repetitions; repetition += 1) {
            const idempotencyKey = `bench:${strategy.kind}:${task.taskId}:${repetition}`;
            const measured = await measureRun(strategy, task, repetition, idempotencyKey);
            runs.push(...measured);
          }
        }
      }
      const summaries: StrategyTaskSummary[] = [];
      for (const task of tasks) {
        for (const strategy of strategies) {
          summaries.push(summarize(task.taskId, strategy.kind, runs));
        }
      }
      return {
        label: deps.label,
        startedAt,
        finishedAt: new Date().toISOString(),
        runs,
        summaries,
        environment: {
          ...deps.environment,
          verificationProvenance:
            "benchmark-harness (the canonical governed completion path; not independent evaluator judgment)",
        },
      };
    },
  };
}

export type BenchmarkHarness = ReturnType<typeof createBenchmarkHarness>;
