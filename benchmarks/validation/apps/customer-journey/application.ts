/**
 * The customer-journey customer application (VAL-050).
 *
 * A real customer-style application riding Zeck's public SDK boundary:
 * one pinned journey corpus row per run — the row's END-TO-END
 * CUSTOMER JOURNEY (onboarding → intent → plan → daily usage over the
 * recorded application portfolio → outcome), its stage declarations
 * (the journey shape with the recorded input digests), its integrity
 * families under test and its expected verdict — submitted through
 * the public create boundary under its OWN idempotency key. The
 * application exercises the customer side of the journey contract:
 *
 *   * every row's submission lands ONE durable execution (the harness
 *     submit — the evidence carries the request fingerprint and the
 *     completion timeline); a declared re-issue row re-submits the
 *     IDENTICAL request under the SAME key and observes the replay
 *     (the same execution id, never a second execution);
 *   * the completion poll observes the row's terminal (COMPLETED for
 *     the honest journey rows; FAILED for the five adversarial probe
 *     rows whose dishonest journey shapes FAIL their named criteria);
 *   * the result retrieval observes the verification statuses AND the
 *     journey observation package — and the app re-derives the five
 *     mechanical integrity oracles AT THE BOUNDARY over the public
 *     result read (stage completeness, cross-stage idempotency,
 *     continuation exactly-once, customer boundary, accounting
 *     reconciliation — never trusting the platform's own claim);
 *   * the task body carries REFERENCES ONLY (the row id, the journey
 *     shape, the integrity families) — never a price, never a
 *     recorded result copy;
 *   * the LIVE RAIL is honest: the one env-gated live row is NOT RUN
 *     without the credential (the env var named in the verdict and
 *     the evidence) — the offline world never fabricates a live
 *     journey, and the offline fake world refuses the live rail
 *     outright.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type { LabUsage, LabVerificationCriterion } from "../../platform/derive";
import type { CustomerJourneyCorpusRow, JourneyVerdictKind } from "./corpus";
import {
  CUSTOMER_JOURNEY_CORPUS,
  journeySubmissionKey,
  journeyTaskBodyFor,
  liveGateOpen,
} from "./corpus";
import type { JourneyObservation } from "./driver";
import { deriveJourneyVerdict, verifyCustomerJourneyIntegrity } from "./driver";

/** One journey submission's observation (the app's own receipt view). */
export interface JourneySubmissionObservation {
  readonly executionId: string;
  readonly replayed: boolean;
  readonly status: string | null;
  readonly rejection: { readonly code: string; readonly status: number } | null;
  readonly submittedAt: number;
  readonly latencyMs: number;
}

/** The app's full run outcome (evidence + assertions + the journey contract). */
export interface CustomerJourneyAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  /** The app-side boundary contract criteria (the honest-vocabulary pins). */
  readonly appCriteria: readonly LabVerificationCriterion[];
  /** The five mechanical integrity criteria re-derived at the boundary. */
  readonly journeyCriteria: readonly LabVerificationCriterion[];
  /** The derived journey verdict (JOURNEY-COMPLETED / JOURNEY-FAILED / NOT-RUN). */
  readonly verdict: JourneyVerdictKind;
  /** The NOT-RUN reason (the env var named) — null otherwise. */
  readonly notRunReason: string | null;
  readonly submission: JourneySubmissionObservation | null;
  /** The idempotent re-issue receipt (the declared re-issue rows only). */
  readonly resubmission: { readonly executionId: string; readonly replayed: boolean } | null;
  readonly observedTerminal: string | null;
  readonly verificationStatuses: readonly string[];
  readonly usage: LabUsage | null;
  readonly submissionLatencyMs: number;
}

