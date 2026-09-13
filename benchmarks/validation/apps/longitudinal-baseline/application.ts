/**
 * The longitudinal-baseline customer application (VAL-030).
 *
 * A real customer-style application riding Zeck's public SDK boundary:
 * one pinned frozen-baseline corpus row per run — the frozen app
 * artifact + the golden workload revision, content-addressed by the
 * manifest's digests — submitted as a CONTROL-RUN task (the CONTROL arm
 * declaration rides the task semantics: learning explicitly INERT; the
 * app never selects provider/model/rail — the platform keeps the route
 * authority). The application exercises the BASELINE-FREEZE side of the
 * control-run contract at the customer boundary:
 *
 *   * every row's control-run submission lands ONE durable execution
 *     through the harness submit (the evidence carries the request
 *     fingerprint and the completion timeline);
 *   * the completion poll observes the row's honest terminal —
 *     COMPLETED for the admitted baselines, FAILED for the
 *     guard-rejected baseline (the honest precondition failure is the
 *     first-class frozen reference, never a retry);
 *   * the result retrieval observes the verification statuses (the
 *     app-side terminal↔criteria agreement is derived MECHANICALLY over
 *     the public result read) and the route's model-call count (the
 *     control run's OWN dispatches: a reused or shortcut-contaminated
 *     run under-dispatches and is mechanically visible at the customer
 *     boundary);
 *   * the events read re-derives the platform's trajectory digest over
 *     the PUBLIC step-event journal — the app never trusts the
 *     platform's own claim; the observed digest must be a MEMBER of the
 *     corpus-pinned trajectory-digest equivalence class;
 *   * the re-run rows re-issue the submission key with the IDENTICAL
 *     body after settlement (the control re-run): the ledger must
 *     REPLAY the committed identity (identity preserved, the replayed
 *     flag surfaced — a second identity is a re-arbitration and FAILs
 *     the app), and the re-observed trajectory must STILL reproduce the
 *     recorded equivalence class (a drifting re-run is mechanically out
 *     of class).
 *
 * The application's own assertions verify the per-row control contract
 * through the platform slice's PURE `verifyLongitudinalBaselineAppContract`
 * — a fabricated outcome, an under-dispatching run, a drifting re-run or
 * a duplicated identity never passes a row whose control contract is
 * violated.
 */

import { createZeckClient, ZeckApiError } from "../../../../sdk";
import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type { LabVerificationCriterion } from "../../platform/derive";
import {
  appTrajectoryDigestOf,
  verifyLongitudinalBaselineAppContract,
} from "../../platform/longitudinal-baseline";
import {
  controlSubmissionKey,
  controlTaskBodyFor,
  LONGITUDINAL_CORPUS,
  LONGITUDINAL_TASK_KIND,
} from "./corpus";

/** One submission observation (the app's own receipt view). */
export interface ControlSubmissionObservation {
  readonly executionId: string;
  readonly replayed: boolean;
  readonly status: string | null;
  readonly rejection: { readonly code: string; readonly status: number } | null;
  readonly submittedAt: number;
  readonly latencyMs: number;
}

/** The app's full run outcome (evidence + assertions + control contract). */
export interface LongitudinalAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly appCriteria: readonly LabVerificationCriterion[];
  /** The original control-run submission's observed receipt. */
  readonly submission: ControlSubmissionObservation | null;
  /** The control re-run's replay receipt (rerun rows only). */
  readonly replay: ControlSubmissionObservation | null;
  /** The observed terminal from the public execution read. */
  readonly observedTerminal: string | null;
  /** The verification statuses from the public result read. */
  readonly verificationStatuses: readonly string[];
  /** The app-side trajectory digest over the public events read. */
  readonly trajectoryDigest: string | null;
  /** The re-run's app-side trajectory digest (rerun rows only). */
  readonly rerunTrajectoryDigest: string | null;
  /** The observed model-call count from the public route read. */
  readonly observedModelCalls: number | null;
  /** The measured submission latencies (ms) — original then replay. */
  readonly submissionLatencyMs: readonly number[];
}

