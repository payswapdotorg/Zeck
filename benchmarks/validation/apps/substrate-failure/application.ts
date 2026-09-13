/**
 * The substrate-failure customer application (VAL-022).
 *
 * A real customer-style application: one pinned corpus execution per
 * run — sandbox unavailability at submission, readiness recovery,
 * mid-execution sandbox loss with fresh-sandbox retry, the exhausted
 * bound, the timeout/OOM classifications, quarantine propagation —
 * submitted through Zeck's public SDK boundary. The platform drives
 * the readiness-gated bounded recovery machinery with per-attempt
 * substrate journaling; this application asserts the per-row
 * deterministic outcome contract from the corpus: a substrate-failure
 * row must land the corpus-declared honest FAILED terminal (a
 * COMPLETED there would mean a fabricated recovery); the recovery and
 * healthy rows must COMPLETED.
 *
 * The app's task slice is FLAT: one entry per EXECUTION (the
 * quarantine row carries three — the registry state carries across
 * them platform-side; each submission is a distinct execution with a
 * per-execution-distinct idempotency key, the VAL-018 lesson).
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import {
  SUBSTRATE_CORPUS,
  SUBSTRATE_FAILURE_TASKS,
  type SubstrateCorpusRow,
  taskBodyFor,
} from "./corpus";

const IDEMPOTENCY_PREFIX = "val-022-substrate-readiness";

/**
 * Run the substrate-failure application end to end over one pinned
 * corpus execution. The transport implementation is injected (the
 * SDK's seam); the app never selects provider/model/substrate (the
 * platform's authority — the task references the corpus scenario; the
 * platform derives the route and the substrate policy).
 */
export async function runSubstrateFailureApp(options: {
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
  /** The FLAT task index (one entry per execution, in corpus order). */
  readonly taskIndex: number;
}): Promise<{ readonly evidence: HarnessEvidence; readonly passed: boolean }> {
  const task = SUBSTRATE_FAILURE_TASKS[options.taskIndex];
  if (task === undefined) {
    throw new Error("the pinned substrate-failure task slice is empty");
  }
  // Locate the row + execution for the flat entry (the platform-side
  // driver binds the same corpus; the app only submits the task body).
  let row: SubstrateCorpusRow | undefined;
  let executionIndex = 0;
  let cursor = 0;
  for (const candidate of SUBSTRATE_CORPUS) {
    if (cursor + candidate.executions.length > options.taskIndex) {
      row = candidate;
      executionIndex = options.taskIndex - cursor;
      break;
    }
    cursor += candidate.executions.length;
  }
  if (row === undefined) {
    throw new Error(`no corpus row for flat task index ${options.taskIndex}`);
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
      workOrder: "VAL-022",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  const submitted = await harness.submit(
    {
      applicationId: options.config.applicationId,
      task: taskBodyFor(row, executionIndex),
    },
    // Per-EXECUTION-distinct key: every execution is a distinct durable
    // payload (the quarantine row's three submissions must never
    // collide on the ledger — the VAL-018 lesson).
    `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}`,
  );

  await harness.awaitCompletion(submitted.executionId);
  await harness.retrieveResult(submitted.executionId);

  // The deterministic outcome contract per corpus execution: the
  // substrate-failure rows EXPECT the honest FAILED terminal (a
  // fabricated COMPLETED fails the app); the recovery/healthy rows
  // expect COMPLETED. Per the VAL-020 review calibration the
  // verification criteria prove the SEMANTICS (classification, bounded
  // retry, readiness gating, quarantine) — a correctly-classified
  // substrate failure PASSES its criteria while the terminal stays
  // honestly FAILED.
  const passed = harness.assertOutcome({
    expectTerminalStatus: task.expectedTerminal,
    expectVerificationStatuses: ["PASS"],
    forbiddenTerminalStatuses: [task.expectedTerminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  return { evidence: harness.evidence(), passed };
}
