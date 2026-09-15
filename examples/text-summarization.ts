/**
 * WORKLOAD FAMILY: text — document summarization at a bounded length
 * (the VAL-010 application shape, pinned task row text.summarize-doc.v1).
 *
 * One sentence: submit a summarize task with a word budget and read the
 * completed result, route summary and settled cost back through the SDK.
 *
 * Classification: runnable (the text family is live-proven by the
 * validation program over an openrouter rail; the example itself only
 * speaks the provider-neutral wire).
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "text-summarization",
  family: "text",
  title: "Text — bounded-length document summarization",
  classification: { kind: "runnable" },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
    constraints: { maxCostMicroUsd: "5000", maxLatencyMs: 30_000 },
    metadata: { family: "text", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId);
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  console.log(`text summarization finished: ${status}`);
}

runWhenInvoked(import.meta.url, () => main());
