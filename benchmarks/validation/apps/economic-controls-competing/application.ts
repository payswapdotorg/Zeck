/**
 * The economic-controls-competing customer application (VAL-043).
 *
 * A real customer-style application: one pinned competing-stack
 * corpus row per run — the row's ARM MANIFEST ENTRY (the arm kind, the
 * pinned price revision, the DECLARED COMPETITOR CONFIGURATION
 * revision, the pre-registered slice shape, the statistical minimums,
 * the pinned threshold-or-budget REFERENCE) and the FROZEN PORTFOLIO
 * reference (digests only) — submitted through Zeck's public SDK
 * boundary. The application exercises the customer side of the
 * competing-stack economics contract:
 *
 *   * every row's submission lands ONE durable execution (the harness
 *     submit — the evidence carries the request fingerprint and the
 *     completion timeline);
 *   * the completion poll observes the row's terminal (COMPLETED for
 *     the honest protocol-conformant rows; FAILED when any mechanical
 *     criterion failed — the honest failure is the verified outcome);
 *   * the result retrieval observes the verification statuses — the
 *     app-side terminal↔criteria agreement is derived MECHANICALLY
 *     over the public result read (a fabricated pass-with-fail — a
 *     COMPLETED terminal with a FAIL verification status — FAILs the
 *     app honestly: the anyFail→FAILED invariant probed at the
 *     customer boundary);
 *   * the task body carries REFERENCES ONLY (the arm identity, the
 *     pinned price revision, the competitor configuration revision,
 *     the frozen-portfolio digest) — never an inline list price,
 *     never a configuration bound (the platform resolves pricing
 *     through the manifest and the competitor configuration through
 *     the registry).
 *
 * The application's own assertions verify the per-row outcome contract
 * through the VAL-040 app-contract derivation (imported, never
 * copied) — a fabricated outcome never passes a row whose outcome
 * contract is violated.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type { LabVerificationCriterion } from "../../platform/derive";
import { verifyEconomicAppContract } from "../economic-baseline/driver";
import { COMPETING_CORPUS, submissionKey, taskBodyFor } from "./corpus";

/** The app's full run outcome (evidence + assertions + outcome contract). */
export interface CompetingAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly competingCriteria: readonly LabVerificationCriterion[];
  /** The observed terminal from the public execution read. */
  readonly observedTerminal: string | null;
  /** The verification statuses from the public result read. */
  readonly verificationStatuses: readonly string[];
  /** The measured submission latency (ms). */
  readonly submissionLatencyMs: readonly number[];
}

/** The app's pinned corpus slice (`economic-controls-competing.experiment.v1` rows). */
export const COMPETING_TASKS = COMPETING_CORPUS.map((row) => ({
  kind: "economic-controls-competing.experiment.v1",
  rowId: row.rowId,
  expectedTerminal: row.expected.terminal,
  armId: row.arm.armId,
  armKind: row.arm.kind,
  priceRevision: row.arm.priceRevision,
  competitorConfigRevision: row.competitorConfigRevision,
  sliceSize: row.arm.corpusSlice.length,
  minimumSamples: row.arm.minimumSamples,
  ...(row.arm.kind === "fixed-quality"
    ? { pinnedThreshold: row.arm.pinnedThreshold.resolutionRate }
    : { pinnedBudgetMicroUsd: row.arm.pinnedBudgetMicroUsd }),
  ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
  appCreated: row.expected.appCreated,
  replayedSubmissions: row.expected.replayedSubmissions,
  rejectedSubmissions: row.expected.rejectedSubmissions,
}));

/**
 * Run the economic-controls-competing application end to end over one
 * pinned corpus row: submit → poll to the row's terminal → retrieve
 * the result (the verification statuses) → the deterministic assertions
 * → the app-side economic contract. The transport implementation is
 * injected (the SDK's seam); the app never selects pricing or the
 * competitor configuration (the arm declares the pinned revisions; the
 * platform resolves them).
 */
export async function runCompetingApp(options: {
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
}): Promise<CompetingAppResult> {
  const row = COMPETING_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned competing-stack task slice is empty");
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
      workOrder: "VAL-043",
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
      competingCriteria: [
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
  const competingCriteria = verifyEconomicAppContract({
    row,
    terminal: observedTerminal,
    verificationStatuses,
  });
  const contractPassed = competingCriteria.every((criterion) => criterion.status === "PASS");

  return {
    evidence: harness.evidence(),
    passed: harnessPassed && contractPassed,
    competingCriteria,
    observedTerminal,
    verificationStatuses,
    submissionLatencyMs,
  };
}
