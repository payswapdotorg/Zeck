/**
 * The audio-understanding customer application (VAL-017).
 *
 * A real customer-style application: classification of submitted audio
 * clips against a fixed event vocabulary. Integrates with Zeck exactly
 * as a customer would — through the public SDK boundary (the validation
 * harness), with a repository-reproducible, secret-free configuration
 * and one environment secret. It never imports Zeck internals and never
 * selects a provider/model (API-001: routing is the platform's
 * authority).
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";

/** The app's pinned corpus slice (audio-understanding.classify-event.v1 rows). */
export const AUDIO_UNDERSTANDING_TASKS = [
  { kind: "classify-audio", clip: "event-001", labels: ["doorbell", "alarm", "music"] },
  { kind: "classify-audio", clip: "event-002", labels: ["doorbell", "alarm", "music"] },
  // The corrupted-clip edge row: the platform's honest expectation is
  // FAILED (the provider rejects genuinely undecodable audio) — never a
  // fabricated label, never a silent pass.
  { kind: "classify-audio", clip: "audio-corrupt", labels: ["doorbell", "alarm", "music"] },
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
    expectTerminalStatus: "FAILED" as const,
    expectVerificationStatuses: ["FAIL" as const],
    forbiddenTerminalStatuses: ["COMPLETED"] as const,
  },
];

const IDEMPOTENCY_PREFIX = "val-017-audio-understanding";

/**
 * Run the audio-understanding application end to end over one pinned
 * task. The transport implementation is injected (the SDK's seam).
 */
export async function runAudioUnderstandingApp(options: {
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

  const task = AUDIO_UNDERSTANDING_TASKS[options.taskIndex] ?? AUDIO_UNDERSTANDING_TASKS[0];
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
