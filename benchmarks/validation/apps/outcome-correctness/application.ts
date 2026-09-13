/**
 * The outcome-correctness customer application (VAL-026).
 *
 * A real customer-style application: one pinned corpus row per run —
 * the declared effect set, the budget-guard input and the declared
 * verification expectation — submitted through Zeck's public SDK
 * boundary. The application exercises the OUTCOME side of the
 * correctness contract:
 *
 *   * every row's submission lands ONE durable execution (the harness
 *     submit — the evidence carries the request fingerprint and the
 *     completion timeline);
 *   * the completion poll observes the row's terminal — COMPLETED for
 *     the healthy rows, FAILED for the failure-shaped rows (the
 *     honest failure is the verified outcome, never a retry);
 *   * the result retrieval observes the verification statuses — the
 *     app-side terminal↔criteria agreement is derived MECHANICALLY
 *     over the public result read (a fabricated pass-with-fail — a
 *     COMPLETED terminal with a FAIL verification status — FAILs the
 *     app honestly: the anyFail→FAILED invariant probed at the
 *     customer boundary);
 *   * the replay rows re-issue the submission key with the IDENTICAL
 *     body after settlement — the ledger must REPLAY the committed
 *     outcome (identity preserved, the replayed flag surfaced; a
 *     second identity is a re-arbitration and FAILs the app).
 *
 * The application's own assertions verify the per-row outcome contract
 * (the corpus-declared terminal + the app-side reconciliation criteria
 * + the replay identity) — a fabricated outcome never passes a row
 * whose outcome contract is violated.
 */

import { createZeckClient, ZeckApiError } from "../../../../sdk";
import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type { LabVerificationCriterion } from "../../platform/derive";
import type { SubmissionObservation } from "../../platform/outcome-correctness";
import { verifyOutcomeAppContract } from "../../platform/outcome-correctness";
import { OUTCOME_CORPUS, submissionKey, taskBodyFor } from "./corpus";

/** The app's full run outcome (evidence + assertions + outcome contract). */
export interface OutcomeAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly outcomeCriteria: readonly LabVerificationCriterion[];
  /** The original submission's observed receipt. */
  readonly submission: SubmissionObservation | null;
  /** The replay receipt (replay rows only). */
  readonly replay: SubmissionObservation | null;
  /** The observed terminal from the public execution read. */
  readonly observedTerminal: string | null;
  /** The verification statuses from the public result read. */
  readonly verificationStatuses: readonly string[];
  /** The measured submission latencies (ms) — original then replay. */
  readonly submissionLatencyMs: readonly number[];
}

/** The app's pinned corpus slice (`outcome-correctness.effect.v1` rows). */
export const OUTCOME_TASKS = OUTCOME_CORPUS.map((row) => ({
  kind: "outcome-correctness.effect.v1",
  rowId: row.rowId,
  expectedTerminal: row.expected.terminal,
  declaredEffects: row.declaredEffects.length,
  quotaMicro: row.quotaMicro,
  ...(row.failure === undefined ? {} : { failureKind: row.failure.kind }),
  ...(row.replay === undefined ? {} : { replay: row.replay.after }),
  ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
  appCreated: row.expected.appCreated,
  replayedSubmissions: row.expected.replayedSubmissions,
  rejectedSubmissions: row.expected.rejectedSubmissions,
}));

/**
 * Run the outcome-correctness application end to end over one pinned
 * corpus row: submit → poll to the row's terminal → retrieve the
 * result (the verification statuses) → (the replay rows) re-issue the
 * submission key and observe the replayed receipt. The transport
 * implementation is injected (the SDK's seam); the app never selects
 * provider/model/rail (the platform's authority).
 */
export async function runOutcomeApp(options: {
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
}): Promise<OutcomeAppResult> {
  const row = OUTCOME_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned outcome-correctness task slice is empty");
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
      workOrder: "VAL-026",
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

  const key = submissionKey({ runSuffix: options.runSuffix, taskIndex: options.taskIndex });
  const body = taskBodyFor({ rowId: row.rowId, quotaMicro: row.quotaMicro });
  const request = { applicationId: options.config.applicationId, task: body };
  const submissionLatencyMs: number[] = [];

  // ---- the submission phase ----
  const submittedAt = options.now().getTime();
  let submission: SubmissionObservation | null = null;
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
    // NO outcome to reconcile (never a fabricated completion).
    return {
      evidence: harness.evidence(),
      passed: false,
      outcomeCriteria: [
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
      submissionLatencyMs,
    };
  }

  // ---- the completion phase (poll to the row's terminal) ----
  const executionId = submission.executionId;
  const observedTerminal = await harness.awaitCompletion(executionId);

  // ---- the result-retrieval phase (the verification statuses) ----
  const result = await harness.retrieveResult(executionId);
  const verificationStatuses =
    result === null ? [] : result.verification.map((entry) => entry.status as string);

  // ---- the replay phase (the replay rows: re-issue the SAME key) ----
  let replay: SubmissionObservation | null = null;
  if (row.replay !== undefined) {
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

  // 2. The app-side outcome contract (PURE): the terminal↔criteria
  //    agreement over the public result read (the anyFail→FAILED
  //    invariant probed at the customer boundary), the expected
  //    terminal met, and the replay identity preservation.
  const outcomeCriteria = verifyOutcomeAppContract({
    row,
    terminal: observedTerminal,
    verificationStatuses,
    replay,
  });
  const contractPassed = outcomeCriteria.every((criterion) => criterion.status === "PASS");

  // 3. The submission contract: the original submission CREATED (never
  //    a replay — the replay rides the row's own replay phase only).
  const submissionPassed = submission.replayed === false && submission.rejection === null;

  return {
    evidence: harness.evidence(),
    passed: harnessPassed && contractPassed && submissionPassed,
    outcomeCriteria,
    submission,
    replay,
    observedTerminal,
    verificationStatuses,
    submissionLatencyMs,
  };
}