/** The app's pinned corpus slice (`customer-journey.lifecycle.v1` rows). */
export const CUSTOMER_JOURNEY_TASKS = CUSTOMER_JOURNEY_CORPUS.map((row) => ({
  kind: "customer-journey.lifecycle.v1",
  rowId: row.rowId,
  stages: row.stages.map((stage) => stage.stage),
  integrityFamilies: [...row.integrityFamilies],
  expectedVerdict: row.expected.verdict,
  expectedFailedCriteria: [...row.expected.failedCriteria],
  expectedTerminal: row.expected.terminal,
  ...(row.midJourneyFailureStage === undefined
    ? {}
    : { midJourneyFailureStage: row.midJourneyFailureStage }),
  ...(row.expectsResubmissionReplay === undefined
    ? {}
    : { expectsResubmissionReplay: row.expectsResubmissionReplay }),
  ...(row.probe === undefined ? {} : { probe: row.probe.kind }),
  ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
}));

/**
 * Run the customer-journey application end to end over one pinned
 * corpus row: submit the journey task (under its OWN idempotency
 * key) → poll the run to its terminal → retrieve the result (the
 * verification statuses, the honest usage and the journey observation
 * package) → re-derive the five integrity oracles AT THE BOUNDARY →
 * the app-side journey contract. The transport implementation is
 * injected (the SDK's seam); the app never selects provider/model or
 * rail (the platform keeps the route authority) and never re-prices
 * recorded inputs (the stages replay recorded workloads).
 */
