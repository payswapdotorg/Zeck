/**
 * The production-pilot customer application (VAL-051).
 *
 * A real customer-style application riding Zeck's public SDK boundary:
 * one pinned pilot corpus row per run — the row's DECLARED PILOT WINDOW
 * (its shift cardinality, span, drift tolerance and declared
 * divergences), its declared schedule of shifts (each REPLAYING the
 * recorded VAL-050 journey stages with their audited VAL-049 economics
 * carried as the cost basis), its operating profile (the window-wide
 * budget/policy envelope), its observation families under test and its
 * expected verdict — submitted through the public create boundary
 * under its OWN idempotency key. The application exercises the customer
 * side of the pilot contract:
 *
 *   * every row's submission lands ONE durable execution (the harness
 *     submit — the evidence carries the request fingerprint and the
 *     completion timeline);
 *   * the completion poll observes the row's terminal (COMPLETED for
 *     the honest pilot rows — the within-bounds replays, the
 *     exactly-once resumes, the honest drifting and regressing
 *     classifications alike, since the honest finding IS the verified
 *     outcome; FAILED for the seven adversarial probe rows whose
 *     dishonest window shapes FAIL their named criteria);
 *   * the result retrieval observes the verification statuses AND the
 *     pilot window package — and the app re-derives the EIGHT
 *     mechanical observation oracles AT THE BOUNDARY over the public
 *     result read (`drivePilotRow` — window honesty, schedule
 *     completeness, continuation exactly-once, drift-classification
 *     honesty, incident honesty, budget/policy envelope, end-of-window
 *     reconciliation, customer boundary — never trusting the platform's
 *     own claim);
 *   * the task body carries REFERENCES ONLY (the row id, the workload
 *     class, the declared window and schedule shape, the observation
 *     families) — never a price, never a recorded result copy;
 *   * the LIVE RAIL is honest: the one env-gated live row is NOT RUN
 *     without the credential (the env var named in the verdict and the
 *     evidence) — the offline world never fabricates a live pilot
 *     window, and the offline fake world refuses the live rail
 *     outright.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type { LabUsage, LabVerificationCriterion } from "../../platform/derive";
import type { EconomicCorpusRow } from "../economic-baseline/driver";
import { verifyEconomicAppContract } from "../economic-baseline/driver";
import type { PilotCorpusRow } from "./corpus";
import { liveGateOpen, PILOT_CORPUS, PILOT_TASK_KIND, submissionKey, taskBodyFor } from "./corpus";
import type { PilotVerdictKind, PilotWindowObservation } from "./driver";
import { drivePilotRow } from "./driver";

/** One pilot submission's observation (the app's own receipt view). */
export interface PilotSubmissionObservation {
  readonly executionId: string;
  readonly replayed: boolean;
  readonly status: string | null;
  readonly rejection: { readonly code: string; readonly status: number } | null;
  readonly submittedAt: number;
  readonly latencyMs: number;
}

/** The app's full run outcome (evidence + assertions + the pilot contract). */
export interface PilotAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  /** The app-side boundary contract criteria (the honest-vocabulary pins). */
  readonly appCriteria: readonly LabVerificationCriterion[];
  /** The eight mechanical observation criteria re-derived at the boundary. */
  readonly pilotCriteria: readonly LabVerificationCriterion[];
  /** The derived pilot verdict (PILOT-COMPLETED / PILOT-FAILED / NOT-RUN). */
  readonly verdict: PilotVerdictKind;
  /** The NOT-RUN reason (the env var named) — null otherwise. */
  readonly notRunReason: string | null;
  readonly submission: PilotSubmissionObservation | null;
  readonly observedTerminal: string | null;
  readonly verificationStatuses: readonly string[];
  readonly usage: LabUsage | null;
  readonly submissionLatencyMs: number;
}

