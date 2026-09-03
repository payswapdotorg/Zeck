/**
 * Accelerator fleet port (accelerators integration outbound; WORK-030).
 *
 * THE fleet seam the simulated adapter implements (and a real
 * accelerator-fleet adapter would implement behind the same neutral
 * contract): allocation with STABLE idempotency keys (exactly one paid
 * allocation per key — the budget-before-allocation boundary's physical
 * witness), capacity enforcement, release, and the keyed run ledger
 * (exactly one run observation per run key — the crash-convergence
 * mechanism the sandbox module's resume path relies on). The projected
 * observation rides the sandbox module's PUBLIC neutral contract.
 */

import type { EmittedCheckpoint } from "../../../modules/sandbox/public";
import type { FleetAllocationRecord, FleetAllocationRequest } from "../domain/accelerator";

/** The neutral spec one fleet run executes (projected by the runtime adapter). */
export interface FleetRunSpec {
  readonly runKey: string;
  readonly workloadId: string;
  readonly workloadKey: string;
  readonly attempt: number;
  readonly deviceClass: string;
  readonly devices: number;
  readonly checkpointIntervalSteps: number;
  readonly lineageRefs: Readonly<Record<string, readonly string[]>>;
  readonly resumeCheckpointRefs: readonly string[];
}

/** What one fleet run observed (the sandbox module's neutral shape). */
export interface FleetRunOutcome {
  readonly outcome: "workload-completed" | "workload-failed";
  readonly stepsCompleted: number;
  readonly checkpoints: readonly EmittedCheckpoint[];
  readonly output: {
    readonly contentDigest: string;
    readonly descriptor: Readonly<Record<string, unknown>>;
  } | null;
  readonly usageMicroUsd: string;
  readonly failure: {
    readonly failureClass: "workload-failure" | "timeout" | "substrate-error";
    readonly message: string;
    readonly retryable: boolean;
  } | null;
}

export interface AcceleratorFleet {
  /** The fabric identity (the substrate it serves). */
  readonly fabricId: string;
  /** Allocate devices (idempotent per allocation key; fails closed on capacity). */
  allocate(request: FleetAllocationRequest): Promise<FleetAllocationRecord>;
  /** Release an allocation (idempotent per allocation key). */
  release(allocationKey: string): Promise<{ released: boolean }>;
  /** Inspect one allocation (the idempotency ledger read). */
  findAllocation(allocationKey: string): Promise<FleetAllocationRecord | null>;
  /** The allocation journal (the paid-side-effect witness). */
  listAllocations(): readonly FleetAllocationRecord[];
  /** The active allocation count (capacity witness). */
  activeAllocations(): number;
  /** Execute one run (idempotent per run key — the convergence ledger). */
  executeRun(spec: FleetRunSpec): FleetRunOutcome;
}
