/**
 * Accelerator substrate runtime adapter (accelerators integration;
 * WORK-030, ACC-002).
 *
 * Implements the SANDBOX module's public `AcceleratorSubstrateRuntime`
 * port (the provider-neutral GPU/accelerator execution seam) over one
 * accelerator FLEET (the integration's neutral fabric port): the
 * allocation (idempotent per stable key — the paid boundary the
 * governed side enters ONLY after budget admission), the release, and
 * the run (the fleet's keyed idempotency ledger: exactly one run
 * observation per run key — the crash-convergence mechanism).
 *
 * The adapter carries NO authority surface: no stores, no admission
 * decisions, no execution vocabulary (the port's shape makes duplicate
 * authorities unrepresentable). Swapping this adapter for another
 * substrate implementation changes NOTHING in the sandbox module's
 * core Execution abstraction — the required provider/accelerator
 * substitution discrimination.
 */

import type {
  AcceleratorAllocation,
  AcceleratorRuntimeSpec,
  AcceleratorSubstrateRuntime,
  TrainingRunObservation,
} from "../../../modules/sandbox/public";
import type { AcceleratorFleet } from "../ports/accelerator-fleet";

export function createAcceleratorSubstrateRuntime(
  fleet: AcceleratorFleet,
): AcceleratorSubstrateRuntime {
  return {
    adapterRef: `accelerator-fabric:${fleet.fabricId}`,
    async allocate(request, allocationKey, context): Promise<AcceleratorAllocation> {
      const record = await fleet.allocate({
        allocationKey,
        applicationId: context.applicationId,
        tenantId: context.tenantId,
        deviceClass: request.acceleratorClass,
        deviceCount: request.deviceCount,
        perDeviceMemoryMiB: request.perDeviceMemoryMiB,
        interconnect: request.interconnect,
      });
      return {
        allocationId: record.allocationId,
        substrateId: fleet.fabricId,
        devices: record.devices,
        allocatedAt: record.allocatedAt,
      };
    },
    async release(allocationKey): Promise<{ released: boolean }> {
      return fleet.release(allocationKey);
    },
    async run(spec: AcceleratorRuntimeSpec, runKey: string): Promise<TrainingRunObservation> {
      const observation = fleet.executeRun({
        runKey,
        workloadId: spec.workloadId,
        workloadKey: spec.workloadKey,
        attempt: spec.attempt,
        deviceClass: spec.resource.accelerator.acceleratorClass,
        devices: spec.resource.accelerator.deviceCount,
        checkpointIntervalSteps: spec.checkpointIntervalSteps,
        lineageRefs: spec.lineageRefs,
        resumeCheckpointRefs: spec.resumeCheckpointRefs,
      });
      return {
        outcome: observation.outcome,
        stepsCompleted: observation.stepsCompleted,
        checkpoints: observation.checkpoints.map((checkpoint) => ({
          checkpointSequence: checkpoint.checkpointSequence,
          stepPosition: checkpoint.stepPosition,
          metricsDigest: checkpoint.metricsDigest,
          lineage: checkpoint.lineage,
        })),
        output: observation.output,
        usageMicroUsd: observation.usageMicroUsd,
        failure: observation.failure,
      };
    },
  };
}
