/**
 * The economic-longitudinal-curve customer application (VAL-047).
 *
 * A real customer-style application: one pinned longitudinal cost-curve
 * row per run — the row's FAMILY (cost-per-outcome-trajectory |
 * improvement-rate-decomposition | plateau-maturity-verdict), the
 * workload class, the DECLARED window (matching the recorded data),
 * the PRE-REGISTERED point set (digest references into the recorded
 * longitudinal ledgers) composed with the RECORDED VAL-045 attribution
 * results (digest references, never copies), the declared mechanism
 * cohorts, the marked price-regime change points, the statistical
 * minimums, the Wilson configuration and the expected verdict
 * REFERENCE — submitted through Zeck's public SDK boundary. The
 * application exercises the customer side of the curve contract:
 *
 *   * every row's submission lands ONE durable execution (the harness
 *     submit — the evidence carries the request fingerprint and the
 *     completion timeline);
 *   * the completion poll observes the row's terminal (COMPLETED for
 *     the honest verdict rows — improving, plateaued,
 *     never-materialized and mixed-cohort-regressing alike, since the
 *     honest classification IS the verified outcome; FAILED when any
 *     mechanical criterion failed — including the eight adversarial
 *     probe rows whose denatured shapes FAIL their named criteria);
 *   * the result retrieval observes the verification statuses — the
 *     app-side terminal↔criteria agreement is derived MECHANICALLY
 *     over the public result read (a fabricated pass-with-fail — a
 *     COMPLETED terminal with a FAIL verification status — FAILs the
 *     app honestly: the anyFail→FAILED invariant probed at the
 *     customer boundary);
 *   * the task body carries REFERENCES ONLY (the family, the workload
 *     class, the window, the point-set digest references, the cohorts,
 *     the regime change points, the minimums, the Wilson level) —
 *     never an inline price, never a recorded result copy (the
 *     platform resolves the ledgers, the attribution corpora and the
 *     manifests through their registries).
 *
 * The application's own assertions verify the per-row outcome contract
 * through the VAL-040 app-contract derivation (imported, never copied)
 * — a fabricated outcome never passes a row whose outcome contract is
 * violated.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type { LabVerificationCriterion } from "../../platform/derive";
import type { EconomicCorpusRow } from "../economic-baseline/driver";
import { verifyEconomicAppContract } from "../economic-baseline/driver";
import { CURVE_CORPUS, submissionKey, taskBodyFor } from "./corpus";

/** The app's full run outcome (evidence + assertions + outcome contract). */
export interface CurveAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly curveCriteria: readonly LabVerificationCriterion[];
  /** The observed terminal from the public execution read. */
  readonly observedTerminal: string | null;
  /** The verification statuses from the public result read. */
  readonly verificationStatuses: readonly string[];
  /** The measured submission latency (ms). */
  readonly submissionLatencyMs: readonly number[];
}

/** The app's pinned corpus slice (`economic-longitudinal-curve.experiment.v1` rows). */
export const CURVE_TASKS = CURVE_CORPUS.map((row) => ({
  kind: "economic-longitudinal-curve.experiment.v1",
  rowId: row.rowId,
  expectedTerminal: row.expected.terminal,
  family: row.family,
  workloadClass: row.workloadClass,
  expectedVerdict: row.expected.verdict,
  minimumGenerations: row.minimumGenerations,
  minimumOutcomesPerPoint: row.minimumOutcomesPerPoint,
  windowFromGeneration: row.declaredWindow.fromGeneration,
  windowToGeneration: row.declaredWindow.toGeneration,
  pointSetSize: row.pointSet.length,
  regimeChangePoints: row.regimeChangePoints.length,
  ...(row.adversarial === undefined ? {} : { adversarial: row.adversarial }),
  ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
  appCreated: row.expected.appCreated,
  replayedSubmissions: row.expected.replayedSubmissions,
  rejectedSubmissions: row.expected.rejectedSubmissions,
}));

/**
 * Run the economic-longitudinal-curve application end to end over one
 * pinned corpus row: submit → poll to the row's terminal → retrieve
 * the result (the verification statuses) → the deterministic
 * assertions → the app-side economic contract. The transport
 * implementation is injected (the SDK's seam); the app never selects
 * pricing and never copies recorded results (the row declares the
 * digest references; the platform resolves the corpora).
 */
export async function runCurveApp(options: {
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
}): Promise<CurveAppResult> {
  const row = CURVE_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned longitudinal cost-curve task slice is empty");
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
      workOrder: "VAL-047",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  const key = submissionKey({ runSuffix: options.runSuffix, taskIndex: options.taskIndex });
  const body = taskBodyFor({ row });
  const request = { applicationId: options.config.applicationId, task: body };
  const submissionLatencyMs: number[] = [];

  // ---- the submission phase ----
  const submittedAt = options.now().getTime();
  let executionId = "";
  let rejected = false;
  try {
    const run = await harness.submit(request, key);
    submissionLatencyMs.push(options.now().getTime() - submittedAt);
    executionId = run.executionId;
    rejected = executionId === "";
  } catch (error: unknown) {
    submissionLatencyMs.push(options.now().getTime() - submittedAt);
    rejected = true;
    void error;
  }
  if (rejected) {
    // The submission itself was rejected — an honest app failure with
    // NO outcome to reconcile (never a fabricated completion).
    return {
      evidence: harness.evidence(),
      passed: false,
      curveCriteria: [
        {
          criterionId: "submission-landed",
          strategy: "deterministic",
          status: "FAIL",
          evidence: ["rejection:the submission never landed a durable execution"],
        },
      ],
      observedTerminal: null,
      verificationStatuses: [],
      submissionLatencyMs,
    };
  }

  // ---- the completion phase (poll to the row's terminal) ----
  const observedTerminal = await harness.awaitCompletion(executionId);

  // ---- the result-retrieval phase (the verification statuses) ----
  const result = await harness.retrieveResult(executionId);
  const verificationStatuses =
    result === null ? [] : result.verification.map((entry) => entry.status as string);

  // ---- the assertion phase ----
  // 1. The harness's deterministic outcome assertions (the terminal
  //    contract; the forbidden opposite; no retryable errors).
  const harnessPassed = harness.assertOutcome({
    expectTerminalStatus: row.expected.terminal,
    forbiddenTerminalStatuses: [row.expected.terminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  // 2. The app-side economic contract (the VAL-040 derivation,
  //    imported): the terminal↔criteria agreement over the public
  //    result read (the anyFail→FAILED invariant probed at the
  //    customer boundary) + the expected terminal met.
  const curveCriteria = verifyEconomicAppContract({
    row: row as unknown as EconomicCorpusRow,
    terminal: observedTerminal,
    verificationStatuses,
  });
  const contractPassed = curveCriteria.every((criterion) => criterion.status === "PASS");

  return {
    evidence: harness.evidence(),
    passed: harnessPassed && contractPassed,
    curveCriteria,
    observedTerminal,
    verificationStatuses,
    submissionLatencyMs,
  };
}
