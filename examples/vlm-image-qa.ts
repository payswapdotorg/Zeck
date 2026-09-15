/**
 * WORKLOAD FAMILY: vlm — vision-language model image understanding
 * (the VAL-017 application shape, pinned task row vlm.describe.v1).
 *
 * One sentence: ask an open-ended question about an image and read the
 * structured description with its verification evidence.
 *
 * Classification: PROVIDER-GATED — VLM candidates are openrouter
 * (live-proven, credential env var NAME OPENROUTER_API_KEY) and openai
 * (region-blocked, 403). Completion requires an authorized VLM rail.
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, gatedBanner, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "vlm-image-qa",
  family: "vlm",
  title: "VLM — open-ended image question answering",
  classification: {
    kind: "provider-gated",
    gatedBy: "OPENROUTER_API_KEY",
    note:
      "VLM candidates: openrouter (live-proven) and openai " +
      "(region-blocked 403). Completion requires an authorized VLM rail.",
  },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "describe-image", image: "scene-001" },
    constraints: { maxCostMicroUsd: "8000", maxLatencyMs: 60_000 },
    metadata: { family: "vlm", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  console.log(gatedBanner(EXAMPLE));
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId, { timeoutMs: 120_000 });
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  console.log(`VLM image QA finished: ${status}`);
}

runWhenInvoked(import.meta.url, () => main());
