/**
 * WORKLOAD FAMILY: computer-use — agentic desktop/workspace task execution
 * (the VAL-019 application shape, pinned task row computer-use.task.v1).
 *
 * One sentence: submit a goal-directed file/workspace task and read the
 * final tree-diff evidence from the completed execution.
 *
 * Classification: PROVIDER-GATED for LIVE desktop rails — the executed
 * validation rows ran against the in-memory workspace fixture
 * (live-proven: extension sort with exact final tree; one designed
 * FAILED row proving the /etc/passwd data-boundary refusal with the
 * tree unchanged). A LIVE desktop computer-use rail is a recorded NOT
 * RUN boundary (no operator-authorized rail at run time).
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, gatedBanner, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "computer-use-agent",
  family: "computer-use",
  title: "Computer use — workspace file task (fixture-proven; live rail NOT RUN)",
  classification: {
    kind: "provider-gated",
    note:
      "fixture-proven (in-memory workspace; exact final-tree evidence, " +
      "data-boundary refusal); LIVE desktop rail NOT RUN — no " +
      "operator-authorized computer-use rail. See docs/VALIDATION-REPORT.md.",
  },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "computer-task", workspace: "ws-002", goal: "remove exact duplicates" },
    constraints: { maxCostMicroUsd: "30000", maxLatencyMs: 300_000 },
    metadata: { family: "computer-use", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  console.log(gatedBanner(EXAMPLE));
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId, { timeoutMs: 300_000 });
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  console.log(`computer task finished: ${status}`);
}

runWhenInvoked(import.meta.url, () => main());
