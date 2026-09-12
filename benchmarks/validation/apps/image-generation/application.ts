/**
 * The image-generation customer application (VAL-015).
 *
 * A real customer-style application: text-to-image generation over
 * seeded prompt fixtures. Integrates with Zeck exactly as a customer
 * would — through the public SDK boundary (the validation harness),
 * with a repository-reproducible, secret-free configuration and one
 * environment secret. It never imports Zeck internals and never
 * selects a provider/model (API-001: routing is the platform's
 * authority).
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";

/**
 * The app's pinned corpus slice (`image-generation.from-prompt.v1`
 * rows). The seeded prompt fixtures make every dispatch reproducible
 * at the request level; the declared sizes ride the task (the platform
 * passes them to the rail and verifies the delivered raster's declared
 * dimensions against them).
 */
export const IMAGE_GENERATION_TASKS = [
  { kind: "generate-image", prompt: "img-prompt-001", width: 1328, height: 1328 },
  { kind: "generate-image", prompt: "img-prompt-002", width: 1328, height: 1328 },
  { kind: "generate-image", prompt: "img-prompt-003", width: 1664, height: 928 },
  // The corpus's own empty-prompt edge row: the platform rejects a
  // blank prompt BEFORE any paid dispatch — the honest expectation is
  // FAILED (never a fabricated image, never a silent pass).
  { kind: "generate-image", prompt: "" },
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

const IDEMPOTENCY_PREFIX = "val-015-image-generation";

/**
 * Run the image-generation application end to end over one pinned
 * task. The transport implementation is injected (the SDK's seam).
 */
export async function runImageGenerationApp(options: {
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
      workOrder: "VAL-015",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  const task = IMAGE_GENERATION_TASKS[options.taskIndex] ?? IMAGE_GENERATION_TASKS[0];
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
