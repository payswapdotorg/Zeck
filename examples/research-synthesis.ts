/**
 * WORKLOAD FAMILY: research — multi-source synthesis with source binding
 * (the VAL-019 application shape, pinned task row research.topic.v1).
 *
 * One sentence: submit a research topic and read the synthesized answer
 * whose verification criteria bind claims to retrieved sources.
 *
 * Classification: runnable (retrieval is a seeded deterministic tool
 * capability; synthesis follows the text family's live-proven rail).
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "research-synthesis",
  family: "research",
  title: "Research — multi-source synthesis with source binding",
  classification: { kind: "runnable" },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "research", topic: "topic-agree-3" },
    constraints: { maxCostMicroUsd: "15000", maxLatencyMs: 120_000 },
    metadata: { family: "research", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId, { timeoutMs: 180_000 });
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  const verification = await client.listVerification(receipt.executionId);
  console.log(
    `research synthesis finished: ${status} (${verification.length} verification result(s))`,
  );
}

runWhenInvoked(import.meta.url, () => main());
