/**
 * The long-running/resumable agent customer application (VAL-013).
 *
 * A real customer-style application: batch jobs whose executions span
 * checkpoints, external interruptions and resumes, submitted through
 * Zeck's public SDK boundary. The platform drives the checkpointed
 * agent (durable checkpoints with digests, wait-user/resume cycles,
 * exactly-once effects, corruption detection) and records the
 * mechanically verified outcome; this application asserts the
 * deterministic outcome contract per task.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import { BATCH_JOBS, LONG_RUNNING_TASKS } from "./batch-jobs";

const IDEMPOTENCY_PREFIX = "val-013-long-running";

/** Per-task expected terminal (the corpus rows' own expectations). */
export function expectedTerminalFor(taskIndex: number): "COMPLETED" | "FAILED" {
  const job = BATCH_JOBS[taskIndex];
  return (job?.expectedTerminal ?? "COMPLETED") as "COMPLETED" | "FAILED";
}

/**
 * Run the long-running application end to end over one pinned task.
 * The transport implementation is injected (the SDK's seam).
 */
export async function runLongRunningApp(options: {
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
      workOrder: "VAL-013",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  const task = LONG_RUNNING_TASKS[options.taskIndex] ?? LONG_RUNNING_TASKS[0];
  if (task === undefined) {
    throw new Error("the pinned long-running task slice is empty");
  }
  const expectedTerminal = expectedTerminalFor(options.taskIndex);
  const submitted = await harness.submit(
    {
      applicationId: options.config.applicationId,
      task: { ...task },
    },
    `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}`,
  );

  await harness.awaitCompletion(submitted.executionId);
  await harness.retrieveResult(submitted.executionId);

  // The deterministic outcome contract per corpus row: healthy runs
  // COMPLETED+PASS; the corrupted-checkpoint edge FAILS honestly (a
  // COMPLETED there would mean trusting corrupted state).
  const passed = harness.assertOutcome({
    expectTerminalStatus: expectedTerminal,
    expectVerificationStatuses: [expectedTerminal === "COMPLETED" ? "PASS" : "FAIL"],
    forbiddenTerminalStatuses: [expectedTerminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  return { evidence: harness.evidence(), passed };
}
