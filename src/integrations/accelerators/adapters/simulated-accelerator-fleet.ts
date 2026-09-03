/**
 * Simulated accelerator fleet (accelerators integration adapter;
 * WORK-030, ACC-002).
 *
 * The in-process SIMULATED accelerator fabric: a neutral device
 * inventory, an idempotent allocation ledger (exactly one allocation
 * per stable key — the physical witness the budget-before-allocation
 * discrimination inspects), capacity enforcement (fail-closed), and
 * the deterministic run ledger (exactly one observation per run key —
 * the crash-convergence mechanism). NO real accelerator-fabric
 * credentials exist in this environment: the external-substrate
 * behavior is UNVERIFIED and recorded as such in
 * docs/work-items/WORK-030.md (the standing provider-honesty stance —
 * the GOVERNED side is real, the substrate is simulated).
 *
 * Determinism: the simulated run derives its steps, checkpoints and
 * output digest deterministically from the run key + the spec's
 * lineage + the checkpoint interval, so retries replay the SAME
 * observation (keyed convergence) and the substitution discrimination
 * can compare two DIFFERENT fleets behind the same contract.
 */

import { createHash } from "node:crypto";
import { PlatformError } from "../../../shared/errors";
import type {
  AcceleratorDeviceDescriptor,
  FleetAllocationRecord,
  FleetAllocationRequest,
  FleetRunRecord,
} from "../domain/accelerator";
import type { AcceleratorFleet, FleetRunOutcome, FleetRunSpec } from "../ports/accelerator-fleet";

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export interface SimulatedAcceleratorFleetOptions {
  readonly now: () => Date;
  readonly generateId: () => string;
  /** Simulate runs that FAIL after emitting some checkpoints. */
  readonly failRunsOf?: (workloadId: string, attempt: number) => boolean;
  /** The number of steps the simulated run completes. */
  readonly totalSteps?: number;
}

/**
 * The simulated fleet: `totalSteps` steps with a checkpoint every
 * `checkpointIntervalSteps` (the run's declared interval), a final
 * output descriptor (content digest derived from the run key + lineage)
 * and a usage figure derived from devices × steps.
 */
export class SimulatedAcceleratorFleet implements AcceleratorFleet {
  readonly fabricId: string;
  private readonly allocations = new Map<string, FleetAllocationRecord>();
  private readonly runs = new Map<
    string,
    {
      runKey: string;
      workloadId: string;
      attempt: number;
      stepsCompleted: number;
      observation: FleetRunOutcome;
    }
  >();
  private readonly options: SimulatedAcceleratorFleetOptions;
  private readonly inventory: readonly AcceleratorDeviceDescriptor[];

  constructor(
    fabricId: string,
    inventory: readonly AcceleratorDeviceDescriptor[],
    options: SimulatedAcceleratorFleetOptions,
  ) {
    this.fabricId = fabricId;
    this.inventory = inventory;
    this.options = options;
  }

  /** The fleet's device inventory (the capacity facts). */
  inventoryOf(): readonly AcceleratorDeviceDescriptor[] {
    return this.inventory;
  }

