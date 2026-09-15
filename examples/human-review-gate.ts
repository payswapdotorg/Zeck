/**
 * WORKLOAD FAMILY: hitl — human-in-the-loop approval gates
 * (the pinned corpus task row hitl.approval-gate.v1).
 *
 * One sentence: submit a gated action and observe that the execution
 * waits for the recorded human decision — the action lands ONLY after
 * approval, never before, and a rejection means no action at all.
 *
 * Classification: runnable (gate discipline is deterministic — the
 * ordering of the approval event vs the action event is the oracle).
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "human-review-gate",
  family: "hitl",
  title: "Human review — approval-gated action execution",
  classification: { kind: "runnable" },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    // The scripted decision rides the pinned gate fixture (approve).
    task: { kind: "hitl-gate", gate: "gate-001", decision: "approve" },
    constraints: { maxCostMicroUsd: "5000", maxLatencyMs: 60_000 },
    metadata: { family: "hitl", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  // WAITING_HUMAN is a legal lifecycle status — the poll simply waits
  // for the recorded decision to land and the gate to release.
  const status = await awaitTerminalStatus(client, receipt.executionId, { timeoutMs: 120_000 });
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  const events = await client.listEvents(receipt.executionId);
  const approval = events.find((event) => event.type.includes("approval"));
  const action = events.find((event) => event.type.includes("action"));
  console.log(
    `human review finished: ${status} ` +
      `(approval event: ${approval === undefined ? "not observed" : approval.type}; ` +
      `action event: ${action === undefined ? "not observed" : action.type})`,
  );
  if (approval !== undefined && action !== undefined) {
    const ordered = approval.sequence < action.sequence;
    console.log(
      `gate discipline: approval precedes action = ${ordered} ` +
        "(the human-confirmation constraint — an agent can never approve on the human's behalf)",
    );
  }
}

runWhenInvoked(import.meta.url, () => main());
