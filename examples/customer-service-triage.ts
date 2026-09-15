/**
 * WORKLOAD FAMILY: customer-service — triage and routing of support tickets
 * (the pinned corpus task row customer-service.triage.v1).
 *
 * One sentence: submit a support ticket for governed triage and read the
 * classified outcome with its verification evidence.
 *
 * Classification: runnable (the triage stage is deterministic over the
 * pinned ticket fixtures; downstream reply generation follows the text
 * family's availability).
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "customer-service-triage",
  family: "customer-service",
  title: "Customer service — governed ticket triage",
  classification: { kind: "runnable" },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "cs-ticket", ticket: "ticket-001" },
    constraints: { maxCostMicroUsd: "8000", maxLatencyMs: 60_000 },
    metadata: { family: "customer-service", example: EXAMPLE.name },
    // Attribute the end user the execution (and any spend) belongs to.
    userId: "end-user-001",
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId);
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  console.log(`ticket triage finished: ${status}`);
}

runWhenInvoked(import.meta.url, () => main());
