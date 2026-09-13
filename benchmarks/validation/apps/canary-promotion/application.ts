/**
 * The canary-promotion customer application (VAL-035).
 *
 * A real customer-style application riding Zeck's public SDK boundary:
 * one pinned canary corpus row per run — the row's canaried candidate
 * (the VAL-034 shadow-executed lifecycle identity, the read-only
 * input) promoted through the GOVERNED RAMP (the pinned schedule of
 * increasing traffic fractions under the explicit failure budget and
 * divergence tolerance), submitted as a CANARY task (the
 * governed-ramp declaration rides the task semantics: the app never
 * selects provider/model/rail — the platform keeps the route
 * authority). The application exercises the canary contract at the
 * customer boundary in three phases:
 *
 *   * the submission phase — the row's canary run lands its OWN
 *     durable execution through the harness submit under its OWN
 *     idempotency key (one submission per row);
 *   * the observation phase — the completion poll observes the run's
 *     honest terminal (COMPLETED for a clean promotion or an honest
 *     refusal; FAILED for an honest budget-breach rollback — the
 *     breach is recorded, never smoothed), the result retrieval
 *     observes the verification statuses, the route's model-call
 *     count (zero offline — the offline canary comparison is
 *     digest-level; the live row's REAL residual-AI round), the
 *     honest usage (measured on the live rail, honestly none
 *     offline), the canary verdict read back (the kind, the refusal
 *     reason, the breaching step, the final stage), the lifecycle
 *     landing (the pinned final stage only — canaried, or promoted on
 *     a clean full ramp), the read-back canary decisions (with their
 *     policy citations and checks), the per-case slice comparisons
 *     (both sides' digests + the claimed agreement), the rollback
 *     events (with their residual serves) and the rollback-plan
 *     record, the customer-facing served outcomes, the canary cost
 *     measurement, the served accounting (the incumbent basis + the
 *     billed total — the never-billed-for-the-canary proof), the
 *     canary-ledger booking with its marker and the exercised
 *     capabilities, and the events read re-derives the canary
 *     trajectory digest over the PUBLIC step-event journal (the app
 *     never trusts the platform's own claim);
 *   * the assertion phase — the app's own assertions verify the
 *     per-row canary contract through the platform slice's PURE
 *     `verifyCanaryPromotionAppContract`: the read-back verdict
 *     matches the pinned oracle (the kind, the refusal reason, the
 *     breaching step, the final stage), the lifecycle landing is the
 *     pinned final stage ONLY (a landing past promoted never passes),
 *     the policy explicitness is re-derived at the boundary over the
 *     read-back decisions' citations and checks (an unstated or
 *     unchecked policy item never passes), the breach honesty is
 *     re-derived at the boundary over the row's pinned policy and the
 *     read-back per-case slice comparisons (a smoothed breach never
 *     passes), the rollback completeness is re-derived at the boundary
 *     over the read-back rollback events (a partial or unevidenced
 *     rollback never passes), the slice isolation is re-derived at the
 *     boundary over the read-back served outcomes (an over-slice
 *     serve never passes), and the cost separation is re-derived at
 *     the boundary over the read-back costs (a billed or unmarked
 *     canary never passes).
 */

import { createZeckClient, ZeckApiError } from "../../../../sdk";
import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type { AppCanaryObservation, CanaryCostMeasurement } from "../../platform/canary-promotion";
import { verifyCanaryPromotionAppContract } from "../../platform/canary-promotion";
import type { LabUsage, LabVerificationCriterion } from "../../platform/derive";
import { appTrajectoryDigestOf } from "../../platform/longitudinal-baseline";
import {
  CANARY_PROMOTION_CORPUS,
  CANARY_PROMOTION_TASK_KIND,
  canarySubmissionKey,
  canaryTaskBodyFor,
} from "./corpus";

/** One canary submission's observation (the app's own receipt view). */
export interface CanarySubmissionObservation {
  readonly executionId: string;
  readonly replayed: boolean;
  readonly status: string | null;
  readonly rejection: { readonly code: string; readonly status: number } | null;
  readonly submittedAt: number;
  readonly latencyMs: number;
}

/** The canary verdict as read back through the public result read. */
export interface CanaryVerdictReadback {
  readonly kind: string;
  readonly refusalReason: string | null;
  readonly breachingStepIndex: number | null;
  readonly finalStage: string | null;
}

