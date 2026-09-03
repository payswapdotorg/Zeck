/**
 * Accelerator substrate ports (sandbox module outbound; WORK-030,
 * ACC-002).
 *
 * THE provider-neutral GPU/accelerator selection + execution seam —
 * the substrate-federation discipline applied to the accelerator axis:
 *
 *   - SELECTION is a capability/resource CONTRACT match, never a
 *     vendor lookup: the catalog port resolves the workload's
 *     `AcceleratorResourceRequest` against substrate CLAIMS in the
 *     capabilities module's registry (the ONE claim authority — there
 *     is no second catalog here). A selection is the neutral substrate
 *     identity + version + opaque adapterRef + resource profile; the
 *     concrete fleet binding happens at the composition root through
 *     the runtime registry (adapterRef -> runtime adapter);
 *   - THE RUNTIME is the replaceable-adapter seam: one neutral
 *     contract per substrate (`allocate` / `release` / `run`), carrying
 *     ONLY neutral shapes — no stores, no authorities, no vendor
 *     vocabulary, no execution status (an adapter is structurally
 *     never handed an authority surface). Swapping the substrate
 *     adapter changes NOTHING in the core Execution abstraction (the
 *     required substitution discrimination);
 *   - ALLOCATION is the PAID boundary: `allocate` must only ever be
 *     called AFTER budget admission (the service enforces the order —
 *     the resource-before-paid-allocation invariant), with a STABLE
 *     allocation key so retries converge on exactly one allocation.
 */

import type { SandboxTask } from "../domain/sandbox";
import type {
  AcceleratorResourceRequest,
  TrainingResourceEstimate,
  TrainingWorkloadKind,
} from "../domain/workload";

// ---------------------------------------------------------------------------
// Selection (the capability/resource contract — ACC-002)
// ---------------------------------------------------------------------------

/** One provider-neutral substrate selection (the claim evidence). */
export interface SubstrateSelection {
  readonly substrateId: string;
  readonly version: string;
  /** OPAQUE reference to the replaceable adapter (never a vendor name). */
  readonly adapterRef: string;
  /** The substrate's content digest (the selected revision evidence). */
  readonly digest: string;
  /** The neutral execution-capability identity the substrate claims. */
  readonly executionCapabilityId: string;
  /** The substrate's declared resource profile (neutral units). */
  readonly resource: {
    readonly cpuMilliCores: number;
    readonly memoryMiB: number;
    readonly estimatedDurationMs: number;
    readonly estimatedCostMicroUsd: string;
  };
  readonly isolation: string;
}

export interface AcceleratorSubstrateCatalog {
  /**
   * Resolve the request against the available substrate claims
   * (provider-neutral matching). Returns null when NO available
   * substrate satisfies the request (fail-closed CAPABILITY_UNAVAILABLE
   * upstream); NEVER falls back to a default substrate.
   */
  select(
    applicationId: string,
    workloadKind: TrainingWorkloadKind,
    request: AcceleratorResourceRequest,
  ): Promise<SubstrateSelection | null>;
}

// ---------------------------------------------------------------------------
// The runtime seam (the replaceable adapter contract)
// ---------------------------------------------------------------------------

/** A durable accelerator allocation on the substrate. */
export interface AcceleratorAllocation {
  readonly allocationId: string;
  readonly substrateId: string;
  readonly devices: number;
  readonly allocatedAt: string;
}

/** The neutral runtime specification the substrate executes. */
export interface AcceleratorRuntimeSpec {
  readonly workloadId: string;
  readonly workloadKey: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly workloadKind: TrainingWorkloadKind;
  readonly task: SandboxTask;
  /** The IMMUTABLE admitted resource estimate snapshot. */
  readonly resource: TrainingResourceEstimate;
  readonly lineageRefs: Readonly<Record<string, readonly string[]>>;
  /** The resume point: checkpoint identity refs the run restarts from. */
  readonly resumeCheckpointRefs: readonly string[];
  readonly checkpointIntervalSteps: number;
  readonly attempt: number;
}

/** One checkpoint the substrate emits during a run. */
export interface EmittedCheckpoint {
  readonly checkpointSequence: number;
  readonly stepPosition: number;
  /** sha256 hex over the canonical metrics record at checkpoint time. */
  readonly metricsDigest: string;
  /** The checkpoint's own lineage refs (the restart contract). */
  readonly lineage: Readonly<Record<string, readonly string[]>>;
}

/** What one run observed (the accelerator axis only). */
export interface TrainingRunObservation {
  readonly outcome: "workload-completed" | "workload-failed";
  readonly stepsCompleted: number;
  /** The checkpoints emitted during this run (recorded write-once). */
  readonly checkpoints: readonly EmittedCheckpoint[];
  /** The final output descriptor (content digest + neutral facts). */
  readonly output: {
    readonly contentDigest: string;
    readonly descriptor: Readonly<Record<string, unknown>>;
  } | null;
  /** Runtime-reported actual usage (integer micro-USD). */
  readonly usageMicroUsd: string;
  readonly failure: {
    readonly failureClass: "workload-failure" | "timeout" | "substrate-error";
    readonly message: string;
    readonly retryable: boolean;
  } | null;
}

/**
 * One accelerator-substrate runtime adapter. Allocation is the PAID
 * boundary (the service calls it ONLY after budget admission, with the
 * stable allocation key); `run` is the long-running execution (it
 * returns the full observation incl. emitted checkpoints); both are
 * idempotent per stable key.
 */
export interface AcceleratorSubstrateRuntime {
  /** The neutral adapter identity this runtime serves (the binding key). */
  readonly adapterRef: string;
  allocate(
    request: AcceleratorResourceRequest,
    allocationKey: string,
    context: { readonly applicationId: string; readonly tenantId: string },
  ): Promise<AcceleratorAllocation>;
  release(allocationKey: string): Promise<{ released: boolean }>;
  run(spec: AcceleratorRuntimeSpec, runKey: string): Promise<TrainingRunObservation>;
}

/**
 * The runtime registry (composition wiring): adapterRef -> runtime.
 * The runtime is resolved ONLY at dispatch, AFTER selection and budget
 * admission; an unwired adapterRef fails closed (no default runtime).
 */
export interface AcceleratorRuntimeRegistry {
  register(runtime: AcceleratorSubstrateRuntime): void;
  runtimeFor(adapterRef: string): AcceleratorSubstrateRuntime | null;
}

/** A simple in-memory registry implementation (composition convenience). */
export function createAcceleratorRuntimeRegistry(): AcceleratorRuntimeRegistry {
  const runtimes = new Map<string, AcceleratorSubstrateRuntime>();
  return {
    register(runtime) {
      runtimes.set(runtime.adapterRef, runtime);
    },
    runtimeFor(adapterRef) {
      return runtimes.get(adapterRef) ?? null;
    },
  };
}
