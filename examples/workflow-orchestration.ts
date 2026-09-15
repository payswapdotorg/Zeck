/**
 * WORKLOAD FAMILY: workflow — governed multi-step orchestration
 * (the VAL-013 application shape, pinned task row workflow.invoice-approval.v1).
 *
 * One sentence: run a named workflow (an invoice approval chain) as ONE
 * execution and observe the step-wise event ledger of the orchestration.
 *
 * Classification: runnable (workflow orchestration is proven over the
 * durable transport in the validation program).
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "workflow-orchestration",
  family: "workflow",
  title: "Workflow — governed multi-step orchestration (invoice approval)",
  classification: { kind: "runnable" },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "run-workflow", workflow: "invoice-approval", invoice: "invoice-011" },
    constraints: { maxCostMicroUsd: "8000", maxLatencyMs: 60_000 },
    metadata: { family: "workflow", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId, { timeoutMs: 180_000 });
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  const events = await client.listEvents(receipt.executionId);
  console.log(`workflow finished: ${status} (${events.length} ledger event(s))`);
  for (const event of events) {
    console.log(`  #${event.sequence} ${event.type}`);
  }
}

runWhenInvoked(import.meta.url, () => main());
