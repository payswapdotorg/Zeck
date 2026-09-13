/**
 * The workload-replay customer application (VAL-031).
 *
 * A real customer-style application riding Zeck's public SDK boundary:
 * one pinned replay-population corpus row per run — VAL-030's frozen
 * baseline manifest replayed N times with learning still INERT,
 * submitted as REPLAY tasks (the CONTROL arm declaration rides the
 * task semantics: learning explicitly inert; the app never selects
 * provider/model/rail — the platform keeps the route authority). The
 * application exercises the repeated-replay contract at the customer
 * boundary in three phases:
 *
 *   * the replay-submission phase — every replay lands its OWN durable
 *     execution through the harness submit under its OWN idempotency
 *     key (N replays per row; a replay never re-issues another
 *     replay's key);
 *   * the observation phase — the per-replay completion polls observe
 *     each replay's honest terminal (COMPLETED for the admitted
 *     baselines, FAILED for the guard-rejected population — the honest
 *     precondition failure replays N times, never a retry), the result
 *     retrievals observe the verification statuses and each replay's
 *     route model-call count, and the events reads re-derive EVERY
 *     replay's trajectory digest over the PUBLIC step-event journal
 *     (the app never trusts the platform's own claim);
 *   * the analysis phase — the population statistics are derived from
 *     the app's OWN observations: the digest distribution (which rows
 *     are deterministic across identical replays and which
 *     legitimately vary), the measured latency distribution
 *     (min/max/median over the per-replay submission latencies) and
 *     the population dispatch total.
 *
 * The application's own assertions verify the per-row replay contract
 * through the platform slice's PURE `verifyWorkloadReplayAppContract`
 * — a shoulder-in that replays an existing execution, a drifting
 * replay, a dropped trajectory read, a smoothed variance or a
 * fabricated terminal never passes a row whose replay contract is
 * violated.
 */

import { createZeckClient, ZeckApiError } from "../../../../sdk";
import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type { LabVerificationCriterion } from "../../platform/derive";
import { appTrajectoryDigestOf } from "../../platform/longitudinal-baseline";
import type {
  AppReplayObservation,
  DigestDistributionEntry,
  StabilityKind,
} from "../../platform/workload-replay";
import {
  deriveLatencyDistribution,
  deriveStabilityReportOf,
  verifyWorkloadReplayAppContract,
} from "../../platform/workload-replay";
import {
  replaySubmissionKey,
  replayTaskBodyFor,
  WORKLOAD_REPLAY_CORPUS,
  WORKLOAD_REPLAY_TASK_KIND,
} from "./corpus";

/** One replay submission's observation (the app's own receipt view). */
export interface ReplaySubmissionObservation {
  readonly executionId: string;
  readonly replayOrdinal: number;
  readonly replayed: boolean;
  readonly status: string | null;
  readonly rejection: { readonly code: string; readonly status: number } | null;
  readonly submittedAt: number;
  readonly latencyMs: number;
}

/** The app's derived population statistics (the analysis phase's output). */
export interface ReplayPopulationStatistics {
  /** The observed stability report (variance is REPORTED, never smoothed). */
  readonly stability: {
    readonly kind: StabilityKind;
    readonly distribution: readonly DigestDistributionEntry[];
  };
  /** The measured latency distribution over the per-replay submissions. */
  readonly latency: {
    readonly count: number;
    readonly minMs: number | null;
    readonly maxMs: number | null;
    readonly medianMs: number | null;
  };
  /** The observed population dispatch total (the public route reads). */
  readonly observedModelCalls: number;
}

/** The app's full run outcome (evidence + assertions + replay contract). */
export interface WorkloadReplayAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly appCriteria: readonly LabVerificationCriterion[];
  /** The per-replay submission receipts, in ordinal order. */
  readonly submissions: readonly ReplaySubmissionObservation[];
  /** The per-replay observed terminals, in ordinal order. */
  readonly observedTerminals: readonly (string | null)[];
  /** The per-replay verification statuses, in ordinal order. */
  readonly verificationStatuses: readonly (readonly string[])[];
  /** The per-replay app-side trajectory digests, in ordinal order. */
  readonly trajectoryDigests: readonly (string | null)[];
  /** The per-replay observed model-call counts, in ordinal order. */
  readonly observedModelCalls: readonly (number | null)[];
  /** The analysis phase's derived population statistics. */
  readonly population: ReplayPopulationStatistics;
  /** The measured per-replay submission latencies (ms), in ordinal order. */
  readonly submissionLatencyMs: readonly number[];
}

