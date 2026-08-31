/**
 * Workload-class contracts (planning module domain; WORK-031, CSX-002).
 *
 * The task-side twin of the capabilities module's frozen workload-class
 * vocabulary: a `WorkloadClassProfile` maps a task's workload class to
 * the capability requirements + substrate requirements the planner
 * reasons over. Workload classes are EXECUTION-COMPATIBLE metadata:
 * they ride the EXISTING planning decision (additive capture), extend
 * the task profile's requirement derivation, and NEVER change the
 * core Execution abstraction (criterion 5 of the work order: a new
 * workload class is representable without core execution changes —
 * the vocabulary lives here, the mapping is data).
 */

import { PlatformError } from "../../../shared/errors";
import type { CapabilityRequirement, WorkloadClass } from "../../capabilities/public";
import { isWorkloadClass } from "../../capabilities/public";

/**
 * The frozen workload-class → requirement mapping. Adding a class or
 * changing a mapping row is a reviewed vocabulary change, never a
 * silent one (the task-kind table discipline).
 */
export const WORKLOAD_CLASS_REQUIREMENTS: Readonly<
  Record<WorkloadClass, readonly CapabilityRequirement[]>
> = {
  interactive: [{ id: "interactive-execution", kind: "runtime", minVersion: "1.0.0" }],
  realtime: [{ id: "realtime-execution", kind: "runtime", minVersion: "1.0.0" }],
  asynchronous: [{ id: "async-execution", kind: "runtime", minVersion: "1.0.0" }],
  batch: [{ id: "batch-execution", kind: "runtime", minVersion: "1.0.0" }],
  "training-evaluation": [{ id: "training-execution", kind: "runtime", minVersion: "1.0.0" }],
  edge: [{ id: "edge-execution", kind: "runtime", minVersion: "1.0.0" }],
  embodied: [{ id: "embodied-execution", kind: "runtime", minVersion: "1.0.0" }],
  "specialized-accelerator": [
    { id: "accelerator-execution", kind: "runtime", minVersion: "1.0.0" },
  ],
};

/** The workload-class profile captured on a planning decision (CSX-002). */
export interface WorkloadClassProfile {
  /** The task's declared workload class. */
  readonly workloadClass: WorkloadClass;
  /** The substrate requirements derived from the class + the task. */
  readonly requirements: readonly CapabilityRequirement[];
}

/** Fail-closed validation of a workload-class profile. */
export function validateWorkloadClassProfile(value: unknown): WorkloadClassProfile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformError({
      code: "NO_ELIGIBLE_ROUTE",
      message: "workload-class profile must be an object",
    });
  }
  const profile = value as WorkloadClassProfile;
  if (typeof profile.workloadClass !== "string" || !isWorkloadClass(profile.workloadClass)) {
    throw new PlatformError({
      code: "NO_ELIGIBLE_ROUTE",
      message: `workloadClass "${String(profile.workloadClass)}" is not in the frozen vocabulary`,
    });
  }
  if (!Array.isArray(profile.requirements) || profile.requirements.length === 0) {
    throw new PlatformError({
      code: "NO_ELIGIBLE_ROUTE",
      message: "workload-class profile must carry at least one requirement",
    });
  }
  for (const requirement of profile.requirements) {
    if (
      requirement === null ||
      typeof requirement !== "object" ||
      typeof requirement.id !== "string" ||
      requirement.id.length === 0
    ) {
      throw new PlatformError({
        code: "NO_ELIGIBLE_ROUTE",
        message: "each workload-class requirement must be a capability requirement",
      });
    }
  }
  return {
    workloadClass: profile.workloadClass,
    requirements: [...profile.requirements],
  };
}

/** Derive the workload-class profile for a task's declared class. */
export function workloadClassProfileOf(workloadClass: WorkloadClass): WorkloadClassProfile {
  return {
    workloadClass,
    requirements: [...(WORKLOAD_CLASS_REQUIREMENTS[workloadClass] ?? [])],
  };
}
