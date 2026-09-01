/**
 * Substrate catalog port (planning module outbound; WORK-031, CSX-003).
 *
 * The seam through which the planner consults the provider-neutral
 * substrate catalog (implemented by an adapter wrapping the
 * capabilities module's PUBLIC substrate registry). READ-ONLY: the
 * planner never registers, mutates or executes substrates — claims
 * are metadata; selection is evidence; execution happens downstream
 * through the existing paths.
 */

import type { WorkloadClass } from "../../capabilities/public";

/** The neutral substrate fact the planner reasons over. */
export interface SubstrateCatalogEntry {
  readonly substrateId: string;
  readonly version: string;
  readonly adapterRef: string;
  readonly workloadClasses: readonly WorkloadClass[];
  readonly latencyClass: string;
  readonly isolation: string;
  readonly status: string;
  readonly resource: {
    readonly cpuMilliCores: number;
    readonly memoryMiB: number;
    readonly estimatedDurationMs: number;
    readonly estimatedCostMicroUsd: string;
  };
  readonly executionCapabilityId: string;
}

export interface SubstrateCatalog {
  /** The AVAILABLE substrates serving a workload class, in catalog order. */
  listAvailable(
    applicationId: string,
    workloadClass: WorkloadClass,
  ): Promise<readonly SubstrateCatalogEntry[]>;
}
