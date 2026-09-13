/**
 * The shadow-execution customer application (VAL-034).
 *
 * A real customer-style application riding Zeck's public SDK boundary:
 * one pinned shadow corpus row per run — the row's shadowed candidate
 * (the VAL-033 differentially-evaluated lifecycle identity, the
 * read-only input) executed IN THE SHADOW beside the incumbent over
 * the recorded traffic mix (the workload mix the shadow replays),
 * submitted as a SHADOW task (the shadow-execute-only,
 * observation-only declaration rides the task semantics: canary and
 * promotion are never this app's acts; the app never selects
 * provider/model/rail — the platform keeps the route authority). The
 * application exercises the shadow contract at the customer boundary
 * in three phases:
 *
 *   * the submission phase — the row's shadow run lands its OWN
 *     durable execution through the harness submit under its OWN
 *     idempotency key (one submission per row);
 *   * the observation phase — the completion poll observes the run's
 *     honest terminal (COMPLETED for a shadow agreement or an honest
 *     refusal; FAILED for an honest divergence — a divergence is
 *     recorded, never smoothed), the result retrieval observes the
 *     verification statuses, the route's model-call count (zero
 *     offline — the offline shadow comparison is digest-level; the
 *     live row's REAL residual-AI round), the honest usage (measured
 *     on the live rail, honestly none offline), the shadow verdict
 *     read back (the kind, the refusal reason, the divergent cases,
 *     the leak kind), the lifecycle landing (the shadow stage ONLY),
 *     the per-case comparison records (both sides' digests + the
 *     claimed agreement), the asserted aggregate, the customer-facing
 *     served outcomes, the shadow cost measurement, the served
 *     accounting (the incumbent basis + the billed total — the
 *     never-billed-for-the-shadow proof), the shadow-ledger booking
 *     and the exercised capabilities, and the events read re-derives
 *     the shadow trajectory digest over the PUBLIC step-event journal
 *     (the app never trusts the platform's own claim);
 *   * the assertion phase — the app's own assertions verify the
 *     per-row shadow contract through the platform slice's PURE
 *     `verifyShadowExecutionAppContract`: the read-back verdict
 *     matches the pinned oracle (the kind, the refusal reason, the
 *     divergent cases — pinned case-by-case), the lifecycle landing
 *     is the shadow stage ONLY (a landing past shadow-executed never
 *     passes), the regression comparison is RE-DERIVED at the boundary
 *     over the row's declared population and the READ-BACK per-case
 *     records (never trusting the claimed verdict — an aggregate-only
 *     claim or a smoothed divergence never passes), the serving
 *     isolation is re-derived at the boundary over the read-back
 *     served outcomes (a leaked shadow outcome never passes), the
 *     population completeness is re-derived at the boundary, and the
 *     cost separation is re-derived at the boundary over the read-back
 *     costs (a billed shadow never passes).
 */

import { createZeckClient, ZeckApiError } from "../../../../sdk";
import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type { LabUsage, LabVerificationCriterion } from "../../platform/derive";
import { appTrajectoryDigestOf } from "../../platform/longitudinal-baseline";
import type {
  AppShadowObservation,
  ShadowAggregateClaim,
  ShadowCostMeasurement,
} from "../../platform/shadow-execution";
import { verifyShadowExecutionAppContract } from "../../platform/shadow-execution";
import {
  SHADOW_EXECUTION_CORPUS,
  SHADOW_EXECUTION_TASK_KIND,
  shadowSubmissionKey,
  shadowTaskBodyFor,
} from "./corpus";

/** One shadow submission's observation (the app's own receipt view). */
export interface ShadowSubmissionObservation {
  readonly executionId: string;
  readonly replayed: boolean;
  readonly status: string | null;
  readonly rejection: { readonly code: string; readonly status: number } | null;
  readonly submittedAt: number;
  readonly latencyMs: number;
}

/** The shadow verdict as read back through the public result read. */
export interface ShadowVerdictReadback {
  readonly kind: string;
  readonly refusalReason: string | null;
  readonly divergenceCaseIds: readonly string[];
  readonly leakKind: string | null;
}