/** The app's pinned corpus slice (`longitudinal-baseline.control.v1` rows). */
export const LONGITUDINAL_TASKS = LONGITUDINAL_CORPUS.map((row) => ({
  kind: LONGITUDINAL_TASK_KIND,
  rowId: row.rowId,
  appId: row.manifest.appId,
  appVersion: row.appArtifact.appVersion,
  workloadId: row.manifest.workloadId,
  workloadRevision: row.manifest.workloadRevision,
  appDigest: row.manifest.appDigest,
  workloadDigest: row.manifest.workloadDigest,
  manifestDigest: row.manifest.manifestDigest,
  expectedTerminal: row.expected.terminal,
  dispatchRounds: row.workload.dispatchRounds,
  quotaMicro: row.workload.quotaMicro,
  declaredEffects: row.workload.effects.length,
  expectedModelCalls: row.expectedModelCalls,
  trajectoryClassSize: row.expectedTrajectoryClass.length,
  ...(row.rerun === undefined ? {} : { rerun: row.rerun.probe }),
  ...(row.contamination === undefined ? {} : { contamination: row.contamination.kind }),
  ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
  appCreated: row.expected.appCreated,
  replayedSubmissions: row.expected.replayedSubmissions,
  rejectedSubmissions: row.expected.rejectedSubmissions,
  ledgerIdentities: row.expected.ledgerIdentities,
}));

/**
 * Run the longitudinal-baseline application end to end over one pinned
 * corpus row: submit the control run → poll to the row's terminal →
 * retrieve the result (the verification statuses + the route's
 * model-call count) → read the events (the app-side trajectory digest
 * over the public journal) → (the rerun rows) re-issue the submission
 * key with the IDENTICAL body and re-observe the trajectory. The
 * transport implementation is injected (the SDK's seam); the app never
 * selects provider/model/rail (the platform's authority).
 */
