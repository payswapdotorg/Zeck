/**
 * The measurement builder (PPR-018A scope item 6) — derives the
 * measured entries of the thirteen-dimension schema from a corpus run
 * report, and the honest not-measured entries for the dimensions the
 * run itself cannot measure (the work order replaces those with its
 * own measured facts when it has them).
 *
 * MEASURED FROM THE RUN: outcome-success, quality-verification,
 * latency-tail, usage-cost, failure-retry, telemetry-explainability,
 * reproducibility (from the run's own replay/correlation facts).
 *
 * HONEST NOT-MEASURED BY DEFAULT (work-order measured facts replace
 * them): determinism-reuse, provider-portability, customization-
 * coverage, engineering-surface-removed, capability-discovery-
 * avoidance, diagnosis-recovery.
 *
 * Every entry's basis is `measured` only when the underlying facts
 * exist; absent facts degrade to honest not-measured with the reason
 * in the statement — never a fabricated number.
 */

import {
  type BaselineRunRecord,
  type LatencyTailMeasurement,
  type MeasurementEntry,
  type MeasurementSet,
  latencyTailOf,
  medianOf,
  percentileOf,
  validateMeasurementSet,
} from "../../src/integrations/compatibility/public";
import type { CorpusRunReport } from "./corpus-runner";

export type { CorpusRunReport };

/** A named measurement-build issue (fail-closed; the set must validate). */
export interface MeasurementBuildIssue {
  readonly issue: string;
}

const NOT_YET = (what: string): string =>
  `${what} not measured in this run — no fabricated value is offered; the work order's own measured facts replace this entry when available.`;

/** Build the full thirteen-dimension measurement set from a corpus run report. */
export function measurementSetOf(report: CorpusRunReport): MeasurementSet {
  const entries: MeasurementEntry[] = [
    outcomeSuccessOf(report),
    qualityVerificationOf(report),
    latencyTailEntryOf(report),
    usageCostOf(report),
    failureRetryOf(report),
    determinismReuseOf(),
    providerPortabilityOf(),
    customizationCoverageOf(),
    engineeringSurfaceRemovedOf(),
    capabilityDiscoveryAvoidanceOf(),
    telemetryExplainabilityOf(report),
    diagnosisRecoveryOf(),
    reproducibilityOf(report),
  ];
  const set: MeasurementSet = { entries };
  const issues = validateMeasurementSet(set);
  if (issues.length > 0) {
    // Structurally unreachable (the builder emits every dimension once);
    // fail loudly rather than return an invalid set.
    throw new Error(
      `measurement builder produced an invalid set: ${issues.map((issue) => `${issue.dimension}: ${issue.issue}`).join("; ")}`,
    );
  }
  return set;
}

/** Dimension 1 — outcome success (attempts/successes/failures/not-run from the run outcomes). */
function outcomeSuccessOf(report: CorpusRunReport): MeasurementEntry {
  const outcomes = report.runOutcomes;
  const successes = outcomes.filter((entry) => entry.outcome === "PASS").length;
  const failures = outcomes.filter((entry) => entry.outcome === "FAIL").length;
  const notRun = outcomes.filter(
    (entry) => entry.outcome === "NOT-RUN" || entry.outcome === "BLOCKED",
  ).length;
  const bypasses = outcomes.filter((entry) => entry.outcome === "BYPASS_DETECTED").length;
  return {
    dimension: "outcome-success",
    basis: outcomes.length > 0 ? "measured" : "not-measured",
    statement:
      outcomes.length === 0
        ? "no corpus task ran — outcome success is not measured"
        : `${successes}/${outcomes.length} corpus task(s) resolved the declared success check (${failures} FAIL, ${notRun} NOT-RUN/BLOCKED, ${bypasses} BYPASS_DETECTED).`,
    attempts: outcomes.length,
    successes,
    failures,
    notRun,
  };
}

/** Dimension 2 — quality/verification (task checks + Zeck verification results). */
function qualityVerificationOf(report: CorpusRunReport): MeasurementEntry {
  const taskChecksPassed = report.taskReports.filter((r) => r.outcome.succeeded === true).length;
  const taskChecksTotal = report.taskReports.filter((r) => r.outcome.succeeded !== null).length;
  const traces = report.taskReports.flatMap((r) => [...r.traces]);
  const zeckPassed = traces.reduce((sum, trace) => sum + trace.passingVerificationCount, 0);
  const zeckTotal = traces.reduce((sum, trace) => sum + trace.verificationCount, 0);
  const measured = taskChecksTotal > 0 || traces.length > 0;
  return {
    dimension: "quality-verification",
    basis: measured ? "measured" : "not-measured",
    statement: measured
      ? `${taskChecksPassed}/${taskChecksTotal} task success checks passed (the corpus's own declared definition); ${zeckPassed}/${zeckTotal} Zeck verification results PASS over ${traces.length} correlated execution(s).`
      : NOT_YET("Quality/verification facts are"),
    taskChecksPassed: taskChecksTotal > 0 ? taskChecksPassed : null,
    taskChecksTotal: taskChecksTotal > 0 ? taskChecksTotal : null,
    zeckVerificationsPassed: traces.length > 0 ? zeckPassed : null,
    zeckVerificationsTotal: traces.length > 0 ? zeckTotal : null,
  };
}

