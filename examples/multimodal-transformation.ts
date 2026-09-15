/**
 * WORKLOAD FAMILY: multimodal — cross-modal chained transformation
 * (the VAL-018 application shape, pinned task row multimodal.summary.v1).
 *
 * One sentence: submit a task that consumes BOTH a document and an audio
 * stream into one summary, and read the per-stage provenance (each
 * stage's latency, usage and digest) from the completed result.
 *
 * Classification: PROVIDER-GATED — chained multimodal rows were
 * live-proven (vision stage over OPENROUTER_API_KEY, derived raster
 * over QWEN_API_KEY); one chained row honestly FAILED (corrupted
 * source → chain-abort with zero generation-rail calls). Completion
 * requires deployments with both authorized rails.
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, gatedBanner, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "multimodal-transformation",
  family: "multimodal",
  title: "Multimodal — document + audio chained summary",
  classification: {
    kind: "provider-gated",
    gatedBy: "OPENROUTER_API_KEY",
    note:
      "chained rows live-proven (vision over OPENROUTER_API_KEY, derived " +
      "raster over QWEN_API_KEY); one honest FAILED row (corrupted source, " +
      "chain-abort). Completion requires both authorized rails.",
  },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "multimodal-summary", doc: "mm-doc-001", audio: "mm-audio-001" },
    constraints: { maxCostMicroUsd: "20000", maxLatencyMs: 180_000 },
    metadata: { family: "multimodal", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  console.log(gatedBanner(EXAMPLE));
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId, { timeoutMs: 180_000 });
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  console.log(`multimodal transformation finished: ${status}`);
}

runWhenInvoked(import.meta.url, () => main());
