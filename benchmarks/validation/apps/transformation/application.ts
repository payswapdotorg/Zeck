/**
 * The transformation customer application (VAL-010).
 *
 * A real customer-style application: register rewriting (tone) and
 * record-set normalization between canonical shapes, submitted through
 * Zeck's public SDK boundary with repository-reproducible, secret-free
 * configuration. Provider/model selection never appears in the request
 * (API-001).
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";

/**
 * The app's pinned corpus slice: two register-rewrite rows
 * (text.transform-tone.v1) and two record-normalization rows
 * (structured.transform-records.v1).
 */
export const TRANSFORMATION_TASKS = [
  { kind: "transform", source: "snippet-01", register: "formal" },
  { kind: "transform", source: "snippet-04", register: "plain" },
  { kind: "transform-records", from: "csv", to: "json", set: "records-001" },
  { kind: "transform-records", from: "duplicates", to: "unique", set: "records-005" },
] as const;

const IDEMPOTENCY_PREFIX = "val-010-transformation";

/**
 * Run the transformation application end to end over one pinned task.
 * The transport implementation is injected (the SDK's seam).
 */
export async function runTransformationApp(options: {
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

  const task = TRANSFORMATION_TASKS[options.taskIndex] ?? TRANSFORMATION_TASKS[0];
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
