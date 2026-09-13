/**
 * The learning-discovery customer application (VAL-032).
 *
 * A real customer-style application riding Zeck's public SDK boundary:
 * one pinned discovery corpus row per run — the row's recorded
 * VAL-031 replay population mined for its declared candidate kind,
 * submitted as a DISCOVERY task (the propose-only declaration rides
 * the task semantics: discovery proposes, never applies; the app
 * never selects provider/model/rail — the platform keeps the route
 * authority). The application exercises the discovery contract at the
 * customer boundary in three phases:
 *
 *   * the discovery-submission phase — the row's discovery run lands
 *     its OWN durable execution through the harness submit under its
 *     OWN idempotency key (one submission per row);
 *   * the observation phase — the completion poll observes the run's
 *     honest terminal (COMPLETED for every row: an honest REFUSAL is
 *     a completed discovery, never a fabricated failure), the result
 *     retrieval observes the verification statuses, the route's
 *     model-call count (zero offline — the mining is ledger-level; the
 *     live row's REAL confirmation round), the honest usage (measured
 *     on the live rail, honestly none offline) and the discovery
 *     outcome read back (the proposal record or the honest refusal),
 *     and the events read re-derives the discovery trajectory digest
 *     over the PUBLIC step-event journal (the app never trusts the
 *     platform's own claim);
 *   * the assertion phase — the app's own assertions verify the
 *     per-row discovery contract through the platform slice's PURE
 *     `verifyLearningDiscoveryAppContract`: the read-back proposal
 *     matches the pinned oracle (kind, mined-structure digest, the
 *     `proposed` lifecycle stage — an applied proposal never passes)
 *     and its evidence citation is re-derived COMPLETE at the boundary
 *     over the row's declared population (an uncited, partial or
 *     fabricated citation never passes), the conservatism is
 *     re-derived at the boundary (a variance-smoothing proposal never
 *     passes), an honest refusal is reported with its pinned reason,
 *     and the discovery made its OWN dispatches.
 */

import { createZeckClient, ZeckApiError } from "../../../../sdk";
import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type { LabUsage, LabVerificationCriterion } from "../../platform/derive";
import type { AppDiscoveryObservation } from "../../platform/learning-discovery";
import { verifyLearningDiscoveryAppContract } from "../../platform/learning-discovery";
import { appTrajectoryDigestOf } from "../../platform/longitudinal-baseline";
import {
  discoverySubmissionKey,
  discoveryTaskBodyFor,
  LEARNING_DISCOVERY_CORPUS,
  LEARNING_DISCOVERY_TASK_KIND,
} from "./corpus";

/** One discovery submission's observation (the app's own receipt view). */
export interface DiscoverySubmissionObservation {
  readonly executionId: string;
  readonly replayed: boolean;
  readonly status: string | null;
  readonly rejection: { readonly code: string; readonly status: number } | null;
  readonly submittedAt: number;
  readonly latencyMs: number;
}

/** The discovery outcome as read back through the public result read. */
export interface DiscoveryOutcomeReadback {
  readonly proposal: {
    readonly proposalId: string;
    readonly kind: string;
    readonly citation: {
      readonly trajectoryDigests: readonly string[];
      readonly replayIdentities: readonly string[];
    };
    readonly minedStructureDigest: string;
    readonly lifecycleStage: string;
  } | null;
  readonly refusal: { readonly reason: string } | null;
}

/** The app's full run outcome (evidence + assertions + the discovery contract). */
export interface LearningDiscoveryAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly appCriteria: readonly LabVerificationCriterion[];
  readonly submission: DiscoverySubmissionObservation;
  readonly observedTerminal: string | null;
  readonly verificationStatuses: readonly string[];
  readonly outcome: DiscoveryOutcomeReadback;
  /** The app-side trajectory digest over the public events read. */
  readonly trajectoryDigest: string | null;
  readonly observedModelCalls: number | null;
  /** The run's measured usage (the live row; honestly null offline). */
  readonly usage: LabUsage | null;
  readonly submissionLatencyMs: number;
}

