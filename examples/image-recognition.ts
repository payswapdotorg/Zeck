/**
 * WORKLOAD FAMILY: image-recognition — image classification / OCR
 * (the pinned corpus task row image-recognition.classify.v1).
 *
 * One sentence: submit an image with a closed label set and read the
 * classification verdict from the completed execution's result.
 *
 * Classification: PROVIDER-GATED — vision-capable candidates are
 * openrouter (live-proven, credential env var NAME OPENROUTER_API_KEY)
 * and openai (region-blocked, 403). Completing this workload requires
 * a deployment with an authorized vision rail.
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, gatedBanner, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "image-recognition",
  family: "image-recognition",
  title: "Vision — image classification over a closed label set",
  classification: {
    kind: "provider-gated",
    gatedBy: "OPENROUTER_API_KEY",
    note:
      "vision-capable candidates: openrouter (live-proven) and openai " +
      "(region-blocked 403). Completion requires an authorized vision rail.",
  },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "classify-image", image: "img-c-001", labels: ["bicycle", "bus", "car"] },
    constraints: { maxCostMicroUsd: "8000", maxLatencyMs: 60_000 },
    metadata: { family: "image-recognition", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  console.log(gatedBanner(EXAMPLE));
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId, { timeoutMs: 120_000 });
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  console.log(`image classification finished: ${status}`);
}

runWhenInvoked(import.meta.url, () => main());
