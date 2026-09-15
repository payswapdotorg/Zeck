/**
 * WORKLOAD FAMILY: voice — audio transcription / synthesis round trips
 * (the VAL-014 application shape, pinned task row voice.transcribe.v1).
 *
 * One sentence: submit a transcription task for a pinned audio clip and
 * read the transcript-verification result from the completed execution.
 *
 * Classification: PROVIDER-GATED — the ASR/TTS legs are live-proven
 * over the qwen dashscope-international rail (qwen3-asr-flash /
 * qwen3-tts-flash, credential env var NAME QWEN_API_KEY) by the
 * validation program; the openai ASR candidate is region-blocked
 * (HTTP 403) from the recorded egress. Completing this workload
 * requires a deployment with an authorized ASR-capable rail.
 * See docs/developer/AVAILABILITY.md and docs/VALIDATION-REPORT.md.
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, gatedBanner, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "voice-transcription",
  family: "voice",
  title: "Voice — audio transcription round trip",
  classification: {
    kind: "provider-gated",
    gatedBy: "QWEN_API_KEY",
    note:
      "ASR/TTS live-proven over the qwen dashscope-international rail; " +
      "the openai ASR candidate is region-blocked (403). Completion " +
      "requires a deployment with an authorized ASR-capable rail.",
  },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "transcribe", clip: "utterance-001" },
    constraints: { maxCostMicroUsd: "10000", maxLatencyMs: 60_000 },
    metadata: { family: "voice", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  console.log(gatedBanner(EXAMPLE));
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId, { timeoutMs: 120_000 });
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  console.log(`voice transcription finished: ${status}`);
}

runWhenInvoked(import.meta.url, () => main());
