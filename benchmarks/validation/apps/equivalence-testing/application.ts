/**
 * The equivalence-testing customer application (VAL-033).
 *
 * A real customer-style application riding Zeck's public SDK boundary:
 * one pinned equivalence corpus row per run — the row's source
 * proposal (the VAL-032 registry identity, the read-only input)
 * generated as an ISOLATED deterministic replacement and differentially
 * evaluated against the incumbent over the cited historical replay
 * inputs plus the pinned adversarial cases, submitted as an
 * EQUIVALENCE task (the differentially-evaluate-only declaration
 * rides the task semantics: shadow, canary and promotion are never
 * this app's acts; the app never selects provider/model/rail — the
 * platform keeps the route authority). The application exercises the
 * equivalence contract at the customer boundary in three phases:
 *
 *   * the submission phase — the row's equivalence run lands its OWN
 *     durable execution through the harness submit under its OWN
 *     idempotency key (one submission per row);
 *   * the observation phase — the completion poll observes the run's
 *     honest terminal (COMPLETED for an equivalence pass or an
 *     honest refusal; FAILED for an honest divergence — a divergence
 *     is recorded, never smoothed), the result retrieval observes the
 *     verification statuses, the route's model-call count (zero
 *     offline — the offline differential is digest-level; the live
 *     row's REAL residual-AI round), the honest usage (measured on
 *     the live rail, honestly none offline), the equivalence verdict
 *     read back (the kind, the refusal reason, the divergent cases,
 *     the escape directions), the lifecycle landing (the equivalence
 *     stage ONLY), the per-case outcomes (both sides' digests) and
 *     the exercised capabilities, and the events read re-derives the
 *     equivalence trajectory digest over the PUBLIC step-event
 *     journal (the app never trusts the platform's own claim);
 *   * the assertion phase — the app's own assertions verify the
 *     per-row equivalence contract through the platform slice's PURE
 *     `verifyEquivalenceTestingAppContract`: the read-back verdict
 *     matches the pinned oracle (the kind, the refusal reason, the
 *     divergent cases), the lifecycle landing is the equivalence
 *     stage ONLY (a landing past differentially-evaluated never
 *     passes), the differential evaluation is RE-DERIVED at the
 *     boundary over the row's declared population and the READ-BACK
 *     outcome digests (never trusting the claimed verdict — an
 *     unchecked criterion or a smoothed divergence never passes) and
 *     the isolation is re-derived at the boundary (a containment
 *     escape never passes).
 */

import { createZeckClient, ZeckApiError } from "../../../../sdk";
import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type { LabUsage, LabVerificationCriterion } from "../../platform/derive";
import type { AppEquivalenceObservation } from "../../platform/equivalence-testing";
import { verifyEquivalenceTestingAppContract } from "../../platform/equivalence-testing";
import { appTrajectoryDigestOf } from "../../platform/longitudinal-baseline";
import {
  EQUIVALENCE_TESTING_CORPUS,
  EQUIVALENCE_TESTING_TASK_KIND,
  equivalenceSubmissionKey,
  equivalenceTaskBodyFor,
} from "./corpus";

/** One equivalence submission's observation (the app's own receipt view). */
export interface EquivalenceSubmissionObservation {
  readonly executionId: string;
  readonly replayed: boolean;
  readonly status: string | null;
  readonly rejection: { readonly code: string; readonly status: number } | null;
  readonly submittedAt: number;
  readonly latencyMs: number;
}

/** The equivalence verdict as read back through the public result read. */
export interface EquivalenceVerdictReadback {
  readonly kind: string;
  readonly refusalReason: string | null;
  readonly divergenceCaseIds: readonly string[];
  readonly escapeDirections: readonly string[];
}

/** The app's full run outcome (evidence + assertions + the equivalence contract). */
export interface EquivalenceTestingAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly appCriteria: readonly LabVerificationCriterion[];
  readonly submission: EquivalenceSubmissionObservation;
  readonly observedTerminal: string | null;
  readonly verificationStatuses: readonly string[];
  readonly verdict: EquivalenceVerdictReadback | null;
  readonly lifecycleLanding: { readonly proposalId: string; readonly finalStage: string } | null;
  readonly outcomes: readonly {
    readonly caseId: string;
    readonly incumbentDigest: string;
    readonly replacementDigest: string;
    readonly claimedEquivalent: boolean;
  }[];
  readonly exercisedCapabilities: readonly string[];
  /** The app-side trajectory digest over the public events read. */
  readonly trajectoryDigest: string | null;
  readonly observedModelCalls: number | null;
  /** The run's measured usage (the live row; honestly null offline). */
  readonly usage: LabUsage | null;
  readonly submissionLatencyMs: number;
}

