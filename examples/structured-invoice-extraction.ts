/**
 * WORKLOAD FAMILY: structured — typed extraction into an exact JSON shape
 * (the VAL-008 application shape, pinned task row structured.extract-invoice.v1).
 *
 * One sentence: extract typed invoice fields from synthetic invoice text
 * into a byte-exact JSON artifact and verify the output shape through
 * the verification axis.
 *
 * Classification: runnable (deterministic rows — the family is proven
 * with byte-exact comparison oracles in the validation program).
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "structured-invoice-extraction",
  family: "structured",
  title: "Structured — typed invoice extraction (exact JSON shape)",
  classification: { kind: "runnable" },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "extract", format: "invoice", doc: "invoice-001" },
    constraints: { maxCostMicroUsd: "3000", maxLatencyMs: 10_000 },
    metadata: { family: "structured", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId);
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  // The expected output shape for the pinned row (see the corpus):
  // fields invoiceId, totalCents, currency in the output artifact.
  console.log(`structured extraction finished: ${status}`);
}

runWhenInvoked(import.meta.url, () => main());
