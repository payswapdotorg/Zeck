/**
 * The economic-audit customer application (VAL-049).
 *
 * A real customer-style application: one pinned audit row per run —
 * the row's AUDIT ARM (REPRODUCIBILITY | ANTI-GAMING | BOUNDS), the
 * audited work orders (VAL-041..048), the AUDITED INPUT DIGEST
 * references (content digests into the recorded corpora — never
 * copies), the gaming vectors under probe (the anti-gaming arm) and
 * the expected audit verdict (REPRODUCIBLE-VERIFIED / BOUNDS-HELD /
 * GAMING-DETECTED with the mechanism NAMED / NOT-AUDITABLE with the
 * reason NAMED) — submitted through Zeck's public SDK boundary. The
 * application exercises the customer side of the audit contract:
 *
 *   * every row's submission lands ONE durable execution (the harness
 *     submit — the evidence carries the request fingerprint and the
 *     completion timeline);
 *   * the completion poll observes the row's terminal (COMPLETED for
 *     the honest audit rows — the reproducibility replays, the honest
 *     boundaries, the bounds checks and the gaming detections alike,
 *     since the honest audit verdict IS the verified outcome; FAILED
 *     when any mechanical criterion failed — including the four
 *     adversarial audit-probe rows whose dishonest audit shapes FAIL
 *     their named criteria);
 *   * the result retrieval observes the verification statuses — the
 *     app-side terminal↔criteria agreement is derived MECHANICALLY
 *     over the public result read (a fabricated pass-with-fail — a
 *     COMPLETED terminal with a FAIL verification status — FAILs the
 *     app honestly: the anyFail→FAILED invariant probed at the
 *     customer boundary);
 *   * the task body carries REFERENCES ONLY (the arm, the audited
 *     work orders, the digest references, the gaming vectors) — never
 *     a price, never a recorded result copy (the platform resolves
 *     the recorded corpora through their registries).
 *
 * The application's own assertions verify the per-row outcome contract
 * through the VAL-040 app-contract derivation (imported, never copied)
 * — a fabricated outcome never passes a row whose outcome contract is
 * violated.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type { LabVerificationCriterion } from "../../platform/derive";
import type { EconomicCorpusRow } from "../economic-baseline/driver";
import { verifyEconomicAppContract } from "../economic-baseline/driver";
import { AUDIT_CORPUS, submissionKey, taskBodyFor } from "./corpus";

/** The app's full run outcome (evidence + assertions + outcome contract). */
export interface AuditAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly auditCriteria: readonly LabVerificationCriterion[];
  /** The observed terminal from the public execution read. */
  readonly observedTerminal: string | null;
  /** The verification statuses from the public result read. */
  readonly verificationStatuses: readonly string[];
  /** The measured submission latency (ms). */
  readonly submissionLatencyMs: readonly number[];
}

/** The app's pinned corpus slice (`economic-audit.experiment.v1` rows). */
export const AUDIT_TASKS = AUDIT_CORPUS.map((row) => ({
  kind: "economic-audit.experiment.v1",
  rowId: row.rowId,
  expectedTerminal: row.expected.terminal,
  arm: row.arm,
  expectedVerdict: row.expected.verdict,
  auditedWorkOrders: [...row.auditedWorkOrders],
  ...(row.gamingVectors === undefined ? {} : { gamingVectors: [...row.gamingVectors] }),
  ...(row.combinedVectors === undefined ? {} : { combinedVectors: [...row.combinedVectors] }),
  ...(row.adversarial === undefined ? {} : { adversarial: row.adversarial }),
  ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
  appCreated: row.expected.appCreated,
  replayedSubmissions: row.expected.replayedSubmissions,
  rejectedSubmissions: row.expected.rejectedSubmissions,
}));

/**
 * Run the economic-audit application end to end over one pinned corpus
 * row: submit → poll to the row's terminal → retrieve the result (the
 * verification statuses) → the deterministic assertions → the
 * app-side audit contract. The transport implementation is injected
 * (the SDK's seam); the app never selects pricing and never copies
 * recorded results (the row declares the digest references; the
 * platform resolves the corpora).
 */
export async function runAuditApp(options: {
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
}): Promise<AuditAppResult> {
  const row = AUDIT_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned audit task slice is empty");
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
      workOrder: "VAL-049",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  const key = submissionKey({ runSuffix: options.runSuffix, taskIndex: options.taskIndex });
  const body = taskBodyFor({ row });
  const request = { applicationId: options.config.applicationId, task: body };
  const submissionLatencyMs: number[] = [];

  // ---- the submission phase ----
  const submittedAt = options.now().getTime();
  let executionId = "";
  let rejected = false;
  try {
    const run = await harness.submit(request, key);
    submissionLatencyMs.push(options.now().getTime() - submittedAt);
    executionId = run.executionId;
    rejected = executionId === "";
  } catch (error: unknown) {
    submissionLatencyMs.push(options.now().getTime() - submittedAt);
    rejected = true;
    void error;
  }
  if (rejected) {
    // The submission itself was rejected — an honest app failure with
    // NO outcome to reconcile (never a fabricated completion).
    return {
      evidence: harness.evidence(),
      passed: false,
      auditCriteria: [
        {
          criterionId: "submission-landed",
          strategy: "deterministic",
          status: "FAIL",
          evidence: ["rejection:the submission never landed a durable execution"],
        },
      ],
      observedTerminal: null,
      verificationStatuses: [],
      submissionLatencyMs,
    };
  }

  // ---- the completion phase (poll to the row's terminal) ----
  const observedTerminal = await harness.awaitCompletion(executionId);

  // ---- the result-retrieval phase (the verification statuses) ----
  const result = await harness.retrieveResult(executionId);
  const verificationStatuses =
    result === null ? [] : result.verification.map((entry) => entry.status as string);

  // ---- the assertion phase ----
  // 1. The harness's deterministic outcome assertions (the terminal
  //    contract; the forbidden opposite; no retryable errors).
  const harnessPassed = harness.assertOutcome({
    expectTerminalStatus: row.expected.terminal,
    forbiddenTerminalStatuses: [row.expected.terminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  // 2. The app-side audit contract (the VAL-040 derivation,
  //    imported): the terminal↔criteria agreement over the public
  //    result read (the anyFail→FAILED invariant probed at the
  //    customer boundary) + the expected terminal met.
  const auditCriteria = verifyEconomicAppContract({
    row: row as unknown as EconomicCorpusRow,
    terminal: observedTerminal,
    verificationStatuses,
  });
  const contractPassed = auditCriteria.every((criterion) => criterion.status === "PASS");

  return {
    evidence: harness.evidence(),
    passed: harnessPassed && contractPassed,
    auditCriteria,
    observedTerminal,
    verificationStatuses,
    submissionLatencyMs,
  };
}