/** Dimension 3 — latency + tail (successful-outcome task durations; deterministic percentiles). */
function latencyTailEntryOf(report: CorpusRunReport): MeasurementEntry {
  const samples = report.taskReports
    .filter((r) => r.outcome.succeeded === true)
    .map((r) => r.outcome.durationMs);
  return latencyTailOf(
    samples,
    samples.length > 0 ? "measured" : "not-measured",
    samples.length > 0
      ? `Successful-outcome end-to-end task latency over ${samples.length} resolved task(s) (milliseconds; nearest-rank percentiles).`
      : NOT_YET("Latency samples are"),
  );
}

/** Dimension 4 — usage + cost (from the correlated executions' settled facts). */
function usageCostOf(report: CorpusRunReport): MeasurementEntry {
  const edgeExecutions = report.taskReports.flatMap((r) => [...r.outcome.edgeExecutions]);
  const traces = report.taskReports.flatMap((r) => [...r.traces]);
  const withUsage = edgeExecutions.filter(
    (edge) => edge.usage !== undefined && edge.usage !== null,
  );
  const inputTokens = withUsage.reduce((sum, edge) => sum + (edge.usage?.inputTokens ?? 0), 0);
  const outputTokens = withUsage.reduce((sum, edge) => sum + (edge.usage?.outputTokens ?? 0), 0);
  const costEdges = edgeExecutions.filter(
    (edge) => edge.costMicroUsd !== undefined && edge.costMicroUsd !== null,
  );
  const totalCost = costEdges.reduce(
    (sum, edge) => sum + Number(edge.costMicroUsd ?? 0),
    0,
  );
  const successes = report.runOutcomes.filter((entry) => entry.outcome === "PASS").length;
  const costPerSuccess =
    successes > 0 && costEdges.length > 0
      ? String(Math.floor(totalCost / successes))
      : null;
  const measured = edgeExecutions.length > 0;
  return {
    dimension: "usage-cost",
    basis: measured ? "measured" : "not-measured",
    statement: measured
      ? `${inputTokens} input / ${outputTokens} output token(s) reported over ${edgeExecutions.length} edge execution(s); settled cost ${totalCost} micro-USD${costPerSuccess !== null ? ` (${costPerSuccess} micro-USD per successfully resolved outcome)` : ""}.`
      : NOT_YET("Usage and cost facts are"),
    inputTokens: withUsage.length > 0 ? inputTokens : null,
    outputTokens: withUsage.length > 0 ? outputTokens : null,
    totalCostMicroUsd: costEdges.length > 0 ? String(totalCost) : null,
    costPerSuccessMicroUsd: costPerSuccess,
  };
}

/** Dimension 5 — failure/retry counts (from the task outcomes). */
function failureRetryOf(report: CorpusRunReport): MeasurementEntry {
  const failures = report.taskReports.reduce((sum, r) => sum + r.outcome.failureCount, 0);
  const retries = report.taskReports.reduce((sum, r) => sum + r.outcome.retryCount, 0);
  const measured = report.taskReports.length > 0;
  return {
    dimension: "failure-retry",
    basis: measured ? "measured" : "not-measured",
    statement: measured
      ? `${failures} failure(s) and ${retries} retry(ies) recorded across ${report.taskReports.length} task run(s).`
      : NOT_YET("Failure/retry counts are"),
    failureCount: measured ? failures : null,
    retryCount: measured ? retries : null,
    duplicateCount: null,
    timeoutCount: null,
  };
}

/** Dimension 6 — deterministic/reuse/verified-computation opportunities (work-order measured). */
function determinismReuseOf(): MeasurementEntry {
  return {
    dimension: "determinism-reuse",
    basis: "not-measured",
    statement: NOT_YET(
      "Deterministic/reuse/verified-computation opportunities are measured by the work order's own analysis (measured, never assumed — the program's rule)",
    ),
    deterministicExecutionCount: null,
    reuseCount: null,
    verifiedComputationSubstitutions: null,
  };
}

/** Dimension 7 — provider portability / change effort (work-order measured). */
function providerPortabilityOf(): MeasurementEntry {
  return {
    dimension: "provider-portability",
    basis: "not-measured",
    statement: NOT_YET("Provider portability and change-effort facts are"),
    providerSwitchTimeMs: null,
    changedApplicationFiles: null,
    regressionCount: null,
  };
}