export async function runLongitudinalApp(options: {
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
}): Promise<LongitudinalAppResult> {
  const row = LONGITUDINAL_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned longitudinal-baseline task slice is empty");
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
      workOrder: "VAL-030",
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

  const key = controlSubmissionKey({ runSuffix: options.runSuffix, taskIndex: options.taskIndex });
  const body = controlTaskBodyFor({ rowId: row.rowId });
  const request = { applicationId: options.config.applicationId, task: body };
  const submissionLatencyMs: number[] = [];

  // ---- the submission phase (the control run's landing) ----
  const submittedAt = options.now().getTime();
  let submission: ControlSubmissionObservation;
  try {
    const run = await harness.submit(request, key);
    submissionLatencyMs.push(options.now().getTime() - submittedAt);
    submission = {
      executionId: run.executionId,
      replayed: run.replayed,
      status: run.initialStatus,
      rejection: null,
      submittedAt,
      latencyMs: options.now().getTime() - submittedAt,
    };
  } catch (error: unknown) {
    submissionLatencyMs.push(options.now().getTime() - submittedAt);
    submission = {
      executionId: "",
      replayed: false,
      status: null,
      rejection: {
        code: error instanceof ZeckApiError ? error.body.code : "UNEXPECTED",
        status: error instanceof ZeckApiError ? error.status : 0,
      },
      submittedAt,
      latencyMs: options.now().getTime() - submittedAt,
    };
  }
  if (submission.rejection !== null || submission.executionId === "") {
    // The submission itself was rejected — an honest app failure with
    // NO control run to reconcile (never a fabricated completion).
    return {
      evidence: harness.evidence(),
      passed: false,
      appCriteria: [
        {
          criterionId: "submission-landed",
          strategy: "deterministic",
          status: "FAIL",
          evidence: [`rejection:${submission.rejection?.code ?? "none"}`],
        },
      ],
      submission,
      replay: null,
      observedTerminal: null,
      verificationStatuses: [],
      trajectoryDigest: null,
      rerunTrajectoryDigest: null,
      observedModelCalls: null,
      submissionLatencyMs,
    };
  }

  // ---- the observation phase (the public reads) ----
  const executionId = submission.executionId;
  const observedTerminal = await harness.awaitCompletion(executionId);

  // The result read: the verification statuses + the route's own
  // model-call count (the control run's OWN dispatches).
  const result = await harness.retrieveResult(executionId);
  const verificationStatuses =
    result === null ? [] : result.verification.map((entry) => entry.status as string);
  const observedModelCalls = result === null ? null : (result.route?.modelCalls ?? null);

  // The events read: the app mechanically re-derives the platform's
  // own trajectory digest over the PUBLIC step-event journal — never
  // trusting the platform's claim.
  let trajectoryDigest: string | null = null;
  try {
    const events = await client.listEvents(executionId);
    trajectoryDigest = appTrajectoryDigestOf(
      events.map((event) => ({ type: event.type, sequence: event.sequence })),
    );
  } catch {
    trajectoryDigest = null;
  }

  // ---- the control re-run phase (the rerun rows: re-issue the SAME key) ----
  let replay: ControlSubmissionObservation | null = null;
  let rerunTrajectoryDigest: string | null = null;
  if (row.rerun !== undefined) {
    const replaySubmittedAt = options.now().getTime();
    try {
      const { receipt } = await client.createExecution(request, key);
      submissionLatencyMs.push(options.now().getTime() - replaySubmittedAt);
      replay = {
        executionId: receipt.executionId,
        replayed: receipt.replayed,
        status: receipt.status,
        rejection: null,
        submittedAt: replaySubmittedAt,
        latencyMs: options.now().getTime() - replaySubmittedAt,
      };
    } catch (error: unknown) {
      submissionLatencyMs.push(options.now().getTime() - replaySubmittedAt);
      replay = {
        executionId: "",
        replayed: false,
        status: null,
        rejection: {
          code: error instanceof ZeckApiError ? error.body.code : "UNEXPECTED",
          status: error instanceof ZeckApiError ? error.status : 0,
        },
        submittedAt: replaySubmittedAt,
        latencyMs: options.now().getTime() - replaySubmittedAt,
      };
    }
    // The replayed execution settles to the SAME terminal (the ledger
    // replays the committed outcome — never a second transition): the
    // poll returns immediately for a terminal row.
    if (replay.rejection === null && replay.executionId !== "") {
      await harness.awaitCompletion(replay.executionId);
      // The re-run's trajectory: re-read the public journal AFTER the
      // re-issue (a drifting re-run is mechanically out of class).
      try {
        const rerunEvents = await client.listEvents(replay.executionId);
        rerunTrajectoryDigest = appTrajectoryDigestOf(
          rerunEvents.map((event) => ({ type: event.type, sequence: event.sequence })),
        );
      } catch {
        rerunTrajectoryDigest = null;
      }
    }
  }

  // ---- the assertion phase ----
  // 1. The harness's deterministic outcome assertions (the terminal
  //    contract; the forbidden opposite; no retryable errors).
  const harnessPassed = harness.assertOutcome({
    expectTerminalStatus: row.expected.terminal,
    forbiddenTerminalStatuses: [row.expected.terminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  // 2. The app-side control contract (PURE): the terminal↔criteria
  //    agreement over the public result read, the expected terminal
  //    met, the trajectory class membership (the app re-derived
  //    digest), the control run's own dispatch count, and — the rerun
  //    rows — the re-run class membership and the replay identity
  //    preservation.
  const appCriteria = verifyLongitudinalBaselineAppContract({
    row,
    terminal: observedTerminal,
    verificationStatuses,
    trajectoryDigest,
    rerunTrajectoryDigest,
    observedModelCalls,
    replay:
      replay === null
        ? null
        : {
            replayed: replay.replayed,
            executionId: replay.executionId,
            rejection: replay.rejection === null ? null : { code: replay.rejection.code },
          },
  });
  const contractPassed = appCriteria.every((criterion) => criterion.status === "PASS");

  // 3. The submission contract: the original submission CREATED (never
  //    a replay — the re-run rides the row's own re-run phase only).
  const submissionPassed = submission.replayed === false && submission.rejection === null;

  return {
    evidence: harness.evidence(),
    passed: harnessPassed && contractPassed && submissionPassed,
    appCriteria,
    submission,
    replay,
    observedTerminal,
    verificationStatuses,
    trajectoryDigest,
    rerunTrajectoryDigest,
    observedModelCalls,
    submissionLatencyMs,
  };
}