  async allocate(request: FleetAllocationRequest): Promise<FleetAllocationRecord> {
    const existing = this.allocations.get(request.allocationKey);
    if (existing !== undefined) {
      return existing; // keyed convergence: exactly one allocation per key
    }
    const classInventory = this.inventory.filter(
      (device) => device.deviceClass === request.deviceClass,
    );
    if (classInventory.length === 0) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `the simulated fleet ${this.fabricId} has no ${request.deviceClass} devices`,
        details: { fabricId: this.fabricId, deviceClass: request.deviceClass },
      });
    }
    // Capacity is enforced PER CLASS: the active (unreleased) allocations
    // of this device class may never exceed the class inventory.
    const activeForClass = [...this.allocations.values()].filter(
      (allocation) =>
        allocation.deviceClass === request.deviceClass && allocation.releasedAt === null,
    ).length;
    const free = classInventory.length - activeForClass;
    if (request.deviceCount > free) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `the simulated fleet ${this.fabricId} cannot satisfy a ${request.deviceCount}-device request (inventory: ${classInventory.length}, active: ${activeForClass})`,
        details: {
          fabricId: this.fabricId,
          requested: request.deviceCount,
          inventory: classInventory.length,
          active: activeForClass,
        },
      });
    }
    const memory = classInventory[0]?.memoryMiB ?? 0;
    if (request.perDeviceMemoryMiB > memory) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `the simulated fleet ${this.fabricId} devices carry ${memory} MiB each; ${request.perDeviceMemoryMiB} MiB per device was requested`,
        details: {
          fabricId: this.fabricId,
          requested: request.perDeviceMemoryMiB,
          available: memory,
        },
      });
    }
    if (
      request.interconnect === "interconnect-fabric" &&
      !classInventory.some((device) => device.fabricAttached)
    ) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `the simulated fleet ${this.fabricId} has no interconnect fabric`,
        details: { fabricId: this.fabricId },
      });
    }
    const record: FleetAllocationRecord = {
      allocationId: this.options.generateId(),
      allocationKey: request.allocationKey,
      applicationId: request.applicationId,
      tenantId: request.tenantId,
      deviceClass: request.deviceClass,
      devices: request.deviceCount,
      perDeviceMemoryMiB: request.perDeviceMemoryMiB,
      allocatedAt: this.options.now().toISOString(),
      releasedAt: null,
    };
    this.allocations.set(request.allocationKey, record);
    return record;
  }

  async release(allocationKey: string): Promise<{ released: boolean }> {
    const existing = this.allocations.get(allocationKey);
    if (existing === undefined || existing.releasedAt !== null) {
      return { released: false }; // idempotent release
    }
    this.allocations.set(allocationKey, {
      ...existing,
      releasedAt: this.options.now().toISOString(),
    });
    return { released: true };
  }

  async findAllocation(allocationKey: string): Promise<FleetAllocationRecord | null> {
    return this.allocations.get(allocationKey) ?? null;
  }

  listAllocations(): readonly FleetAllocationRecord[] {
    return [...this.allocations.values()];
  }

  activeAllocations(): number {
    return (
      this.allocations.size -
      [...this.allocations.values()].filter((a) => a.releasedAt !== null).length
    );
  }

  /** The run ledger read (keyed convergence witness). */
  runOf(runKey: string): FleetRunRecord | null {
    const run = this.runs.get(runKey);
    return run === undefined
      ? null
      : {
          runKey: run.runKey,
          workloadId: run.workloadId,
          attempt: run.attempt,
          stepsCompleted: run.stepsCompleted,
          observation: { ...run.observation },
        };
  }

  /** The number of DISTINCT run invocations executed (the run witness). */
  runCount(): number {
    return this.runs.size;
  }

  /** Execute one run (idempotent per run key — the convergence ledger). */
  executeRun(spec: FleetRunSpec): FleetRunOutcome {
    const existing = this.runs.get(spec.runKey);
    if (existing !== undefined) {
      return existing.observation as FleetRunOutcome;
    }
    const totalSteps = this.options.totalSteps ?? 12;
    const shouldFail = this.options.failRunsOf?.(spec.workloadId, spec.attempt) === true;
    const resumeStep = spec.resumeCheckpointRefs.length > 0 ? 4 : 0;
    const checkpoints: {
      checkpointSequence: number;
      stepPosition: number;
      metricsDigest: string;
      lineage: Record<string, readonly string[]>;
    }[] = [];
    let sequence = 0;
    for (
      let step = spec.checkpointIntervalSteps;
      step <= totalSteps;
      step += spec.checkpointIntervalSteps
    ) {
      if (step <= resumeStep) {
        continue; // already durable: the resume point replays
      }
      sequence += 1;
      checkpoints.push({
        checkpointSequence: sequence,
        stepPosition: step,
        metricsDigest: sha256Hex(
          `simulated-accelerator:${this.fabricId}:${spec.workloadKey}:${spec.attempt}:${sequence}:${step}`,
        ),
        lineage: {
          datasetRefs: [...(spec.lineageRefs.datasetRefs ?? [])],
          codeRefs: [...(spec.lineageRefs.codeRefs ?? [])],
          configRefs: [...(spec.lineageRefs.configRefs ?? [])],
          checkpointRefs: [...(spec.resumeCheckpointRefs ?? [])],
          parentOutputRefs: [...(spec.lineageRefs.parentOutputRefs ?? [])],
        },
      });
    }
    const usageMicroUsd = String(spec.devices * 1000 + totalSteps * 100);
    if (shouldFail) {
      const observation: FleetRunOutcome = {
        outcome: "workload-failed",
        stepsCompleted: Math.min(totalSteps, spec.checkpointIntervalSteps),
        checkpoints: checkpoints.slice(0, 1),
        output: null,
        usageMicroUsd,
        failure: {
          failureClass: "workload-failure",
          message: `the simulated accelerator fleet ${this.fabricId} reported a failed training run for workload ${spec.workloadId}`,
          retryable: true,
        },
      };
      this.runs.set(spec.runKey, {
        runKey: spec.runKey,
        workloadId: spec.workloadId,
        attempt: spec.attempt,
        stepsCompleted: observation.stepsCompleted,
        observation,
      });
      return observation;
    }
    const contentDigest = sha256Hex(
      `simulated-accelerator:${this.fabricId}:${spec.runKey}:${JSON.stringify(
        Object.keys(spec.lineageRefs)
          .sort()
          .map((key) => [key, [...(spec.lineageRefs[key] ?? [])].sort()]),
      )}`,
    );
    const observation: FleetRunOutcome = {
      outcome: "workload-completed",
      stepsCompleted: totalSteps,
      checkpoints,
      output: {
        contentDigest,
        descriptor: {
          kind: "trained-output",
          fabricId: this.fabricId,
          deviceClass: spec.deviceClass,
          devices: spec.devices,
          steps: totalSteps,
          lineage: spec.lineageRefs,
        },
      },
      usageMicroUsd,
      failure: null,
    };
    this.runs.set(spec.runKey, {
      runKey: spec.runKey,
      workloadId: spec.workloadId,
      attempt: spec.attempt,
      stepsCompleted: totalSteps,
      observation,
    });
    return observation;
  }
}
