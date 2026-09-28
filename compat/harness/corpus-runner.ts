/**
 * The reusable corpus runner (PPR-018A scope item 4) — the ONE runner
 * every application work order (PPR-018..027) replays its
 * representative corpus through. It:
 *
 *  1. starts ONE exact pinned runtime session (the driver the work
 *     order registered) and REFUSES unpinned execution — the session's
 *     own descriptor must match the expected record binding exactly;
 *  2. audits the session's provider-credential erasure (ACR-007 §5)
 *     and records the honest facts (names + presence, never values);
 *  3. executes every corpus task through the pinned runtime (the
 *     ACR-007 translation boundary — the harness adds NO provider
 *     selection, retry routing, budget accounting, verification or
 *     optimization logic);
 *  4. correlates EVERY delegated edge execution through the read-only
 *     ZeckTraceSource (the executions public surface), recording the
 *     durable trace facts — a missing correlation is an honest named
 *     miss, never a fabricated fact;
 *  5. derives the run-level outcome per task (PASS / NOT-RUN /
 *     BLOCKED / FAIL / BYPASS_DETECTED — the work order's completeness
 *     vocabulary) and the aggregated egress observation;
 *  6. always stops what it started (finally).
 *
 * The output `CorpusRunReport` is the raw material the evidence
 * assembly (evidence-assembly.ts) turns into a compatibility evidence
 * record draft, and the measurement builder (measurement.ts) turns
 * into the thirteen-dimension measurement set.
 */

import {
  type CompatibilityEvidenceRecord,
  type EgressObservation,
  type PinnedRuntimeDriver,
  type PinnedRuntimeTask,
  type RuntimeBinding,
  type ZeckTraceFact,
  type ZeckTraceSource,
  checkProviderCredentialErasure,
  deriveRunOutcome,
  runtimeBindingIssues,
  runtimeBindingOf,
  zeckTraceFactOf,
  type CorrelatedRunReport,
  type CredentialErasureResult,
  type RunNotRunCause,
  type RunOutcome,
} from "../../src/integrations/compatibility/public";
import { PROVIDER_CREDENTIAL_ENV_VAR_NAMES } from "./credential-erasure";

/** One corpus task (the work order's declaration; the session executes it). */
export interface CorpusTask extends PinnedRuntimeTask {}

export interface CorpusRunnerOptions {
  /** The pinned driver the work order registered (started ONCE, stopped always). */
  readonly driver: PinnedRuntimeDriver;
  /**
   * The expected binding — the record the run is producing evidence
   * for (the runner refuses a session that does not match exactly).
   */
  readonly expected: RuntimeBinding;
  /** The representative corpus (idempotent task list, stable order). */
  readonly corpus: readonly CorpusTask[];
  /** The read-only Zeck execution trace source (correlation, never fabrication). */
  readonly traceSource: ZeckTraceSource;
  /** The injected clock (ISO strings). */
  readonly now: () => string;
  /** Override the provider-credential name list (default: the harness's reusable list). */
  readonly credentialEnvVarNames?: readonly string[];
}

/** The full corpus run report (the evidence + measurement input). */
export interface CorpusRunReport {
  readonly runtime: {
    readonly runtimeId: string;
    readonly applicationId: string;
    readonly pin: { readonly upstreamRevision: string; readonly integrationRevision: string };
  };
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Per-task correlated reports (task outcome + correlated trace facts). */
  readonly taskReports: readonly CorrelatedRunReport[];
  /** The derived run-level outcome per task (the completeness vocabulary). */
  readonly runOutcomes: readonly { readonly taskId: string; readonly outcome: RunOutcome }[];
  /** The aggregated egress observation (worst-case honest derivation). */
  readonly egressObservation: EgressObservation | null;
  /** The session's credential erasure audit (names + presence, never values). */
  readonly credentialErasure: CredentialErasureResult | null;
}

/** A raised, named runner error (fail-closed; never a silent skip). */
export class CorpusRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusRunnerError";
  }
}

/**
 * Run the corpus through the pinned runtime. Fail-closed on unpinned
 * execution: the driver's pins AND the started session's descriptor
 * must match `expected` exactly, or the run refuses (a named error —
 * an unpinned run produces no report).
 */
