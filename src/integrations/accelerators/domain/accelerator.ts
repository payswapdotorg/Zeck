/**
 * Accelerator fabric domain (accelerators integration; WORK-030,
 * ACC-002).
 *
 * The provider-neutral ACCELERATOR FLEET vocabulary of the
 * accelerators integration: the device inventory of one accelerator
 * substrate (neutral device classes, per-device memory and compute
 * units — never vendor names, never product SKUs) and the durable
 * allocation ledger shapes (the idempotency keys that make paid
 * allocation exactly-once).
 *
 * The integration is the SUBSTRATE side of the sandbox module's
 * `AcceleratorSubstrateRuntime` seam: the governed side (admission
 * ordering, budget-before-allocation, checkpoint identity, lineage,
 * verification-before-release) lives in the sandbox module over its
 * REAL authorities; this integration owns ONLY the external-fabric
 * mechanics behind the neutral contract (the substrate-federation
 * discipline — claims ride the capabilities registry, the runtime is
 * replaceable, vendor specifics never cross).
 */

/** One neutral accelerator device of the fleet's inventory. */
export interface AcceleratorDeviceDescriptor {
  /** The neutral device class (the sandbox module's vocabulary). */
  readonly deviceClass: string;
  /** Per-device memory in MiB. */
  readonly memoryMiB: number;
  /** Neutral compute-unit rating (>= 1). */
  readonly computeUnits: number;
  /** Whether the device participates in the interconnect fabric. */
  readonly fabricAttached: boolean;
}

/** The neutral fleet descriptor (the substrate's inventory). */
export interface AcceleratorFabricDescriptor {
  /** The fabric identity (the substrate it serves). */
  readonly fabricId: string;
  readonly devices: readonly AcceleratorDeviceDescriptor[];
}

/** One durable allocation on the fabric (idempotent per key). */
export interface FleetAllocationRecord {
  readonly allocationId: string;
  readonly allocationKey: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deviceClass: string;
  readonly devices: number;
  readonly perDeviceMemoryMiB: number;
  readonly allocatedAt: string;
  readonly releasedAt: string | null;
}

/** The allocation request the runtime seam projects onto the fleet. */
export interface FleetAllocationRequest {
  readonly allocationKey: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deviceClass: string;
  readonly deviceCount: number;
  readonly perDeviceMemoryMiB: number;
  readonly interconnect: string;
}

/** One simulated run record (the keyed idempotency ledger). */
export interface FleetRunRecord {
  readonly runKey: string;
  readonly workloadId: string;
  readonly attempt: number;
  readonly stepsCompleted: number;
  readonly observation: Record<string, unknown>;
}