/** The app's pinned corpus slice (`workload-replay.population.v1` rows). */
export const WORKLOAD_REPLAY_TASKS = WORKLOAD_REPLAY_CORPUS.map((row) => ({
  kind: WORKLOAD_REPLAY_TASK_KIND,
  rowId: row.rowId,
  baselineRowId: row.baselineRowId,
  appId: row.manifest.appId,
  appVersion: row.appArtifact.appVersion,
  workloadId: row.manifest.workloadId,
  workloadRevision: row.manifest.workloadRevision,
  appDigest: row.manifest.appDigest,
  workloadDigest: row.manifest.workloadDigest,
  manifestDigest: row.manifest.manifestDigest,
  replayCount: row.replayCount,
  expectedTerminal: row.expected.terminal,
  expectedModelCallsPerReplay: row.expectedModelCallsPerReplay,
  populationModelCalls: row.expectedModelCallsPerReplay * row.replayCount,
  trajectoryClassSize: row.expectedTrajectoryClass.length,
  stabilityKind: row.expectedStability.kind,
  stabilityDistributionSize: row.expectedStability.distribution.length,
  ...(row.probe === undefined ? {} : { probe: row.probe.kind }),
  ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
  appCreated: row.expected.appCreated,
  replayedSubmissions: row.expected.replayedSubmissions,
  rejectedSubmissions: row.expected.rejectedSubmissions,
  ledgerIdentities: row.expected.ledgerIdentities,
}));

/**
 * Run the workload-replay application end to end over one pinned
 * corpus row: submit the N replays (each under its OWN idempotency
 * key) → poll every replay to the row's terminal → retrieve every
 * replay's result (the verification statuses + the route's model-call
 * count) → read every replay's events (the app-side trajectory digest
 * over the public journal) → derive the population statistics from the
 * app's OWN observations → verify the per-row replay contract. The
 * transport implementation is injected (the SDK's seam); the app never
 * selects provider/model/rail (the platform's authority).
 */
