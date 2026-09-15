/**
 * WORKLOAD FAMILY: realtime-voice — streamed turn-taking voice sessions
 * (the VAL-014 application shape, pinned task row realtime-voice.rt-dialog.v1).
 *
 * One sentence: submit a streamed dialog turn and observe the turn
 * accounting and journaled session state through the execution ledger.
 *
 * Classification: PROVIDER-GATED (a recorded NOT RUN boundary) — no
 * authorized WebSocket voice-session API exists in the authorized
 * provider set; the recorded QWEN_API_KEY covers the ASR/TTS legs
 * only. The streaming realtime rail is a declared availability gap,
 * honestly recorded in docs/VALIDATION-REPORT.md — never a silent pass.
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, gatedBanner, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "realtime-voice-session",
  family: "realtime-voice",
  title: "Realtime voice — streamed dialog turn (NOT RUN rail boundary)",
  classification: {
    kind: "provider-gated",
    note:
      "streaming realtime rail NOT RUN — no authorized WebSocket " +
      "voice-session API in the provider set (QWEN_API_KEY covers " +
      "ASR/TTS legs only); see docs/VALIDATION-REPORT.md.",
  },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "rt-dialog", session: "rt-001", turn: 1 },
    constraints: { maxCostMicroUsd: "15000", maxLatencyMs: 60_000 },
    metadata: { family: "realtime-voice", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  console.log(gatedBanner(EXAMPLE));
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId, { timeoutMs: 120_000 });
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  console.log(`realtime dialog turn finished: ${status}`);
}

runWhenInvoked(import.meta.url, () => main());
