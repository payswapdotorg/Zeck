/**
 * WORKLOAD FAMILY: tools — tool-augmented goal execution
 * (the VAL-012 application shape, pinned task row tools.use-tool.v1).
 *
 * One sentence: submit a goal plus the neutral tool names it may use and
 * read back the executed plan's route summary and tool events.
 *
 * Classification: runnable (the tool-augmented family is live-proven by
 * the validation program over an openrouter rail).
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "tool-augmented-lookup",
  family: "tools",
  title: "Tools — goal execution with named neutral tools",
  classification: { kind: "runnable" },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "use-tool", goal: "compute 17 * 23", tools: ["calculator"] },
    constraints: { maxCostMicroUsd: "5000", maxLatencyMs: 30_000 },
    metadata: { family: "tools", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId);
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  // Tool invocations surface as step events in the public ledger.
  const events = await client.listEvents(receipt.executionId);
  const toolEvents = events.filter((event) => event.type.includes("tool"));
  console.log(`tool-augmented run finished: ${status} (${toolEvents.length} tool event(s))`);
}

runWhenInvoked(import.meta.url, () => main());