/** The app's pinned corpus slice (`production-pilot.window.v1` rows). */
export const PILOT_TASKS = PILOT_CORPUS.map((row) => ({
  kind: PILOT_TASK_KIND,
  rowId: row.rowId,
  workloadClass: row.workloadClass,
  declaredShifts: row.window.declaredShifts,
  driftTolerancePct: row.window.driftTolerancePct,
  shifts: row.schedule.shifts.map((shift) => shift.journeyRowId),
  observationFamilies: [...row.observationFamilies],
  expectedVerdict: row.expected.verdict,
  expectedFailedCriteria: [...row.expected.failedCriteria],
  expectedTerminal: row.expected.terminal,
  ...(row.probe === undefined ? {} : { probe: row.probe.kind }),
  ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
}));

/**
 * Run the production-pilot application end to end over one pinned
 * corpus row: submit the pilot window task (under its OWN idempotency
 * key) → poll the run to its terminal → retrieve the result (the
 * verification statuses, the honest usage and the pilot window
 * package) → re-derive the eight observation oracles AT THE BOUNDARY →
 * the app-side pilot contract. The transport implementation is
 * injected (the SDK's seam); the app never selects provider/model or
 * rail (the platform keeps the route authority) and never re-prices a
 * recorded input (the shifts replay recorded workloads — the
 * re-measurement ban).
 */
