/**
 * The realtime voice-loop customer application (VAL-014).
 *
 * A real customer-style application: bounded voice-loop sessions whose
 * executions span turns, interruptions and resumes, submitted through
 * Zeck's public SDK boundary. The platform drives the BOUNDED typed
 * turn protocol (per-turn ASR + TTS legs over the REAL rails, durable
 * turn checkpoints with digests, wait-user/resume cycles, exactly-once
 * turn accounting, corruption detection) and records the mechanically
 * verified outcome; this application asserts the deterministic outcome
 * contract per session.
 *
 * REALTIME-RAIL BOUNDARY (honest): a true streaming realtime voice rail
 * (a WebSocket voice session API) is NOT authorized in this validation
 * environment — the realtime surface is proven through the platform's
 * session/resumability semantics over the REAL execution lifecycle
 * with REAL per-turn voice dispatches, and the missing access
 * requirement is surfaced exactly (see the platform module's
 * REALTIME_VOICE_RAIL_REQUIREMENT and the evidence document).
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import { expectedTerminalForSession, REALTIME_VOICE_TASKS } from "./dialogs";

const IDEMPOTENCY_PREFIX = "val-014-realtime-voice";

/** Per-task expected terminal (the corpus rows' own expectations). */
export function expectedTerminalForRealtimeRow(taskIndex: number): "COMPLETED" | "FAILED" {
  const task = REALTIME_VOICE_TASKS[taskIndex];
  return task === undefined ? "COMPLETED" : expectedTerminalForSession(task.session);
}

/**
 * Run the realtime voice-loop application end to end over one pinned
 * session task. The transport implementation is injected (the SDK's seam).
 */
export async function runRealtimeVoiceApp(options: {
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
      workOrder: "VAL-014",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  const task = REALTIME_VOICE_TASKS[options.taskIndex];
  if (task === undefined) {
    throw new Error("the pinned realtime-voice task slice is empty");
  }
  const expectedTerminal = expectedTerminalForRealtimeRow(options.taskIndex);
  const submitted = await harness.submit(
    {
      applicationId: options.config.applicationId,
      task: { ...task },
    },
    `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}`,
  );

  await harness.awaitCompletion(submitted.executionId);
  await harness.retrieveResult(submitted.executionId);

  // The deterministic outcome contract per corpus row: healthy sessions
  // COMPLETED+PASS; the corrupted-checkpoint edge FAILS honestly (a
  // COMPLETED there would mean trusting corrupted session state).
  const passed = harness.assertOutcome({
    expectTerminalStatus: expectedTerminal,
    expectVerificationStatuses: [expectedTerminal === "COMPLETED" ? "PASS" : "FAIL"],
    forbiddenTerminalStatuses: [expectedTerminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  return { evidence: harness.evidence(), passed };
}
