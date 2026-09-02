/**
 * Accelerator substrate operator adapter (accelerators integration;
 * WORK-030, ACC-002 — the substrate-federation path).
 *
 * Implements the substrate-federation integration's PUBLIC
 * `SubstrateOperatorAdapter` port (an intra-integration import): the
 * accelerator fabric's NEUTRAL substrate declarations — the claims the
 * composition root federates into the capabilities module's PUBLIC
 * substrate registry (the ONE claim authority). The declaration rides
 * the existing `ComputationalSubstrateInput` contract: the
 * `specialized-accelerator` + workload classes, the neutral resource
 * profile, the isolation class and the execution-capability identity
 * (`accelerator-<class>` — the convention the sandbox module's
 * substrate-catalog adapter matches). No vendor vocabulary crosses.
 */

import type { ExternalSubstrateSubmission } from "../../substrate-federation/public";
import type { AcceleratorFleet } from "../ports/accelerator-fleet";

export interface AcceleratorOperatorOptions {
  /** The substrate declaration version (published per fabric revision). */
  readonly version?: string;
  /** Cost per unit, integer micro-USD string. */
  readonly estimatedCostMicroUsd?: string;
  /** A workload class to serve beyond the accelerator classes. */
  readonly workloadClasses?: readonly ("batch" | "training-evaluation")[];
}

export function createAcceleratorOperator(
  fleet: AcceleratorFleet,
  deviceClass: string,
  options: AcceleratorOperatorOptions = {},
): {
  readonly operatorId: string;
  listSubstrates(applicationId: string): Promise<readonly ExternalSubstrateSubmission[]>;
} {
  const substrateId = `accelerator-fabric-${fleet.fabricId}`;
  const declaration: ExternalSubstrateSubmission["substrate"] = {
    substrateId,
    version: options.version ?? "1.0.0",
    workloadClasses: [
      "specialized-accelerator",
      ...(options.workloadClasses ?? ["training-evaluation", "batch"]),
    ],
    modalities: ["text", "document"],
    latencyClass: "batch",
    resource: {
      cpuMilliCores: 0,
      memoryMiB: 0,
      estimatedDurationMs: 3_600_000,
      estimatedCostMicroUsd: options.estimatedCostMicroUsd ?? "1000",
    },
    isolation: "container",
    sideEffectClasses: ["none"],
    executionCapability: { id: `accelerator-${deviceClass}` },
    adapterRef: `accelerator-fabric:${fleet.fabricId}`,
    description: `the simulated accelerator fabric ${fleet.fabricId} (${deviceClass} devices)`,
  };
  return {
    operatorId: `accelerators:${fleet.fabricId}`,
    async listSubstrates(): Promise<readonly ExternalSubstrateSubmission[]> {
      return [{ substrate: declaration, operator: `accelerators:${fleet.fabricId}` }];
    },
  };
}
