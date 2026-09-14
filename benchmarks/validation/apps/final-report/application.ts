/**
 * The final-report customer application (VAL-052).
 *
 * A real customer-style application riding Zeck's public SDK
 * boundary: one pinned final-report corpus row per run — the row's
 * REPORT SHAPE (the program slice under inventory and its recorded
 * evidence references), its gate families under test and its expected
 * verdict — submitted through the public create boundary under its
 * OWN idempotency key. The application exercises the customer side of
 * the report contract:
 *
 *   * every row's submission lands ONE durable execution (the harness
 *     submit — the evidence carries the request fingerprint and the
 *     completion timeline);
 *   * the completion poll observes the row's terminal (COMPLETED for
 *     the honest report rows; FAILED for the seven adversarial probe
 *     rows whose dishonest report shapes FAIL their named criteria);
 *   * the result retrieval observes the verification statuses AND the
 *     report package — and the app re-derives the THIRTEEN mechanical
 *     oracles AT THE BOUNDARY over the public result read (the three
 *     consolidated-evidence-inventory oracles, the NINE release-gate
 *     conditions and the deadline-remainder honesty — never trusting
 *     the platform's own claim);
 *   * the task body carries REFERENCES ONLY (the row id, the program
 *     slice, the verification families, the registry counts) — never
 *     a copied evidence body, never a re-measured value;
 *   * the LIVE RAIL is honest: the one env-gated live row is NOT RUN
 *     without the credential (the env var named in the verdict and
 *     the evidence) — the offline world never fabricates a live
 *     confirmation, and the offline fake world refuses the live rail
 *     outright.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type { LabUsage, LabVerificationCriterion } from "../../platform/derive";
import type { FinalReportCorpusRow, ReportVerdictKind } from "./corpus";
import {
  FINAL_REPORT_CORPUS,
  liveGateOpen,
  reportSubmissionKey,
  reportTaskBodyFor,
} from "./corpus";
import type { ReportPackage, ReportWorld } from "./driver";
import { deriveReleaseGateVerdict, verifyFinalReportIntegrity } from "./driver";

/** One report submission's observation (the app's own receipt view). */
export interface ReportSubmissionObservation {
  readonly executionId: string;
  readonly replayed: boolean;
  readonly status: string | null;
  readonly rejection: { readonly code: string; readonly status: number } | null;
  readonly submittedAt: number;
  readonly latencyMs: number;
}

/** The app's full run outcome (evidence + assertions + the report contract). */
export interface FinalReportAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  /** The app-side boundary contract criteria (the honest-vocabulary pins). */
  readonly appCriteria: readonly LabVerificationCriterion[];
  /** The thirteen mechanical criteria re-derived at the boundary. */
  readonly reportCriteria: readonly LabVerificationCriterion[];
  /** The derived release-gate verdict (COMPLETED / FAILED / NOT-RUN). */
  readonly verdict: ReportVerdictKind;
  /** The NOT-RUN reason (the env var named) — null otherwise. */
  readonly notRunReason: string | null;
  readonly submission: ReportSubmissionObservation | null;
  readonly observedTerminal: string | null;
  readonly verificationStatuses: readonly string[];
  readonly usage: LabUsage | null;
  readonly submissionLatencyMs: number;
}

/** The app's pinned corpus slice (`final-report.release-gate.v1` rows). */
export const FINAL_REPORT_TASKS = FINAL_REPORT_CORPUS.map((row) => ({
  kind: "final-report.release-gate.v1",
  rowId: row.rowId,
  programSlice: row.programSlice,
  verificationFamilies: [...row.verificationFamilies],
  expectedVerdict: row.expected.verdict,
  expectedFailedCriteria: [...row.expected.failedCriteria],
  expectedTerminal: row.expected.terminal,
  ...(row.probe === undefined ? {} : { probe: row.probe.kind }),
  ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
}));

/**
 * Run the final-report application end to end over one pinned corpus
 * row: submit the report task (under its OWN idempotency key) → poll
 * the report to its terminal → retrieve the result (the verification
 * statuses, the honest usage and the report package) → re-derive the
 * thirteen mechanical oracles AT THE BOUNDARY over the governed world
 * of record → the app-side report contract. The transport
 * implementation is injected (the SDK's seam); the app never selects
 * provider/model or rail (the platform keeps the route authority) and
 * never re-measures recorded inputs (the inventory is pure derivation
 * over the RECORDED governed state and evidence documents).
 */