/** The app's full run outcome (evidence + assertions + the canary contract). */
export interface CanaryPromotionAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly appCriteria: readonly LabVerificationCriterion[];
  readonly submission: CanarySubmissionObservation;
  readonly observedTerminal: string | null;
  readonly verificationStatuses: readonly string[];
  readonly verdict: CanaryVerdictReadback | null;
  readonly lifecycleLanding: { readonly proposalId: string; readonly finalStage: string } | null;
  readonly decisions: readonly {
    readonly stepIndex: number;
    readonly kind: string;
    readonly sliceFraction: number;
    readonly observedDivergenceCount: number;
    readonly budgetLimit: number;
    readonly policyCitations: {
      readonly rampScheduleDigest: string;
      readonly failureBudgetStated: boolean;
      readonly toleranceStated: boolean;
    };
    readonly policyChecks: {
      readonly rampChecked: boolean;
      readonly budgetChecked: boolean;
      readonly toleranceChecked: boolean;
    };
  }[];
  readonly sliceComparisons: readonly {
    readonly stepIndex: number;
    readonly caseId: string;
    readonly incumbentDigest: string;
    readonly replacementDigest: string;
    readonly claimedAgrees: boolean;
  }[];
  readonly rollbackEvents: readonly {
    readonly stepIndex: number;
    readonly residualReplacementCaseIds: readonly string[];
  }[];
  readonly rollbackPlanRecorded: boolean;
  readonly servedOutcomes: readonly {
    readonly stepIndex: number;
    readonly caseId: string;
    readonly servedSource: string;
    readonly servedDigest: string;
  }[];
  readonly canaryCost: CanaryCostMeasurement | null;
  readonly servedIncumbentMicroUsd: number | null;
  readonly servedCostMicroUsd: number | null;
  readonly canaryLedgerBookedMicroUsd: number | null;
  readonly canaryMarkerPresent: boolean | null;
  readonly exercisedCapabilities: readonly string[];
  /** The app-side trajectory digest over the public events read. */
  readonly trajectoryDigest: string | null;
  readonly observedModelCalls: number | null;
  /** The run's measured usage (the live row; honestly null offline). */
  readonly usage: LabUsage | null;
  readonly submissionLatencyMs: number;
}

/** The app's pinned corpus slice (`canary-promotion.governed-ramp.v1` rows). */
export const CANARY_PROMOTION_TASKS = CANARY_PROMOTION_CORPUS.map((row) => ({
  kind: CANARY_PROMOTION_TASK_KIND,
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
  rampSchedule: row.rampSchedule.map((step) => step.trafficFraction),
  maxDivergencesPerStep: row.failureBudget.maxDivergencesPerStep,
  expectedVerdict: row.expected.verdict,
  expectedRefusalReason: row.expected.refusalReason,
  expectedBreachingStepIndex: row.expected.breachingStepIndex,
  expectedFinalStage: row.expected.finalStage,
  expectedTerminal: row.expected.terminal,
  trajectoryClassSize: row.expectedTrajectoryClass.length,
  expectedModelCalls: row.expected.modelCalls,
  ...(row.probe === undefined ? {} : { probe: row.probe.kind }),
  ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
}));

/**
 * Run the canary-promotion application end to end over one pinned
 * corpus row: submit the canary task (under its OWN idempotency key)
 * → poll the run to its terminal → retrieve the result (the
 * verification statuses, the route's model-call count, the honest
 * usage, the verdict read back, the lifecycle landing, the canary
 * decisions, the slice comparisons, the rollback events, the served
 * outcomes, the canary cost, the served accounting and the exercised
 * capabilities) → read the events (the app-side canary trajectory
 * digest over the public journal) → verify the per-row canary
 * contract. The transport implementation is injected (the SDK's
 * seam); the app never selects provider/model/rail (the platform's
 * authority).
 */
