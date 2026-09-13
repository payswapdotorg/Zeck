/**
 * The substrate-failure customer application (VAL-022).
 *
 * A real customer-style application: one pinned substrate-failure
 * corpus row per run — sandbox unavailability at submission,
 * mid-execution sandbox loss, the genuine substrate deadline timeout,
 * the OOM-killed sandbox, the task's own failure, the unwired
 * substrate, the healthy/recovery rows and the quarantine propagation
 * row — submitted through Zeck's public SDK boundary. The platform
 * drives the readiness-gated dispatch machinery with the fresh-sandbox
 * retry policy and the strike/quarantine state; this application
 * asserts the per-submission deterministic outcome contract from the
 * corpus: a failure submission must land the corpus-declared honest
 * FAILED terminal (a COMPLETED there would mean a fabricated
 * recovery); the healthy and recovery submissions must COMPLETED (a
 * FAILED there would mean a fabricated failure); the gated submission
 * must FAIL having never touched the substrate.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import { SUBSTRATE_FAILURE_CORPUS, taskBodyForSubmission } from "./corpus";

/** The app's pinned corpus slice (`substrate-failure.probe.v1` rows, per submission). */
export const SUBSTRATE_FAILURE_TASKS = SUBSTRATE_FAILURE_CORPUS.flatMap((row) =>
  row.oracle.submissions.map((submission, submissionIndex) => ({
    kind: "substrate-probe" as const,
    scenario: row.rowId,
    submission: submissionIndex + 1,
    /** The submission's own expected terminal (the app's outcome contract). */
    expectedTerminal: submission.terminal,
  })),
);

/** One submission's observed outcome contract. */
export interface SubstrateSubmissionOutcome {
  readonly scenario: string;
  readonly submission: number;
  readonly executionId: string | null;
  readonly terminal: string | null;
  readonly passed: boolean;
  readonly evidence: HarnessEvidence;
}

export interface SubstrateFailureAppResult {
  /** The primary (last-submission) evidence record. */
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly submissions: readonly SubstrateSubmissionOutcome[];
}

const IDEMPOTENCY_PREFIX = "val-022-substrate-failure";

/**
 * Run the substrate-failure application end to end over one pinned
 * corpus row. The transport implementation is injected (the SDK's
 * seam); the app never selects substrate/provider/model (the
 * platform's authority). Multi-submission rows submit sequentially —
 * each future submission is the propagation/recovery probe of the
 * substrate state the earlier submissions left behind.
 */
export async function runSubstrateFailureApp(options: {
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
}): Promise<SubstrateFailureAppResult> {
  const row = SUBSTRATE_FAILURE_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned substrate-failure task slice is empty");
  }
  const submissions: SubstrateSubmissionOutcome[] = [];
  let passed = true;

  for (
    let submissionIndex = 0;
    submissionIndex < row.oracle.submissions.length;
    submissionIndex += 1
  ) {
    const submissionOracle = row.oracle.submissions[submissionIndex];
    if (submissionOracle === undefined) {
      throw new Error(`corpus row ${row.rowId} has no submission ${submissionIndex + 1}`);
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
        workOrder: "VAL-022",
        baseRevision: options.config.corpusRevision,
        applicationRevision: options.config.applicationRevision,
        corpusRevision: options.config.corpusRevision,
        integrationSurface: options.config.integrationSurface,
      },
      pollIntervalMs: options.config.pollIntervalMs,
      completionTimeoutMs: options.config.completionTimeoutMs,
    });
    const submitted = await harness.submit(
      {
        applicationId: options.config.applicationId,
        task: taskBodyForSubmission(row, submissionIndex),
      },
      `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}-${submissionIndex + 1}`,
    );
    await harness.awaitCompletion(submitted.executionId);
    await harness.retrieveResult(submitted.executionId);

    // The deterministic outcome contract per submission: failure
    // submissions EXPECT the honest FAILED terminal (a fabricated
    // COMPLETED fails the app); the healthy and recovery submissions
    // expect COMPLETED (a fabricated FAILED fails the app likewise).
    const submissionPassed = harness.assertOutcome({
      expectTerminalStatus: submissionOracle.terminal,
      expectVerificationStatuses: ["PASS"],
      forbiddenTerminalStatuses: [
        submissionOracle.terminal === "COMPLETED" ? "FAILED" : "COMPLETED",
      ],
      forbidRetryableErrors: true,
    });
    submissions.push({
      scenario: row.rowId,
      submission: submissionIndex + 1,
      executionId: submitted.executionId,
      terminal: submissionOracle.terminal,
      passed: submissionPassed,
      evidence: harness.evidence(),
    });
    if (!submissionPassed) {
      passed = false;
    }
  }

  const primary = submissions[submissions.length - 1];
  if (primary === undefined) {
    throw new Error("the pinned substrate-failure task slice is empty");
  }
  return { evidence: primary.evidence, passed, submissions };
}