export async function runCorpus(options: CorpusRunnerOptions): Promise<CorpusRunReport> {
  const { driver, expected, corpus, traceSource, now } = options;
  const credentialNames = options.credentialEnvVarNames ?? PROVIDER_CREDENTIAL_ENV_VAR_NAMES;

  const driverIssues = runtimeBindingIssues(expected, {
    applicationId: driver.identity.applicationId,
    pin: driver.pin,
  });
  if (driverIssues.length > 0) {
    throw new CorpusRunnerError(
      `unpinned application execution refused: ${driverIssues.map((issue) => issue.issue).join("; ")}`,
    );
  }

  const startedAt = now();
  const runCorrelationId = `corpus:${driver.runtimeId}:${startedAt}`;
  const session = await driver.start({
    expectedApplicationId: expected.applicationId,
    expectedPin: expected.pin,
    runCorrelationId,
    now,
  });
  try {
    const sessionIssues = runtimeBindingIssues(expected, {
      applicationId: session.descriptor.applicationId,
      pin: session.descriptor.pin,
    });
    if (sessionIssues.length > 0) {
      throw new CorpusRunnerError(
        `the started session's descriptor does not match the expected binding — unpinned application execution refused: ${sessionIssues
          .map((issue) => issue.issue)
          .join("; ")}`,
      );
    }
    const credentialErasure = checkProviderCredentialErasure(credentialNames, {
      has: (name) =>
        session.environmentFacts.find((fact) => fact.envVarName === name)?.present === true,
    });
    const taskReports: CorrelatedRunReport[] = [];
    for (const task of corpus) {
      const outcome = await session.executeTask(task);
      const traces: ZeckTraceFact[] = [];
      for (const edge of outcome.edgeExecutions) {
        const read = await traceSource.readExecutionTrace(
          session.descriptor.applicationId,
          edge.executionId,
        );
        traces.push(
          zeckTraceFactOf(edge.edgeId, session.descriptor.applicationId, edge.executionId, read),
        );
      }
      taskReports.push({
        task,
        outcome,
        traces,
        egressObservation: outcome.egressObservation ?? null,
      });
    }
    const finishedAt = now();
    return {
      runtime: {
        runtimeId: session.descriptor.runtimeId,
        applicationId: session.descriptor.applicationId,
        pin: session.descriptor.pin,
      },
      startedAt,
      finishedAt,
      taskReports,
      runOutcomes: taskReports.map((report) => ({
        taskId: report.task.taskId,
        outcome: deriveRunOutcome({
          succeeded: report.outcome.succeeded,
          bypassObserved: report.outcome.egressObservation?.status === "violations-detected",
          unavailable: report.outcome.unavailable ?? null,
        }),
      })),
      egressObservation: aggregateEgressObservation(taskReports.map((r) => r.egressObservation)),
      credentialErasure,
    };
  } finally {
    await session.stop();
  }
}

/** Derive the run-level outcome of one task report (exposed for tests + reports). */
export function runOutcomeOf(report: CorrelatedRunReport): RunOutcome {
  return deriveRunOutcome({
    succeeded: report.outcome.succeeded,
    bypassObserved: report.outcome.egressObservation?.status === "violations-detected",
    unavailable: report.outcome.unavailable ?? null,
  });
}

/**
 * Aggregate the per-task egress observations into one honest
 * observation: a passing violation anywhere ⇒ violations-detected;
 * otherwise deny-mode with blocked violations ⇒ provably-blocked;
 * otherwise observed-clean when at least one observation ran.
 */
export function aggregateEgressObservation(
  observations: readonly (EgressObservation | null)[],
): EgressObservation | null {
  const present = observations.filter(
    (observation): observation is EgressObservation => observation !== null,
  );
  if (present.length === 0) {
    return null;
  }
  const anyPassing = present.some(
    (observation) =>
      observation.status === "violations-detected" ||
      observation.violations.some((violation) => !violation.blocked),
  );
  if (anyPassing) {
    return {
      mode: present.some((observation) => observation.mode === "deny") ? "deny" : "observe",
      status: "violations-detected",
      violations: present.flatMap((observation) => [...observation.violations]),
    };
  }
  const allDeny = present.every((observation) => observation.mode === "deny");
  const violations = present.flatMap((observation) => [...observation.violations]);
  if (violations.length === 0) {
    return { mode: allDeny ? "deny" : "observe", status: "observed-clean", violations: [] };
  }
  return {
    mode: allDeny ? "deny" : "observe",
    status: allDeny ? "provably-blocked" : "observed-clean",
    violations,
  };
}

/** Helper: the honest NOT-RUN cause for a task that could not execute. */
export function notRunCauseOf(report: CorrelatedRunReport): RunNotRunCause {
  return (
    report.outcome.unavailable ?? {
      outcome: "NOT-RUN",
      cause: "the task produced no success fact and no declared unavailability",
      owner: "work-order",
    }
  );
}

/** Helper: the binding of a record (the runner's expected input). */
export function expectedBindingOf(record: CompatibilityEvidenceRecord): RuntimeBinding {
  return runtimeBindingOf(record.pinnedApplication);
}