/** The app's full run outcome (evidence + assertions + the shadow contract). */
export interface ShadowExecutionAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly appCriteria: readonly LabVerificationCriterion[];
  readonly submission: ShadowSubmissionObservation;
  readonly observedTerminal: string | null;
  readonly verificationStatuses: readonly string[];
  readonly verdict: ShadowVerdictReadback | null;
  readonly lifecycleLanding: { readonly proposalId: string; readonly finalStage: string } | null;
  readonly comparisons: readonly {
    readonly caseId: string;
    readonly incumbentDigest: string;
    readonly shadowDigest: string;
    readonly claimedAgrees: boolean;
  }[];
  readonly aggregate: ShadowAggregateClaim | null;
  readonly servedOutcomes: readonly {
    readonly caseId: string;
    readonly servedSource: string;
    readonly servedDigest: string;
  }[];
  readonly shadowCost: ShadowCostMeasurement | null;
  readonly servedIncumbentMicroUsd: number | null;
  readonly servedCostMicroUsd: number | null;
  readonly shadowLedgerBookedMicroUsd: number | null;
  readonly exercisedCapabilities: readonly string[];
  /** The app-side trajectory digest over the public events read. */
  readonly trajectoryDigest: string | null;
  readonly observedModelCalls: number | null;
  /** The run's measured usage (the live row; honestly null offline). */
  readonly usage: LabUsage | null;
  readonly submissionLatencyMs: number;
}

/** The app's pinned corpus slice (`shadow-execution.regression.v1` rows). */
export const SHADOW_EXECUTION_TASKS = SHADOW_EXECUTION_CORPUS.map((row) => ({
  kind: SHADOW_EXECUTION_TASK_KIND,
  rowId: row.rowId,
  sourceProposalId: row.sourceProposalId,
  replacementShape: row.replacementShape,
  declaredCapabilities: [...row.declaredCapabilities],
  grantedIsolationSurface: [...row.grantedIsolationSurface],
  criterionKind: row.acceptanceCriterion.kind,
  toleratedCaseIds: [...(row.acceptanceCriterion.toleratedCaseIds ?? [])],
  populationSize: row.trafficPopulation.length,
  historicalCases: row.trafficPopulation.filter((tcase) => tcase.source === "historical-replay")
    .length,
  injectedProbes: row.trafficPopulation.filter((tcase) => tcase.source === "adversarial").length,
  workloadClasses: [...new Set(Object.values(row.trafficWorkloadClasses))].length,
  expectedVerdict: row.expected.verdict,
  expectedRefusalReason: row.expected.refusalReason,
  expectedDivergenceCaseIds: row.expected.divergenceCaseIds.length,
  expectedTerminal: row.expected.terminal,
  trajectoryClassSize: row.expectedTrajectoryClass.length,
  expectedModelCalls: row.expected.modelCalls,
  ...(row.probe === undefined ? {} : { probe: row.probe.kind }),
  ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
}));

/**
 * Run the shadow-execution application end to end over one pinned
 * corpus row: submit the shadow task (under its OWN idempotency key)
 * → poll the run to its terminal → retrieve the result (the
 * verification statuses, the route's model-call count, the honest
 * usage, the verdict read back, the lifecycle landing, the per-case
 * comparison records, the served outcomes, the shadow cost, the
 * served accounting and the exercised capabilities) → read the events
 * (the app-side shadow trajectory digest over the public journal) →
 * verify the per-row shadow contract. The transport implementation is
 * injected (the SDK's seam); the app never selects
 * provider/model/rail (the platform's authority).
 */
