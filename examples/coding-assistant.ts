/**
 * WORKLOAD FAMILY: coding — implementation of a pinned function spec
 * (the VAL-019 application shape, pinned task row coding.implement.v1).
 *
 * One sentence: submit a function specification for implementation and
 * read the output artifact (the implementation) with its digest.
 *
 * Classification: runnable (the coding family is exercised by the
 * validation program; generation follows the live-proven text rail).
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "coding-assistant",
  family: "coding",
  title: "Coding — pinned function-spec implementation",
  classification: { kind: "runnable" },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "implement", spec: "fn-fizzmod" },
    constraints: { maxCostMicroUsd: "10000", maxLatencyMs: 120_000 },
    metadata: { family: "coding", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId, { timeoutMs: 180_000 });
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  console.log(`implementation finished: ${status}`);
}

runWhenInvoked(import.meta.url, () => main());
