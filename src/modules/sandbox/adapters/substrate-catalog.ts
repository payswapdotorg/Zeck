/**
 * Accelerator substrate-catalog adapter (sandbox module; WORK-030,
 * ACC-002).
 *
 * Implements the sandbox module's `AcceleratorSubstrateCatalog` port
 * against the REAL capabilities module's PUBLIC substrate registry (the
 * ONE claim authority — WORK-031's substrate-federation discipline:
 * there is NO second catalog in the sandbox module). Selection is a
 * pure, provider-neutral capability/resource CONTRACT match:
 *
 *   1. the substrate must be AVAILABLE and serve the workload's mapped
 *      workload class (training/fine-tuning/evaluation ->
 *      `training-evaluation`, batch-inference -> `batch`);
 *   2. the substrate's execution-capability claim must match the
 *      requested accelerator class through the NEUTRAL convention
 *      `accelerator-<class>` (e.g. `accelerator-gpu`) — the claim IS
 *      the accelerator declaration, published into the existing
 *      capability registry by the substrate operator (the
 *      substrate-federation path);
 *   3. the substrate's per-unit resource profile must COVER the
 *      workload's per-replica estimate (0 = an unbounded claim);
 *   4. the earliest match wins deterministically (ordered by substrate
 *      id, then version descending) — there is no vendor preference,
 *      no region preference, no price preference here: those are
 *      substrate-operator concerns behind the adapterRef.
 *
 * The selection carries NO authorization (a claim is metadata); policy,
 * budget and capability admission happen in THEIR authorities at
 * submission time. Type + runtime coupling is to the capabilities
 * PUBLIC barrel only.
 */

import type { SubstrateRegistry } from "../../capabilities/public";
import type { TrainingWorkloadKind } from "../domain/workload";
import type {
  AcceleratorSubstrateCatalog,
  SubstrateSelection,
} from "../ports/accelerator-substrate";

/** The neutral execution-capability identity of one accelerator class. */
export function acceleratorCapabilityIdFor(acceleratorClass: string): string {
  return `accelerator-${acceleratorClass}`;
}

/** The workload-class mapping (the capabilities module's frozen vocabulary). */
const WORKLOAD_CLASS_BY_KIND: Readonly<Record<TrainingWorkloadKind, string>> = {
  training: "training-evaluation",
  "fine-tuning": "training-evaluation",
  "batch-inference": "batch",
  evaluation: "training-evaluation",
};

export function createSubstrateCatalogAdapter(
  registry: SubstrateRegistry,
): AcceleratorSubstrateCatalog {
  return {
    async select(applicationId, workloadKind, request): Promise<SubstrateSelection | null> {
      const workloadClass = WORKLOAD_CLASS_BY_KIND[workloadKind];
      const candidates = await registry.listAvailableByWorkloadClass(applicationId, workloadClass);
      const capabilityId = acceleratorCapabilityIdFor(request.acceleratorClass);
      // Deterministic order: substrate id ascending, version descending.
      const ordered = [...candidates].sort((a, b) => {
        if (a.substrateId !== b.substrateId) {
          return a.substrateId < b.substrateId ? -1 : 1;
        }
        return a.version > b.version ? -1 : a.version < b.version ? 1 : 0;
      });
      for (const record of ordered) {
        if (record.executionCapability.id !== capabilityId) {
          continue;
        }
        if (
          record.resource.cpuMilliCores !== 0 &&
          record.resource.cpuMilliCores < request.deviceCount * 1000
        ) {
          continue;
        }
        if (
          record.resource.memoryMiB !== 0 &&
          record.resource.memoryMiB < request.perDeviceMemoryMiB
        ) {
          continue;
        }
        return {
          substrateId: record.substrateId,
          version: record.version,
          adapterRef: record.adapterRef,
          digest: record.digest,
          executionCapabilityId: record.executionCapability.id,
          resource: {
            cpuMilliCores: record.resource.cpuMilliCores,
            memoryMiB: record.resource.memoryMiB,
            estimatedDurationMs: record.resource.estimatedDurationMs,
            estimatedCostMicroUsd: record.resource.estimatedCostMicroUsd,
          },
          isolation: record.isolation,
        };
      }
      return null;
    },
  };
}