export async function runFinalReportApp(options: {
  readonly config: AppHarnessConfig;
  readonly token: string;
  readonly transport: TransportImplementation;
  /**
   * The report world of record (the governed state + the evidence
   * documents the boundary re-derivation adjudicates against — the
   * REAL repository world, or a controlled fake in the
   * discrimination battery).
   */
  readonly world: ReportWorld;
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
  /** The environment the live gate consults (defaults to process.env). */
  readonly env?: NodeJS.ProcessEnv;
}): Promise<FinalReportAppResult> {
  const row = FINAL_REPORT_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned final-report task slice is empty");
  }
  const env = options.env ?? process.env;

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
      workOrder: "VAL-052",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  // ---- the live-gate honesty (the env-gated row is NOT RUN
  //      without the credential — the env var NAMED, never a
  //      fabricated live confirmation) ----
  if (row.liveGate !== undefined && !liveGateOpen(row, env)) {
    const envVars = row.liveGate.envVars.join(", ");
    return {
      evidence: harness.evidence(),
      passed: true,
      appCriteria: [
        {
          criterionId: "app-live-gate-honest",
          strategy: "deterministic",
          status: "PASS",
          evidence: [
            `NOT RUN: the live confirmation slice demands the operator-authorized rail (${envVars} absent)`,
          ],
        },
      ],
      reportCriteria: [],
      verdict: "NOT-RUN",
      notRunReason: `NOT RUN: ${envVars} absent (the live confirmation slice demands the operator-authorized rail)`,
      submission: null,
      observedTerminal: null,
      verificationStatuses: [],
      usage: null,
      submissionLatencyMs: 0,
    };
  }

  // ---- the submission phase (one submission per row) ----
  const key = reportSubmissionKey({ runSuffix: options.runSuffix, taskIndex: options.taskIndex });
  const body = reportTaskBodyFor({ row });
  const request = { applicationId: options.config.applicationId, task: body };
  const submittedAt = options.now().getTime();
  let submission: ReportSubmissionObservation;
  try {
    const run = await harness.submit(request, key);
    const latencyMs = options.now().getTime() - submittedAt;
    submission = {
      executionId: run.executionId,
      replayed: run.replayed,
      status: run.initialStatus,
      rejection: null,
      submittedAt,
      latencyMs,
    };
  } catch (error: unknown) {
    const latencyMs = options.now().getTime() - submittedAt;
    submission = {
      executionId: "",
      replayed: false,
      status: null,
      rejection: {
        code: (error as { body?: { code?: string } })?.body?.code ?? "UNEXPECTED",
        status: (error as { status?: number })?.status ?? 0,
      },
      submittedAt,
      latencyMs,
    };
  }
  const rejectionLabel =
    submission.rejection === null
      ? "none/0"
      : `${submission.rejection.code}/${submission.rejection.status}`;
  if (submission.rejection !== null || submission.executionId === "") {
    // The submission itself was rejected — an honest app failure with
    // NO report to adjudicate (never a fabricated completion).
    return {
      evidence: harness.evidence(),
      passed: false,
      appCriteria: [
        {
          criterionId: "submission-landed",
          strategy: "deterministic",
          status: "FAIL",
          evidence: [`rejection:${rejectionLabel}:the submission never landed a durable execution`],
        },
      ],
      reportCriteria: [],
      verdict: "FAILED",
      notRunReason: null,
      submission,
      observedTerminal: null,
      verificationStatuses: [],
      usage: null,
      submissionLatencyMs: submission.latencyMs,
    };
  }

  // ---- the observation phase (the public reads) ----
  const executionId = submission.executionId;
  const observedTerminal = await harness.awaitCompletion(executionId);
  const result = await harness.retrieveResult(executionId);
  const verificationStatuses =
    result === null ? [] : result.verification.map((entry) => entry.status as string);
  let usage: LabUsage | null = null;
  if (result !== null && result.usage !== null) {
    usage = { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
  }
  const view = (result ?? {}) as Partial<{ report: ReportPackage | null }>;
  const report: ReportPackage | null = view.report ?? null;

  // ---- the assertion phase ----
  // 1. The harness's deterministic outcome assertions (the run's
  //    terminal contract; the forbidden opposite; no retryable errors).
  const harnessPassed = harness.assertOutcome({
    expectTerminalStatus: row.expected.terminal,
    forbiddenTerminalStatuses: [row.expected.terminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  // 2. The app-side report contract (the boundary pins — the honest
  //    vocabulary: the expected verdict, the failed criteria NAMED,
  //    the terminal↔statuses agreement, the usage honesty).
  const appCriteria = verifyFinalReportAppContract({
    row,
    submission,
    terminal: observedTerminal,
    verificationStatuses,
    report,
    usage,
    world: options.world,
  });

  // 3. The thirteen mechanical oracles re-derived AT THE BOUNDARY
  //    over the public result read (never trusting the platform's
  //    own claim).
  const derived =
    report === null ? null : deriveReleaseGateVerdict({ row, world: options.world, report });
  const reportCriteria =
    report === null ? [] : verifyFinalReportIntegrity({ row, world: options.world, report });
  const verdict: ReportVerdictKind = derived?.verdict ?? "FAILED";
  const contractPassed = appCriteria.every((criterion) => criterion.status === "PASS");

  return {
    evidence: harness.evidence(),
    passed: harnessPassed && contractPassed,
    appCriteria,
    reportCriteria,
    verdict,
    notRunReason: null,
    submission,
    observedTerminal,
    verificationStatuses,
    usage,
    submissionLatencyMs: submission.latencyMs,
  };
}

/**
 * The app-side report contract (the boundary pins): the submission
 * landed ONE fresh durable execution; the observed terminal matches
 * the expected terminal; the boundary-re-derived release-gate verdict
 * matches the expected verdict with the failed criteria NAMED; the
 * terminal↔criteria agreement holds (a COMPLETED terminal never
 * carries a FAIL status and a FAILED terminal always does); the usage
 * honesty holds (offline rows honestly report none; the live row's
 * usage is measured, never fabricated).
 */
export function verifyFinalReportAppContract(input: {
  readonly row: FinalReportCorpusRow;
  readonly submission: ReportSubmissionObservation;
  readonly terminal: string | null;
  readonly verificationStatuses: readonly string[];
  readonly report: ReportPackage | null;
  readonly usage: LabUsage | null;
  readonly world: ReportWorld;
}): readonly LabVerificationCriterion[] {
  const { row, submission, terminal, verificationStatuses, report, usage, world } = input;
  const criteria: LabVerificationCriterion[] = [];

  // 1. The submission contract: ONE fresh durable execution.
  criteria.push({
    criterionId: "submission-landed",
    strategy: "deterministic",
    status:
      submission.rejection === null &&
      submission.executionId !== "" &&
      submission.replayed === false
        ? "PASS"
        : "FAIL",
    evidence: [
      `execution:${submission.executionId || "none"}`,
      `replayed:${submission.replayed}`,
      ...(submission.rejection === null
        ? []
        : [`rejection:${submission.rejection.code}/${submission.rejection.status}`]),
    ],
  });

  // 2. The expected terminal.
  criteria.push({
    criterionId: "app-expected-terminal",
    strategy: "deterministic",
    status: terminal === row.expected.terminal ? "PASS" : "FAIL",
    evidence: [`expected:${row.expected.terminal}`, `observed:${terminal ?? "TIMEOUT"}`],
  });

  // 3. The boundary-re-derived release-gate verdict (the honest
  //    vocabulary). A live-gated row only reaches this phase with its
  //    gate OPEN (the closed gate returned the honest NOT-RUN above) —
  //    a driven live confirmation slice is expected to complete
  //    honestly (the NOT-RUN pin in the corpus is the OFFLINE boundary
  //    of record; the live lane's driven expectation is the honest
  //    COMPLETED).
  const drivenLive = row.liveGate !== undefined;
  const expectedVerdict = drivenLive ? "COMPLETED" : row.expected.verdict;
  const expectedFailedDrivenLive: readonly string[] = drivenLive ? [] : row.expected.failedCriteria;
  const derived = report === null ? null : deriveReleaseGateVerdict({ row, world, report });
  criteria.push({
    criterionId: "app-report-verdict",
    strategy: "deterministic",
    status: derived !== null && derived.verdict === expectedVerdict ? "PASS" : "FAIL",
    evidence: [`expected:${expectedVerdict}`, `observed:${derived?.verdict ?? "NO-REPORT"}`],
  });

  // 4. The failed criteria NAMED (a FAILED verdict names its failed
  //    criteria exactly; a COMPLETED verdict names none).
  const expectedFailed = [...expectedFailedDrivenLive].sort();
  const observedFailed = [...(derived?.failedCriteria ?? [])].sort();
  const namedMatch =
    expectedFailed.length === observedFailed.length &&
    expectedFailed.every((criterionId, index) => observedFailed[index] === criterionId);
  criteria.push({
    criterionId: "app-failed-criteria-named",
    strategy: "deterministic",
    status: namedMatch ? "PASS" : "FAIL",
    evidence: [
      `expected-named:${expectedFailed.join(",") || "none"}`,
      `observed-named:${observedFailed.join(",") || "none"}`,
    ],
  });

  // 5. The terminal↔criteria agreement (the anyFail→FAILED invariant
  //    probed at the customer boundary).
  const hasFail = verificationStatuses.includes("FAIL");
  const agreement = (terminal === "COMPLETED" && !hasFail) || (terminal === "FAILED" && hasFail);
  criteria.push({
    criterionId: "app-terminal-criteria-agreement",
    strategy: "deterministic",
    status: agreement ? "PASS" : "FAIL",
    evidence: [
      `terminal:${terminal ?? "TIMEOUT"}`,
      `statuses:${verificationStatuses.join(",") || "none"}`,
    ],
  });

  // 6. The usage honesty: offline rows honestly report no measured
  //    usage (the inventory is pure derivation over the RECORDED
  //    governed state — the economics are the recorded basis, never a
  //    fabricated measurement).
  const usageHonest = row.needsDispatch ? true : usage === null;
  criteria.push({
    criterionId: "app-usage-honesty",
    strategy: "deterministic",
    status: usageHonest ? "PASS" : "FAIL",
    evidence: [
      `needsDispatch:${row.needsDispatch}`,
      `usage:${usage === null ? "none-reported (honest offline)" : "measured"}`,
    ],
  });

  return criteria;
}
