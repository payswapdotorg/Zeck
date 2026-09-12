/**
 * The image-recognition customer application (VAL-017).
 *
 * A real customer-style application: classification of submitted images
 * against a fixed label vocabulary. Integrates with Zeck exactly as a
 * customer would — through the public SDK boundary (the validation
 * harness), with a repository-reproducible, secret-free configuration
 * and one environment secret. It never imports Zeck internals and never
 * selects a provider/model (API-001: routing is the platform's
 * authority).
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";

/** The app's pinned corpus slice (image-recognition.classify.v1 rows). */
export const IMAGE_RECOGNITION_TASKS = [
  { kind: "classify-image", image: "img-c-001", labels: ["bicycle", "bus", "car"] },
  { kind: "classify-image", image: "img-c-002", labels: ["bicycle", "bus", "car"] },
  { kind: "classify-image", image: "img-c-003", labels: ["bicycle", "bus", "car"] },
  // The corrupted-image edge row: the platform's honest expectation is
  // FAILED (the provider rejects genuinely undecodable media) — never a
  // fabricated label, never a silent pass.
  { kind: "classify-image", image: "img-corrupt", labels: ["bicycle", "bus", "car"] },
] as const;

/** Per-task outcome contracts (the corpus rows' own expectations). */
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

const IDEMPOTENCY_PREFIX = "val-017-image-recognition";

/**
 * Run the image-recognition application end to end over one pinned task.
 * The transport implementation is injected (the SDK's seam).
 */
export async function runImageRecognitionApp(options: {
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
      workOrder: "VAL-017",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  const task = IMAGE_RECOGNITION_TASKS[options.taskIndex] ?? IMAGE_RECOGNITION_TASKS[0];
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