/** The app's pinned corpus slice (`equivalence-testing.verdict.v1` rows). */
export const EQUIVALENCE_TESTING_TASKS = EQUIVALENCE_TESTING_CORPUS.map((row) => ({
  kind: EQUIVALENCE_TESTING_TASK_KIND,
  rowId: row.rowId,
  sourceProposalId: row.sourceProposalId,
  replacementShape: row.replacementShape,
  declaredCapabilities: [...row.declaredCapabilities],
  grantedIsolationSurface: [...row.grantedIsolationSurface],
  criterionKind: row.acceptanceCriterion.kind,
  toleratedCaseIds: [...(row.acceptanceCriterion.toleratedCaseIds ?? [])],
  populationSize: row.differentialPopulation.length,
  historicalCases: row.differentialPopulation.filter(
    (dcase) => dcase.source === "historical-replay",
  ).length,
  adversarialCases: row.differentialPopulation.filter((dcase) => dcase.source === "adversarial")
    .length,
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
 * Run the equivalence-testing application end to end over one pinned
 * corpus row: submit the equivalence task (under its OWN idempotency
 * key) → poll the run to its terminal → retrieve the result (the
 * verification statuses, the route's model-call count, the honest
 * usage, the verdict read back, the lifecycle landing, the per-case
 * outcomes and the exercised capabilities) → read the events (the
 * app-side equivalence trajectory digest over the public journal) →
 * verify the per-row equivalence contract. The transport
 * implementation is injected (the SDK's seam); the app never selects
 * provider/model/rail (the platform's authority).
 */
export async function runEquivalenceTestingApp(options: {
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
}): Promise<EquivalenceTestingAppResult> {
  const row = EQUIVALENCE_TESTING_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned equivalence-testing task slice is empty");
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
      workOrder: "VAL-033",
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
  const key = equivalenceSubmissionKey({
    runSuffix: options.runSuffix,
    taskIndex: options.taskIndex,
  });
  const body = equivalenceTaskBodyFor({
    rowId: row.rowId,
    sourceProposalId: row.sourceProposalId,
    replacementShape: row.replacementShape,
  });
  const request = { applicationId: options.config.applicationId, task: body };
  const submittedAt = options.now().getTime();
  let submission: EquivalenceSubmissionObservation;
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
  let verdict: EquivalenceVerdictReadback | null = null;
  let lifecycleLanding: { proposalId: string; finalStage: string } | null = null;
  let outcomes: EquivalenceTestingAppResult["outcomes"] = [];
  let exercisedCapabilities: readonly string[] = [];
  let observedModelCalls: number | null = null;
  let usage: LabUsage | null = null;
  let trajectoryDigest: string | null = null;
  if (submission.rejection === null && submission.executionId !== "") {
    const executionId = submission.executionId;
    observedTerminal = await harness.awaitCompletion(executionId);

    // The result read: the verification statuses, the route's own
    // model-call count, the honest usage, the verdict read back, the
    // lifecycle landing, the per-case outcomes and the exercised
    // capabilities.
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
      verdict: EquivalenceVerdictReadback;
      lifecycleLanding: { proposalId: string; finalStage: string };
      outcomes: EquivalenceTestingAppResult["outcomes"];
      exercisedCapabilities: readonly string[];
    }>;
    verdict = view.verdict ?? null;
    lifecycleLanding = view.lifecycleLanding ?? null;
    outcomes = view.outcomes ?? [];
    exercisedCapabilities = view.exercisedCapabilities ?? [];

    // The events read: the app mechanically re-derives the equivalence
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

  // 2. The app-side equivalence contract (PURE): the read-back verdict
  //    matches the pinned oracle — the kind, the refusal reason, the
  //    divergent cases — the lifecycle landing is the equivalence stage
  //    ONLY, the differential evaluation is re-derived AT the boundary
  //    over the read-back outcome digests (never trusting the claim),
  //    the isolation is re-derived at the boundary, the run made its
  //    own dispatches, and the app-side trajectory digest is a member
  //    of the pinned class.
  const observation: AppEquivalenceObservation = {
    executionId: submission.executionId,
    replayed: submission.replayed,
    rejection: submission.rejection === null ? null : { code: submission.rejection.code },
    terminal: observedTerminal,
    verificationStatuses,
    verdict,
    lifecycleLanding,
    outcomes,
    exercisedCapabilities,
    trajectoryDigest,
    observedModelCalls,
  };
  const appCriteria = verifyEquivalenceTestingAppContract({ row, observation });
  const contractPassed = appCriteria.every((criterion) => criterion.status === "PASS");

  // 3. The submission contract: the equivalence submission landed its
  //    OWN fresh execution (never a replay — a shoulder-in never passes).
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
    outcomes,
    exercisedCapabilities,
    trajectoryDigest,
    observedModelCalls,
    usage,
    submissionLatencyMs: submission.latencyMs,
  };
}