export async function runPilotApp(options: {
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
  /** The environment the live gate consults (defaults to process.env). */
  readonly env?: NodeJS.ProcessEnv;
}): Promise<PilotAppResult> {
  const row = PILOT_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned production-pilot task slice is empty");
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
      workOrder: "VAL-051",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  // ---- the live-gate honesty (the env-gated row is NOT RUN without
  //      the credential — the env var NAMED, never a fabricated live
  //      pilot window) ----
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
            `NOT RUN: the live pilot slice demands the operator-authorized rail (${envVars} absent)`,
            "honestly not run, never a fake success",
          ],
        },
      ],
      pilotCriteria: [],
      verdict: "NOT-RUN",
      notRunReason: `NOT RUN: ${envVars} absent (the live pilot slice demands the operator-authorized rail)`,
      submission: null,
      observedTerminal: null,
      verificationStatuses: [],
      usage: null,
      submissionLatencyMs: 0,
    };
  }

  // ---- the submission phase (one submission per row) ----
  const key = submissionKey({ runSuffix: options.runSuffix, taskIndex: options.taskIndex });
  const body = taskBodyFor({ row });
  const request = { applicationId: options.config.applicationId, task: body };
  const submittedAt = options.now().getTime();
  let submission: PilotSubmissionObservation;
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
  if (submission.rejection !== null || submission.executionId === "") {
    // The submission itself was rejected — an honest app failure with
    // NO pilot window to reconcile (never a fabricated completion).
    return {
      evidence: harness.evidence(),
      passed: false,
      appCriteria: [
        {
          criterionId: "submission-landed",
          strategy: "deterministic",
          status: "FAIL",
          evidence: ["rejection:the submission never landed a durable execution"],
        },
      ],
      pilotCriteria: [],
      verdict: "PILOT-FAILED",
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
  const view = (result ?? {}) as Partial<{ pilot: PilotWindowObservation | null }>;
  const observation: PilotWindowObservation | null = view.pilot ?? null;

  // ---- the assertion phase ----
  // 1. The harness's deterministic outcome assertions (the run's
  //    terminal contract; the forbidden opposite; no retryable errors).
  const harnessPassed = harness.assertOutcome({
    expectTerminalStatus: row.expected.terminal,
    forbiddenTerminalStatuses: [row.expected.terminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  // 2. The app-side economic contract (the VAL-040 derivation,
  //    imported): the terminal↔criteria agreement over the public
  //    result read (the anyFail→FAILED invariant probed at the
  //    customer boundary) + the expected terminal met.
  const economicCriteria = verifyEconomicAppContract({
    row: row as unknown as EconomicCorpusRow,
    terminal: observedTerminal,
    verificationStatuses,
  });

  // 3. The app-side pilot contract (the boundary pins — the honest
  //    verdict vocabulary, the failed criteria NAMED, the usage
  //    honesty, the window package).
  const pilotAppCriteria = verifyPilotAppContract({
    row,
    submission,
    verificationStatuses,
    observation,
    usage,
  });

  // 4. The eight mechanical observation oracles re-derived AT THE
  //    BOUNDARY over the public result read (never trusting the
  //    platform's own claim).
  const derived =
    observation === null
      ? null
      : drivePilotRow({
          rowId: row.rowId,
          window: row.window,
          schedule: row.schedule,
          policy: row.operatingProfile,
          observation,
        });
  const contractPassed =
    economicCriteria.every((criterion) => criterion.status === "PASS") &&
    pilotAppCriteria.every((criterion) => criterion.status === "PASS");

  return {
    evidence: harness.evidence(),
    passed: harnessPassed && contractPassed,
    appCriteria: [...economicCriteria, ...pilotAppCriteria],
    pilotCriteria: derived?.criteria ?? [],
    verdict: derived?.terminal ?? "PILOT-FAILED",
    notRunReason: null,
    submission,
    observedTerminal,
    verificationStatuses,
    usage,
    submissionLatencyMs: submission.latencyMs,
  };
}

/**
 * The app-side pilot contract (the boundary pins): the submission
 * landed ONE fresh durable execution; the boundary-re-derived pilot
 * verdict matches the expected verdict with the failed criteria NAMED;
 * the pilot window package arrived over the public result read
 * (honestly labeled `derived-from-recorded-basis` offline — never a
 * fabricated measurement); the usage honesty holds (offline rows
 * honestly report none; the live row's usage is measured, never
 * fabricated).
 */
export function verifyPilotAppContract(input: {
  readonly row: PilotCorpusRow;
  readonly submission: PilotSubmissionObservation;
  readonly verificationStatuses: readonly string[];
  readonly observation: PilotWindowObservation | null;
  readonly usage: LabUsage | null;
}): readonly LabVerificationCriterion[] {
  const { row, submission, verificationStatuses, observation, usage } = input;
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

  // 2. The boundary-re-derived pilot verdict (the honest vocabulary).
  // A live-gated row only reaches this phase with its gate OPEN (the
  // closed gate returned the honest NOT-RUN above) — a driven live
  // pilot is expected to complete honestly (the NOT-RUN pin in the
  // corpus is the OFFLINE boundary of record).
  const drivenLive = row.liveGate !== undefined;
  const expectedVerdict = drivenLive ? "PILOT-COMPLETED" : row.expected.verdict;
  const derived =
    observation === null
      ? null
      : drivePilotRow({
          rowId: row.rowId,
          window: row.window,
          schedule: row.schedule,
          policy: row.operatingProfile,
          observation,
        });
  criteria.push({
    criterionId: "app-pilot-verdict",
    strategy: "deterministic",
    status: derived !== null && derived.terminal === expectedVerdict ? "PASS" : "FAIL",
    evidence: [`expected:${expectedVerdict}`, `observed:${derived?.terminal ?? "NO-OBSERVATION"}`],
  });

  // 3. The failed criteria NAMED (a PILOT-FAILED verdict names its
  //    failed criteria exactly; a PILOT-COMPLETED verdict names none).
  const expectedFailed = drivenLive ? [] : [...row.expected.failedCriteria].sort();
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

  // 4. The pilot window package: the window record arrived over the
  //    public result read, honestly labeled (the offline rows carry
  //    the derived-from-recorded-basis record — a re-measurement
  //    masquerading as pilot observation is the banned shape).
  const packageHonest =
    observation !== null && (row.needsDispatch ? observation.basis === "measured-live" : true);
  criteria.push({
    criterionId: "app-window-package",
    strategy: "deterministic",
    status: packageHonest ? "PASS" : "FAIL",
    evidence: [
      `package:${observation === null ? "absent" : "present"}`,
      `basis:${observation?.basis ?? "none"}`,
      `shifts:${observation?.shifts.length ?? 0}`,
      `criteria:${verificationStatuses.join(",") || "none"}`,
    ],
  });

  // 5. The usage honesty: offline rows honestly report no measured
  //    usage (the shifts replay recorded workloads — the economics are
  //    the recorded basis, never a fabricated measurement).
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
