/**
 * The customer-style sample application (VAL-002, acceptance criteria
 * 1 and 7).
 *
 * A MINIMAL application that integrates with Zeck exactly the way a
 * customer would: configuration from repository files + one
 * environment secret, submission through the public SDK client,
 * asynchronous completion, result retrieval, deterministic assertions
 * and evidence emission. It imports ONLY the public SDK and the
 * validation harness — never internal Zeck source (the import scanner
 * test proves it mechanically).
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";

/** The sample application's deterministic task. */
const SAMPLE_TASK = {
  kind: "summarize",
  input: "zeck-validation-sample-1",
} as const;

/** The idempotency key namespace of the sample app. */
const SAMPLE_IDEMPOTENCY_PREFIX = "val-002-sample";

/**
 * Run the sample application end to end.
 *
 * The transport implementation is injected (the SDK's seam): in
 * production it is the environment's global transport; in tests it can
 * be a controlled stub or a real client against a served API.
 */
export async function runSampleApp(options: {
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
  /** Unique suffix for the idempotency key (per invocation). */
  readonly runSuffix: string;
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
      workOrder: "VAL-002",
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
      task: SAMPLE_TASK,
    },
    `${SAMPLE_IDEMPOTENCY_PREFIX}-${options.runSuffix}`,
  );

  await harness.awaitCompletion(submitted.executionId);
  await harness.retrieveResult(submitted.executionId);

  const passed = harness.assertOutcome({
    expectTerminalStatus: "COMPLETED",
    expectVerificationStatuses: ["PASS"],
    forbiddenTerminalStatuses: ["FAILED", "CANCELLED", "EXPIRED"],
    forbidRetryableErrors: true,
  });

  return { evidence: harness.evidence(), passed };
}
