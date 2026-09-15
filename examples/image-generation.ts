/**
 * WORKLOAD FAMILY: image-generation — raster image synthesis
 * (the VAL-015 application shape, pinned task row image-generation.generate.v1).
 *
 * One sentence: submit a generation prompt with explicit raster
 * dimensions and retrieve the output artifact reference with its
 * content digest from the completed execution.
 *
 * Classification: PROVIDER-GATED — image generation is live-proven
 * over the qwen rail (qwen-image-2.0, credential env var NAME
 * QWEN_API_KEY); the openai candidate is region-blocked (403) from
 * the recorded egress. Completing this workload requires a deployment
 * with an authorized image-generation rail.
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, gatedBanner, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "image-generation",
  family: "image-generation",
  title: "Image — raster generation with explicit dimensions",
  classification: {
    kind: "provider-gated",
    gatedBy: "QWEN_API_KEY",
    note:
      "image generation live-proven over the qwen rail (qwen-image-2.0); " +
      "the openai candidate is region-blocked (403). Completion requires " +
      "an authorized image-generation rail.",
  },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "generate-image", prompt: "img-prompt-001", width: 512, height: 512 },
    constraints: { maxCostMicroUsd: "50000", maxLatencyMs: 120_000 },
    metadata: { family: "image-generation", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  console.log(gatedBanner(EXAMPLE));
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId, { timeoutMs: 180_000 });
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  console.log(`image generation finished: ${status}`);
}

runWhenInvoked(import.meta.url, () => main());
