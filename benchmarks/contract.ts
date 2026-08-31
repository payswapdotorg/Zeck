/**
 * Benchmark harness contract (WORK-016 — the measurement surface).
 *
 * BENCHMARK = MEASUREMENT, NEVER AUTHORITY (§21 of the Work Order): the
 * harness compares execution strategies on representative governed tasks
 * using the SAME execution and evidence contract, and its outputs are
 * EVIDENCE RECORDS ONLY. A benchmark report cannot authorize providers,
 * change policy, change budgets, promote an agent, mutate routing, mark
 * an execution verified (beyond the canonical governed completion path
 * every execution uses) or mutate WorkflowOS state — the harness surface
 * holds no such call, and the architecture gate proves it.
 *
 * FAIR COMPARISON (§20): the three strategy kinds run over the SAME
 * injected authorities (the same executions service, the same policy
 * admission, the same evidence reads). No hidden privileges: the native
 * path uses the identical session-service admission chain as the BYOA
 * path; the WorkflowOS path goes through the identical submission
 * contract. Environmental differences (clock source, store wiring,
 * repetitions) are recorded explicitly in the report.
 */

/** The neutral strategy kinds under comparison. */
export const BENCHMARK_STRATEGY_KINDS = [
  "native-agent-session",
  "byoa-agent-session",
  "workflowos-submission",
] as const;

export type BenchmarkStrategyKind = (typeof BENCHMARK_STRATEGY_KINDS)[number];

/** A representative governed task (the Zeck task vocabulary). */
export interface BenchmarkTask {
  readonly taskId: string;
  readonly description: string;
  readonly task: Readonly<Record<string, unknown>>;
  /** Optional deterministic expectation the verification dimension uses. */
  readonly verification: {
    readonly criterionId: string;
    readonly strategy: string;
    readonly expectedStatus: "PASS" | "FAIL" | "INCONCLUSIVE";
  };
}

/** One measured run of one (task, strategy) pair. */
export interface ExecutionRunMeasurement {
  readonly taskId: string;
  readonly strategy: BenchmarkStrategyKind;
  readonly runIndex: number;
  /** The durable execution identity the measurement refers to (provenance). */
  readonly executionId: string;
  /** Success dimension: the terminal (or current) execution status. */
  readonly status: string;
  readonly terminal: boolean;
  /** Verification dimension: the recorded verification outcomes. */
  readonly verificationOutcomes: readonly string[];
  /** Cost dimension: settled cost from durable ledger facts (null when unset). */
  readonly settledCostMicroUsd: string | null;
  /** Latency dimension: harness wall-clock milliseconds (environmental — see notes). */
  readonly wallClockMs: number;
  /** Latency dimension: durable ledger timestamps (createdAt → terminalAt). */
  readonly ledgerDurationMs: number | null;
  /** Retry dimension: replan/wait/resume events on the ledger. */
  readonly retryEvents: number;
  /** Tool-usage dimension: agent action/tool step events on the ledger. */
  readonly toolUsageEvents: number;
  /** Route/strategy dimension: the planning decision's selected strategy id. */
  readonly selectedStrategyId: string | null;
  /** Artifact dimension: artifact references from settled facts. */
  readonly artifactCount: number;
  /** Failure-mode dimension: the failure command/reason when failed. */
  readonly failureMode: string | null;
}

/** Aggregated evidence for one (task, strategy) pair. */
export interface StrategyTaskSummary {
  readonly taskId: string;
  readonly strategy: BenchmarkStrategyKind;
  readonly runs: number;
  readonly completed: number;
  readonly failed: number;
  readonly nonTerminal: number;
  readonly passResults: number;
  readonly failResults: number;
  readonly inconclusiveResults: number;
  readonly settledCostMicroUsd: string | null;
  readonly meanWallClockMs: number;
  readonly meanLedgerDurationMs: number | null;
  readonly meanRetryEvents: number;
  readonly meanToolUsageEvents: number;
  readonly meanArtifactCount: number;
  readonly failureModes: readonly string[];
}

/** The full benchmark evidence record (pure data — no authority power). */
export interface BenchmarkEvidence {
  readonly label: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly runs: readonly ExecutionRunMeasurement[];
  readonly summaries: readonly StrategyTaskSummary[];
  /** Explicit environmental differences (§20 — no hidden privileges). */
  readonly environment: BenchmarkEnvironment;
}

export interface BenchmarkEnvironment {
  /** How the authorities were wired (e.g. "in-memory" | "postgresql"). */
  readonly wiring: string;
  /** The clock the harness used for wall-clock latency. */
  readonly clock: "performance" | "date";
  /** Repetitions per (task, strategy) pair. */
  readonly repetitions: number;
  /**
   * Honest note: the verification dimension is recorded through the
   * canonical governed completion path with harness-identified
   * provenance ("benchmark-harness"), not through independent evaluator
   * judgment (a future benchmark surface).
   */
  readonly verificationProvenance: string;
  /** Any environmental caveats the runner supplies. */
  readonly notes: readonly string[];
}

/** The neutral report shape (a pure projection over the evidence). */
export interface BenchmarkReport {
  readonly evidence: BenchmarkEvidence;
  /** Side-by-side per-task comparison rows (strategy × task). */
  readonly comparison: readonly {
    readonly taskId: string;
    readonly rows: readonly {
      readonly strategy: BenchmarkStrategyKind;
      readonly successRate: number;
      readonly passRate: number;
      readonly meanWallClockMs: number;
      readonly meanRetryEvents: number;
      readonly settledCostMicroUsd: string | null;
    }[];
  }[];
  /** The strategy-level aggregate (all tasks pooled). */
  readonly strategyTotals: readonly {
    readonly strategy: BenchmarkStrategyKind;
    readonly runs: number;
    readonly successRate: number;
    readonly passRate: number;
    readonly meanWallClockMs: number;
  }[];
}