export async function runShadowExecutionApp(options: {
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
}): Promise<ShadowExecutionAppResult> {
  const row = SHADOW_EXECUTION_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned shadow-execution task slice is empty");
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
      workOrder: "VAL-034",
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
  const key = shadowSubmissionKey({
    runSuffix: options.runSuffix,
    taskIndex: options.taskIndex,
  });
  const body = shadowTaskBodyFor({
    rowId: row.rowId,
    sourceProposalId: row.sourceProposalId,
    replacementShape: row.replacementShape,
  });
  const request = { applicationId: options.config.applicationId, task: body };
  const submittedAt = options.now().getTime();
  let submission: ShadowSubmissionObservation;
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
  let verdict: ShadowVerdictReadback | null = null;
  let lifecycleLanding: { proposalId: string; finalStage: string } | null = null;
  let comparisons: ShadowExecutionAppResult["comparisons"] = [];
  let aggregate: ShadowAggregateClaim | null = null;
  let servedOutcomes: ShadowExecutionAppResult["servedOutcomes"] = [];
  let shadowCost: ShadowCostMeasurement | null = null;
  let servedIncumbentMicroUsd: number | null = null;
  let servedCostMicroUsd: number | null = null;
  let shadowLedgerBookedMicroUsd: number | null = null;
  let exercisedCapabilities: readonly string[] = [];
  let observedModelCalls: number | null = null;
  let usage: LabUsage | null = null;
  let trajectoryDigest: string | null = null;
  if (submission.rejection === null && submission.executionId !== "") {
    const executionId = submission.executionId;
    observedTerminal = await harness.awaitCompletion(executionId);

    // The result read: the verification statuses, the route's own
    // model-call count, the honest usage, the verdict read back, the
    // lifecycle landing, the per-case comparison records, the served
    // outcomes, the shadow cost and the served accounting.
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
      verdict: ShadowVerdictReadback;
      lifecycleLanding: { proposalId: string; finalStage: string };
      comparisons: ShadowExecutionAppResult["comparisons"];
      aggregate: ShadowAggregateClaim;
      servedOutcomes: ShadowExecutionAppResult["servedOutcomes"];
      shadowCost: ShadowCostMeasurement;
      servedAccounting: { incumbentMicroUsd: number; billedMicroUsd: number };
      shadowLedgerBookedMicroUsd: number | null;
      exercisedCapabilities: readonly string[];
    }>;
    verdict = view.verdict ?? null;
    lifecycleLanding = view.lifecycleLanding ?? null;
    comparisons = view.comparisons ?? [];
    aggregate = view.aggregate ?? null;
    servedOutcomes = view.servedOutcomes ?? [];
    shadowCost = view.shadowCost ?? null;
    servedIncumbentMicroUsd = view.servedAccounting?.incumbentMicroUsd ?? null;
    servedCostMicroUsd = view.servedAccounting?.billedMicroUsd ?? null;
    shadowLedgerBookedMicroUsd = view.shadowLedgerBookedMicroUsd ?? null;
    exercisedCapabilities = view.exercisedCapabilities ?? [];

    // The events read: the app mechanically re-derives the shadow
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

  // 2. The app-side shadow contract (PURE): the read-back verdict
  //    matches the pinned oracle — the kind, the refusal reason, the
  //    divergent cases pinned case-by-case — the lifecycle landing is
  //    the shadow stage ONLY, the regression comparison is re-derived
  //    AT the boundary over the read-back per-case records (never
  //    trusting the claim), the serving isolation is re-derived at
  //    the boundary over the read-back served outcomes, the
  //    population completeness is re-derived at the boundary, the
  //    cost separation is re-derived at the boundary over the
  //    read-back costs, the run made its own dispatches, and the
  //    app-side trajectory digest is a member of the pinned class.
  const observation: AppShadowObservation = {
    executionId: submission.executionId,
    replayed: submission.replayed,
    rejection: submission.rejection === null ? null : { code: submission.rejection.code },
    terminal: observedTerminal,
    verificationStatuses,
    verdict,
    lifecycleLanding,
    comparisons,
    aggregateClaim: aggregate,
    servedOutcomes,
    shadowCost,
    servedIncumbentMicroUsd,
    servedCostMicroUsd,
    shadowLedgerBookedMicroUsd,
    exercisedCapabilities,
    trajectoryDigest,
    observedModelCalls,
  };
  const appCriteria = verifyShadowExecutionAppContract({ row, observation });
  const contractPassed = appCriteria.every((criterion) => criterion.status === "PASS");

  // 3. The submission contract: the shadow submission landed its OWN
  //    fresh execution (never a replay — a shoulder-in never passes).
  const submissionsPassed = submission.replayed === false && submission.rejection === null;

  return {
    evidence: harness.evidence(),
    passed: harnessPassed && contractPassed && submissionsPassed,
    appCriteria,
    submission,
    observedTerminal,
    verificationStatuses,
    verdict,
    lifecycleLanding,
    comparisons,
    aggregate,
    servedOutcomes,
    shadowCost,
    servedIncumbentMicroUsd,
    servedCostMicroUsd,
    shadowLedgerBookedMicroUsd,
    exercisedCapabilities,
    trajectoryDigest,
    observedModelCalls,
    usage,
    submissionLatencyMs: submission.latencyMs,
  };
}
