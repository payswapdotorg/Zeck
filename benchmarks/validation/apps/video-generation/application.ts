/**
 * The video-generation customer application (VAL-016).
 *
 * A real customer-style application: text-to-video generation over
 * seeded storyboard prompt fixtures, riding the platform's
 * ASYNCHRONOUS generation rail end to end (submission → task identity
 * → bounded polling → terminal artifact → mechanical verification).
 * Integrates with Zeck exactly as a customer would — through the
 * public SDK boundary (the validation harness), with a
 * repository-reproducible, secret-free configuration and one
 * environment secret. It never imports Zeck internals and never
 * selects a provider/model (API-001: routing is the platform's
 * authority).
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";

/**
 * The app's pinned corpus slice (`video-media.clip-from-prompt.v1`
 * rows). The seeded storyboard prompt fixtures make every dispatch
 * reproducible at the request level; the declared durations and
 * aspects ride the task (the platform passes them to the rail as the
 * bounded generation parameters and verifies the delivered artifact
 * mechanically).
 */
export const VIDEO_GENERATION_TASKS = [
  { kind: "generate-video", prompt: "vid-prompt-001", seconds: 5, aspect: "16:9" as const },
  { kind: "generate-video", prompt: "vid-prompt-003", seconds: 5, aspect: "16:9" as const },
  { kind: "generate-video", prompt: "vid-prompt-006", seconds: 5, aspect: "9:16" as const },
  // The corpus's own zero-seconds edge row: the platform rejects a
  // zero-duration task BEFORE any paid dispatch — the honest
  // expectation is FAILED (never a fabricated clip, never a silent
  // pass).
  { kind: "generate-video", prompt: "vid-prompt-005", seconds: 0 },
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

const IDEMPOTENCY_PREFIX = "val-016-video-generation";

/**
 * Run the video-generation application end to end over one pinned
 * task. The transport implementation is injected (the SDK's seam).
 */
export async function runVideoGenerationApp(options: {
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
      workOrder: "VAL-016",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  const task = VIDEO_GENERATION_TASKS[options.taskIndex] ?? VIDEO_GENERATION_TASKS[0];
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
