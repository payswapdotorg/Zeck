/**
 * The text-generation customer application (VAL-010).
 *
 * A real customer-style application: document summarization at a bounded
 * length. Integrates with Zeck exactly as a customer would — through the
 * public SDK boundary (the validation harness), with a repository-
 * reproducible, secret-free configuration and one environment secret.
 * It never imports Zeck internals and never selects a provider/model
 * (API-001: routing is the platform's authority).
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";

/** The app's pinned corpus slice (text.summarize-doc.v1 rows). */
export const TEXT_GENERATION_TASKS = [
  { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
  { kind: "summarize", doc: "research-abstract-01", maxWords: 40 },
  { kind: "summarize", doc: "changelog-01", maxWords: 25 },
] as const;

const IDEMPOTENCY_PREFIX = "val-010-text-generation";

/**
 * Run the text-generation application end to end over one pinned task.
 * The transport implementation is injected (the SDK's seam).
 */
export async function runTextGenerationApp(options: {
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

  const task = TEXT_GENERATION_TASKS[options.taskIndex] ?? TEXT_GENERATION_TASKS[0];
  const submitted = await harness.submit(
    {
      applicationId: options.config.applicationId,
      task: { ...task },
    },
    `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}`,
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
