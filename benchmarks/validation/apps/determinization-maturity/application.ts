/**
 * The determinization-maturity customer application (VAL-036).
 *
 * A real customer-style application riding Zeck's public SDK
 * boundary: one pinned maturity corpus row per run — the workload
 * family's LONGITUDINAL HISTORY (the recorded lifecycle + generation
 * + accounting evidence VAL-032..035 produced, the read-only input)
 * analyzed across its promotion generations, submitted as a
 * DETERMINIZATION-MATURITY task (the app never selects
 * provider/model/rail — the platform keeps the route authority). The
 * application exercises the maturity contract at the customer
 * boundary in three phases:
 *
 *   * the submission phase — the row's analysis lands its OWN durable
 *     execution through the harness submit under its OWN idempotency
 *     key (one submission per row);
 *   * the observation phase — the completion poll observes the run's
 *     honest terminal (COMPLETED for an established analysis or an
 *     honest immaturity), the result retrieval observes the
 *     verification statuses, the route's model-call count (zero
 *     offline — the offline analysis is digest-level; the live row's
 *     REAL measured round), the honest usage (measured on the live
 *     rail, honestly none offline), the classification read back, the
 *     refusal reason read back, the curve series read back (the
 *     generation points with their measured facts), the savings
 *     attribution read back, the report-recorded flag, and the events
 *     read re-derives the maturity trajectory digest over the PUBLIC
 *     step-event journal (the app never trusts the platform's own
 *     claim);
 *   * the assertion phase — the app's own assertions verify the
 *     per-row maturity contract through the platform slice's PURE
 *     `verifyDeterminizationMaturityAppContract`: the read-back
 *     classification matches the claimed classification AND the
 *     boundary re-derivation of the classification fidelity over the
 *     read-back curve series, the curve-series integrity is
 *     re-derived at the boundary (a gapped or extrapolated series
 *     never passes), the savings reconciliation is re-derived at the
 *     boundary (an aggregate-only or mismatched number never passes),
 *     the report landing matches the expected verdict, the run made
 *     its own dispatches, and the refusal read-back matches the
 *     pinned oracle.
 */

import { createZeckClient, ZeckApiError } from "../../../../sdk";
import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type { LabUsage, LabVerificationCriterion } from "../../platform/derive";
import type { AppMaturityObservation } from "../../platform/determinization-maturity";
import { verifyDeterminizationMaturityAppContract } from "../../platform/determinization-maturity";
import { appTrajectoryDigestOf } from "../../platform/longitudinal-baseline";
import {
  DETERMINIZATION_MATURITY_CORPUS,
  DETERMINIZATION_MATURITY_TASK_KIND,
  maturitySubmissionKey,
  maturityTaskBodyFor,
} from "./corpus";

/** One maturity submission's observation (the app's own receipt view). */
export interface MaturitySubmissionObservation {
  readonly executionId: string;
  readonly replayed: boolean;
  readonly status: string | null;
  readonly rejection: { readonly code: string; readonly status: number } | null;
  readonly submittedAt: number;
  readonly latencyMs: number;
}

/** The app's full run outcome (evidence + assertions + the maturity contract). */
export interface DeterminizationMaturityAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly appCriteria: readonly LabVerificationCriterion[];
  readonly submission: MaturitySubmissionObservation;
  readonly observedTerminal: string | null;
  readonly verificationStatuses: readonly string[];
  readonly classification: string | null;
  readonly refusalReason: string | null;
  readonly curveSeries: readonly {
    readonly generation: number;
    readonly displacedModelCalls: number;
    readonly measuredCostMicroUsd: number;
    readonly measuredLatencyMs: number;
    readonly measured: boolean;
    readonly pointSource: string;
    readonly generationDigest: string;
    readonly lifecycleProposalIds: readonly string[];
  }[];
  readonly savings: {
    readonly totalMicroUsd: number;
    readonly perMechanism: Readonly<Record<string, number>> | null;
  } | null;
  readonly reportRecorded: boolean;
  readonly observedModelCalls: number | null;
  readonly trajectoryDigest: string | null;
  readonly usage: LabUsage | null;
  readonly submissionLatencyMs: number;
}

/** The app's pinned corpus slice (the maturity task declarations). */
export const DETERMINIZATION_MATURITY_TASKS = DETERMINIZATION_MATURITY_CORPUS.map((row) => ({
  kind: DETERMINIZATION_MATURITY_TASK_KIND,
  rowId: row.rowId,
  familyId: row.familyId,
  generations: row.curveSeries.length,
  citedLifecycle: row.citation.lifecycleProposalIds.length,
  citedGenerationDigests: row.citation.generationDigests.length,
  citedAccountingDigests: row.citation.accountingEntryDigests.length,
  claimedClassification: row.claimedClassification,
  claimedSavingsTotalMicroUsd: row.claimedSavings.totalMicroUsd,
  perMechanismBreakdown: row.claimedSavings.perMechanism !== null,
  expectedVerdict: row.expected.verdict,
  expectedRefusalReason: row.expected.refusalReason,
  expectedTerminal: row.expected.terminal,
  expectedModelCalls: row.expected.modelCalls,
  ...(row.probe === undefined ? {} : { probe: row.probe.kind }),
  ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
}));

