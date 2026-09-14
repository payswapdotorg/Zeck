/**
 * The economic-competitive-benchmark customer application (VAL-048).
 *
 * A real customer-style application: one pinned cross-workload
 * competitive row per run — the row's COMPARISON FAMILY
 * (quality-adjusted-ranking | latency-adjusted-ranking |
 * failure-adjusted-ranking | portfolio-weighted-aggregate), the
 * workload class (the pre-registered competitive cohort), the
 * PRE-REGISTERED arm set (digest references into the recorded
 * corpora: the VAL-040 Zeck rows, the VAL-041 direct controls, the
 * VAL-042 optimized baseline runs, the VAL-043 competing runs), the
 * VAL-044 adjusted-basis references, the Zeck longitudinal context
 * (the VAL-045 attribution + the VAL-047 curves — disclosed, never
 * mixed), the VAL-046 substrate disclosures, the statistical minimums,
 * the Wilson configuration, the declared multiple-comparison policy,
 * the portfolio aggregate's EXPLICIT weights and the expected verdict
 * REFERENCE — submitted through Zeck's public SDK boundary. The
 * application exercises the customer side of the competitive
 * contract:
 *
 *   * every row's submission lands ONE durable execution (the harness
 *     submit — the evidence carries the request fingerprint and the
 *     completion timeline);
 *   * the completion poll observes the row's terminal (COMPLETED for
 *     the honest verdict rows — wins, ties, null-basis and
 *     under-powered alike, since the honest classification IS the
 *     verified outcome; FAILED when any mechanical criterion failed —
 *     including the six adversarial probe rows whose denatured
 *     shapes FAIL their named criteria);
 *   * the result retrieval observes the verification statuses — the
 *     app-side terminal↔criteria agreement is derived MECHANICALLY
 *     over the public result read (a fabricated pass-with-fail — a
 *     COMPLETED terminal with a FAIL verification status — FAILs the
 *     app honestly: the anyFail→FAILED invariant probed at the
 *     customer boundary);
 *   * the task body carries REFERENCES ONLY (the family, the workload
 *     class, the arm-set digest references, the adjusted-basis
 *     references, the curve context digest, the minimums, the policy,
 *     the weights) — never an inline price, never a recorded result
 *     copy (the platform resolves the recorded corpora and the
 *     manifests through their registries).
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
import { COMPETITIVE_CORPUS, submissionKey, taskBodyFor } from "./corpus";

/** The app's full run outcome (evidence + assertions + outcome contract). */
export interface CompetitiveAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly competitiveCriteria: readonly LabVerificationCriterion[];
  /** The observed terminal from the public execution read. */
  readonly observedTerminal: string | null;
  /** The verification statuses from the public result read. */
  readonly verificationStatuses: readonly string[];
  /** The measured submission latency (ms). */
  readonly submissionLatencyMs: readonly number[];
}

/** The app's pinned corpus slice (`economic-competitive-benchmark.experiment.v1` rows). */
export const COMPETITIVE_TASKS = COMPETITIVE_CORPUS.map((row) => ({
  kind: "economic-competitive-benchmark.experiment.v1",
  rowId: row.rowId,
  expectedTerminal: row.expected.terminal,
  family: row.family,
  workloadClass: row.workloadClass,
  expectedVerdict: row.expected.verdict,
  minimumPairedRounds: row.minimumPairedRounds,
  minimumDistinctArms: row.minimumDistinctArms,
  armSetSize: row.armSet.length,
  multipleComparisonFamilySize: row.multipleComparison.familySize,
  ...(row.latencyBudgetMs === undefined ? {} : { latencyBudgetMs: row.latencyBudgetMs }),
  ...(row.declaredWeights === undefined
    ? {}
    : {
        declaredWeights: row.declaredWeights.map((entry) => ({
          workloadClass: entry.workloadClass,
          weight: entry.weight,
        })),
      }),
  ...(row.adversarial === undefined ? {} : { adversarial: row.adversarial }),
  ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
  appCreated: row.expected.appCreated,
  replayedSubmissions: row.expected.replayedSubmissions,
  rejectedSubmissions: row.expected.rejectedSubmissions,
}));

/**
 * Run the economic-competitive-benchmark application end to end over
 * one pinned corpus row: submit → poll to the row's terminal →
 * retrieve the result (the verification statuses) → the deterministic
 * assertions → the app-side economic contract. The transport
 * implementation is injected (the SDK's seam); the app never selects
 * pricing and never copies recorded results (the row declares the
 * digest references; the platform resolves the corpora).
 */
export async function runCompetitiveApp(options: {
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
}): Promise<CompetitiveAppResult> {
  const row = COMPETITIVE_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned cross-workload competitive task slice is empty");
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
      workOrder: "VAL-048",
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
      competitiveCriteria: [
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

  // 2. The app-side economic contract (the VAL-040 derivation,
  //    imported): the terminal↔criteria agreement over the public
  //    result read (the anyFail→FAILED invariant probed at the
  //    customer boundary) + the expected terminal met.
  const competitiveCriteria = verifyEconomicAppContract({
    row: row as unknown as EconomicCorpusRow,
    terminal: observedTerminal,
    verificationStatuses,
  });
  const contractPassed = competitiveCriteria.every((criterion) => criterion.status === "PASS");

  return {
    evidence: harness.evidence(),
    passed: harnessPassed && contractPassed,
    competitiveCriteria,
    observedTerminal,
    verificationStatuses,
    submissionLatencyMs,
  };
}
