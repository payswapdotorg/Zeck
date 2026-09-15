/**
 * WORKLOAD FAMILY: browser-use — agentic web-shop task execution
 * (the VAL-019 application shape, pinned task row browser-use.task.v1).
 *
 * One sentence: submit a goal-directed browsing task against a governed
 * site fixture and read the ordered interaction trail from the ledger.
 *
 * Classification: PROVIDER-GATED for LIVE web rails — the executed
 * validation rows ran against the in-memory shop page-graph fixture
 * (live-proven: plain and coupon checkout with exact total math; one
 * designed FAILED row proving secret-flow refusal with zero orders).
 * A LIVE web browser rail is a recorded NOT RUN boundary (no
 * operator-authorized browser rail at run time).
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, gatedBanner, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "browser-use-agent",
  family: "browser-use",
  title: "Browser use — goal-directed shopping task (fixture-proven; live rail NOT RUN)",
  classification: {
    kind: "provider-gated",
    note:
      "fixture-proven (in-memory shop page graph; exact-total checkouts, " +
      "secret-flow refusal); LIVE web browser rail NOT RUN — no " +
      "operator-authorized browser rail. See docs/VALIDATION-REPORT.md.",
  },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "browser-task", site: "shop-fixture", goal: "buy A1 and B2" },
    constraints: { maxCostMicroUsd: "30000", maxLatencyMs: 300_000 },
    metadata: { family: "browser-use", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  console.log(gatedBanner(EXAMPLE));
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId, { timeoutMs: 300_000 });
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  const events = await client.listEvents(receipt.executionId);
  console.log(`browser task finished: ${status} (${events.length} ledger event(s))`);
}

runWhenInvoked(import.meta.url, () => main());