export async function runWorkloadReplayApp(options: {
  readonly config: AppHarnessConfig;
  readonly token: string;
  readonly transport: TransportImplementation;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly environment: {
    readonly runtime: string;
    readonly toolchain: string;
    readonly database: string;
    readonly configuration: Readonly<Record<string, string>>;
  };
  readonly runSuffix: string;
  readonly taskIndex: number;
}): Promise<WorkloadReplayAppResult> {
  const row = WORKLOAD_REPLAY_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned workload-replay task slice is empty");
  }

  const harness = new ValidationHarness({
    baseUrl: options.config.baseUrl,
    token: options.token,
    applicationId: options.config.applicationId,
    transport: options.transport,
    runtime: {
      now: options.now,
      sleep: options.sleep,
      environment: options.environment,
    },
    identity: {
      program: "zeck-validation",
      workOrder: "VAL-031",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });
  const client = createZeckClient({
    baseUrl: options.config.baseUrl,
    token: options.token,
    applicationId: options.config.applicationId,
    fetchImpl: options.transport,
  });

  const submissions: ReplaySubmissionObservation[] = [];
  const observedTerminals: (string | null)[] = [];
  const verificationStatuses: string[][] = [];
  const trajectoryDigests: (string | null)[] = [];
  const observedModelCalls: (number | null)[] = [];
  const submissionLatencyMs: number[] = [];

  // ---- the replay-submission phase (N replays, each its OWN execution) ----
  for (let replayOrdinal = 1; replayOrdinal <= row.replayCount; replayOrdinal += 1) {
    const key = replaySubmissionKey({
      runSuffix: options.runSuffix,
      taskIndex: options.taskIndex,
      replayOrdinal,
    });
    const body = replayTaskBodyFor({ rowId: row.rowId, replayOrdinal });
    const request = { applicationId: options.config.applicationId, task: body };
    const submittedAt = options.now().getTime();
    try {
      const run = await harness.submit(request, key);
      const latencyMs = options.now().getTime() - submittedAt;
      submissionLatencyMs.push(latencyMs);
      submissions.push({
        executionId: run.executionId,
        replayOrdinal,
        replayed: run.replayed,
        status: run.initialStatus,
        rejection: null,
        submittedAt,
        latencyMs,
      });
    } catch (error: unknown) {
      const latencyMs = options.now().getTime() - submittedAt;
      submissionLatencyMs.push(latencyMs);
      submissions.push({
        executionId: "",
        replayOrdinal,
        replayed: false,
        status: null,
        rejection: {
          code: error instanceof ZeckApiError ? error.body.code : "UNEXPECTED",
          status: error instanceof ZeckApiError ? error.status : 0,
        },
        submittedAt,
        latencyMs,
      });
    }
  }

  // ---- the observation phase (the per-replay public reads) ----
  for (const submission of submissions) {
    if (submission.rejection !== null || submission.executionId === "") {
      // The replay's submission was rejected — an honest app failure
      // with NO replay to observe (never a fabricated completion).
      observedTerminals.push(null);
      verificationStatuses.push([]);
      trajectoryDigests.push(null);
      observedModelCalls.push(null);
      continue;
    }
    const executionId = submission.executionId;
    observedTerminals.push(await harness.awaitCompletion(executionId));

    // The result read: the verification statuses + the route's own
    // model-call count (this replay's OWN dispatches).
    const result = await harness.retrieveResult(executionId);
    verificationStatuses.push(
      result === null ? [] : result.verification.map((entry) => entry.status as string),
    );
    observedModelCalls.push(result === null ? null : (result.route?.modelCalls ?? null));

    // The events read: the app mechanically re-derives the platform's
    // own trajectory digest over the PUBLIC step-event journal — never
    // trusting the platform's claim.
    try {
      const events = await client.listEvents(executionId);
      trajectoryDigests.push(
        appTrajectoryDigestOf(
          events.map((event) => ({ type: event.type, sequence: event.sequence })),
        ),
      );
    } catch {
      trajectoryDigests.push(null);
    }
  }

  // ---- the analysis phase (the population statistics, from OWN observations) ----
  const stability = deriveStabilityReportOf(trajectoryDigests);
  const latency = deriveLatencyDistribution({
    perReplayLatencyMs: submissionLatencyMs,
    expectedReplayCount: row.replayCount,
  });
  const populationModelCalls = observedModelCalls.reduce(
    (sum: number, calls) => sum + (calls ?? 0),
    0,
  );

  // ---- the assertion phase ----
  // 1. The harness's deterministic outcome assertions (the LAST
  //    replay's terminal contract; the forbidden opposite; no
  //    retryable errors — every replay's terminal is verified
  //    individually by the app contract below).
  const harnessPassed = harness.assertOutcome({
    expectTerminalStatus: row.expected.terminal,
    forbiddenTerminalStatuses: [row.expected.terminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  // 2. The app-side replay contract (PURE): the population
  //    completeness at the customer boundary, the per-replay
  //    terminal↔criteria agreements, expected terminals, class
  //    memberships and own-dispatch counts, and the population-level
  //    stability honesty + dispatch total.
  const replays: AppReplayObservation[] = submissions.map((submission, index) => ({
    replayOrdinal: submission.replayOrdinal,
    executionId: submission.executionId,
    replayed: submission.replayed,
    rejection: submission.rejection === null ? null : { code: submission.rejection.code },
    terminal: observedTerminals[index] ?? null,
    verificationStatuses: verificationStatuses[index] ?? [],
    trajectoryDigest: trajectoryDigests[index] ?? null,
    observedModelCalls: observedModelCalls[index] ?? null,
  }));
  const appCriteria = verifyWorkloadReplayAppContract({ row, replays });
  const contractPassed = appCriteria.every((criterion) => criterion.status === "PASS");

  // 3. The submission contract: every replay submission landed its OWN
  //    fresh execution (never a replay — a shoulder-in never passes).
  const submissionsPassed = submissions.every(
    (submission) => submission.replayed === false && submission.rejection === null,
  );

  return {
    evidence: harness.evidence(),
    passed: harnessPassed && contractPassed && submissionsPassed,
    appCriteria,
    submissions,
    observedTerminals,
    verificationStatuses,
    trajectoryDigests,
    observedModelCalls,
    population: {
      stability,
      latency: {
        count: latency.count,
        minMs: latency.minMs ?? 0,
        maxMs: latency.maxMs ?? 0,
        medianMs: latency.medianMs ?? 0,
      },
      observedModelCalls: populationModelCalls,
    },
    submissionLatencyMs,
  };
}
