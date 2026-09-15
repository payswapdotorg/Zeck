/**
 * WORKLOAD FAMILY: three-d — 3D scene rendering / mesh synthesis
 * (the VAL-018 application shape, pinned task row three-d.render-scene.v1).
 *
 * One sentence: submit a scene render request and retrieve the rendered
 * artifact reference and digest.
 *
 * Classification: PROVIDER-GATED (a recorded NOT RUN boundary with NO
 * candidate provider) — the authorized provider set contains no
 * 3D-generation-capable provider (capability-matrix row model:three-d,
 * candidates []). The recorded minimum access requirement is one
 * 3D-capable provider credential read from ZECK_3D_API_KEY. All six
 * pinned 3D rows are a declared availability gap — never a silent pass.
 */

import type { ExecutionRequest } from "../sdk";
import { coreEnvVars, type ExampleMeta, gatedBanner, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "three-d-generation",
  family: "three-d",
  title: "3D — scene rendering (NO provider in the authorized set)",
  classification: {
    kind: "provider-gated",
    gatedBy: "ZECK_3D_API_KEY",
    note:
      "no 3D-generation-capable provider in the authorized set " +
      "(model:three-d candidates: []); minimum access: one 3D-capable " +
      "provider credential from ZECK_3D_API_KEY. All six pinned rows " +
      "NOT RUN — see docs/VALIDATION-REPORT.md.",
  },
  envVars: coreEnvVars(),
};

export function executionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "render-3d", scene: "scene3d-001" },
    constraints: { maxCostMicroUsd: "100000", maxLatencyMs: 600_000 },
    metadata: { family: "three-d", example: EXAMPLE.name },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);
  console.log(gatedBanner(EXAMPLE));
  const { receipt } = await client.createExecution(executionRequest(env), `${EXAMPLE.name}-1`);
  const status = await awaitTerminalStatus(client, receipt.executionId, { timeoutMs: 120_000 });
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  console.log(`3D render finished: ${status}`);
}

runWhenInvoked(import.meta.url, () => main());
