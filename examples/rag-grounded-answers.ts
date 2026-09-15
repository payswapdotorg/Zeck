/**
 * WORKLOAD FAMILY: rag — retrieval-grounded answers over a knowledge base
 * (the VAL-011 application shape, pinned task row rag.kb-qa.v1).
 *
 * One sentence: ask a grounded question over a synthetic knowledge base
 * and inspect the completed result whose verification criterion binds
 * the answer to retrieved sources.
 *
 * Classification: runnable (document-retrieval is a seeded deterministic
 * tool capability; the family is proven in the validation program).
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "rag-grounded-answers",
  family: "rag",
  title: "RAG — knowledge-base grounded question answering",
  classification: { kind: "runnable" },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "kb-qa", kb: "kb-synthetic-products-v1", question: "Is it good?" },
    constraints: { maxCostMicroUsd: "5000", maxLatencyMs: 30_000 },
    metadata: { family: "rag", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId);
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  const verification = await client.listVerification(receipt.executionId);
  console.log(`rag answer finished: ${status} (${verification.length} verification result(s))`);
}

runWhenInvoked(import.meta.url, () => main());
