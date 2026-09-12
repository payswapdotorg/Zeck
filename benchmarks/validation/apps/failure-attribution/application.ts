/**
 * The failure-attribution customer application (VAL-020).
 *
 * A real customer-style application: one pinned failure-probe corpus
 * row per run — transport-failure, quota-envelope, rate-limit,
 * invalid-request, access-denied, empty-completion, tool-failure,
 * tool-timeout, healthy-recovery-after-retry, healthy-no-retry and the
 * env-gated live rail rows — submitted through Zeck's public SDK
 * boundary. The platform drives the bounded retry/recovery machinery
 * with per-attempt attribution journaling; this application asserts
 * the per-row deterministic outcome contract from the corpus: a
 * failure row must land the corpus-declared honest FAILED terminal (a
 * COMPLETED there would mean a fabricated recovery); the
 * empty-completion row must COMPLETED (an honest success with empty
 * content — a FAILED there would mean a fabricated failure); the
 * healthy and recovery rows must COMPLETED.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import { FAILURE_CORPUS } from "./corpus";

/** The app's pinned corpus slice (`failure-attribution.probe.v1` rows). */
export const FAILURE_ATTRIBUTION_TASKS = FAILURE_CORPUS.map((row) => ({
  kind: row.kind,
  scenario: row.rowId,
  ...(row.toolInvocation === undefined ? {} : { tool: row.toolInvocation.tool }),
  ...(row.toolInvocation === undefined ? {} : { arguments: { ...row.toolInvocation.arguments } }),
  /** The corpus row's own expected terminal (the app's outcome contract). */
  expectedTerminal: row.expected.terminal,
}));

const IDEMPOTENCY_PREFIX = "val-020-failure-attribution";

/**
 * Run the failure-attribution application end to end over one pinned
 * corpus row. The transport implementation is injected (the SDK's
 * seam); the app never selects provider/model/rail (the platform's
 * authority).
 */
export async function runFailureAttributionApp(options: {
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
}): Promise<{ readonly evidence: HarnessEvidence; readonly passed: boolean }> {
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
      workOrder: "VAL-020",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  const task = FAILURE_ATTRIBUTION_TASKS[options.taskIndex] ?? FAILURE_ATTRIBUTION_TASKS[0];
  if (task === undefined) {
    throw new Error("the pinned failure-attribution task slice is empty");
  }
  const { expectedTerminal, ...payload } = task;
  const submitted = await harness.submit(
    {
      applicationId: options.config.applicationId,
      task: { ...payload },
    },
    `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}`,
  );

  await harness.awaitCompletion(submitted.executionId);
  await harness.retrieveResult(submitted.executionId);

  // The deterministic outcome contract per corpus row: failure rows
  // EXPECT the honest FAILED terminal (a fabricated COMPLETED fails
  // the app); the empty-completion and healthy rows expect COMPLETED.
  // 2026-09-12 Lead review fix: in THIS slice the verification criteria
  // prove the ATTRIBUTION (class/layer/attempts vs the row's oracle) —
  // a correctly-attributed provider failure PASSES its criteria while
  // the terminal stays honestly FAILED. The generic FAIL-status
  // expectation (the VAL-019 outcome-template) never held here: the
  // live crown's first PG-backed run surfaced all-PASS criteria on
  // FAILED rows as the DESIGNED outcome, failing the app's assertion.
  const passed = harness.assertOutcome({
    expectTerminalStatus: expectedTerminal,
    expectVerificationStatuses: ["PASS"],
    forbiddenTerminalStatuses: [expectedTerminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  return { evidence: harness.evidence(), passed };
}
