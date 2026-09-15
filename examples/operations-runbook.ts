/**
 * WORKLOAD FAMILY: operations — governed runbook execution
 * (the pinned corpus task row operations.run-runbook.v1).
 *
 * One sentence: submit a named runbook against a target and read the
 * executed steps with their side-effect accounting from the ledger.
 *
 * Classification: runnable (runbook steps are deterministic tool
 * invocations over pinned operational fixtures — no live production
 * target is reachable from a sandbox by construction).
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "operations-runbook",
  family: "operations",
  title: "Operations — governed runbook execution",
  classification: { kind: "runnable" },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "run-runbook", runbook: "rb-restart", target: "svc-a" },
    constraints: { maxCostMicroUsd: "5000", maxLatencyMs: 120_000 },
    metadata: { family: "operations", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId, { timeoutMs: 180_000 });
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  const events = await client.listEvents(receipt.executionId);
  console.log(`runbook finished: ${status} (${events.length} ledger event(s))`);
}

runWhenInvoked(import.meta.url, () => main());
