/**
 * The savings-attribution customer application (VAL-045).
 *
 * A real customer-style application riding Zeck's public SDK
 * boundary: one pinned attribution corpus row per run — the workload
 * family's RECORDED ECONOMICS (VAL-044's adjusted-cost incumbent
 * baselines + the recorded savings totals) and RECORDED LIFECYCLE
 * HISTORY (VAL-030..036's lifecycle records, promotion generations,
 * accounting ledgers and maturity reports — the read-only input)
 * attributed across their mechanisms (reuse / cache / competence /
 * deterministicization + the honest unattributed residual),
 * submitted as a SAVINGS-ATTRIBUTION task (the app never selects
 * provider/model/rail — the platform keeps the route authority). The
 * application exercises the attribution contract at the customer
 * boundary in three phases:
 *
 *   * the submission phase — the row's analysis lands its OWN durable
 *     execution through the harness submit under its OWN idempotency
 *     key (one submission per row);
 *   * the observation phase — the completion poll observes the run's
 *     honest terminal (COMPLETED for an established attribution or an
 *     honest no-evidence refusal), the result retrieval observes the
 *     verification statuses, the route's model-call count (zero
 *     offline — the offline analysis is digest-level; the live row's
 *     REAL measured round), the honest usage (measured on the live
 *     rail, honestly none offline), the per-mechanism attributed
 *     totals read back, the residual read back, the per-generation
 *     splits read back, the report-recorded flag, the refusal reason
 *     read back, and the events read re-derives the attribution
 *     trajectory digest over the PUBLIC step-event journal (the app
 *     never trusts the platform's own claim);
 *   * the assertion phase — the app's own assertions verify the
 *     per-row attribution contract through the platform slice's PURE
 *     `verifySavingsAttributionAppContract`: the read-back attributed
 *     split matches the declared split, the boundary re-derivation of
 *     the reconciliation identity over the read-back numbers (a
 *     non-reconciling split never passes), the residual read-back
 *     honesty (never hidden, never folded into a mechanism), the
 *     report landing matches the expected verdict, the run made its
 *     own dispatches, and the refusal read-back matches the pinned
 *     oracle.
 */

import { createZeckClient, ZeckApiError } from "../../../../sdk";
import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type { LabUsage, LabVerificationCriterion } from "../../platform/derive";
import { appTrajectoryDigestOf } from "../../platform/longitudinal-baseline";
import type { AppAttributionObservation } from "../../platform/savings-attribution";
import { verifySavingsAttributionAppContract } from "../../platform/savings-attribution";
import {
  attributionSubmissionKey,
  attributionTaskBodyFor,
  declaredSplitTotalsOf,
  SAVINGS_ATTRIBUTION_CORPUS,
  SAVINGS_ATTRIBUTION_TASK_KIND,
} from "./corpus";

/** One attribution submission's observation (the app's own receipt view). */
export interface AttributionSubmissionObservation {
  readonly executionId: string;
  readonly replayed: boolean;
  readonly status: string | null;
  readonly rejection: { readonly code: string; readonly status: number } | null;
  readonly submittedAt: number;
  readonly latencyMs: number;
}

/** The app's full run outcome (evidence + assertions + the attribution contract). */
export interface SavingsAttributionAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly appCriteria: readonly LabVerificationCriterion[];
  readonly submission: AttributionSubmissionObservation;
  readonly observedTerminal: string | null;
  readonly verificationStatuses: readonly string[];
  readonly attributed: Readonly<Record<string, number>> | null;
  readonly residualMicroUsd: number | null;
  readonly claimedTotalMicroUsd: number | null;
  readonly perGeneration: readonly {
    readonly generation: number;
    readonly perMechanism: Readonly<Record<string, number>>;
    readonly residualMicroUsd: number;
    readonly recordedTotalMicroUsd: number;
  }[];
  readonly reportRecorded: boolean;
  readonly refusalReason: string | null;
  readonly observedModelCalls: number | null;
  readonly trajectoryDigest: string | null;
  readonly usage: LabUsage | null;
  readonly submissionLatencyMs: number;
}

/** The app's pinned corpus slice (the attribution task declarations). */
export const SAVINGS_ATTRIBUTION_TASKS = SAVINGS_ATTRIBUTION_CORPUS.map((row) => {
  const declared = declaredSplitTotalsOf(row);
  return {
    kind: SAVINGS_ATTRIBUTION_TASK_KIND,
    rowId: row.rowId,
    familyId: row.familyId,
    claims: row.split.claims.length,
    residualClaims: row.split.residual.length,
    attributedReuseMicroUsd: declared.attributed.reuse,
    attributedCacheMicroUsd: declared.attributed.cache,
    attributedCompetenceMicroUsd: declared.attributed.competence,
    attributedDeterministicizationMicroUsd: declared.attributed.deterministicization,
    attributedTotalMicroUsd: declared.attributedTotalMicroUsd,
    residualMicroUsd: declared.residualMicroUsd,
    expectedVerdict: row.expected.verdict,
    expectedRefusalReason: row.expected.refusalReason,
    expectedTerminal: row.expected.terminal,
    expectedModelCalls: row.expected.modelCalls,
    ...(row.probe === undefined ? {} : { probe: row.probe.kind }),
    ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
  };
});