/** The app's pinned corpus slice (`learning-discovery.proposal.v1` rows). */
export const LEARNING_DISCOVERY_TASKS = LEARNING_DISCOVERY_CORPUS.map((row) => ({
  kind: LEARNING_DISCOVERY_TASK_KIND,
  rowId: row.rowId,
  replayPopulationRefs: [...row.replayPopulationRefs],
  candidateKind: row.candidateKind,
  populationSize: row.population.length,
  distinctTrajectoryDigests: new Set(row.population.map((o) => o.trajectoryDigest)).size,
  replayIdentities: row.population.length,
  expectedEmitsProposal: row.expected.emitsProposal,
  expectedKind: row.expected.kind,
  expectedRefusalReason: row.expected.refusalReason,
  expectedStructureDigest: row.expected.minedStructureDigest,
  trajectoryClassSize: row.expectedTrajectoryClass.length,
  expectedModelCalls: row.expected.modelCalls,
  ...(row.probe === undefined ? {} : { probe: row.probe.kind }),
  ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
}));

/**
 * Run the learning-discovery application end to end over one pinned
 * corpus row: submit the discovery task (under its OWN idempotency
 * key) → poll the run to its terminal → retrieve the result (the
 * verification statuses, the route's model-call count, the honest
 * usage and the discovery outcome read back) → read the events (the
 * app-side discovery trajectory digest over the public journal) →
 * verify the per-row discovery contract. The transport implementation
 * is injected (the SDK's seam); the app never selects
 * provider/model/rail (the platform's authority).
 */
export async function runLearningDiscoveryApp(options: {
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
}): Promise<LearningDiscoveryAppResult> {
  const row = LEARNING_DISCOVERY_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned learning-discovery task slice is empty");
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
      workOrder: "VAL-032",
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

  // ---- the discovery-submission phase (one submission per row) ----
  const key = discoverySubmissionKey({
    runSuffix: options.runSuffix,
    taskIndex: options.taskIndex,
  });
  const body = discoveryTaskBodyFor({
    rowId: row.rowId,
    candidateKind: row.candidateKind,
  });
  const request = { applicationId: options.config.applicationId, task: body };
  const submittedAt = options.now().getTime();
  let submission: DiscoverySubmissionObservation;
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
  let outcome: DiscoveryOutcomeReadback = { proposal: null, refusal: null };
  let observedModelCalls: number | null = null;
  let usage: LabUsage | null = null;
  let trajectoryDigest: string | null = null;
  if (submission.rejection === null && submission.executionId !== "") {
    const executionId = submission.executionId;
    observedTerminal = await harness.awaitCompletion(executionId);

    // The result read: the verification statuses, the route's own
    // model-call count, the honest usage and the discovery outcome
    // read back (the proposal record or the honest refusal).
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
      proposal: DiscoveryOutcomeReadback["proposal"];
      refusal: DiscoveryOutcomeReadback["refusal"];
    }>;
    outcome = {
      proposal: view.proposal ?? null,
      refusal: view.refusal ?? null,
    };

    // The events read: the app mechanically re-derives the discovery
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

  // 2. The app-side discovery contract (PURE): the read-back proposal
  //    matches the pinned oracle — the kind, the mined-structure
  //    digest, the proposed lifecycle stage, the evidence-citation
  //    completeness re-derived at the boundary, the conservatism
  //    re-derived at the boundary — an honest refusal carries its
  //    pinned reason, the discovery made its own dispatches, and the
  //    app-side trajectory digest is a member of the pinned class.
  const observation: AppDiscoveryObservation = {
    executionId: submission.executionId,
    replayed: submission.replayed,
    rejection: submission.rejection === null ? null : { code: submission.rejection.code },
    terminal: observedTerminal,
    verificationStatuses,
    proposal: outcome.proposal,
    refusal: outcome.refusal,
    trajectoryDigest,
    observedModelCalls,
  };
  const appCriteria = verifyLearningDiscoveryAppContract({ row, observation });
  const contractPassed = appCriteria.every((criterion) => criterion.status === "PASS");

  // 3. The submission contract: the discovery submission landed its OWN
  //    fresh execution (never a replay — a shoulder-in never passes).
  const submissionsPassed = submission.replayed === false && submission.rejection === null;

  return {
    evidence: harness.evidence(),
    passed: harnessPassed && contractPassed && submissionsPassed,
    appCriteria,
    submission,
    observedTerminal,
    verificationStatuses,
    outcome,
    trajectoryDigest,
    observedModelCalls,
    usage,
    submissionLatencyMs: submission.latencyMs,
  };
}