export async function runCustomerJourneyApp(options: {
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
}): Promise<CustomerJourneyAppResult> {
  const row = CUSTOMER_JOURNEY_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned customer-journey task slice is empty");
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
      workOrder: "VAL-050",
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
  //      fabricated live journey) ----
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
            `NOT RUN: the live journey slice demands the operator-authorized rail (${envVars} absent)`,
          ],
        },
      ],
      journeyCriteria: [],
      verdict: "NOT-RUN",
      notRunReason: `NOT RUN: ${envVars} absent (the live journey slice demands the operator-authorized rail)`,
      submission: null,
      resubmission: null,
      observedTerminal: null,
      verificationStatuses: [],
      usage: null,
      submissionLatencyMs: 0,
    };
  }

  // ---- the submission phase (one submission per row) ----
  const key = journeySubmissionKey({ runSuffix: options.runSuffix, taskIndex: options.taskIndex });
  const body = journeyTaskBodyFor({ row });
  const request = { applicationId: options.config.applicationId, task: body };
  const submittedAt = options.now().getTime();
  let submission: JourneySubmissionObservation;
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
    // NO journey to reconcile (never a fabricated completion).
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
      journeyCriteria: [],
      verdict: "JOURNEY-FAILED",
      notRunReason: null,
      submission,
      resubmission: null,
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
  const view = (result ?? {}) as Partial<{ journey: JourneyObservation | null }>;
  const observation: JourneyObservation | null = view.journey ?? null;

  // ---- the idempotent re-issue phase (the declared rows only) ----
  let resubmission: { executionId: string; replayed: boolean } | null = null;
  if (row.expectsResubmissionReplay === true) {
    try {
      const replay = await harness.submit(request, key);
      resubmission = { executionId: replay.executionId, replayed: replay.replayed };
    } catch {
      resubmission = { executionId: "", replayed: false };
    }
  }

  // ---- the assertion phase ----
  // 1. The harness's deterministic outcome assertions (the run's
  //    terminal contract; the forbidden opposite; no retryable errors).
  const harnessPassed = harness.assertOutcome({
    expectTerminalStatus: row.expected.terminal,
    forbiddenTerminalStatuses: [row.expected.terminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  // 2. The app-side journey contract (the boundary pins — the honest
  //    vocabulary: the expected verdict, the failed criteria NAMED,
  //    the terminal↔statuses agreement, the usage honesty, the
  //    idempotent re-issue replay).
  const appCriteria = verifyCustomerJourneyAppContract({
    row,
    submission,
    resubmission,
    terminal: observedTerminal,
    verificationStatuses,
    observation,
    usage,
  });

  // 3. The five mechanical integrity oracles re-derived AT THE
  //    BOUNDARY over the public result read (never trusting the
  //    platform's own claim).
  const derived = observation === null ? null : deriveJourneyVerdict({ row, observation });
  const journeyCriteria =
    observation === null ? [] : verifyCustomerJourneyIntegrity({ row, observation });
  const verdict: JourneyVerdictKind = derived?.verdict ?? "JOURNEY-FAILED";
  const contractPassed = appCriteria.every((criterion) => criterion.status === "PASS");

  return {
    evidence: harness.evidence(),
    passed: harnessPassed && contractPassed,
    appCriteria,
    journeyCriteria,
    verdict,
    notRunReason: null,
    submission,
    resubmission,
    observedTerminal,
    verificationStatuses,
    usage,
    submissionLatencyMs: submission.latencyMs,
  };
}

/**
 * The app-side journey contract (the boundary pins): the submission
 * landed ONE fresh durable execution; the observed terminal matches
 * the expected terminal; the boundary-re-derived journey verdict
 * matches the expected verdict with the failed criteria NAMED; the
 * terminal↔criteria agreement holds (a COMPLETED terminal never
 * carries a FAIL status and a FAILED terminal always does); the usage
 * honesty holds (offline rows honestly report none; the live row's
 * usage is measured, never fabricated); the declared re-issue rows
 * replay (never double-create).
 */
export function verifyCustomerJourneyAppContract(input: {
  readonly row: CustomerJourneyCorpusRow;
  readonly submission: JourneySubmissionObservation;
  readonly resubmission: { readonly executionId: string; readonly replayed: boolean } | null;
  readonly terminal: string | null;
  readonly verificationStatuses: readonly string[];
  readonly observation: JourneyObservation | null;
  readonly usage: LabUsage | null;
}): readonly LabVerificationCriterion[] {
  const { row, submission, resubmission, terminal, verificationStatuses, observation, usage } =
    input;
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

  // 3. The boundary-re-derived journey verdict (the honest vocabulary).
  // A live-gated row only reaches this phase with its gate OPEN (the
  // closed gate returned the honest NOT-RUN above) — a driven live
  // journey is expected to complete honestly (the NOT-RUN pin in the
  // corpus is the OFFLINE boundary of record; the live lane's driven
  // expectation is the honest JOURNEY-COMPLETED).
  const drivenLive = row.liveGate !== undefined;
  const expectedVerdict = drivenLive ? "JOURNEY-COMPLETED" : row.expected.verdict;
  const expectedFailedDrivenLive: readonly string[] = drivenLive ? [] : row.expected.failedCriteria;
  const derived = observation === null ? null : deriveJourneyVerdict({ row, observation });
  criteria.push({
    criterionId: "app-journey-verdict",
    strategy: "deterministic",
    status: derived !== null && derived.verdict === expectedVerdict ? "PASS" : "FAIL",
    evidence: [`expected:${expectedVerdict}`, `observed:${derived?.verdict ?? "NO-OBSERVATION"}`],
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
  //    usage (the stages replay recorded workloads — the economics
  //    are the recorded basis, never a fabricated measurement).
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

  // 7. The idempotent re-issue replay (the declared rows only): the
  //    identical request under the same key replays the original
  //    execution — never a second durable execution.
  if (row.expectsResubmissionReplay === true) {
    criteria.push({
      criterionId: "app-resubmission-replay",
      strategy: "deterministic",
      status:
        resubmission !== null &&
        resubmission.replayed === true &&
        resubmission.executionId === submission.executionId
          ? "PASS"
          : "FAIL",
      evidence: [
        `original:${submission.executionId}`,
        `reissue:${resubmission === null ? "none" : resubmission.executionId || "none"}`,
        `replayed:${resubmission?.replayed ?? false}`,
      ],
    });
  }

  return criteria;
}
