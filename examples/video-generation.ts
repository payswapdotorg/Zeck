/**
 * WORKLOAD FAMILY: video-media — asynchronous video synthesis
 * (the VAL-016 application shape, pinned task row video-media.generate.v1).
 *
 * One sentence: submit a short-clip generation request, poll the async
 * lifecycle patiently (generation is slow — minutes, not seconds), and
 * retrieve the mp4 artifact reference with digest and duration facts.
 *
 * Classification: PROVIDER-GATED — three live generations were proven
 * over the qwen rail (wan2.2-t2v-plus, credential env var NAME
 * QWEN_API_KEY) at ~88 s per clip; further live rows are a recorded
 * NOT RUN boundary (free-tier quota exhausted —
 * AllocationQuota.FreeTierOnly, an operator tier action). The
 * byteplus-ark/seedance candidates did not resolve (DNS failure).
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, gatedBanner, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "video-generation",
  family: "video-media",
  title: "Video — asynchronous short-clip generation",
  classification: {
    kind: "provider-gated",
    gatedBy: "QWEN_API_KEY",
    note:
      "three live generations proven (wan2.2-t2v-plus, ~88 s each); " +
      "further live rows NOT RUN — free-tier quota exhausted " +
      "(AllocationQuota.FreeTierOnly, operator tier action pending); " +
      "ark/seedance candidates DNS-failed. See docs/VALIDATION-REPORT.md.",
  },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "generate-video", prompt: "vid-prompt-001", seconds: 5 },
    constraints: { maxCostMicroUsd: "500000", maxLatencyMs: 900_000 },
    metadata: { family: "video-media", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  console.log(gatedBanner(EXAMPLE));
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  // Generation measured ~88 s wall per clip when live-proven: patient
  // polling with a long deadline is the honest integration pattern.
  const status = await awaitTerminalStatus(client, receipt.executionId, {
    timeoutMs: 900_000,
    intervalMs: 5_000,
  });
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  console.log(`video generation finished: ${status}`);
}

runWhenInvoked(import.meta.url, () => main());
