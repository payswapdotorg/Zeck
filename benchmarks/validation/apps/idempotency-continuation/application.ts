/**
 * The idempotency-and-continuation customer application (VAL-021).
 *
 * A real customer-style application: one pinned corpus row per run —
 * the duplicate/conflict/retry/escalate/continue submission patterns —
 * submitted through Zeck's public SDK boundary. The application
 * exercises the SUBMISSION side of the exactly-once contract:
 *
 *   * duplicate rows submit the SAME create (same key + same body)
 *     twice — the replayed receipt must preserve the identity and
 *     surface the replayed flag;
 *   * conflict rows submit the same key with a MUTATED task body —
 *     the platform must answer with the typed IDEMPOTENCY_KEY_REUSED
 *     rejection (409), never a second execution;
 *   * retry-storm rows submit the SAME create five times — the ledger
 *     converges the storm (one created + four replays);
 *   * escalate/continue rows submit once and let the platform-side
 *     driver exercise the escalation routing and the continuation
 *     machinery.
 *
 * The application's own assertions verify the per-row outcome
 * contract (the corpus-declared terminal + PASS verification
 * statuses) AND the submission contract (the replay/rejection counts,
 * the identity preservation, the typed rejection code) — a fabricated
 * COMPLETED never passes a row whose submission contract is violated.
 */

import { ZeckApiError } from "../../../../sdk";
import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type { LabVerificationCriterion } from "../../platform/derive";
import {
  type SubmissionObservation,
  verifySubmissionContract,
} from "../../platform/idempotency-continuation";
import { CONTINUATION_CORPUS, IDEMPOTENCY_TASK_KIND, taskBodyFor } from "./corpus";

/** The app's pinned corpus slice (one entry per corpus row). */
export const IDEMPOTENCY_CONTINUATION_TASKS = CONTINUATION_CORPUS.map((row) => ({
  kind: IDEMPOTENCY_TASK_KIND,
  rowId: row.rowId,
  pattern: row.pattern,
  expectedTerminal: row.expected.terminal,
  submissions: row.submissions.count,
  replayedSubmissions: row.expected.replayedSubmissions,
  rejectedSubmissions: row.expected.rejectedSubmissions,
}));

/** The app's measured submission facts (the pattern's ledger outcome). */
export interface SubmissionFacts {
  readonly submissions: number;
  readonly created: number;
  readonly replayed: number;
  readonly rejected: number;
  readonly firstExecutionId: string | null;
}

/** The app's full run outcome (evidence + assertions + submission contract). */
export interface IdempotencyContinuationAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly submissionFacts: SubmissionFacts;
  readonly submissionCriteria: readonly LabVerificationCriterion[];
}

const IDEMPOTENCY_PREFIX = "val-021-idempotency-continuation";

/**
 * Run the idempotency-and-continuation application end to end over one
 * pinned corpus row. The transport implementation is injected (the
 * SDK's seam); the app never selects provider/model/rail (the
 * platform's authority).
 */
export async function runIdempotencyContinuationApp(options: {
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
}): Promise<IdempotencyContinuationAppResult> {
  const row = CONTINUATION_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned idempotency-continuation task slice is empty");
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
      workOrder: "VAL-021",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  // ---- the submission phase (the pattern's own behavior) ----
  const idempotencyKey = `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}`;
  const request = {
    applicationId: options.config.applicationId,
    task: taskBodyFor(row),
  };
  const observations: SubmissionObservation[] = [];
  let firstExecutionId: string | null = null;

  for (let submission = 1; submission <= row.submissions.count; submission += 1) {
    // The conflict row's SECOND submission carries the mutated task
    // body (the different fingerprint — the same key must never
    // silently adopt it).
    const isConflictingSubmission =
      row.pattern === "conflict" &&
      submission === 2 &&
      row.submissions.conflictingTask !== undefined;
    const body = isConflictingSubmission
      ? {
          applicationId: options.config.applicationId,
          task: { ...row.submissions.conflictingTask },
        }
      : request;
    try {
      const submitted = await harness.submit(body, idempotencyKey);
      if (firstExecutionId === null) {
        firstExecutionId = submitted.executionId;
      }
      observations.push({
        executionId: submitted.executionId,
        replayed: submitted.replayed,
        status: submitted.initialStatus,
        rejection: null,
      });
    } catch (error) {
      // The typed rejection (the conflict row's expected answer): a
      // ZeckApiError carrying the platform's IDEMPOTENCY_KEY_REUSED
      // code on HTTP 409. Anything else is an honest failure (the
      // observation records what actually surfaced).
      if (error instanceof ZeckApiError) {
        observations.push({
          executionId: "",
          replayed: false,
          status: null,
          rejection: { code: error.body.code, status: error.status },
        });
      } else {
        observations.push({
          executionId: "",
          replayed: false,
          status: null,
          rejection: { code: "UNEXPECTED", status: 0 },
        });
      }
    }
  }

  // ---- the completion + retrieval phase ----
  if (firstExecutionId === null) {
    // Every submission was rejected — the app cannot await any
    // execution. This is a violated contract for every corpus row
    // (each row's FIRST submission must create).
    const submissionCriteria = verifySubmissionContract({
      expected: {
        submissions: row.submissions.count,
        replayedSubmissions: row.expected.replayedSubmissions,
        rejectedSubmissions: row.expected.rejectedSubmissions,
      },
      firstExecutionId: null,
      observations,
    });
    return {
      evidence: harness.evidence(),
      passed: false,
      submissionFacts: {
        submissions: observations.length,
        created: 0,
        replayed: 0,
        rejected: observations.length,
        firstExecutionId: null,
      },
      submissionCriteria,
    };
  }
  await harness.awaitCompletion(firstExecutionId);
  await harness.retrieveResult(firstExecutionId);

  // ---- the assertion phase ----
  // The outcome contract: the corpus-declared terminal (the exhausted
  // retry row EXPECTS the honest FAILED; every other row expects
  // COMPLETED) + PASS verification statuses (the driver's criteria
  // prove the semantics — a correctly-bounded exhausted storm PASSES
  // its criteria while the terminal stays honestly FAILED).
  const harnessPassed = harness.assertOutcome({
    expectTerminalStatus: row.expected.terminal,
    expectVerificationStatuses: ["PASS"],
    forbiddenTerminalStatuses: [row.expected.terminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  const submissionCriteria = verifySubmissionContract({
    expected: {
      submissions: row.submissions.count,
      replayedSubmissions: row.expected.replayedSubmissions,
      rejectedSubmissions: row.expected.rejectedSubmissions,
    },
    firstExecutionId,
    observations,
  });
  const submissionPassed = submissionCriteria.every((criterion) => criterion.status === "PASS");

  const facts: SubmissionFacts = {
    submissions: observations.length,
    created: observations.filter((o) => !o.replayed && o.rejection === null).length,
    replayed: observations.filter((o) => o.replayed && o.rejection === null).length,
    rejected: observations.filter((o) => o.rejection !== null).length,
    firstExecutionId,
  };

  return {
    evidence: harness.evidence(),
    passed: harnessPassed && submissionPassed,
    submissionFacts: facts,
    submissionCriteria,
  };
}
