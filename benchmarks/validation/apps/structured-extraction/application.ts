/**
 * The structured-extraction customer application (VAL-010).
 *
 * A real customer-style application: invoice documents in, governed
 * JSON records out. Integrates with Zeck exactly as a customer would —
 * through the public SDK boundary — with repository-reproducible,
 * secret-free configuration and one environment secret. Provider/model
 * selection never appears in the request (API-001).
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";

/** The app's pinned corpus slice (structured.extract-invoice.v1 rows). */
export const STRUCTURED_EXTRACTION_TASKS = [
  { kind: "extract", format: "invoice", doc: "invoice-001" },
  { kind: "extract", format: "invoice", doc: "invoice-004" },
  { kind: "extract", format: "invoice", doc: "invoice-007" },
] as const;

/**
 * Per-row deterministic outcome expectations — the CORPUS rows' own
 * expected outcomes. The edge row (invoice-007, missing total) is
 * expected to FAIL honestly: a COMPLETED there would mean a fabricated
 * total (the corpus's forbidden outcome), so the app's assertion
 * contract for that row forbids COMPLETED.
 */
const TASK_EXPECTATIONS = [
  {
    expectTerminalStatus: "COMPLETED" as const,
    expectVerificationStatuses: ["PASS" as const],
    forbiddenTerminalStatuses: ["FAILED", "CANCELLED", "EXPIRED"] as const,
  },
  {
    expectTerminalStatus: "COMPLETED" as const,
    expectVerificationStatuses: ["PASS" as const],
    forbiddenTerminalStatuses: ["FAILED", "CANCELLED", "EXPIRED"] as const,
  },
  {
    expectTerminalStatus: "FAILED" as const,
    expectVerificationStatuses: ["FAIL" as const],
    forbiddenTerminalStatuses: ["COMPLETED"] as const,
  },
];

const IDEMPOTENCY_PREFIX = "val-010-structured-extraction";

/**
 * Run the structured-extraction application end to end over one pinned
 * task. The transport implementation is injected (the SDK's seam).
 */
export async function runStructuredExtractionApp(options: {
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
      workOrder: "VAL-010",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  const task = STRUCTURED_EXTRACTION_TASKS[options.taskIndex] ?? STRUCTURED_EXTRACTION_TASKS[0];
  const submitted = await harness.submit(
    {
      applicationId: options.config.applicationId,
      task: { ...task },
    },
    `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}`,
  );

  await harness.awaitCompletion(submitted.executionId);
  await harness.retrieveResult(submitted.executionId);

  const expectations = TASK_EXPECTATIONS[options.taskIndex] ?? TASK_EXPECTATIONS[0];
  const passed = harness.assertOutcome({
    ...expectations,
    forbidRetryableErrors: true,
  });

  return { evidence: harness.evidence(), passed };
}
