/**
 * WORKLOAD FAMILY: audio-understanding — audio event/classification input
 * (the pinned corpus task row audio-understanding.classify.v1).
 *
 * One sentence: submit an audio clip for event classification and read
 * the classified outcome with onset/duration facts.
 *
 * Classification: PROVIDER-GATED (a recorded NOT RUN boundary) — the
 * only authorized audio-input candidate (openai) is region-blocked
 * (HTTP 403 unsupported_country_region_territory) from the recorded
 * egress. This capability is a declared availability gap honestly
 * recorded in docs/VALIDATION-REPORT.md — never a silent pass.
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, gatedBanner, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "audio-understanding",
  family: "audio-understanding",
  title: "Audio — clip event classification (NOT RUN rail boundary)",
  classification: {
    kind: "provider-gated",
    gatedBy: "OPENAI_API_KEY",
    note:
      "audio-input candidates: openai only — region-blocked (HTTP 403 " +
      "unsupported_country_region_territory) from the recorded egress. " +
      "A declared availability gap; see docs/VALIDATION-REPORT.md.",
  },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "classify-audio", clip: "event-005", onset: true },
    constraints: { maxCostMicroUsd: "8000", maxLatencyMs: 60_000 },
    metadata: { family: "audio-understanding", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  console.log(gatedBanner(EXAMPLE));
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId, { timeoutMs: 120_000 });
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  console.log(`audio classification finished: ${status}`);
}

runWhenInvoked(import.meta.url, () => main());