export async function runCanaryPromotionApp(options: {
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
}): Promise<CanaryPromotionAppResult> {
  const row = CANARY_PROMOTION_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned canary-promotion task slice is empty");
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
      workOrder: "VAL-035",
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
  const key = canarySubmissionKey({
    runSuffix: options.runSuffix,
    taskIndex: options.taskIndex,
  });
  const body = canaryTaskBodyFor({
    rowId: row.rowId,
    sourceProposalId: row.sourceProposalId,
    replacementShape: row.replacementShape,
  });
  const request = { applicationId: options.config.applicationId, task: body };
  const submittedAt = options.now().getTime();
  let submission: CanarySubmissionObservation;
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
  let verdict: CanaryVerdictReadback | null = null;
  let lifecycleLanding: { proposalId: string; finalStage: string } | null = null;
  let decisions: CanaryPromotionAppResult["decisions"] = [];
  let sliceComparisons: CanaryPromotionAppResult["sliceComparisons"] = [];
  let rollbackEvents: CanaryPromotionAppResult["rollbackEvents"] = [];
  let rollbackPlanRecorded = false;
  let servedOutcomes: CanaryPromotionAppResult["servedOutcomes"] = [];
  let canaryCost: CanaryCostMeasurement | null = null;
  let servedIncumbentMicroUsd: number | null = null;
  let servedCostMicroUsd: number | null = null;
  let canaryLedgerBookedMicroUsd: number | null = null;
  let canaryMarkerPresent: boolean | null = null;
  let exercisedCapabilities: readonly string[] = [];
  let observedModelCalls: number | null = null;
  let usage: LabUsage | null = null;
  let trajectoryDigest: string | null = null;
  if (submission.rejection === null && submission.executionId !== "") {
    const executionId = submission.executionId;
    observedTerminal = await harness.awaitCompletion(executionId);

    // The result read: the verification statuses, the route's own
    // model-call count, the honest usage, the verdict read back, the
    // lifecycle landing, the canary decisions, the slice
    // comparisons, the rollback events + plan, the served outcomes,
    // the canary cost and the served accounting.
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
      verdict: CanaryVerdictReadback;
      lifecycleLanding: { proposalId: string; finalStage: string };
      decisions: CanaryPromotionAppResult["decisions"];
      sliceComparisons: CanaryPromotionAppResult["sliceComparisons"];
      rollbackEvents: CanaryPromotionAppResult["rollbackEvents"];
      rollbackPlanRecorded: boolean;
      servedOutcomes: CanaryPromotionAppResult["servedOutcomes"];
      canaryCost: CanaryCostMeasurement;
      servedAccounting: { incumbentMicroUsd: number; billedMicroUsd: number };
      canaryLedgerBookedMicroUsd: number | null;
      canaryMarkerPresent: boolean | null;
      exercisedCapabilities: readonly string[];
    }>;
    verdict = view.verdict ?? null;
    lifecycleLanding = view.lifecycleLanding ?? null;
    decisions = view.decisions ?? [];
    sliceComparisons = view.sliceComparisons ?? [];
    rollbackEvents = view.rollbackEvents ?? [];
    rollbackPlanRecorded = view.rollbackPlanRecorded ?? false;
    servedOutcomes = view.servedOutcomes ?? [];
    canaryCost = view.canaryCost ?? null;
    servedIncumbentMicroUsd = view.servedAccounting?.incumbentMicroUsd ?? null;
    servedCostMicroUsd = view.servedAccounting?.billedMicroUsd ?? null;
    canaryLedgerBookedMicroUsd = view.canaryLedgerBookedMicroUsd ?? null;
    canaryMarkerPresent = view.canaryMarkerPresent ?? null;
    exercisedCapabilities = view.exercisedCapabilities ?? [];

    // The events read: the app mechanically re-derives the canary
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

  // 2. The app-side canary contract (PURE): the read-back verdict
  //    matches the pinned oracle — the kind, the refusal reason, the
  //    breaching step, the final stage — the lifecycle landing is the
  //    pinned final stage ONLY, the policy explicitness is re-derived
  //    AT the boundary over the read-back decisions' citations and
  //    checks (never trusting the claim), the breach honesty is
  //    re-derived at the boundary over the read-back per-case slice
  //    comparisons, the rollback completeness is re-derived at the
  //    boundary over the read-back rollback events, the slice
  //    isolation is re-derived at the boundary over the read-back
  //    served outcomes, the cost separation is re-derived at the
  //    boundary over the read-back costs, the run made its own
  //    dispatches, and the app-side trajectory digest is a member of
  //    the pinned class.
  const observation: AppCanaryObservation = {
    executionId: submission.executionId,
    replayed: submission.replayed,
    rejection: submission.rejection === null ? null : { code: submission.rejection.code },
    terminal: observedTerminal,
    verificationStatuses,
    verdict,
    lifecycleLanding,
    decisions,
    sliceComparisons,
    rollbackEvents,
    rollbackPlanRecorded,
    servedOutcomes,
    canaryCost,
    servedIncumbentMicroUsd,
    servedCostMicroUsd,
    canaryLedgerBookedMicroUsd,
    canaryMarkerPresent,
    exercisedCapabilities,
    trajectoryDigest,
    observedModelCalls,
  };
  const appCriteria = verifyCanaryPromotionAppContract({ row, observation });
  const contractPassed = appCriteria.every((criterion) => criterion.status === "PASS");

  // 3. The submission contract: the canary submission landed its OWN
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
    decisions,
    sliceComparisons,
    rollbackEvents,
    rollbackPlanRecorded,
    servedOutcomes,
    canaryCost,
    servedIncumbentMicroUsd,
    servedCostMicroUsd,
    canaryLedgerBookedMicroUsd,
    canaryMarkerPresent,
    exercisedCapabilities,
    trajectoryDigest,
    observedModelCalls,
    usage,
    submissionLatencyMs: submission.latencyMs,
  };
}