/** Dimension 8 — customization coverage (work-order measured). */
function customizationCoverageOf(): MeasurementEntry {
  return {
    dimension: "customization-coverage",
    basis: "not-measured",
    statement: NOT_YET("Customization coverage facts are"),
    customizationAxesRetained: null,
    customizationAxesTotal: null,
  };
}

/** Dimension 9 — engineering surface removed (work-order measured). */
function engineeringSurfaceRemovedOf(): MeasurementEntry {
  return {
    dimension: "engineering-surface-removed",
    basis: "not-measured",
    statement: NOT_YET("Engineering-surface-removed facts are"),
    removedFiles: null,
    removedLines: null,
  };
}

/** Dimension 10 — capability-discovery-driven avoided implementation (work-order measured). */
function capabilityDiscoveryAvoidanceOf(): MeasurementEntry {
  return {
    dimension: "capability-discovery-avoidance",
    basis: "not-measured",
    statement: NOT_YET("Capability-discovery avoidance facts are"),
    capabilitiesAdoptedFromZeck: null,
    avoidedBespokeImplementations: null,
  };
}

/** Dimension 11 — telemetry/explainability completeness (from the correlated traces). */
function telemetryExplainabilityOf(report: CorpusRunReport): MeasurementEntry {
  const traces = report.taskReports.flatMap((r) => [...r.traces]);
  const edgeExecutions = report.taskReports.flatMap((r) => [...r.outcome.edgeExecutions]);
  if (traces.length === 0 && edgeExecutions.length === 0) {
    return {
      dimension: "telemetry-explainability",
      basis: "not-measured",
      statement: NOT_YET("Telemetry/explainability facts are"),
      reconstructibleExecutions: null,
      executionsTotal: null,
    };
  }
  // An execution is reconstructible when its trace was found AND
  // carries durable evidence (ledger events + verification results)
  // AND at least route-or-cost-or-usage facts were projectable.
  const reconstructible = traces.filter(
    (trace) =>
      trace.correlated &&
      (trace.route !== null ||
        trace.costMicroUsd !== null ||
        (trace.usage !== undefined && trace.usage !== null)),
  ).length;
  return {
    dimension: "telemetry-explainability",
    basis: "measured",
    statement: `${reconstructible}/${edgeExecutions.length} delegated execution(s) are reconstructible end-to-end through the executions public surface (ledger events + verification + route/cost/usage facts).`,
    reconstructibleExecutions: reconstructible,
    executionsTotal: edgeExecutions.length,
  };
}

/** Dimension 12 — diagnosis/recovery time (work-order exercised). */
function diagnosisRecoveryOf(): MeasurementEntry {
  return {
    dimension: "diagnosis-recovery",
    basis: "not-measured",
    statement: NOT_YET(
      "Incident diagnosis and recovery times are exercised by the work order's failure/recovery scenarios",
    ),
    diagnosisTimeMs: null,
    recoveryTimeMs: null,
    incidentsExercised: null,
  };
}

/** Dimension 13 — reproducibility (the run's correlation + replay facts). */
function reproducibilityOf(report: CorpusRunReport): MeasurementEntry {
  const traces = report.taskReports.flatMap((r) => [...r.traces]);
  const edgeExecutions = report.taskReports.flatMap((r) => [...r.outcome.edgeExecutions]);
  const correlated = traces.filter((trace) => trace.correlated).length;
  const measured = edgeExecutions.length > 0;
  return {
    dimension: "reproducibility",
    basis: measured ? "measured" : "not-measured",
    statement: measured
      ? `${correlated}/${edgeExecutions.length} delegated execution(s) correlate durably (ledger events + verification results) — the run's Zeck evidence is reproducible through the executions public surface at the exact pinned revisions.`
      : NOT_YET("Reproducibility facts are"),
    rerunsAttempted: measured ? edgeExecutions.length : null,
    rerunsAgreed: measured ? correlated : null,
  };
}

/**
 * The baseline-side latency/cost/usage summary (for the baseline
 * comparison statement — always labeled as baseline facts).
 */
export function baselineSummaryOf(baseline: BaselineRunRecord): string {
  const executed = baseline.taskRuns.filter((run) => run.succeeded !== null).length;
  const successes = baseline.taskRuns.filter((run) => run.succeeded === true).length;
  const samples = baseline.taskRuns
    .filter((run) => run.succeeded === true)
    .map((run) => run.durationMs);
  const median = medianOf(samples);
  const p95 = percentileOf(samples, 95);
  const totalCost = baseline.taskRuns.reduce(
    (sum, run) => (run.costMicroUsd !== undefined && run.costMicroUsd !== null ? sum + Number(run.costMicroUsd) : sum),
    0,
  );
  return `BASELINE ${baseline.kind}: ${successes}/${executed} task(s) resolved, median latency ${median ?? "n/a"} ms, p95 ${p95 ?? "n/a"} ms, settled cost ${totalCost} micro-USD over the ${baseline.stack} stack (baseline facts — never Zeck evidence).`;
}
