/**
 * The voice input/output customer application (VAL-014).
 *
 * A real customer-style application covering BOTH voice directions:
 *   * speech-to-text — `transcribe-utterance` rows over deterministic
 *     synthetic clips (utterances, briefings) plus the REAL roundtrip
 *     row (`transcribe-roundtrip`: the REAL TTS rail synthesizes the
 *     pinned phrase into REAL speech, the REAL ASR rail transcribes it,
 *     and the transcript is verified against the phrase fixture's own
 *     ground-truth terms);
 *   * text-to-speech — `synthesize-speech` rows over pinned phrases
 *     (REAL TTS dispatch; mechanical payload verification).
 *
 * Integrates with Zeck exactly as a customer would — through the public
 * SDK boundary (the validation harness), with a repository-reproducible,
 * secret-free configuration and one environment secret. It never imports
 * Zeck internals and never selects a provider/model (API-001: routing is
 * the platform's authority).
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";

/** The app's pinned corpus slice (voice-io.* rows). */
export const VOICE_IO_TASKS = [
  // speech-to-text over synthetic fixtures (utterance + briefing shapes)
  { kind: "transcribe-utterance", clip: "utt-001" },
  { kind: "transcribe-utterance", clip: "brf-001" },
  // the REAL roundtrip row: REAL TTS speech → REAL ASR transcript,
  // verified against the phrase fixture's ground-truth terms
  { kind: "transcribe-roundtrip", phrase: "phrase-001", voice: "Cherry" },
  // the corrupted-clip edge row: the platform's honest expectation is
  // FAILED (the provider rejects genuinely undecodable audio) — never a
  // fabricated transcript, never a silent pass.
  { kind: "transcribe-utterance", clip: "audio-corrupt" },
  // text-to-speech over pinned phrases (mechanically verified payloads)
  { kind: "synthesize-speech", phrase: "phrase-002", voice: "Cherry" },
  { kind: "synthesize-speech", phrase: "phrase-003", voice: "Cherry" },
  // the malformed-input edge row: empty text is rejected BEFORE any
  // dispatch (the platform's own pre-dispatch discrimination).
  { kind: "synthesize-speech", phrase: "phrase-blank", voice: "Cherry" },
] as const;

/** Per-task outcome contracts (the corpus rows' own expectations). */
const TASK_EXPECTATIONS: readonly {
  readonly expectTerminalStatus: "COMPLETED" | "FAILED";
  readonly expectVerificationStatuses: readonly string[];
  readonly forbiddenTerminalStatuses: readonly string[];
}[] = [
  {
    expectTerminalStatus: "COMPLETED",
    expectVerificationStatuses: ["PASS"],
    forbiddenTerminalStatuses: ["FAILED", "CANCELLED", "EXPIRED"],
  },
  {
    expectTerminalStatus: "COMPLETED",
    expectVerificationStatuses: ["PASS"],
    forbiddenTerminalStatuses: ["FAILED", "CANCELLED", "EXPIRED"],
  },
  {
    expectTerminalStatus: "COMPLETED",
    expectVerificationStatuses: ["PASS"],
    forbiddenTerminalStatuses: ["FAILED", "CANCELLED", "EXPIRED"],
  },
  {
    expectTerminalStatus: "FAILED",
    expectVerificationStatuses: ["FAIL"],
    forbiddenTerminalStatuses: ["COMPLETED"],
  },
  {
    expectTerminalStatus: "COMPLETED",
    expectVerificationStatuses: ["PASS"],
    forbiddenTerminalStatuses: ["FAILED", "CANCELLED", "EXPIRED"],
  },
  {
    expectTerminalStatus: "COMPLETED",
    expectVerificationStatuses: ["PASS"],
    forbiddenTerminalStatuses: ["FAILED", "CANCELLED", "EXPIRED"],
  },
  {
    expectTerminalStatus: "FAILED",
    expectVerificationStatuses: ["FAIL"],
    forbiddenTerminalStatuses: ["COMPLETED"],
  },
];

const IDEMPOTENCY_PREFIX = "val-014-voice-io";

/** Per-row expected terminal (the corpus rows' own expectations). */
export function expectedTerminalForVoiceIoRow(taskIndex: number): "COMPLETED" | "FAILED" {
  const expectation = TASK_EXPECTATIONS[taskIndex];
  return (expectation?.expectTerminalStatus ?? "COMPLETED") as "COMPLETED" | "FAILED";
}

/**
 * Run the voice-io application end to end over one pinned task. The
 * transport implementation is injected (the SDK's seam).
 */
export async function runVoiceIoApp(options: {
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

  const task = VOICE_IO_TASKS[options.taskIndex] ?? VOICE_IO_TASKS[0];
  if (task === undefined) {
    throw new Error("the pinned voice-io task slice is empty");
  }
  const submitted = await harness.submit(
    {
      applicationId: options.config.applicationId,
      task: { ...task },
    },
    `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}`,
  );

  await harness.awaitCompletion(submitted.executionId);
  await harness.retrieveResult(submitted.executionId);

  // The deterministic outcome contract per corpus row: healthy rows
  // COMPLETED+PASS; the corrupted-clip and empty-text edge rows FAIL
  // honestly (a COMPLETED there would mean a fabricated transcript or a
  // dispatch that should never have happened).
  const expectations = TASK_EXPECTATIONS[options.taskIndex] ?? TASK_EXPECTATIONS[0];
  if (expectations === undefined) {
    throw new Error("the pinned voice-io expectation slice is empty");
  }
  const passed = harness.assertOutcome({
    expectTerminalStatus: expectations.expectTerminalStatus,
    expectVerificationStatuses: [...expectations.expectVerificationStatuses],
    forbiddenTerminalStatuses: [...expectations.forbiddenTerminalStatuses],
    forbidRetryableErrors: true,
  });

  return { evidence: harness.evidence(), passed };
}
