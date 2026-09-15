/**
 * WORKLOAD FAMILY: long-running — resumable batch jobs
 * (the VAL-013 application shape, pinned task row long-running.batch.v1).
 *
 * One sentence: submit a batch job that checkpoints its way through many
 * items, poll patiently (long deadlines), and read the honest completion
 * state including crash-resume behavior.
 *
 * Classification: runnable (checkpoint/resume semantics are proven over
 * REAL PostgreSQL in the validation program's integration suites).
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "long-running-batch",
  family: "long-running",
  title: "Long-running — checkpointed batch job with patient polling",
  classification: { kind: "runnable" },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "long-run", job: "job-001" },
    constraints: { maxCostMicroUsd: "20000", maxLatencyMs: 600_000 },
    metadata: { family: "long-running", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  // Long-running families need a LONG poll deadline — the wire exposes
  // no push channel for execution state; webhooks are the push surface.
  const status = await awaitTerminalStatus(client, receipt.executionId, {
    timeoutMs: 600_000,
    intervalMs: 2_000,
  });
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  console.log(`long-running job finished: ${status}`);
}

runWhenInvoked(import.meta.url, () => main());