/**
 * Run the savings-attribution application end to end over one pinned
 * corpus row: submit the attribution task (under its OWN idempotency
 * key) → poll the run to its terminal → retrieve the result (the
 * verification statuses, the route's model-call count, the honest
 * usage, the attributed split, the residual, the per-generation
 * splits, the report record, the refusal reason) → read the events
 * (the app-side attribution trajectory digest over the public
 * journal) → verify the per-row attribution contract. The transport
 * implementation is injected (the SDK's seam); the app never selects
 * provider/model/rail (the platform's authority).
 */
export async function runSavingsAttributionApp(options: {
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
}): Promise<SavingsAttributionAppResult> {
  const row = SAVINGS_ATTRIBUTION_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned savings-attribution task slice is empty");
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
      workOrder: "VAL-045",
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
  const key = attributionSubmissionKey({
    runSuffix: options.runSuffix,
    taskIndex: options.taskIndex,
  });
  const body = attributionTaskBodyFor({ rowId: row.rowId, familyId: row.familyId });
  const request = { applicationId: options.config.applicationId, task: body };
  const submittedAt = options.now().getTime();
  let submission: AttributionSubmissionObservation;
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
  let attributed: SavingsAttributionAppResult["attributed"] = null;
  let residualMicroUsd: number | null = null;
  let claimedTotalMicroUsd: number | null = null;
  let perGeneration: SavingsAttributionAppResult["perGeneration"] = [];
  let reportRecorded = false;
  let refusalReason: string | null = null;
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
      attributed: SavingsAttributionAppResult["attributed"];
      residualMicroUsd: number | null;
      claimedTotalMicroUsd: number | null;
      perGeneration: SavingsAttributionAppResult["perGeneration"];
      reportRecorded: boolean;
      refusalReason: string | null;
    }>;
    attributed = view.attributed ?? null;
    residualMicroUsd = view.residualMicroUsd ?? null;
    claimedTotalMicroUsd = view.claimedTotalMicroUsd ?? null;
    perGeneration = view.perGeneration ?? [];
    reportRecorded = view.reportRecorded ?? false;
    refusalReason = view.refusalReason ?? null;

    // The events read: the app mechanically re-derives the attribution
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

  // 2. The app-side attribution contract (PURE): the boundary
  //    re-derivations — never trusting the platform's claim.
  const observation: AppAttributionObservation = {
    executionId: submission.executionId,
    replayed: submission.replayed,
    rejection: submission.rejection === null ? null : { code: submission.rejection.code },
    terminal: observedTerminal,
    verificationStatuses,
    attributed:
      attributed === null
        ? null
        : {
            reuse: attributed.reuse ?? 0,
            cache: attributed.cache ?? 0,
            competence: attributed.competence ?? 0,
            deterministicization: attributed.deterministicization ?? 0,
          },
    residualMicroUsd,
    claimedTotalMicroUsd,
    perGeneration: perGeneration.map((split) => ({
      generation: split.generation,
      perMechanism: {
        reuse: split.perMechanism.reuse ?? 0,
        cache: split.perMechanism.cache ?? 0,
        competence: split.perMechanism.competence ?? 0,
        deterministicization: split.perMechanism.deterministicization ?? 0,
      },
      residualMicroUsd: split.residualMicroUsd,
      recordedTotalMicroUsd: split.recordedTotalMicroUsd,
    })),
    refusalReason,
    reportRecorded,
    observedModelCalls,
    trajectoryDigest,
  };
  const appCriteria = verifySavingsAttributionAppContract({ row, observation });
  const contractPassed = appCriteria.every((criterion) => criterion.status === "PASS");

  // 3. The submission contract: the attribution submission landed its
  //    OWN fresh execution (never a replay — a shoulder-in never passes).
  const submissionsPassed = submission.replayed === false && submission.rejection === null;

  return {
    evidence: harness.evidence(),
    passed: harnessPassed && contractPassed && submissionsPassed,
    appCriteria,
    submission,
    observedTerminal,
    verificationStatuses,
    attributed,
    residualMicroUsd,
    claimedTotalMicroUsd,
    perGeneration,
    reportRecorded,
    refusalReason,
    observedModelCalls,
    trajectoryDigest,
    usage,
    submissionLatencyMs: submission.latencyMs,
  };
}