/**
 * Run the determinization-maturity application end to end over one
 * pinned corpus row: submit the maturity task (under its OWN
 * idempotency key) → poll the run to its terminal → retrieve the
 * result (the verification statuses, the route's model-call count,
 * the honest usage, the classification, the refusal reason, the curve
 * series, the savings attribution, the report record) → read the
 * events (the app-side maturity trajectory digest over the public
 * journal) → verify the per-row maturity contract. The transport
 * implementation is injected (the SDK's seam); the app never selects
 * provider/model/rail (the platform's authority).
 */
export async function runDeterminizationMaturityApp(options: {
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
}): Promise<DeterminizationMaturityAppResult> {
  const row = DETERMINIZATION_MATURITY_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned determinization-maturity task slice is empty");
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
      workOrder: "VAL-036",
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

  // ---- the submission phase (one submission per row) ----
  const key = maturitySubmissionKey({
    runSuffix: options.runSuffix,
    taskIndex: options.taskIndex,
  });
  const body = maturityTaskBodyFor({ rowId: row.rowId, familyId: row.familyId });
  const request = { applicationId: options.config.applicationId, task: body };
  const submittedAt = options.now().getTime();
  let submission: MaturitySubmissionObservation;
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
        code: error instanceof ZeckApiError ? error.body.code : "UNEXPECTED",
        status: error instanceof ZeckApiError ? error.status : 0,
      },
      submittedAt,
      latencyMs,
    };
  }

  // ---- the observation phase (the public reads) ----
  let observedTerminal: string | null = null;
  let verificationStatuses: readonly string[] = [];
  let classification: string | null = null;
  let refusalReason: string | null = null;
  let curveSeries: DeterminizationMaturityAppResult["curveSeries"] = [];
  let savings: DeterminizationMaturityAppResult["savings"] = null;
  let reportRecorded = false;
  let observedModelCalls: number | null = null;
  let usage: LabUsage | null = null;
  let trajectoryDigest: string | null = null;
  if (submission.rejection === null && submission.executionId !== "") {
    const executionId = submission.executionId;
    observedTerminal = await harness.awaitCompletion(executionId);

    const result = await harness.retrieveResult(executionId);
    verificationStatuses =
      result === null ? [] : result.verification.map((entry) => entry.status as string);
    observedModelCalls = result === null ? null : (result.route?.modelCalls ?? null);
    if (result !== null && result.usage !== null) {
      usage = {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      };
    }
    const view = (result ?? {}) as Partial<{
      classification: string | null;
      refusalReason: string | null;
      curveSeries: DeterminizationMaturityAppResult["curveSeries"];
      savings: DeterminizationMaturityAppResult["savings"];
      reportRecorded: boolean;
    }>;
    classification = view.classification ?? null;
    refusalReason = view.refusalReason ?? null;
    curveSeries = view.curveSeries ?? [];
    savings = view.savings ?? null;
    reportRecorded = view.reportRecorded ?? false;

    // The events read: the app mechanically re-derives the maturity
    // trajectory digest over the PUBLIC step-event journal — never
    // trusting the platform's claim.
    try {
      const events = await client.listEvents(executionId);
      trajectoryDigest = appTrajectoryDigestOf(
        events.map((event) => ({ type: event.type, sequence: event.sequence })),
      );
    } catch {
      trajectoryDigest = null;
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

  // 2. The app-side maturity contract (PURE): the boundary
  //    re-derivations — never trusting the platform's claim.
  const observation: AppMaturityObservation = {
    executionId: submission.executionId,
    replayed: submission.replayed,
    rejection: submission.rejection === null ? null : { code: submission.rejection.code },
    terminal: observedTerminal,
    verificationStatuses,
    classification,
    refusalReason,
    curveSeries,
    savings:
      savings === null
        ? null
        : {
            totalMicroUsd: savings.totalMicroUsd,
            perMechanism: savings.perMechanism,
          },
    reportRecorded,
    observedModelCalls,
    trajectoryDigest,
  };
  const appCriteria = verifyDeterminizationMaturityAppContract({ row, observation });
  const contractPassed = appCriteria.every((criterion) => criterion.status === "PASS");

  // 3. The submission contract: the maturity submission landed its OWN
  //    fresh execution (never a replay — a shoulder-in never passes).
  const submissionsPassed = submission.replayed === false && submission.rejection === null;

  return {
    evidence: harness.evidence(),
    passed: harnessPassed && contractPassed && submissionsPassed,
    appCriteria,
    submission,
    observedTerminal,
    verificationStatuses,
    classification,
    refusalReason,
    curveSeries,
    savings,
    reportRecorded,
    observedModelCalls,
    trajectoryDigest,
    usage,
    submissionLatencyMs: submission.latencyMs,
  };
}
